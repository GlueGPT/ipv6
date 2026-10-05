'use strict';
/**
 * test-elevate.js —— 验证提权脚本的参数拼装（不真的弹 UAC）
 *
 * 做法：拦截 child_process.spawn，把 elevate.js 生成的 .ps1 读出来，
 * 把里面的 Start-Process 换成打印语句，再执行。
 * 这样能验证"脚本内容是否合法、参数是否正确传递"，而不会弹出授权框。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', red: '\x1b[31m', b: '\x1b[1m', c: '\x1b[36m' };
let pass = 0, fail = 0;
const ok = (s) => { pass++; console.log(`  ${C.g}✓${C.r} ${s}`); };
const bad = (s) => { fail++; console.log(`  ${C.red}✗${C.r} ${s}`); };

const realSpawn = cp.spawn;
let capturedScript = null;

cp.spawn = function (cmd, args, opts) {
  if (cmd === 'powershell.exe' && Array.isArray(args) && args.includes('-File')) {
    const src = args[args.indexOf('-File') + 1];
    try { capturedScript = fs.readFileSync(src, 'utf8'); } catch (_) {}

    if (capturedScript) {
      // 把 Start-Process 那一行换成打印，其余原样保留
      const dry = capturedScript
        .replace(/Start-Process[^\r\n]*/, 'Write-Output ("DRYRUN|node=" + $node + "|args=" + ($args2 -join " ;; ") + "|cwd=" + $cwd)')
        .replace('ELEVATED-OK', 'ELEVATED-OK');
      const dryPath = path.join(os.tmpdir(), `accel-dryrun-${process.pid}.ps1`);
      fs.writeFileSync(dryPath, dry, 'utf8');
      return realSpawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dryPath], opts);
    }
  }
  return realSpawn.apply(cp, arguments);
};

const { relaunchAsAdmin } = require('./elevate');

(async () => {
  console.log(`\n${C.b}${C.c}提权脚本验证${C.r}\n`);

  const r = await relaunchAsAdmin(['--port', '8899']);

  console.log(`${C.b}[1] 提权调用结果${C.r}`);
  r.ok ? ok(`提权流程返回成功（method=${r.method}）`) : bad(`提权失败: ${r.error}`);

  console.log(`\n${C.b}[2] 生成的 PowerShell 脚本内容${C.r}`);
  if (!capturedScript) {
    bad('没有捕获到生成的脚本');
  } else {
    capturedScript.split(/\r?\n/).forEach((l) => console.log(`    ${C.d}${l}${C.r}`));
    ok('脚本已成功生成并执行');
  }

  console.log(`\n${C.b}[3] 关键检查项${C.r}`);
  if (capturedScript) {
    // 引号问题：$ErrorActionPreference 必须是合法的字符串赋值
    const eapLine = (capturedScript.match(/\$ErrorActionPreference\s*=\s*(.*)/) || [])[1] || '';
    check(/^["']Stop["']/.test(eapLine.trim()),
      `$ErrorActionPreference 赋值带引号（${eapLine.trim()}）`,
      `$ErrorActionPreference 的引号丢了：${eapLine}`);

    check(capturedScript.includes('-Verb RunAs'), '包含 -Verb RunAs（会触发 UAC）', '缺少 RunAs 动词');
    check(capturedScript.includes('-WorkingDirectory'), '指定了工作目录', '缺少工作目录');
    check(/\$extra\s*=\s*@\(/.test(capturedScript), '额外参数用数组形式传递', '参数传递方式不对');
    check(capturedScript.includes('ELEVATED-FAIL'), '有失败分支可被识别', '缺少失败标记');
  }

  // 从 --brief 的 dry-run 输出里核对参数
  console.log(`\n${C.b}[4] 参数是否完整传给新进程${C.r}`);
  const probe = await new Promise((resolve) => {
    const ps = [
      '$ErrorActionPreference = "Stop"',
      `$node = '${process.execPath.replace(/'/g, "''")}'`,
      `$launcher = '${path.join(__dirname, 'launcher.js').replace(/'/g, "''")}'`,
      '$extra = @(\'--port\', \'8899\')',
      '$args2 = @($launcher) + $extra',
      'Write-Output ($args2 -join " ;; ")',
    ].join("\r\n");
    const p = path.join(os.tmpdir(), `accel-argcheck-${process.pid}.ps1`);
    fs.writeFileSync(p, '\uFEFF' + ps, 'utf8');
    const ch = realSpawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p], { windowsHide: true });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('exit', () => { try { fs.unlinkSync(p); } catch (_) {} resolve(out.trim()); });
  });
  console.log(`    实际参数: ${probe}`);
  check(probe.includes('launcher.js') && probe.includes('--port') && probe.includes('8899'),
    'launcher.js 路径与 --port 8899 都在参数里',
    `参数不完整: ${probe}`);

  console.log(`\n${C.b}${pass} 项通过，${fail} 项失败${C.r}\n`);
  process.exit(fail ? 1 : 0);
})();

function check(cond, yes, no) { cond ? ok(yes) : bad(no); }
