// 「跑起来会不会在桌面上蹦出一个黑窗」—— 这条测试守它。
//
// 使用者 2026-09-26：「现在运行的时候，是否会跳出 cmd 窗口打断电脑工作。。
// 这个真的很烦啊」
//
// 这不是小事：网关会替使用者起子进程（启动 DSH / 启动 Codex 的 app-server /
// 重建隧道 / 探测安装了哪些程序…），Windows 上只要漏一个 `windowsHide: true`，
// 桌面上就会闪一个控制台窗口，或者**一直挂着一个黑窗**（app-server 是常驻的
// 控制台程序，最典型）。人正在写东西的时候被抢焦点，比功能坏掉还烦。
//
// 判据（故意做得窄，只看**运行期**那几个文件，避免测试文件的噪音）：
//   · 每个 child_process 调用（spawn / exec / execFile / *Sync）都必须带
//     `windowsHide: true`，或者：
//   · 是 powershell 且带 `-WindowStyle Hidden`，或者
//   · 明确标注了 `// windows-visible-ok`（真要给人看的窗口，比如打开控制台本身）。
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
// 运行期会起进程的文件（测试脚本不在此列：跑测试时人就在电脑前，且它们自己会开浏览器）
const FILES = [
  'scripts/mobile-proxy.js', 'scripts/targets.js', 'scripts/gateway-daemon.js',
  'scripts/refresh-tunnel.js', 'scripts/install-autostart.js', 'scripts/config.js',
  'scripts/open-console.js', 'scripts/codex-lock.js', 'scripts/first-run.js',
  'scripts/notify.js', 'scripts/webpush-notify.js', 'desktop/open-console-app.js',
  'desktop/open-desktop-app.js'
];

let pass = 0; let fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); } };

const CALL_RE = /(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/;

console.log('\n[1] 运行期起进程：窗口必须隐藏');
{
  const bad = [];
  let checked = 0;
  for (const rel of FILES) {
    const full = path.join(BASE, rel);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!CALL_RE.test(line)) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue;                 // 注释里的例子不算
      // POSIX 专属命令：Windows 上根本不会走到，不要求 windowsHide
      if (/['"]?(pkill|pgrep|open|launchctl|systemctl|xdotool|ps|killall)['"]?\s*,?\s*\[/.test(line) &&
        !/explorer|cmd|powershell|node/i.test(line)) continue;
      if (/child_process|require\(/.test(line) && !/\(/.test(line.replace(/require\([^)]*\)/, ''))) continue;
      // 这个调用的完整实参（从调用处往后最多 12 行，够覆盖多行 options）
      const chunk = lines.slice(i, i + 13).join('\n');
      // 截到这一条语句结束（分号 + 换行）为止，免得把下一个调用也算进来
      const stmt = chunk.split(/;\s*\n/)[0];
      if (/windowsHide\s*:\s*true/.test(stmt)) { checked++; continue; }
      if (/-WindowStyle\s+Hidden/.test(stmt)) { checked++; continue; }
      // 标记可以写在调用上方几行的注释里（解释往往要几行才说得清）
      if (/windows-visible-ok/.test(lines.slice(Math.max(0, i - 5), i + 1).join('\n'))) { checked++; continue; }
      // docker/explorer/open 这类 GUI 启动器没有控制台，但仍要求写 windowsHide，
      // 免得哪天命令换成控制台程序（写清楚比聪明更省事）
      bad.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
    }
  }
  ok(`运行期 ${checked} 处调用都带了隐藏窗口标记`, bad.length === 0, bad.slice(0, 6).join(' | '));
}

console.log('\n[2] 最要命的那一处：Codex app-server（常驻控制台程序）');
{
  const t = fs.readFileSync(path.join(BASE, 'scripts', 'targets.js'), 'utf8');
  const i = t.indexOf("'app-server'");
  ok('启动 app-server 时带 windowsHide',
    i > 0 && /windowsHide\s*:\s*true/.test(t.slice(i, i + 420)),
    '这一处漏了就会有一个黑窗一直挂在桌面上');
}

console.log('\n[3] 计划任务这一层也不弹窗（守护进程每 5 分钟跑一次）');
{
  const vbs = path.join(BASE, 'scripts', 'daemon-hidden.vbs');
  if (!fs.existsSync(vbs)) { ok('daemon-hidden.vbs 存在', false, '文件不在'); }
  else {
    const src = fs.readFileSync(vbs, 'utf8');
    ok('daemon-hidden.vbs 用 0 号窗口（完全隐藏）',
      /, \s*0\s*(,|\))/.test(src) || /,\s*0\s*,/.test(src), src.trim().slice(0, 80));
    // 任务定义要以**运行期的任务**为准：直接问 schtasks（源码里没有注册它的地方 ——
    // 这台机器上的任务是安装时建好的）。查不到就跳过，不硬判。
    let xml = '';
    try {
      xml = require('child_process').execFileSync('schtasks',
        ['/query', '/tn', '\\PocketBridge Gateway Watchdog', '/xml'],
        { encoding: 'utf8', timeout: 8000, windowsHide: true });
    } catch (e) { /* 没这个任务（别的机器/没装自启） */ }
    if (!xml) {
      console.log('  · 本机没有这个计划任务，跳过（没装开机自启时正常）');
    } else {
      ok('计划任务的命令是 wscript.exe（不是 node/cmd 裸跑）',
        /<Command>\s*wscript\.exe\s*<\/Command>/i.test(xml), xml.slice(0, 120));
      ok('计划任务指向 daemon-hidden.vbs（0 号窗口 = 全程不闪）',
        /daemon-hidden\.vbs/i.test(xml));
    }
  }
}

console.log(`\n${fail ? `${fail} 处问题` : '全部通过'}（${pass} 项）\n`);
process.exitCode = fail ? 1 : 0;
