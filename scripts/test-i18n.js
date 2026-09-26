// 多语言覆盖检查 —— 抓「用到但没翻」和「翻了但缺语言」。
//
// 为什么要有这个：多语言做完之后**一条测试都没有**，所以下面这种漏翻
// 谁也发现不了 —— 控制台 renderDesktopSummary() 里写了一句硬编码的
// 『本机服务运行中』，它同时干了两件坏事：
//   1. 把 render() 已经算好的顶部结论（t('手机可以连')）盖掉了；
//   2. 绕过了 t()，切到英文/西班牙文时标题掉回中文。
// 两件事都是 browser-check 偶然撞出来的，不是主动查出来的。
//
// 这个脚本把字典**真的跑起来**（不是正则数数），再核对三件事：
//   A. 每个 t('…') / data-i18n 用到的键，字典里必须有
//   B. 每个条目的 en、es 都得有内容，且不能和中文原文一样（等于没翻）
//   C. 反过来也要看：字典里有没有再也没人用的死条目（只提醒，不判失败）
//
// 说明：只认字面量 t('…')。t(变量)、t('a'+b) 这种动态键这里看不见 ——
// 那是静态检查的边界，不是漏报，写在下面省得下次误以为是全覆盖。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const PAGES = ['console.html', 'codex.html', 'go.html'];
const LANGS = ['en', 'es'];

let bad = 0;
let warn = 0;
const fail = (msg) => { console.log(`  ✗ ${msg}`); bad++; };
const note = (msg) => { console.log(`  · ${msg}`); warn++; };

// ── 把 i18n.js 真跑起来，拿到 DshI18n ───────────────────────────────────────
function loadI18n() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.navigator = { languages: ['zh-CN'], language: 'zh-CN' };
  sandbox.localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  sandbox.document = { documentElement: {}, querySelectorAll: () => [], addEventListener: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(BASE, 'pwa', 'i18n.js'), 'utf8'), sandbox, { filename: 'i18n.js' });
  if (!sandbox.DshI18n) throw new Error('i18n.js 跑完没有挂上 DshI18n');
  return sandbox;
}

// ── 从 register( … ) 里把对象字面量整段抠出来（要数括号，不能靠正则）──────
// 实现搬到了 i18n-dict.js —— test-release-lock.js 也要用它。
const { extractRegisterArg } = require('./page-source.js');

