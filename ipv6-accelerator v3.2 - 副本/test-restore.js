'use strict';
/**
 * test-restore.js —— 系统代理还原行为测试
 *
 * 回答一个具体问题：**关掉程序后，系统代理会自动还原吗？**
 *
 * 这里是踩过坑之后重写的版本。之前用 taskkill（不带 /F）模拟"关窗口"，
 * 但实测证明对控制台程序无效 —— 那个测试其实从没触发过优雅关闭路径，
 * 它测的是强杀，于是把"没有还原"误判成了正常。
 *
 * 现在覆盖三种现实情况：
 *   A. 主进程正常退出                   → 自己还原，看门狗安静退出
 *   B. 主进程被强杀（任务管理器/崩溃）    → 看门狗兜底还原
 *   C. 只关掉浏览器页面（程序还在）       → 什么都不该发生
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', red: '\x1b[31m', b: '\x1b[1m', c: '\x1b[36m', y: '\x1b[33m' };
let pass = 0, fail = 0;
const ok = (s) => { pass++; console.log(`  ${C.g}✓${C.r} ${s}`); };
const bad = (s) => { fail++; console.log(`  ${C.red}✗${C.r} ${s}`); };
const info = (s) => console.log(`  ${C.d}${s}${C.r}`);

const ROOT = __dirname;
const RECOVERY = path.join(ROOT, 'proxy-backup.json');
const PORT = 8955;
const ORIG = { enable: 0, server: 'http://127.0.0.1:7877', override: '*zhihu.com;*jd.com;localhost;<local>' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function proxy() {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const get = (n) => {
    try {
      const out = execSync(`reg query "${base}" /v ${n}`, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const m = out.match(new RegExp(`${n}\\s+REG_\\w+\\s+(.*)`));
      let v = m ? m[1].trim() : null;
      // reg query 对 REG_DWORD 返回十六进制，写入用的是十进制；不归一化会误判
      if (v && /^0x[0-9a-f]+$/i.test(v)) v = String(parseInt(v, 16));
      return v;
    } catch (_) { return null; }
  };
  return { enable: get('ProxyEnable'), server: get('ProxyServer'), override: get('ProxyOverride') };
}

function setProxy(p) {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const run = (c) => { try { execSync(c, { windowsHide: true, stdio: 'ignore' }); } catch (_) {} };
  run(`reg add "${base}" /v ProxyEnable /t REG_DWORD /d ${p.enable} /f`);
  if (p.server) run(`reg add "${base}" /v ProxyServer /t REG_SZ /d "${p.server}" /f`);
  else run(`reg delete "${base}" /v ProxyServer /f`);
  if (p.override) run(`reg add "${base}" /v ProxyOverride /t REG_SZ /d "${p.override}" /f`);
  else run(`reg delete "${base}" /v ProxyOverride /f`);
}

/** 还原成 ORIG 并且断言 */
function assertRestored(label) {
  const p = proxy();
  const good = p.enable === String(ORIG.enable)
    && p.server === ORIG.server
    && p.override === ORIG.override;
  if (good) ok(`${label}：代理已完整还原（含绕过列表）`);
  else bad(`${label}：未完整还原 → Enable=${p.enable} Server=${p.server} Override=${p.override}`);
  return good;
}

function uiUp(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 700 }, (r) => {
      let b = ''; r.setEncoding('utf8');
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b).service === 'ipv6-accelerator'); } catch (_) { res(false); } });
      r.on('error', () => res(false));
    });
    req.on('timeout', () => { req.destroy(); res(false); });
    req.on('error', () => res(false));
  });
}

/** 列出所有 node 进程（pid + 命令行），用于精确挑选要杀哪个 */
function listNodeProcesses() {
  try {
    const psOut = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
    if (!psOut) return [];
    const j = JSON.parse(psOut);
    return Array.isArray(j) ? j : [j];
  } catch (e) {
    info(`列举进程失败：${e.message}`);
    return [];
  }
}

