// 回归链的完整性 —— 防的是「链里有步骤其实什么都没验」。
//
// 为什么需要它：这一类问题**已经出现过三次**，每次都是人工翻出来的：
//
//   1. similarity-audit  —— 参考仓库不存在时打印 [skip] 然后 exit 0，
//                           链里显示「ok」，其实什么都没查
//   2. tunnel.js 的窄杀  —— 只有**静态**检查（扫源码里有没有 taskkill /IM），
//                           运行时从没跑过，于是 `BASE is not defined` 躲了很多轮，
//                           隧道一死就再也重建不了
//   3. test-compat / test-config / test-polyfill —— 只把结果写进 JSON，
//                           不打印、不设退出码，失败也照样「ok」
//
// 三次的共同点：**检查有没有真的在验，没有任何东西在管**。
//
// 这个脚本就是管这件事的，而且**故意做成静态的**：真跑一遍链要十几分钟，
// 那样它就没法成为链里的一步（而它恰恰最该在链里）。静态判据足够抓住
// 上面第 3 类 —— 那三个脚本的特征是「零 console.log、零 exitCode」。
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8'));

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

// 链里的脚本清单（从 package.json 现读，不写死 —— 写死的话加了新步骤它也不知道）
const chain = String(pkg.scripts.test || '');
const names = [...new Set([...chain.matchAll(/scripts\/([\w-]+)\.js/g)].map((m) => m[1]))];

console.log('\n=== 回归链的完整性 ===\n');
console.log(`  链里有 ${names.length} 个脚本\n`);

// ── 1. 链里提到的脚本都要存在 ───────────────────────────────────────────────
{
  const missing = names.filter((n) => !fs.existsSync(path.join(BASE, 'scripts', `${n}.js`)));
  ok('链里提到的脚本都存在', missing.length === 0, missing.join(', '));
}

// ── 2. 每个脚本都要有「能说话」的机制 ───────────────────────────────────────
//
// 判据放宽到「几种里有任意一种」，因为项目里有几种合理写法：
//   · console.log / console.error  —— 打印结论
//   · process.stdout.write         —— 同上（self-check / security-audit 用这种）
//   · ok( / check( / assert        —— 断言助手（内部会打印）
//   · process.exitCode / exit      —— 至少能把失败传出去
// 一个都没有的，**失败了也没人知道** —— 那就是要抓的。
//
// （第一版漏了 `process.stdout.write`，于是把 self-check 和 security-audit
//   误判成「不说话」。**判据太窄会误报，和太宽会漏报一样糟** ——
//   一个会冤枉好脚本的检查，很快就会被当成噪音。所以这里宁可多列几种写法。）
{
  const mute = [];
  for (const n of names) {
    const p = path.join(BASE, 'scripts', `${n}.js`);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const speaks = /console\.(log|error|warn)\s*\(/.test(src)
      || /process\.stdout\.write\s*\(/.test(src)
      || /\b(ok|check|assert)\s*\(/.test(src)
      || /process\.exitCode\s*=/.test(src)
      || /process\.exit\(/.test(src);
    if (!speaks) mute.push(n);
  }
  ok('链里每个脚本都会说话（能打印结论或设退出码）', mute.length === 0,
    mute.length ? `${mute.join(', ')} —— 它们失败了也会显示「ok」` : `${names.length} 个都查了`);
}

// ── 3. 链里不该混进「明确会跳过」的检查而不自知 ─────────────────────────────
//
// similarity-audit 那一类的特征：脚本里有一条**静默跳过**的路径
// （打印 skip 之后 exit 0）。这不一定是错的（参考仓库本来就不在仓库里），
// 但链里应该知道有这一步 —— 所以这里只报出来，不判失败。
{
  const silentSkips = [];
  for (const n of names) {
    const p = path.join(BASE, 'scripts', `${n}.js`);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    // 「跳过」+「exit 0」在附近出现
    for (const m of src.matchAll(/process\.exit\(0\)/g)) {
      const ctx = src.slice(Math.max(0, m.index - 400), m.index);
      if (/跳过|不存在|没有做|skip/i.test(ctx)) { silentSkips.push(n); break; }
    }
  }
  if (silentSkips.length) {
    console.log(`  · 有 ${silentSkips.length} 个脚本带「静默跳过」路径（不判失败，但要心里有数）：`);
    console.log(`      ${[...new Set(silentSkips)].join(', ')}`);
    console.log('      它们跳过时退出码是 0，链里会显示「ok」。设计如此（比如参考仓库不在仓库里），');
    console.log('      但**别把它们的绿灯当成「这一项验过了」**。');
  } else {
    console.log('  · 没有静默跳过的脚本');
  }
}

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
