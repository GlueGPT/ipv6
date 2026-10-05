'use strict';
/**
 * connect.js —— 连接竞速（Happy Eyeballs 的加强版）
 *
 * 传统 Happy Eyeballs 是"v6 先试，250ms 后 v4 跟上"。
 * 这里升级成"多候选竞速"：把优选出来的 N 个 IP 错峰发起，**谁先握手成功就用谁**，
 * 其余立刻销毁。这样即使某个优选 IP 临时抽风，也只会多花几十毫秒，不会卡住整个请求。
 */

const net = require('net');
const tls = require('tls');

/**
 * 竞速连接到一组候选 IP。
 *
 * @param {object} p
 *   ips: string[]              候选 IP，按优先级排列
 *   port: number
 *   stagger: number            逐个发起的间隔（ms）
 *   timeout: number            整体超时
 *   localAddress: string       绑定本地地址（校园网多网卡时有用）
 *   onWin: (ip) => void        获胜回调，用于统计
 *   onFail: (ip) => void       失败回调，用于退避
 * @returns {Promise<{socket, ip}>}
 */
function raceConnect({ ips, port, stagger = 90, timeout = 8000, localAddress, onWin, onFail }) {
  return new Promise((resolve, reject) => {
    if (!ips || !ips.length) return reject(new Error('no-candidate'));

    let settled = false;
    const sockets = new Set();
    let pending = ips.length;
    const errors = [];

    /**
     * 清理落败的连接。
     * winner 必须排除在外 —— 否则会把刚赢下来的 socket 一起销毁，
     * 之后 remoteAddress / TLS 升级全部失效。
     */
    const cleanup = (winner) => {
      for (const s of sockets) { if (s !== winner) { try { s.destroy(); } catch (_) {} } }
      sockets.clear();
      if (winner) sockets.add(winner);
      clearTimeout(overall);
      clearTimeout(schedule);
      clearInterval(schedule);
    };

    const overall = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup(null);
      reject(new Error('race-timeout: ' + errors.join(',')));
    }, timeout);
    overall.unref?.();

    const tryOne = (ip) => {
      if (settled) return;
      const family = net.isIP(ip);
      const sock = net.connect({ host: ip, port, family, localAddress });
      sockets.add(sock);

      const done = (err) => {
        if (settled) return;
        pending--;
        if (err) {
          try { sock.destroy(); } catch (_) {}
          sockets.delete(sock);
          errors.push(`${ip}:${err}`);
          if (onFail) onFail(ip);
          if (pending <= 0) {
            settled = true;
            cleanup(null);
            reject(new Error('all-failed: ' + errors.join(',')));
          }
        } else {
          settled = true;
          // 先把 remoteAddress 固定下来再清理，避免 socket 被销毁后读不到
          const remote = sock.remoteAddress;
          const remotePort = sock.remotePort;
          const local = sock.localAddress;
          cleanup(sock);
          if (onWin) onWin(ip);
          resolve({ socket: sock, ip, remoteAddress: remote, remotePort, localAddress: local });
        }
      };

      sock.setTimeout(timeout, () => done('timeout'));
      sock.once('error', (e) => done(e.code || e.message));
      sock.once('connect', () => {
        sock.setTimeout(0);
        done(null);
      });
    };

    // 错峰发起，避免同一瞬间向 CDN 打出 N 个连接（部分 CDN 会直接 RST）
    let idx = 0;
    const schedule = setInterval(() => {
      if (settled || idx >= ips.length) { clearInterval(schedule); return; }
      tryOne(ips[idx++]);
    }, stagger);
    schedule.unref?.();
    tryOne(ips[idx++]); // 第一个立即发起
  });
}

/**
 * 在竞速选出的 socket 上建立 TLS。
 * 关键：SNI 必须是原域名，证书校验也是按域名来的，否则 HTTPS 会失败。
 */
function upgradeTls(socket, hostname, { alpn = ['http/1.1'], rejectUnauthorized = false, timeout = 10000, servername } = {}) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({
      socket,
      servername: servername || hostname,
      ALPNProtocols: alpn,
      rejectUnauthorized,
    });
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; try { t.destroy(); } catch (_) {} reject(e); };
    t.setTimeout(timeout, () => fail(new Error('tls-timeout')));
    t.once('error', fail);
    t.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      t.setTimeout(0);
      resolve(t);
    });
  });
}

/**
 * 一站式：给一个域名/URL，返回一条已经连通（且可选完成 TLS）的 socket。
 * 这是代理转发路径上的核心函数。
 */
async function connectTo(hostname, port, {
  router,
  isTls = false,
  servername,
  localAddress,
  raceLimit = 4,
  stagger = 90,
  timeout = 8000,
  alpn = ['http/1.1'],
} = {}) {
  let ips;
  if (router) {
    ips = await router.raceOrderFor(hostname, {
      port,
      url: isTls ? `https://${hostname}${port === 443 ? '' : ':' + port}/` : `http://${hostname}${port === 80 ? '' : ':' + port}/`,
    });
  }
  if (!ips || !ips.length) {
    // 路由表完全没拿到地址 → 交给系统解析兜底
    ips = [hostname];
  }

  const onFail = router ? (ip) => router.reportFailure(ip) : undefined;
  const onWin = router ? (ip) => router.reportSuccess(ip) : undefined;

  const { socket, ip, remoteAddress, remotePort, localAddress: boundLocal } = await raceConnect({
    ips: ips.slice(0, raceLimit),
    port,
    stagger,
    timeout,
    localAddress,
    onWin,
    onFail,
  });

  const meta = { ip, remoteAddress, remotePort, localAddress: boundLocal };

  if (!isTls) return { socket, ...meta };

  try {
    const t = await upgradeTls(socket, hostname, { alpn, servername });
    return { socket: t, ...meta, tls: true, alpn: t.alpnProtocol };
  } catch (e) {
    // TLS 失败 → 换个 IP 再试一次（只有一次机会，避免拖慢）
    try { socket.destroy(); } catch (_) {}
    if (onFail) onFail(ip);
    const alternates = ips.slice(1, raceLimit);
    if (!alternates.length) throw e;
    const second = await raceConnect({
      ips: alternates, port, stagger, timeout, localAddress, onWin, onFail,
    });
    const t2 = await upgradeTls(second.socket, hostname, { alpn, servername });
    return {
      socket: t2,
      ip: second.ip,
      remoteAddress: second.remoteAddress,
      remotePort: second.remotePort,
      localAddress: second.localAddress,
      tls: true,
      alpn: t2.alpnProtocol,
      retried: true,
    };
  }
}

module.exports = { raceConnect, upgradeTls, connectTo };
