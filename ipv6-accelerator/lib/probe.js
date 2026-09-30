'use strict';
/**
 * probe.js —— 地址解析 + 连通性/延迟/吞吐量探测
 *
 * 这是整个工具的"眼睛"：负责把一个域名展开成一组候选 IP（IPv4 + IPv6），
 * 然后对每个候选 IP 实测 TCP 握手延迟和真实 HTTP 下载吞吐。
 *
 * 设计要点：
 *  1. 延迟低 ≠ 速度快。所以除了 TCP 握手，还要发一个带 Range 的 GET 实测吞吐。
 *  2. 所有探测必须绑定到"指定 IP"，绕开系统解析器，否则测不出单个 IP 的好坏。
 *  3. 解析走系统 DNS（校园网/运营商 DNS 对国内域名最准），DoH 只作为补充。
 */

const dns = require('dns');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });

// ---------------------------------------------------------------------------
// 1. DNS 解析
// ---------------------------------------------------------------------------

/**
 * 解析单个域名，返回 { v4: [], v6: [] }。
 * 系统解析器对国内 CDN 最准确，所以主用系统 DNS，失败时再尝试公共 DNS。
 */
async function resolveHost(hostname, opts = {}) {
  const out = { v4: [], v6: [], sources: {} };
  if (!hostname) return out;

  // 如果本身就是个 IP 字面量，直接返回
  const lit = net.isIP(hostname);
  if (lit === 4) { out.v4 = [hostname]; out.sources.v4 = 'literal'; return out; }
  if (lit === 6) { out.v6 = [hostname]; out.sources.v6 = 'literal'; return out; }

  const servers = opts.dnsServers || null;

  const query = async (type) => {
    // 先用系统默认解析器
    try {
      const r = await dns.promises.lookup(hostname, { all: true, family: type === 'AAAA' ? 6 : 4 });
      const list = r.map((x) => x.address).filter((a) => net.isIP(a) === (type === 'AAAA' ? 6 : 4));
      if (list.length) return { list, via: 'system' };
    } catch (_) { /* 落到下面的备用解析 */ }

    // 系统解析器失败时，用指定/公共 DNS 重试
    try {
      const r = await resolver.resolve4(hostname).catch(() => []);
      if (type === 'A' && r.length) return { list: r, via: 'dns4' };
    } catch (_) {}
    try {
      const r = await resolver.resolve6(hostname).catch(() => []);
      if (type === 'AAAA' && r.length) return { list: r, via: 'dns6' };
    } catch (_) {}

    return { list: [], via: null };
  };

  const [a, aaaa] = await Promise.all([query('A'), query('AAAA')]);
  out.v4 = uniq(a.list);
  out.v6 = uniq(aaaa.list);
  out.sources.v4 = a.via;
  out.sources.v6 = aaaa.via;
  if (servers) out.dnsServers = servers;
  return out;
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

// ---------------------------------------------------------------------------
// 2. 并发闸门（避免一次性打爆几百个连接，触发 CDN 的风控）
// ---------------------------------------------------------------------------

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// ---------------------------------------------------------------------------
// 3. 通用连接辅助
// ---------------------------------------------------------------------------

/** 在指定超时内把 socket 连到 host:port，成功返回 socket */
function tcpConnect(host, port, { timeout = 600, localAddress = undefined, family } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, localAddress };
    if (family) opts.family = family;
    const sock = net.connect(opts);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    sock.setTimeout(timeout, () => fail(new Error('tcp-timeout')));
    sock.once('error', fail);
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.removeListener('error', fail);
      resolve(sock);
    });
  });
}

// ---------------------------------------------------------------------------
// 4. TCP 握手延迟探测
// ---------------------------------------------------------------------------

/**
 * 对单个 IP 做 TCP 握手测延迟。
 * 返回 { ok, latency, port } 或 { ok:false, error }
 */
