'use strict';
/**
 * sysproxy.js —— 界面内的系统代理开关
 *
 * ---------------------------------------------------------------------------
 * 为什么单独做一个模块，而不是让界面去调 launcher.js
 * ---------------------------------------------------------------------------
 * launcher.js 的系统代理逻辑是**进程级**的：它在启动时接管、在退出时还原，
 * 生命周期和那一次启动绑定。而界面上用户想要的是"现在打开 / 现在关掉"，
 * 两个动作可能在一次会话里来回切换，和启动流程无关。
 *
 * 所以这里做成一组可重复调用的函数：开 → 备份 → 改；关 → 读备份 → 还原。
 *
 * ---------------------------------------------------------------------------
 * 三条不能破的规矩（都是从 launcher.js 的真实事故里搬过来的）
 * ---------------------------------------------------------------------------
 * 1. **读取必须三态**：`null` 不能同时表示"这项本来就不存在"和"查询失败了"。
 *    混淆两者会让还原逻辑去 `reg delete` 用户真实存在的分流规则。
 * 2. **读不到就绝不删除**：备份里标记为 unknown 的项，还原时只关开关，原样保留。
 * 3. **备份文件独占创建（'wx'）**：绝不覆盖上一次会话留下的那一份备份 ——
 *    它是唯一能救回用户原始配置的东西。
 *
 * 另外备份文件**刻意不和 launcher.js 用同一个**（那边是 proxy-backup.json）。
 * 两边各自管各自的，避免互相覆盖、也避免界面关掉代理时误删启动器记的备份。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 界面触发的备份文件。与 launcher.js 的 proxy-backup.json 分开，互不干扰。 */
const BACKUP_FILE = path.join(ROOT, 'proxy-backup-ui.json');

/** 与 launcher.js 保持一致的绕过列表：本机地址和局域网不走代理 */
const OVERRIDE_DEFAULT = 'localhost;127.*;10.*;172.16.*;192.168.*;<local>';

function supported() {
  return process.platform === 'win32';
}

/** 执行 reg.exe。走参数数组，不经过 cmd.exe —— 值里的 * ; <local> 会被 shell 吃掉 */
function execReg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, () => resolve());
  });
}

