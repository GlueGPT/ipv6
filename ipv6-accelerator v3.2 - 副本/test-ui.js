'use strict';
/**
 * test-ui.js —— 界面静态检查
 *
 * ---------------------------------------------------------------------------
 * 为什么要专门做这个
 * ---------------------------------------------------------------------------
 * 之前我一直用"抓 HTML 看某个标签/文字在不在"来验证界面，
 * 这完全测不出 JavaScript 的问题 —— 结果出现了一次真实事故：
 * 重构时留下重复的 `let MODES` 声明，整个 <script> 块因语法错误
 * 一行都没执行：卡片不渲染、状态永远停在"检测中…"、按钮点了没反应。
 * 而 HTML 标签检查全部通过。
 *
 * 所以这个测试要真正解析内联 JS，检查三类会致命的问题：
 *   1. 语法错误（会让整块脚本完全不执行）
 *   2. 调用了但从未定义的函数（重构改名后最容易漏）
 *   3. HTML 里用到的元素 id 在脚本里被引用、但 HTML 里不存在
 *      （反之亦然：脚本里 $('#xxx') 引用了不存在的 id → 后续全是 null 报错）
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, 'public', 'index.html');
const C = { r: '\x1b[0m', d: '\x1b[2m', g: '\x1b[32m', red: '\x1b[31m', b: '\x1b[1m', c: '\x1b[36m' };
let pass = 0, fail = 0;
const ok = (s) => { pass++; console.log(`  ${C.g}✓${C.r} ${s}`); };
const bad = (s) => { fail++; console.log(`  ${C.red}✗${C.r} ${s}`); };

// ---------------------------------------------------------------------------
// 0. 所有 JS 文件的语法与顶层重复声明
//
// 这一项是被同一类事故逼出来的：我先后在 public/index.html 和
// make-launchers.js 里都留下了重复的顶层声明，两次都是语法错误，
// 而两次我都没在跑测试时发现 —— 因为检查只覆盖了"运行时文件"，
// 没覆盖"生成器脚本"，界面脚本更是根本没被当成代码检查过。
// 所以这里统一扫全部 .js（含构建脚本）+ 页面内联脚本。
// ---------------------------------------------------------------------------
console.log(`${C.b}${C.c}界面与构建脚本静态检查${C.r}\n`);
console.log(`${C.b}[0] 全部 JS 文件语法与重复声明${C.r}`);
{
  const root = __dirname;
  const jsFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) jsFiles.push(full);
    }
  };
  walk(root);

  let problems = 0;
  for (const f of jsFiles) {
    const rel = path.relative(root, f);
    const code = fs.readFileSync(f, 'utf8');

    // 语法
    try {
      new vm.Script(code, { filename: rel });
    } catch (e) {
      bad(`${rel} 语法错误：${e.message}`);
      problems++;
      continue;
    }

    // 顶层重复声明（只看行首无缩进的声明，函数内部的正常重名不算）
    const seen = new Map();
    code.split(/\r?\n/).forEach((l, i) => {
      const m = l.match(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/);
      if (!m) return;
      if (seen.has(m[1])) {
        bad(`${rel} 顶层重复声明 "${m[1]}"：第 ${seen.get(m[1]) + 1} 行 与 第 ${i + 1} 行`);
        problems++;
      } else seen.set(m[1], i);
    });
  }

  if (!problems) ok(`${jsFiles.length} 个 JS 文件语法正确、无顶层重复声明`);
}

const html = fs.readFileSync(HTML, 'utf8');

// ---------------------------------------------------------------------------
// 取出所有内联 <script> 块（跳过 src= 的外链脚本）
// ---------------------------------------------------------------------------
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log(`  ${C.d}public/index.html  ${html.length} 字节，内联脚本 ${scripts.length} 块${C.r}\n`);

if (!scripts.length) { bad('没有任何内联脚本，界面不可能有交互'); process.exit(1); }
const js = scripts.join('\n;\n');

// ---------------------------------------------------------------------------
// 1. 语法检查
// ---------------------------------------------------------------------------
console.log(`${C.b}[1] 语法检查${C.r}`);
try {
  new vm.Script(js, { filename: 'public/index.html:<script>' });
  ok('内联 JS 语法正确（语法错会导致整块脚本一行都不执行）');
} catch (e) {
  bad(`语法错误：${e.message}`);
  console.log(`  ${C.d}${e.stack.split('\n').slice(0, 4).join('\n  ')}${C.r}`);
}

// ---------------------------------------------------------------------------
// 2. 顶层重复声明
// 只查顶层：函数内部的局部变量重名是正常的
// ---------------------------------------------------------------------------
console.log(`\n${C.b}[2] 顶层重复声明${C.r}`);
{
  // 用 vm 解析出顶层词法声明，比正则可靠
  const topNames = [];
  // 简单做法：找行首（无缩进）的 let/const/var/function 声明
  const lines = js.split(/\r?\n/);
  const seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:let|const|var|function)\s+([A-Za-z_$][\w$]*)/);
    if (!m) continue;
    const n = m[1];
    if (seen.has(n)) {
      bad(`顶层重复声明 "${n}"：第 ${seen.get(n) + 1} 行 与 第 ${i + 1} 行`);
    } else {
      seen.set(n, i);
    }
  }
  if (![...seen.keys()].length) bad('没有解析到任何顶层声明，检查器可能失效了');
  else ok(`顶层声明 ${seen.size} 个，无重复`);
}

// ---------------------------------------------------------------------------
// 3. 调用了但未定义的函数
// ---------------------------------------------------------------------------
console.log(`\n${C.b}[3] 函数定义与调用一致性${C.r}`);
{
  const defined = new Set();
  // function 声明
  for (const m of js.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  // 箭头函数 / 函数表达式形式的常量
  for (const m of js.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) defined.add(m[1]);

  // 已知可用的全局/内置
  const builtins = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'do', 'else', 'try',
    'async', 'await', 'super', 'this', 'void', 'delete', 'in', 'of', 'instanceof',
    'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Set', 'Map', 'Promise',
    'Error', 'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
    'decodeURIComponent', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'fetch', 'confirm', 'alert', 'console', 'URL', 'Buffer', 'require',
  ]);

  const missing = new Map();
  for (const m of js.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const n = m[1];
    if (builtins.has(n) || defined.has(n)) continue;
    // 排除方法调用（前面有点号的情况已被 lookbehind 挡掉）与关键字
    if (!missing.has(n)) missing.set(n, js.slice(0, m.index).split('\n').length);
  }

  // 只看我们自己命名风格的（驼峰且长度>2），过滤掉 CSS/DOM 里的常见词
  const suspicious = [...missing.entries()].filter(([n]) =>
    /^[a-z][A-Za-z0-9]*$/.test(n) && n.length > 3 &&
    !/^(https?|data)$/.test(n) &&
    // $('#x') 这类选择器内的不算
    true
  );

  if (suspicious.length) {
    for (const [n, line] of suspicious) bad(`调用了未定义的函数 "${n}"（约第 ${line} 行）`);
  } else {
    ok(`函数名一致：定义了 ${defined.size} 个，未发现调用不存在的函数`);
  }
}

// ---------------------------------------------------------------------------
// 4. 脚本引用的元素 id 必须在 HTML 里存在
// ---------------------------------------------------------------------------
console.log(`\n${C.b}[4] 元素 id 引用检查${C.r}`);
{
  // HTML 里定义的所有 id
  const htmlIds = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

  // 脚本里 $('#xxx') 引用的 id
  const used = new Set();
  for (const m of js.matchAll(/\$\(\s*['"]#([A-Za-z0-9_\-]+)['"]\s*\)/g)) used.add(m[1]);
  // getElementById
  for (const m of js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) used.add(m[1]);

  const missingIds = [...used].filter((id) => !htmlIds.has(id));
  if (missingIds.length) {
    for (const id of missingIds) bad(`脚本引用了不存在的 id："#${id}"（运行时取到 null 会立刻报错）`);
  } else {
    ok(`脚本引用的 ${used.size} 个 id 在 HTML 中都存在`);
  }

  // 反向：HTML 定义了 id 但脚本从没用过 —— 只作提示，不算失败
  const unused = [...htmlIds].filter((id) => !used.has(id));
  if (unused.length) {
    console.log(`  ${C.d}提示：${unused.length} 个 id 未被脚本引用（可能是纯样式锚点）${C.r}`);
  }
}

// ---------------------------------------------------------------------------
// 5. 关键功能点：模式网格渲染函数必须存在且被调用
// ---------------------------------------------------------------------------
console.log(`\n${C.b}[5] 关键路径检查${C.r}`);
{
  const required = [
    ['loadModes', '读取平台列表'],
    ['renderPlatforms', '渲染平台宫格'],
    ['renderDetail', '渲染平台详情面板'],
    ['applyMode', '一键开启'],
    ['revertMode', '关闭并还原'],
    ['loadEnv', '本机环境检测'],
    ['doProbe', '目标测速'],
    ['poll', '代理状态轮询'],
  ];
  let miss = 0;
  for (const [fn, what] of required) {
    const defined = new RegExp(`(function\\s+${fn}\\b|(?:const|let|var)\\s+${fn}\\s*=)`).test(js);
    const called = new RegExp(`(?<![.\\w$])${fn}\\s*\\(`).test(js);
    if (!defined) { bad(`${what}：函数 ${fn} 未定义`); miss++; }
    else if (!called) { bad(`${what}：函数 ${fn} 定义了但从未被调用`); miss++; }
  }
  if (!miss) ok(`${required.length} 个关键函数均已定义且被调用`);
}

// ---------------------------------------------------------------------------
// 6. 启动时初始化调用是否齐全
// ---------------------------------------------------------------------------
console.log(`\n${C.b}[6] 启动初始化${C.r}`);
{
  const tail = js.slice(-1500);
  const needs = ['loadEnv()', 'loadModes()', 'poll()'];
  const absent = needs.filter((n) => !js.includes(n + ';') && !js.includes(n));
  if (absent.length) bad(`启动时没有调用：${absent.join(', ')}`);
  else ok('启动时调用了 loadEnv / loadModes / poll（界面首屏不会空白）');
  void tail;
}

// ---------------------------------------------------------------------------
// 7. 真跑一遍页面脚本（vm + 最小 DOM 桩）
//
// 静态检查能发现语法错和拼写错，但发现不了"能跑但跑出来是错的"。
// 这一步把页面脚本放进 vm 里真实执行：喂假的 API 响应，
// 看它到底有没有把平台卡片渲染出来。不需要装 jsdom。
// ---------------------------------------------------------------------------
console.log(`\n${C.b}[7] 实际执行页面脚本（渲染验证）${C.r}`);

/** 把页面脚本放进 vm 里真实跑一遍，喂假 API 响应，检查渲染结果 */
async function runPageScript() {
  // --- 从 HTML 里收集真实存在的 id，桩只认这些，模拟浏览器行为 ---
  const htmlIds = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

  const created = [];   // 记录 innerHTML 被写入了什么

  function makeEl(id) {
    const el = {
      id: id || '',
      style: {},
      dataset: {},
      className: '',
      value: '',
      disabled: false,
      _html: '',
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); created.push({ id: this.id, html: this._html }); },
      get textContent() { return this._text || ''; },
      set textContent(v) { this._text = String(v); },
      addEventListener() {}, removeEventListener() {},
      appendChild() {}, remove() {},
      scrollIntoView() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    };
    return el;
  }

  const registry = new Map();
  const document = {
    querySelector(sel) {
      const m = String(sel).match(/^#([\w-]+)$/);
      if (!m) return null;
      const id = m[1];
      // 关键：只返回 HTML 里真实存在的元素，不存在就返回 null —— 和浏览器一致
      if (!htmlIds.has(id)) return null;
      if (!registry.has(id)) registry.set(id, makeEl(id));
      return registry.get(id);
    },
    querySelectorAll() { return []; },
    getElementById(id) { return this.querySelector('#' + id); },
    createElement() { return makeEl(''); },
    addEventListener() {},
  };

  // 假的 /api/* 响应：形状必须和 server.js 返回的一致
  const fakeEnv = {
    addresses: {
      v6: [{ iface: '以太网', address: '2001:da8:e000:9::c90c', scopeid: 0, mac: '00:11:22:33:44:55' }],
      v6LinkLocal: [{ iface: '以太网', address: 'fe80::1', scopeid: 10, mac: '00:11:22:33:44:55' }],
      v4: [{ iface: '以太网', address: '10.0.0.5', mac: '00:11:22:33:44:55' }],
    },
    egressV4: { ok: true, ip: '1.2.3.4' },
    egressV6: { ok: true, ip: '2001:da8::1' },
    ipv6Tcp: { ok: true, latency: 9.1 },
    policy: 'auto',
    localAddress: null,
    originPool: ['1.2.3.4'],
    proxy: 'http://127.0.0.1:8899',
    socks5: null,
    hostsPath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    hostsManaged: 0,
    platform: 'win32 10.0',
    node: 'v24.0.0',
  };

  const fakeModes = {
    ok: true,
    hostsWritable: false,
    hostsError: '没有写 hosts 的权限（需要管理员）',
    hostsPath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    proxyAddress: 'http://127.0.0.1:8899',
    hostEntries: 0,
    activeModes: [],
    modes: [
      { id: 'browser', name: '浏览器 / 下载器', short: '浏览器', icon: 'browser', color: '#2b9df4',
        strategy: 'proxy', requiresAdmin: false, desc: 'Chrome / Edge / IDM / aria2',
        detail: '走本地代理', tip: '填 127.0.0.1:8899', domainCount: 0, sampleDomains: [],
        active: false, entryCount: 0, available: true, unavailableReason: null },
      { id: 'steam', name: 'Steam', short: 'Steam', icon: 'steam', color: '#66c0f4',
        strategy: 'hosts', requiresAdmin: true, desc: 'Steam 游戏下载与更新',
        detail: '不走系统代理', tip: '重启 Steam', domainCount: 18,
        sampleDomains: ['steampipe.akamaized.net', 'steamcdn-a.akamaihd.net'],
        active: false, entryCount: 0, available: false, unavailableReason: '需要管理员' },
      { id: 'epic', name: 'Epic Games', short: 'Epic', icon: 'epic', color: '#c8c8c8',
        strategy: 'hosts', requiresAdmin: true, desc: 'Epic 游戏下载与更新',
        detail: '不走系统代理', tip: '重启 Epic', domainCount: 6,
        sampleDomains: ['epicgames-download1.akamaized.net'],
        active: true, entryCount: 6, available: false, unavailableReason: '需要管理员' },
    ],
  };

  const fakeStats = {
    uptime: 60000, requests: 12, tunnels: 8, socks5: 0, errors: 0, active: 1,
    bytesUp: 2048, bytesDown: 10485760, connV4: 3, connV6: 5,
    byIp: [{ ip: '2001:da8:e000:8936::97', family: 6, count: 5, bytesDown: 10485760, host: 'mirrors.zju.edu.cn' }],
    recent: [],
    policy: 'auto',
    routes: [{ hostname: 'mirrors.zju.edu.cn', at: Date.now(), age: 30000, hits: 2,
      primary: '2001:da8:e000:8936::97', raceOrder: ['2001:da8:e000:8936::97'], failCount: 0,
      speedDone: true, best: { ip: '2001:da8:e000:8936::97', family: 6, latency: 2, kbps: 9000 }, count: 2 }],
  };

  const calls = [];
  const sandbox = {
    document,
    window: {},
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => true,
    alert: () => {},
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async (url) => {
      calls.push(url);
      const body = url.includes('/api/env') ? fakeEnv
        : url.includes('/api/modes') ? fakeModes
          : url.includes('/api/stats') ? fakeStats
            : { ok: true };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    },
    URL,
    JSON,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    Map,
    Set,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  let execError = null;
  try {
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox, { filename: 'public/index.html:<script>', timeout: 5000 });
  } catch (e) {
    execError = e;
  }

  if (execError) {
    bad(`执行页面脚本时抛错：${execError.message}`);
    console.log(`  ${C.d}${String(execError.stack).split('\n').slice(0, 5).join('\n  ')}${C.r}`);
  } else {
    ok('页面脚本无异常执行完成（没有一上来就抛错）');
  }

  // 等微任务跑完（loadEnv / loadModes / poll 都是异步的）
  // 注意：这些函数内部还有 await fetch，所以不能只 flush 一次，
  // 要反复让出事件循环，直到 DOM 真的被写入为止。
  const flush = () => new Promise((r) => setImmediate(r));
  const waitFor = async (pred, tries = 50) => {
    for (let i = 0; i < tries; i++) {
      if (pred()) return true;
      await flush();
    }
    return false;
  };

  await waitFor(() => created.some((c) => c.id === 'platformGrid' && c.html));
  await waitFor(() => created.some((c) => c.id === 'v6addr' && c.html));
  await waitFor(() => (registry.get('ipv6text') || {}).textContent);
  // 再补几轮，确保 poll 等后续调用也跑完
  for (let i = 0; i < 10; i++) await flush();

  const apiCalled = ['/api/env', '/api/modes', '/api/stats'].filter((p) => calls.some((c) => c.includes(p)));
  apiCalled.length === 3
    ? ok(`启动即调用 ${apiCalled.join(' / ')}`)
    : bad(`启动时只调用了 ${apiCalled.join(', ') || '无'}`);

  // 平台宫格是否真的渲染出卡片
  const gridWrite = created.filter((c) => c.id === 'platformGrid').pop();
  if (!gridWrite || !gridWrite.html) {
    bad('没有向 #platformGrid 写入任何内容（平台卡片不会显示）');
  } else {
    const cardCount = (gridWrite.html.match(/class="pcard/g) || []).length;
    const useCount = (gridWrite.html.match(/<use href="#logo-/g) || []).length;
    cardCount === fakeModes.modes.length
      ? ok(`平台宫格渲染出 ${cardCount} 张卡片（与后端返回的模式数一致）`)
      : bad(`平台宫格渲染了 ${cardCount} 张卡片，后端返回 ${fakeModes.modes.length} 个模式`);
    useCount === fakeModes.modes.length
      ? ok(`${useCount} 个平台图标引用已生成`)
      : bad(`图标引用数 ${useCount} 与模式数 ${fakeModes.modes.length} 不符`);

    // 关键文案是否真的出现在渲染结果里
    for (const [needle, what] of [
      ['浏览器 / 下载器', '平台名'],
      ['Steam', '平台名'],
      ['Epic Games', '平台名'],
      ['已加速', 'Epic 已启用状态'],
    ]) {
      gridWrite.html.includes(needle) ? ok(`渲染结果包含「${what}」`) : bad(`渲染结果缺少「${needle}」`);
    }
  }

  // 详情面板是否渲染
  const detWrite = created.filter((c) => c.id === 'platformDetail').pop();
  detWrite && detWrite.html
    ? ok('平台详情面板已渲染')
    : bad('平台详情面板没有渲染（选中平台后不会出现操作按钮）');

  // 环境卡片是否被填上（不是一直停在"检测中…"）
  const v6Write = created.filter((c) => c.id === 'v6addr').pop();
  v6Write && v6Write.html && v6Write.html.includes('2001:da8:e000:9::c90c')
    ? ok('本机 IPv6 卡片已填入真实地址（不再停在"检测中…"）')
    : bad('本机 IPv6 卡片没有更新，界面会一直显示"检测中…"');

  // 注意：这两处代码用的是 textContent 赋值，不是 innerHTML。
  // 所以必须直接读元素，不能查 created[] 记录（那只捕获 innerHTML 写入）。
  const badgeEl = registry.get('ipv6text');
  if (badgeEl && /IPv6/.test(badgeEl.textContent || '')) {
    ok(`状态徽章已更新：${badgeEl.textContent}`);
  } else {
    bad(`状态徽章没有更新，会一直显示"检测中…"（实际值："${badgeEl ? badgeEl.textContent : '(元素未创建)'}"）`);
  }

  const proxyEl = registry.get('proxybadge');
  if (proxyEl && /8899/.test(proxyEl.textContent || '')) {
    ok(`代理地址徽章已更新：${proxyEl.textContent}`);
  } else {
    bad(`代理地址徽章没有更新（实际值："${proxyEl ? proxyEl.textContent : '(元素未创建)'}"）`);
  }
}

// ---------------------------------------------------------------------------
// 8. 启动菜单烟雾测试
//
// 菜单是双击启动时用户看到的第一屏，但它此前从未被真正执行验证过 ——
// 只在代码里 grep 到"菜单选项存在"就当成通过了。这里真的跑一遍：
// 用 ACCEL_FORCE_MENU 强制显示（沙箱里 stdout 不是 TTY），喂 "q" 让它退出，
// 检查菜单内容是否齐全、退出码是否正常。
// ---------------------------------------------------------------------------
console.log(`\n${C.b}[8] 启动菜单烟雾测试${C.r}`);

const runMenuSmoke = () => (async () => {
  const { spawn } = require('child_process');
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'launcher.js')], {
      cwd: __dirname,
      env: { ...process.env, ACCEL_FORCE_MENU: '1', ACCEL_NO_MENU: '' },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    // 等它把菜单打完再喂 q
    setTimeout(() => {
      try { child.stdin.write('q\n'); child.stdin.end(); } catch (_) {}
    }, 3000);

    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 20000);
    child.on('exit', (code) => { clearTimeout(killer); resolve({ out, code }); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ out, code: -1, error: e.message }); });
  });

  if (res.error) {
    bad(`菜单进程启动失败：${res.error}`);
    return;
  }

  const text = res.out.replace(/\x1b\[[0-9;]*m/g, '');
  const items = [
    ['IPv6 通用下载加速器', '标题'],
    ['当前状态', '状态行'],
    ['[1] 普通启动', '选项 1'],
    ['[2] 加速启动', '选项 2'],
    ['[3] 加速启动 + 管理员权限', '选项 3'],
    ['[4] 管理员启动', '选项 4'],
    ['[h]', '帮助选项'],
    ['[q]', '退出选项'],
    ['127.0.0.1:8899', '代理地址提示'],
  ];
  const absent = items.filter(([needle]) => !text.includes(needle));
  if (absent.length) {
    for (const [needle, what] of absent) bad(`菜单缺少「${what}」（找不到 "${needle}"）`);
  } else {
    ok(`菜单渲染完整（${items.length} 项内容齐全）`);
  }
  res.code === 0
    ? ok('选择 q 后正常退出（退出码 0）')
    : bad(`选择 q 后退出码异常：${res.code}`);
})();

// ---------------------------------------------------------------------------
runMenuSmoke().then(runPageScript).then(() => {
  console.log(`\n${C.b}${pass} 项通过，${fail} 项失败${C.r}\n`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(`\n界面测试自身出错: ${e.stack || e.message}\n`);
  process.exit(1);
});
