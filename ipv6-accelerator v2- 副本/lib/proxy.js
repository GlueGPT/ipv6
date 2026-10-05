'use strict';
/**
 * proxy.js —— 本地 HTTP/HTTPS 代理（可选 SOCKS5 半隧道）
 *
 * 这是通用性的关键：只要把浏览器 / IDM / aria2 / 游戏客户端的代理指向它，
 * 一切流量就走优选后的 IP，**不需要改 hosts，也不需要管理员权限**。
 *
 * 三种用法：
 *   1. HTTP 代理       —— 普通 http:// 请求，代理自己转发
 *   2. HTTPS 隧道      —— CONNECT 方法，双向透传，TLS 由客户端自己做
 *   3. SOCKS5 半隧道   —— 早期版本只做"先把域名解析成优选 IP"，主要用于游戏客户端
 */

const net = require('net');
const http = require('http');
const { connectTo } = require('./connect');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

class Stats {
  constructor() {
    this.startedAt = Date.now();
    this.requests = 0;
    this.tunnels = 0;
    this.socks5 = 0;
    this.errors = 0;
    this.bytesUp = 0;
    this.bytesDown = 0;
    this.byIp = new Map();      // ip -> { count, bytesDown, family, host }
    this.recent = [];           // 最近若干条连接记录
    this.active = new Set();
  }

  noteIp(ip, hostname, extra = {}) {
    let e = this.byIp.get(ip);
    if (!e) { e = { ip, family: net.isIP(ip), count: 0, bytesDown: 0, host: hostname }; this.byIp.set(ip, e); }
    e.count++;
    e.host = hostname;
    Object.assign(e, extra);
    return e;
  }

  addBytesDown(ip, n) {
    this.bytesDown += n;
    if (ip) { const e = this.byIp.get(ip); if (e) e.bytesDown += n; }
  }

  addBytesUp(n) { this.bytesUp += n; }

  push(entry) {
    this.recent.unshift(entry);
    if (this.recent.length > 200) this.recent.pop();
  }

  snapshot() {
    const byIp = Array.from(this.byIp.values())
      .sort((a, b) => b.bytesDown - a.bytesDown)
      .slice(0, 50);
    let v4 = 0, v6 = 0;
    for (const e of this.byIp.values()) { if (e.family === 6) v6 += e.count; else if (e.family === 4) v4 += e.count; }
    return {
      uptime: Date.now() - this.startedAt,
      requests: this.requests,
      tunnels: this.tunnels,
      socks5: this.socks5,
      errors: this.errors,
      active: this.active.size,
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown,
      connV4: v4,
      connV6: v6,
      byIp: byIp.map((e) => ({ ...e, kbps: null })),
      recent: this.recent.slice(0, 60),
    };
  }
}

class ProxyServer {
  constructor({ router, host = '127.0.0.1', port = 8899, log = () => {}, rejectUnauthorized = false, tunnelTimeout = 0, localAddress } = {}) {
    this.router = router;
    this.host = host;
    this.port = port;
    this.log = log;
    this.rejectUnauthorized = rejectUnauthorized;
    this.tunnelTimeout = tunnelTimeout;
    this.localAddress = localAddress;
    this.stats = new Stats();
    this.server = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this._onRequest(req, res));
    this.server.on('connect', (req, socket, head) => this._onConnect(req, socket, head));
    this.server.on('clientError', (err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
    });
    // 允许 upgrades（WebSocket 走普通代理时会用到）
    this.server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    return this;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  get address() { return `http://${this.host}:${this.port}`; }

  // -------------------------------------------------------------------------
  // HTTP 请求转发
  // -------------------------------------------------------------------------
  async _onRequest(req, res) {
    this.stats.requests++;
    let target;
    try {
      target = new URL(req.url);
    } catch (_) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('本代理只接受绝对 URL 形式的请求（请把浏览器代理指向本端口）。\n');
    }

    const hostname = target.hostname;
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const isTls = target.protocol === 'https:';
    const t0 = Date.now();

