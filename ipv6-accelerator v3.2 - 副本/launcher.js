'use strict';
/**
 * launcher.js —— 启动器的"大脑"
 *
 * ---------------------------------------------------------------------------
 * 为什么中文输出要做在这里，而不是 .cmd 里
 * ---------------------------------------------------------------------------
 * cmd.exe 是按控制台代码页逐字节读取批处理文件的。中文 .cmd 只要编码不对
 * （UTF-8 带 BOM、UTF-8 无 BOM、GBK 与代码页不匹配……），就会出现
 * 行首字符被吃掉、echo 变成 ho、中文变成 锟斤拷 等各种问题，而且
 * 每种 Windows 环境下表现还不一样。
 *
 * Node 写控制台走的是 WriteConsoleW（Unicode API），和代码页无关。
 * 所以：.cmd 里只留纯 ASCII，所有中文提示都从这里输出。
 * 这样中文显示永远正确，启动脚本也就永远解析正确。
 *
 * 另外这个文件还承担两件 .cmd 做起来很别扭的事：
 *   1. 判断加速器是不是已经在跑（已经跑就直接开浏览器，不报错）
 *   2. 中文的错误提示和退出码
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, exec, execFile, execFileSync } = require('child_process');

/** 系统代理所在的注册表路径，全局只此一份，避免各处硬编码漂移 */
const PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// ---------------------------------------------------------------------------
// 启动日志
//
// 黑窗口一闪而过时，用户看不到任何报错，也就没法排查。
// 所以启动器从第一行起就把所有关键动作写进 startup.log。
// 全程同步写，保证进程被强杀时日志也已经落盘。
// ---------------------------------------------------------------------------
const LOG_FILE = path.join(__dirname, 'startup.log');

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\r\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) { /* 日志失败不能影响启动 */ }
}

function logReset() {
  try {
    fs.writeFileSync(LOG_FILE,
      `==== IPv6 加速器启动日志 ====\r\n` +
      `时间: ${new Date().toLocaleString()}\r\n` +
      `Node: ${process.version} (${process.execPath})\r\n` +
      `平台: ${process.platform} ${require('os').release()}\r\n` +
      `脚本目录: ${__dirname}\r\n` +
      `工作目录: ${process.cwd()}\r\n` +
      `原始参数: ${JSON.stringify(process.argv.slice(2))}\r\n` +
      `------------------------------\r\n`, 'utf8');
  } catch (_) {}
}

logReset();
logLine('launcher.js 开始执行（说明 node 能正常启动、launcher.js 能被读到）');

const DEFAULT_PORT = 8899;
const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

function parseArgs(argv) {
  const a = { port: DEFAULT_PORT, open: true, proxy: false, elevate: false, decided: false, rest: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port' || k === '-p') { a.port = Number(argv[++i]); }
    else if (k === '--no-open') { a.open = false; }
    else if (k === '--proxy') { a.proxy = true; }      // 顺带设置系统代理（退出还原）
    else if (k === '--elevate') { a.elevate = true; }  // 以管理员身份重新启动
    // --decided：提权后的新进程带着这个标记，表示"用户已经在旧窗口做过选择了"。
    // 没有它，新进程会因为"零参数"而再次弹出菜单，让用户连选两次（真实踩过）。
    else if (k === '--decided') { a.decided = true; }
    else if (k === '--help' || k === '-h') { a.help = true; }
    else a.rest.push(k);
  }
  a.rest.unshift('--port', String(a.port));
  // 告诉服务端"系统代理已指向本加速器"，界面据此显示浏览器模式状态
  if (a.proxy) a.rest.push('--system-proxy');
  return a;
}

/**
 * 应用参数。
 *
 * 之所以做成"可覆盖"而不是一次性 const：
 * 交互菜单是在解析之后才决定要加哪些参数的（比如用户选了管理员+系统代理），
 * 加载时就锁死 ARGS 会让菜单根本没地方生效。
 */
let ARGS = parseArgs(process.argv);
function applyArgs(extra) {
  ARGS = parseArgs([process.argv[0], process.argv[1], ...extra]);
}
logLine(`解析参数: port=${ARGS.port} proxy=${ARGS.proxy} open=${ARGS.open} 传给 server.js: ${JSON.stringify(ARGS.rest)}`);

/**
 * 询问某个端口上的服务是不是"我们自己的加速器"。
 *
 * 关键：必须带 service 字段校验。
 * 早期版本只看 /api/health 是否返回 200，结果任何恰好占着 8900 的程序
 * 都会被误判成"加速器已在运行"，导致启动器不再启动服务、用户以为闪退。
 */
function probeMine(port, timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j && j.service === 'ipv6-accelerator') {
            resolve({ mine: true, pid: j.pid, proxyPort: j.port, uiPort: j.uiPort });
            return;
          }
          resolve({ mine: false, foreign: true });
        } catch (_) { resolve({ mine: false, foreign: true }); }
      });
      res.on('error', () => resolve({ mine: false }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ mine: false }); });
    req.on('error', () => resolve({ mine: false }));
  });
}

/**
 * 等某个端口上的界面服务就绪（轮询 /api/health 并核对服务标识）。
 *
 * 用在提权之后：新窗口里的实例要解析 DNS、探测 IPv6、绑端口，
 * 不可能一启动就能连上。父进程必须等它真的起来了再打开浏览器，
 * 否则用户会打开一个"无法访问"的页面，然后以为程序坏了。
 */
async function waitForUi(port, maxMs = 30000, excludePid = 0, gapMs = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await probeMine(port);
    // excludePid：旧实例的 pid。新实例起来之前旧实例还在响应，
    // 不排掉它就会"旧界面刚被打开就被替换掉"，页面立刻变成无法访问。
    if (r && r.mine && (!excludePid || r.pid !== excludePid)) return true;
    await new Promise((res) => setTimeout(res, gapMs));
  }
  return false;
}

/** 读取 PID 文件（服务启动时写，退出时删） */
function readPidFileInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'accelerator.pid'), 'utf8'));
    if (j && j.service === 'ipv6-accelerator') return j;
  } catch (_) {}
  return null;
}

/** 确认 PID 是不是真的还活着 */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** 探测端口是否只是被占用（不一定是我们的服务） */
function probeTcp(port, timeout = 900) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout, () => fin(false));
    s.once('error', () => fin(false));
    s.once('connect', () => fin(true));
  });
}

function openBrowser(url) {
  if (!ARGS.open) return;

  // 提权后不能用 start 直接开：那会以**高完整性级别**拉起浏览器，
  // Edge / Chrome 在这种情况下常常直接打不开（或弹"无法以管理员身份运行"）。
  // 实测表现就是"选完管理员启动之后没有自动弹出网页"。
  //
  // explorer.exe 一般是以普通权限在跑的，把 URL 交给它，
  // 浏览器就会以普通权限打开 —— 既能正常启动，也不必以管理员身份跑浏览器。
  let elevated = false;
  try { elevated = require('./elevate').isElevated(); } catch (_) {}
  if (elevated) {
    execFile('explorer.exe', [url], { windowsHide: true }, () => {});
    return;
  }
  // start 是 cmd 内建命令，用 cmd /c 包一层
  exec(`start "" "${url}"`, { shell: 'cmd.exe', windowsHide: true }, () => {});
}

