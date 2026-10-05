'use strict';
/**
 * presets.js —— 多模式（程序）预设表
 *
 * ---------------------------------------------------------------------------
 * 为什么分两种策略
 * ---------------------------------------------------------------------------
 * 一类程序**认系统代理**：浏览器、IDM、aria2、curl。
 *   对它们用本地代理最干净 —— 不改 hosts、不要管理员。
 *
 * 另一类程序**根本不看系统代理**：Steam、Epic、Origin 的下载器都有自己的
 * 连接逻辑，直接把内容 CDN 的域名解析结果拿去连。对它们只有改 hosts 一条路
 * （这也是原版 UsbEAm 必须写 hosts 的原因）。
 *
 * ---------------------------------------------------------------------------
 * 域名清单的来源与取舍
 * ---------------------------------------------------------------------------
 * 参考了社区维护的域名表（v2fly domain-list-community、ACL4SSR 等），
 * 但它们的目标是"分流/绕行"，本工具的目标是"挑最快的 IP"，
 * 所以只保留**真正承载大流量下载**的域名，把登录/社区这类小请求排除掉 ——
 * 域名越少，优选越快，也越不容易误伤。
 *
 * hosts 里写死某个域名后，如果那个 IP 挂了，该域名就彻底不可用。
 * 所以每个模式都提供"还原"，且应用时会先备份。
 */

/** Steam 内容分发的区域子域，覆盖亚洲常用节点即可 */
const STEAM_REGIONS = ['sg', 'hk', 'jp', 'kr', 'syd', 'tyo', 'seo', 'hkg', 'sin', 'lax', 'sea'];

/** Steam 内容 CDN 子域前缀（正向和反向都有用到） */
const STEAM_CDN_PREFIXES = [
  'steamcdn-a.akamaihd.net/steam',
  'steamcdn-a.akamaihd.net/client',
  'steamcdn-a.akamaihd.net/steamlink',
];

/** 游戏相关的通用大文件 CDN（Akamai / Cloudflare / Cloudfront / Fastly） */
const GENERIC_CDN = [
  { host: 'steampipe.akamaized.net', role: 'download', note: 'Steam 管线 CDN（Akamai）' },
  { host: 'epicgames-download1.akamaized.net', role: 'download', note: 'Epic 下载 CDN（Akamai）' },
  { host: 'cloudflare.epicgamescdn.com', role: 'download', note: 'Epic 下载 CDN（Cloudflare）' },
  { host: 'download.epicgames.com', role: 'download', note: 'Epic 下载入口' },
  { host: 'cdn1.epicgames.com', role: 'download', note: 'Epic 内容 CDN' },
  { host: 'origin-a.akamaihd.net', role: 'download', note: 'EA/Origin 下载 CDN（Akamai）' },
  { host: 'eaassets-a.akamaihd.net', role: 'download', note: 'EA 资源 CDN' },
];

