'use strict';
/**
 * route.js —— 优选排序与策略路由
 *
 * 把 probe.js 测出来的原始数据变成"用哪个 IP"的决策。
 * 同时维护一张运行时路由表：代理每收到一个请求，先查表，查不到就实时解析 + 快速探测。
 */

const net = require('net');
const probe = require('./probe');

/** 上游 IP 策略 */
const POLICY = {
  AUTO: 'auto',       // 按实测吞吐/延迟自动挑最优（IPv6 与 IPv4 同台竞争）
  PREFER_V6: 'v6',    // 只在 IPv6 里挑最优
  PREFER_V4: 'v4',    // 只在 IPv4 里挑最优
  BALANCE: 'balance', // 双栈分流：让 v6 和 v4 各承担一部分连接
};

/**
 * 给候选结果打分。
 * 权重设计：吞吐是第一位的（下载加速的本质），延迟用于吞吐缺失时兜底。
 */
function score(row) {
  const kbps = row.kbps || 0;
  const latency = row.latency == null ? 5000 : row.latency;
  // 吞吐 1Mbps ≈ 128KB/s(kbps=128) 记 1 分；延迟每 10ms 扣 0.02 分
  return kbps / 128 - latency / 500;
}

/**
 * 对探测结果排序。可用的排前面；同可用度下按分数降序。
 */
function rank(rows, opts = {}) {
  const { policy = POLICY.AUTO, blocked = new Set(), preferFamilyFirst = true } = opts;

  let pool = rows.slice();

  // 拉黑过滤
  if (blocked && blocked.size) pool = pool.filter((r) => !blocked.has(r.ip));

  // 策略过滤
  if (policy === POLICY.PREFER_V6) {
    const only6 = pool.filter((r) => r.family === 6);
    if (only6.length) pool = only6;
  } else if (policy === POLICY.PREFER_V4) {
    const only4 = pool.filter((r) => r.family === 4);
    if (only4.length) pool = only4;
  }

  pool = pool.map((r) => ({ ...r, score: Number(score(r).toFixed(3)) }));

  pool.sort((a, b) => {
    // 1) 能连通的优先
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    // 2) 有吞吐数据的优先
    const aHasSpeed = a.kbps != null ? 1 : 0;
    const bHasSpeed = b.kbps != null ? 1 : 0;
    if (aHasSpeed !== bHasSpeed) return bHasSpeed - aHasSpeed;
    // 3) 综合分数
    if (a.score !== b.score) return b.score - a.score;
    // 4) 同分时，IPv6 优先（校园网/教育网 v6 通常更空）
    if (preferFamilyFirst && a.family !== b.family) return a.family === 6 ? -1 : 1;
    // 5) 最后看延迟
    return (a.latency || 9999) - (b.latency || 9999);
  });

  return pool;
}

/**
 * 把排序结果压缩成"连接竞速顺序"：只取前 N 个可用 IP。
 * 竞速时同时尝试多个，谁先连上就用谁，所以不需要严格排序，但顺序仍有意义（错峰发起）。
 */
function toRaceOrder(rows, { limit = 4 } = {}) {
  return rows.filter((r) => r.ok).slice(0, limit).map((r) => r.ip);
}

// ---------------------------------------------------------------------------
// 运行时路由表
// ---------------------------------------------------------------------------

class RouteTable {
  constructor(opts = {}) {
    this.policy = opts.policy || POLICY.AUTO;
    this.ttl = opts.ttl || 5 * 60 * 1000;      // 路由缓存有效期
    this.minProbeInterval = opts.minProbeInterval || 30 * 1000;
    this.entryMaxAge = opts.entryMaxAge || 10 * 60 * 1000;
    this.maxEntries = opts.maxEntries || 2000;
    this.records = new Map();                   // hostname -> record
    this.blocked = new Set();                   // 用户手动拉黑的 IP
    this.originPool = [];                       // 用户手工补充的 IP 池
    this.localAddress = opts.localAddress;
    this.pending = new Map();                   // hostname -> Promise（去重并发探测）
    this.refining = new Set();                  // 正在后台做吞吐测速的域名
  }

  setPolicy(p) { this.policy = p; }

  setOriginPool(list) {
    this.originPool = (list || []).map((s) => String(s).trim()).filter(Boolean);
    this.clear();
  }

  setLocalAddress(addr) {
    this.localAddress = addr || undefined;
    this.clear();
  }

  clear() { this.records.clear(); }

  block(ip) { this.blocked.add(ip); this.clear(); }
  unblock(ip) { this.blocked.delete(ip); }
  isBlocked(ip) { return this.blocked.has(ip); }

  /** 记录一次连接结果，用于失败退避 */
  reportFailure(ip) {
    for (const rec of this.records.values()) {
      if (rec.raceOrder && rec.raceOrder.includes(ip)) {
        rec.failCount = (rec.failCount || 0) + 1;
        // 连续失败 3 次就从竞速顺序里摘掉
        if (rec.failCount >= 3) {
          rec.raceOrder = rec.raceOrder.filter((x) => x !== ip);
        }
      }
    }
  }

  reportSuccess(ip) {
    for (const rec of this.records.values()) {
      if (rec.rows && rec.rows.some((r) => r.ip === ip)) rec.failCount = 0;
    }
  }

