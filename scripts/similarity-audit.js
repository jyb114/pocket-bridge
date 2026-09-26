#!/usr/bin/env node
'use strict';

/**
 * similarity-audit —— 反抄袭自查工具（自己写的，用于证明自己没抄）
 *
 * 为什么需要它：
 *   我们说「没有任何一行代码来自别人」，这句话必须能被验证，不能只是嘴说。
 *   这个脚本把我们的源码和参考项目的源码做 k-gram 指纹比对，
 *   给出一个可复算的数字，并把最像的片段原样打印出来供人工判断。
 *
 * 原理（和查重系统一样，很朴素）：
 *   1. 去掉注释和多余空白 —— 注释不算「代码表达」，但字符串内容算。
 *   2. 切成 token 流，取连续 k 个 token 组成一个「指纹」(shingle)。
 *      k 取 14：太短会命中 `res.writeHead(200, {` 这类通用写法，
 *      太长则改写几个变量名就测不出来。
 *   3. containment(我们, 他们) = 我们有多少比例的指纹在他们那边出现过。
 *      这是单向的：我们抄了他们 -> 这个值必然高；反过来不成立。
 *
 * 判定阈值：
 *   < 0.5%  正常（巧合的通用写法）
 *   < 2%    需要人工看一眼命中的片段
 *   >= 2%   警告，必须逐条核对
 *
 * 用法：
 *   node scripts/similarity-audit.js
 *   REF_REPO=<路径> node scripts/similarity-audit.js     # 指定参考仓库
 *
 * 参考仓库不存在时直接跳过（退出码 0）——它不该成为构建的必要条件。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REF = process.env.REF_REPO || path.join(process.env.TEMP || '/tmp', 'saya-ref');

/**
 * 我们自己的源码。
 *
 * 覆盖范围刻意放宽到所有「有表达」的东西，而不只是代码：
 * 文档和 skill 说明同样可能无意中抄到别人的措辞，不扫就等于没查。
 * 故意排除：logs/（运行时数据）、runtime/（下载的 node）、
 *          desktop/ 里的二进制、以及一切 .zip。
 */
const OURS = [
  'scripts',
  'pwa',
  'skills',
  'desktop',
];

/** 扫描这些扩展名。.md 也算 —— 文档抄措辞一样是抄。 */
const OUR_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.md', '.ps1', '.cmd', '.bat', '.vbs', '.json']);

const REF_EXT = new Set(['.ts', '.js', '.mjs', '.kt', '.go']);

