// 文字对比度 —— 计划 H「焦点/对比度」的验收测试。
//
// 为什么要机器来算：对比度靠眼睛是看不出来的。这一轮实测就发现
// console.html 的「更淡的文字」`--dim2` 在深色底上只有 3.68:1、
// 浅色底 3.90:1 —— 都低于 WCAG AA 对正文要求的 4.5:1，
// 而它恰恰是给**最小号提示文字**用的，是最需要达标的那一层。
// 肉眼看只觉得「有点灰」，完全意识不到它已经不合规。
//
// 顺带查一个容易被忽略的：**层级不能倒过来**。
// 浅色那套原来是 dim 4.60、dim2 3.90 —— 数字看着都「比正文淡」，
// 但 dim2 其实比 dim 还深，视觉上的「更淡一级」根本没成立。
//
// 标准：WCAG 2.1 —— 正文 4.5:1，大字号 3:1。这里按**正文**要求，
// 因为这些色值会用在 11~13px 的提示文字上。
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const AA = 4.5;

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

function luminance(hex) {
  const c = hex.replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(c.substr(i, 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** 从页面里抠出每一组 :root 变量（深色一套、浅色一套） */
function palettes(file) {
  const src = fs.readFileSync(path.join(BASE, file), 'utf8');
  const out = [];
  for (const m of src.matchAll(/:root\{([^}]*)\}/g)) {
    const vars = {};
    for (const v of m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) vars[v[1]] = v[2];
    if (vars.bg && vars.fg) out.push({ vars, at: m.index });
  }
  return out;
}

// 每个页面声明自己遵守什么。
//
// `hierarchy` 只对**声明了「dim2 = 更淡一级」**的页面成立（console.html 是这样）。
// codex.html 的 dim2 是给 11~12px 的**标签**用的（小节标题、发言人、计划标题），
// 比 dim 亮是有意的 —— 标签要比装饰性的说明文字更清楚。
// 一开始我把「dim 必须比 dim2 显眼」写成了普遍规则，结果把 codex.html 判红，
// 那是**断言过头**，不是页面有问题。约定不同就分开声明，别用一条规则套所有页面。
const PAGES = [
  ['pwa/console.html', [['fg', '正文'], ['dim', '次要文字'], ['dim2', '更淡的文字']], { hierarchy: true }],
  ['pwa/codex.html', [['fg', '正文'], ['dim', '次要文字'], ['dim2', '标签文字']], { hierarchy: false }],
  ['pwa/go.html', [['fg', '正文'], ['dim', '次要文字']], { hierarchy: false }]
];

console.log('\n=== 文字对比度（WCAG AA 正文 4.5:1）===\n');

for (const [file, levels, opts] of PAGES) {
  if (!fs.existsSync(path.join(BASE, file))) continue;
  const sets = palettes(file);
  if (!sets.length) { console.log(`  · ${file} 里没找到 :root 调色板，跳过`); continue; }
  console.log(`  ${file}`);
  sets.forEach((set, i) => {
    const bg = set.vars.bg;
    const line = [];
    let worst = Infinity;
    for (const [key, label] of levels) {
      const c = set.vars[key];
      if (!c) continue;
      const r = ratio(c, bg);
      worst = Math.min(worst, r);
      line.push(`${label} ${r.toFixed(2)}:1${r >= AA ? '' : '✗'}`);
    }
    ok(`  第 ${i + 1} 套（底 ${bg}）`, worst >= AA, line.join('　'));
    // 层级只在声明了这条约定的页面上查
    if (opts.hierarchy && set.vars.dim && set.vars.dim2) {
      ok(`  第 ${i + 1} 套层级：次要 > 更淡`, ratio(set.vars.dim, bg) > ratio(set.vars.dim2, bg),
        `${ratio(set.vars.dim, bg).toFixed(2)} vs ${ratio(set.vars.dim2, bg).toFixed(2)}`);
    }
  });
}

// 焦点指示：键盘操作的可达性前提 —— 看不见焦点就没法用键盘
{
  console.log('\n  焦点可见性');
  const consoleSrc = fs.readFileSync(path.join(BASE, 'pwa/console.html'), 'utf8');
  ok('  控制台有 :focus-visible 描边', /:focus-visible/.test(consoleSrc));
  const codexSrc = fs.readFileSync(path.join(BASE, 'pwa/codex.html'), 'utf8');
  // 手机页是触摸优先，但接了键盘（iPad / 蓝牙键盘）也要能用
  ok('  手机页有 :focus-visible 兜底', /:focus-visible/.test(codexSrc),
    /:focus-visible/.test(codexSrc) ? '' : '手机页没有 —— 接了键盘就看不见焦点在哪');
}

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
