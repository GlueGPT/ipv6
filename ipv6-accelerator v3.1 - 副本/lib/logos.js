'use strict';
/**
 * logos.js —— 平台图标（纯 SVG，无外部资源、无字体依赖）
 *
 * 设计取舍：
 *   没有去临摹各家的官方 logo —— 手绘矢量既不可能画准，也涉及商标问题。
 *   改用「品牌色圆角徽章 + 商标字母」的做法：
 *   颜色一眼可辨（Steam 浅蓝、Epic 银灰、战网亮蓝、EA 红……），
 *   字母点明身份，整体风格统一。信息传达上反而比画歪的 logo 更清楚。
 */

const LOGOS = {
  browser: { text: 'WEB', color: '#2b9df4', textColor: '#04121a' },
  idm: { text: 'IDM', color: '#1a9e5c', textColor: '#031a0f' },
  steam: { text: 'ST', color: '#66c0f4', textColor: '#0b1d29' },
  epic: { text: 'EP', color: '#c8c8c8', textColor: '#1a1a1a' },
  battlenet: { text: 'BN', color: '#00aeff', textColor: '#03202e' },
  ea: { text: 'EA', color: '#ff4747', textColor: '#2a0808' },
  ubisoft: { text: 'UB', color: '#0b8ce8', textColor: '#04182a' },
  riot: { text: 'RG', color: '#d13639', textColor: '#2a0708' },
  rockstar: { text: 'RS', color: '#fcaf17', textColor: '#2a1c00' },
  gog: { text: 'GG', color: '#a259ff', textColor: '#20083a' },
  amazon: { text: 'AG', color: '#ff9900', textColor: '#2a1800' },
  wargaming: { text: 'WG', color: '#e63946', textColor: '#2a0509' },
  microsoft: { text: 'XB', color: '#107c10', textColor: '#eaffea' },
  cdn: { text: 'CDN', color: '#8fa3b8', textColor: '#111823' },
};

/**
 * 生成 SVG sprite —— 一段 <symbol> 定义，塞进页面里。
 *
 * 相比每个图标一个 data URI，sprite 的好处：
 *   - 不占 HTML 体积（只用一次）
 *   - 前端用 <use href="#logo-steam"> 引用，可以自由换尺寸和颜色
 *   - 每页只解析一次
 */
function sprite(size = 48) {
  const parts = [];
  for (const [id, l] of Object.entries(LOGOS)) {
    const fs = l.text.length > 2 ? size * 0.30 : size * 0.40;
    const r = size * 0.26;
    parts.push(
      `<symbol id="logo-${id}" viewBox="0 0 ${size} ${size}">` +
      `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${l.color}"/>` +
      `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" ` +
      `font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" ` +
      `font-size="${fs.toFixed(1)}" font-weight="700" fill="${l.textColor}" ` +
      `letter-spacing="-0.5">${l.text}</text>` +
      `</symbol>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${parts.join('')}</svg>`;
}

/** 生成一个独立的徽章 SVG（用于 /api/logos/:id 这类单独取图） */
function badge(id, size = 44) {
  const l = LOGOS[id] || LOGOS.cdn;
  const fs = l.text.length > 2 ? size * 0.30 : size * 0.40;
  const r = size * 0.26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${l.color}"/>` +
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" ` +
    `font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" ` +
    `font-size="${fs.toFixed(1)}" font-weight="700" fill="${l.textColor}">${l.text}</text></svg>`;
}

module.exports = { LOGOS, sprite, badge };