// ---------------------------------------------------------------------------
// 系统代理的保存 / 设置 / 还原（仅 --proxy 模式）
//
// 这里有个必须处理的失效模式：如果进程被强杀（任务管理器结束、崩溃、断电），
// 系统代理会被永久留在 127.0.0.1:<端口>，而那里没有服务在监听 —— 用户直接断网，
// 且完全不知道原因。
//
// 两层防护：
//   1) 设置代理前把原设置写到 proxy-backup.json，还原成功后删除
//   2) 提供 restore-proxy.js / 还原系统代理.cmd，供异常退出后手动恢复
// ---------------------------------------------------------------------------
const RECOVERY_FILE = path.join(__dirname, 'proxy-backup.json');

// 进程内幂等守卫。
// 之前 SIGINT、SIGTERM、child exit 三个入口都会调 bye() → restore() → applyRestore()，
// 同一次退出可能连写三遍注册表；更糟的是写一半被打断，状态就停在中间。
let restoreDone = false;

function writeRecovery(data) {
  // 用 'wx' 独占创建：文件已存在说明上一次会话的备份还没被清掉，
  // 这时覆盖它等于把"上一次的真实代理配置"弄丢。宁可拒绝启动，
  // 也不能在拿不到正确备份的情况下改系统代理。
  try {
    fs.writeFileSync(RECOVERY_FILE, JSON.stringify(data, null, 2),
      { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return { exists: true, file: RECOVERY_FILE };
    // 不能静默吞掉：写不进去意味着异常退出后用户会断网且无法自动恢复
    console.error(`  [恢复文件写入失败] ${RECOVERY_FILE}`);
    console.error(`  原因: ${e.code || ''} ${e.message}`);
    return false;
  }
}

function clearRecovery() {
  try { fs.unlinkSync(RECOVERY_FILE); } catch (_) {}
  // 标记文件是临时互斥凭证，一并清掉，免得下次启动被残留标记挡住
  try { fs.unlinkSync(path.join(__dirname, 'proxy-restore.claim')); } catch (_) {}
}

/**
 * 读取 Internet Settings 下的一个值。
 *
 * 返回值是三态的，不能简化为 string | null —— 这个区别是本项目踩过的最贵的坑：
 *
 *   { ok: true,  value: 'x'  }  —— 查到了
 *   { ok: true,  value: null  }  —— 查到了，确认该项**本来就不存在**
 *   { ok: false, value: null, error } —— 查询本身失败了
 *
 * 为什么必须区分第三种：还原逻辑里 "server == null" 的含义是
 * "原本就没有这一项，还原时应该删掉它"。可一旦 reg query 因为任何原因失败
 * （沙箱拦截、权限、进程被杀），拿到的也是 null —— 还原时就会把用户
 * 真实存在的代理配置 **删掉**，用户的分流规则全部丢失，且极难察觉。
 *
 * 真实踩坑记录：用户机器上 ProxyServer=127.0.0.1:7877、ProxyOverride 是一长串
 * 分流规则，但 reg query 被沙箱拦截后，备份文件里两项都记成了 null。
 * 那份备份一旦执行还原，就会把用户的分流配置清空。
 */
function regGet(name) {
  return new Promise((resolve) => {
    exec(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${name}`,
      { windowsHide: true },
      (err, stdout) => {
        if (err) {
          return resolve({
            ok: false, value: null,
            error: `reg query ${name} 失败: ${(err.code || err.message || '').toString().trim()}`,
          });
        }
        const m = String(stdout).match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`));
        // 命令成功但没匹配到 → 该项确实不存在（reg query 对不存在的 /v 会报错，
        // 走到这里说明值里可能有换行等异常格式，保守当作"不存在"但仍是 ok:true）
        if (!m) return resolve({ ok: true, value: null });
        let v = m[1].trim();
        // reg query 对 REG_DWORD 会返回 0x0 这种十六进制，统一转成十进制存放，
        // 免得恢复文件里出现 "0x0" 这种不直观的值
        if (/^0x[0-9a-f]+$/i.test(v)) v = String(parseInt(v, 16));
        resolve({ ok: true, value: v });
      }
    );
  });
}

/**
 * 一次读完三项代理设置，并明确区分"读到了"和"读不到"。
 * @returns {{ok:boolean, enable:string|null, server:string|null,
 *            override:string|null, failed:string[], error?:string}}
 */
async function readProxySettings() {
  const [en, sv, ov] = await Promise.all([
    regGet('ProxyEnable'), regGet('ProxyServer'), regGet('ProxyOverride'),
  ]);
  const failed = [];
  if (!en.ok) failed.push('ProxyEnable');
  if (!sv.ok) failed.push('ProxyServer');
  if (!ov.ok) failed.push('ProxyOverride');
  return {
    ok: failed.length === 0,
    // enable 默认按"关闭"处理：这一项即使读不到也不会造成破坏
    // （最坏情况是还原后代理是关的，而不是删掉用户的服务器配置）
    enable: en.ok && en.value != null ? en.value : '0',
    server: sv.ok ? sv.value : null,
    override: ov.ok ? ov.value : null,
    failed,
    error: failed.length ? `无法读取 ${failed.join('、')}` : undefined,
  };
}

/**
 * 真正执行注册表写操作的底层入口。
 *
 * 单独抽出来是为了测试：还原逻辑里"删除用户的 ProxyServer"是**不可逆破坏性操作**，
 * 必须能被断言"到底执行了哪些命令"。而沙箱环境里 reg.exe 往往被安全策略拦截，
 * 真调会抛 EPERM，测试就只能退化成 grep 源码 —— 那等于没测。
 * 注入之后测试能记录完整命令序列，并在沙箱里跑通。
 */
let execRegImpl = null;   // 测试会替换成记录器；null 表示走真实的 reg.exe

function execReg(args) {
  if (execRegImpl) return Promise.resolve(execRegImpl(args));
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, () => resolve());
  });
}

function regSet(name, type, value) {
  // 用 execFile + 参数数组，不走 shell 拼接：
  // ProxyOverride 的值含 * ; <local> 等字符，交给 cmd.exe 解析会被吃掉一部分，
  // 还原出来的绕过列表就会缺项 —— 而用户完全看不出来。
  return execReg(['add', PROXY_KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
}

function regDelete(name) {
  return execReg(['delete', PROXY_KEY, '/v', name, '/f']);
}

/**
 * 还原系统代理时，**删除**用户原本就有的配置是不可逆的破坏性操作。
 *
 * 因此只要备份里某一项没标记成"确认原本不存在"，一律改为
 * "跳过、不动"，而不是删掉。宁可让用户的代理保持指向本程序
 * （他双击一下 restore-proxy.cmd / 重启电脑就能恢复），
 * 也绝不能悄悄清空他的分流规则。
 *
 * saved.unknown = ['ProxyServer', ...] 由 readProxySettings 填入。
 */
function destructiveTargets(saved) {
  if (!saved) return [];
  // 老版本备份文件没有 unknown 字段 —— 无法区分"原本不存在"和"读失败"，
  // 保守起见当成读失败：宁可只关开关，也不能删掉用户可能存在的配置。
  if (!Array.isArray(saved.unknown)) return ['ProxyServer', 'ProxyOverride'];
  return saved.unknown;
}

// 与 watchdog.js 之间的互斥标记：同一次退出只允许一方真正改注册表。
// 不加的话，主进程正在异步写 ProxyServer 时被强杀，看门狗会在 1.2 秒内
// 接手再写一遍，中间出现"开关已关、服务器地址还没改回来"的断网窗口。
const CLAIM_FILE = path.join(__dirname, 'proxy-restore.claim');

/**
 * 认领标记的有效期。
 *
 * 还原只是几次 reg 写入，正常几秒内就做完。标记留到超过这个时间，
 * 只可能是写下它的进程中途死了（被强杀、崩溃）—— 这时候它是**僵尸标记**。
 */
const CLAIM_TTL_MS = 60000;

/** 标记文件里记的那个进程还活着吗 */
function claimOwnerAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = 进程存在但没权限
}

/**
 * 读标记文件。
 *
 * 老版本只往里写了一个 pid 数字，兼容成 { pid, ts:0 } —— ts 为 0 表示
 * "没有时间戳，无法判断是否过期"，此时按**还活着**处理：
 * 宁可多让一次，也不能在真有别人正在还原时插一脚。
 */
function readClaim() {
  let raw = '';
  try { raw = fs.readFileSync(CLAIM_FILE, 'utf8'); } catch (_) { return null; }
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return { pid: Number(j.pid) || 0, ts: Number(j.ts) || 0 };
  } catch (_) { /* 不是 JSON，按老格式处理 */ }
  const n = Number(String(raw).trim());
  return (Number.isFinite(n) && n > 0) ? { pid: n, ts: 0 } : { pid: 0, ts: 0 };
}

