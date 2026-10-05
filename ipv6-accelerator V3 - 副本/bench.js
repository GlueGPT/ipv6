'use strict';
/**
 * bench.js —— 严格对照测试：瞬时采样 vs 持续下载
 *
 * 目的：验证 probe.js 里"短窗口测吞吐"的读数到底准不准。
 *
 * 做法：对同一个 URL 同一个 IP，
 *   A) 用 probe.js 的方式测（4MB 起，自适应放大）
 *   B) 持续下载 40MB，按 500ms 分片记录速率曲线，看收敛值
 * 把两者放在一起对比，就能看出短窗口是不是读到了 TCP 慢启动阶段的假值。
 */

const tls = require('tls');
const https = require('https');
const http = require('http');
const { probeThroughput } = require('./lib/probe');

/**
 * 用法（全部用具名参数，避免 PowerShell 把空参数吃掉）:
 *   node bench.js --url <URL> [--ip <IP>] [--mb <持续下载MB数>] [--brief]
 *
 * --brief 只输出一行汇总，方便批量对照
 */

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const URL_ = arg('--url', 'https://mirrors.ustc.edu.cn/debian/ls-lR.gz');
const IP = arg('--ip', null);            // 不传就自动解析
const SUSTAIN_BYTES = Number(arg('--mb', '40')) * 1024 * 1024;
const BRIEF = argv.includes('--brief');

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', m: '\x1b[35m' };

/** 持续下载并按时间分片报告速率 */
function sustainedDownload(url, ip, byteLimit) {
  return new Promise((resolve) => {
    const t = new URL(url);
    const isTls = t.protocol === 'https:';
    const mod = isTls ? https : http;
    const t0 = process.hrtime.bigint();
    const ms = (ns) => Number(process.hrtime.bigint() - ns) / 1e6;

    let firstByteNs = null;
    let bytes = 0;
    let settled = false;
    const slices = [];          // 每 500ms 一片
    let sliceStartNs = null, sliceBytes = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      const totalMs = ms(t0);
      const transferMs = firstByteNs ? ms(firstByteNs) : 0;
      resolve({
        bytes, totalMs, transferMs,
        ttfb: firstByteNs ? ms(t0) : null,
        slices,
        // 全窗口平均
        avgKbps: transferMs > 0 ? (bytes / 1024) / (transferMs / 1000) : 0,
        // 后半程平均（已过慢启动）
        stableKbps: (() => {
          const half = slices.slice(Math.floor(slices.length / 2));
          if (!half.length) return 0;
          const b = half.reduce((s, x) => s + x.bytes, 0);
          const m = half.reduce((s, x) => s + x.ms, 0);
          return m > 0 ? (b / 1024) / (m / 1000) : 0;
        })(),
      });
    };

    const req = mod.request({
      protocol: t.protocol, hostname: t.hostname,
      port: t.port || (isTls ? 443 : 80),
      path: t.pathname + t.search, method: 'GET',
      headers: {
        Host: t.host, 'User-Agent': 'bench/1.0', Accept: '*/*',
        Range: `bytes=0-${byteLimit - 1}`, 'Accept-Encoding': 'identity',
      },
      lookup: (h, o, cb) => { const c = typeof o === 'function' ? o : cb; c(null, ip, require('net').isIP(ip)); },
      family: require('net').isIP(ip),
      servername: isTls ? t.hostname : undefined,
      rejectUnauthorized: false,
      timeout: 60000,
    }, (res) => {
      res.on('data', (chunk) => {
        if (firstByteNs === null) { firstByteNs = process.hrtime.bigint(); sliceStartNs = firstByteNs; }
        bytes += chunk.length;
        sliceBytes += chunk.length;
        if (sliceStartNs && ms(sliceStartNs) >= 500) {
          slices.push({ ms: ms(sliceStartNs), bytes: sliceBytes });
          sliceStartNs = process.hrtime.bigint();
          sliceBytes = 0;
        }
        if (bytes >= byteLimit) { req.destroy(); finish(); }
      });
      res.on('end', () => { if (sliceBytes) slices.push({ ms: ms(sliceStartNs), bytes: sliceBytes }); finish(); });
      res.on('error', (e) => { finish(); });
    });
    req.on('timeout', () => { req.destroy(); finish(); });
    req.on('error', (e) => { console.log('  请求错误:', e.code || e.message); finish(); });
    req.end();
  });
}

const fmt = (kb) => kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB/s' : kb.toFixed(0) + ' KB/s';

