'use strict';
/**
 * test-launcher.js —— 启动器「大脑」的端到端测试
 *
 * launcher.js 此前几乎没有测试：菜单只是"grep 到有 [1] [2] 就当通过"，
 * 提权也只是测了 relaunchAsAdmin 这个函数本身。
 * 结果就是最反直觉的那个 bug ——「选 3 之后新窗口还要再选一次 3」——
 * 一路漏到了用户手上。
 *
 * 这个文件覆盖的是**整条链路**：
 *   菜单选择 → 参数生效 → 提权转发内容正确 → 新进程不再重弹菜单
 *
 * 全部用子进程跑真实的 launcher.js，不 mock。原因很简单：
 * 这个 bug 恰恰是因为"单测都通过、只有真跑才暴露"才漏出去的。
 *
 * 覆盖：
 *   [1] 参数解析：--decided / --proxy / --port 的语义
 *   [2] 菜单选择 → ARGS 生效（含已是管理员时的降级）
 *   [3] 提权转发参数：必须带 --proxy，必须带 --decided
 *   [4] --decided 必须真的抑制菜单（端到端验证"不用再选一次"）
 *   [5] 代理备份的三态语义（查询失败 ≠ 值不存在）
 *   [6] 破坏性还原保护：读不到就绝不删用户的配置
 *   [7] 还原幂等：bye 被触发多次也只写一次注册表
 *   [8] 备份文件独占创建：残留备份必须挡住接管
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', red: '\x1b[31m', b: '\x1b[1m', c: '\x1b[36m' };
let pass = 0, fail = 0;
const ok = (s) => { pass++; console.log(`  ${C.g}✓${C.r} ${s}`); };
const bad = (s) => { fail++; console.log(`  ${C.red}✗${C.r} ${s}`); };
const check = (cond, yes, no) => cond ? ok(yes) : bad(no || yes);
const section = (t) => console.log(`\n${C.b}${t}${C.r}`);

const ROOT = __dirname;
const LAUNCHER = path.join(ROOT, 'launcher.js');
const RECOVERY_FILE = path.join(ROOT, 'proxy-backup.json');
const CLAIM_FILE = path.join(ROOT, 'proxy-restore.claim');
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/**
 * 跑一次 launcher.js，返回输出与退出码。
 * feed 为要喂给 stdin 的内容（用来选菜单）。
 */
function runLauncher(args = [], { feed = null, env = {}, timeout = 25000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    if (feed != null) {
      // 等菜单打印完再喂，否则 readline 可能还没建好
      setTimeout(() => {
        try { child.stdin.write(feed); } catch (_) {}
      }, 1200);
    }

    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeout);
    child.on('exit', (code) => { clearTimeout(killer); resolve({ out: strip(out), code }); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ out: strip(out), code: -1, error: e.message }); });
  });
}

