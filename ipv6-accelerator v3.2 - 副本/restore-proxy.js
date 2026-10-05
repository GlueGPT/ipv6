'use strict';
/**
 * restore-proxy.js —— 把系统代理恢复成启动加速器之前的样子
 *
 * 用途：如果加速器的窗口被强行结束（任务管理器结束进程、
 * 系统崩溃、直接关电源），launcher.js 来不及执行还原逻辑，系统代理就会
 * 停留在 127.0.0.1:8899 而那里已经没有服务 —— 表现就是"突然上不了网"。
 *
 * 这时双击「还原系统代理.cmd」或运行本脚本即可恢复。
 * 原始设置保存在 proxy-backup.json（由 launcher.js 在改代理之前写入）。
 */

const path = require('path');
const { applyRestore, readRecovery, clearRecovery, RECOVERY_FILE } = require('./launcher');
const sysproxy = require('./lib/sysproxy');

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m' };

/**
 * 界面里开启的系统代理用的是另一份备份（proxy-backup-ui.json）。
 *
 * 救援脚本必须两份都管：只还原启动器那份的话，界面开的代理会一直卡在
 * 已停止的端口上，而且残留的备份文件还会让界面**拒绝再次接管**
 * （它看到备份还在就不敢覆盖）。
 */
async function restoreUiBackup() {
  if (!sysproxy.hasBackup()) return false;
  const r = await sysproxy.disable();
  console.log(`  ${C.g}✓ 界面开启的系统代理也已还原。${C.r}`);
  if (r && r.note) console.log(`  ${C.d}${r.note}${C.r}`);
  console.log('');
  return true;
}

/**
 * 孤儿代理：没有任何备份文件，但代理开关开着、指向本程序的端口，
 * 而那个端口上根本没有服务。
 *
 * 这就是"关掉程序之后打不开网页"的状态 —— 表现是所有网站都连不上，
 * 而用户完全不知道原因。以前这个脚本遇到"没有备份"就直接说"设置是干净的"
 * 然后退出，把最容易断网的那种情况漏掉了。
 *
 * 这里只做一件事：**把开关关掉**。不删用户的服务器地址和绕过列表 ——
 * 无备份时无从得知它们原本是什么，删掉是不可逆的。
 */
async function fixOrphanProxy(port) {
  const st = await sysproxy.status(port);
  if (!st.orphan) return false;

  console.log(`  ${C.red}发现问题：系统代理开着，但指向的 ${C.b}127.0.0.1:${port}${C.r}${C.red} 没有服务在跑。${C.r}`);
  console.log(`  ${C.d}这会让浏览器把所有请求发给一个没人应答的地址 —— 表现就是网页全部打不开。${C.r}`);
  console.log('');
  console.log(`  ${C.d}没有找到备份文件，无法还原成"开启加速器之前"的样子，${C.r}`);
  console.log(`  ${C.d}所以这里只把代理开关关掉（你原来的服务器地址和绕过列表保持不动）。${C.r}`);
  console.log('');

  const r = await sysproxy.disable();
  if (r && r.ok) {
    console.log(`  ${C.g}✓ 已关闭系统代理，现在可以正常上网了。${C.r}`);
    console.log(`  ${C.d}如果浏览器还是连不上，关掉浏览器重开一次让它读新设置。${C.r}`);
  } else {
    console.log(`  ${C.red}✗ 关闭失败：${r && r.error}${C.r}`);
    console.log(`  ${C.d}手动办法：设置 → 网络和 Internet → 代理 → 关掉「使用代理服务器」。${C.r}`);
  }
  console.log('');
  return true;
}

async function main() {
  console.log('');

  const uiDone = await restoreUiBackup();

  // 端口取 PID 文件里的记录（服务可能在别的端口上跑过），取不到就用默认端口
  let port = 8899;
  try {
    const j = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'accelerator.pid'), 'utf8'));
    if (j && j.proxyPort) port = Number(j.proxyPort) || port;
  } catch (_) {}

  const fixed = await fixOrphanProxy(port);

  const saved = readRecovery();
  if (!saved) {
    if (!uiDone && !fixed) {
      console.log(`  ${C.y}没有找到需要恢复的代理设置。${C.r}`);
      console.log(`  ${C.d}（恢复文件 ${RECOVERY_FILE} 不存在，且系统代理也没有指向无人应答的地址）${C.r}`);
      console.log('');
    }
    return;
  }

  // 备份里可能带 unknown 列表（读取失败的项）。那些项我们**不敢删**，
  // 只能关掉代理开关，原样保留用户的服务器地址和绕过列表。
  const skip = Array.isArray(saved.unknown) ? saved.unknown : [];

  console.log(`  ${C.b}即将把系统代理恢复为：${C.r}`);
  console.log(`    ProxyEnable   = ${saved.enable}`);
  console.log(`    ProxyServer   = ${skip.includes('ProxyServer') ? '(保留你原来的，不动)' : (saved.server || '(删除该项)')}`);
  console.log(`    ProxyOverride = ${skip.includes('ProxyOverride') ? '(保留你原来的，不动)' : (saved.override || '(删除该项)')}`);
  console.log(`  ${C.d}备份时间：${saved.at || '未知'}${C.r}`);
  if (skip.length) {
    console.log('');
    console.log(`  ${C.y}注意：${skip.join('、')} 在备份时没能读到。${C.r}`);
    console.log(`  ${C.y}为避免误删你原有的配置，这几项会保持原样。${C.r}`);
  }
  console.log('');

  const r = await applyRestore(saved);
  clearRecovery();

  if (r && r.partial) {
    console.log(`  ${C.y}✓ 代理开关已恢复。${C.r}`);
    console.log(`  ${C.d}你的代理服务器地址和绕过列表保持原样，没有被改动。${C.r}`);
  } else {
    console.log(`  ${C.g}✓ 已恢复。${C.r}`);
  }
  console.log(`  ${C.d}如果浏览器还是连不上网，重启浏览器让新设置生效。${C.r}`);
  console.log('');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n  ${C.red}[错误]${C.r} ${e && e.stack ? e.stack : e.message}\n`);
    console.error(`  手动恢复方法：设置 → 网络和 Internet → 代理，关掉"使用代理服务器"。`);
    process.exit(1);
  });
}
