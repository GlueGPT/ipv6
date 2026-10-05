'use strict';
/**
 * watchdog.js —— 系统代理的兜底还原
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 「加速启动」会把系统代理指向本程序。如果程序不是"正常退出"，
 * 代理就会留在 127.0.0.1:8899 而那里已经没有服务 —— 表现为**直接上不了网**，
 * 用户还完全不知道原因。
 *
 * 而 Windows 上"异常退出"是常态，实测确认：
 *   - 任务管理器结束进程  → 收尾代码不执行
 *   - 外部 process.kill 发 SIGINT/SIGTERM → 直接 TerminateProcess，
 *     Node 的 signal handler 和 exit 事件都不会触发
 *   - 关闭控制台窗口（CTRL_CLOSE_EVENT）→ 同上，且系统只给几秒
 *   - 蓝屏/断电/重启         → 根本无从执行
 *
 * 所以靠"退出时还原"是不可靠的。改为：启动时派一个独立的小进程盯着主进程，
 * 主进程一旦消失就由它来还原。
 *
 * ---------------------------------------------------------------------------
 * 怎么避免和正常退出打架
 * ---------------------------------------------------------------------------
 * 用一个令牌（token）标记"这次会话"：
 *   - 主进程正常退出时会自己还原，并删除 proxy-backup.json
 *   - 看门狗先读文件，发现 token 不匹配或文件不存在，说明已经被正常收尾了，安静退出
 *   - 只有"文件还在、token 还是我的、主进程却没了"才动手还原
 *
 * 用法（由 launcher.js 自动调用，不需要手动跑）：
 *   node watchdog.js --pid <主进程pid> --token <令牌> [--verbose] [--file <恢复文件名>]
 *
 * `--file` 缺省为 proxy-backup.json（启动器那份）。界面开启的系统代理用
 * proxy-backup-ui.json，由 server.js 带 --file 单独派一个看门狗盯着。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const WATCHDOG_LOG = path.join(ROOT, 'watchdog.log');
// 还原任务的互斥标记，见下方 claimRestore 的说明
const CLAIM_FILE = path.join(ROOT, 'proxy-restore.claim');
const PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// 轮询间隔：太短浪费 CPU，太长会让用户在断网状态下多等
const POLL_MS = 1200;
// 最长守护时间：防止看门狗自己被遗忘而永久驻留（12 小时足够覆盖任何正常使用）
const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const TARGET_PID = Number(arg('--pid', '0'));
const TOKEN = arg('--token', '');
const VERBOSE = process.argv.includes('--verbose');

/**
 * 恢复文件的文件名可通过 --file 指定。
 *
 * 默认仍是 proxy-backup.json（启动器用的那份）。界面上的「一键开启系统代理」
 * 走的是 lib/sysproxy.js，它写另一份 proxy-backup-ui.json ——
 * 两边各自派一个看门狗、各自盯自己那份，互不覆盖。
 */
const RECOVERY_FILE = path.join(ROOT, arg('--file', 'proxy-backup.json'));

function log(msg) {
  if (!VERBOSE) return;
  try { fs.appendFileSync(WATCHDOG_LOG, `[${new Date().toISOString()}] ${msg}\r\n`, 'utf8'); } catch (_) {}
}

/** 目标进程还活着吗 */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM 说明进程存在但没有权限
}

function readRecovery() {
  try { return JSON.parse(fs.readFileSync(RECOVERY_FILE, 'utf8')); }
  catch (_) { return null; }
}

function clearRecovery() {
  try { fs.unlinkSync(RECOVERY_FILE); } catch (_) {}
}

/**
 * 把系统代理还原成 saved 记录的样子（同步，保证执行完再退出）
 *
 * 与 launcher.js 的同名逻辑保持一致，两点必须相同：
 *   1) 认得 saved.unknown —— 读取失败的项目一律跳过，绝不删除
 *   2) 认得老版本备份（没有 unknown 字段）→ 语义未知 → 保守跳过
 *
 * 之前这里和 launcher.js 是两份独立实现。改了一边忘了另一边，
 * 就会出现"主进程按新逻辑跳过了、看门狗按老逻辑删掉了"的静默数据丢失。
 */