/**
 * 僵尸标记会让"退出时还原"永久失效 —— 实测踩到过：
 *
 * 一次还原中途被杀，proxy-restore.claim 留在磁盘上。之后每次启动，
 * claimRestore() 都因为文件已存在而返回 false，还原被整段跳过，
 * 恢复文件也永远不会被清理。表现是：程序看起来在正常退出，
 * 系统代理却一直卡在已经没有服务监听的端口上，用户直接断网。
 *
 * 所以认领前先判断旧标记是不是僵尸：超过有效期、或写着它的进程已经不在了。
 */
function claimIsStale() {
  try { fs.accessSync(CLAIM_FILE); } catch (_) { return false; }
  const c = readClaim();
  if (!c || !c.ts) return false;                       // 没有时间戳：不敢判定过期
  if (Date.now() - c.ts > CLAIM_TTL_MS) return true;
  return !claimOwnerAlive(c.pid);
}

/** 启动前清掉僵尸标记，避免上一次的残留挡住这一次 */
function clearStaleClaim() {
  if (!claimIsStale()) return false;
  try { fs.unlinkSync(CLAIM_FILE); return true; } catch (_) { return false; }
}

function claimRestore() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(CLAIM_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }),
        { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true;   // 写不出标记：宁可重复还原，也不能不还原
      // 已存在：先确认是不是僵尸标记，是就删掉重试一次
      if (attempt === 0 && claimIsStale()) {
        try { fs.unlinkSync(CLAIM_FILE); } catch (_) {}
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseClaim() {
  try { fs.unlinkSync(CLAIM_FILE); } catch (_) {}
}

/** 同步版还原 —— 只用于进程即将退出、来不及等异步回调的最后关头 */
function applyRestoreSync(saved) {
  if (!saved) return { done: false, reason: 'no-backup' };
  if (restoreDone) return { done: false, reason: 'already-restored' };
  if (!claimRestore()) {
    logLine('[还原] 任务已被看门狗认领，跳过（避免重复写入注册表）');
    return { done: false, reason: 'claimed-by-watchdog' };
  }
  restoreDone = true;
  const skip = destructiveTargets(saved);
  const run = (cmd) => {
    if (execRegImpl) { execRegImpl(cmd); return; }
    try { execFileSync('reg.exe', cmd, { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
  };
  try {
    if (skip.length) {
      // 有读不到的项 → 只能把开关关掉，不能碰用户的服务器/绕过列表
      run(['add', PROXY_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD',
        '/d', String(saved.enable == null ? 0 : saved.enable), '/f']);
      logLine(`[还原] 跳过了未能确认的项: ${skip.join(', ')}（只关了开关，未删除任何配置）`);
      clearRecovery();
      return { done: true, partial: true, skipped: skip };
    }

    run(['add', PROXY_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', String(saved.enable == null ? 0 : saved.enable), '/f']);
    if (saved.server != null) run(['add', PROXY_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', String(saved.server), '/f']);
    else run(['delete', PROXY_KEY, '/v', 'ProxyServer', '/f']);
    if (saved.override != null) run(['add', PROXY_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', String(saved.override), '/f']);
    else run(['delete', PROXY_KEY, '/v', 'ProxyOverride', '/f']);
    clearRecovery();
    return { done: true };
  } finally {
    releaseClaim();
  }
}

/** 读取恢复文件（供 restore-proxy.js 使用） */
function readRecovery() {
  try { return JSON.parse(fs.readFileSync(RECOVERY_FILE, 'utf8')); }
  catch (_) { return null; }
}

/**
 * 把系统代理恢复成 saved 里的设置（含绕过列表）。
 * saved 形如 { enable, server, override }，null 表示该值原本不存在。
 *
 * 幂等：进程内多次调用（SIGINT + child exit 会各触发一次 bye）
 * 以及与看门狗的跨进程竞争，都靠 restoreLock 收敛成一次真正的还原。
 */
async function applyRestore(saved) {
  if (!saved) return { done: false, reason: 'no-backup' };
  if (restoreDone) return { done: false, reason: 'already-restored' };
  if (!claimRestore()) {
    logLine('[还原] 任务已被看门狗认领，跳过（避免重复写入注册表）');
    return { done: false, reason: 'claimed-by-watchdog' };
  }
  restoreDone = true;

  try {
    const skip = destructiveTargets(saved);
    if (skip.length) {
      await regSet('ProxyEnable', 'REG_DWORD', saved.enable == null ? '0' : String(saved.enable));
      logLine(`[还原] 跳过了未能确认的项: ${skip.join(', ')}（只关了开关，未删除任何配置）`);
      // 必须清掉恢复文件：残留的备份会让下一次启动以为"上次没收尾"，
      // 直接把用户挡在门外，还再也看不到"你的配置被保留着"这个结论。
      clearRecovery();
      return { done: true, partial: true, skipped: skip };
    }

    await regSet('ProxyEnable', 'REG_DWORD', saved.enable == null ? '0' : String(saved.enable));
    if (saved.server != null) await regSet('ProxyServer', 'REG_SZ', saved.server);
    else await regDelete('ProxyServer');
    if (saved.override != null) await regSet('ProxyOverride', 'REG_SZ', saved.override);
    else await regDelete('ProxyOverride');
    return { done: true };
  } finally {
    releaseClaim();
  }
}

/**
 * 停掉一个正在运行的加速器实例。
 *
 * 用在 --elevate 场景：用户之前可能用普通权限启动过，
 * 这时必须先把旧实例停掉，否则新实例会撞端口、
 * 或者被"检测到已在运行"直接劝退 —— 结果就是管理员权限根本没生效。
 *
 * 先试 SIGTERM（让它自己走完还原系统代理的收尾流程），
 * 不行再强杀，最后确认端口真的释放了。
 */
async function stopExistingInstance(pid) {
  const graceful = () => { try { process.kill(pid, 'SIGTERM'); return true; } catch (_) { return false; } };
  const forceful = () => { try { process.kill(pid, 'SIGKILL'); return true; } catch (_) { return false; } };

  if (!graceful()) return false;

  // 给它 4 秒做收尾（还原 hosts、还原系统代理）
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!pidAlive(pid)) return true;
  }

  logLine(`pid ${pid} 没有响应 SIGTERM，强制结束`);
  forceful();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!pidAlive(pid)) return true;
  }

  // 还活着就只能交给端口预检去报错了
  return !pidAlive(pid);
}

/**
 * 换掉正在运行的实例：停掉旧的、把它的启动包裹进程也结束掉、清掉 PID 文件。
 * 返回是否成功腾出位置。
 */
async function replaceExistingInstance(found) {
  console.log(`  ${C.d}正在停掉旧实例（pid ${found.pid}）……${C.r}`);
  logLine(`--elevate：准备停掉旧实例 pid=${found.pid}`);

  const stopped = await stopExistingInstance(found.pid);
  if (!stopped) {
    logLine(`旧实例 pid=${found.pid} 无法结束`);
    console.log(`  ${C.red}✗ 无法结束旧实例（pid ${found.pid}）。${C.r}`);
    console.log(`  ${C.d}请手动结束它：任务管理器 → 详细信息 → 找 node.exe (pid ${found.pid})。${C.r}`);
    console.log('');
    return false;
  }

  // 旧实例是通过 start.cmd → launcher.js → server.js 启动的。
  // server.js 没了，包着它的 launcher.js 会自己退出，但可能还在等端口，
  // 这里再等一小会儿并清掉 PID 文件，避免新实例被自己的残留记录劝退。
  try {
    const stale = readPidFileInfo();
    if (stale && stale.pid === found.pid) {
      const p = path.join(__dirname, 'accelerator.pid');
      try { fs.unlinkSync(p); logLine('已清理旧 PID 文件'); } catch (_) {}
    }
  } catch (_) {}

  // 等端口真正释放（TIME_WAIT 不影响 listen，但监听 socket 需要时间关闭）
  for (let i = 0; i < 30; i++) {
    const busy = await probeTcp(ARGS.port, 300) || await probeTcp(ARGS.port + 1, 300);
    if (!busy) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  logLine('端口等待超时，仍继续尝试启动');
  return true;
}

// ---------------------------------------------------------------------------
// 交互式启动菜单
//
// 只在"双击启动"的场景下出现：没有任何命令行参数 + 有真实控制台 + 未被显式禁用。
// 脚本调用（带参数）时一律不弹菜单，避免影响自动化。
// ---------------------------------------------------------------------------
const MENU_MODE_ARGS = {
  1: [],                                        // 普通启动
  2: ['--proxy'],                               // 加速启动（顺带设置系统代理）
  3: ['--elevate', '--proxy'],                  // 管理员 + 系统代理
  4: ['--elevate'],                             // 管理员，不动系统代理
};

function shouldShowMenu() {
  // 提权后的新进程带着 --decided：用户在旧窗口已经选过了，直接执行，别再问一遍。
  if (ARGS.decided) return false;
  if (process.argv.length > 2) return false;              // 有参数 → 脚本调用
  if (process.env.ACCEL_NO_MENU === '1') return false;    // 显式禁用
  if (process.env.ACCEL_FORCE_MENU === '1') return true;  // 显式强制（测试用）
  if (!process.stdout.isTTY) return false;                // 非交互环境（管道/重定向）
  return true;
}

/**
 * 读一行输入。
 *
 * 有真实控制台时用 readline 交互读；
 * stdin 是管道时（`echo 2 | node launcher.js`）readline 收不到，
 * 改用同步读 —— 这样菜单逻辑才可能被自动化测试覆盖。
 */
function ask(question) {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    try {
      const buf = fs.readFileSync(0, 'utf8');
      const line = String(buf).split(/\r?\n/)[0] || '';
      process.stdout.write(line + '\n');
      return Promise.resolve(line.trim());
    } catch (_) {
      return Promise.resolve('');
    }
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(String(ans || '').trim()); });
  });
}

/**
 * 「按任意键继续」，最多等 maxSeconds 秒。
 *
 * 用于提权成功后的旧窗口：那里已经没有活要干了，唯一目的是
 * 让用户看清"新窗口已经接管"，而不是以为程序闪退。
 * 加上超时是为了自动化测试/脚本调用时不会永久卡住。
 */
function waitForKey(prompt, maxSeconds = 60) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.setRawMode(false); } catch (_) {}
      process.stdin.pause();
      try { process.stdin.removeListener('data', onData); } catch (_) {}
      resolve('');
    };
    const onData = () => { process.stdout.write('\n'); finish(); };
    const timer = setTimeout(finish, maxSeconds * 1000);
    try { process.stdin.setRawMode(true); } catch (_) {}
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdout.write(`  ${C.d}${prompt}${C.r}`);
  });
}

