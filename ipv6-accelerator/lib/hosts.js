'use strict';
/**
 * hosts.js —— hosts 增强模式（给"不认代理"的程序兜底）
 *
 * 代理模式解决 95% 的场景，但有些程序（部分游戏客户端、带自签证书的更新器）
 * 会无视系统代理。这时只能回到 UsbEAm 的老办法：改 hosts。
 *
 * 与原作者做法的区别：这里只操作一段带标记的区块，可一键完全还原，
 * 并且在写入前先备份原文件，绝不破坏用户已有的 hosts 内容。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARK_BEGIN = '# ==== IPv6 Accelerator BEGIN ====';
const MARK_END = '# ==== IPv6 Accelerator END ====';

function hostsPath() {
  if (process.platform === 'win32') {
    const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
    if (fs.existsSync(p)) return p;
  }
  return '/etc/hosts';
}

function readHosts() {
  const p = hostsPath();
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

/** 解析出当前被管理的条目 */
function listManaged() {
  const text = readHosts();
  const m = text.match(new RegExp(escapeRe(MARK_BEGIN) + '([\\s\\S]*?)' + escapeRe(MARK_END)));
  if (!m) return [];
  return m[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const parts = l.split(/\s+/);
      return { ip: parts[0], host: parts[1] };
    }).filter((e) => e.host);
}

/** 写入一组 hostname -> ip 映射（会整体替换受管区块） */
function apply(entries, { backup = true } = {}) {
  const p = hostsPath();
  let text;
  try { text = readHosts(); }
  catch (e) { return { ok: false, error: `读取 hosts 失败: ${e.message}` }; }

  if (backup) {
    try {
      const bdir = path.join(__dirname, '..', 'backup');
      fs.mkdirSync(bdir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(bdir, `hosts.${stamp}.bak`), text, 'utf8');
    } catch (_) { /* 备份失败不阻断，但下面会提示 */ }
  }

  const clean = stripManaged(text);
  const lines = entries
    .filter((e) => e && e.host && e.ip)
    .map((e) => `${e.ip}\t${e.host}${e.comment ? '\t# ' + e.comment : ''}`);

  const block = `${MARK_BEGIN}\n${lines.join('\n')}\n${MARK_END}\n`;
  const next = clean.replace(/\s*$/, '\n') + '\n' + block;

  try {
    fs.writeFileSync(p, next, 'utf8');
    return { ok: true, path: p, count: lines.length };
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return { ok: false, error: '权限不足：写 hosts 需要管理员身份。请右键用"以管理员身份运行"启动本程序。', path: p };
    }
    return { ok: false, error: `写入失败: ${e.message}`, path: p };
  }
}

/** 还原：删掉受管区块，其他内容原样保留 */
function revert() {
  const p = hostsPath();
  let text;
  try { text = readHosts(); }
  catch (e) { return { ok: false, error: e.message }; }

  if (!text.includes(MARK_BEGIN)) return { ok: true, path: p, removed: 0, note: '本来就没有受管条目' };

  const clean = stripManaged(text);
  try {
    fs.writeFileSync(p, clean, 'utf8');
    return { ok: true, path: p, removed: listManaged().length };
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return { ok: false, error: '权限不足：需要管理员身份才能修改 hosts。' };
    }
    return { ok: false, error: e.message };
  }
}

function stripManaged(text) {
  return text.replace(new RegExp('\\s*' + escapeRe(MARK_BEGIN) + '[\\s\\S]*?' + escapeRe(MARK_END) + '\\s*\\n?', 'g'), '\n');
}

/** 刷 DNS 缓存，让 hosts 立刻生效 */
function flushDns() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('ipconfig /flushdns', { windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, output: (stdout || '').trim(), error: err ? err.message : null });
    });
  });
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { hostsPath, listManaged, apply, revert, flushDns, MARK_BEGIN, MARK_END };