/** 注释和空白的处理。注意：字符串字面量原样保留，因为抄字符串也是抄。 */
function normalize(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // 字符串：原样保留（含引号），跳过里面的注释符
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 切 token。标识符、数字、字符串、运算符各算一个 token。
 * 故意不做 camelCase 拆分：那样会把 `writeHead` 和 `write_head` 判成一样，
 * 反而放松了标准。我们要的是「严」，宁可误报也不漏报。
 */
function tokenize(src) {
  const tokens = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`|([A-Za-z_$][A-Za-z0-9_$]*)|(\d+(?:\.\d+)?)|([^\sA-Za-z0-9_$]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1] !== undefined) tokens.push('"' + m[1] + '"');
    else if (m[2] !== undefined) tokens.push("'" + m[2] + "'");
    else if (m[3] !== undefined) tokens.push('`' + m[3] + '`');
    else if (m[4] !== undefined) tokens.push(m[4]);
    else if (m[5] !== undefined) tokens.push(m[5]);
    else tokens.push(m[6]);
  }
  return tokens;
}

const K = 14;

function shingles(tokens) {
  const set = new Set();
  for (let i = 0; i + K <= tokens.length; i++) {
    set.add(tokens.slice(i, i + K).join('\u0001'));
  }
  return set;
}

function walk(dir, filter, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'deprecated') continue;
      walk(p, filter, acc);
    } else if (filter(p)) {
      acc.push(p);
    }
  }
  return acc;
}

function buildIndex(files, root) {
  const shinglesByFile = new Map();
  const global = new Map(); // shingle -> [file,...] 只留第一个文件，省内存
  let totalTokens = 0;
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const toks = tokenize(normalize(src));
    if (toks.length < K) continue;
    totalTokens += toks.length;
    const sh = shingles(toks);
    const rel = path.relative(root, f).replace(/\\/g, '/');
    shinglesByFile.set(rel, sh);
    for (const s of sh) if (!global.has(s)) global.set(s, rel);
  }
  return { shinglesByFile, global, totalTokens };
}

/**
 * 把 REF 展开成「一组参考项目」。
 *
 * 这样一次就能对照全部同类项目，而不是只查一家 ——
 * 只跟一家比，只能证明「没抄那一家」，证明不了「没抄任何人」。
 * REF 指向单个仓库时就是 [REF]；指向一个装着多个仓库的目录时，就是那些子目录。
 */
function resolveRefs(ref) {
  if (!fs.existsSync(ref)) return [];
  const subs = fs.readdirSync(ref, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '.git')
    .map((e) => path.join(ref, e.name))
    .filter((p) => walk(p, (f) => REF_EXT.has(path.extname(f))).length > 0);
  return subs.length ? subs : [ref];
}

function main() {
  const refs = resolveRefs(REF);
  if (refs.length === 0) {
    // 退出码仍是 0（参考仓库不在本仓库里，拿不到是常态，红了只会训练人忽略它），
    // 但**必须让人一眼看出来它什么都没查**。
    //
    // 原来这里只打两行 [skip]，混在回归链几十行输出里根本认不出来 ——
    // 它显示为「ok」，而 THIRD-PARTY-NOTICES.md 里那个 0.0289% 的数字
    // 早就没法复现了，谁都没发现。
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────┐');
    console.log('  │ 这次没有做反抄袭审计 —— 参考仓库不存在                    │');
    console.log('  │ 脚本以退出码 0 结束，所以回归链里会显示成「通过」。        │');
    console.log('  │ 也就是说：**这一项这次没有验证任何东西**。                │');
    console.log('  │ 要真跑：REF_REPO=<参考仓库路径> node scripts/similarity-audit.js │');
    console.log('  └─────────────────────────────────────────────────────────┘');
    console.log('  （找不到的路径：' + REF + '）');
    console.log('');
    process.exit(0);
  }

  const ourFiles = [];
  for (const d of OURS) {
    walk(path.join(ROOT, d), (p) => OUR_EXT.has(path.extname(p)), ourFiles);
  }
  // 根目录下的文档也算（README / CHANGELOG / LEARN-FROM-OTHERS ...）
  for (const name of ['README.md', 'CHANGELOG.md', 'LEARN-FROM-OTHERS.md', 'PLAN-E2EE.md', 'SECURITY.md']) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) ourFiles.push(p);
  }

  const ours = buildIndex(ourFiles, ROOT);

  console.log('=== 反抄袭审计（k-gram 指纹比对）===');
  console.log('我们  ：' + ours.shinglesByFile.size + ' 个文件 / ' + ours.totalTokens + ' tokens');
  console.log('指纹长度 k = ' + K + ' tokens');
  console.log('');
  console.log('对照 ' + refs.length + ' 个同类项目：');
  console.log('');

  // 我们的指纹摊平成一张集合，逐个参考项目算 containment
  const ourAll = new Set();
  for (const sh of ours.shinglesByFile.values()) for (const s of sh) ourAll.add(s);

  const rows = [];
  const allRefShingles = new Map();  // 合并所有参考项目的指纹 -> 来源
  for (const ref of refs) {
    const files = walk(ref, (p) => REF_EXT.has(path.extname(p)));
    const idx = buildIndex(files, ref);
    for (const [s, f] of idx.global) if (!allRefShingles.has(s)) allRefShingles.set(s, path.basename(ref) + '/' + f);

    let hit = 0;
    const uniq = new Map();
    for (const s of ourAll) {
      if (!idx.global.has(s)) continue;
      hit++;
      if (!uniq.has(s)) uniq.set(s, idx.global.get(s));
    }
    const pct = ourAll.size === 0 ? 0 : (hit / ourAll.size) * 100;
    rows.push({ name: path.basename(ref), files: idx.shinglesByFile.size, tokens: idx.totalTokens, hit, uniq, pct });
  }

  rows.sort((a, b) => b.pct - a.pct);
  console.log('  ' + '项目'.padEnd(30) + '文件'.padStart(6) + 'tokens'.padStart(10) + '命中片段'.padStart(10) + 'containment'.padStart(14));
  for (const r of rows) {
    console.log('  ' + r.name.padEnd(30) + String(r.files).padStart(6) + String(r.tokens).padStart(10) +
      String(r.uniq.size).padStart(10) + (r.pct.toFixed(4) + '%').padStart(14));
  }

  // 合并口径：和「所有参考项目的并集」比。这是最严的算法 ——
  // 任何一家出现过就算命中，不给「从不同项目各抄一点」留缝。
  let unionHit = 0;
  const unionUniq = new Map();
  for (const s of ourAll) {
    if (!allRefShingles.has(s)) continue;
    unionHit++;
    if (!unionUniq.has(s)) unionUniq.set(s, allRefShingles.get(s));
  }
  const unionPct = ourAll.size === 0 ? 0 : (unionHit / ourAll.size) * 100;

  console.log('');
  console.log('我们的指纹总数                : ' + ourAll.size);
  console.log('对照全部项目（并集，最严口径）: ' + unionHit + ' 命中 / ' + unionUniq.size + ' 个片段');
  console.log('union containment             : ' + unionPct.toFixed(4) + '%');
  console.log('');

  const uniqueHits = unionUniq;
  const hit = unionHit;
  const pct = unionPct;

  if (uniqueHits.size > 0) {
    console.log('--- 命中的片段（逐条人工核对）---');
    let shown = 0;
    for (const [s, from] of uniqueHits) {
      const text = s.split('\u0001').join(' ');
      console.log('  ' + (++shown) + ') <-> ' + from);
      console.log('     ' + text);
      if (shown >= 40) break;
    }
    if (uniqueHits.size > shown) console.log('  ...还有 ' + (uniqueHits.size - shown) + ' 条未显示');
    console.log('');
    console.log('  提示：以下两种命中不算抄袭，属于「无法改写的公共写法」——');
    console.log('        · 协议常量（HTTP 报文格式、RFC 定义的状态行）');
    console.log('        · 平台规定的固定串（iOS viewport meta 等）');
    console.log('        除此之外的每一条都必须能解释清楚来源。');
    console.log('');
  }

  const verdict =
    pct < 0.5 ? '正常（共性写法，无抄袭迹象）' :
    pct < 2 ? '需人工看一眼命中片段' :
    '警告：重合度偏高，必须逐条核对';
  console.log('结论：' + verdict);

  // 退出码：只有明确偏高才失败，避免把巧合当错误
  process.exitCode = pct >= 2 ? 1 : 0;
}

main();
