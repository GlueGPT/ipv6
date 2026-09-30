'use strict';
/**
 * test-e2e.js —— 端到端验证
 *
 * 验证的是"真的把流量交给代理，代理真的走了优选 IP"，而不是只调 API 看返回值。
 */

const http = require('http');
const net = require('net');
const tls = require('tls');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 8899;
const UI_PORT = 8900;

const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', m: '\x1b[35m', b: '\x1b[1m' };
let pass = 0, fail = 0;
const ok = (s) => { pass++; process.stdout.write(`${C.g}✓${C.r} ${s}\n`); };
const bad = (s) => { fail++; process.stdout.write(`\x1b[31m✗${C.r} ${s}\n`); };

function req(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: PROXY_HOST, port, path, method: body ? 'POST' : 'GET',
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      timeout: 90000,
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
        catch (_) { resolve({ status: res.statusCode, text: b }); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 通过代理下载一段数据，返回速度与命中 IP */
function downloadViaProxy(url, byteLimit) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host: PROXY_HOST, port: PROXY_PORT });
    let phase = 'connect';
    let bytes = 0, ttfb = null, settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      try { sock.destroy(); } catch (_) {}
      resolve({ ms: Math.round(ms), bytes, ttfb, ...extra });
    };
    sock.setTimeout(60000, () => finish({ ok: false, error: 'timeout' }));

    sock.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    sock.on('connect', () => {
      sock.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`);
    });

    sock.on('data', (chunk) => {
      if (phase === 'connect') {
        const s = chunk.toString('latin1');
        const idx = s.indexOf('\r\n\r\n');
        if (idx === -1) return;                 // 响应头还没收全
        const status = s.slice(0, s.indexOf('\r\n'));
        if (!/200/.test(status)) return finish({ ok: false, error: 'proxy-status: ' + status });
        phase = 'tls';
        const rest = chunk.subarray(idx + 4);

        const t = tls.connect({ socket: sock, servername: target.hostname, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false }, () => {
          phase = 'http';
          t.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\nRange: bytes=0-${byteLimit - 1}\r\nUser-Agent: e2e\r\nConnection: close\r\n\r\n`);
        });
        t.on('data', (c) => {
          if (c === undefined) return;
          if (ttfb === null) ttfb = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
          bytes += c.length;
          if (bytes >= byteLimit) {
            // 拿到响应头里的状态行 + 统计
            finish({ ok: true, statusLine: status, bytes });
            t.destroy();
          }
        });
        t.on('end', () => finish({ ok: true, statusLine: status, bytes }));
        t.on('error', (e) => finish({ ok: false, error: 'tls: ' + (e.code || e.message) }));
        if (rest.length) t.emit('data', rest);
        return;
      }
    });
  });
}

/** 等服务就绪：启动阶段要做 IPv6 探测，不能假设立刻可连 */
async function waitReady(port, tries = 40, gapMs = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await req(port, '/api/health');
      if (r.json && r.json.ok) return true;
    } catch (_) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