const MODES = [
  {
    id: 'browser',
    name: '浏览器 / 下载器',
    short: '浏览器',
    icon: 'browser',
    color: '#2b9df4',
    strategy: 'proxy',
    requiresAdmin: false,
    desc: 'Chrome / Edge / Firefox / IDM / aria2 / curl',
    detail: '走本地代理（127.0.0.1:8899），不改 hosts、不需要管理员。' +
      '程序在连接层把目标换成实测最优 IP，SNI 与 Host 保持不变。',
    tip: '在浏览器或 IDM 里把 HTTP/HTTPS 代理设为 127.0.0.1:8899，或用「一键开启系统代理.cmd」。',
  },
  {
    id: 'idm',
    name: 'IDM 下载器',
    short: 'IDM',
    icon: 'idm',
    color: '#1a9e5c',
    strategy: 'proxy',
    requiresAdmin: false,
    desc: 'Internet Download Manager 的分段多线程下载',
    detail: 'IDM **遵守系统代理设置**，所以走本地代理即可，不用改 hosts、不需要管理员。' +
      'IDM 的多线程分段下载正好能让竞速逻辑发挥最大作用 —— 每条连接都会独立选到最优 IP。',
    tip: 'IDM → 选项 → 代理服务器 → 选「使用系统代理」；或手动填 HTTP 代理 127.0.0.1:8899。',
    // 这些域名供 IDM 场景下的"只对这些走代理"之类的定向配置参考
    domains: [
      { host: 'mirror.idm.software', role: 'update', note: 'IDM 自身更新 CDN' },
    ],
  },
  {
    id: 'steam',
    name: 'Steam',
    short: 'Steam',
    icon: 'steam',
    color: '#66c0f4',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'Steam 与蒸汽中国的游戏下载与更新',
    detail: 'Steam 下载**不使用系统代理**，只能通过 hosts 把内容 CDN 指向优选 IP。' +
      '注意：Steam 客户端对单个目标 IP 的连接数有限制，最高速率可能受限。',
    tip: '应用后建议重启 Steam 客户端让 hosts 生效。',
    domains: [
      { host: 'steampipe.akamaized.net', role: 'download', note: 'Steam 管线 CDN（主力）' },
      { host: 'steamcdn-a.akamaihd.net', role: 'download', note: 'Steam 内容 CDN' },
      { host: 'cdn.steamstatic.com', role: 'download', note: 'Steam 静态资源 CDN' },
      { host: 'steamcontent.com', role: 'download', note: 'Steam 内容域名' },
      { base: 'steampipe.akamaized.net', expand: STEAM_REGIONS, role: 'download', note: 'Steam 管线区域节点' },
      { base: 'steamcdn-a.akamaihd.net', expand: ['steam', 'client', 'steamlink'], role: 'download', note: 'Steam CDN 子域' },
    ],
  },
  {
    id: 'epic',
    name: 'Epic Games',
    short: 'Epic',
    icon: 'epic',
    color: '#b8b8b8',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'Epic Games 启动器的游戏下载与更新',
    detail: 'Epic 下载同样**不走系统代理**，需要 hosts 重定向。' +
      'Epic 同时使用 Akamai 和 Cloudflare 两套 CDN，程序会在两者里一起优选。',
    tip: '应用后重启 Epic 启动器。',
    domains: [
      { host: 'epicgames-download1.akamaized.net', role: 'download', note: 'Epic 下载 CDN（Akamai）' },
      { host: 'cloudflare.epicgamescdn.com', role: 'download', note: 'Epic 下载 CDN（Cloudflare）' },
      { host: 'download.epicgames.com', role: 'download', note: 'Epic 下载入口' },
      { host: 'cdn1.epicgames.com', role: 'download', note: 'Epic 内容 CDN 1' },
      { host: 'cdn2.epicgames.com', role: 'download', note: 'Epic 内容 CDN 2' },
      { host: 'epicgames-download2.akamaized.net', role: 'download', note: 'Epic 下载 CDN 备用' },
    ],
  },
  {
    id: 'battlenet',
    name: 'Battle.net',
    short: '战网',
    icon: 'battlenet',
    color: '#00aeff',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: '暴雪战网客户端的游戏下载与更新',
    detail: '战网的内容分发走 Blizzard 自建 CDN + Akamai。' +
      '已知问题：战网客户端对单个目标 IP 只发起 3 个连接，最高速率可能受限。',
    tip: '应用后重启战网客户端。',
    domains: [
      { host: 'cdn.blizzard.com', role: 'download', note: '暴雪 CDN（主力，多 AAAA）' },
      { host: 'level3.blizzard.com', role: 'download', note: '暴雪 CDN（Level3/Akamai）' },
      { host: 'us.actual.battle.net', role: 'download', note: '战网美服下载节点' },
      { host: 'eu.actual.battle.net', role: 'download', note: '战网欧服下载节点' },
      { host: 'kr.actual.battle.net', role: 'download', note: '战网韩服下载节点' },
    ],
  },
  {
    id: 'ea',
    name: 'EA Desktop',
    short: 'EA',
    icon: 'ea',
    color: '#ff4747',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'EA Desktop / EA app / Origin 的下载与更新',
    detail: 'EA 的内容分发走 Akamai。',
    tip: '应用后重启 EA app。',
    domains: [
      { host: 'origin-a.akamaihd.net', role: 'download', note: 'Origin 下载 CDN' },
      { host: 'eaassets-a.akamaihd.net', role: 'download', note: 'EA 资源 CDN' },
      { host: 'cdn.origin.com', role: 'download', note: 'Origin 内容 CDN' },
    ],
  },
  {
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    short: '育碧',
    icon: 'ubisoft',
    color: '#0b8ce8',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'Ubisoft Connect 的游戏下载与更新',
    detail: '育碧的内容分发走 Akamai。',
    tip: '应用后重启 Ubisoft Connect。',
    domains: [
      { host: 'ubisoft-origin.akamaized.net', role: 'download', note: 'Ubisoft CDN（Akamai）' },
      { host: 'cdn.ubi.com', role: 'download', note: 'Ubisoft 内容 CDN' },
    ],
  },
  {
    id: 'riot',
    name: 'Riot Games',
    short: 'Riot',
    icon: 'riot',
    color: '#d13639',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: '拳头客户端与英雄联盟系游戏的下载更新',
    detail: '拳头用自建 RiotCDN + Akamai 分发。',
    tip: '应用后重启拳头客户端。',
    domains: [
      { host: 'lol.secure.dyn.riotcdn.net', role: 'download', note: '英雄联盟动态 CDN' },
      { host: 'riotgames.com', role: 'download', note: '拳头主域' },
    ],
  },
  {
    id: 'rockstar',
    name: 'Rockstar Games',
    short: 'R星',
    icon: 'rockstar',
    color: '#fcaf17',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'Rockstar Games Launcher 的下载与更新',
    detail: 'R星内容分发走 Akamai。',
    tip: '应用后重启 Rockstar Games Launcher。',
    domains: [
      { host: 'prod.cloud.rockstargames.com', role: 'download', note: 'R星云 CDN' },
      { host: 'media.rockstargames.com', role: 'download', note: 'R星媒体 CDN' },
      { host: 'rockstargames.com', role: 'download', note: 'R星主域' },
    ],
  },
  {
    id: 'gog',
    name: 'GOG Galaxy',
    short: 'GOG',
    icon: 'gog',
    color: '#a259ff',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'GOG Galaxy / GOG 的游戏下载与更新',
    detail: 'GOG 内容分发走 Fastly 与 Akamai。注意 GOG 部分节点在海外，优选效果有限。',
    tip: '应用后重启 GOG Galaxy。',
    domains: [
      { host: 'content-system.gog.com', role: 'download', note: 'GOG 内容系统（Fastly）' },
      { host: 'cdn.gog.com', role: 'download', note: 'GOG CDN' },
    ],
  },
  {
    id: 'amazon',
    name: 'Amazon Games',
    short: 'Amazon',
    icon: 'amazon',
    color: '#ff9900',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'Amazon Games 客户端下载与更新',
    detail: '亚马逊游戏走自家 Cloudfront。',
    tip: '应用后重启 Amazon Games 客户端。',
    domains: [
      { host: 'd2c8v52ll5s99u.cloudfront.net', role: 'download', note: 'Amazon Games CDN（Cloudfront）' },
      { host: 'amazon.com', role: 'download', note: '亚马逊主域' },
    ],
  },
  {
    id: 'wargaming',
    name: 'Wargaming.net',
    short: 'WG',
    icon: 'wargaming',
    color: '#e63946',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'Wargaming Game Center 的下载与更新',
    detail: 'WG 用 G-Core 自建 CDN。',
    tip: '应用后重启 WGC。',
    domains: [
      { host: 'cdn-wg.gcdn.co', role: 'download', note: 'WG CDN（G-Core）' },
      { host: 'wgcdn.net', role: 'download', note: 'WG CDN' },
      { host: 'wargaming.net', role: 'download', note: 'WG 主域' },
    ],
  },
  {
    id: 'microsoft',
    name: 'Xbox / Microsoft Store',
    short: 'Xbox',
    icon: 'microsoft',
    color: '#107c10',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'Xbox PC 与 Microsoft Store 的游戏下载',
    detail: '微软的内容分发走 Akamai 与自己 CDN。' +
      '提示：Xbox 主机默认 IPv6 优先且无法自定义，需关闭路由器的 IPv6 才能用 DNS 重定向。',
    tip: '应用后重启 Microsoft Store 或 Xbox 应用。',
    domains: [
      { host: 'dl.delivery.mp.microsoft.com', role: 'download', note: '微软下载交付（Akamai）' },
      { host: 'tlu.dl.delivery.mp.microsoft.com', role: 'download', note: '微软下载（TLS 变体）' },
      { host: 'assets1.xboxlive.com', role: 'download', note: 'Xbox Live 资源' },
      { host: 'assets2.xboxlive.com', role: 'download', note: 'Xbox Live 资源 2' },
    ],
  },
  {
    id: 'cdn',
    name: '通用大文件 CDN',
    short: '通用 CDN',
    icon: 'cdn',
    color: '#8fa3b8',
    strategy: 'hosts',
    requiresAdmin: true,
    desc: 'Akamai / Cloudfront / Fastly 等公共 CDN',
    detail: '不绑定具体游戏平台的通用 CDN 域名，' +
      '用于加速各类软件更新器、补丁下载，以及自建站点放在 CDN 上的资源。',
    tip: '如果你有特定域名要加速，用下面的「自定义域名」更合适。',
    domains: [
      { host: 'steampipe.akamaized.net', role: 'download', note: 'Akamai 通用' },
      { host: 'epicgames-download1.akamaized.net', role: 'download', note: 'Akamai 通用' },
      { host: 'd2c8v52ll5s99u.cloudfront.net', role: 'download', note: 'Cloudfront 示例' },
      { host: 'content-system.gog.com', role: 'download', note: 'Fastly 示例' },
    ],
  },
];