/** 去掉 ANSI 颜色，供 --brief 单行输出使用 */
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

(async () => {
  const t = new URL(URL_);
  let ip = IP;
  if (!ip) {
    const dns = require('dns');
    const r = await dns.promises.lookup(t.hostname, { all: true });
    ip = (r.find((x) => x.family === 6) || r[0]).address;
  }
  const fam = require('net').isIP(ip);

  if (BRIEF) {
    // 单行汇总模式：给批量对照用
    const a = await probeThroughput(URL_, ip, {});
    const b = await sustainedDownload(URL_, ip, SUSTAIN_BYTES);
    const host = t.hostname.padEnd(32);
    console.log(plain(
      `${host} ip=${ip.padEnd(30)} v${fam}  ` +
      `短窗口=${fmt(a.kbps || 0).padStart(11)}  ` +
      `稳定=${fmt(b.stableKbps).padStart(11)}  ` +
      `实收=${(b.bytes / 1048576).toFixed(1).padStart(5)}MB  ` +
      `比值=${(a.kbps && b.stableKbps ? (a.kbps / b.stableKbps).toFixed(2) : '-')}`
    ));
    return;
  }

  console.log(`\n${C.b}${C.c}测速对照实验${C.r}`);
  console.log(`  目标: ${URL_}`);
  console.log(`  使用 IP: ${ip} ${fam === 6 ? '(IPv6)' : '(IPv4)'}`);
  console.log('');

  // ---- A: probe.js 的短窗口方式 ----
  console.log(`${C.b}[A] probe.js 短窗口方式（默认参数）${C.r}`);
  const a = await probeThroughput(URL_, ip, {});
  console.log(`  下载 ${(a.bytes / 1048576).toFixed(2)} MB  传输窗口 ${a.transferMs} ms`);
  console.log(`  TTFB ${a.ttfb} ms   读数 ${C.y}${fmt(a.kbps || 0)}${C.r}  ${a.reliable ? '标记为可信' : C.d + '标记为不可信' + C.r}`);
  console.log('');

  // ---- B: 持续下载 ----
  console.log(`${C.b}[B] 持续下载 ${(SUSTAIN_BYTES / 1048576).toFixed(0)} MB，500ms 分片${C.r}`);
  const b = await sustainedDownload(URL_, ip, SUSTAIN_BYTES);
  console.log(`  实收 ${(b.bytes / 1048576).toFixed(2)} MB   TTFB ${b.ttfb ? b.ttfb.toFixed(0) : '-'} ms`);
  console.log(`  ${C.d}分片速率曲线（每片 500ms）:${C.r}`);
  b.slices.forEach((s, i) => {
    const k = (s.bytes / 1024) / (s.ms / 1000);
    const bar = '█'.repeat(Math.min(60, Math.round(k / 1024 / 2)));
    console.log(`    #${String(i + 1).padStart(2)}  ${String((s.bytes / 1048576).toFixed(2)).padStart(6)} MB / ${s.ms.toFixed(0).padStart(4)} ms  ${fmt(k).padStart(11)}  ${C.c}${bar}${C.r}`);
  });
  console.log('');
  console.log(`  全程平均     ${C.b}${fmt(b.avgKbps)}${C.r}`);
  console.log(`  后半程平均   ${C.b}${C.g}${fmt(b.stableKbps)}${C.r}   ${C.d}← 这才是"稳定吞吐"，短窗口应该逼近这个值${C.r}`);
  console.log('');

  if (a.kbps) {
    const ratio = a.kbps / b.stableKbps;
    console.log(`${C.b}结论${C.r}`);
    console.log(`  短窗口读数 ${fmt(a.kbps)}  vs  稳定吞吐 ${fmt(b.stableKbps)}   比值 ${ratio.toFixed(2)}`);
    if (ratio < 0.6) {
      console.log(`  ${C.y}⚠ 短窗口严重低估（只有稳定值的 ${(ratio * 100).toFixed(0)}%）${C.r}`);
      console.log(`  ${C.d}原因通常是窗口落在 TCP 慢启动阶段，或采样时间太短。${C.r}`);
    } else if (ratio > 1.6) {
      console.log(`  ${C.y}⚠ 短窗口明显高估，可能读到了接收缓冲区里的数据。${C.r}`);
    } else {
      console.log(`  ${C.g}✓ 短窗口读数与稳定吞吐基本一致，测量方式可靠。${C.r}`);
    }
  }
  console.log('');
})();
