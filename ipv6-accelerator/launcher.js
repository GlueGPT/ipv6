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
const { spawn, exec } = require('child_process');

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
  const a = { port: DEFAULT_PORT, open: true, proxy: false, rest: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port' || k === '-p') { a.port = Number(argv[++i]); }
    else if (k === '--no-open') { a.open = false; }
    else if (k === '--proxy') { a.proxy = true; }     // 顺带设置系统代理（退出还原）
    else a.rest.push(k);
  }
  a.rest.unshift('--port', String(a.port));
  return a;
}

const ARGS = parseArgs(process.argv);
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

function writeRecovery(data) {
  try {
    fs.writeFileSync(RECOVERY_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    // 不能静默吞掉：写不进去意味着异常退出后用户会断网且无法自动恢复
    console.error(`  [恢复文件写入失败] ${RECOVERY_FILE}`);
    console.error(`  原因: ${e.code || ''} ${e.message}`);
    return false;
  }
}

function clearRecovery() {
  try { fs.unlinkSync(RECOVERY_FILE); } catch (_) {}
}

function regGet(name) {
  return new Promise((resolve) => {
    exec(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${name}`,
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout).match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`));
        if (!m) return resolve(null);
        let v = m[1].trim();
        // reg query 对 REG_DWORD 会返回 0x0 这种十六进制，统一转成十进制存放，
        // 免得恢复文件里出现 "0x0" 这种不直观的值
        if (/^0x[0-9a-f]+$/i.test(v)) v = String(parseInt(v, 16));
        resolve(v);
      }
    );
  });
}

function regSet(name, type, value) {
  return new Promise((resolve) => {
    exec(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${name} /t ${type} /d "${value}" /f`,
      { windowsHide: true },
      () => resolve()
    );
  });
}

function regDelete(name) {
  return new Promise((resolve) => {
    exec(
      `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${name} /f`,
      { windowsHide: true },
      () => resolve()
    );
  });
}

/** 同步版还原 —— 只用于进程即将退出、来不及等异步回调的最后关头 */
function applyRestoreSync(saved) {
  if (!saved) return;
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const { execSync } = require('child_process');
  const run = (cmd) => { try { execSync(cmd, { windowsHide: true, stdio: 'ignore' }); } catch (_) {} };
  run(`reg add "${base}" /v ProxyEnable /t REG_DWORD /d ${saved.enable == null ? 0 : saved.enable} /f`);
  if (saved.server != null) run(`reg add "${base}" /v ProxyServer /t REG_SZ /d "${saved.server}" /f`);
  else run(`reg delete "${base}" /v ProxyServer /f`);
  if (saved.override != null) run(`reg add "${base}" /v ProxyOverride /t REG_SZ /d "${saved.override}" /f`);
  else run(`reg delete "${base}" /v ProxyOverride /f`);
  clearRecovery();
}

/** 读取恢复文件（供 restore-proxy.js 使用） */
function readRecovery() {
  try { return JSON.parse(fs.readFileSync(RECOVERY_FILE, 'utf8')); }
  catch (_) { return null; }
}

/**
 * 把系统代理恢复成 saved 里的设置（含绕过列表）。
 * saved 形如 { enable, server, override }，null 表示该值原本不存在。
 */
async function applyRestore(saved) {
  if (!saved) return;
  await regSet('ProxyEnable', 'REG_DWORD', saved.enable == null ? '0' : String(saved.enable));
  if (saved.server != null) await regSet('ProxyServer', 'REG_SZ', saved.server);
  else await regDelete('ProxyServer');
  if (saved.override != null) await regSet('ProxyOverride', 'REG_SZ', saved.override);
  else await regDelete('ProxyOverride');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const uiPort = ARGS.port + 1;

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
    console.log('');
    console.log(`  ${C.g}加速器已经在运行中${C.r}（pid ${found.pid}，通过${found.via}确认）`);
    console.log(`  ${C.d}界面地址：http://127.0.0.1:${found.uiPort}${C.r}`);
    console.log(`  ${C.d}代理地址：http://127.0.0.1:${found.proxyPort}${C.r}`);
    console.log('');
    console.log(`  ${C.d}不需要重复启动，已帮你打开界面。${C.r}`);
    console.log(`  ${C.d}要停掉它：在那个黑窗口里按 Ctrl+C，或用任务管理器结束 pid ${found.pid}。${C.r}`);
    console.log('');
    openBrowser(`http://127.0.0.1:${found.uiPort}`);
    logLine(`检测到已有实例 pid=${found.pid}（${found.via}），打开浏览器后退出。这是正常结束，不是闪退。`);
    process.exit(0);
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
    if (!ARGS.proxy || !saved) return;
    await applyRestore(saved);
    clearRecovery();
  };

  if (ARGS.proxy) {
    saved = {
      enable: (await regGet('ProxyEnable')) || '0',
      server: await regGet('ProxyServer'),
      override: await regGet('ProxyOverride'),
      at: new Date().toISOString(),
      port: ARGS.port,
    };

    // 先落盘再改设置：万一改到一半崩了，还能靠这个文件恢复
    const ok = writeRecovery(saved);
    if (!ok) {
      console.log(`  ${C.y}[警告] 无法写入恢复文件，异常退出时将需要手动还原代理设置。${C.r}`);
    }

    console.log('');
    console.log(`  ${C.d}原代理设置： ProxyEnable=${saved.enable}  ProxyServer=${saved.server || '(无)'}${C.r}`);
    console.log(`  ${C.d}原绕过列表： ${saved.override || '(无)'}${C.r}`);

    await regSet('ProxyEnable', 'REG_DWORD', '1');
    await regSet('ProxyServer', 'REG_SZ', `http://127.0.0.1:${ARGS.port}`);
    await regSet('ProxyOverride', 'REG_SZ', 'localhost;127.*;10.*;172.16.*;192.168.*;<local>');

    console.log(`  ${C.g}✓${C.r} 系统代理已指向 ${C.b}http://127.0.0.1:${ARGS.port}${C.r}`);
    console.log(`  ${C.d}退出本程序时会自动还原（含绕过列表）。${C.r}`);
    console.log(`  ${C.d}若本窗口被强行杀掉导致断网，双击「还原系统代理.cmd」即可恢复。${C.r}`);
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

  const bye = async (code) => {
    logLine(`退出流程开始 (code=${code})`);
    await restore();
    if (ARGS.proxy) console.log(`\n  ${C.g}✓${C.r} 系统代理已还原为原设置。\n`);

    // 给出人类看得懂的收尾结论
    if (code === 3) {
      console.log(`  ${C.y}服务没能启动：端口冲突。${C.r}`);
      console.log(`  ${C.d}如果加速器本来就在运行，直接打开界面即可，不用重复启动。${C.r}`);
    } else if (code === 4) {
      console.log(`  ${C.y}服务没能启动：端口被其他程序占用。${C.r}`);
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
  process.on('uncaughtException', (e) => {
    logLine(`[未捕获异常] ${e && e.stack ? e.stack : e}`);
    console.error(`\n  ${C.red}[未捕获异常]${C.r} ${e && e.stack ? e.stack : e}`);
    if (ARGS.proxy) applyRestoreSync(saved);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    logLine(`[未处理的 Promise 拒绝] ${e && e.stack ? e.stack : e}`);
    console.error(`\n  ${C.red}[未处理的 Promise 拒绝]${C.r} ${e && e.stack ? e.stack : e}`);
    if (ARGS.proxy) applyRestoreSync(saved);
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
  RECOVERY_FILE,
};
