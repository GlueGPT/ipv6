'use strict';
/**
 * restore-proxy.js —— 把系统代理恢复成启动加速器之前的样子
 *
 * 用途：如果「一键开启系统代理.cmd」的窗口被强行结束（任务管理器结束进程、
 * 系统崩溃、直接关电源），launcher.js 来不及执行还原逻辑，系统代理就会
 * 停留在 127.0.0.1:8899 而那里已经没有服务 —— 表现就是"突然上不了网"。
 *
 * 这时双击「还原系统代理.cmd」或运行本脚本即可恢复。
 * 原始设置保存在 proxy-backup.json（由 launcher.js 在改代理之前写入）。
 */

const path = require('path');
const { applyRestore, readRecovery, clearRecovery, RECOVERY_FILE } = require('./launcher');

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m' };

async function main() {
  console.log('');

  const saved = readRecovery();
  if (!saved) {
    console.log(`  ${C.y}没有找到需要恢复的代理设置。${C.r}`);
    console.log(`  ${C.d}（恢复文件 ${RECOVERY_FILE} 不存在，说明代理设置是干净的）${C.r}`);
    console.log('');
    return;
  }

  console.log(`  ${C.b}即将把系统代理恢复为：${C.r}`);
  console.log(`    ProxyEnable   = ${saved.enable}`);
  console.log(`    ProxyServer   = ${saved.server || '(删除该项)'}`);
  console.log(`    ProxyOverride = ${saved.override || '(删除该项)'}`);
  console.log(`  ${C.d}备份时间：${saved.at || '未知'}${C.r}`);
  console.log('');

  await applyRestore(saved);
  clearRecovery();

  console.log(`  ${C.g}✓ 已恢复。${C.r}`);
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