async function probeTcp(ip, ports, { timeout = 800, localAddress = undefined } = {}) {
  const errors = [];
  for (const port of ports) {
    const t0 = process.hrtime.bigint();
    try {
      const sock = await tcpConnect(ip, port, { timeout, localAddress });
      const latency = Number(process.hrtime.bigint() - t0) / 1e6;
      sock.destroy();
      return { ok: true, latency, port };
    } catch (e) {
      errors.push(`${port}:${e.message}`);
      // 连接被明确拒绝 → 这个 IP 活着但端口不通，继续试下一个端口
    }
  }
  return { ok: false, error: errors.join('|') || 'unreachable' };
}

/** 并发探测多个端口，取最快的一个（比逐个串行试快很多） */
async function probeTcpParallel(ip, ports, opts = {}) {
  const results = await Promise.all(ports.map((p) => probeTcp(ip, [p], opts).then((r) => ({ ...r, port: p }))));
  const good = results.filter((r) => r.ok);
  if (!good.length) return { ok: false, error: results.map((r) => r.error).join('|') };
  good.sort((a, b) => a.latency - b.latency);
  return good[0];
}

// ---------------------------------------------------------------------------
// 5. HTTP 吞吐量实测
// ---------------------------------------------------------------------------

/**
 * 强制把请求解析到指定 IP（绕开系统解析器），这是能测出"单个 IP 好坏"的关键。
 * 注意：连接用 IP，但 SNI / Host / servername 仍然是域名，否则 CDN 会返回错误的证书或内容。
 */
function makeLookup(ip) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};
    const family = net.isIP(ip);
    if (opts.all) return cb(null, [{ address: ip, family }]);
    return cb(null, ip, family);
  };
}

/**
 * 对一个 IP 实测下载吞吐。
 *
 * 两个必须处理的坑：
 *
 * 坑 1：速度只能在**首字节到达之后**开始计时。
 *   如果把 TLS 握手 / TTFB 也算进分母，小响应（403 报错页只有 19KB）
 *   会算出一个毫无意义的速度值，把优选结果带偏。
 *
 * 坑 2：传输窗口太短，测到的不是链路速度，而是内核 socket 缓冲速度。
 *   千兆校园网镜像上 4MB 只要 40ms 就下完，此时数据主要来自缓冲区，读数虚高。
 *
 * 所以这里做**基于时间预算的两段式自适应**：
 *   - 先用小样本（probeBytes）快速跑一遍，控制在 probeMs 上下；
 *   - 如果传输窗口短于 minTransferMs（说明链路很快、读数不可靠），
 *     就把样本放大 maxSampleScale 倍重测一次；
 *   - maxBytes 是硬上限：慢链路上宁可读数不精确，也不能为了测速下掉几十 MB。
 *
 * @param {string} url
 * @param {string} ip
 * @param {object} opts
 *   probeBytes      首轮样本大小，默认 4MB
 *   probeMs         首轮期望耗时，用于估算放大倍数，默认 250ms
 *   maxBytes        硬上限，默认 64MB
 *   maxSampleScale  最大放大倍数，默认 16
 *   minTransferMs   低于此传输时长认为读数不可信，默认 120ms
 *   timeout         单次超时
 */
