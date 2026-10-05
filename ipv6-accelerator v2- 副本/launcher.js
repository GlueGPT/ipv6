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
  const a = { port: DEFAULT_PORT, open: true, proxy: false, elevate: false, rest: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port' || k === '-p') { a.port = Number(argv[++i]); }
    else if (k === '--no-open') { a.open = false; }
    else if (k === '--proxy') { a.proxy = true; }      // 顺带设置系统代理（退出还原）
    else if (k === '--elevate') { a.elevate = true; }  // 以管理员身份重新启动
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

/** 读取当前系统代理是否指向本加速器，用于菜单里显示"加速已开启" */
function systemProxyPointsHere(port) {
  return new Promise((resolve) => {
    exec(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(String(stdout).includes(`127.0.0.1:${port}`));
      }
    );
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

  if (!elevated) {
    console.log(`  ${C.d}提示：游戏平台（Steam / Epic 等）需要管理员权限；${C.r}`);
    console.log(`  ${C.d}      浏览器和 IDM 的代理模式不需要，选 1 或 2 即可。${C.r}`);
    console.log('');
  }

  console.log(`  ${C.b}[1]${C.r} 普通启动`);
  console.log(`      ${C.d}只开界面。浏览器 / IDM 手动填代理 127.0.0.1:${ARGS.port}${C.r}`);
  console.log(`  ${C.b}[2]${C.r} 加速启动 ${C.g}（推荐）${C.r}`);
  console.log(`      ${C.d}自动把系统代理指向本程序，浏览器 / IDM 立刻生效${C.r}`);
  console.log(`      ${C.d}退出时自动还原原来的代理设置${C.r}`);
  console.log(`  ${C.b}[3]${C.r} 加速启动 + 管理员权限`);
  console.log(`      ${C.d}上面的功能，外加游戏平台模式（Steam / Epic / 战网……）${C.r}`);
  console.log(`  ${C.b}[4]${C.r} 管理员启动，不动系统代理`);
  console.log(`      ${C.d}只想用游戏平台模式、不想改系统代理时选这个${C.r}`);
  console.log(`  ${C.b}[h]${C.r} 查看命令行用法`);
  console.log(`  ${C.b}[q]${C.r} 退出`);
  console.log('');

  for (let attempt = 0; attempt < 5; attempt++) {
    const ans = (await ask(`  ${C.b}请选择 [1/2/3/4/h/q]（直接回车 = 2 加速启动）：${C.r}`)).toLowerCase();

    if (ans === '' || ans === '2') return { args: MENU_MODE_ARGS[2] };
    if (ans === '1') return { args: MENU_MODE_ARGS[1] };
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
      // 必须把 --elevate 摘掉再传下去，否则万一 isElevated() 判断不准就会无限弹 UAC
      const forward = process.argv.slice(2).filter((x) => x !== '--elevate' && x !== '--no-open');
      const r = await relaunchAsAdmin(forward);
      if (r.ok) {
        logLine('提权成功，已在新窗口启动，本进程退出');
        console.log(`  ${C.g}✓ 已在新的管理员窗口中启动加速器。${C.r}`);
        console.log(`  ${C.d}这个窗口可以关掉了，请看新弹出的窗口。${C.r}`);
        console.log('');
        process.exit(0);
      }
      logLine(`提权失败: ${r.error}`);
      console.log(`  ${C.red}✗ 提权失败：${r.error}${C.r}`);
      console.log('');
      console.log('  你可以：');
      console.log('    1. 继续用普通权限运行（浏览器代理模式仍然完全可用）');
      console.log('    2. 或者手动：右键 start.cmd → 以管理员身份运行');
      console.log('');
      // 不直接退出，让用户仍然能用代理模式
      console.log(`  ${C.d}3 秒后按普通权限继续启动……${C.r}`);
      await new Promise((r2) => setTimeout(r2, 3000));
    }
  } else {
    // 没要求提权，但提醒一下 hosts 模式会不可用
    try {
      const hosts = require('./lib/hosts');
      const w = hosts.canWrite();
      if (!w.ok) {
        logLine(`hosts 不可写: ${w.error}`);
        console.log(`  ${C.d}提示：当前不是管理员权限，hosts 模式（Steam / Epic）不可用；${C.r}`);
        console.log(`  ${C.d}      浏览器代理模式不受影响。需要 hosts 模式请双击「以管理员身份运行.cmd」。${C.r}`);
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
        console.log(`  ${C.red}请先手动结束旧实例，再重新运行「以管理员身份运行.cmd」。${C.r}`);
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
    if (!ARGS.proxy || !saved) return;
    await applyRestore(saved);
    clearRecovery();
  };

  if (ARGS.proxy) {
    // 令牌用来区分"这一次会话"。看门狗只在令牌对得上时才动手，
    // 避免把下一次运行刚写好的恢复文件误用掉。
    const token = `${process.pid}-${Date.now().toString(36)}`;

    saved = {
      enable: (await regGet('ProxyEnable')) || '0',
      server: await regGet('ProxyServer'),
      override: await regGet('ProxyOverride'),
      at: new Date().toISOString(),
      port: ARGS.port,
      token,
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
  stopExistingInstance,
  replaceExistingInstance,
  readPidFileInfo,
  pidAlive,
  RECOVERY_FILE,
};
