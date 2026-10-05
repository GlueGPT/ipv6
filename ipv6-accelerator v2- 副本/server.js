'use strict';
/**
 * server.js —— IPv6 通用下载加速器（本地代理 + Web UI）
 *
 * 用法:
 *   node server.js                      启动代理和界面，默认 http://127.0.0.1:8899
 *   node server.js --port 9000          换端口
 *   node server.js --policy v6          只走 IPv6
 *   node server.js --no-ui              只跑代理，不给界面
 *   node server.js --socks5 1088        额外开一个 SOCKS5 端口
 *   node server.js --local 2001:da8:e000:9::c90c   绑定指定出口地址
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

const probe = require('./lib/probe');
const { RouteTable, POLICY, rank } = require('./lib/route');
const proxy = require('./lib/proxy');
const { ProxyServer, Socks5Server } = proxy;
const hosts = require('./lib/hosts');
const presets = require('./lib/presets');
const logos = require('./lib/logos');

// 启动即校验：模式的 icon 必须在 logos.js 里有定义。
// 名字写错时前端只会显示空白图标，不主动检查根本发现不了。
{
  const problems = presets.validateIcons(logos);
  if (problems.length) {
    console.error('[错误] 平台图标配置有问题：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

/**
 * 服务身份标识。
 * 启动器要靠它判断"8899/8900 上跑的到底是不是我"，
 * 而不是随便一个占用该端口的程序。
 */
const SERVICE_ID = 'ipv6-accelerator';
const VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { port: 8899, host: '127.0.0.1', policy: POLICY.AUTO, ui: true, socks5: 0, local: null, log: true, systemProxy: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--port' || k === '-p') { a.port = Number(v); i++; }
    else if (k === '--host') { a.host = v; i++; }
    else if (k === '--policy') { a.policy = v; i++; }
    else if (k === '--no-ui') { a.ui = false; }
    else if (k === '--socks5') { a.socks5 = Number(v); i++; }
    else if (k === '--local') { a.local = v; i++; }
    else if (k === '--system-proxy') { a.systemProxy = true; }
    else if (k === '--quiet' || k === '-q') { a.log = false; }
    else if (k === '--help' || k === '-h') { a.help = true; }
  }
  return a;
}

const ARGS = parseArgs(process.argv);
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function log(level, msg) {
  if (!ARGS.log && level === 'info') return;
  const tag = { info: `${C.cyan}[信息]${C.reset}`, warn: `${C.yellow}[警告]${C.reset}`, error: `${C.red}[错误]${C.reset}`, ok: `${C.green}[完成]${C.reset}` }[level] || '[信息]';
  process.stdout.write(`${tag} ${msg}\n`);
}