async function probeThroughput(url, ip, opts = {}) {
  const {
    probeBytes = 4 * 1024 * 1024,
    probeMs = 250,
    maxBytes = 64 * 1024 * 1024,
    maxSampleScale = 16,
    minTransferMs = 120,
    minBytes = 512 * 1024,
    timeout = 12000,
    localAddress = undefined,
  } = opts;

  let limit = Math.min(probeBytes, maxBytes);
  let best = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await once(url, ip, { byteLimit: limit, minBytes, timeout, localAddress });

    if (!r.ok) return r;

    // 传输窗口已经够长，或者样本已经到顶 → 就用这个结果
    const windowOk = r.transferMs != null && r.transferMs >= minTransferMs;
    if (windowOk || limit >= maxBytes) {
      return r;
    }

    // 还没到窗口下限：按实测速度推断要下多少字节才能跑满 probeMs，并留出放大余量
    best = r;
    const measured = r.transferMs > 0 ? r.bytes / r.transferMs : 0; // bytes per ms
    let next;
    if (measured > 0) {
      // 目标时长取 probeMs 的 2 倍，避免刚好卡在边界上
      next = Math.ceil(measured * probeMs * 2);
    } else {
      next = limit * 4;
    }
    // 至少放大 2 倍，最多 maxSampleScale 倍，且不超过硬上限
    next = Math.max(limit * 2, Math.min(next, limit * maxSampleScale, maxBytes));
    if (next <= limit) break;
    limit = next;
  }

  return best;
}

/** 单次吞吐测量 */
function once(url, ip, { byteLimit, minBytes, timeout, localAddress }) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad-url' }); }

    const isTls = target.protocol === 'https:';
    const mod = isTls ? https : http;
    const family = net.isIP(ip);
    const t0 = process.hrtime.bigint();
    let ttfb = null;
    let firstByteNs = null;
    let bytes = 0;
    let settled = false;
    const msSince = (ns) => Number(process.hrtime.bigint() - ns) / 1e6;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;

      let kbps = null;
      let transferMs = null;
      let reliable = false;

      if (bytes > 0 && firstByteNs != null) {
        transferMs = msSince(firstByteNs);
        // 传输阶段至少要跑够 20ms，否则计时精度不够，宁可不给结论
        if (transferMs >= 20) {
          kbps = (bytes / 1024) / (transferMs / 1000);
          reliable = bytes >= minBytes;
        }
      }

      resolve({
        ttfb: ttfb != null ? Number(ttfb.toFixed(1)) : null,
        transferMs: transferMs != null ? Number(transferMs.toFixed(1)) : null,
        ms: Number(msSince(t0).toFixed(1)),
        bytes,
        kbps: kbps != null ? Number(kbps.toFixed(1)) : null,
        reliable,
        byteLimit,
        ...extra,
      });
    };

    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isTls ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        Host: target.host,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPv6Accelerator/1.0',
        Accept: '*/*',
        Range: `bytes=0-${byteLimit - 1}`,
        'Accept-Encoding': 'identity',
      },
      lookup: makeLookup(ip),
      family,
      localAddress,
      servername: isTls ? target.hostname : undefined,
      // 探测阶段允许证书异常，我们只关心速度，不关心证书链
      rejectUnauthorized: false,
      timeout,
    }, (res) => {
      ttfb = msSince(t0);
      res.on('data', (chunk) => {
        if (firstByteNs === null) firstByteNs = process.hrtime.bigint();
        bytes += chunk.length;
        if (bytes >= byteLimit) {
          // 先让 finish 把首字节之后的时间算完，再断开
          finish({ ok: true, code: res.statusCode, truncated: true });
          req.destroy();
        }
      });
      res.on('end', () => finish({ ok: true, code: res.statusCode }));
      res.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    });

    req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 6. 目标标定：找出一个"真的能测出吞吐"的 URL
// ---------------------------------------------------------------------------

/**
 * 常见的镜像站大文件路径。
 * 只给域名时，直接测 https://域名/ 是没意义的 —— 根路径往往只返回几十 KB 的
 * 目录列表页，测出来的速度反映不了真实下载能力。所以先按这个列表标定。
 */
const CALIBRATION_PATHS = [
  '/ubuntu/ls-lR.gz',
  '/debian/ls-lR.gz',
  '/centos/ls-lR.gz',
  '/ubuntu/dists/noble/Release',
  '/debian/dists/stable/Release',
  '/anaconda/archive/Anaconda3-2024.10-1-Linux-x86_64.sh',
];

/**
 * 判断一个 URL 是否值得用来测吞吐：响应 200/206 且内容足够大。
 * 只看头部（Range 只取前 64KB），代价很小。
 */