/** 读取当前系统代理是否指向本加速器，用于菜单里显示"加速已开启" */
function systemProxyPointsHere(port) {
  return Promise.all([regGet('ProxyEnable'), regGet('ProxyServer')]).then(([en, sv]) => {
    // 两项都要看：只看 ProxyServer 的话，代理开关是关的（用户根本没在用代理）
    // 也会显示"系统代理已开启"，属于误报。
    if (!en.ok || !sv.ok) return false;
    return String(en.value) === '1' && String(sv.value || '').includes(`127.0.0.1:${port}`);
  });
}

async function showMenu(uiPort) {
  const { isElevated } = require('./elevate');
  const elevated = isElevated();
  const hosts = require('./lib/hosts');
  const writable = hosts.canWrite();
  const proxyOn = await systemProxyPointsHere(ARGS.port);

  console.log('');
  console.log(`  ${C.b}${C.cyan}IPv6 通用下载加速器${C.r}`);
  console.log('');
  console.log(`  ${C.d}当前状态：${C.r}` +
    `管理员 ${elevated ? C.g + '是' + C.r : C.y + '否' + C.r}   ` +
    `hosts 可写 ${writable.ok ? C.g + '是' + C.r : C.y + '否' + C.r}   ` +
    `系统代理 ${proxyOn ? C.g + '已开启' + C.r : C.d + '未开启' + C.r}`);
  console.log('');

  // 提示文案按实际权限走。
  // 之前只有"非管理员"才提示，导致已经是管理员时用户看到一堆重复说明，
  // 还得自己判断 1 和 3 到底差在哪。
  if (elevated) {
    console.log(`  ${C.d}已是管理员，所有模式都可用（含 Steam / Epic 等游戏平台）。${C.r}`);
  } else {
    console.log(`  ${C.d}提示：游戏平台（Steam / Epic 等）需要管理员权限，选 3 会自动弹一次 UAC；${C.r}`);
    console.log(`  ${C.d}      浏览器和 IDM 的代理模式不需要，选 1 或 2 即可。${C.r}`);
  }
  console.log('');

  console.log(`  ${C.b}[1]${C.r} 普通启动`);
  console.log(`      ${C.d}只开界面。浏览器 / IDM 手动填代理 127.0.0.1:${ARGS.port}${C.r}`);
  console.log(`  ${C.b}[2]${C.r} 加速启动 ${C.g}（推荐）${C.r}`);
  console.log(`      ${C.d}自动把系统代理指向本程序，浏览器 / IDM 立刻生效${C.r}`);
  console.log(`      ${C.d}退出时自动还原原来的代理设置${C.r}`);

  if (elevated) {
    // 已经是管理员了，再给"提权"选项就是纯粹的无意义操作：
    // 选了也只是走 isElevated() 分支打个勾而已。直接说明结论。
    console.log(`  ${C.g}[3]${C.r} 加速启动 ${C.d}（当前已是管理员，游戏平台模式已可用）${C.r}`);
    console.log(`  ${C.g}[4]${C.r} 启动但不动系统代理 ${C.d}（当前已是管理员）${C.r}`);
  } else {
    console.log(`  ${C.b}[3]${C.r} 加速启动 + 管理员权限`);
    console.log(`      ${C.d}上面的功能，外加游戏平台模式（Steam / Epic / 战网……）${C.r}`);
    console.log(`  ${C.b}[4]${C.r} 管理员启动，不动系统代理`);
    console.log(`      ${C.d}只想用游戏平台模式、不想改系统代理时选这个${C.r}`);
  }

  console.log(`  ${C.b}[h]${C.r} 查看命令行用法`);
  console.log(`  ${C.b}[q]${C.r} 退出`);
  console.log('');

  for (let attempt = 0; attempt < 5; attempt++) {
    const ans = (await ask(`  ${C.b}请选择 [1/2/3/4/h/q]（直接回车 = 2 加速启动）：${C.r}`)).toLowerCase();

    if (ans === '' || ans === '2') return { args: MENU_MODE_ARGS[2] };
    if (ans === '1') return { args: MENU_MODE_ARGS[1] };
    // 3/4 **一律**带 --elevate，哪怕当前窗口已经是管理员。
    //
    // 这里之前按"已是管理员就不带 --elevate"优化过一次，结果把管理员模式
    // 彻底弄坏了：'当前是不是管理员' 和 '正在跑的实例是不是管理员' 是两件事。
    // 不带 --elevate 的新进程一旦检测到已有实例，就走"已在运行 → 打开浏览器 → 退出"
    // 分支，于是**旧的非管理员实例继续运行**，hosts 永远不可写。
    // 表现就是：用户选了 3、UAC 也点了是，界面却仍然提示"需要管理员"。
    if (ans === '3') return { args: MENU_MODE_ARGS[3] };
    if (ans === '4') return { args: MENU_MODE_ARGS[4] };
    if (ans === 'q' || ans === 'exit') return { exit: true };
    if (ans === 'h' || ans === 'help' || ans === '--help') return { help: true };

    console.log(`  ${C.y}没看懂「${ans}」，请输入 1 / 2 / 3 / 4 / h / q${C.r}`);
  }

  console.log(`  ${C.d}多次输入无效，按默认（2 加速启动）继续。${C.r}`);
  return { args: MENU_MODE_ARGS[2] };
}

