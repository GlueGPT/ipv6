'use strict';
/**
 * cli.js —— 命令行测速工具（不用开界面）
 *
 * 用法:
 *   node cli.js <目标>            测一个目标的 v4/v6 对比
 *   node cli.js <目标> --quick    只测延迟，不测吞吐
 *   node cli.js <目标> --json     输出 JSON（方便脚本处理）
 *   node cli.js --env             只看本机 IPv6 环境
 */

const probe = require('./lib/probe');
const { rank, POLICY } = require('./lib/route');
const os = require('os');

const C = {
  r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m',
  c: '\x1b[36m', m: '\x1b[35m', red: '\x1b[31m',
};

function vw(s) { let n = 0; for (const ch of String(s)) n += ch.charCodeAt(0) > 255 ? 2 : 1; return n; }
function pad(s, n, right = false) {
  const str = String(s);
  const fill = ' '.repeat(Math.max(0, n - vw(str)));
  return right ? fill + str : str + fill;
}
const fmtSpeed = (kbps) => {
  if (kbps == null) return '—';
  return kbps >= 1024 ? (kbps / 1024).toFixed(2) + ' MB/s' : kbps.toFixed(0) + ' KB/s';
};
const famTag = (f) => (f === 6 ? `${C.m}IPv6${C.r}` : `${C.c}IPv4${C.r}`);

async function showEnv() {
  console.log(`\n${C.b}本机网络环境${C.r}\n`);
  const ifaces = os.networkInterfaces();
  const v6 = [], v6ll = [], v4 = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.internal) continue;
      if (i.family === 'IPv6') (/^fe80:/i.test(i.address) ? v6ll : v6).push(`${i.address}  ${C.d}(${name})${C.r}`);
      else v4.push(`${i.address}  ${C.d}(${name})${C.r}`);
    }
  }
  console.log(`  ${C.m}全局 IPv6${C.r}   ${v6.length ? v6.join('\n              ') : C.red + '无（加速会退化为 IPv4 优选）' + C.r}`);
  if (v6ll.length) console.log(`  ${C.d}链路本地 v6   ${v6ll.join('\n              ')}${C.r}`);
  console.log(`  ${C.c}IPv4${C.r}        ${v4.length ? v4.join('\n              ') : '无'}`);

  const targets = ['2400:3200::1', '2400:3200:baba::1', '240c::6666'];
  const r = await Promise.all(targets.map((ip) => probe.probeTcp(ip, [53, 443], { timeout: 1500 })));
  const good = r.filter((x) => x.ok).sort((a, b) => a.latency - b.latency)[0];
  console.log('');
  if (good) {
    console.log(`  ${C.g}✓${C.r} IPv6 出口可达，最低延迟 ${C.b}${good.latency.toFixed(1)} ms${C.r}`);
  } else {
    console.log(`  ${C.red}✗${C.r} IPv6 出口不可达（测了 ${targets.join(', ')}）`);
  }
  console.log('');
}

