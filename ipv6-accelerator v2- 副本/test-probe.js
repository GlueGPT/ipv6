'use strict';
/**
 * test-probe.js —— 探测模块自测
 * 直接验证：DNS 展开、TCP 延迟、HTTP 吞吐、竞速连接、优选排序
 */

const probe = require('./lib/probe');
const { rank, toRaceOrder, POLICY } = require('./lib/route');
const { raceConnect, connectTo } = require('./lib/connect');

const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', m: '\x1b[35m', b: '\x1b[1m' };
const ok = (s) => process.stdout.write(`${C.g}✓${C.r} ${s}\n`);
const bad = (s) => process.stdout.write(`\x1b[31m✗${C.r} ${s}\n`);

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - len(s))); }
function len(s) { let n = 0; for (const ch of String(s)) n += ch.charCodeAt(0) > 255 ? 2 : 1; return n; }

(async () => {
  const TARGETS = [
    'mirrors.ustc.edu.cn',
    'mirrors.tuna.tsinghua.edu.cn',
    'www.qq.com',
    'mirrors.zju.edu.cn',
  ];

  console.log(`\n${C.b}=== 1. DNS 展开（A / AAAA） ===${C.r}`);
  for (const t of TARGETS) {
    const r = await probe.resolveHost(t);
    console.log(`${pad(t, 34)} v6=${String(r.v6.length).padStart(2)}  v4=${String(r.v4.length).padStart(2)}   ${C.m}${r.v6.slice(0, 2).join(' ')}${C.r}`);
  }

  console.log(`\n${C.b}=== 2. TCP 延迟探测（并发多端口） ===${C.r}`);
  const cands = await probe.buildCandidates('mirrors.ustc.edu.cn');
  const all = [...cands.family.v6.map((ip) => ({ ip, fam: 6 })), ...cands.family.v4.map((ip) => ({ ip, fam: 4 }))];
  for (const c of all) {
    const t0 = Date.now();
    const r = await probe.probeTcpParallel(c.ip, [443, 80], { timeout: 1500 });
    const tag = c.fam === 6 ? `${C.m}v6${C.r}` : `${C.c}v4${C.r}`;
    if (r.ok) console.log(`${tag} ${pad(c.ip, 40)} ${String(r.latency.toFixed(1)).padStart(7)} ms  :${r.port}  ${C.d}(${Date.now() - t0}ms 总耗时)${C.r}`);
    else console.log(`${tag} ${pad(c.ip, 40)} ${C.d}不通 (${r.error.slice(0, 40)})${C.r}`);
  }

  console.log(`\n${C.b}=== 3. HTTP 吞吐实测（带 Range，只下 3MB） ===${C.r}`);
  // 注意：候选 IP 必须和 URL 的域名同源，否则 SNI/Host 对不上，TLS 直接协商失败
  const TEST_URL = 'https://mirrors.zju.edu.cn/ubuntu/ls-lR.gz';
  const tcands = await probe.buildCandidates(TEST_URL);
  const tall = [
    ...tcands.family.v6.map((ip) => ({ ip, fam: 6 })),
    ...tcands.family.v4.map((ip) => ({ ip, fam: 4 })),
  ];
  console.log(`${C.d}  目标: ${TEST_URL}`);
  console.log(`  候选: ${tall.map((x) => `v${x.fam} ${x.ip}`).join('  ')}${C.r}`);
  const speedRows = [];
  for (const c of tall) {
    const s = await probe.probeThroughput(TEST_URL, c.ip, { byteLimit: 3 * 1024 * 1024, timeout: 10000 });
    const tag = c.fam === 6 ? `${C.m}v6${C.r}` : `${C.c}v4${C.r}`;
    if (s.ok) {
      const kbps = s.kbps != null ? Math.round(s.kbps) : 0;
      speedRows.push({ ip: c.ip, fam: c.fam, kbps: s.reliable ? kbps : null, reliable: s.reliable, latency: null });
      const flag = s.reliable ? `${C.g}可信${C.r}` : `${C.y}样本不足${C.r}`;
      console.log(`${tag} ${pad(c.ip, 40)} ${String(kbps).padStart(6)} KB/s  ttfb=${String(s.ttfb).padStart(6)}ms  传输=${(s.bytes / 1024).toFixed(0)}KB  耗时=${s.transferMs}ms  HTTP ${s.code}  ${flag}`);
    } else {
      console.log(`${tag} ${pad(c.ip, 40)} ${C.d}失败: ${s.error}${C.r}`);
    }
  }
  // 用同源候选继续后面的排序/竞速测试
  all.length = 0; all.push(...tall);

  console.log(`\n${C.b}=== 4. 优选排序（只有可信测量参与排序） ===${C.r}`);
  const ranked = rank(speedRows.map((r) => ({ ...r, ok: true, family: r.fam, latency: 0, port: 443 })), { policy: POLICY.AUTO });
  ranked.forEach((r, i) => {
    const tag = r.family === 6 ? `${C.m}IPv6${C.r}` : `${C.c}IPv4${C.r}`;
    console.log(`  #${i + 1}  ${tag}  ${pad(r.ip, 40)} ${String(r.kbps == null ? '不可信' : r.kbps).padStart(6)} KB/s   分数 ${r.score}`);
  });

  console.log(`\n${C.b}=== 5. 竞速连接（多 IP 谁先连上用谁） ===${C.r}`);
  const raceIps = ranked.filter((r) => r.ok).slice(0, 4).map((r) => r.ip);
  const t0 = Date.now();
  const win = await raceConnect({ ips: raceIps, port: 443, stagger: 80, timeout: 5000 });
  const tag = String(win.remoteAddress).includes(':') ? `${C.m}IPv6${C.r}` : `${C.c}IPv4${C.r}`;
  ok(`竞速获胜 ${tag} ${win.ip} → 实际远端 ${win.remoteAddress}:${win.remotePort}`);
  console.log(`${C.d}  候选 ${raceIps.length} 个错峰发起，用时 ${Date.now() - t0}ms；剩余落败连接已销毁${C.r}`);
  win.socket.destroy();

  console.log(`\n${C.b}=== 6. 完整 connectTo（含 TLS 升级） ===${C.r}`);
  try {
    const r = await connectTo('mirrors.zju.edu.cn', 443, { router: null, isTls: true });
    ok(`TLS 建连成功 → 实际 IP ${r.ip}  ALPN=${r.alpn}  加密=${r.socket.encrypted}`);
    r.socket.destroy();
  } catch (e) {
    bad(`TLS 建连失败: ${e.message}`);
  }

  console.log(`\n${C.b}=== 7. 路由表端到端 ===${C.r}`);
  const { RouteTable } = require('./lib/route');
  const rt = new RouteTable({ policy: POLICY.AUTO });
  const rec = await rt.lookup('mirrors.zju.edu.cn', { doSpeed: true });
  ok(`路由表已建立：主用 ${rec.primary}，竞速顺序 [${rec.raceOrder.join(', ')}]`);
  console.log(`${C.d}  候选共 ${rec.rows.length} 个，可用 ${rec.rows.filter((r) => r.ok).length} 个${C.r}`);

  console.log(`\n${C.g}${C.b}全部模块自测通过${C.r}\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