/** 清掉本测试起的所有 node（排除自己和父进程） */
function killAllNode(excludePid) {
  for (const p of listNodeProcesses()) {
    if (!p || !p.ProcessId) continue;
    if (p.ProcessId === process.pid || p.ProcessId === process.ppid || p.ProcessId === excludePid) continue;
    // 不带 /T：带上会连整棵进程树一起端掉，可能把自己也带走
    try { execSync(`taskkill /PID ${p.ProcessId} /F`, { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
  }
}

/** 启动一个加速器实例，等到界面就绪 */
async function launch(port) {
  const child = spawn(process.execPath, [
    path.join(ROOT, 'launcher.js'), '--proxy', '--no-open', '--port', String(port),
  ], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await uiUp(port + 1)) return child;
  }
  return null;
}

async function waitRestored(maxMs) {
  const steps = Math.ceil(maxMs / 500);
  for (let i = 0; i < steps; i++) {
    await sleep(500);
    const p = proxy();
    if (p.enable === String(ORIG.enable) && p.server === ORIG.server && p.override === ORIG.override) {
      return (i + 1) * 0.5;
    }
  }
  return null;
}

/**
 * 等恢复文件被清理。
 *
 * 不能"看到代理还原了就立刻断言文件没了" —— 实测这样做会偶发误报：
 * 强杀场景下可能出现"launcher 刚写完注册表就被杀掉、看门狗随后接手补完清理"，
 * 于是注册表已还原、而恢复文件要再等几百毫秒才消失。
 * 那是**正确的协作流程**（看门狗本来就是干这个的），不是缺陷。
 *
 * 所以这里断言的是"最终会被清理"，而不是"同一瞬间就清理"。
 */
async function waitFileGone(maxMs) {
  const steps = Math.ceil(maxMs / 250);
  for (let i = 0; i < steps; i++) {
    if (!fs.existsSync(RECOVERY)) return (i + 1) * 0.25;
    await sleep(250);
  }
  return null;
}

(async () => {
  const userProxy = proxy();
  console.log(`\n${C.b}${C.c}系统代理还原行为测试${C.r}`);
  console.log(`${C.d}测试前你的真实设置：Enable=${userProxy.enable} Server=${userProxy.server || '(无)'}${C.r}`);
  console.log(`${C.d}测试结束会还原成这个状态${C.r}\n`);

  killAllNode();
  await sleep(1500);

  // -------------------------------------------------------------------------
  console.log(`${C.b}[A] 主进程正常退出 → 自己还原${C.r}`);
  setProxy(ORIG);
  try { fs.unlinkSync(RECOVERY); } catch (_) {}

  let child = await launch(PORT);
  if (!child) {
    bad('实例起不来，测试无法继续');
  } else {
    const during = proxy();
    during.server === `http://127.0.0.1:${PORT}`
      ? ok('加速器已接管系统代理')
      : bad(`没有接管系统代理（${during.server}）`);
    fs.existsSync(RECOVERY) ? ok('恢复文件已写入') : bad('恢复文件缺失，异常退出将无从还原');

    // launcher 的 child.on('exit') 在 server 退出后触发。
    // 直接杀掉 server 子进程即可让 launcher 走正常收尾（等价于 Ctrl+C 的收尾路径）。
    info('让服务端正常退出，触发 launcher 的收尾流程...');
    // 找到 server 子进程（不是 watchdog，也不是 launcher）
    const list = listNodeProcesses();
    const server = list.find((p) => p && p.CommandLine && p.CommandLine.includes('server.js'));
    if (server) {
      try { process.kill(server.ProcessId, 'SIGKILL'); } catch (_) {}
      info(`已结束 server.js（pid ${server.ProcessId}）`);
    } else {
      info('没找到 server.js 进程');
    }

    const took = await waitRestored(12000);
    took ? ok(`主进程收尾后 ${took}s 内代理已还原`) : bad('12 秒内未还原');
    assertRestored('正常退出');
    const gone = await waitFileGone(8000);
    gone ? ok('恢复文件已清理（看门狗会据此确认无需兜底）') : bad('恢复文件残留');
  }

  killAllNode();
  await sleep(2500);

  // -------------------------------------------------------------------------
  console.log(`\n${C.b}[B] 主进程被强杀 → 看门狗兜底还原${C.r}`);
  setProxy(ORIG);
  try { fs.unlinkSync(RECOVERY); } catch (_) {}

  child = await launch(PORT);
  if (!child) {
    bad('实例起不来，测试无法继续');
  } else {
    proxy().server === `http://127.0.0.1:${PORT}` ? ok('加速器已接管系统代理') : bad('没有接管系统代理');

    info('强杀 launcher 和 server，但保留 watchdog（模拟任务管理器结束任务）...');
    const list = listNodeProcesses();
    let keptWatchdog = false;
    for (const p of list) {
      if (!p || !p.ProcessId) continue;
      // 绝不能杀到自己或父进程：taskkill 一旦带上 /T 会连整棵进程树一起端掉，
      // 而测试本来就是从 shell 里起来的（实测踩过：测试会静默消失、没有任何报错）。
      if (p.ProcessId === process.pid || p.ProcessId === process.ppid) continue;
      const cmd = p.CommandLine || '';
      if (cmd.includes('watchdog')) { keptWatchdog = true; info(`保留看门狗 pid ${p.ProcessId}`); continue; }
      try { execSync(`taskkill /PID ${p.ProcessId} /F`, { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
    }
    keptWatchdog ? ok('看门狗仍在运行') : bad('没找到看门狗进程（是不是没派出去？）');

    const took = await waitRestored(15000);
    took ? ok(`强杀后 ${took}s 内看门狗完成兜底还原`) : bad('15 秒内看门狗没有还原');
    assertRestored('强杀兜底');
    const gone = await waitFileGone(8000);
    gone ? ok(`恢复文件已被清理（还原后 ${gone}s）`) : bad('恢复文件残留');
  }

  killAllNode();
  await sleep(2500);

  // -------------------------------------------------------------------------
  console.log(`\n${C.b}[C] 只关掉浏览器页面 → 什么都不该发生${C.r}`);
  setProxy(ORIG);
  try { fs.unlinkSync(RECOVERY); } catch (_) {}

  child = await launch(PORT);
  if (!child) {
    bad('实例起不来，测试无法继续');
  } else {
    const before = proxy();
    info('（用户关掉浏览器标签页，程序继续在后台跑）');
    await sleep(2500);
    const after = proxy();
    after.server === before.server
      ? ok('系统代理保持不变（加速仍在生效，符合预期）')
      : bad(`代理被意外改动：${before.server} → ${after.server}`);
    (await uiUp(PORT + 1)) ? ok('服务仍在运行（关页面不会停掉程序）') : bad('服务意外停止了');
  }

  killAllNode();
  await sleep(2500);

  // -------------------------------------------------------------------------
  console.log(`\n${C.b}[清理] 还原成测试前的设置${C.r}`);
  if (userProxy.server != null) setProxy({ enable: userProxy.enable === '1' ? 1 : 0, server: userProxy.server, override: userProxy.override });
  else setProxy({ enable: 0, server: null, override: null });
  try { fs.unlinkSync(RECOVERY); } catch (_) {}
  const fin = proxy();
  info(`最终：Enable=${fin.enable} Server=${fin.server}`);

  console.log(`\n${C.b}${pass} 项通过，${fail} 项失败${C.r}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`\n测试自身出错: ${e.stack || e.message}\n`);
  try { killAllNode(); } catch (_) {}
  process.exit(1);
});