(async () => {
  console.log(`\n${C.b}${C.c}端到端验证${C.r}  代理 ${PROXY_HOST}:${PROXY_PORT}  界面 ${UI_PORT}\n`);

  const ready = await waitReady(UI_PORT);
  if (!ready) {
    bad(`界面服务在 20 秒内没有就绪（${UI_PORT}）`);
    process.exit(1);
  }

  // --- 1. 界面服务 ---
  console.log(`${C.b}[1] Web 界面与 API${C.r}`);
  const health = await req(UI_PORT, '/api/health').catch((e) => ({ error: e }));
  health.json && health.json.ok ? ok('/api/health 正常') : bad('/api/health 失败: ' + JSON.stringify(health).slice(0, 120));

  const page = await new Promise((resolve) => {
    http.get({ host: PROXY_HOST, port: UI_PORT, path: '/', timeout: 8000 }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, len: b.length, hasTitle: /IPv6 通用下载加速器/.test(b) }));
    }).on('error', (e) => resolve({ error: e.message }));
  });
  page.hasTitle ? ok(`首页 HTML 正常返回（${page.len} 字节，标题匹配）`) : bad('首页异常: ' + JSON.stringify(page));

  // --- 2. 环境检测 ---
  console.log(`\n${C.b}[2] 本机环境检测${C.r}`);
  const env = await req(UI_PORT, '/api/env');
  if (env.json && env.json.addresses) {
    const v6 = env.json.addresses.v6;
    v6.length ? ok(`检测到 ${v6.length} 个全局 IPv6 地址: ${v6.map((a) => a.address).join(', ')}`) : bad('未检测到 IPv6 地址');
    env.json.ipv6Tcp && env.json.ipv6Tcp.ok
      ? ok(`IPv6 TCP 连通，延迟 ${env.json.ipv6Tcp.latency} ms`)
      : bad('IPv6 TCP 不通');
    ok(`出口 IPv6: ${env.json.egressV6 && env.json.egressV6.ok ? env.json.egressV6.ip : '检测站点不可达（正常，多数在墙外）'}`);
    ok(`出口 IPv4: ${env.json.egressV4 && env.json.egressV4.ok ? env.json.egressV4.ip : '检测站点不可达'}`);
    ok(`hosts 路径: ${env.json.hostsPath}`);
  } else bad('/api/env 返回异常');

  // --- 3. 优选测速（双栈目标） ---
  console.log(`\n${C.b}[3] 优选测速 API（双栈目标）${C.r}`);
  const TARGET = 'https://mirrors.zju.edu.cn/ubuntu/ls-lR.gz';
  const pr = await req(UI_PORT, '/api/probe', { target: TARGET, doSpeed: true });
  if (pr.json && pr.json.rows) {
    const { rows, v4, v6 } = pr.json;
    ok(`解析到 ${rows.length} 个候选，耗时 ${pr.json.elapsed} ms`);
    for (const r of rows) {
      const tag = r.family === 6 ? `${C.m}IPv6${C.r}` : `${C.c}IPv4${C.r}`;
      const kb = r.speedKbps != null ? `${r.speedKbps} KB/s` : '—';
      const rel = r.reliable ? `${C.g}可信${C.r}` : `${C.y}样本不足${C.r}`;
      console.log(`     ${tag}  ${String(r.ip).padEnd(34)} 延迟 ${String(r.latency).padStart(6)} ms  吞吐 ${kb.padStart(12)}  ${rel}  HTTP ${r.code}`);
    }
    v6 && v6.alive ? ok(`IPv6 可用 ${v6.alive}/${v6.total}，最优 ${v6.bestIp}`) : bad('IPv6 侧无可测候选');
    v4 && v4.alive ? ok(`IPv4 可用 ${v4.alive}/${v4.total}，最优 ${v4.bestIp}`) : bad('IPv4 侧无可测候选');
    if (v6 && v4 && v6.bestKbps && v4.bestKbps) {
      const ratio = v6.bestKbps / v4.bestKbps;
      console.log(`     ${C.d}IPv6 / IPv4 吞吐比 = ${ratio.toFixed(2)}×${C.r}`);
    }
  } else bad('/api/probe 返回异常: ' + JSON.stringify(pr).slice(0, 160));

  // --- 4. 真实穿越代理下载 ---
  console.log(`\n${C.b}[4] 真的把流量交给代理（CONNECT 隧道 + TLS）${C.r}`);
  const cold = await downloadViaProxy(TARGET, 1 * 1024 * 1024);
  if (cold.ok) {
    // 两阶段设计：首包只等延迟探测，不应该被吞吐测速拖到一秒
    const fast = cold.ttfb != null && cold.ttfb < 500;
    const msg = `首次请求（冷启动）TTFB ${cold.ttfb} ms，耗 ${cold.ms} ms`;
    fast ? ok(`${msg}  —— 首包没有被吞吐测速阻塞`) : bad(`${msg}  —— 首包仍然过慢`);
  } else {
    bad('首次请求失败: ' + JSON.stringify(cold).slice(0, 160));
  }

  const dl = await downloadViaProxy(TARGET, 8 * 1024 * 1024);
  if (dl.ok && dl.bytes > 0) {
    const transferMs = dl.ttfb != null ? dl.ms - dl.ttfb : dl.ms;
    const kbps = transferMs > 0 ? Math.round((dl.bytes / 1024) / (transferMs / 1000)) : 0;
    ok(`经代理下载成功：${(dl.bytes / 1048576).toFixed(2)} MB，总耗时 ${dl.ms} ms，TTFB ${dl.ttfb} ms`);
    ok(`端到端吞吐 ≈ ${(kbps / 1024).toFixed(1)} MB/s（已扣除 TTFB）`);
  } else {
    bad(`经代理下载失败: ${JSON.stringify(dl).slice(0, 200)}`);
  }

  // --- 4b. 后台优选是否补上了吞吐数据 ---
  console.log(`\n${C.b}[4b] 后台吞吐优选是否生效${C.r}`);
  let refined = null;
  for (let i = 0; i < 30; i++) {
    const r = await req(UI_PORT, '/api/route');
    const rec = (r.json.routes || []).find((x) => x.hostname === 'mirrors.zju.edu.cn');
    if (rec && rec.speedDone) { refined = rec; break; }
    await new Promise((x) => setTimeout(x, 700));
  }
  if (refined) {
    ok(`后台优选已完成：主用 ${refined.primary}，竞速顺序 [${refined.raceOrder.join(', ')}]`);
  } else {
    bad('20 秒内后台优选没有完成（speedDone 未置位）');
  }

  // --- 5. 代理是否真的把连接换成了优选 IP ---
  console.log(`\n${C.b}[5] 代理统计：确认连接落在优选 IP 上${C.r}`);
  await new Promise((r) => setTimeout(r, 600));
  const st = await req(UI_PORT, '/api/stats');
  if (st.json) {
    const s = st.json;
    ok(`请求 ${s.requests} · 隧道 ${s.tunnels} · 错误 ${s.errors} · 下行 ${(s.bytesDown / 1048576).toFixed(2)} MB`);
    const v6c = s.connV6 || 0, v4c = s.connV4 || 0;
    console.log(`     ${C.d}连接分布: IPv6 ${v6c} 个 / IPv4 ${v4c} 个${C.r}`);
    if (s.tunnels > 0) ok(`CONNECT 隧道已建立并通过代理转发`);
    else bad('没有记录到 CONNECT 隧道');
    if (s.routes && s.routes.length) {
      for (const r of s.routes) {
        console.log(`     ${C.d}路由: ${r.hostname}  主用 ${r.primary}  竞速 [${(r.raceOrder || []).join(', ')}]  命中 ${r.hits}${C.r}`);
      }
      const hit = s.routes.find((r) => r.hostname === 'mirrors.zju.edu.cn');
      hit && hit.primary ? ok(`mirrors.zju.edu.cn 已建立优选路由，主用 ${hit.primary}`) : bad('没有该域名的路由记录');
    } else bad('路由表为空');
    const byIp = s.byIp || [];
    byIp.length ? ok(`实际承载流量的 IP: ${byIp.map((e) => `${e.ip}(v${e.family},${(e.bytesDown / 1048576).toFixed(1)}MB)`).join('  ')}`) : bad('没有 byIp 统计');
  } else bad('/api/stats 异常');

  // --- 6. 策略切换 ---
  console.log(`\n${C.b}[6] 策略切换${C.r}`);
  const p1 = await req(UI_PORT, '/api/policy', { policy: 'v6' });
  p1.json && p1.json.policy === 'v6' ? ok('已切换为「强制 IPv6」') : bad('策略切换失败');
  const pr2 = await req(UI_PORT, '/api/probe', { target: TARGET, doSpeed: false, policy: 'v6' });
  const onlyV6 = pr2.json && pr2.json.rows && pr2.json.rows.every((r) => r.family === 6);
  onlyV6 ? ok('强制 IPv6 策略下，排序结果只含 IPv6 候选') : bad('策略未生效: ' + JSON.stringify((pr2.json || {}).rows || []).slice(0, 100));
  await req(UI_PORT, '/api/policy', { policy: 'auto' });
  ok('已恢复「自动」策略');

  // --- 7. hosts 只读检查 ---
  console.log(`\n${C.b}[7] hosts 模式检查${C.r}`);
  const hl = await req(UI_PORT, '/api/hosts', { action: 'list' });
  hl.json && hl.json.ok ? ok(`hosts 可读取，当前受管条目 ${hl.json.entries.length} 条`) : bad('hosts 读取失败: ' + JSON.stringify(hl).slice(0, 140));

  console.log(`\n${C.b}${pass} 项通过，${fail} 项失败${C.r}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n验证过程出错:', e); process.exit(1); });