async function calibrateUrl(url, ip, { minBytes = 128 * 1024, timeout = 5000 } = {}) {
  const r = await once(url, ip, { byteLimit: 64 * 1024, minBytes, timeout, localAddress: undefined });
  if (!r.ok) return null;
  const okCode = r.code === 200 || r.code === 206;
  if (!okCode) return null;
  // 拿到满 64KB 就说明这个路径有足够内容；否则看 Content-Length 已经体现在 bytes 上
  if (r.bytes < 32 * 1024) return null;
  return { url, code: r.code, bytes: r.bytes };
}

/**
 * 给一个目标挑出最适合测吞吐的 URL。
 * 如果用户给的是带路径的 URL，先试它本身；不理想再按常见镜像路径试。
 */
async function pickSpeedUrl(target, ip, opts = {}) {
  const { timeout = 5000 } = opts;
  const u = normalizeUrl(target);
  if (!u) return null;

  const tried = new Set();

  // 1) 用户给的路径本身就可用（比如直接给了 .gz / .iso 链接）
  if (u.pathname && u.pathname !== '/') {
    tried.add(u.pathname + u.search);
    const self = await calibrateUrl(u.toString(), ip, { timeout });
    if (self) return self.url;
  }

  // 2) 按常见镜像路径逐个标定，谁先成功用谁
  for (const p of CALIBRATION_PATHS) {
    if (tried.has(p)) continue;
    const candidate = `${u.protocol}//${u.host}${p}`;
    const r = await calibrateUrl(candidate, ip, { timeout });
    if (r) return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 7. 候选 IP 汇总
// ---------------------------------------------------------------------------

/**
 * 把一个目标（URL 或域名）展开成完整候选列表。
 * 额外支持用户手工提供的 IP（originPool），用于"CDN 优选"场景。
 */
async function buildCandidates(target, opts = {}) {
  const url = normalizeUrl(target);
  const hostname = url ? url.hostname : String(target).trim();

  const resolved = await resolveHost(hostname, opts);

  let v4 = resolved.v4.slice();
  let v6 = resolved.v6.slice();

  // 用户手工补充的 IP 池
  for (const raw of (opts.originPool || [])) {
    const ip = String(raw).trim();
    const t = net.isIP(ip);
    if (t === 4 && !v4.includes(ip)) v4.push(ip);
    if (t === 6 && !v6.includes(ip)) v6.push(ip);
  }

  // 如果目标是 IP 字面量，URL 里的 IP 就是候选
  if (!v4.length && !v6.length) {
    const t = net.isIP(hostname);
    if (t === 4) v4 = [hostname];
    if (t === 6) v6 = [hostname];
  }

  // 上下限保护
  const cap = opts.maxCandidates || 24;
  v4 = v4.slice(0, cap);
  v6 = v6.slice(0, cap);

  const port = url ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : 443;

  return { url, hostname, family: { v4, v6 }, port, sources: resolved.sources };
}

function normalizeUrl(target) {
  const s = String(target || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) { try { return new URL(s); } catch (_) { return null; } }
  if (/^[\w.\-:\[\]]+(\/\S*)?$/.test(s)) { try { return new URL('https://' + s); } catch (_) { return null; } }
  return null;
}

// ---------------------------------------------------------------------------
// 7. 完整探测流水线
// ---------------------------------------------------------------------------

/**
 * 对一组候选 IP 跑完整探测：TCP 延迟 → HTTP 吞吐。
 *
 * @returns {Array} 每个候选的结果，已按吞吐/延迟排序的原始数据
 */
/**
 * 对一组候选 IP 跑完整探测：TCP 延迟 → HTTP 吞吐。
 *
 * ports 默认只探目标实际使用的端口。
 * 早期版本会串行试 [443,80,8080,8443]，每个失败都要等满超时，
 * 冷启动时能把首包拖到将近一秒。而代理本来就知道要连哪个端口，
 * 去探其他端口既没有意义，又白白增加延迟。
 *
 * @returns {Array} 每个候选的结果
 */
async function probeAll(candidates, opts = {}) {
  const {
    tcpPorts = [candidates.port || 443],
    tcpTimeout = 900,
    doSpeed = true,
    speedByteLimit = 4 * 1024 * 1024,
    speedTimeout = 10000,
    concurrency = 16,
    localAddress = undefined,
    onProgress = null,
  } = opts;

  const items = [];
  for (const ip of candidates.family.v4) items.push({ ip, family: 4, kind: 'IPv4' });
  for (const ip of candidates.family.v6) items.push({ ip, family: 6, kind: 'IPv6' });

  const limit = createLimiter(Math.max(1, concurrency));
  let done = 0;

  // 标定：先找出一个真正能测吞吐的 URL。
  // 这一步只做一次，之后所有候选 IP 都用同一个 URL，结果才可比。
  // 直接用 http://域名/ 去测是错的 —— 根路径只有几十 KB 的列表页。
  let speedUrl = candidates.url ? candidates.url.toString() : null;
  let calibrated = null;

  if (doSpeed && speedUrl) {
    // 交替尝试 v6/v4 的前几个 IP：某个 IP 标定不到不代表别的 IP 也不行
    const v6 = candidates.family.v6, v4 = candidates.family.v4;
    const tryOrder = [];
    for (let i = 0; i < 3; i++) {
      if (v6[i]) tryOrder.push(v6[i]);
      if (v4[i]) tryOrder.push(v4[i]);
    }
    for (const ip of tryOrder) {
      calibrated = await pickSpeedUrl(speedUrl, ip, { timeout: Math.min(speedTimeout, 6000) });
      if (calibrated) { speedUrl = calibrated; break; }
    }
    if (!calibrated) speedUrl = null;  // 标定不出来就别给假数据
  }

  const results = await Promise.all(items.map((item) => limit(async () => {
    const t = await probeTcpParallel(item.ip, tcpPorts, { timeout: tcpTimeout, localAddress });
    const row = {
      ...item,
      ok: t.ok,
      latency: t.ok ? Math.round(t.latency * 10) / 10 : null,
      port: t.ok ? t.port : null,
      error: t.ok ? null : t.error,
      kbps: null,
      speedKbps: null,
      reliable: false,
      ttfb: null,
      code: null,
    };

    // TCP 都不通的 IP，不必再花时间测吞吐
    if (t.ok && doSpeed && speedUrl) {
      const s = await probeThroughput(speedUrl, item.ip, {
        byteLimit: speedByteLimit,
        timeout: speedTimeout,
        localAddress,
      });
      row.ttfb = s.ttfb;
      row.bytes = s.bytes || 0;
      row.code = s.code || null;
      row.reliable = !!s.reliable;

      if (s.ok) {
        // speedKbps 保留原始测量值，供界面展示
        row.speedKbps = s.kbps != null ? Math.round(s.kbps) : null;
        // 只有可信的测量才参与优选排序，避免被 403 报错页之类的小响应带偏
        row.kbps = s.reliable ? row.speedKbps : null;
      } else {
        row.speedError = s.error;
      }
    }

    done++;
    if (onProgress) onProgress(done, items.length, row);
    return row;
  })));

  // 把标定结果挂在返回值上，调用方可以展示"实际测速用的是哪个地址"
  results.speedUrl = speedUrl;
  results.calibrated = !!calibrated;
  return results;
}

module.exports = {
  resolveHost,
  buildCandidates,
  normalizeUrl,
  probeTcp,
  probeTcpParallel,
  probeThroughput,
  probeAll,
  calibrateUrl,
  pickSpeedUrl,
  CALIBRATION_PATHS,
  tcpConnect,
  createLimiter,
  makeLookup,
  uniq,
};
