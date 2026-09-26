// 刷新隧道地址 —— 控制台上那个按钮干的事。
//
// 为什么要它：免费 Cloudflare 快速隧道会被回收（今天就发生过一次：
//   ERR Register tunnel error: "Unauthorized: Tunnel not found"
// 而本机的 cloudflared 还在傻等，域名已经指向空气 —— 手机怎么都打不开）。
// 这时候唯一的出路是**重建一条隧道**，拿到新地址，再把它告诉手机。
//
// 原来控制台上那个「刷新隧道」按钮只会回一句
//   「隧道由启动器管理。请在命令行运行 gateway-daemon.js」
// —— 那不是操作说明，那是把活推给使用者。
//
// 这个脚本做的事：杀掉卡死的 cloudflared → 跑守护进程建一条新的 →
// 守护进程发现地址变了会自动往手机推一条带一次性链接的通知。
//
// 用法（由中间层按钮调用，不给人用）：
//   node scripts/refresh-tunnel.js [--port 8080]
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const DAEMON_LOG = path.join(LOG_DIR, 'daemon.log');
// 命名隧道重连后 hostname 本来就不会变；不能拿「URL 变了」当成功判据。
const EXPECT_SAME_ADDRESS = process.argv.includes('--expect-same-address');

function log(msg) {
  const line = `${new Date().toISOString()} [刷新隧道] ${msg}\n`;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(DAEMON_LOG, line); }
  catch (err) { /* 日志失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const FILE = path.join(LOG_DIR, 'last-tunnel-url.txt');
  let before = '';
  try { before = fs.readFileSync(FILE, 'utf8').trim(); } catch (err) { }

  // 1. 等调用方的 HTTP 响应先发出去 —— 不然使用者看到一个"点完没反应"的页面
  await sleep(1200);

  // 2. 杀掉**我们自己的** cloudflared（它卡死了，或者我们正要换一条）
  //
  //    ★ 这里原来写的是 `taskkill /IM cloudflared.exe /T /F` ——
  //      那会杀掉这台机器上**所有** cloudflared，包括别的项目、别的隧道。
  //      使用者很可能同时跑着别的东西（他本来就挂着代理和一堆工具），
  //      我们没有任何理由去动不属于自己的进程。
  //
  //      项目自己的约定写在 tunnel.js 里：「把 pid 一并带出去：调用方要能
  //      只收掉自己起的那个」。这个脚本违反了它。改进计划里也点名了这条
  //      （「宽泛杀隧道进程」），核对了源码，确实是真问题。
  //
  //    判据：可执行文件路径在**本项目目录**下。我们这个 cloudflared 是随项目
  //    一起分发的（cloudflared/cloudflared.exe），路径独一无二。
  const BASE_DIR = BASE.replace(/[\\/]+$/, '');
  let killed = 0;
  try {
    if (process.platform === 'win32') {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | ` +
        `Where-Object { $_.ExecutablePath -like '${BASE_DIR.replace(/'/g, "''")}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
      killed = (out.match(/\d+/g) || []).length;
    } else {
      // unix 上用完整路径匹配 —— 同样是为了不误伤别人的 cloudflared
      execFileSync('pkill', ['-f', `${BASE_DIR}/cloudflared`],
        { stdio: 'ignore', timeout: 10000 });
      killed = 1;
    }
    log(killed ? `已停掉本项目自己的隧道进程（${killed} 个）`
      : '没有本项目自己的隧道进程在跑');
  } catch (err) {
    // 一个都没匹配到也算正常（可能已经退了）
    log(`停旧隧道时没找到目标进程（可能本来就没在跑）: ${err.message.slice(0, 80)}`);
  }
  await sleep(1500);

  // 3. 跑守护进程 —— 它会建一条新隧道，并发现"地址变了"自动推送通知
  try {
    const r = spawn(process.execPath, [path.join(__dirname, 'gateway-daemon.js')], {
      cwd: BASE, detached: true, stdio: 'ignore', windowsHide: true
    });
    r.unref();
    log('已拉起守护进程去重建隧道');
  } catch (err) {
    log(`✗ 拉起守护进程失败: ${err.message}`);
    return;
  }

  // 4. 等**新**地址。
  //
  //    ★ 这里第一版写错了：它只等「文件里有个合法地址」就退出 ——
  //      而文件里**一直有旧地址**，所以它立刻退出并报「地址没变」，
  //      可实际上守护进程几秒后才写出新地址。
  //      使用者看到的是日志说没变、手机却连不上 —— 比没有日志更糟。
  //      正确做法：等到地址**和按下之前不一样**才算成功。
  if (EXPECT_SAME_ADDRESS) {
    // named tunnel 的地址是配置里的 hostname，文件在重连期间也可能保留旧值；
    // 因此这里只如实记录「已请求重连」，由守护进程日志报告真实连接失败。
    log('已请求命名隧道重连；固定 hostname 保持不变');
    return;
  }

  for (let i = 0; i < 60; i++) {          // 最多等 30 秒
    await sleep(500);
    let now = '';
    try { now = fs.readFileSync(FILE, 'utf8').trim(); } catch (err) { }
    if (now && /^https:\/\//.test(now) && now !== before) {
      log(`✓ 隧道已重建，新地址: ${now}（新地址会推给手机）`);
      return;
    }
  }
  log('✗ 30 秒内没等到新地址。可能：网络不通、Cloudflare 那边有问题，' +
    '或者守护进程判断「隧道其实还活着」就没重建 —— 去控制台看「外网通道」那一栏。');
})();
