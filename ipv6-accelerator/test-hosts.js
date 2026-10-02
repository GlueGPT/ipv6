'use strict';
/**
 * test-hosts.js —— 多模式 hosts 逻辑测试（在临时文件上跑，不动系统 hosts）
 *
 * 重点验证三件容易出错的事：
 *   1. 用户原有的 hosts 内容一个字都不能动
 *   2. 开启新模式不能把已开启的其他模式冲掉（多模式共存）
 *   3. 按模式还原只移除该模式的条目，其他模式保留
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require 之前设置，模块加载时就会读这个变量
const TMP = path.join(os.tmpdir(), `accel-hosts-test-${process.pid}.txt`);
process.env.ACCEL_HOSTS_FILE = TMP;

const hosts = require('./lib/hosts');

const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', red: '\x1b[31m', b: '\x1b[1m', c: '\x1b[36m' };
let pass = 0, fail = 0;
const ok = (s) => { pass++; console.log(`  ${C.g}✓${C.r} ${s}`); };
const bad = (s) => { fail++; console.log(`  ${C.red}✗${C.r} ${s}`); };
const check = (cond, yes, no) => cond ? ok(yes) : bad(no);

const USER_CONTENT = [
  '# 用户自己的 hosts',
  '127.0.0.1  localhost',
  '::1        localhost',
  '10.0.0.5   my-nas.local   # 我自己加的内网设备',
  '',
].join('\r\n');

function reset() { fs.writeFileSync(TMP, USER_CONTENT, 'utf8'); }
function raw() { return fs.readFileSync(TMP, 'utf8'); }

console.log(`\n${C.b}${C.c}多模式 hosts 逻辑测试${C.r}`);
console.log(`${C.d}  临时文件: ${TMP}${C.r}\n`);

// ---------------------------------------------------------------------------
console.log(`${C.b}[1] 写入前：用户原始内容必须被保护${C.r}`);
reset();
const before = raw();
check(before.includes('my-nas.local'), '用户原有条目就位', '测试前置条件失败');

// ---------------------------------------------------------------------------
console.log(`\n${C.b}[2] 应用 Steam 模式${C.r}`);
let r = hosts.apply([
  { ip: '2001:da8:d800:95::110', host: 'steampipe.akamaized.net', mode: 'steam', role: 'download', comment: 'v6 20ms 12MB/s' },
  { ip: '2001:da8:d800:95::110', host: 'steamcdn-a.akamaihd.net', mode: 'steam', role: 'download', comment: 'v6 21ms' },
], { replaceModes: ['steam'] });
check(r.ok, `写入成功（${r.count} 条）`, `写入失败: ${r.error}`);
check(raw().includes('my-nas.local'), '用户原有内容仍在', '用户内容被破坏！');
check(raw().includes('::1        localhost'), '用户原有格式未被改写', '用户原有行被改动');
check(JSON.stringify(hosts.activeModes()) === '["steam"]', '当前模式 = [steam]', `模式不对: ${JSON.stringify(hosts.activeModes())}`);
check(hosts.listByMode('steam').length === 2, 'steam 有 2 条条目', `条目数不对: ${hosts.listByMode('steam').length}`);

// ---------------------------------------------------------------------------
console.log(`\n${C.b}[3] 再应用 Epic 模式 —— Steam 必须保留${C.r}`);
r = hosts.apply([
  { ip: '2001:da8:e000:8936::97', host: 'epicgames-download1.akamaized.net', mode: 'epic', role: 'download', comment: 'v6 2ms' },
], { replaceModes: ['epic'] });
check(r.ok, `写入成功（${r.count} 条）`, `写入失败: ${r.error}`);
const modes2 = hosts.activeModes().sort();
check(modes2.join(',') === 'epic,steam', `两个模式共存: ${modes2.join(', ')}`, `模式丢失: ${JSON.stringify(modes2)}`);
check(hosts.listByMode('steam').length === 2, 'steam 条目还在（2 条）', 'steam 条目被冲掉了！');
check(hosts.listByMode('epic').length === 1, 'epic 条目已写入（1 条）', 'epic 条目缺失');
check(raw().includes('my-nas.local'), '用户原有内容仍未被破坏', '用户内容被破坏！');

// ---------------------------------------------------------------------------
console.log(`\n${C.b}[4] 重新优选 Steam —— 只替换 steam，epic 不受影响${C.r}`);
r = hosts.apply([
  { ip: '2402:f000:1:400::2', host: 'steampipe.akamaized.net', mode: 'steam', role: 'download', comment: 'v6 30ms 新' },
  { ip: '2402:f000:1:400::2', host: 'cdn.steamstatic.com', mode: 'steam', role: 'download', comment: 'v6 31ms' },
  { ip: '2402:f000:1:400::2', host: 'steamcontent.com', mode: 'steam', role: 'download', comment: 'v6 32ms' },
], { replaceModes: ['steam'] });
const steamNow = hosts.listByMode('steam');
check(steamNow.length === 3, `steam 更新为 3 条（旧条目已替换）`, `steam 条目数异常: ${steamNow.length}`);
check(!steamNow.some((e) => e.ip === '2001:da8:d800:95::110'), 'steam 旧 IP 已被替换掉', '旧 IP 残留');
check(hosts.listByMode('epic').length === 1, 'epic 完全未受影响', 'epic 被误改');
check(raw().split('steampipe.akamaized.net').length - 1 === 1, '同一域名没有重复行', '出现重复行');

// ---------------------------------------------------------------------------
console.log(`\n${C.b}[5] 按模式还原 Steam —— Epic 必须保留${C.r}`);
r = hosts.revertMode('steam');
check(r.ok, `还原成功（移除 ${r.removed} 条，剩余 ${r.remaining} 条）`, `还原失败: ${r.error}`);
check(r.removed === 3, '移除条数正确（3）', `移除条数不对: ${r.removed}`);
check(hosts.activeModes().join(',') === 'epic', '当前只剩 epic', `模式不对: ${JSON.stringify(hosts.activeModes())}`);
check(hosts.listByMode('epic').length === 1, 'epic 保留', 'epic 丢失');
check(raw().includes('my-nas.local'), '用户原有内容仍在', '用户内容被破坏！');
check(!raw().includes('steampipe.akamaized.net'), 'steam 条目已清干净', 'steam 条目残留');

// ---------------------------------------------------------------------------
console.log(`\n${C.b}[6] 全部还原 —— 用户内容必须一字不差${C.r}`);
r = hosts.revert();
check(r.ok, `全部还原成功（移除 ${r.removed} 条）`, `还原失败: ${r.error}`);
check(r.removed === 1, '全部还原报告的移除条数正确（1）', `移除条数不对: ${r.removed}（应为 1）`);
check(hosts.activeModes().length === 0, '所有模式已清空', `仍有模式: ${JSON.stringify(hosts.activeModes())}`);
const after = raw();
check(after.includes('my-nas.local'), '用户条目仍在', '用户条目丢失');
check(!after.includes('IPv6 Accelerator'), '受管区块已完全移除', '受管区块残留');

// 逐行比对用户原有内容（忽略首尾空白差异）
const userLines = USER_CONTENT.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const afterLines = after.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const allPresent = userLines.every((l) => afterLines.includes(l));
check(allPresent, `用户原有 ${userLines.length} 行全部原样保留`, '有用户行丢失或被改写');

// ---------------------------------------------------------------------------
console.log(`\n${C.b}[7] 边界情况${C.r}`);
reset();
hosts.apply([{ ip: '1.2.3.4', host: 'a.example.com', mode: 'steam', role: 'download' }], { replaceModes: ['steam'] });
// 同一域名在两个模式里，后写入的应该胜出且只有一行
hosts.apply([{ ip: '5.6.7.8', host: 'a.example.com', mode: 'epic', role: 'download' }], { replaceModes: ['epic'] });
const dup = raw().split('a.example.com').length - 1;
check(dup === 1, '跨模式同域名只保留一行', `出现 ${dup} 行重复`);
const winner = hosts.listManaged().find((e) => e.host === 'a.example.com');
check(winner && winner.ip === '5.6.7.8', '后写入的模式胜出', `胜出的是 ${winner && winner.ip}`);

// 还原一个不存在的模式
const r2 = hosts.revertMode('nintendo');
check(r2.ok && r2.removed === 0, '还原不存在的模式：安全返回 0', '处理异常');

// 空条目写入
const r3 = hosts.apply([], { replaceModes: ['steam'] });
check(r3.ok, '写入空列表不报错', `失败: ${r3.error}`);

// ---------------------------------------------------------------------------
try { fs.unlinkSync(TMP); } catch (_) {}

console.log(`\n${C.b}${pass} 项通过，${fail} 项失败${C.r}\n`);
process.exit(fail ? 1 : 0);
