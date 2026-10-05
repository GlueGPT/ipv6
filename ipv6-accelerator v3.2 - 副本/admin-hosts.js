'use strict';
/**
 * admin-hosts.js —— 只在"写 hosts 的那一刻"按需提权
 *
 * ---------------------------------------------------------------------------
 * 为什么要单独做这个
 * ---------------------------------------------------------------------------
 * 之前的唯一办法是"关掉程序 → 右键 start.cmd → 以管理员身份运行 → 再选 3"。
 * 这条路径又长又容易走岔：用户往往已经开着加速器在用浏览器代理，
 * 为了给 Steam 加速要把整套程序重启一遍，而重启过程中任何一步走岔
 * （旧实例没被顶掉、UAC 点了否、选错了菜单项）都会得到
 * "界面仍然提示需要管理员" —— 也就是"管理员模式根本用不了"。
 *
 * 实际上**只有写 hosts 这一个动作需要管理员**：代理、测速、优选全都不需要。
 * 所以这里把它拆出来：平时普通权限跑，真正要写 hosts 时弹一次 UAC，
 * 用一个短命的管理员子进程写完就退出。主进程权限始终不变。
 *
 * ---------------------------------------------------------------------------
 * 父子进程怎么通信
 * ---------------------------------------------------------------------------
 * 提权是用 `Start-Process -Verb RunAs` 起的，它只负责"启动"，
 * 拿不到子进程的退出码，也没有可用的 stdout 管道。
 * 所以约定：入参写进一个临时 JSON 文件，子进程把结果写进另一个临时 JSON 文件。
 * 父进程轮询结果文件 —— 用户点 UAC 可能要几秒甚至更久，所以超时给得宽松。
 *
 * 用法：
 *   node admin-hosts.js --run --in <入参.json> --out <结果.json>   （子进程，已提权）
 *   const { runElevated } = require('./admin-hosts')               （主进程调用）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const hosts = require('./lib/hosts');
const elevate = require('./elevate');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/**
 * 子进程：此时已经有管理员权限，执行真正的 hosts 操作。
 *
 * 只做 hosts 相关的三件事，绝不做别的 —— 它跑在高权限下，
 * 攻击面必须尽可能小（入参是本地临时文件，内容由主进程生成）。
 */
async function childRun() {
  const inFile = arg('--in', '');
  const outFile = arg('--out', '');
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(inFile, 'utf8')); } catch (_) { payload = {}; }

  let result = { ok: false, error: '无法解析入参' };
  try {
    const flush = async () => {
      const f = await hosts.flushDns();
      return !!f.ok;
    };

    if (payload.action === 'apply') {
      const w = hosts.apply(payload.entries || [], {
        replaceModes: payload.replaceModes || [],
        keepOthers: true,
      });
      result = w.ok ? { ...w, dnsFlushed: await flush() } : { ...w };
    } else if (payload.action === 'revert') {
      const r = payload.mode ? hosts.revertMode(payload.mode) : hosts.revert();
      result = r.ok ? { ...r, dnsFlushed: await flush() } : { ...r };
    } else if (payload.action === 'set') {
      // 先清空全部受管区块，再把保留下来的条目写回去（"删除单条"用这个）
      const cleared = hosts.revert();
      if (!cleared.ok) result = { ok: false, error: cleared.error || '清空受管区块失败' };
      else if (!payload.entries || !payload.entries.length) result = { ...cleared, count: 0, dnsFlushed: await flush() };
      else {
        const w = hosts.apply(payload.entries, { keepOthers: true });
        result = w.ok ? { ...w, dnsFlushed: await flush() } : { ...w };
      }
    } else {
      result = { ok: false, error: `未知操作: ${payload.action}` };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  try { fs.writeFileSync(outFile, JSON.stringify(result), 'utf8'); } catch (_) {}
}

/** 这个平台能不能弹 UAC？不能的话只能让用户自己以管理员身份重启 */
function canElevate() {
  if (process.platform !== 'win32') return false;
  return typeof elevate.relaunchAsAdmin === 'function';
}

/**
 * 提权执行一次 hosts 操作。
 *
 * @param {object} payload  { action, entries?, replaceModes?, mode? }
 * @param {number} timeoutMs 等用户点 UAC 的时间；给得宽松些，人要点按钮
 * @returns {Promise<object>} 子进程写回的结果
 */
async function runElevated(payload, timeoutMs = 180000) {
  if (!canElevate()) return { ok: false, error: '当前平台无法提权，请以管理员身份重新启动本程序' };

  const id = `${process.pid}-${Date.now().toString(36)}`;
  const inFile = path.join(os.tmpdir(), `accel-hosts-in-${id}.json`);
  const outFile = path.join(os.tmpdir(), `accel-hosts-out-${id}.json`);

  try { fs.writeFileSync(inFile, JSON.stringify(payload), 'utf8'); } catch (e) {
    return { ok: false, error: `无法写入临时入参: ${e.message}` };
  }
  try { fs.unlinkSync(outFile); } catch (_) {}

  const self = path.join(__dirname, 'admin-hosts.js');
  const r = await elevate.relaunchAsAdmin(['--run', '--in', inFile, '--out', outFile], self);
  if (!r.ok) {
    cleanup([inFile]);
    return { ok: false, error: `没有获得管理员授权：${r.error}`, cancelled: true };
  }

  // 子进程可能还在等用户点 UAC，这里轮询结果文件
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((res) => setTimeout(res, 300));
    let txt = '';
    try { txt = fs.readFileSync(outFile, 'utf8'); } catch (_) { txt = ''; }
    if (!txt) continue;
    let out = null;
    try { out = JSON.parse(txt); } catch (_) { out = null; }
    if (out) { cleanup([inFile, outFile]); return out; }
  }

  cleanup([inFile]);
  try { fs.unlinkSync(outFile); } catch (_) {}
  return { ok: false, error: '等待管理员授权超时，hosts 未改动', cancelled: true };
}

function cleanup(files) {
  for (const f of files) { try { fs.unlinkSync(f); } catch (_) {} }
}

if (process.argv.includes('--run')) {
  childRun().then(() => process.exit(0), () => process.exit(1));
}

module.exports = { runElevated, canElevate, childRun };