function execRegSync(args) {
  try { execFileSync('reg.exe', args, { windowsHide: true, stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

/**
 * 三态读取：
 *   { ok:true,  value:'x' }            查到了
 *   { ok:true,  value:null }           查到了，确认该项本来就不存在
 *   { ok:false, value:null, error }    查询本身失败（绝不能据此删除）
 */
function regGet(name) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', PROXY_KEY, '/v', name], { windowsHide: true }, (err, stdout) => {
      if (err) {
        return resolve({ ok: false, value: null, error: `reg query ${name} 失败: ${(err.code || err.message || '').toString().trim()}` });
      }
      const m = String(stdout).match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`));
      if (!m) return resolve({ ok: true, value: null });
      let v = m[1].trim();
      if (/^0x[0-9a-f]+$/i.test(v)) v = String(parseInt(v, 16));
      resolve({ ok: true, value: v });
    });
  });
}

function regSet(name, type, value) {
  return execReg(['add', PROXY_KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
}

function regDelete(name) {
  return execReg(['delete', PROXY_KEY, '/v', name, '/f']);
}

/** 一次读完三项，并明确列出读不到的项 */
async function read() {
  if (!supported()) return { ok: false, failed: ['platform'], error: '仅支持 Windows' };
  const names = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];
  const got = await Promise.all(names.map(regGet));
  const failed = [];
  got.forEach((g, i) => { if (!g.ok) failed.push(names[i]); });
  return {
    ok: failed.length === 0,
    enable: got[0].ok && got[0].value != null ? got[0].value : '0',
    server: got[1].ok ? got[1].value : null,
    override: got[2].ok ? got[2].value : null,
    failed,
    error: failed.length ? `无法读取 ${failed.join('、')}` : undefined,
  };
}

function readBackup() {
  try { return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')); }
  catch (_) { return null; }
}

function hasBackup() {
  try { fs.accessSync(BACKUP_FILE); return true; } catch (_) { return false; }
}

function clearBackup() {
  try { fs.unlinkSync(BACKUP_FILE); } catch (_) {}
}

/** 某个端口上有没有服务在监听（用来判断代理是不是指向了一个死端口） */
function portListening(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout, () => fin(false));
    s.once('error', () => fin(false));
    s.once('connect', () => fin(true));
  });
}

/** 当前系统代理是不是指向本程序的某个端口 */
function pointsToUs(server, port) {
  if (!server) return false;
  const s = String(server);
  return s.includes(`127.0.0.1:${port}`) || s.includes(`localhost:${port}`);
}

/**
 * 查询状态。
 * @param {number} port 本程序代理端口
 * @returns {Promise<{supported:boolean, on:boolean, server:string|null,
 *                    override:string|null, managed:boolean, backup:boolean, error?:string}>}
 */
async function status(port) {
  if (!supported()) return { supported: false, on: false, server: null, managed: false, backup: false, orphan: false, error: '仅支持 Windows' };
  const cur = await read();
  const backup = readBackup();
  const managed = pointsToUs(cur.server, port);
  const on = cur.ok && Number(cur.enable) === 1;

  /**
   * 孤儿代理：开关开着、指向本程序的端口，但**那边已经没有服务**，
   * 而且没有任何备份文件 —— 也就是说没有任何进程会再来还原它。
   *
   * 这是"关掉程序之后打不开网页"的典型成因：
   * 看门狗只在"备份文件还在"时才动手，备份没了它就以为已经收尾干净了。
   * 于是代理永久停在一个死端口上，用户直接断网，且重开程序也未必救得回来。
   *
   * 检测出这个状态后，restore-proxy.js 和界面都能给出明确的一键修复。
   */
  let orphan = false;
  if (on && managed && !backup) {
    orphan = !(await portListening(port));
  }

  return {
    supported: true,
    readable: cur.ok,
    on,
    server: cur.server,
    override: cur.override,
    managed,          // 代理地址指向本程序
    backup: !!backup, // 我们有没有接过管
    orphan,           // 指向死端口且无人会来还原
    error: cur.error,
  };
}

/**
 * 开启：把系统代理指向本程序。
 *
 * 顺序很重要：先读全 → 再写备份（独占）→ 最后才改注册表。
 * 任何一步失败都不动注册表。
 */
async function enable(port) {
  if (!supported()) return { ok: false, error: '仅支持 Windows' };

  const cur = await read();
  if (!cur.ok) {
    return {
      ok: false, error: cur.error, needManual: true,
      hint: '读不到当前代理设置时不敢接管 —— 否则可能无法还原。请在程序里手动填代理地址。',
    };
  }

  if (pointsToUs(cur.server, port) && Number(cur.enable) === 1) {
    return { ok: true, already: true, server: cur.server };
  }

  // 备份必须独占创建：文件已存在说明上一次没有正常还原，此时覆盖会毁掉
  // 唯一一份原始配置。宁可拒绝接管，也不制造无法恢复的局面。
  const backup = {
    source: 'ui',
    token: `${process.pid}-${Date.now()}`,
    savedAt: new Date().toISOString(),
    enable: cur.enable,
    server: cur.server,
    override: cur.override,
    unknown: cur.failed,     // 读不到的项：还原时一律跳过，绝不删除
  };
  try {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      return {
        ok: false, error: '检测到上一次的代理备份没有被清理',
        hint: '为避免覆盖掉原始配置，已停止接管。请先点「关闭系统代理」或双击 restore-proxy.cmd，再试一次。',
      };
    }
    return { ok: false, error: `写备份失败: ${e.message}` };
  }

  await regSet('ProxyEnable', 'REG_DWORD', '1');
  await regSet('ProxyServer', 'REG_SZ', `http://127.0.0.1:${port}`);
  // 用户原本有绕过列表就保留（追加默认项，避免本机地址也被代理），
  // 没有则用默认值 —— 还原时按备份原样处理。
  const override = cur.override && cur.override.trim()
    ? `${cur.override.replace(/;\s*$/, '')};${OVERRIDE_DEFAULT}`
    : OVERRIDE_DEFAULT;
  await regSet('ProxyOverride', 'REG_SZ', override);

  const after = await status(port);
  // token 交给调用方：派看门狗时要带上它，看门狗靠它区分"这次会话的备份"
  return { ok: true, server: `http://127.0.0.1:${port}`, previous: cur, on: after.on, token: backup.token };
}

/** 关闭：按备份还原，并清掉备份文件 */
async function disable() {
  if (!supported()) return { ok: false, error: '仅支持 Windows' };
  const saved = readBackup();
  if (!saved) {
    // 没有备份说明不是我们接管的。此时只关开关，绝不动用户的服务器地址和绕过列表。
    const cur = await read();
    if (cur.ok && Number(cur.enable) === 1) await regSet('ProxyEnable', 'REG_DWORD', '0');
    return { ok: true, restored: false, note: '没有找到本程序写入的备份，只关闭了代理开关，未改动你的服务器地址与绕过列表。' };
  }

  const skip = Array.isArray(saved.unknown) ? saved.unknown : ['ProxyServer', 'ProxyOverride'];
  await regSet('ProxyEnable', 'REG_DWORD', saved.enable == null ? '0' : String(saved.enable));

  if (!skip.includes('ProxyServer')) {
    if (saved.server != null) await regSet('ProxyServer', 'REG_SZ', saved.server);
    else await regDelete('ProxyServer');
  }
  if (!skip.includes('ProxyOverride')) {
    if (saved.override != null) await regSet('ProxyOverride', 'REG_SZ', saved.override);
    else await regDelete('ProxyOverride');
  }

  clearBackup();
  return { ok: true, restored: true, skipped: skip, previous: { enable: saved.enable, server: saved.server, override: saved.override } };
}

/**
 * 进程退出时的兜底还原（同步版）。
 * 退出路径上来不及等异步回调，所以这里用 execFileSync。
 */
function restoreSync() {
  if (!supported()) return { done: false, reason: 'unsupported' };
  const saved = readBackup();
  if (!saved) return { done: false, reason: 'no-backup' };

  const skip = Array.isArray(saved.unknown) ? saved.unknown : ['ProxyServer', 'ProxyOverride'];
  execRegSync(['add', PROXY_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', String(saved.enable == null ? 0 : saved.enable), '/f']);
  if (!skip.includes('ProxyServer')) {
    if (saved.server != null) execRegSync(['add', PROXY_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', String(saved.server), '/f']);
    else execRegSync(['delete', PROXY_KEY, '/v', 'ProxyServer', '/f']);
  }
  if (!skip.includes('ProxyOverride')) {
    if (saved.override != null) execRegSync(['add', PROXY_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', String(saved.override), '/f']);
    else execRegSync(['delete', PROXY_KEY, '/v', 'ProxyOverride', '/f']);
  }
  clearBackup();
  return { done: true, skipped: skip };
}

module.exports = {
  supported, read, status, enable, disable, restoreSync,
  readBackup, hasBackup, clearBackup, pointsToUs, portListening,
  BACKUP_FILE, PROXY_KEY, OVERRIDE_DEFAULT,
};
