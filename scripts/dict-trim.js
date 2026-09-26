// 只发使用者那一门语言：把我们自己文件里的另外两种语言**在服务端摘掉**。
//
// 目标：减小手机端语言包传输体积。
//
// 现状（实测）：我们自己写的每个文件都自带三语 ——
//   codex.html     字典 41,907 字节
//   console.html   字典 65,126 字节
//   boot.js        三语小表 7,640 字节
//   go.html        字典 4,696 字节（26 条）
//   first-load.js  三语小表 1,191 字节
// 而一次只用得上一门 —— 中文使用者更极端：**key 本身就是中文原文，一条字典都不需要**。
//
// 做法：网关照旧从磁盘读，发出去之前按当前语言摘掉多余的。客户端一行都不用改，
// 也不用多发请求（手机上那条隧道一个来回 2.8–5 秒，多一个请求比多几 KB 贵得多）。
//
// 两种形状（实测覆盖了我们全部文件）：
//   A. 语言在外层：`var TEXT = { zh: {…}, en: {…}, es: {…} };`（first-load / boot）
//      → 只留目标语言那一块
//   B. 语言在内层：`DshI18n.register({ '中文原文': { en: '…', es: '…' }, … });`
//      → 中文：整条删（key 就是中文）；英文：删 es 属性；西语：删 en 属性
//
// ★ 三条自我约束：
//   1. **不认识的写法一律不碰**（只处理形状明确匹配的块，其余原样）；
//   2. 改完做一次**语法检查**（new Function），不过就整份退回原文；
//   3. 结果按「文件 + 大小 + 修改时间 + 语言」缓存，不会每请求重解析。
'use strict';

const fs = require('fs');
const path = require('path');

const LANGS = ['zh', 'en', 'es'];

/**
 * 切出「代码 / 字符串 / 正则」几类片段（注释不参与匹配）。
 * 为什么要切：文案里就有 `{n}`、`{which}` 这种花括号，直接数大括号会把文件切坏。
 *
 * ★ 必须认**正则字面量** —— 实测踩过：console.html 里有 `/\{(\w+)\}/` 这种替换正则，
 *   不认它就会把 `\{` 当代码里的花括号，配平一错，整个字典只认出前 15 条
 *   （体积报告里 console.html 那一行 99% 就是它）。
 */
function scan(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let codeStart = 0;
  const pushCode = (end) => { if (end > codeStart) out.push({ type: 'code', s: codeStart, e: end }); };
  let prevSig = '';                       // 上一个有意义的字符（判断 / 是除号还是正则）
  const REGEX_OK_BEFORE = '(,=:[!&|?{};+-*%~^<>';
  while (i < n) {
    const c = src[i];
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      pushCode(i);
      const end = src[i + 1] === '/' ? (src.indexOf('\n', i) < 0 ? n : src.indexOf('\n', i)) : (src.indexOf('*/', i + 2) < 0 ? n : src.indexOf('*/', i + 2) + 2);
      out.push({ type: 'comment', s: i, e: end });
      i = end; codeStart = i; continue;
    }
    if (c === '/' && (prevSig === '' || REGEX_OK_BEFORE.indexOf(prevSig) >= 0)) {
      // 正则：扫到未转义的 /（字符类里的 / 不算），再吃 flags；认错就退回当除号
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; j++; break; }
        else if (d === '\n') break;       // 正则不跨行 —— 多半是除号
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j])) j++;
        pushCode(i);
        out.push({ type: 'regex', s: i, e: j });
        i = j; codeStart = i; prevSig = ')';
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      pushCode(i);
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      out.push({ type: 'str', s: i, e: j, quote: c });
      i = j; codeStart = i; prevSig = 'x';
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  pushCode(n);
  return out.sort((a, b) => a.s - b.s);
}

/** 从 abs 处的 '{' 找配对的 '}'（字符串不参与计数） */
function findClose(src, tokens, abs) {
  let depth = 0;
  for (const t of tokens) {
    if (t.type !== 'code') continue;
    if (t.e <= abs) continue;
    for (let k = Math.max(t.s, abs); k < t.e; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) return k; }
    }
  }
  return -1;
}

