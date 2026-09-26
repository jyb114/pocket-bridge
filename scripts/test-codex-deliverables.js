// Codex 交付文件：`:codex-file-citation{...}` 要变成能点的下载按钮。
//
// 一个含中文目录的文件引用原样显示时，用户无法点按下载：
//   :codex-file-citation{path="D:/示例项目/example.docx" purpose="output"}
// —— 这一页原来完全不认这个标记，所以它只是一串看不懂的符号，点也点不动。
//
// 顺便守一条：上传那条 403 不能一律翻译成「登录已过期，请重新配对」。
// 进门验证（x-dsh-need-proof）是**暂时的**，说成「重新配对」会把在外面的人吓死
// （实际故障时用户可能无法在电脑前重新配对）。
//
// 跑法: node scripts/test-codex-deliverables.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
const { extractFunction } = require('./page-source.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

console.log('\n=== Codex 交付文件 · 回归 ===\n');

// ── ① 源码级：函数和接线都在 ────────────────────────────────────────────────
console.log('[1] 接线');
{
  for (const fn of ['parseCitations', 'citationButtonHtml', 'downloadDeliverable', 'baseName']) {
    ok(`有 ${fn}()`, new RegExp(`function ${fn}\\(`).test(SRC));
  }
  ok('fmt() 会把标记换成占位符再还原',
    /parseCitations\(src0\)/.test(SRC) && /u0000C\(\\d\+\)/.test(SRC.replace(/\\\\/g, '\\')));
  ok('点击是事件委托（正文每次重画都不用重挂）',
    /addEventListener\('click', function \(ev\) \{[\s\S]{0,400}data-filecite/.test(SRC));
  ok('下载走 privateFetch（经中继必须加密，普通 <a href> 会被闸门拒掉）',
    /downloadDeliverable[\s\S]{0,600}privateFetch\('\/codex\/file\?path='/.test(SRC));
  ok('有 .filecite 的样式', /\.bub \.filecite\{/.test(SRC));
  ok('403 且带 x-dsh-need-proof 时不再说「重新配对」',
    /headers\.get\('x-dsh-need-proof'\)==='1'[\s\S]{0,120}正在验证这台设备/.test(SRC));
}

// ── ② 抠出真函数，在 vm 里跑 ────────────────────────────────────────────────
function sandbox() {
  const box = {
    esc: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (s) => s,
    String, RegExp, Number, Array, Object, JSON
  };
  vm.createContext(box);
  for (const fn of ['parseCitations', 'baseName', 'citationButtonHtml']) {
    vm.runInContext(extractFunction(SRC, fn), box);
  }
  return box;
}

console.log('\n[2] 解析标记');
{
  const box = sandbox();
  const one = box.parseCitations(':codex-file-citation{path="D:/示例项目/a.docx" purpose="output"}');
  ok('认得出一个标记', one.length === 1, JSON.stringify(one));
  ok('路径解析正确（中文与外层引号都行）', one[0] && one[0].path === 'D:/示例项目/a.docx', JSON.stringify(one[0]));
  ok('purpose 也读出来了', one[0] && one[0].purpose === 'output');

  const single = box.parseCitations(":codex-file-citation{path='C:/x/y z.svg' purpose='output'}");
  ok('单引号 / 路径里有空格也能认', single[0] && single[0].path === 'C:/x/y z.svg', JSON.stringify(single));

  const many = box.parseCitations('前 :codex-file-citation{path="a.docx"} 中 :codex-file-citation{path="b.svg"} 后');
  ok('一行里两个标记都认出来', many.length === 2, JSON.stringify(many));
  ok('第二个的位置是对的', many[1] && many[1].at > many[0].at);

  ok('没有 path 的标记直接忽略', box.parseCitations(':codex-file-citation{purpose="output"}').length === 0);
  ok('普通文字不受影响', box.parseCitations('就是一段话').length === 0);
}

console.log('\n[3] 渲染成按钮');
{
  const box = sandbox();
  const html = box.citationButtonHtml('D:/示例项目/example.docx', 'output');
  ok('是一个 button', /^<button /.test(html) && /data-filecite="/.test(html), html.slice(0, 80));
  ok('显示的是文件名（不是整条路径）', /example\.docx</.test(html), html.slice(0, 120));
  ok('整条路径放在 title 里（长按/悬停能看到）', /title="D:\/示例项目/.test(html));
  ok('按钮上写着「下载交付文件」', /下载交付文件/.test(html));
  ok('非 output 的写成「打开文件」', /打开文件/.test(box.citationButtonHtml('a/b.png', '')));
  ok('路径里的引号被转义（不会把属性截断）',
    /data-filecite="[^"]*&quot;[^"]*"/.test(box.citationButtonHtml('a/"weird".txt', 'output')));
}

console.log('\n[4] fmt() 集成（标记不再原样露出来）');
{
  const box = sandbox();
  box.blocks = [];
  vm.runInContext(extractFunction(SRC, 'fmt'), box);
  // fmt 依赖 blocks / clip 之类的闭包变量；这里补最小的一份
  vm.runInContext('var blocks = [];', box);
  const out = vm.runInContext(`fmt('最新版正文：:codex-file-citation{path="D:/示例项目/example.docx" purpose="output"}；两图已嵌入。')`, box);
  ok('不再有原始标记', out.indexOf(':codex-file-citation') < 0, out.slice(0, 120));
  ok('变成了可点的按钮', /class="filecite"/.test(out), out.slice(0, 160));
  ok('路径带在按钮上', /data-filecite="D:\/示例项目\/example\.docx"/.test(out), out.slice(0, 200));
  ok('周围的正文保留着', /最新版正文/.test(out) && /两图已嵌入/.test(out));
}

console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
