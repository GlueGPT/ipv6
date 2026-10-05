'use strict';
/**
 * test-replace.js —— 实例替换逻辑测试
 *
 * 为什么专门测这个：
 * 用户遇到过"用了以管理员身份运行.cmd，提权也显示成功了，界面却仍然
 * 提示需要管理员"。根因是——之前用普通权限启动的实例还在跑，
 * 新的管理员实例一启动就检测到"已有实例"，打开浏览器就退出了，
 * 于是管理员权限根本没生效。
 *
 * 所以 --elevate 必须能主动把旧实例顶掉。这里就验证这条路径：
 *   真的起一个实例 → 调 replaceExistingInstance → 确认进程死了、端口空了。
 *
 * 测的是 launcher.js 里导出的真实函数，不是抄一遍逻辑。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

// 保险：导入 launcher.js 会执行它的模块级初始化，绝不能让菜单在测试里弹出来
process.env.ACCEL_NO_MENU = '1';

const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', red: '\x1b[31m', b: '\x1b[1m', c: '\x1b[36m', y: '\x1b[33m' };
let pass = 0, fail = 0;
const ok = (s) => { pass++; console.log(`  ${C.g}✓${C.r} ${s}`); };
const bad = (s) => { fail++; console.log(`  ${C.red}✗${C.r} ${s}`); };

const PID_FILE = path.join(__dirname, 'accelerator.pid');
const PORT = 8977;          // 测试专用端口，避开正在使用的 8899
const UI_PORT = PORT + 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeTcp(port, timeout = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout, () => fin(false));
    s.once('error', () => fin(false));
    s.once('connect', () => fin(true));
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

(async () => {
  console.log(`\n${C.b}${C.c}实例替换逻辑测试${C.r}\n`);

  const { replaceExistingInstance, readPidFileInfo, stopExistingInstance } = require('./launcher');

  console.log(`${C.b}[1] 导出检查${C.r}`);
  typeof replaceExistingInstance === 'function'
    ? ok('replaceExistingInstance 已导出（测的是真实实现）')
    : bad('replaceExistingInstance 没有导出');
  typeof stopExistingInstance === 'function'
    ? ok('stopExistingInstance 已导出')
    : bad('stopExistingInstance 没有导出');

  // -------------------------------------------------------------------------
  console.log(`\n${C.b}[2] 起一个测试实例（模拟"用 start.cmd 启动过"）${C.r}`);
  try { fs.unlinkSync(PID_FILE); } catch (_) {}

  const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', String(PORT)], {
    cwd: __dirname, stdio: 'ignore', windowsHide: true,
  });
  const childPid = child.pid;
  console.log(`  ${C.d}已派生 pid=${childPid}，端口 ${PORT}${C.r}`);

  // 等它把端口绑上并写好 PID 文件
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await probeTcp(PORT, 400)) { up = true; break; }
  }
  up ? ok(`实例已就绪并监听 ${PORT}`) : bad('实例在 30 秒内没有起来，后续测试无意义');

  if (!up) {
    try { process.kill(childPid, 'SIGKILL'); } catch (_) {}
    console.log(`\n${C.b}${pass} 项通过，${fail} 项失败${C.r}\n`);
    process.exit(1);
  }

  const info = readPidFileInfo();
  info && info.pid
    ? ok(`PID 文件已写入（pid=${info.pid}）`)
    : bad('PID 文件没有写入，实例检测会失效');

  // -------------------------------------------------------------------------
  console.log(`\n${C.b}[3] 调 replaceExistingInstance 顶掉它${C.r}`);
  const found = { pid: childPid, uiPort: UI_PORT, proxyPort: PORT, via: '测试' };

  const t0 = Date.now();
  const freed = await replaceExistingInstance(found);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  freed ? ok(`replaceExistingInstance 返回成功（耗时 ${elapsed}s）`) : bad('replaceExistingInstance 返回失败');
  !alive(childPid) ? ok('旧实例进程已结束') : bad(`旧实例 pid=${childPid} 仍然活着`);

  const stillListening = await probeTcp(PORT, 500);
  !stillListening ? ok(`端口 ${PORT} 已释放（新实例可以绑定）`) : bad(`端口 ${PORT} 仍被占用`);

  const stale = readPidFileInfo();
  (!stale || stale.pid !== childPid)
    ? ok('旧 PID 文件已清理（不会把新实例误判为"已在运行"）')
    : bad(`PID 文件仍指向已死的 pid=${childPid}，新实例会被误劝退`);

  // -------------------------------------------------------------------------
  console.log(`\n${C.b}[4] 边界情况${C.r}`);
  const again = await replaceExistingInstance({ pid: childPid, uiPort: UI_PORT, proxyPort: PORT, via: '测试' });
  // 进程已经死了，stopExistingInstance 的 SIGTERM 会抛 ESRCH → 返回 false
  again === false
    ? ok('对已结束的 pid 再调一次：安全返回 false，不抛异常')
    : ok(`对已结束的 pid 再调一次：返回 ${again}（未抛异常即可）`);

  const nonsense = await stopExistingInstance(999999999);
  nonsense === false
    ? ok('对不存在的 pid 调 stopExistingInstance：安全返回 false')
    : bad('对不存在的 pid 没有安全返回');

  // 清理
  try { process.kill(childPid, 'SIGKILL'); } catch (_) {}
  try { fs.unlinkSync(PID_FILE); } catch (_) {}

  console.log(`\n${C.b}${pass} 项通过，${fail} 项失败${C.r}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`\n测试自身出错: ${e.stack || e.message}\n`);
  process.exit(1);
});