/** 把 from 起（含）到结束后第一个逗号删掉，返回新串；用于「删掉一个片段」 */
function cutRange(src, from, to) {
  let end = to;
  while (end < src.length && /\s/.test(src[end])) end++;
  if (src[end] === ',') end++;
  let start = from;
  // 前面若只剩空白 + 逗号，也一起吃掉，免得留下 `{,`
  let back = start - 1;
  while (back >= 0 && /\s/.test(src[back])) back--;
  if (src[back] === ',' && /^[\s,]*$/.test(src.slice(back + 1, start))) start = back;
  return src.slice(0, start) + src.slice(end);
}

/**
 * 形状 A：在对象体里摘掉若干「顶层 `name: { … }`」块。
 * @returns {{text:string, removed:number}}
 */
function stripKeyedBlocks(src, names) {
  const tokens = scan(src);
  let out = src;
  let removed = 0;
  for (const name of names) {
    const tokensNow = scan(out);
    let depth = 0;
    for (let t = 0; t < tokensNow.length; t++) {
      const tok = tokensNow[t];
      if (tok.type !== 'code') continue;
      for (let k = tok.s; k < tok.e; k++) {
        const ch = out[k];
        if (ch === '{') { depth++; continue; }
        if (ch === '}') { depth--; continue; }
        if (depth !== 0) continue;
        // 顶层位置：看是不是 `name :`
        const re = new RegExp(`^${name}\\s*:\\s*`, '');
        const slice = out.slice(k, k + name.length + 8);
        const m = re.exec(slice);
        if (!m) continue;
        const braceAt = k + m[0].length;
        if (out[braceAt] !== '{') continue;
        const close = findClose(out, tokensNow, braceAt);
        if (close < 0) continue;
        out = cutRange(out, k, close + 1);
        removed++;
        t = -1;              // 重新扫（偏移全变了，简单起见）
        break;
      }
      if (t === -1) break;
    }
  }
  return { text: out, removed };
}

/**
 * 形状 B：在 `DshI18n.register({ … })` 的对象体里裁条目。
 * @returns {{text:string, removed:number, note:string}}
 */
