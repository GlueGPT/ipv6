'use strict';
/**
 * make-launchers.js —— 生成 .cmd 启动脚本
 *
 * ---------------------------------------------------------------------------
 * 为什么 .cmd 里一个中文都不放
 * ---------------------------------------------------------------------------
 * Windows 的 cmd.exe 是**按控制台代码页逐字节读取批处理文件**的。
 * 中文批处理只要编码和代码页对不上（UTF-8 带 BOM、UTF-8 无 BOM、GBK 不匹配……），
 * 就会出现：行首字符被吃掉、echo 变成 ho、注释行被当命令执行、中文变成乱码。
 * 而且不同 Windows 环境下表现还不一样，极难一次写对。
 *
 * 本项目真实踩过这个坑：第一版 start.cmd 是 UTF-8 带 BOM，双击后满屏报错没法用。
 *
 * 最终定的方案：
 *   - .cmd 内容**全部 ASCII**，只做一件事：找到 Node.js，然后把活交给 launcher.js
 *   - 所有中文提示由 Node 输出（Node 用 WriteConsoleW 写控制台，和代码页无关，绝不会乱码）
 *   - 文件名可以是中文（NTFS 文件名是 UTF-16，不受控制台编码影响）
 *
 * 这样启动脚本在任何 Windows 上都能正确解析。
 */

const fs = require('fs');
const path = require('path');

// ==== 只维护这里，改完重新生成 ====

/**
 * 两个入口脚本内容完全相同，只靠 --proxy 参数区分行为。
 * 保持 ASCII，不要在这里加中文（原因见文件头注释）。
 */
const LAUNCHER_CMD = `@echo off
setlocal
cd /d "%~dp0"

rem ---- Diagnostics: even if cmd fails before reaching Node, we still get a log ----
set "RC=1"
echo ==== launcher.cmd ==== > "%~dp0startup.log"
echo time: %DATE% %TIME% >> "%~dp0startup.log"
echo cwd: %CD% >> "%~dp0startup.log"
echo script dir: %~dp0 >> "%~dp0startup.log"
echo args: %* >> "%~dp0startup.log"

if not exist "%~dp0launcher.js" (
  echo ERROR: launcher.js not found in %~dp0 >> "%~dp0startup.log"
  echo.
  echo   [ERROR] launcher.js is missing from:
  echo       %~dp0
  echo.
  echo   Please make sure all project files were extracted to the same folder.
  echo.
  goto :end
)

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles%\\nodejs\\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\\nodejs\\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\\npm\\node.exe" set "NODE_EXE=%APPDATA%\\npm\\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\\dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe"
if not defined NODE_EXE (
  echo ERROR: Node.js not found >> "%~dp0startup.log"
  echo.
  echo   [ERROR] Node.js not found.
  echo.
  echo   This tool needs Node.js to run. Please install the LTS build from:
  echo       https://nodejs.org/
  echo   Then double-click this file again.
  echo.
  goto :end
)

echo node: %NODE_EXE% >> "%~dp0startup.log"
"%NODE_EXE%" "%~dp0launcher.js" %*
set "RC=%ERRORLEVEL%"
echo node exit code: %RC% >> "%~dp0startup.log"

:end
echo.
echo   ------------------------------------------------------------
echo   Done. If something went wrong, see:
echo       %~dp0startup.log
echo   This window will close when you press a key.
echo   ------------------------------------------------------------
pause >nul
rem pass node's exit code through (pause overwrites ERRORLEVEL, hence RC)
exit /b %RC%
`;

const START_BODY = LAUNCHER_CMD;
const PROXY_BODY = LAUNCHER_CMD.replace(
  '"%~dp0launcher.js" %*',
  '"%~dp0launcher.js" --proxy %*'
);
// 还原脚本：只把入口换成 restore-proxy.js，其余（含日志与 pause）保持一致
const RESTORE_BODY = LAUNCHER_CMD.replace(
  '"%~dp0launcher.js" %*',
  '"%~dp0restore-proxy.js"'
);

const files = [
  { name: 'start.cmd', content: START_BODY },
  { name: 'start-ascii.cmd', content: START_BODY },
  { name: '一键开启系统代理.cmd', content: PROXY_BODY },
  { name: 'restore-proxy.cmd', content: RESTORE_BODY },
];

// ==== 生成前自检 ====
for (const f of files) {
  // 内容必须全 ASCII（文件名可以是中文，但内容不行）
  const bad = [...f.content].filter((ch) => ch.charCodeAt(0) > 127);
  if (bad.length) {
    console.error(`[错误] ${f.name} 内容含非 ASCII 字符： ${bad.slice(0, 10).join('')}`);
    process.exit(1);
  }
  if (/^\uFEFF/.test(f.content)) {
    console.error(`[错误] ${f.name} 内容带 BOM`);
    process.exit(1);
  }
  if (!/%~dp0(launcher|restore-proxy)\.js/.test(f.content)) {
    console.error(`[错误] ${f.name} 没有调用本项目的 js 入口`);
    process.exit(1);
  }
}

// ==== 生成 ====
//
// 内容是纯 ASCII，所以不需要任何转码：直接按 UTF-8 无 BOM + CRLF 写就行
// （ASCII 字符在 UTF-8 和 GBK 里字节完全相同，不存在歧义）。
// 上一版曾经要绕 PowerShell 做 GBK 转码，改用纯 ASCII 方案后这一步就省掉了。
const utf8NoBom = 'utf8';

for (const f of files) {
  const target = path.join(__dirname, f.name);
  const text = f.content.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(target, text, utf8NoBom);

  // 写盘后回读校验：确认没有 BOM、没有非 ASCII 字节漏进来
  const bytes = fs.readFileSync(target);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  const nonAscii = bytes.filter((b) => b > 127).length;

  if (hasBom) {
    console.error(`[错误] ${f.name} 写盘后检测到 BOM`);
    process.exit(1);
  }
  if (nonAscii > 0) {
    console.error(`[错误] ${f.name} 写盘后检测到 ${nonAscii} 个非 ASCII 字节`);
    process.exit(1);
  }

  console.log(`  ${f.name.padEnd(24)} ${String(bytes.length).padStart(5)} 字节  BOM=无  非ASCII=0  正常`);
}

console.log('');
console.log('启动脚本已就绪。双击 start.cmd 即可运行。');