    try {
      const { socket, ip } = await connectTo(hostname, port, {
        router: this.router,
        isTls: false,               // 客户端与代理之间是明文，代理自己去和源站做 TLS
        localAddress: this.localAddress,
        raceLimit: 4,
      });

      const entry = this.stats.noteIp(ip, hostname);
      this.stats.active.add(socket);
      socket.once('close', () => this.stats.active.delete(socket));

      if (isTls) {
        const tls = await require('./connect').upgradeTls(socket, hostname, {
          alpn: ['http/1.1'],
          rejectUnauthorized: this.rejectUnauthorized,
        });
        this._relayHttp(req, res, tls, ip, hostname, Date.now() - t0);
      } else {
        this._relayHttp(req, res, socket, ip, hostname, Date.now() - t0);
      }
      if (entry) entry.lastLatency = Date.now() - t0;
    } catch (e) {
      this.stats.errors++;
      this.log('warn', `请求失败 ${hostname}:${port} → ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`优选连接失败: ${e.message}\n`);
      } else {
        try { res.destroy(); } catch (_) {}
      }
    }
  }

  /** 把已建立的上游 socket 当作"裸 HTTP 连接"用，手工写请求行 */
  _relayHttp(clientReq, clientRes, upstream, ip, hostname, connectMs) {
    const path = (() => {
      try { const u = new URL(clientReq.url); return u.pathname + u.search; } catch (_) { return clientReq.url; }
    })();

    const headers = {};
    for (const [k, v] of Object.entries(clientReq.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    // 代理可能改了端口，确保 Host 正确
    if (!headers.host) headers.host = hostname;

    const lines = [`${clientReq.method} ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
      else lines.push(`${k}: ${v}`);
    }
    lines.push('Connection: close', '', '');
    upstream.write(lines.join('\r\n'));

    this.stats.push({ t: Date.now(), kind: 'http', host: hostname, ip, family: net.isIP(ip), connectMs });
    this.stats.requests++;

    // 请求体转发
    let upBytes = 0;
    clientReq.on('data', (c) => { upBytes += c.length; upstream.write(c); });
    clientReq.on('end', () => { this.stats.addBytesUp(upBytes); upstream.end(); });
    clientReq.on('error', () => { try { upstream.destroy(); } catch (_) {} });

    // 响应透传
    let downBytes = 0;
    upstream.on('data', (c) => { downBytes += c.length; if (!clientRes.writableEnded) clientRes.write(c); });
    upstream.on('end', () => {
      this.stats.addBytesDown(ip, downBytes);
      if (!clientRes.writableEnded) clientRes.end();
    });
    upstream.on('error', (e) => {
      this.stats.errors++;
      this.log('warn', `上游断开 ${hostname}: ${e.message}`);
      this.stats.addBytesDown(ip, downBytes);
      try { clientRes.destroy(); } catch (_) {}
    });
    clientRes.on('close', () => { try { upstream.destroy(); } catch (_) {} });
  }

  // -------------------------------------------------------------------------
  // HTTPS CONNECT 隧道
  // -------------------------------------------------------------------------
  async _onConnect(req, clientSocket, head) {
    this.stats.tunnels++;
    const [hostname, portStr] = splitHostPort(req.url);
    const port = Number(portStr || 443);
    const t0 = Date.now();

    if (!hostname) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    // 本地自环保护：别把自己代理进去
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    try {
      const tDial = Date.now();
      const { socket: upstream, ip } = await connectTo(hostname, port, {
        router: this.router,
        isTls: false,
        localAddress: this.localAddress,
        raceLimit: 4,
        timeout: 9000,
      });

      const connectMs = Date.now() - t0;
      const dialMs = Date.now() - tDial;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);

      const hostRec = this.router && this.router.records.get(hostname);
      const entry = this.stats.noteIp(ip, hostname);
      this.stats.push({
        t: Date.now(), kind: 'connect', host: hostname, port, ip, family: net.isIP(ip),
        connectMs, dialMs,
        lookupMs: Math.max(0, connectMs - dialMs),
        speedDone: hostRec ? !!hostRec.speedDone : null,
      });
      this._pipe(clientSocket, upstream, ip, hostname);
    } catch (e) {
      this.stats.errors++;
      this.log('warn', `CONNECT 失败 ${hostname}:${port} → ${e.message}`);
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) {}
    }
  }

  // WebSocket / HTTP Upgrade 走普通代理
  async _onUpgrade(req, clientSocket, head) {
    let target;
    try { target = new URL(req.url); } catch (_) { return clientSocket.destroy(); }
    const port = Number(target.port || (target.protocol === 'wss:' ? 443 : 80));
    try {
      const { socket, ip } = await connectTo(target.hostname, port, {
        router: this.router, localAddress: this.localAddress, raceLimit: 3,
      });
      const sock = target.protocol === 'wss:'
        ? await require('./connect').upgradeTls(socket, target.hostname, { alpn: ['http/1.1'], rejectUnauthorized: this.rejectUnauthorized })
        : socket;

      this.stats.noteIp(ip, target.hostname);
      this.stats.push({ t: Date.now(), kind: 'upgrade', host: target.hostname, port, ip, family: net.isIP(ip), connectMs: 0 });

      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        lines.push(`${k}: ${Array.isArray(v) ? v.join(',') : v}`);
      }
      lines.push('', '');
      sock.write(lines.join('\r\n'));
      if (head && head.length) sock.write(head);
      this._pipe(clientSocket, sock, ip, target.hostname);
    } catch (e) {
      this.stats.errors++;
      try { clientSocket.destroy(); } catch (_) {}
    }
  }

  /** 双向透传 + 字节统计 */
  _pipe(client, upstream, ip, hostname) {
    let down = 0, up = 0;
    this.stats.active.add(upstream);
    this.stats.active.add(client);

    client.on('data', (c) => { up += c.length; if (!upstream.destroyed) upstream.write(c); });
    upstream.on('data', (c) => { down += c.length; if (!client.destroyed) client.write(c); });

    const teardown = () => {
      this.stats.addBytesUp(up);
      this.stats.addBytesDown(ip, down);
      this.stats.active.delete(upstream);
      this.stats.active.delete(client);
      try { client.destroy(); } catch (_) {}
      try { upstream.destroy(); } catch (_) {}
    };

    client.on('error', teardown);
    upstream.on('error', teardown);
    client.on('close', teardown);
    upstream.on('close', teardown);

    client.on('end', () => { if (!upstream.destroyed) upstream.end(); });
    upstream.on('end', () => { if (!client.destroyed) client.end(); });
  }
}