  /**
   * 查询一个主机的竞速 IP 列表。
   *
   * 两阶段设计（这是首包延迟的关键）：
   *   阶段一 — 只做 TCP 延迟探测，几十毫秒内就能拿到结果，立刻放行请求；
   *   阶段二 — 后台跑真实吞吐测速，完成后就地更新排序。
   *
   * 这样首次访问的 TTFB 是"几十毫秒级"而不是"一秒级"，
   * 而"按吞吐优选"的能力会在后续请求上体现出来。
   *
   * @param {string} hostname
   * @param {object} opts { url, doSpeed, refine, force }
   */
  async lookup(hostname, opts = {}) {
    const now = Date.now();
    const hit = this.records.get(hostname);
    if (!opts.force && hit && now - hit.at < this.ttl && hit.raceOrder && hit.raceOrder.length) {
      hit.hits = (hit.hits || 0) + 1;
      return hit;
    }

    // 同一个域名的并发请求合并成一次探测
    if (this.pending.has(hostname)) return this.pending.get(hostname);

    const refine = opts.refine !== false;

    const job = (async () => {
      const target = opts.url || hostname;
      const cands = await probe.buildCandidates(target, { originPool: this.originPool });

      // —— 阶段一：只测延迟，快速决策（只探实际要连的那个端口） ——
      const fastRows = await probe.probeAll(cands, {
        doSpeed: false,
        concurrency: 16,
        localAddress: this.localAddress,
      });

      const fastRanked = rank(fastRows, { policy: this.policy, blocked: this.blocked });
      const rec = {
        hostname,
        at: Date.now(),
        family: cands.family,
        port: cands.port,
        rows: fastRanked,
        raceOrder: toRaceOrder(fastRanked, { limit: 4 }),
        primary: null,
        hits: 0,
        failCount: 0,
        speedDone: false,
      };
      rec.primary = rec.raceOrder[0] || null;
      this.records.set(hostname, rec);
      this._evict(now);

      // —— 阶段二：后台按真实吞吐重新排序，不阻塞当前请求 ——
      if (refine && opts.doSpeed !== false) {
        this._refine(hostname, cands, fastRows).catch(() => {});
      }

      return rec;
    })().finally(() => this.pending.delete(hostname));

    this.pending.set(hostname, job);
    return job;
  }

  /** 后台吞吐测速并就地更新排序（失败静默，不影响已经可用的路由） */
  async _refine(hostname, cands, fastRows) {
    if (this.refining.has(hostname)) return;
    this.refining.add(hostname);
    try {
      // 只为"延迟探测通过"的 IP 测吞吐，省掉对不可达 IP 的无谓等待
      const alive = fastRows.filter((r) => r.ok);
      if (!alive.length) return;

      const limit = probe.createLimiter(6);
      const measured = await Promise.all(alive.map((row) => limit(async () => {
        const s = await probe.probeThroughput(cands.url.toString(), row.ip, {
          localAddress: this.localAddress,
        });
        return {
          ...row,
          ttfb: s.ttfb,
          bytes: s.bytes || 0,
          code: s.code || null,
          reliable: !!s.reliable,
          speedKbps: s.kbps != null ? Math.round(s.kbps) : null,
          kbps: s.ok && s.reliable ? Math.round(s.kbps) : null,
          speedError: s.ok ? null : s.error,
        };
      })));

      // 目标可能已经被新的探测替换掉了，避免覆盖更新的结果
      const cur = this.records.get(hostname);
      if (!cur || cur.speedDone) return;

      const reranked = rank(measured, { policy: this.policy, blocked: this.blocked });
      cur.rows = reranked;
      cur.raceOrder = toRaceOrder(reranked, { limit: 4 });
      cur.primary = cur.raceOrder[0] || cur.primary;
      cur.speedDone = true;
      cur.speedAt = Date.now();
    } finally {
      this.refining.delete(hostname);
    }
  }

  /**
   * 代理热路径用：只拿竞速顺序，尽量不阻塞。
   * 完全没有缓存时给一个"三选一"兜底：系统解析出的第一个 v6 + 第一个 v4。
   *
   * @param {string} hostname
   * @param {object} opts { url, port, doSpeed, refine, force }
   */
  async raceOrderFor(hostname, opts = {}) {
    const rec = await this.lookup(hostname, opts);
    if (rec.raceOrder.length) return rec.raceOrder;

    // 全部探测失败（可能在探测阶段被限流）→ 退化为普通解析
    const fallback = [];
    const f = rec.family || {};
    if (this.policy !== POLICY.PREFER_V4 && f.v6 && f.v6.length) fallback.push(f.v6[0]);
    if (this.policy !== POLICY.PREFER_V6 && f.v4 && f.v4.length) fallback.push(f.v4[0]);
    return fallback;
  }

  snapshot() {
    const out = [];
    for (const rec of this.records.values()) {
      out.push({
        hostname: rec.hostname,
        at: rec.at,
        age: Date.now() - rec.at,
        hits: rec.hits || 0,
        primary: rec.primary,
        raceOrder: rec.raceOrder,
        failCount: rec.failCount || 0,
        speedDone: !!rec.speedDone,
        best: rec.rows && rec.rows[0] ? {
          ip: rec.rows[0].ip, family: rec.rows[0].family,
          latency: rec.rows[0].latency, kbps: rec.rows[0].kbps,
        } : null,
        count: rec.rows ? rec.rows.length : 0,
      });
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  _evict(now) {
    if (this.records.size <= this.maxEntries) return;
    // 按最后访问时间淘汰最旧的
    const arr = Array.from(this.records.entries()).sort((a, b) => a[1].at - b[1].at);
    const drop = this.records.size - this.maxEntries;
    for (let i = 0; i < drop; i++) this.records.delete(arr[i][0]);
  }
}

module.exports = { POLICY, score, rank, toRaceOrder, RouteTable };