function applyRestoreSync(saved) {
  const skip = Array.isArray(saved.unknown)
    ? saved.unknown
    : ['ProxyServer', 'ProxyOverride'];   // 老备份：语义不明，不敢删

  const run = (cmd) => {
    try { execFileSync('reg.exe', cmd, { windowsHide: true, stdio: 'ignore' }); return true; }
    catch (_) { return false; }
  };

  const enable = saved.enable == null ? '0' : String(saved.enable);
  run(['add', PROXY_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enable, '/f']);

  if (skip.includes('ProxyServer')) {
    run(['delete', PROXY_KEY, '/v', 'ProxyServer', '/f']);
  } else if (saved.server != null) {
    run(['add', PROXY_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', String(saved.server), '/f']);
  } else {
    run(['delete', PROXY_KEY, '/v', 'ProxyServer', '/f']);
  }

  if (skip.includes('ProxyOverride')) {
    run(['delete', PROXY_KEY, '/v', 'ProxyOverride', '/f']);
  } else if (saved.override != null) {
    run(['add', PROXY_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', String(saved.override), '/f']);
  } else {
    run(['delete', PROXY_KEY, '/v', 'ProxyOverride', '/f']);
  }
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
if (!TARGET_PID || !TOKEN) {
  log(`参数不足（pid=${TARGET_PID} token=${TOKEN ? '有' : '无'}），退出`);
  process.exit(0);
}

log(`看门狗启动，盯 pid=${TARGET_PID}，token=${TOKEN.slice(0, 8)}`);

const startedAt = Date.now();
let ticks = 0;
let handled = false;

/**
 * 认领这次还原任务。
 *
 * 竞态场景：主进程正在跑 applyRestore（异步，4 次 execFile），
 * 用户在这期间点了任务管理器的"结束进程"。主进程瞬间消失，
 * 看门狗下一 tick（最多 1.2 秒后）就会接手再还原一次。
 *
 * 两次还原的结果其实一样（幂等写入同样的值），但中间会出现
 * "ProxyEnable 已改回 0、ProxyServer 还没改回去"的窗口 ——
 * 恰好在这个窗口里打开网页，就是"没网"。
 *
 * 所以用一个"我正在还原"的标记文件互斥：谁先 create 成功谁动手，
 * 另一个安静退出。
 */
/**
 * 与 launcher.js 保持同一套判断，两边必须一致：
 * 一边当它是僵尸、另一边当它有效，就会出现"谁都没还原"或者"两边都写"。
 */
const CLAIM_TTL_MS = 60000;

function claimOwnerAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readClaim() {
  let raw = '';
  try { raw = fs.readFileSync(CLAIM_FILE, 'utf8'); } catch (_) { return null; }
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return { pid: Number(j.pid) || 0, ts: Number(j.ts) || 0 };
  } catch (_) { /* 老格式：只有一个 pid 数字 */ }
  const n = Number(String(raw).trim());
  return (Number.isFinite(n) && n > 0) ? { pid: n, ts: 0 } : { pid: 0, ts: 0 };
}

/**
 * 僵尸标记必须能识别：还原中途被杀会留下这个文件，
 * 之后每次运行都因为"已存在"而跳过还原，代理永远回不去。
 */
function claimIsStale() {
  try { fs.accessSync(CLAIM_FILE); } catch (_) { return false; }
  const c = readClaim();
  if (!c || !c.ts) return false;                       // 没有时间戳时不判定过期
  if (Date.now() - c.ts > CLAIM_TTL_MS) return true;
  return !claimOwnerAlive(c.pid);
}

function claimRestore() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(CLAIM_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }),
        { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true;   // 写不出来：宁可重复还原，也不能不还原
      if (attempt === 0 && claimIsStale()) {
        try { fs.unlinkSync(CLAIM_FILE); } catch (_) {}
        continue;
      }
      return false;
    }
  }
  return false;
}

const timer = setInterval(() => {
  ticks++;

  if (handled) return;

  // 超时自我保护
  if (Date.now() - startedAt > MAX_LIFETIME_MS) {
    log('超过最长守护时间，退出');
    handled = true;
    clearInterval(timer);
    process.exit(0);
  }

  // 主进程还活着 → 什么都不做
  if (alive(TARGET_PID)) return;

  // 主进程没了。先确认"这次会话"的还原还没被做过
  const saved = readRecovery();
  if (!saved) {
    log('主进程已退出，且恢复文件不存在（说明已正常收尾），看门狗退出');
    handled = true;
    clearInterval(timer);
    process.exit(0);
  }

  if (saved.token && saved.token !== TOKEN) {
    log('恢复文件属于别的会话（token 不匹配），看门狗退出');
    handled = true;
    clearInterval(timer);
    process.exit(0);
  }

  // 已经有别的进程（或主进程的收尾流程）认领了这次还原 → 不重复动手
  if (!claimRestore()) {
    log('还原任务已被其他进程认领，看门狗退出');
    handled = true;
    try { fs.unlinkSync(CLAIM_FILE); } catch (_) {}
    clearInterval(timer);
    process.exit(0);
  }

  // 到这里说明：主进程异常消失，而且代理还指着它 → 必须还原
  log(`主进程 ${TARGET_PID} 已消失且代理未还原，执行兜底还原`);
  const skip = Array.isArray(saved.unknown) ? saved.unknown : [];
  if (skip.length) log(`兜底还原：跳过未能确认的项 ${skip.join(', ')}（不删除）`);
  applyRestoreSync(saved);
  clearRecovery();
  log('兜底还原完成');

  handled = true;
  try { fs.unlinkSync(CLAIM_FILE); } catch (_) {}
  clearInterval(timer);
  process.exit(0);
}, POLL_MS);

// 注意：这里**不能** timer.unref()。
// unref 之后事件循环就没有活着的句柄了，Node 会立刻退出，
// 看门狗一次都不会检查 —— 实测踩过这个坑（日志里只有"启动"，一个 tick 都没有）。
// 看门狗是由父进程用 detached + unref 派出来的独立进程，
// 它活着不会拖住父进程，所以本来就该保持事件循环活跃。