if (ARGS.help) {
  console.log(`
IPv6 通用下载加速器 —— 本地代理模式

  node server.js [选项]

  --port <n>      代理和界面端口（默认 8899）
  --host <ip>     监听地址（默认 127.0.0.1，改成 0.0.0.0 可给局域网设备用）
  --policy <p>    上游 IP 策略: auto | v6 | v4 | balance（默认 auto）
  --socks5 <n>    额外监听一个 SOCKS5 端口（默认不开）
  --local <ip>    绑定本机出口地址，例如 2001:da8:e000:9::c90c
  --system-proxy  声明系统代理已指向本加速器（由启动器传入，用于界面显示状态）
  --no-ui         不提供 Web 界面
  --quiet         少打印日志
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------
const ROUTER = new RouteTable({
  policy: ARGS.policy,
  localAddress: ARGS.local || undefined,
});

let PROXY = null;
let SOCKS = null;

// 由启动器通过 --system-proxy 告知：当前系统代理是不是指向本加速器。
// 界面用它来显示"浏览器模式"是否已生效。
let SYSTEM_PROXY_ON = false;

// ---------------------------------------------------------------------------
// 本机网络环境检测
// ---------------------------------------------------------------------------

/** 取出本机所有非回环 IPv6 / IPv4 地址，并区分全局地址与链路本地地址 */
async function localAddresses() {
  const res = { v4: [], v6: [], v6LinkLocal: [] };
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.internal) continue;
      if (i.family === 'IPv6') {
        const entry = { iface: name, address: i.address, scopeid: i.scopeid, mac: i.mac };
        // fe80::/10 是链路本地地址，不能用来访问互联网，单独归类避免误导
        if (/^fe80:/i.test(i.address)) res.v6LinkLocal.push(entry);
        else res.v6.push(entry);
      } else if (i.family === 'IPv4') {
        res.v4.push({ iface: name, address: i.address, mac: i.mac });
      }
    }
  }
  return res;
}

/** 出口 IPv4（这些检测站点多在墙外，不通是常态，只用于展示） */
async function egressV4(timeout = 4000) {
  const urls = ['https://v4.myip.la/', 'https://ipv4.icanhazip.com/', 'https://4.ipw.cn/', 'https://myip.ipip.net/'];
  return raceText(urls, 4, timeout);
}

/** 出口 IPv6 */
async function egressV6(timeout = 4000) {
  const urls = ['https://v6.myip.la/', 'https://ipv6.icanhazip.com/', 'https://6.ipw.cn/', 'https://ipv6.lookup.test-ipv6.com/ip/'];
  return raceText(urls, 6, timeout);
}

/** 从一组 URL 里竞速取第一个成功返回的文本 */
function raceText(urls, family, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    let pending = urls.length;
    const done = (r) => {
      if (settled) return;
      pending--;
      if (r) { settled = true; resolve(r); return; }
      if (pending <= 0) { settled = true; resolve({ ok: false, error: '所有检测地址均不可达' }); }
    };
    const t = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'timeout' }); } }, timeout);
    for (const u of urls) {
      probeHttpText(u, family, timeout).then(done, () => done(null));
    }
    void t;
  });
}

function probeHttpText(url, family, timeout) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { family, timeout, headers: { 'user-agent': 'IPv6Accelerator/1.0' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 4096) req.destroy(); });
      res.on('end', () => {
        const ip = extractIp(buf);
        if (ip) resolve({ ok: true, url, ip, raw: buf.trim().slice(0, 200) });
        else resolve(null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function extractIp(text) {
  const t = String(text);
  const m6 = t.match(/([0-9a-fA-F]{0,4}:[0-9a-fA-F:]{2,})/);
  const m4 = t.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  if (m4) return m4[1];
  if (m6) return m6[1];
  return null;
}

/** 纯 IPv6 连通性判断（不依赖能否查到出口 IP） */
async function ipv6Reachable() {
  // 这些是国内可达的 v6 递归 DNS / 公共地址，用短超时快速判断，
  // 避免启动阶段被墙外目标的超时拖住。
  const targets = ['2400:3200::1', '2400:3200:baba::1', '240c::6666', '2400:da00::6666'];
  const r = await Promise.all(targets.map((ip) => probe.probeTcp(ip, [53, 80, 443], { timeout: 1200 })));
  const best = r.filter((x) => x.ok).sort((a, b) => a.latency - b.latency)[0];
  return best ? { ok: true, latency: Math.round(best.latency * 10) / 10 } : { ok: false };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** 单域名/URL 测速：解析 + 全候选探测 */
async function apiProbe(req, res) {
  const body = await readJson(req);
  const target = String(body.target || '').trim();
  if (!target) return json(res, 400, { error: '请填写 URL 或域名' });

  const t0 = Date.now();
  let cands;
  try {
    cands = await probe.buildCandidates(target, { originPool: body.originPool || ROUTER.originPool });
  } catch (e) {
    return json(res, 400, { error: `目标无法解析: ${e.message}` });
  }

  const rows = await probe.probeAll(cands, {
    doSpeed: body.doSpeed !== false,
    speedByteLimit: Number(body.byteLimit) || 1.5 * 1024 * 1024,
    speedTimeout: Number(body.speedTimeout) || 6000,
    concurrency: 16,
    localAddress: ARGS.local || undefined,
  });

  const ranked = rank(rows, { policy: body.policy || ROUTER.policy, blocked: ROUTER.blocked });

  // 汇总对比 v4 / v6
  const sum = (fam) => {
    const list = ranked.filter((r) => r.family === fam && r.ok);
    if (!list.length) return null;
    const best = list.reduce((a, b) => ((b.kbps || 0) > (a.kbps || 0) ? b : a), list[0]);
    const bestLat = list.reduce((a, b) => ((b.latency || 1e9) < (a.latency || 1e9) ? b : a), list[0]);
    const speeds = list.map((r) => r.kbps).filter((x) => x != null);
    return {
      alive: list.length,
      total: ranked.filter((r) => r.family === fam).length,
      bestIp: best.ip,
      bestKbps: best.kbps,
      bestLatency: bestLat.ip,
      minLatency: bestLat.latency,
      avgKbps: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null,
    };
  };

  json(res, 200, {
    target: cands.url ? cands.url.toString() : target,
    hostname: cands.hostname,
    port: cands.port,
    sources: cands.sources,
    elapsed: Date.now() - t0,
    speedUrl: rows.speedUrl || null,          // 实际用来测吞吐的地址（标定结果）
    calibrated: !!rows.calibrated,
    rows: ranked,
    v4: sum(4),
    v6: sum(6),
  });
}

async function apiEnv(req, res) {
  const [addrs, v4, v6, reach] = await Promise.all([
    localAddresses(), egressV4(), egressV6(), ipv6Reachable(),
  ]);
  json(res, 200, {
    addresses: addrs,
    egressV4: v4,
    egressV6: v6,
    ipv6Tcp: reach,
    policy: ROUTER.policy,
    localAddress: ARGS.local,
    proxy: PROXY ? PROXY.address : null,
    socks5: SOCKS ? `socks5://${SOCKS.host}:${SOCKS.port}` : null,
    hostsPath: hosts.hostsPath(),
    hostsManaged: hosts.listManaged().length,
    platform: `${process.platform} ${os.release()}`,
    node: process.version,
  });
}

