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

/**
 * hosts 文件路径。
 *
 * 允许通过环境变量 ACCEL_HOSTS_FILE 覆盖 —— 这不只是测试便利：
 * 它让"多模式共存 / 按模式还原"这套逻辑可以在临时文件上完整验证，
 * 而不必真的去动系统 hosts、也不必每次都提权。
 */
let overridePath = process.env.ACCEL_HOSTS_FILE || null;

function setHostsPath(p) { overridePath = p || null; }

function hostsPath() {
  if (overridePath) return overridePath;
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

/** 解析出当前被管理的条目（含所属模式标记） */
function listManaged() {
  const text = readHosts();
  const m = text.match(new RegExp(escapeRe(MARK_BEGIN) + '([\\s\\S]*?)' + escapeRe(MARK_END)));
  if (!m) return [];
  return m[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const parts = l.split(/\s+/);
      // 行格式: <ip>\t<host>\t# <说明> [ipv6accel:<mode>:<role>]
      const comment = parts.length > 2 ? l.slice(l.indexOf(parts[1]) + parts[1].length).replace(/^\s*#\s*/, '').trim() : '';
      const tag = comment.match(/\[ipv6accel:([^:\]]+):([^\]]+)\]/);
      return {
        ip: parts[0],
        host: parts[1],
        comment: comment.replace(/\[ipv6accel:[^\]]+\]/, '').trim(),
        mode: tag ? tag[1] : null,
        role: tag ? tag[2] : null,
      };
    }).filter((e) => e.host);
}

/** 列出指定模式的条目；不传 mode 则返回全部 */
function listByMode(mode) {
  const all = listManaged();
  return mode ? all.filter((e) => e.mode === mode) : all;
}

/** 当前实际生效的模式（去重） */
function activeModes() {
  return Array.from(new Set(listManaged().map((e) => e.mode).filter(Boolean)));
}

/** 把条目对象序列化成 hosts 行 */
function toLine(e) {
  const tag = e.mode ? ` [ipv6accel:${e.mode}:${e.role || 'default'}]` : '';
  const comment = e.comment ? `\t# ${e.comment}${tag}` : (tag ? `\t#${tag}` : '');
  return `${e.ip}\t${e.host}${comment}`;
}

/**
 * 写入一组 hostname -> ip 映射。
 *
 * 关键：默认**保留其他模式**已有的条目。
 * 否则"开启 Steam 模式"会把已经配好的"Epic 模式"冲掉，
 * 用户会以为开了新的就丢了旧的。
 *
 * @param {Array} entries  条目，可带 mode / role / comment
 * @param {object} opts
 *   replaceModes: string[]  写入前先清掉这些模式的旧条目（通常传本次要重新优选的模式）
 *   append: boolean         是否保留其他模式（默认 true）
 */
function apply(entries, { backup = true, replaceModes = [], keepOthers = true } = {}) {
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
      pruneBackups(bdir);
    } catch (_) { /* 备份失败不阻断 */ }
  }

  // 保留其他模式的条目，只替换本次要动的那些
  const drop = new Set(replaceModes);
  const kept = keepOthers
    ? listManaged().filter((e) => !e.mode || !drop.has(e.mode))
    : [];

  // 同一域名只保留一条：后写入的（也就是本次新优选的）覆盖旧的
  const byHost = new Map();
  for (const e of kept) byHost.set(e.host, e);
  for (const e of entries) {
    if (!e || !e.host || !e.ip) continue;
    byHost.set(e.host, e);
  }

  const lines = Array.from(byHost.values()).map(toLine).filter(Boolean);
  const block = lines.length ? `${MARK_BEGIN}\n${lines.join('\n')}\n${MARK_END}\n` : '';
  const next = lines.length ? stripManaged(text).replace(/\s*$/, '\n') + '\n' + block : stripManaged(text);

  try {
    fs.writeFileSync(p, next, 'utf8');
    return {
      ok: true, path: p, count: lines.length,
      modes: Array.from(new Set(Array.from(byHost.values()).map((e) => e.mode).filter(Boolean))),
    };
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return {
        ok: false, path: p, needAdmin: true,
        error: '权限不足：修改 hosts 需要管理员身份。',
        hint: '请关掉本程序，右键「以管理员身份运行」start.cmd 再试。',
      };
    }
    return { ok: false, error: `写入失败: ${e.message}`, path: p };
  }
}