async function probeOne(target, opts) {
  const t0 = Date.now();
  const cands = await probe.buildCandidates(target);

  if (opts.json) {
    const rows = await probe.probeAll(cands, { doSpeed: !opts.quick, speedByteLimit: opts.bytes });
    const ranked = rank(rows, { policy: opts.policy });
    process.stdout.write(JSON.stringify({
      target: cands.url ? cands.url.toString() : target,
      hostname: cands.hostname,
      elapsed: Date.now() - t0,
      rows: ranked,
    }, null, 2) + '\n');
    return;
  }

  console.log(`\n${C.b}目标${C.r}  ${cands.url ? cands.url.toString() : target}`);
  console.log(`${C.d}域名 ${cands.hostname}   端口 ${cands.port}   ` +
    `解析到 IPv6 ${cands.family.v6.length} 个 / IPv4 ${cands.family.v4.length} 个${C.r}\n`);

  if (!cands.family.v6.length && !cands.family.v4.length) {
    console.log(`  ${C.red}解析不到任何地址${C.r}\n`);
    return;
  }

  const rows = await probe.probeAll(cands, {
    doSpeed: !opts.quick,
    speedByteLimit: opts.bytes,
    onProgress: (done, total, row) => {
      const t = row.ok
        ? `${C.g}✓${C.r} ${pad(row.latency + ' ms', 10, true)}`
        : `${C.red}✗${C.r} ${C.d}${pad(row.error ? row.error.slice(0, 24) : '', 24)}${C.r}`;
      process.stderr.write(`\r  ${C.d}探测中 ${done}/${total}   ${pad(row.ip, 40)} ${t}${C.r}          `);
    },
  });
  process.stderr.write('\r' + ' '.repeat(100) + '\r');

  const ranked = rank(rows, { policy: opts.policy });

  // 先算纯文本，按显示宽度补位，最后再套颜色 —— 避免 ANSI 转义码把对齐算错
  console.log(`  ${C.d}${pad('#', 3)} ${pad('IP 地址', 42)} ${pad('协议', 6)} ${pad('延迟', 9)} ${pad('吞吐', 12)} 状态${C.r}`);
  console.log(`  ${C.d}${'─'.repeat(84)}${C.r}`);

  ranked.forEach((r, i) => {
    const latPlain = r.latency != null ? `${r.latency} ms` : '—';
    const latColor = r.latency == null ? C.d
      : r.latency < 50 ? C.g : r.latency < 150 ? C.y : C.red;

    const spdPlain = r.reliable ? fmtSpeed(r.kbps)
      : r.speedKbps != null ? fmtSpeed(r.speedKbps) + '?'
        : '—';
    const spdColor = r.reliable ? C.r : C.d;

    const stPlain = r.ok ? (r.reliable ? '可用' : r.speedKbps != null ? '样本不足' : '仅延迟') : '不通';
    const stColor = r.ok ? (r.reliable ? C.g : C.y) : C.red;

    const famPlain = r.family === 6 ? 'IPv6' : 'IPv4';
    const famColor = r.family === 6 ? C.m : C.c;

    console.log(
      `  ${pad(i + 1, 3)} ${pad(r.ip, 42)} ` +
      `${famColor}${pad(famPlain, 6)}${C.r} ` +
      `${latColor}${pad(latPlain, 9)}${C.r} ` +
      `${spdColor}${pad(spdPlain, 12)}${C.r} ` +
      `${stColor}${stPlain}${C.r}`
    );
  });

  // 汇总对比
  const best = (fam) => {
    const list = ranked.filter((r) => r.family === fam && r.ok && r.reliable);
    if (!list.length) return null;
    return list.reduce((a, b) => ((b.kbps || 0) > (a.kbps || 0) ? b : a), list[0]);
  };
  const b6 = best(6), b4 = best(4);
  console.log('');
  const fmtSide = (r, fam) => r ? `${famTag(fam)} 最优 ${r.ip}  ${C.b}${fmtSpeed(r.kbps)}${C.r}  (${r.latency} ms)` : `${famTag(fam)} 无可信测量结果`;

  console.log(`  ${fmtSide(b6, 6)}`);
  console.log(`  ${fmtSide(b4, 4)}`);

  if (!opts.quick) {
    if (b6 && b4) {
      const ratio = b6.kbps / b4.kbps;
      console.log('');
      if (ratio > 1.15) console.log(`  ${C.m}${C.b}▶ IPv6 快 ${ratio.toFixed(2)} 倍，建议走 IPv6${C.r}`);
      else if (ratio < 0.87) console.log(`  ${C.c}${C.b}▶ IPv4 反而快 ${(1 / ratio).toFixed(2)} 倍，这个目标不该走 IPv6${C.r}`);
      else console.log(`  ${C.d}▶ 两者基本持平（${ratio.toFixed(2)} 倍），IPv6 无优势${C.r}`);
    } else if (b6) console.log(`\n  ${C.m}▶ 只有 IPv6 有可信结果，将全程走 v6${C.r}`);
    else if (b4) console.log(`\n  ${C.c}▶ 只有 IPv4 有可信结果（该目标没有 AAAA 或 v6 路径不通）${C.r}`);
    else console.log(`\n  ${C.y}▶ 两种协议族都没有测出可信吞吐，目标可能不可达或需要鉴权${C.r}`);
  }
  console.log(`\n  ${C.d}总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s${C.r}\n`);
}

// ---- 入口 ----
(async () => {
  const argv = process.argv.slice(2);
  const opts = { quick: false, json: false, policy: POLICY.AUTO, bytes: 4 * 1024 * 1024 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick' || a === '-q') opts.quick = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--bytes') { opts.bytes = Number(argv[++i]) * 1024 * 1024; }
    else if (a === '--policy') { opts.policy = argv[++i]; }
    else if (a === '--env') { await showEnv(); return; }
    else if (a === '--help' || a === '-h') {
      console.log(`
IPv6 下载加速器 - 命令行测速

  node cli.js <目标>              测一个 URL 或域名的 v4/v6 对比
  node cli.js <目标> --quick      只测 TCP 延迟，不下载
  node cli.js <目标> --json       输出 JSON
  node cli.js <目标> --bytes 16   每轮最多下 16MB 用于测速（默认 4）
  node cli.js --env               只检测本机 IPv6 环境

示例:
  node cli.js mirrors.zju.edu.cn
  node cli.js https://mirrors.tuna.tsinghua.edu.cn/ubuntu/ls-lR.gz
`);
      return;
    } else rest.push(a);
  }

  if (!rest.length) {
    console.log(`\n  用法: node cli.js <目标域名或URL>\n  例:   node cli.js mirrors.ustc.edu.cn\n  查看环境: node cli.js --env\n`);
    return;
  }

  // 支持一次测多个目标
  for (const t of rest) await probeOne(t, opts);
})().catch((e) => {
  console.error(`\n${C.red}出错:${C.r} ${e.message}\n`);
  process.exit(1);
});
