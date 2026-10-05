'use strict';
/**
 * elevate.js —— 用管理员身份重新启动加速器
 *
 * hosts 模式的写入必须有管理员权限，但让用户每次都要"右键 → 以管理员身份运行"
 * 太麻烦，而且主程序 99% 的功能（代理、测速、优选）根本不需要管理员。
 *
 * 所以做成**按需提权**：平时用普通权限跑，只有要写 hosts 时才弹一次 UAC。
 *
 * 实现上用 PowerShell 的 Start-Process -Verb RunAs，它会弹出系统 UAC 对话框。
 * 用户点"否"就返回失败，不会静默什么都不做。
 */

const path = require('path');
const { spawn } = require('child_process');

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

/** 当前进程是不是已经是管理员 */
function isElevated() {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
  try {
    // Windows 上最可靠的判断：尝试写一个只有管理员能碰的目录
    const fs = require('fs');
    const probe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', '.accel-elev-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 以管理员身份重新启动 launcher.js。
 *
 * 实现说明：不要把 PowerShell 脚本塞进 -Command 字符串。
 * 那样要过 node → cmd → powershell 三层引号转义，实测会出现
 * `$ErrorActionPreference = "Stop"` 的引号被吃掉、静默退化成
 * `= Stop` 的情况 —— 命令表面还能跑，但错误处理已经失效。
 * 所以这里把脚本写成临时 .ps1 文件，用 -File 执行，彻底避开引号问题。
 *
 * @param {string[]} extraArgs  额外参数，原样转发
 * @param {string} [scriptPath] 要提权运行的脚本，缺省是 launcher.js
 * @returns {Promise<{ok:boolean, error?:string, method?:string}>}
 */
function relaunchAsAdmin(extraArgs = [], scriptPath) {
  const fs = require('fs');
  const os = require('os');
  const launcher = scriptPath || path.join(__dirname, 'launcher.js');
  const nodeExe = process.execPath;

  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // PowerShell 单引号字符串里，单引号本身要写成两个
      const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const argList = extraArgs.map(q).join(', ');
      const argExpr = argList ? `@(${argList})` : '@()';

      const psScript = [
        '$ErrorActionPreference = "Stop"',
        'try {',
        `  $node = ${q(nodeExe)}`,
        `  $launcher = ${q(launcher)}`,
        `  $cwd = ${q(__dirname)}`,
        `  $extra = ${argExpr}`,
        '  $args2 = @($launcher) + $extra',
        // PowerShell 5.1 的 -ArgumentList 是把数组元素用空格拼起来、且**不加引号**的。
        // 如果用户目录带空格（例如 C:\Users\Zhang San\Desktop\...），
        // launcher.js 的路径就会被当成两个参数。所以这里自己加引号。
        '  $quoted = $args2 | ForEach-Object { if ($_ -match \'[\\s"]\') { \'"\' + ($_ -replace \'"\', \'\\"\') + \'"\' } else { $_ } }',
        '  Start-Process -FilePath $node -ArgumentList ($quoted -join \' \') -WorkingDirectory $cwd -Verb RunAs',
        '  Write-Output "ELEVATED-OK"',
        '} catch {',
        '  Write-Output ("ELEVATED-FAIL: " + $_.Exception.Message)',
        '}',
      ].join("\r\n");

      const scriptPath = path.join(os.tmpdir(), `accel-elevate-${process.pid}.ps1`);
      try {
        // 带 BOM 的 UTF-8，确保 PowerShell 5.1 也能正确读中文/特殊字符
        fs.writeFileSync(scriptPath, '\uFEFF' + psScript, 'utf8');
      } catch (e) {
        return resolve({ ok: false, error: `无法写入提权脚本: ${e.message}` });
      }

      const cleanup = () => { try { fs.unlinkSync(scriptPath); } catch (_) {} };

      const child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true });

      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      child.on('error', (e) => { cleanup(); resolve({ ok: false, error: e.message }); });
      child.on('exit', () => {
        cleanup();
        if (out.includes('ELEVATED-OK')) return resolve({ ok: true, method: 'UAC' });
        const msg = (out.match(/ELEVATED-FAIL: (.*)/) || [])[1]
          || out.trim()
          || '未知错误（可能是在 UAC 对话框点了「否」）';
        resolve({ ok: false, error: msg });
      });
    } else if (process.platform === 'darwin') {
      // macOS 用 osascript 弹授权框；单引号里不能直接放单引号，先做转义
      const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
      const inner = [nodeExe, launcher, ...extraArgs].map(sq).join(' ');
      const cmd = `osascript -e 'do shell script "${inner} > /dev/null 2>&1 &" with administrator privileges'`;
      const child = spawn('sh', ['-c', cmd], { windowsHide: true });
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('exit', (code) => resolve(code === 0 ? { ok: true, method: 'osascript' } : { ok: false, error: '用户取消了授权' }));
    } else {
      // Linux: 用 pkexec，失败就提示用户自己加 sudo
      const manual = `sudo ${[nodeExe, launcher, ...extraArgs].join(' ')}`;
      const child = spawn('pkexec', [nodeExe, launcher, ...extraArgs], { windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', (e) => resolve({ ok: false, error: `需要手动执行: ${manual}  (${e.message})` }));
      child.on('exit', (code) => resolve(code === 0 ? { ok: true, method: 'pkexec' } : { ok: false, error: 'pkexec 未成功，可能被取消或未安装' }));
    }
  });
}

// 命令行入口：node elevate.js [额外参数...]
if (require.main === module) {
  (async () => {
    if (isElevated()) {
      console.log('');
      console.log(`  ${C.g}当前已经是管理员权限。${C.r}`);
      console.log(`  ${C.d}直接运行 start.cmd 即可，hosts 模式可以直接用。${C.r}`);
      console.log('');
      return;
    }
    console.log('');
    console.log(`  ${C.y}即将弹出管理员授权（UAC）对话框。${C.r}`);
    console.log(`  ${C.d}请点"是"，加速器会以管理员身份重新启动，${C.r}`);
    console.log(`  ${C.d}这样 Steam / Epic 等 hosts 模式才能写入系统 hosts 文件。${C.r}`);
    console.log('');
    const r = await relaunchAsAdmin(process.argv.slice(2));
    if (r.ok) {
      console.log(`  ${C.g}✓ 已在新窗口中以管理员身份启动。${C.r}`);
      console.log(`  ${C.d}这个旧窗口可以关掉了。${C.r}`);
      console.log('');
    } else {
      console.log(`  ${C.red}✗ 提权失败：${r.error}${C.r}`);
      console.log('');
      console.log('  手动办法：右键点击 start.cmd → 以管理员身份运行');
      console.log('');
      process.exit(1);
    }
  })();
}

module.exports = { isElevated, relaunchAsAdmin };