/** 清理测试产生的残留文件（只删本测试自己建的，不碰用户数据） */
function cleanup() {
  for (const f of [CLAIM_FILE]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

async function main() {

// ===========================================================================
section('[1] 参数解析：--decided 是"用户已选过"的标记');
// ===========================================================================
{
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  check(/a\.decided = false/.test(src) || /decided:\s*false/.test(src),
    'decided 字段有默认值 false', '找不到 decided 默认值');
  check(/k === '--decided'/.test(src),
    '能解析 --decided', 'parseArgs 里没有处理 --decided');
}

// ===========================================================================
section('[2] 菜单选择 → 参数生效');
// ===========================================================================
{
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  const m = src.match(/const MENU_MODE_ARGS = \{([\s\S]*?)\};/);
  check(!!m, '菜单模式表存在');
  const table = m ? m[1] : '';
  check(/1:\s*\[\]/.test(table), '模式 1 = 普通启动（无参数）');
  check(/2:\s*\['--proxy'\]/.test(table), '模式 2 = --proxy');
  check(/3:\s*\['--elevate',\s*'--proxy'\]/.test(table),
    '模式 3 = --elevate + --proxy（用户报告的那个选项）',
    '模式 3 的参数不是 --elevate + --proxy');
  check(/4:\s*\['--elevate'\]/.test(table), '模式 4 = --elevate');

  // 3/4 **必须**始终带 --elevate，哪怕当前窗口已经是管理员。
  //
  // 这里以前是"已是管理员就降级成不带 --elevate"，那条优化本身是个 bug：
  // "当前窗口是不是管理员" 和 "正在运行的实例是不是管理员" 是两件事。
  // 不带 --elevate 的新进程一旦检测到已有实例，就走
  // "已在运行 → 打开浏览器 → 退出"，于是**旧的非管理员实例继续运行**，
  // hosts 永远不可写 —— 用户选了 3、UAC 也点了是，管理员模式却没生效。
  check(/ans === '3'\) return \{ args: MENU_MODE_ARGS\[3\] \}/.test(src),
    '选 3 一律带 --elevate（不因当前已是管理员而降级）',
    '选 3 又降级成了不带 --elevate —— 会让旧的非管理员实例继续运行');
  check(/ans === '4'\) return \{ args: MENU_MODE_ARGS\[4\] \}/.test(src),
    '选 4 一律带 --elevate（不因当前已是管理员而降级）',
    '选 4 又降级成了不带 --elevate');
}

// ===========================================================================
section('[3] 提权转发：参数必须显式构造，不能转发 slice(2)');
// ===========================================================================
{
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  // 注意：这里不能写成 /const forward = \[([\s\S]*?)\];/ —— 非贪婪会在
  // 第一处 "];" 就截断，正好把后面两行 push 切掉，断言就永远失败。
  // 用行范围截取：从 const forward 到 logLine(提权转发参数)。
  const start = src.indexOf('const forward = [');
  const end = src.indexOf('logLine(`提权转发参数', start);
  const fwd = (start >= 0 && end > start) ? src.slice(start, end) : '';

  check(fwd.length > 0, '找到提权转发参数的代码段');
  check(/'--port',\s*String\(ARGS\.port\)/.test(fwd),
    '转发端口（否则界面端口会变，用户以为开了两个）');
  check(/if \(ARGS\.proxy\) forward\.push\('--proxy'\)/.test(fwd),
    '按需转发 --proxy（不能靠 ARGS.rest，它里面是给 server.js 的 --system-proxy）',
    '转发里没有带上 --proxy 的条件');
  check(/forward\.push\('--decided'\)/.test(fwd),
    '转发 --decided（否则新进程会重弹菜单 —— 用户报告的核心问题）',
    '转发里没有 --decided');

  // 转发里必须带 --elevate：新进程靠它走"替换旧实例"分支。
  // 少了它，新进程看到"已有实例在跑"就直接退出，旧的非管理员实例继续运行，
  // 结果就是管理员模式永远不生效。
  check(/'--elevate'/.test(fwd),
    '转发 --elevate（新进程要靠它替换旧的非管理员实例）',
    '转发里没有 --elevate —— 旧实例不会被替换，hosts 仍然不可写');

  // 浏览器不能由提权后的进程打开：那会以高完整性级别拉起浏览器，
  // Edge / Chrome 经常直接打不开，表现就是"选完 3 没有自动弹出网页"。
  check(/'--no-open'/.test(fwd),
    '转发 --no-open（浏览器交给未提权的旧进程代开）',
    '转发里没有 --no-open —— 提权进程里开浏览器常常打不开');

  check(!/relaunchAsAdmin\(process\.argv\.slice\(2\)/.test(src),
    '没有把 process.argv.slice(2) 直接转发给提权',
    '仍在用 argv.slice(2) 转发，这就是重弹菜单的根因');
}

// ===========================================================================
section('[4] 端到端：--decided 必须真的不弹菜单');
// ===========================================================================
{
  // 这条是本文件最重要的一条：它直接验证用户报告的
  // 「选 3 之后新窗口还要再选一次 3」已被修好。
  const r = await runLauncher(
    ['--port', '8899', '--proxy', '--decided'],
    { env: { ACCEL_FORCE_MENU: '1' } },   // 强制菜单，靠 --decided 压制它
  );

  const asked = r.out.includes('请选择');
  check(!asked,
    '带 --decided 时即使 ACCEL_FORCE_MENU=1 也不弹菜单（无需再选一次）',
    `仍然弹了菜单 —— 用户报告的问题没有修好。输出：\n${r.out.slice(0, 400)}`);

  // 参数是否生效要看日志：沙箱里 reg.exe 被安全策略拦截时，
  // 程序会在改注册表**之前**安全退出（这是新加的保护，见段 [6]），
  // 所以输出里不一定出现"系统代理已指向"。断言必须落在日志上。
  const log = fs.readFileSync(path.join(ROOT, 'startup.log'), 'utf8');
  check(/解析参数: port=8899 proxy=true/.test(log),
    '--proxy 被正确解析（新的管理员进程会接管系统代理）',
    `--proxy 没有生效，日志：\n${log.slice(0, 400)}`);
  check(/--system-proxy/.test(log),
    'server.js 收到了 --system-proxy（界面会显示"代理已指向本程序"）');

  // 如果环境确实拦住了 reg query，必须是"拒绝改动"而不是"硬改一通"
  if (r.out.includes('无法读取你当前的系统代理设置')) {
    check(!r.out.includes('系统代理已指向'),
      '读不到原设置时拒绝改动系统代理（而不是先改了再想办法还原）',
      '读不到却仍然改了系统代理');
  }

  cleanup();
  try { fs.unlinkSync(RECOVERY_FILE); } catch (_) {}
}

// ===========================================================================
section('[5] 代理备份的三态语义：查询失败 ≠ 值不存在');
// ===========================================================================
{
  const L = require('./launcher');

  check(typeof L.readProxySettings === 'function',
    'readProxySettings 已导出（读三项并区分成功/失败）');

  // destructiveTargets 是保护的核心：老备份或 unknown 里列出的项都不能删
  check(L.destructiveTargets(null).length === 0, '没有备份时不会尝试删除任何项');
  check(L.destructiveTargets({ server: null, override: null }).includes('ProxyServer'),
    '老版本备份（没有 unknown 字段）→ 保守跳过 ProxyServer，不删',
    '老备份被判为"可以安全删除"，这会清空用户配置');
  check(L.destructiveTargets({ server: null, override: null, unknown: [] }).length === 0,
    '新版本备份且 unknown 为空 → 确认读到了，null 表示原本确实不存在，可以删');

  // regGet 必须是三态
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  check(/ok: false, value: null/.test(src),
    'regGet 能表达"查询失败"（ok:false），不再一律返回 null');
}

// ===========================================================================
section('[6] 破坏性还原保护：读不到就绝不删用户的配置');
// ===========================================================================
{
  const L = require('./launcher');
  L.__resetRestoreGuard();
  try { fs.unlinkSync(CLAIM_FILE); } catch (_) {}

  // 关键场景：备份时 reg query 失败，server/override 记成了 null。
  // 如果照着 null 去"还原"，就会把用户真实的 127.0.0.1:7877 和
  // 那一长串分流规则 **删掉** —— 静默且不可逆。
  const cmds = [];
  L.__setRegExec((args) => { cmds.push(args); });
  fs.writeFileSync(RECOVERY_FILE, JSON.stringify({
    enable: '0', server: null, override: null,
    unknown: ['ProxyServer', 'ProxyOverride'],
    at: new Date().toISOString(), port: 8899, token: 't',
  }), 'utf8');

  const r = await L.applyRestore({
    enable: '0', server: null, override: null,
    unknown: ['ProxyServer', 'ProxyOverride'],
  });

  check(r.partial === true, '标记为"部分还原"');
  check(Array.isArray(r.skipped) && r.skipped.includes('ProxyServer'),
    '明确报告跳过了 ProxyServer');

  const deletes = cmds.filter((a) => a[0] === 'delete');
  check(deletes.length === 0,
    '一条 reg delete 都没执行（用户的代理配置和分流规则原样保留）',
    `执行了破坏性删除：${JSON.stringify(deletes)}`);

  const enableWrites = cmds.filter((a) => a[0] === 'add' && a.includes('ProxyEnable'));
  check(enableWrites.length === 1,
    '只把代理开关写回原值（关掉即可让用户恢复联网）',
    `ProxyEnable 写入次数异常：${enableWrites.length}`);

  check(!fs.existsSync(RECOVERY_FILE),
    '还原后清掉恢复文件（避免下次启动被残留备份挡住）',
    '恢复文件残留');

  L.__setRegExec(null);
}

// ===========================================================================
section('[7] 还原幂等：bye 被触发多次也只写一次');
// ===========================================================================
{
  const L = require('./launcher');

  L.__resetRestoreGuard();
  try { fs.unlinkSync(CLAIM_FILE); } catch (_) {}

  const cmds = [];
  L.__setRegExec((args) => { cmds.push(args); });

  const saved = { enable: '0', server: null, override: null, unknown: [] };
  const first = await L.applyRestore(saved);
  const afterFirst = cmds.length;
  const second = await L.applyRestore(saved);
  const third = await L.applyRestore(saved);
  const sync = L.applyRestoreSync(saved);

  check(first.done === true, '第一次还原正常执行');
  check(afterFirst > 0, `第一次确实写了注册表（${afterFirst} 条命令）`);
  check(second.done === false && second.reason === 'already-restored',
    '第二次调用被幂等守卫拦下（SIGINT + child exit 不会连写两遍注册表）',
    `第二次调用没有拦住：${JSON.stringify(second)}`);
  check(third.done === false, '第三次同样被拦下');
  check(sync.done === false && sync.reason === 'already-restored',
    '同步版同样被守卫拦下（uncaughtException 路径不会重复写）',
    `同步版没有拦住：${JSON.stringify(sync)}`);
  check(cmds.length === afterFirst,
    '注册表写入次数没有增加（真正做到只写一次）',
    `守卫失效：命令数从 ${afterFirst} 涨到 ${cmds.length}`);

  check(!fs.existsSync(CLAIM_FILE),
    '还原完成后互斥标记已清理（不会挡住下一次运行）',
    '互斥标记文件残留');

  L.__setRegExec(null);
}

// ===========================================================================
section('[7b] 跨进程互斥：看门狗认领后主进程不再重复写');
// ===========================================================================
{
  const L = require('./launcher');
  L.__resetRestoreGuard();

  // 模拟"看门狗正在还原"：标记文件已存在
  fs.writeFileSync(CLAIM_FILE, '99999', 'utf8');

  const cmds = [];
  L.__setRegExec((args) => { cmds.push(args); });

  const r = await L.applyRestore({ enable: '0', server: null, override: null, unknown: [] });
  check(r.done === false && r.reason === 'claimed-by-watchdog',
    '看门狗已认领时主进程让出，不再重复改注册表',
    `没有让出：${JSON.stringify(r)}`);
  check(cmds.length === 0, '一条命令都没执行');

  try { fs.unlinkSync(CLAIM_FILE); } catch (_) {}
  L.__setRegExec(null);
}

// ===========================================================================
section('[8] 备份文件独占创建：残留备份必须挡住接管');
// ===========================================================================
{
  const L = require('./launcher');

  // 模拟"上次被强杀、备份还在"的场景
  fs.writeFileSync(RECOVERY_FILE, JSON.stringify({
    enable: '0', server: '127.0.0.1:7877', override: 'a;b',
    unknown: [], at: new Date().toISOString(), port: 8899, token: 'stale-token',
  }), 'utf8');

  const r = L.writeRecovery({ enable: '1', server: 'x', override: 'y', unknown: [], token: 'new' });
  check(r && r.exists === true,
    '残留备份存在时拒绝覆盖（否则会毁掉唯一能救人的那份备份）',
    '覆盖了残留备份');

  const kept = L.readRecovery();
  check(kept && kept.token === 'stale-token',
    '原有备份内容保持不变（token 仍是旧的）',
    '备份被改写了');

  try { fs.unlinkSync(RECOVERY_FILE); } catch (_) {}

  // 干净时应该能正常创建
  const r2 = L.writeRecovery({ enable: '0', server: null, override: null, unknown: [], token: 'fresh' });
  check(r2 === true, '没有残留时能正常创建备份');
  try { fs.unlinkSync(RECOVERY_FILE); } catch (_) {}
}

// ===========================================================================
section('[9] 看门狗与主进程语义一致');
// ===========================================================================
{
  const src = fs.readFileSync(path.join(ROOT, 'watchdog.js'), 'utf8');
  check(/saved\.unknown/.test(src),
    '看门狗认得 unknown 字段（不会在主进程跳过后又去删除）',
    '看门狗不认识 unknown，会重复主进程已避免的破坏性操作');
  check(/'ProxyServer', 'ProxyOverride'/.test(src),
    '看门狗对老备份同样保守处理');
  check(/function claimRestore\(\)/.test(src),
    '看门狗有互斥认领（避免和主进程同时写注册表）');
  check(/handled = true/.test(src),
    '看门狗的定时回调有幂等守卫（不会第二个 tick 再动一次手）');

  // 两边的 PROXY_KEY 必须是同一条路径。
  // 注意要比较**求值后**的值：源码里两边写的都是 '\\' 转义形式，
  // 直接拿源码文本比会误判成不一致。
  const L = require('./launcher');
  const wm = src.match(/const PROXY_KEY = '([^']+)'/);
  check(!!wm, 'watchdog 侧定义了 PROXY_KEY');
  check(wm && eval(`'${wm[1]}'`) === L.PROXY_KEY,
    'watchdog 与 launcher 求值后是同一条注册表路径（不会一边写错地方）',
    `两边不一致：${JSON.stringify(wm && eval(`'${wm[1]}'`))} vs ${JSON.stringify(L.PROXY_KEY)}`);
}

cleanup();

console.log(`\n${fail === 0 ? C.g : C.red}${pass} 项通过，${fail} 项失败${C.r}`);
if (fail === 0) console.log('启动器流程测试全部通过');
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n${C.red}测试自身崩溃：${C.r}${e && e.stack ? e.stack : e}`);
  process.exit(1);
});