/** 只移除指定模式的条目，其他模式原样保留 */
function revertMode(mode) {
  if (!mode) return revert();
  const p = hostsPath();
  let text;
  try { text = readHosts(); }
  catch (e) { return { ok: false, error: e.message }; }

  const all = listManaged();
  const keep = all.filter((e) => e.mode !== mode);
  const removed = all.length - keep.length;
  if (removed === 0) return { ok: true, removed: 0, note: `模式 ${mode} 本来就没有条目` };

  const lines = keep.map(toLine).filter(Boolean);
  const block = lines.length ? `${MARK_BEGIN}\n${lines.join('\n')}\n${MARK_END}\n` : '';
  const next = lines.length ? stripManaged(text).replace(/\s*$/, '\n') + '\n' + block : stripManaged(text);

  try {
    fs.writeFileSync(p, next, 'utf8');
    return { ok: true, path: p, removed, remaining: keep.length };
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return { ok: false, error: '权限不足：需要管理员身份才能修改 hosts。', needAdmin: true };
    }
    return { ok: false, error: e.message };
  }
}

/**
 * 检测当前进程有没有权限写 hosts。
 *
 * 这个必须提前告诉用户，而不是等他点了"开启 Steam 模式"才报错。
 * 做法是用 'r+' 打开试写并立刻关闭 —— 不会改动内容，但能真实反映权限。
 */
function canWrite() {
  const p = hostsPath();
  try {
    const fd = fs.openSync(p, 'r+');
    fs.closeSync(fd);
    return { ok: true, path: p };
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      return { ok: false, path: p, needAdmin: true, error: '没有写 hosts 的权限（需要管理员）' };
    }
    if (e.code === 'ENOENT') return { ok: false, path: p, error: `找不到 hosts 文件: ${p}` };
    return { ok: false, path: p, error: e.message };
  }
}

/** 还原：删掉受管区块，其他内容原样保留 */
function revert() {
  const p = hostsPath();
  let text;
  try { text = readHosts(); }
  catch (e) { return { ok: false, error: e.message }; }

  if (!text.includes(MARK_BEGIN)) return { ok: true, path: p, removed: 0, note: '本来就没有受管条目' };

  // 必须在清除之前先数，否则数的是已经清空的文件（一直是 0）
  const removed = listManaged().length;
  const clean = stripManaged(text);
  try {
    fs.writeFileSync(p, clean, 'utf8');
    return { ok: true, path: p, removed };
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

/**
 * 备份轮转。
 *
 * 每次写 hosts 都留一份备份，长期使用会无限堆积 ——
 * 实测跑几轮测试就攒了 33 个文件。这里只保留最近 maxKeep 份。
 * 删文件本身有风险，所以只匹配自己生成的那种命名格式，其他文件一律不碰。
 */
function pruneBackups(bdir, maxKeep = 20) {
  try {
    const files = fs.readdirSync(bdir)
      .filter((f) => /^hosts\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.bak$/.test(f))
      .map((f) => {
        const full = path.join(bdir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);   // 新的在前

    let removed = 0;
    for (const x of files.slice(maxKeep)) {
      try { fs.unlinkSync(x.full); removed++; } catch (_) {}
    }
    return removed;
  } catch (_) {
    return 0;
  }
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

module.exports = {
  hostsPath, setHostsPath, listManaged, listByMode, activeModes, apply, revert, revertMode,
  flushDns, toLine, canWrite, pruneBackups, MARK_BEGIN, MARK_END,
};