function splitHostPort(s) {
  if (!s) return [null, null];
  if (s.startsWith('[')) {
    const i = s.indexOf(']');
    return [s.slice(1, i), s.slice(i + 2)];
  }
  const i = s.lastIndexOf(':');
  if (i === -1) return [s, null];
  return [s.slice(0, i), s.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// 可选的 SOCKS5 服务（只做优选解析，不做完整 SOCKS5 代理）
// 用途：某些游戏客户端只认 SOCKS5，或需要单独指向一个端口
// ---------------------------------------------------------------------------

class Socks5Server {
  constructor({ router, host = '127.0.0.1', port = 1088, log = () => {}, localAddress } = {}) {
    this.router = router;
    this.host = host;
    this.port = port;
    this.log = log;
    this.localAddress = localAddress;
    this.stats = new Stats();
    this.server = null;
  }

  async start() {
    this.server = net.createServer((sock) => this._onConn(sock));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    return this;
  }

  async stop() {
    if (this.server) await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  async _onConn(sock) {
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (stage === 0) {
          if (buf.length < 2) return;
          const nmethods = buf[1];
          if (buf.length < 2 + nmethods) return;
          buf = buf.subarray(2 + nmethods);
          sock.write(Buffer.from([0x05, 0x00])); // 无需认证
          stage = 1;
        }
        if (stage === 1) {
          if (buf.length < 4) return;
          const atyp = buf[3];
          let host, need;
          if (atyp === 0x01) { need = 4 + 4 + 2; if (buf.length < need) return; host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; }
          else if (atyp === 0x03) { const l = buf[4]; need = 5 + l + 2; if (buf.length < need) return; host = buf.subarray(5, 5 + l).toString('latin1'); }
          else if (atyp === 0x04) { need = 4 + 16 + 2; if (buf.length < need) return; host = []; for (let i = 0; i < 8; i++) host.push(buf.readUInt16BE(4 + i * 2).toString(16)); host = host.join(':'); }
          else return sock.destroy();

          const port = buf.readUInt16BE(need - 2);
          sock.removeListener('data', onData);

          const ips = this.router ? await this.router.raceOrderFor(host, { url: `https://${host}/`, doSpeed: false }) : [host];
          this.stats.noteIp(ips && ips[0] ? ips[0] : host, host);
          this.stats.socks5++;
          this.stats.push({ t: Date.now(), kind: 'socks5', host, port, ip: ips && ips[0], family: net.isIP(ips && ips[0] || ''), connectMs: 0 });

          const net2 = require('net');
          const up = net2.connect({ host: ips && ips.length ? ips[0] : host, port, localAddress: this.localAddress });
          up.once('connect', () => {
            const rep = Buffer.alloc(10);
            rep.writeUInt8(0x05, 0); rep.writeUInt8(0x00, 1); rep.writeUInt8(0x00, 2);
            rep.writeUInt8(0x01, 3); sock.write(rep);
            if (buf.length > need) up.write(buf.subarray(need));
            this._pipe(sock, up, ips && ips[0], host);
          });
          up.once('error', () => {
            const rep = Buffer.alloc(10);
            rep.writeUInt8(0x05, 0); rep.writeUInt8(0x05, 1); rep.writeUInt8(0x00, 2);
            rep.writeUInt8(0x01, 3); sock.write(rep); sock.destroy();
          });
          stage = 2;
        }
      } catch (e) {
        this.log('warn', `socks5 解析失败: ${e.message}`);
        sock.destroy();
      }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  }

  _pipe(client, upstream, ip, hostname) {
    let down = 0, up = 0;
    client.on('data', (c) => { up += c.length; if (!upstream.destroyed) upstream.write(c); });
    upstream.on('data', (c) => { down += c.length; if (!client.destroyed) client.write(c); });
    const teardown = () => {
      this.stats.addBytesUp(up); this.stats.addBytesDown(ip, down);
      try { client.destroy(); } catch (_) {}
      try { upstream.destroy(); } catch (_) {}
    };
    client.on('error', teardown); upstream.on('error', teardown);
    client.on('close', teardown); upstream.on('close', teardown);
  }
}

module.exports = { ProxyServer, Socks5Server, Stats, splitHostPort };