function printCliHelp() {
  console.log(`
  ${C.b}命令行用法${C.r}

    start.cmd                    双击用：弹出上面的菜单
    start.cmd --proxy            加速启动（自动设置系统代理，退出还原）
    start.cmd --elevate          管理员启动（游戏平台模式需要）
    start.cmd --elevate --proxy  管理员 + 系统代理
    start.cmd --port 9000        换端口（界面端口自动为 9001）
    start.cmd --no-open          启动但不自动开浏览器
    start.cmd --policy v6        默认只走 IPv6

  ${C.b}命令行测速（不用开界面）${C.r}

    node cli.js --env            查看本机 IPv6 环境
    node cli.js <域名或URL>      对比该目标的 IPv4 / IPv6 实测速度
    node cli.js <URL> --quick    只测延迟
    node cli.js <URL> --json     输出 JSON

  ${C.b}出问题时${C.r}

    先看 ${C.b}startup.log${C.r} —— 里面记录了完整的启动过程和错误原因
    系统代理卡住导致上不了网 → 双击 ${C.b}restore-proxy.cmd${C.r}
`);
}

/**
 * 派一个独立的看门狗进程，负责在"非正常退出"时兜底还原系统代理。
 *
 * 为什么要独立进程：实测确认 Windows 上
 *   - 任务管理器结束进程
 *   - 外部 process.kill 发 SIGINT/SIGTERM（直接 TerminateProcess，
 *     signal handler 和 exit 事件都不会触发）
 *   - 关闭控制台窗口
 * 这三种情况下本进程的收尾代码**完全没有机会执行**。
 * 必须在外面留一个"目击者"。
 *
 * detached + unref：看门狗要能活过本进程，但不能拖住本进程退出。
 */