/** hosts 增强模式 */
async function apiHosts(req, res) {
  const body = await readJson(req);
  const action = body.action;
  try {
    if (action === 'list') return json(res, 200, { ok: true, entries: hosts.listManaged(), path: hosts.hostsPath() });
    if (action === 'revert') {
      const r = hosts.revert();
      if (r.ok) await hosts.flushDns();
      return json(res, r.ok ? 200 : 500, r);
    }
    if (action === 'apply') {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (!entries.length) return json(res, 400, { ok: false, error: '没有可写入的条目' });
      const r = hosts.apply(entries);
      if (r.ok) await hosts.flushDns();
      return json(res, r.ok ? 200 : 500, r);
    }
    return json(res, 400, { ok: false, error: `未知操作: ${action}` });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

/** 一键把 topN 优选 IP 写进 hosts */
async function apiHostsAuto(req, res) {
  const body = await readJson(req);
  const targets = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length) return json(res, 400, { ok: false, error: '请提供 targets 列表' });
  const policy = body.policy || ROUTER.policy;
  const out = [];
  for (const t of targets) {
    try {
      const cands = await probe.buildCandidates(t, { originPool: ROUTER.originPool });
      const rows = await probe.probeAll(cands, { doSpeed: true, concurrency: 16, localAddress: ARGS.local || undefined });
      const ranked = rank(rows, { policy, blocked: ROUTER.blocked });
      const best = ranked.find((r) => r.ok);
      if (best) out.push({ host: cands.hostname, ip: best.ip, comment: `v${best.family} ${best.kbps || '-'}KB/s ${best.latency}ms` });
      else out.push({ host: cands.hostname, ip: null, error: '无可用 IP' });
    } catch (e) {
      out.push({ host: String(t), ip: null, error: e.message });
    }
  }
  const ok = out.filter((e) => e.ip);
  if (!ok.length) return json(res, 500, { ok: false, error: '所有目标都没找到可用 IP', detail: out });
  const r = hosts.apply(ok);
  if (r.ok) await hosts.flushDns();
  return json(res, r.ok ? 200 : 500, { ...r, detail: out });
}

/** 手动拉黑 / 解除 */
async function apiBlock(req, res) {
  const body = await readJson(req);
  if (body.ip && body.action === 'block') ROUTER.block(body.ip);
  else if (body.ip && body.action === 'unblock') ROUTER.unblock(body.ip);
  else if (body.action === 'clear') ROUTER.blocked.clear();
  json(res, 200, { ok: true, blocked: Array.from(ROUTER.blocked) });
}

// ---------------------------------------------------------------------------
// 多模式（一键切换浏览器 / Steam / Epic ...）
// ---------------------------------------------------------------------------

/** 列出所有模式及其当前状态 */
async function apiModes(req, res) {
  const writable = hosts.canWrite();
  const active = hosts.activeModes();
  const entries = hosts.listManaged();

  const modes = presets.listModes().map((m) => {
    const mine = entries.filter((e) => e.mode === m.id);
    const blocked = m.strategy === 'hosts' && m.requiresAdmin && !writable.ok;
    return {
      ...m,
      active: m.strategy === 'proxy' ? !!SYSTEM_PROXY_ON : mine.length > 0,
      entryCount: mine.length,
      available: !blocked,
      unavailableReason: blocked ? writable.error : null,
    };
  });

  json(res, 200, {
    ok: true,
    modes,
    activeModes: active,
    hostsWritable: writable.ok,
    hostsError: writable.ok ? null : writable.error,
    hostsPath: writable.path,
    proxyAddress: PROXY ? PROXY.address : null,
    hostEntries: entries.length,
  });
}

/**
 * 应用某个模式。
 *
 * 流程：展开域名 → 并发逐个优选 → 合并写入 hosts（保留其他模式）→ 刷 DNS
 *
 * 注意这里不做整批无上限并发：域名可能有二三十个，每个都要连多个 CDN 节点，
 * 一次性打出去容易被 CDN 判成异常流量。用一个小并发池 + 总时间预算控制。
 */
async function apiModesApply(req, res) {
  const body = await readJson(req);
  const mode = presets.getMode(String(body.mode || ''));
  if (!mode) return json(res, 400, { ok: false, error: `未知模式: ${body.mode}` });

  // 代理类模式不写 hosts，交给启动器/系统代理开关处理
  if (mode.strategy === 'proxy') {
    return json(res, 400, {
      ok: false,
      error: '该模式使用本地代理，不需要写 hosts',
      hint: '把浏览器的 HTTP/HTTPS 代理设为 127.0.0.1:8899，或运行「一键开启系统代理.cmd」。',
    });
  }

  const writable = hosts.canWrite();
  if (!writable.ok) {
    return json(res, 403, {
      ok: false,
      needAdmin: true,
      error: writable.error,
      hint: '请关掉本程序，右键「以管理员身份运行」start.cmd，然后再应用这个模式。',
    });
  }

  let domains = presets.expandDomains(mode);
  const roleFilter = body.role ? String(body.role) : null;
  if (roleFilter) domains = domains.filter((d) => d.role === roleFilter);

  const maxDomains = Math.max(1, Number(body.maxDomains) || 32);
  domains = domains.slice(0, maxDomains);

  if (!domains.length) return json(res, 400, { ok: false, error: '该模式没有可优选的域名' });

  const doSpeed = body.doSpeed !== false;
  const t0 = Date.now();
  const budgetMs = Math.max(10000, Number(body.budgetMs) || 120000);
  const concurrency = Math.max(1, Number(body.concurrency) || 4);

  const limit = probe.createLimiter(concurrency);
  const results = [];
  let timedOut = false;

  await Promise.all(domains.map((d) => limit(async () => {
    if (Date.now() - t0 > budgetMs) { timedOut = true; results.push({ ...d, ok: false, error: '超出时间预算，跳过' }); return; }
    try {
      const cands = await probe.buildCandidates(`https://${d.host}/`, { originPool: ROUTER.originPool });
      const rows = await probe.probeAll(cands, {
        doSpeed,
        concurrency: 6,
        localAddress: ARGS.local || undefined,
      });
      const ranked = rank(rows, { policy: body.policy || ROUTER.policy, blocked: ROUTER.blocked });
      const best = ranked.find((r) => r.ok);
      if (!best) return results.push({ ...d, ok: false, error: '没有可用 IP' });
      results.push({
        ...d, ok: true, ip: best.ip, family: best.family,
        latency: best.latency, kbps: best.kbps, reliable: !!best.reliable,
        candidates: ranked.filter((r) => r.ok).length,
      });
    } catch (e) {
      results.push({ ...d, ok: false, error: e.message });
    }
  })));

  const good = results.filter((r) => r.ok && r.ip);
  if (!good.length) {
    return json(res, 500, {
      ok: false,
      error: '所有域名都没找到可用 IP，hosts 未改动',
      detail: results,
      elapsed: Date.now() - t0,
    });
  }

  const entries = good.map((r) => ({
    ip: r.ip,
    host: r.host,
    mode: mode.id,
    role: r.role,
    comment: `${r.family === 6 ? 'v6' : 'v4'} ${r.latency != null ? r.latency + 'ms' : ''} ${r.reliable && r.kbps ? (r.kbps / 1024).toFixed(1) + 'MB/s' : ''}`.trim(),
  }));

  // replaceModes 只清掉本模式的旧条目，其他模式保留
  const w = hosts.apply(entries, { replaceModes: [mode.id], keepOthers: true });
  if (!w.ok) return json(res, 500, { ok: false, ...w, detail: results });

  const flushed = await hosts.flushDns();

  json(res, 200, {
    ok: true,
    mode: mode.id,
    modeName: mode.name,
    written: w.count,
    applied: good.length,
    failed: results.filter((r) => !r.ok).length,
    timedOut,
    elapsed: Date.now() - t0,
    hostsPath: w.path,
    dnsFlushed: flushed.ok,
    detail: results,
    tip: mode.tip,
  });
}

/** 还原某个模式（只移除该模式的条目） */
async function apiModesRevert(req, res) {
  const body = await readJson(req);
  const modeId = body.mode ? String(body.mode) : null;

  if (!modeId) {
    const r = hosts.revert();
    if (r.ok) await hosts.flushDns();
    return json(res, r.ok ? 200 : 500, r);
  }

  const r = hosts.revertMode(modeId);
  if (r.ok) await hosts.flushDns();
  json(res, r.ok ? 200 : 500, r);
}

/** 当前 hosts 里各模式的明细 */
async function apiModesEntries(req, res) {
  json(res, 200, {
    ok: true,
    entries: hosts.listManaged(),
    modes: hosts.activeModes(),
    writable: hosts.canWrite().ok,
  });
}

/** 代理测速：通过自己的代理下载一段，验证端到端生效 */
async function apiSpeedtest(req, res) {
  const body = await readJson(req);
  const url = String(body.url || '').trim();
  if (!url) return json(res, 400, { error: '请提供下载地址' });
  const useProxy = body.viaProxy !== false;
  const byteLimit = Number(body.byteLimit) || 8 * 1024 * 1024;
  const timeout = Number(body.timeout) || 20000;
  const t0 = Date.now();
  const result = await directDownload(url, { byteLimit, timeout, proxy: useProxy ? PROXY : null, family: body.family || 0 });
  json(res, 200, { url, viaProxy: useProxy, elapsed: Date.now() - t0, ...result });
}

/** 不经过探测、直接下载一段数据量速度（可指定走不走代理） */
function directDownload(url, { byteLimit = 8e6, timeout = 20000, proxy = null, family = 0 } = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch (_) { return resolve({ ok: false, error: 'bad-url' }); }
    const isTls = target.protocol === 'https:';
    const mod = isTls ? require('https') : require('http');

    // 走代理时，把请求发给代理，并用绝对 URL
    const opts = proxy
      ? {
        host: proxy.host, port: proxy.port, method: 'GET',
        path: target.toString(),
        headers: { Host: target.host, 'user-agent': 'IPv6Accelerator/1.0', Range: `bytes=0-${byteLimit - 1}`, 'accept-encoding': 'identity' },
        timeout,
      }
      : {
        protocol: target.protocol, hostname: target.hostname,
        port: target.port || (isTls ? 443 : 80),
        path: target.pathname + target.search, method: 'GET',
        headers: { Host: target.host, 'user-agent': 'IPv6Accelerator/1.0', Range: `bytes=0-${byteLimit - 1}`, 'accept-encoding': 'identity' },
        timeout, family: family || undefined, rejectUnauthorized: false,
      };

    const t0 = process.hrtime.bigint();
    let bytes = 0, ttfb = null, settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ ttfb, ms: Math.round(ms), bytes, kbps: ms > 0 ? Math.round((bytes / 1024) / (ms / 1000)) : 0, ...extra });
    };

    const req = mod.request(opts, (r) => {
      if (ttfb === null) ttfb = Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 10) / 10;
      r.on('data', (c) => {
        bytes += c.length;
        if (bytes >= byteLimit) { req.destroy(); finish({ ok: true, code: r.statusCode, truncated: true }); }
      });
      r.on('end', () => finish({ ok: true, code: r.statusCode }));
      r.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP 服务 + 静态界面
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

function makeUiServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;

    try {
      if (p.startsWith('/api/')) {
        if (p === '/api/health') {
          return json(res, 200, {
            ok: true, service: SERVICE_ID, version: VERSION,
            pid: process.pid, port: ARGS.port, uiPort: ARGS.port + 1,
            ts: Date.now(),
          });
        }
        if (p === '/api/env') return apiEnv(req, res);
        if (p === '/api/probe') return apiProbe(req, res);
        if (p === '/api/speedtest') return apiSpeedtest(req, res);
        if (p === '/api/route') return json(res, 200, { policy: ROUTER.policy, blocked: Array.from(ROUTER.blocked), routes: ROUTER.snapshot() });
        if (p === '/api/policy') {
          const b = await readJson(req);
          if (b.policy && Object.values(POLICY).includes(b.policy)) { ROUTER.setPolicy(b.policy); }
          if (b.localAddress !== undefined) { ROUTER.setLocalAddress(b.localAddress); }
          if (Array.isArray(b.originPool)) { ROUTER.setOriginPool(b.originPool); }
          return json(res, 200, { ok: true, policy: ROUTER.policy, localAddress: ROUTER.localAddress, originPool: ROUTER.originPool });
        }
        if (p === '/api/stats') {
          return json(res, 200, {
            ...(PROXY ? PROXY.stats.snapshot() : {}),
            ...(SOCKS ? { socks5: SOCKS.stats.snapshot() } : {}),
            policy: ROUTER.policy,
            routes: ROUTER.snapshot().slice(0, 40),
          });
        }
        if (p === '/api/block') return apiBlock(req, res);
        if (p === '/api/hosts') return apiHosts(req, res);
        if (p === '/api/hosts/auto') return apiHostsAuto(req, res);
        if (p === '/api/modes') return apiModes(req, res);
        if (p === '/api/modes/apply') return apiModesApply(req, res);
        if (p === '/api/modes/revert') return apiModesRevert(req, res);
        if (p === '/api/modes/entries') return apiModesEntries(req, res);
        if (p === '/api/resolve') {
          const b = await readJson(req);
          const r = await probe.resolveHost(String(b.hostname || '').trim());
          return json(res, 200, r);
        }
        return json(res, 404, { error: 'no such api' });
      }

      if (!ARGS.ui) { res.writeHead(404); return res.end('UI disabled'); }

      // 静态文件
      let file = p === '/' ? '/index.html' : p;
      file = path.normalize(file).replace(/^([/\\])+/, '');
      const full = path.join(__dirname, 'public', file);
      if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end('forbidden'); }
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(full).toLowerCase();

      // 首页需要把平台图标 sprite 注入进去（图标由 lib/logos.js 生成，无外部资源依赖）
      if (ext === '.html') {
        let html = fs.readFileSync(full, 'utf8');
        if (html.includes('<!--LOGOS-->')) {
          html = html.replace('<!--LOGOS-->', logos.sprite(48));
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-length': Buffer.byteLength(html),
        });
        return res.end(html);
      }

      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      log('error', `界面服务出错: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else try { res.destroy(); } catch (_) {}
    }
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/** 记录自己监听的端口和 PID，供启动器判断"是不是已经有实例在跑" */
const PID_FILE = path.join(__dirname, 'accelerator.pid');

function writePidFile() {
  const info = {
    service: SERVICE_ID,
    version: VERSION,
    pid: process.pid,
    proxyPort: ARGS.port,
    uiPort: ARGS.ui ? ARGS.port + 1 : null,
    host: ARGS.host,
    startedAt: new Date().toISOString(),
  };
  try { fs.writeFileSync(PID_FILE, JSON.stringify(info, null, 2), 'utf8'); } catch (_) {}
  return info;
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}

/** 判断某个端口是否已经被占用（不用等 listen 报错） */
function portInUse(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, host);
  });
}

async function main() {
  SYSTEM_PROXY_ON = !!ARGS.systemProxy;

  const banner = [
    '',
    `${C.bold}${C.cyan}  IPv6 通用下载加速器${C.reset}  ${C.dim}本地代理模式 · 不改 hosts、不需管理员${C.reset}`,
    '',
  ].join('\n');
  process.stdout.write(banner);

  // 启动前先把两个端口都检查一遍。
  // 这样报错能同时说清是哪个端口冲突、该换哪个端口，
  // 而不是等 listen 抛一个光秃秃的 EADDRINUSE。
  const uiPortWanted = ARGS.ui ? ARGS.port + 1 : null;
  const conflicts = [];
  if (await portInUse(ARGS.port, ARGS.host)) conflicts.push({ port: ARGS.port, role: '代理' });
  if (uiPortWanted && await portInUse(uiPortWanted, ARGS.host)) conflicts.push({ port: uiPortWanted, role: '界面' });

  if (conflicts.length) {
    const list = conflicts.map((c) => `${c.port}（${c.role}）`).join('、');
    log('error', `端口已被占用：${list}`);
    console.log('');
    console.log(`  ${C.y}可能是加速器已经在运行了。${C.r}先试试直接打开界面：`);
    console.log(`     ${C.b}${C.cyan}http://${ARGS.host}:${uiPortWanted || ARGS.port}${C.reset}`);
    console.log('');
    console.log(`  要另起一个实例，就换一对端口：`);
    console.log(`     ${C.b}node server.js --port ${ARGS.port + 100}${C.reset}`);
    console.log('');
    process.exit(3);   // 3 = 端口冲突，方便启动器区分处理
  }

  // 先探一下本机 IPv6，给出明确结论（很多"加速无效"其实是本机没 v6）
  const reach = await ipv6Reachable();
  if (reach.ok) log('ok', `本机 IPv6 可用，出口延迟约 ${reach.latency} ms`);
  else log('warn', '本机 IPv6 不可用：加速将退化为 IPv4 优选（功能仍可用，但没有 v6 红利）');

  PROXY = new ProxyServer({
    router: ROUTER,
    host: ARGS.host,
    port: ARGS.port,
    log,
    localAddress: ARGS.local || undefined,
  });
  await PROXY.start();
  log('ok', `HTTP/HTTPS 代理已监听 ${C.bold}${PROXY.address}${C.reset}`);

  if (ARGS.socks5) {
    SOCKS = new Socks5Server({ router: ROUTER, host: ARGS.host, port: ARGS.socks5, log, localAddress: ARGS.local || undefined });
    await SOCKS.start();
    log('ok', `SOCKS5 已监听 ${C.bold}socks5://${ARGS.host}:${ARGS.socks5}${C.reset}`);
  }

  const ui = makeUiServer();
  let realUiPort = null;
  if (ARGS.ui) {
    // 界面和代理同端口会冲突，所以界面单独起一个端口
    realUiPort = ARGS.port + 1;
    await new Promise((resolve, reject) => {
      ui.once('error', reject);
      ui.listen(realUiPort, ARGS.host, resolve);
    });
    log('ok', `Web 界面  ${C.bold}${C.cyan}http://${ARGS.host}:${realUiPort}${C.reset}`);
  } else {
    ui.close();
  }

  const info = writePidFile();
  log('info', `已写入运行信息 ${PID_FILE}（pid=${info.pid}）`);

  console.log('');
  console.log(`${C.dim}  把浏览器/IDM/aria2 的代理设为：${PROXY.address}${C.reset}`);
  console.log(`${C.dim}  策略: ${ROUTER.policy}${ARGS.local ? '   出口: ' + ARGS.local : ''}${C.reset}`);
  console.log(`${C.dim}  按 Ctrl+C 退出${C.reset}`);
  console.log('');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\n正在退出…');
    removePidFile();
    try { await PROXY.stop(); } catch (_) {}
    try { if (SOCKS) await SOCKS.stop(); } catch (_) {}
    try { ui.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', removePidFile);
}

main().catch((e) => {
  removePidFile();
  if (e && e.code === 'EADDRINUSE') {
    log('error', `端口被占用（${e.port || ARGS.port}）。换一个端口：node server.js --port ${ARGS.port + 100}`);
    process.exit(3);
  } else {
    log('error', e.stack || e.message);
    console.log(`\n  ${C.d}如果看不懂这个错误，把上面几行发出来即可。${C.reset}\n`);
  }
  process.exit(1);
});
