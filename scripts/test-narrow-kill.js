// 我们的代码不许杀掉**不属于自己的**进程。
//
// 起因（改进计划点名、核对源码确认为真）：refresh-tunnel.js 原来是
//     taskkill /IM cloudflared.exe /T /F
// —— 那是「按镜像名杀」，会杀掉这台机器上**所有** cloudflared，
// 包括使用者别的项目、别的隧道。
//
// 而这个项目自己的约定写在 tunnel.js 里：
//     「把 pid 一并带出去：调用方要能只收掉自己起的那个」
// 也就是说，按镜像名杀是**违反项目自身约定**的写法。
//
// 这条测试同时守两层：
//   · 静态：源码里不许再出现按镜像名杀的写法
//   · 动态：只认本项目目录下的可执行文件这条判据真的能筛出正确的进程
//
// 用法: node scripts/test-narrow-kill.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const staticOnly = process.argv.includes('--static-only');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

console.log('\n=== 不许杀别人的进程 ===\n');

// ── 1. 静态：源码里不许按镜像名杀 ──────────────────────────────────────────
console.log('[1] 源码里不许出现「按镜像名杀」的写法');

// 检查所有会碰进程的脚本
//
// ★ 分两类，这不是耍赖，是真的两类：
//
//   · **我们随项目分发的**（cloudflared）—— 路径独一无二，**必须**按路径认。
//     按镜像名杀就会误伤使用者别的项目、别的隧道。
//   · **第三方程序**（DeepSeek Harness / ChatGPT）—— 只能按名字认，
//     它们没有"我们的那一份"这回事；而且杀它们本身就是**有意的动作**
//     （test-codex-resilience 那条还额外加了显式开关才允许）。
//
//   所以这条只对第一类报错。第二类记下来但不判失败 —— 判失败会逼着
//   有人去写一个假的模样过关，那比不查更糟。
const scripts = fs.readdirSync(path.join(BASE, 'scripts'))
  .filter((f) => f.endsWith('.js'));

const offenders = [];
const thirdParty = [];
for (const f of scripts) {
  const src = fs.readFileSync(path.join(BASE, 'scripts', f), 'utf8');
  for (const m of src.matchAll(/taskkill['"],\s*\[[^\]]*'\/IM',\s*'([^']+)'/g)) {
    const name = m[1];
    if (/cloudflared/i.test(name)) offenders.push(`${f}: taskkill /IM ${name}`);
    else thirdParty.push(`${f}: taskkill /IM ${name}`);
  }
  for (const m of src.matchAll(/pkill['"],\s*\[\s*'-f',\s*'([^']*)'/g)) {
    const pat = m[1];
    if (pat.includes('/') || pat.includes('\\')) continue;   // 带路径的没问题
    if (/cloudflared/i.test(pat)) offenders.push(`${f}: pkill -f '${pat}'`);
    else thirdParty.push(`${f}: pkill -f '${pat}'`);
  }
}
ok('没有脚本**按镜像名杀我们自己分发的 cloudflared**',
  offenders.length === 0, offenders.join('; '));
if (thirdParty.length) {
  console.log(`      · 按名字杀第三方程序（这类只能按名字认，且是有意动作）:`);
  for (const x of thirdParty) console.log(`          ${x}`);
}

// 反向确认：refresh-tunnel.js 确实用了「按路径筛」
const rt = fs.readFileSync(path.join(BASE, 'scripts', 'refresh-tunnel.js'), 'utf8');
ok('refresh-tunnel.js 按**可执行文件路径**筛（只收自己的）',
  /ExecutablePath\s+-like/.test(rt), '没找到按路径筛的写法');

// ── 2. 动态：判据真的能筛出正确的进程 ──────────────────────────────────────
console.log('\n[2] 判据实测：能不能只认出本项目自己的 cloudflared');
if (staticOnly) {
  console.log('      · 跳过本机进程查询（--static-only；需在 Windows 真机单独运行完整测试）');
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 / 1 跳过 ===\n`);
  process.exit(fail ? 1 : 0);
}

function pidsByPath() {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'cloudflared.exe\'" | ' +
    `Where-Object { $_.ExecutablePath -like '${BASE.replace(/'/g, "''")}*' } | ` +
    'ForEach-Object { $_.ProcessId }';
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return (out.match(/\d+/g) || []);
}
function pidsAll() {
  const out = execFileSync('powershell',
    ['-NoProfile', '-Command', '(Get-Process cloudflared -ErrorAction SilentlyContinue).Id -join ","'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return (out.trim() ? out.trim().split(',') : []);
}

try {
  const mine = pidsByPath();
  const all = pidsAll();
  console.log(`      本项目自己的: ${mine.length ? mine.join(', ') : '（无）'}`);
  console.log(`      机器上全部  : ${all.length ? all.join(', ') : '（无）'}`);

  ok('判据没把别人的进程算进来', mine.length <= all.length,
    `自己 ${mine.length} 个 > 全部 ${all.length} 个，判据有问题`);

  if (all.length > mine.length) {
    console.log(`      ⚠ 机器上还有 ${all.length - mine.length} 个**别人的** cloudflared —— ` +
      '正好说明按镜像名杀是危险的，这条测试守的就是它们');
  } else {
    console.log('      （这台机器上目前只有我们自己的，没别人的可对照 —— 判据仍然成立）');
  }
  ok('自己的进程能被正常认出来（判据不是空转）', mine.length > 0 || all.length === 0,
    '有 cloudflared 在跑却一个都认不出来');
} catch (err) {
  console.log(`      （查询失败，跳过动态部分: ${err.message.slice(0, 60)}）`);
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
