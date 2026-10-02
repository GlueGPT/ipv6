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
 *   node watchdog.js --pid <主进程pid> --token <令牌> [--verbose]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const RECOVERY_FILE = path.join(ROOT, 'proxy-backup.json');
const WATCHDOG_LOG = path.join(ROOT, 'watchdog.log');

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

/** 把系统代理还原成 saved 记录的样子（同步，保证执行完再退出） */
function applyRestoreSync(saved) {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const run = (cmd) => {
    try { execFileSync('reg.exe', cmd, { windowsHide: true, stdio: 'ignore' }); return true; }
    catch (_) { return false; }
  };

  const enable = saved.enable == null ? '0' : String(saved.enable);
  run(['add', base, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enable, '/f']);

  if (saved.server != null) {
    run(['add', base, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', String(saved.server), '/f']);
  } else {
    run(['delete', base, '/v', 'ProxyServer', '/f']);
  }

  if (saved.override != null) {
    run(['add', base, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', String(saved.override), '/f']);
  } else {
    run(['delete', base, '/v', 'ProxyOverride', '/f']);
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

const timer = setInterval(() => {
  ticks++;
  void ticks;

  // 超时自我保护
  if (Date.now() - startedAt > MAX_LIFETIME_MS) {
    log('超过最长守护时间，退出');
    clearInterval(timer);
    process.exit(0);
  }

  // 主进程还活着 → 什么都不做
  if (alive(TARGET_PID)) return;

  // 主进程没了。先确认"这次会话"的还原还没被做过
  const saved = readRecovery();
  if (!saved) {
    log('主进程已退出，且恢复文件不存在（说明已正常收尾），看门狗退出');
    clearInterval(timer);
    process.exit(0);
  }

  if (saved.token && saved.token !== TOKEN) {
    log(`恢复文件属于别的会话（token 不匹配），看门狗退出`);
    clearInterval(timer);
    process.exit(0);
  }

  // 到这里说明：主进程异常消失，而且代理还指着它 → 必须还原
  log(`主进程 ${TARGET_PID} 已消失且代理未还原，执行兜底还原`);
  applyRestoreSync(saved);
  clearRecovery();
  log('兜底还原完成');

  clearInterval(timer);
  process.exit(0);
}, POLL_MS);

// 注意：这里**不能** timer.unref()。
// unref 之后事件循环就没有活着的句柄了，Node 会立刻退出，
// 看门狗一次都不会检查 —— 实测踩过这个坑（日志里只有"启动"，一个 tick 都没有）。
// 看门狗是由父进程用 detached + unref 派出来的独立进程，
// 它活着不会拖住父进程，所以本来就该保持事件循环活跃。