function trimRegisterDict(src, marker, mode) {
  // mode.dropEntry: true → 整条删（中文不在保留集里时用：key 本身就是中文）
  // mode.dropProp: 'en'|'es' → 只删该属性（中文要留时用）
  const dropEntry = !!(mode && mode.dropEntry);
  const dropProp = mode && mode.dropProp ? mode.dropProp : null;
  if (!dropEntry && !dropProp) return { text: src, removed: 0, note: '没说要丢什么' };
  const at = src.indexOf(marker);
  if (at < 0) return { text: src, removed: 0, note: '没有 ' + marker };
  const braceAt = src.indexOf('{', at + marker.length);
  if (braceAt < 0) return { text: src, removed: 0, note: '调用里没有对象' };
  let tokens = scan(src);
  const close = findClose(src, tokens, braceAt);
  if (close < 0) return { text: src, removed: 0, note: '大括号不配平' };

  // 顶层条目：字符串 + ':' + '{'
  const ranges = [];
  {
    let depth = 0;
    const body = src.slice(braceAt + 1, close);
    const toks = scan(body);
    for (let t = 0; t < toks.length; t++) {
      const tok = toks[t];
      if (tok.type === 'code') {
        for (let k = tok.s; k < tok.e; k++) {
          if (body[k] === '{') depth++;
          else if (body[k] === '}') depth--;
        }
        continue;
      }
      if (tok.type !== 'str' || depth !== 0) continue;
      // 紧接着是 `: {` 吗
      const after = body.slice(tok.e, tok.e + 12);
      const mm = /^\s*:\s*\{/.exec(after);
      if (!mm) continue;
      const innerBrace = tok.e + mm[0].length - 1;
      const innerClose = findClose(body, scan(body), innerBrace);
      if (innerClose < 0) continue;
      ranges.push({ entryFrom: tok.s, innerFrom: innerBrace + 1, innerTo: innerClose, entryTo: innerClose + 1 });
    }
  }
  if (!ranges.length) return { text: src, removed: 0, note: '一条条目都没认出来' };

  let out = src.slice(0, braceAt + 1) + src.slice(braceAt + 1, close) + src.slice(close);
  let removed = 0;
  for (const r of ranges.reverse()) {
    const base = braceAt + 1;
    if (dropEntry) {
      out = cutRange(out, base + r.entryFrom, base + r.entryTo);
      removed++;
      continue;
    }
    const drop = dropProp;
    const inner = out.slice(base + r.innerFrom, base + r.innerTo);
    const toks = scan(inner);
    let hit = null;
    for (const tok of toks) {
      if (tok.type !== 'code') continue;
      const m = new RegExp(`(^|,|\\s)${drop}\\s*:\\s*$`).exec(inner.slice(0, tok.e));
      if (!m) continue;
      // 值应当是紧随其后的字符串
      let v = tok.e;
      while (v < inner.length && /\s/.test(inner[v])) v++;
      const vTok = toks.find((x) => x.type === 'str' && x.s === v);
      if (!vTok) continue;
      hit = { from: tok.s + m[1].length, to: vTok.e };
      break;
    }
    // 兜底：值后面也可能直接跟字符串（code 片段只到冒号）
    if (!hit) {
      const m2 = new RegExp(`(^|[,{\\s])${drop}\\s*:\\s*(['"])`).exec(inner);
      if (m2) {
        const q = inner[m2.index + m2[0].length - 1];
        let j = m2.index + m2[0].length;
        while (j < inner.length) {
          if (inner[j] === '\\') { j += 2; continue; }
          if (inner[j] === q) { j++; break; }
          j++;
        }
        hit = { from: m2.index + m2[1].length, to: j };
      }
    }
    if (!hit) continue;
    out = cutRange(out, base + r.innerFrom + hit.from, base + r.innerFrom + hit.to);
    removed++;
  }
  return { text: out, removed, note: `${removed} 条（丢 ${dropEntry ? '整条' : dropProp}）` };
}

/** 语法自检（只对纯 JS 文件有意义） */
function parses(src) {
  try { new Function(src); return true; } catch (err) { return false; }   // eslint-disable-line no-new-func
}

const countOf = (s, needle) => s.split(needle).length - 1;
const balance = (s) => countOf(s, '{') - countOf(s, '}');

/**
 * 改完之后的自检 —— **不过就整份退回原文**。
 *
 * 纯 JS 文件直接交给 new Function 判语法；HTML 不行（整份 HTML 当然不是合法
 * 表达式，第一版就是这么翻车的：codex.html 改对了却被自检判死、整份回退，
 * 体积报告里那几行 -0 字节就是它）。HTML 用结构性判据：
 *   · 大括号收支必须和原文一致（切坏了通常立刻不等）
 *   · <script 标签数不能变
 *   · 目标语言必须还在（中文目标除外 —— key 本身就是中文）
 */
function verify(before, after, keep, isHtml) {
  if (isHtml) {
    if (balance(before) !== balance(after)) return false;
    if (countOf(before, '<script') !== countOf(after, '<script')) return false;
    if (countOf(before, '</script>') !== countOf(after, '</script>')) return false;
  } else if (!parses(after)) {
    return false;
  }
  // 要留的语言必须还在（中文的「在」= 那些 key 本身，不需要 en:/es: 属性）
  if (keep.indexOf('en') >= 0 && !/\ben\s*:\s*['"]/.test(after)) return false;
  if (keep.indexOf('es') >= 0 && !/\bes\s*:\s*['"]/.test(after)) return false;
  return true;
}

const cache = new Map();

/**
 * 按语言裁掉其它语言。不认识的形状、改坏了、语法不过 —— 一律原样返回原文。
 * @param {string} src 原始内容
 * @param {string} lang 'zh' | 'en' | 'es'
 * @param {string} [cacheKey] 缓存键（通常给 文件路径+mtime+大小）
 * @returns {{text:string, changed:boolean, note:string}}
 */
function trimToLanguage(src, lang, cacheKey, opts) {
  // lang 允许是一个数组（「这几门都留着」）—— 网关在 cookie 缺失时会保守一点：
  // 中文源 + 浏览器语言都留着，只摘第三门。理由见 mobile-proxy 里调用处的注释。
  const keep = (Array.isArray(lang) ? lang : [lang]).filter((l) => LANGS.indexOf(l) >= 0);
  if (!keep.length) return { text: src, changed: false, note: '语言不认识' };
  const isHtml = !!(opts && opts.isHtml);
  const key = cacheKey || null;
  if (key && cache.has(key)) return cache.get(key);
  const cacheLang = keep.join('+');          // 只用于缓存键和提示

  let text = src;
  const notes = [];

  // A：语言在外的两个小表
  for (const name of ['TEXT', 'NOTE_TEXT']) {
    if (!new RegExp(`(var|const|let)\\s+${name}\\s*=\\s*\\{`).test(text)) continue;
    const start = new RegExp(`(var|const|let)\\s+${name}\\s*=\\s*\\{`).exec(text);
    const braceAt = start.index + start[0].length - 1;
    const close = findClose(text, scan(text), braceAt);
    if (close < 0) continue;
    const body = text.slice(braceAt + 1, close);
    const r = stripKeyedBlocks(body, LANGS.filter((l) => keep.indexOf(l) < 0));
    if (r.removed) {
      const next = text.slice(0, braceAt + 1) + r.text + text.slice(close);
      if (parses(next)) { text = next; notes.push(`${name}: 摘 ${r.removed} 块`); }
    }
  }

  // B：DshI18n.register 的字典。
  //    key 就是中文原文，所以「中文要留」时不能整条删，只能摘掉 en / es 属性。
  if (text.indexOf('DshI18n.register(') >= 0) {
    try {
      let r = { text, removed: 0, note: '' };
      const drops = LANGS.filter((l) => keep.indexOf(l) < 0);
      // ★ 整条删**只对中文客户成立**：中文客户取词时根本不会查字典
      //   （key 本身就是中文原文，i18n.js 直接返回它）。而 en / es 客户必须留着
      //   条目 —— key 是中文原文，他们要靠它查到 en / es 那一条。
      //   （第一版把这个方向写反了：keep=['en'] 时整条删掉，自检发现 en 没了又
      //     整份退回，体积报告里那一行 -0 字节就是它。）
      const onlyZh = keep.length === 1 && keep[0] === 'zh';
      if (onlyZh) {
        r = trimRegisterDict(text, 'DshI18n.register(', { dropEntry: true });
      } else {
        // 中文要留 → 只能摘掉不要的那几门属性（逐门来，一门一次）
        for (const d of drops) {
          const rr = trimRegisterDict(r.text, 'DshI18n.register(', { dropProp: d });
          if (rr.removed) {
            r = { text: rr.text, removed: r.removed + rr.removed, note: '摘 ' + d + ' ' + rr.removed + ' 条' };
          }
        }
      }
      if (r.removed && r.text !== text && verify(src, r.text, keep, isHtml)) {
        text = r.text; notes.push('register: ' + r.note);
      }
    } catch (err) { notes.push('register 抛异常：' + err.message); }
  }

  const result = { text, changed: text !== src, note: (notes.join('；') || '没有可裁的形状') + ' [' + cacheLang + ']' };
  if (key) { cache.set(key, result); if (cache.size > 64) cache.clear(); }
  return result;
}

module.exports = { trimToLanguage, LANGS, scan, findClose };

// 直接跑：`node scripts/dict-trim.js` 打一份体积报告
if (require.main === module) {
  const BASE = path.join(__dirname, '..');
  const files = ['pwa/codex.html', 'pwa/console.html', 'pwa/go.html', 'pwa/boot.js', 'pwa/first-load.js', 'pwa/i18n.js'];
  const zlib = require('zlib');
  console.log('\n=== 语言包体积报告（原始 / brotli / 摘掉其它语言后）===\n');
  const tot = { raw: 0, rawZh: 0, br: 0, brZh: 0 };
  for (const f of files) {
    const src = fs.readFileSync(path.join(BASE, f), 'utf8');
    const raw = Buffer.byteLength(src, 'utf8');
    const br = zlib.brotliCompressSync(Buffer.from(src)).length;
    const zh = trimToLanguage(src, 'zh', f + '|report', { isHtml: /\.html$/.test(f) }).text;
    const rawZh = Buffer.byteLength(zh, 'utf8');
    const brZh = zlib.brotliCompressSync(Buffer.from(zh)).length;
    tot.raw += raw; tot.rawZh += rawZh; tot.br += br; tot.brZh += brZh;
    console.log(`  ${f.padEnd(20)} ${String(raw).padStart(7)} → ${String(rawZh).padStart(7)}  （-${String(raw - rawZh).padStart(6)} 字节，${Math.round((rawZh / raw) * 100)}%）` +
      `   br ${String(br).padStart(6)} → ${String(brZh).padStart(6)}`);
  }
  console.log(`  ${'合计'.padEnd(19)} ${String(tot.raw).padStart(7)} → ${String(tot.rawZh).padStart(7)}` +
    `  （-${tot.raw - tot.rawZh} 字节）   br ${tot.br} → ${tot.brZh} （-${tot.br - tot.brZh}）`);
}