// ── 页面上真正用到的键：t('…') 和 data-i18n* 属性 ──────────────────────────
//
// 三个坑都是这脚本自己踩出来的，写在这儿免得下次又绕回去：
//
//   1. **字面量必须按 JS 规则解释，不能拿源码原样去比。**
//      源码里写的是 \n（反斜杠 + n），而字典是 vm 跑出来的、里面已经是
//      真换行。两种写法硬碰，所有含转义的长句都会误报「没翻」——
//      第一版就因此误报了 29 条，其中一条（换一个新主题？…）明明在字典里。
//      所以这里把整段字面量丢回 vm 解释，和字典走同一套规则。
//
//   2. **HTML 属性值要解码实体。** data-i18n="&lt;b&gt;ntfy&lt;/b&gt;…" 在浏览器里
//      getAttribute() 拿到的是 <b>ntfy</b>…，字典存的也是解码后的那份。
//
//   3. **注释要跳过。** 注释里写「不要这么写：t('已' + 按钮文字」这种
//      反面教材，会被当成真代码报出来 —— 第一版就是这么自我误报的。
//      这里用「整行是不是注释」这个便宜判据，**故意不用**带状态的扫描器：
//      扫描器一旦被正则字面量里的引号带偏，就会把真代码当注释吃掉，
//      那是漏报 —— 对覆盖检查来说，漏报比误报危险得多。
//      代价：行尾注释里写的例子仍会误报。见到了就换行写，别改判据。
function usedKeys(src, sandbox) {
  const keys = new Map(); // key -> 首次出现的行号
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const lines = src.split('\n');
  const inComment = (idx) => {
    const text = (lines[lineOf(idx) - 1] || '').trim();
    return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');
  };
  const add = (k, idx) => { if (k && !inComment(idx) && !keys.has(k)) keys.set(k, lineOf(idx)); };
  const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (const m of src.matchAll(/(?<![\w$.])t\(\s*('(?:[^'\\]|\\.)*')/g)) {
    let k;
    try { k = vm.runInContext(`(${m[1]})`, sandbox); } catch (err) { continue; }
    add(k, m.index);
  }
  for (const m of src.matchAll(/data-i18n[a-z-]*\s*=\s*"([^"]*)"/g)) add(decode(m[1]), m.index);
  for (const m of src.matchAll(/data-i18n[a-z-]*\s*=\s*'([^']*)'/g)) add(decode(m[1]), m.index);
  return keys;
}

// ── 校验单页 ───────────────────────────────────────────────────────────────
const sandbox = loadI18n();
const allUsed = new Map();

for (const page of PAGES) {
  const file = path.join(BASE, 'pwa', page);
  const src = fs.readFileSync(file, 'utf8');
  const arg = extractRegisterArg(src);
  if (!arg) { fail(`${page}：找不到 DshI18n.register({…})`); continue; }

  // 每页用干净的字典，互不串味
  sandbox.DshI18n.dict && Object.keys(sandbox.DshI18n.dict).forEach((k) => delete sandbox.DshI18n.dict[k]);
  let dict;
  try {
    dict = vm.runInContext(`(${arg})`, sandbox, { filename: `${page}:register` });
  } catch (err) {
    fail(`${page}：字典解析失败 —— ${err.message}`);
    continue;
  }
  const before = Object.keys(sandbox.DshI18n.dict).length;
  sandbox.DshI18n.register(dict);
  const keys = Object.keys(sandbox.DshI18n.dict);

  const used = usedKeys(src, sandbox);
  for (const k of used.keys()) allUsed.set(k, true);

  // A. 用到的键必须在字典里
  const missing = [...used.keys()].filter((k) => !sandbox.DshI18n.dict[k]);
  // B. 每条得有 en/es，且不能等于中文原文
  const incomplete = [];
  for (const k of keys) {
    const e = sandbox.DshI18n.dict[k] || {};
    for (const lg of LANGS) {
      const v = e[lg];
      // 纯符号的键（「　+　」「　·　」这种）英西文和中文相同是**对的**，
      // 不该判失败 —— 只有含汉字的才存在「翻没翻」的问题。
      const hasHan = /[\u4e00-\u9fff]/.test(k);
      if (typeof v !== 'string' || !v.trim()) incomplete.push(`${k} → 缺 ${lg}`);
      else if (hasHan && v.trim() === k.trim()) incomplete.push(`${k} → ${lg} 与中文原文相同`);
    }
  }

  const okLine = !missing.length && !incomplete.length;
  console.log(`  ${okLine ? '✓' : '✗'} ${page}：用到 ${used.size} 个键 / 字典 ${keys.length} 条` +
    (before ? `（注册前已有 ${before} 条，未清空）` : ''));
  if (missing.length) {
    // 带上行号和短标签：长句确认框的键有上百字，整条打出来没法看。
    const show = missing.map((k) => `${page}:${used.get(k)} ${JSON.stringify(k.slice(0, 26))}${k.length > 26 ? '…' : ''}`);
    fail(`${page}：${missing.length} 个键用到但没翻 →\n      ${show.slice(0, 12).join('\n      ')}` +
      (missing.length > 12 ? `\n      …还有 ${missing.length - 12} 个` : ''));
  }
  if (incomplete.length) {
    fail(`${page}：${incomplete.length} 处翻译不完整 → ${incomplete.slice(0, 8).join(' | ')}` +
      (incomplete.length > 8 ? ` …还有 ${incomplete.length - 8} 处` : ''));
  }
}

// C. 死条目只提醒：字典里有、但三个页面都没再用到
const dead = [...new Set(
  PAGES.flatMap((p) => {
    const arg = extractRegisterArg(fs.readFileSync(path.join(BASE, 'pwa', p), 'utf8'));
    if (!arg) return [];
    const keys = [];
    const re = /^\s{2,}'((?:[^'\\]|\\.)*)'\s*:/gm;
    for (const m of arg.matchAll(re)) {
      // 和 usedKeys 一样**按 JS 规则解释**再比。
      // 不然 '\n上次检查：' 这种带转义的键会拿原始文本（反斜杠+n）去和
      // 解释过的用过键（真换行）比，永远对不上，于是被误报成死条目 ——
      // 一个会说假话的提醒比没有提醒更糟。
      let k;
      try { k = vm.runInContext(`('${m[1]}')`, sandbox); }
      catch (err) { k = m[1].replace(/\\'/g, "'"); }
      keys.push(k);
    }
    return keys;
  })
)].filter((k) => !allUsed.has(k));
if (dead.length) note(`${dead.length} 条字典项没有任何页面用到（不是错，但可以清）：${dead.slice(0, 8).join(' | ')}${dead.length > 8 ? ' …' : ''}`);

console.log(`\n${bad ? `${bad} 处问题` : '全部通过'}${warn ? `（${warn} 条提醒）` : ''}\n`);
process.exitCode = bad ? 1 : 0;
