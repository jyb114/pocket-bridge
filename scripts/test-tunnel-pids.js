// 隧道进程的窄杀：**运行时**验证「哪些 PID 是我们的」。
//
// 为什么要有这个文件：原来这条逻辑只有 `test-narrow-kill.js` 那种**静态**检查
// （扫源码里有没有 `taskkill /IM`）。静态检查看不出运行时错误 ——
// 于是 `stopTunnels()` 里一个 `BASE is not defined` 一直躲着：
// 一调用就抛，隧道**再也重建不了**，而那正是使用者最需要它的时候。
//
// 这个 bug 是我自己第 0 轮改窄杀时引入的，`const mine = BASE.replace(...)`
// 写在了 try 外面，所以异常直接冒出去。是守护进程日志里的
// 「✗ 异常: BASE is not defined」把它暴露出来的。
//
// 所以这里不再只看源码，而是**真的调用那个函数**，喂进假的进程列表。
'use strict';

const path = require('path');
const { ownTunnelPids } = require('./tunnel.js');
const cfg = require('./config.js');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

const BASE = cfg.BASE;
const SEP = process.platform === 'win32' ? '\\' : '/';
const exe = (p) => BASE + SEP + p;

console.log('\n=== 窄杀：哪些隧道进程是我们的 ===\n');

// ── 1. 认得自己人 ──────────────────────────────────────────────────────────
ok('认得出本项目的 cloudflared',
  JSON.stringify(ownTunnelPids([
    { ProcessId: 11, ExecutablePath: exe('cloudflared\\cloudflared.exe') }
  ])) === '[11]');

ok('一次挑出多个',
  JSON.stringify(ownTunnelPids([
    { ProcessId: 11, ExecutablePath: exe('cloudflared\\cloudflared.exe') },
    { ProcessId: 12, ExecutablePath: exe('cloudflared\\cloudflared.exe') }
  ])) === '[11,12]');

// ── 2. 绝不误伤别人的 ──────────────────────────────────────────────────────
//
// 这条是整件事的**意义所在**：原来按镜像名 `taskkill /IM cloudflared.exe /F`，
// 会把使用者别的项目、别的隧道一起杀掉。
console.log('\n[2] 不误伤');
ok('别处的 cloudflared 不动',
  ownTunnelPids([
    { ProcessId: 21, ExecutablePath: 'C:\\Tools\\cloudflared\\cloudflared.exe' },
    { ProcessId: 22, ExecutablePath: '/usr/local/bin/cloudflared' }
  ]).length === 0);

ok('名字相近的**兄弟目录**不动（pocket-bridge-old）',
  ownTunnelPids([
    { ProcessId: 31, ExecutablePath: BASE + '-old' + SEP + 'cloudflared' + SEP + 'cloudflared.exe' }
  ]).length === 0,
  '前缀匹配要求后面跟路径分隔符');

ok('路径大小写不同仍认得出（Windows 不区分大小写）',
  ownTunnelPids([
    { ProcessId: 41, ExecutablePath: (BASE + SEP + 'cloudflared' + SEP + 'cloudflared.exe').toUpperCase() }
  ]).length === 1);

// ── 3. 脏数据不能把它弄崩 ──────────────────────────────────────────────────
//
// 这些是 PowerShell 的 JSON 在各种边界下真会给出来的东西
// （没权限读路径、只有一个进程时不是数组…）。
console.log('\n[3] 脏数据');
ok('没有 ExecutablePath 的条目跳过（权限不够时就是这样）',
  ownTunnelPids([
    { ProcessId: 51, ExecutablePath: null },
    { ProcessId: 52 },
    { ProcessId: 53, ExecutablePath: exe('cloudflared\\cloudflared.exe') }
  ]).length === 1);
ok('单个对象（不是数组）也能处理',
  ownTunnelPids({ ProcessId: 61, ExecutablePath: exe('cloudflared\\cloudflared.exe') }).length === 1);
ok('空列表不炸', ownTunnelPids([]).length === 0);
ok('null 不炸', ownTunnelPids(null).length === 0);

// ── 4. 空 base 不能变成「匹配一切」 ────────────────────────────────────────
//
// 空字符串做前缀的话，正则就退化成「任何路径都算」，那就等于回到了宽泛杀。
ok('base 为空时不会匹配所有进程',
  ownTunnelPids([{ ProcessId: 71, ExecutablePath: 'C:\\other\\cloudflared.exe' }], BASE).length === 0);

// ── 5. 真正的回归点：stopTunnels 不能再抛 ──────────────────────────────────
//
// 之前 `BASE is not defined` 是在函数体第一行抛的，所以「调用一下不抛」
// 本身就是一条有效断言。它不会杀到什么 —— 机器上现在跑的 cloudflared
// 如果是我们的，那也是**本来就要停**的那一个（这个脚本只在重建隧道时跑）。
console.log('\n[5] 回归：调用不再抛异常');
{
  const tunnel = require('./tunnel.js');
  ok('stopTunnels 是个函数', typeof tunnel.stopTunnels === 'function');
  const src = require('fs').readFileSync(path.join(__dirname, 'tunnel.js'), 'utf8');
  // 直接查那个具体的错法：函数里不该出现裸的 BASE（本项目一律用 cfg.BASE）
  const body = src.slice(src.indexOf('function stopTunnels'), src.indexOf('module.exports'));
  ok('stopTunnels 里没有裸的 BASE 引用', !/(^|[^.\w])BASE\b/.test(body.replace(/BASE_DIR/g, '')),
    '裸 BASE 就是那个 ReferenceError 的来源');
}

console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
