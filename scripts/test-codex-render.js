// 消息渲染的两处健壮性（都是使用者手机上看到的实实在在的坏样子）：
//
// ① 一整条消息显示成「[object Object]」（2026-09-26 截图）。
//    服务端某个字段是对象 / {text:…} 数组时，渲染直接字符串拼接就成了它。
// ② 正文里的 markdown 链接指向本地文件时点不动：
//    「[验证报告](D:/Example Project/reports/REPORT.md)」
//    在手机上就是一堆括号。而「打开/下载这个文件」的能力我们早就有
//    （data-filecite 那套，走加密取回）——同一个按钮直接复用即可。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
const { extractFunction } = require('./page-source.js');

let pass = 0; let fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); } };

function sandbox() {
  const box = {
    esc: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (s) => s,
    baseName: (p) => String(p).split(/[\\/]/).pop(),
    String, RegExp, Number, Array, Object, JSON, Error
  };
  vm.createContext(box);
  for (const fn of ['asText', 'parseCitations', 'citationButtonHtml', 'fmt', 'baseName']) {
    try { vm.runInContext(extractFunction(SRC, fn), box); } catch (e) { }
  }
  return box;
}

console.log('\n[1] asText：别再让 [object Object] 出现在界面上');
{
  const box = sandbox();
  ok('字符串原样', box.asText('一段话') === '一段话');
  ok('null / undefined → 空串', box.asText(null) === '' && box.asText(undefined) === '');
  ok('数字也能读', box.asText(42) === '42');
  ok('对象里有 text：取 text', box.asText({ text: '真正的内容' }) === '真正的内容');
  ok('对象里有 content：取 content', box.asText({ content: '正文' }) === '正文');
  ok('数组：[{text}] 这种也能读', box.asText([{ text: 'A' }, { text: 'B' }]) === 'A\nB');
  ok('字符串数组（reasoning 那种）', box.asText(['第一行', '第二行']) === '第一行\n第二行');
  const unknown = box.asText({ foo: 1, bar: 'x' });
  ok('认不出来的对象：显示 JSON（而不是 [object Object]）',
    /\{/.test(unknown) && !/\[object Object\]/.test(unknown), unknown.slice(0, 60));
  ok('嵌套对象不会漏出 [object Object]',
    !/\[object Object\]/.test(box.asText({ a: { b: 1 } })), box.asText({ a: { b: 1 } }));
}

console.log('\n[2] 渲染：消息正文不再出现 [object Object]');
{
  const box = sandbox();
  const cases = [
    ['agent 的 text 是对象', { text: { text: '真实正文' } }],
    ['agent 的 text 是数组', { text: [{ text: '第一段' }, { type: 'x', text: '第二段' }] }],
    ['未知类型且 text 是对象', { type: 'somethingNew', text: { a: 1 } }]
  ];
  ok('buildAgent 用 asText 读 text（源码级）',
    /function buildAgent[\s\S]{0,120}asText\(item\.text\)/.test(SRC));
  ok('未知类型分支用 asText（源码级）',
    /buildNote\(asText\(item\.type\)/.test(SRC));
  ok('用户消息的 content 也走 asText（源码级）',
    /map\(function \(c\) \{ return asText\(c\.text\); \}\)/.test(SRC));
  void cases; void box;
}

console.log('\n[3] markdown 本地链接 → 可点的文件按钮');
{
  const box = sandbox();
  const html = box.fmt('见 [验证报告](D:/Example Project/reports/REPORT.md) 这份');
  ok('变成了按钮', /class="filecite"/.test(html), html.slice(0, 140));
  ok('带上了路径', /data-filecite="D:\/Example Project\/reports\/REPORT\.md"/.test(html));
  ok('保留了人写的标题（不是只剩文件名）', /验证报告/.test(html));
  ok('周围的正文还在', /见 /.test(html) && /这份/.test(html));
  ok('不再露出那对括号', !/\]\(D:/.test(html));

  const rel = box.fmt('打开 [报告](docs/R3/REPORT.md) 看看');
  ok('相对路径也认', /data-filecite="docs\/R3\/REPORT\.md"/.test(rel), rel.slice(0, 120));

  const spaced = box.fmt('打开 [最终报告](D:/My Project/reports/Final Report (v2).md) 看看');
  ok('本地路径中的空格和括号完整保留',
    /data-filecite="D:\/My Project\/reports\/Final Report \(v2\)\.md"/.test(spaced), spaced.slice(0, 180));

  const angle = box.fmt('打开 [最终报告](<D:/My Project/reports/Final Report (v2).md>) 看看');
  ok('尖括号包裹的带空格路径也变成文件按钮',
    /data-filecite="D:\/My Project\/reports\/Final Report \(v2\)\.md"/.test(angle), angle.slice(0, 180));

  const relativeSpace = box.fmt('打开 [相对报告](docs/Final Report (review).md) 看看');
  ok('相对路径中的空格和括号也保留',
    /data-filecite="docs\/Final Report \(review\)\.md"/.test(relativeSpace), relativeSpace.slice(0, 180));

  const nested = box.fmt('[报告](D:/My Project/report (rev (2)).md)');
  ok('嵌套括号不截断文件名',
    /data-filecite="D:\/My Project\/report \(rev \(2\)\)\.md"/.test(nested), nested.slice(0, 180));

  const multiple = box.fmt('[第一份](docs/a (1).md) 和 [第二份](D:/My Project/b.md)');
  ok('一行两个本地链接都变成独立按钮',
    (multiple.match(/class="filecite"/g) || []).length === 2 &&
    /data-filecite="docs\/a \(1\)\.md"/.test(multiple) &&
    /data-filecite="D:\/My Project\/b\.md"/.test(multiple), multiple.slice(0, 220));

  const web = box.fmt('参考 [文档](https://example.com/a.md) 和 [站点](https://example.com)');
  // 网页链接会被渲染成真正的 <a>（既有功能），这里只要求它**不许**变成文件按钮
  ok('http(s) 链接不变成文件按钮（那是网页，交给浏览器）',
    !/filecite/.test(web) && /<a href="https:\/\/example\.com\/a\.md"/.test(web), web.slice(0, 140));

  const mail = box.fmt('[写邮件](mailto:a@b.com)');
  ok('mailto 之类带协议的也不动', !/filecite/.test(mail), mail.slice(0, 80));

  const inline = box.fmt('代码里 `[x](D:/a/b.md)` 不该变成按钮');
  ok('行内代码里的不认（先用代码块占位符保护过了）', !/filecite/.test(inline), inline.slice(0, 120));

  const codeWithSpaces = box.fmt('代码里 `[x](<D:/My Project/report (v2).md>)` 不该变成按钮');
  ok('带空格的本地链接在行内代码里也不转换', !/filecite/.test(codeWithSpaces), codeWithSpaces.slice(0, 160));
}

console.log(`\n${fail ? `${fail} 处问题` : '全部通过'}（${pass} 项）\n`);
process.exitCode = fail ? 1 : 0;