/** 展开某个模式的域名模板成具体域名列表 */
function expandDomains(mode) {
  const out = [];
  const seen = new Set();

  const push = (host, role, note) => {
    const h = String(host).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
    if (!h || seen.has(h)) return;
    // 只接受看起来像域名的
    if (!/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/.test(h)) return;
    seen.add(h);
    out.push({ host: h, role: role || 'download', note: note || '' });
  };

  for (const d of mode.domains || []) {
    if (d.base && Array.isArray(d.expand)) {
      for (const sub of d.expand) push(`${sub}.${d.base}`, d.role, `${d.note || ''} ${sub}`);
      // 基名本身也一起测
      push(d.base, d.role, d.note);
    } else if (d.host) {
      push(d.host, d.role, d.note);
    }
  }

  return out;
}

function getMode(id) {
  return MODES.find((m) => m.id === id) || null;
}

/**
 * 自检：每个模式的 icon 都必须能在 logos.js 里找到对应图标。
 * 这个检查很有必要 —— icon 名写错时前端只会静默显示空白，
 * 不看界面根本发现不了。
 */
function validateIcons(logos) {
  const problems = [];
  for (const m of MODES) {
    if (m.icon && !logos.LOGOS[m.icon]) {
      problems.push(`模式 ${m.id} 的 icon="${m.icon}" 没有对应图标`);
    }
  }
  return problems;
}

/** 列出所有模式（不含展开后的长列表，避免响应过大） */
function listModes() {
  return MODES.map((m) => ({
    id: m.id,
    name: m.name,
    short: m.short || m.name,
    icon: m.icon || 'cdn',
    color: m.color || '#8fa3b8',
    strategy: m.strategy,
    requiresAdmin: m.requiresAdmin,
    desc: m.desc,
    detail: m.detail,
    tip: m.tip,
    domainCount: m.strategy === 'hosts' ? expandDomains(m).length : 0,
    sampleDomains: m.strategy === 'hosts' ? expandDomains(m).slice(0, 6).map((d) => d.host) : [],
  }));
}

module.exports = { MODES, getMode, listModes, expandDomains, validateIcons, GENERIC_CDN };