function startWatchdog(token) {
  try {
    const wd = spawn(process.execPath, [
      path.join(__dirname, 'watchdog.js'),
      '--pid', String(process.pid),
      '--token', token,
    ], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    wd.unref();
    return wd.pid;
  } catch (e) {
    logLine(`[警告] 看门狗启动失败: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  // ---- 双击启动时先弹交互菜单 ----
  // 只在"没有参数 + 真实控制台"时出现，脚本调用一律跳过。
  if (shouldShowMenu()) {
    const choice = await showMenu(ARGS.port + 1);
    if (choice.exit) {
      logLine('用户在菜单选择退出');
      process.exit(0);
    }
    if (choice.help) {
      printCliHelp();
      logLine('用户在菜单查看帮助');
      const again = await ask(`  ${C.d}按回车退出……${C.r}`);
      void again;
      process.exit(0);
    }
    if (choice.args) {
      applyArgs([...choice.args, '--port', String(ARGS.port)]);
      logLine(`菜单选择生效: proxy=${ARGS.proxy} elevate=${ARGS.elevate}`);
    }
  }

  if (ARGS.help) { printCliHelp(); process.exit(0); }

  const uiPort = ARGS.port + 1;

  // ---- 需要管理员权限时，先提权再继续 ----
  //
  // Steam / Epic 这类模式必须写 hosts，而写 hosts 需要管理员。
  // 与其让用户自己去"右键 → 以管理员身份运行"，不如直接弹一次 UAC。
  if (ARGS.elevate) {
    const { isElevated, relaunchAsAdmin } = require('./elevate');
    if (isElevated()) {
      logLine('已具备管理员权限，继续正常启动');
      console.log(`  ${C.g}✓ 已以管理员身份运行，hosts 模式（Steam / Epic 等）可以正常使用。${C.r}`);
    } else {
      console.log('');
      console.log(`  ${C.y}即将弹出管理员授权（UAC）对话框，请点「是」。${C.r}`);
      console.log(`  ${C.d}hosts 模式（Steam / Epic / EA 等）需要管理员权限才能写入。${C.r}`);
      console.log('');
      logLine('请求提权重启');
      // 记下旧实例的 pid：等新实例就绪时要把它排掉
      const oldInfo = readPidFileInfo();
      const oldPid = oldInfo && pidAlive(oldInfo.pid) ? oldInfo.pid : 0;
      // 必须转发**有效参数**，而不是 process.argv.slice(2)。
      //
      // 这里曾经是本项目最反直觉的一个 bug：双击 start.cmd 时 argv 里只有
      // [node, launcher.js]，slice(2) 是空数组。用户选 3 明明是要
      // "管理员 + 系统代理"，可转发给新进程的是零参数 —— 于是
      //   1) 新进程不知道要设系统代理，--proxy 丢了；
      //   2) 新进程零参数 → shouldShowMenu() 为真 → 菜单又弹一次；
      // 于是用户必须在弹出的第二个窗口里**再选一次 3**，非常莫名其妙。
      //
      // 注意：不能直接转发 ARGS.rest —— 那是**给 server.js** 的参数，
      // 里面是 --system-proxy（告诉界面"代理已指向本程序"），
      // 而 launcher 自己判断要不要改系统代理看的是 --proxy。
      // 两者语义不同，必须显式带上 --proxy，否则新进程不会设系统代理。
      // --elevate 也必须转发。新进程虽然已经是管理员了，但它要靠这个标记
      // 走"替换掉旧的非管理员实例"的分支；没有它，新进程会认为
      // "已经有实例在跑"然后直接退出，管理员权限依旧不生效。
      //
      // --no-open 是故意加的：浏览器必须由**本进程（未提权）**代开。
      // 从提权后的进程里打开 http:// 链接会以高完整性级别启动浏览器，
      // Edge / Chrome 在这种情况下经常直接打不开（或弹"无法以管理员身份运行"），
      // 表现就是"选完 3 之后没有自动弹出网页"。
      const forward = ['--port', String(ARGS.port), '--elevate', '--no-open'];
      if (ARGS.proxy) forward.push('--proxy');
      forward.push('--decided');
      logLine(`提权转发参数: ${JSON.stringify(forward)}`);
      const r = await relaunchAsAdmin(forward);
      if (r.ok) {
        logLine('提权成功，已在新窗口启动，本进程退出');
        console.log('');
        console.log(`  ${C.g}✓ 已在新的管理员窗口中启动加速器。${C.r}`);
        if (ARGS.proxy) {
          console.log(`  ${C.g}  新的窗口已经接管了系统代理 —— 不用再选一次了。${C.r}`);
        }
        console.log('');

        // 等新实例的界面起来，再由本进程打开浏览器（本进程没提权，能正常唤起浏览器）
        if (ARGS.open) {
          const uiPort = ARGS.port + 1;
          const url = `http://127.0.0.1:${uiPort}`;
          process.stdout.write(`  ${C.d}等待新实例就绪……${C.r}`);
          const ready = await waitForUi(uiPort, 30000, oldPid);
          if (ready) {
            console.log(` ${C.g}就绪${C.r}`);
            logLine(`新实例界面已就绪（${uiPort}），打开浏览器`);
            openBrowser(url);
            console.log(`  ${C.d}已帮你打开 ${url}${C.r}`);
          } else {
            console.log(` ${C.y}超时${C.r}`);
            logLine(`等待新实例界面超时（${uiPort}），未自动打开浏览器`);
            console.log(`  ${C.y}新窗口还没起来，请手动打开：${C.b}${url}${C.r}`);
          }
          console.log('');
        }

        console.log(`  ${C.b}这个窗口的任务已经完成，可以关掉了：${C.r}`);
        console.log(`  ${C.d}按任意键关闭，或直接点右上角 ×。新窗口会继续运行。${C.r}`);
        console.log('');
        // 不立刻退出：start.cmd 结尾有 pause，但提权路径走的是 Start-Process
        // 派生的新控制台，这个旧窗口如果瞬间消失，用户会以为"闪退"，
        // 甚至以为提权失败了又去点一次。给一个明确的停留点。
        await waitForKey('按任意键关闭这个窗口……', 60);
        logLine('提权后旧窗口退出');
        process.exit(0);
      }
      logLine(`提权失败: ${r.error}`);
      console.log(`  ${C.red}✗ 没有获得管理员权限：${r.error}${C.r}`);
      console.log('');
      console.log('  接下来：');
      console.log(`    ${C.b}按回车${C.r}  以普通权限继续（浏览器 / IDM 代理完全可用，`);
      console.log(`             只是 Steam / Epic 这类 hosts 模式用不了）`);
      console.log(`    ${C.b}按 q${C.r}    退出，改用「右键 start.cmd → 以管理员身份运行」`);
      console.log('');
      const again = await ask(`  ${C.d}按回车继续（3 秒后自动继续）：${C.r}`);
      if (again.toLowerCase() === 'q') {
        logLine('提权失败后用户选择退出');
        process.exit(0);
      }
    }
  } else {
    // 没要求提权，但提醒一下 hosts 模式会不可用
    try {
      const hosts = require('./lib/hosts');
      const w = hosts.canWrite();
      if (!w.ok) {
        logLine(`hosts 不可写: ${w.error}`);
        console.log(`  ${C.d}提示：当前不是管理员权限，hosts 模式（Steam / Epic）不可用；${C.r}`);
        console.log(`  ${C.d}      浏览器代理模式不受影响。需要 hosts 模式请在上面的菜单里选 3。${C.r}`);
        console.log('');
      }
    } catch (_) {}
  }

  // ---- 已经在跑？直接开界面，不当成错误 ----
  //
  // 检测顺序很重要：
  //   1) PID 文件 —— 只有"端口绑好了"之后才写，最可信
  //   2) 界面端口 —— 界面服务才会响应 /api/health
  //   3) 代理端口 —— 它按 HTTP 代理规则解析请求，探测时要用绝对 URL
  //
  // 早期版本直接对代理端口发 GET /api/health，被代理当成"要转发 /api/health
  // 这个相对地址"而永远失败，于是检测形同虚设 —— 已在运行时双击 start.cmd
  // 会启动第二个实例，端口冲突退出 code=1，表现就是"黑窗口闪退"。
  logLine(`探测已有实例: pid文件 / ${uiPort} / ${ARGS.port}`);

  const pidInfo = readPidFileInfo();
  const pidOk = pidInfo && pidAlive(pidInfo.pid);
  logLine(`PID 文件: ${pidInfo ? JSON.stringify(pidInfo) : '无'}  进程存活=${pidOk}`);

  let found = null;
  if (pidOk) {
    found = { pid: pidInfo.pid, uiPort: pidInfo.uiPort || uiPort, proxyPort: pidInfo.proxyPort || ARGS.port, via: 'pid文件' };
  } else {
    const byUi = await probeMine(uiPort);
    logLine(`界面端口 ${uiPort} 探测: ${JSON.stringify(byUi)}`);
    if (byUi.mine) found = { ...byUi, uiPort, proxyPort: ARGS.port, via: '界面探测' };
    else {
      const byProxy = await probeMine(ARGS.port);
      logLine(`代理端口 ${ARGS.port} 探测: ${JSON.stringify(byProxy)}`);
      if (byProxy.mine) found = { ...byProxy, uiPort, proxyPort: ARGS.port, via: '代理探测' };
    }
  }

  if (found) {
    // 用 --elevate 启动时，用户是明确想"换成管理员实例"。
    // 这时不能只是打开浏览器就退出 —— 那样管理员权限根本没生效，
    // 用户会以为提权成功了、界面却仍然显示"需要管理员"。
    if (ARGS.elevate) {
      console.log('');
      console.log(`  ${C.y}检测到已有实例（pid ${found.pid}），正在替换为管理员实例……${C.r}`);
      console.log(`  ${C.d}因为 hosts 模式需要管理员权限，旧的非管理员实例必须让位。${C.r}`);
      console.log('');
      const freed = await replaceExistingInstance(found);
      if (!freed) {
        console.log(`  ${C.red}请先手动结束旧实例，再重新以管理员身份运行 start.cmd。${C.r}`);
        console.log('');
        process.exit(1);
      }
      console.log(`  ${C.g}✓ 旧实例已停止，继续以管理员身份启动。${C.r}`);
      console.log('');
      // 落到下面正常启动流程
    } else {
      console.log('');
      console.log(`  ${C.g}加速器已经在运行中${C.r}（pid ${found.pid}，通过${found.via}确认）`);
      console.log(`  ${C.d}界面地址：http://127.0.0.1:${found.uiPort}${C.r}`);
      console.log(`  ${C.d}代理地址：http://127.0.0.1:${found.proxyPort}${C.r}`);
      console.log('');
      console.log(`  ${C.d}不需要重复启动，已帮你打开界面。${C.r}`);
      console.log(`  ${C.d}要停掉它：在那个黑窗口里按 Ctrl+C，或用任务管理器结束 pid ${found.pid}。${C.r}`);
      if (ARGS.proxy) {
        console.log('');
        console.log(`  ${C.y}注意：你用的是「一键开启系统代理」，但当前实例不是它启动的，${C.r}`);
        console.log(`  ${C.y}      所以退出时不会自动还原系统代理。如需接管，请先结束 pid ${found.pid}。${C.r}`);
      }
      console.log('');
      openBrowser(`http://127.0.0.1:${found.uiPort}`);
      logLine(`检测到已有实例 pid=${found.pid}（${found.via}），打开浏览器后退出。这是正常结束，不是闪退。`);
      process.exit(0);
    }
  }

  // ---- 端口被别的程序占用？给出明确指引 ----
  const occupiedProxy = await probeTcp(ARGS.port);
  const occupiedUi = await probeTcp(uiPort);
  logLine(`端口占用: proxy(${ARGS.port})=${occupiedProxy}  ui(${uiPort})=${occupiedUi}`);

  if (occupiedProxy || occupiedUi) {
    const which = [];
    if (occupiedProxy) which.push(`${ARGS.port}（代理端口）`);
    if (occupiedUi) which.push(`${uiPort}（界面端口）`);
    console.log('');
    console.log(`  ${C.y}[提示] 端口已被其他程序占用：${which.join('、')}${C.r}`);
    console.log(`  ${C.d}占用者不是本加速器（已核对服务标识）。${C.r}`);
    console.log('');
    console.log('  换一对端口启动即可：');
    console.log(`     ${C.b}start.cmd --port ${ARGS.port + 100}${C.r}`);
    console.log(`  界面地址会变成 http://127.0.0.1:${ARGS.port + 101}`);
    console.log('');
    logLine(`端口被非本程序占用，退出。建议 --port ${ARGS.port + 100}`);
    process.exit(4);   // 4 = 端口被别人占了
  }

  // ---- 设置系统代理（可选） ----
  //
  // 注意：ProxyOverride（绕过列表）也**必须**一起备份还原。
  // 用户原本可能有一长串分流规则（*zhihu.com;*jd.com;...），
  // 如果只还原 ProxyEnable/ProxyServer 而把绕过列表留在我们的默认值，
  // 就会静默破坏用户原有的代理分流配置。
  let saved = null;
  const restore = async () => {
    if (!ARGS.proxy || !saved) return { done: false, reason: 'not-enabled' };
    const r = await applyRestore(saved);
    if (r && r.partial) {
      console.log(`  ${C.y}⚠ 只还原了代理开关，没动你的服务器/绕过列表${C.r}`);
      console.log(`  ${C.d}  （${r.skipped.join('、')} 读取失败，为安全起见未做删除）${C.r}`);
    }
    clearRecovery();
    return r;
  };

  if (ARGS.proxy) {
    // 令牌用来区分"这一次会话"。看门狗只在令牌对得上时才动手，
    // 避免把下一次运行刚写好的恢复文件误用掉。
    const token = `${process.pid}-${Date.now().toString(36)}`;

    const cur = await readProxySettings();
    if (!cur.ok) {
      // 读不到原设置就改系统代理 = 无法安全还原 = 可能把用户配置删掉。
      // 直接拒绝，比"先改了再说"安全得多。
      logLine(`[拒绝] 无法读取原代理设置: ${cur.error}`);
      console.log('');
      console.log(`  ${C.red}✗ 无法读取你当前的系统代理设置，本次不会改动它。${C.r}`);
      console.log(`  ${C.d}  原因：${cur.error}${C.r}`);
      console.log('');
      console.log('  这通常发生在系统被安全软件限制时。可以选 [1] 正常启动，');
      console.log('  然后在浏览器 / IDM 里手动填代理地址：');
      console.log(`     ${C.b}http://127.0.0.1:${ARGS.port}${C.r}`);
      console.log('');
      process.exit(5);   // 5 = 读不到原代理设置，已放弃接管
    }

    saved = {
      enable: cur.enable,
      server: cur.server,
      override: cur.override,
      // 记录"哪些项是确认不存在、可以安全删除的"。
      // 空数组 = 三项都读到了，null 值的那些确实是原本就没有，可以删。
      unknown: [],
      at: new Date().toISOString(),
      port: ARGS.port,
      token,
    };

    // 上一次还原被中断留下的僵尸标记会让本次还原整段跳过（代理就再也还原不回去），
    // 所以接管前先清一次。
    if (clearStaleClaim()) logLine('[清理] 发现上次还原遗留的互斥标记（对应进程已不在），已清除');

    // 先落盘再改设置：万一改到一半崩了，还能靠这个文件恢复
    const ok = writeRecovery(saved);
    if (ok && ok.exists) {
      // 上一次会话的备份还留在磁盘上 —— 说明上次是被强杀的，
      // 代理很可能还指着已经死掉的端口。这时直接改会毁掉那份唯一能救人的备份。
      const stale = readRecovery();
      logLine(`[拒绝] 存在未清理的恢复文件（token=${stale && stale.token}），放弃接管系统代理`);
      console.log('');
      console.log(`  ${C.y}⚠ 检测到上次运行没有正常收尾，系统代理可能还指着已停止的端口。${C.r}`);
      console.log('');
      console.log('  请先双击这个文件还原代理，再重新启动：');
      console.log(`     ${C.b}restore-proxy.cmd${C.r}`);
      console.log('');
      console.log(`  ${C.d}（如果只是想正常用加速器，可以选 [1] 或按 Ctrl+C 退出本次启动。）${C.r}`);
      console.log('');
      process.exit(6);   // 6 = 有未清理的恢复文件，已放弃接管
    }
    if (!ok) {
      // 写不出备份 = 出异常后没法自动还原 = 不能改系统代理
      logLine('[拒绝] 无法写入恢复文件，放弃接管系统代理');
      console.log('');
      console.log(`  ${C.y}⚠ 无法写入代理恢复文件，本次不会改动系统代理。${C.r}`);
      console.log(`  ${C.d}  否则一旦异常退出，你将无法自动恢复原来的代理设置。${C.r}`);
      console.log('');
      console.log(`  仍可正常使用：浏览器 / IDM 手动填代理 ${C.b}http://127.0.0.1:${ARGS.port}${C.r}`);
      console.log('');
      process.exit(5);
    }

    console.log('');
    console.log(`  ${C.d}已备份原代理设置，退出时会完整还原（含绕过列表）。${C.r}`);

    await regSet('ProxyEnable', 'REG_DWORD', '1');
    await regSet('ProxyServer', 'REG_SZ', `http://127.0.0.1:${ARGS.port}`);
    await regSet('ProxyOverride', 'REG_SZ', 'localhost;127.*;10.*;172.16.*;192.168.*;<local>');

    // 派看门狗盯着自己。
    //
    // 只在"退出时还原"是不够的 —— 实测确认 Windows 上任务管理器结束进程、
    // 外部 signal、关闭控制台窗口都会让收尾代码完全没机会执行，
    // 结果就是代理留在已停止的端口上、用户直接上不了网。
    startWatchdog(token);
    logLine(`看门狗已派出（token=${token.slice(0, 12)}）`);

    console.log(`  ${C.g}✓${C.r} 系统代理已指向 ${C.b}http://127.0.0.1:${ARGS.port}${C.r}`);
    console.log(`  ${C.d}退出本程序时会自动还原（含绕过列表）。${C.r}`);
    console.log(`  ${C.d}即使被强杀或崩溃，看门狗也会兜底还原。${C.r}`);
  }

  // ---- 启动服务 ----
  console.log('');
  console.log(`  ${C.b}${C.cyan}IPv6 通用下载加速器${C.r}`);
  console.log(`  ${C.d}正在启动，稍后会自动打开浏览器界面……${C.r}`);
  console.log('');

  const serverPath = path.join(__dirname, 'server.js');
  logLine(`启动 server.js: ${serverPath}`);
  if (!fs.existsSync(serverPath)) {
    logLine(`[致命] 找不到 server.js`);
    console.error(`\n  ${C.red}[错误]${C.r} 找不到 ${serverPath}`);
    console.error(`  请确认 server.js 和 launcher.js 在同一个目录里。\n`);
    process.exit(1);
  }

  const child = spawn(process.execPath, [serverPath, ...ARGS.rest], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  logLine(`server.js 已派生, pid=${child.pid}`);

  // 等界面起来再开浏览器
  let opened = false;
  const tryOpen = async () => {
    if (opened) return;
    for (let i = 0; i < 30; i++) {
      // 关键：必须确认是"我们自己的服务"才开浏览器。
      // 否则另一个占着该端口的程序（或旧实例）会让这里误报成功。
      const probe = await probeMine(uiPort);
      if (probe.mine) {
        opened = true;
        console.log('');
        console.log(`  ${C.g}✓ 界面已就绪${C.r}  ${C.b}${C.cyan}http://127.0.0.1:${uiPort}${C.r}`);
        console.log(`  ${C.d}把浏览器 / IDM / aria2 的代理设为 http://127.0.0.1:${ARGS.port}${C.r}`);
        console.log(`  ${C.d}按 Ctrl+C 退出${C.r}`);
        console.log('');
        logLine(`界面就绪于 ${uiPort}（pid=${probe.pid}），打开浏览器`);
        openBrowser(`http://127.0.0.1:${uiPort}`);
        return;
      }
      // 子进程已经退了就别再等了
      if (child.exitCode !== null || child.signalCode) {
        logLine(`子进程已退出（code=${child.exitCode}），停止等待界面`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    logLine(`[警告] 界面在 15 秒内没有就绪`);
    console.log(`  ${C.y}[提示] 界面在 15 秒内没有就绪。${C.r}`);
    console.log(`  ${C.d}详细信息见 ${LOG_FILE}${C.r}`);
  };
  tryOpen();

  // SIGINT / SIGTERM / child exit / child error 都会走到这里。
  // 之前没有守卫，同一次退出能把注册表连写三遍；而且第一次 await restore()
  // 还没完成时第二次就调了 process.exit —— 状态会停在"改了一半"。
  let byed = false;
  const bye = async (code) => {
    if (byed) return;
    byed = true;
    logLine(`退出流程开始 (code=${code})`);

    const r = await restore();
    if (ARGS.proxy) {
      if (r && r.partial) {
        console.log(`\n  ${C.y}✓${C.r} 已关闭系统代理开关；你的服务器/绕过列表因读取失败被原样保留。\n`);
      } else {
        console.log(`\n  ${C.g}✓${C.r} 系统代理已还原为原设置。\n`);
      }
    }

    // 给出人类看得懂的收尾结论
    if (code === 3) {
      console.log(`  ${C.y}服务没能启动：端口冲突。${C.r}`);
      console.log(`  ${C.d}如果加速器本来就在运行，直接打开界面即可，不用重复启动。${C.r}`);
    } else if (code === 4) {
      console.log(`  ${C.y}服务没能启动：端口被其他程序占用。${C.r}`);
    } else if (code === 5) {
      // 已经在前面提示过了，这里不重复
    } else if (code && code !== 0) {
      console.log(`  ${C.y}服务异常退出（code=${code}）。${C.r}`);
      console.log(`  ${C.d}详细原因见 ${LOG_FILE}${C.r}`);
    }

    logLine('退出流程结束');
    process.exit(code == null ? 0 : code);
  };

  child.on('error', (e) => {
    logLine(`[致命] server.js 派生失败: ${e.message}`);
    console.error(`\n  ${C.red}[错误]${C.r} 无法启动 server.js: ${e.message}\n`);
    bye(1);
  });
  child.on('exit', (code, signal) => {
    logLine(`server.js 退出 code=${code} signal=${signal}`);
    bye(code);
  });
  process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch (_) {} bye(0); });
  process.on('SIGTERM', () => { try { child.kill(); } catch (_) {} bye(0); });

  // 最后一道防线：未捕获异常时也要把代理还原回去，否则用户会莫名断网。
  // 这里用同步版，因为进程马上就要死了，等不了异步回调。
  const fatalRestore = (tag, e) => {
    logLine(`[${tag}] ${e && e.stack ? e.stack : e}`);
    if (ARGS.proxy && !restoreDone) {
      try { applyRestoreSync(saved); } catch (err) { logLine(`[${tag}] 同步还原失败: ${err.message}`); }
    }
  };
  process.on('uncaughtException', (e) => {
    console.error(`\n  ${C.red}[未捕获异常]${C.r} ${e && e.stack ? e.stack : e}`);
    fatalRestore('未捕获异常', e);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    console.error(`\n  ${C.red}[未处理的 Promise 拒绝]${C.r} ${e && e.stack ? e.stack : e}`);
    fatalRestore('未处理的 Promise 拒绝', e);
    process.exit(1);
  });
}

// 只有被直接运行时才执行主流程；被 require 时（如 restore-proxy.js）只导出工具函数
if (require.main === module) {
  main().then(() => {
    logLine('main() 正常返回');
  }).catch((e) => {
    logLine(`[致命] main() 抛出异常: ${e && e.stack ? e.stack : e}`);
    console.error(`\n  ${C.red}[错误]${C.r} ${e && e.stack ? e.stack : e.message}\n`);
    console.error(`  详细信息已写入: ${LOG_FILE}`);
    console.error(`  如果看不懂，把这个文件发给别人看即可。\n`);
    process.exit(1);
  });
}

module.exports = {
  applyRestore,
  applyRestoreSync,
  readRecovery,
  writeRecovery,
  clearRecovery,
  stopExistingInstance,
  replaceExistingInstance,
  readPidFileInfo,
  pidAlive,
  regGet,
  readProxySettings,
  destructiveTargets,
  RECOVERY_FILE,
  PROXY_KEY,
  // 供测试重置内部状态（生产代码不会调用）
  __resetRestoreGuard: () => { restoreDone = false; },
  // 供测试替换注册表写入实现，从而能断言"到底执行了哪些命令"
  __setRegExec: (fn) => { execRegImpl = fn; },
};
