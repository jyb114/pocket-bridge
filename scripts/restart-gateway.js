// 把中间层重启一遍。
//
// 为什么需要它：有四件事**必须重启才生效** ——
//   · 更改地址（换访问密钥）
//   · 更改密钥（换端到端加密密钥）
//   · 开 / 关内网 HTTPS
//   · 切换外网地址策略（动态 / 固定）
// 它们的设置都是中间层**启动时读进内存**的，改完不重启就还是旧的。
//
// 原来这四处都只丢给使用者一句话：「托盘图标右键 → 停止服务 → 再点一下启动」。
// 那不是操作说明，那是把活推给使用者 —— 他要记住托盘在哪、菜单里哪一项、
// 点完还要再点回来。而且很容易只做一半（停了没启，手机直接连不上）。
//
// ── 为什么由中间层自己退出，而不是这个脚本去杀它 ──────────────────────────
//
// 杀掉「某个 PID」需要先确认那个 PID 还是中间层。Windows 上拿别的进程的
// 命令行要绕一大圈（CIM/WMI），而 PID 在中间层退出后的几百毫秒内就可能被
// 系统分配给别的进程 —— 真发生的话，我们杀的是一台无辜的程序。
// 所以反过来：**中间层自己退出**（它当然知道自己该退），这个脚本只负责
// 等它退干净、然后把它拉起来。全程不需要指定任何 PID。
//
// 用法（只给中间层自己调，不给人用）：
//   node scripts/restart-gateway.js --port 8080
//   node scripts/restart-gateway.js --port 8080 --notify-address   # 重启后把新地址推到手机
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const webPushNotify = require('./webpush-notify.js');
const e2eeBridge = require('./ws-e2ee-bridge.js');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const DAEMON_LOG = path.join(LOG_DIR, 'daemon.log');

/**
 * 中间层实际在哪个端口。
 *
 * 优先用调用方传进来的 —— 它是**百分之百确定**的。端口是选出来的
 * （8080 被占就往后挪到 8099），写死 8080 的话，在那种机器上这个脚本会
 * 一直轮询一个没人监听的端口，永远等不到「中间层退了」，白等 20 秒然后放弃。
 * 退路才是读 gateway-port.txt，最后才猜 8080。
 */
function resolvePort() {
  const i = process.argv.indexOf('--port');
  if (i >= 0 && process.argv[i + 1]) {
    const p = Number(process.argv[i + 1]);
    if (Number.isFinite(p) && p > 0) return p;
  }
  try {
    const p = Number(fs.readFileSync(path.join(LOG_DIR, 'gateway-port.txt'), 'utf8').trim());
    if (Number.isFinite(p) && p > 0) return p;
  } catch (err) { /* 没记录过就退回默认 */ }
  return 8080;
}

const PORT = resolvePort();
const HEALTH = `http://127.0.0.1:${PORT}/__health`;

// 「更改地址」之后必须把新地址送到手机上，否则人是被**锁在外面**的。
const NOTIFY_ADDRESS = process.argv.includes('--notify-address');

function log(msg) {
  const line = `${new Date().toISOString()} [自动重启] ${msg}\n`;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(DAEMON_LOG, line); }
  catch (err) { /* 日志失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 中间层还活着吗？（只认我们自己的服务名，别的程序占了 8080 不算） */
function alive() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH, { timeout: 1500 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).service === 'pocket-bridge-gateway');
        } catch (err) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  // 1. 等中间层自己退干净。
  //
  //    这一步不能省：守护进程判断「要不要启动」看的就是「中间层在不在」。
  //    如果它还活着就去跑守护进程，守护进程会说「已在运行」然后什么都不做，
  //    紧接着中间层退出 —— 结果是**服务彻底停了**，比不重启还糟。
  let gone = false;
  for (let i = 0; i < 40; i++) {           // 最多等 20 秒
    if (!(await alive())) { gone = true; break; }
    await sleep(500);
  }
  if (!gone) {
    log('✗ 等了 20 秒，中间层还在跑 —— 放弃重启（保持现状，服务没停）');
    // ★ 这里必须给非零退出码。
    //
    //   原来只有一个 log 就 return，退出码是 0 —— 也就是说「压根没重启」
    //   在外面看起来和「重启成功」一模一样。真人从命令行跑一次就会以为
    //   改动已经生效（本轮就这么被坑了一次：改了网关代码、重启、测出来
    //   还是旧行为，查进程才发现启动时间还是两小时前）。
    //   这个脚本平时是 detached 跑的，没人看得到输出，退出码是唯一的交代。
    process.exitCode = 1;
    return;
  }
  log('中间层已退出，正在拉起来…');

  // 2. 走守护进程把它拉起来。
  //    守护进程会复用**现有的隧道**（端口没变），所以外网地址不会变 ——
  //    这一点对使用者很重要：他刚在控制台上点的按钮，不该顺手换掉手机书签。
  try {
    const r = spawn(process.execPath, [path.join(__dirname, 'gateway-daemon.js')], {
      cwd: BASE, detached: true, stdio: 'ignore', windowsHide: true
    });
    r.unref();
  } catch (err) {
    log(`✗ 拉起守护进程失败: ${err.message}`);
    return;
  }

  // 3. 确认它真的回来了。没回来的话明确写进日志 ——
  //    这个脚本是 detached 跑的，没人能看到它的输出，日志是唯一的交代。
  for (let i = 0; i < 60; i++) {           // 最多等 30 秒
    await sleep(500);
    if (await alive()) {
      log('✓ 中间层已恢复');
      if (NOTIFY_ADDRESS) await notifyNewAddress();
      return;
    }
  }
  log('✗ 30 秒内没恢复。等 5 分钟后那个定时任务兜底（它会自动拉起），或者手动双击 start-gateway.bat。');
  process.exitCode = 1;
})();

/**
 * 把新地址推到手机上。
 *
 * 为什么这一步不能省：更改地址会把**所有设备会话作废**（这是它该做的），
 * 于是手机当场被踢下线，而它书签里还是旧地址。如果人就在电脑前，
 * 复制一下就行；**人在外面时这就是死结** —— 他连不上，也就看不到新地址。
 *
 * 推送走 ntfy / Bark 自己的通道，不依赖我们这条链路可达 ——
 * 「连不上的时候恰好是它还能工作的时候」，和隧道地址变更用的是同一个思路。
 *
 * 推的是**一次性票据**而不是访问密钥：ntfy.sh 的 topic 默认公开，
 * 长期密钥不能落到第三方服务器上（这个项目为此改过一次）。
 */
async function notifyNewAddress() {
  // 票据必须**重启之后**才要 —— 它是用访问密钥派生的，重启前内存里还是旧密钥，
  // 那时候签出来的票在新密钥下当场作废。
  let entry = null;
  try {
    const r = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${PORT}/__recover`, { timeout: 8000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (err) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    if (r && r.ok && r.url) entry = r.url;
  } catch (err) { /* 拿不到就退化 */ }

  const recoveryUrl = entry || null;
  // 仅系统 Web Push 载荷带 fragment；ntfy/Bark 的正文仍只能是一​​次性票据。
  let webRecoveryUrl = recoveryUrl;
  try {
    const secret = e2eeBridge.readSecret();
    if (secret && webRecoveryUrl && /^https:\/\//i.test(webRecoveryUrl)) {
      webRecoveryUrl += `#k=${encodeURIComponent(secret)}`;
    }
  } catch (err) { /* 没有密钥就走普通恢复 */ }
  const webBody = entry
    ? '连接地址已更新。点开这条一次性恢复链接即可继续使用。'
    : '连接地址已更新。请回到电脑复制新链接。';
  try {
    const r = await webPushNotify.sendStored({
      title: 'DSH 地址已更新', body: webBody, url: webRecoveryUrl || '/',
      forceOpen: !!recoveryUrl, tag: 'dsh-address-change'
    });
    log(`· 网页恢复通知：订阅 ${r.attempted}，送达 ${r.delivered}，清理失效 ${r.removed}${r.reason ? `（${r.reason}）` : ''}`);
  } catch (err) {
    log(`· 网页恢复通知发送失败: ${err.message}`);
  }

  let push;
  try { push = require('./notify.js'); } catch (err) { push = null; }
  if (!push || !push.configured()) {
    log('· 未配置 ntfy/Bark；已尝试系统网页通知。');
    return;
  }

  try {
    const body = entry
      ? `点开即用（只能用一次）：${entry}\n地址已经换了，旧链接失效了。`
      : '地址已经换了，旧链接失效了。\n在电脑控制台上复制新地址，或用配对码重新进一次。';
    const r = await push.send('地址已更改', body);
    log(`· 新地址通知已发: ${JSON.stringify(r)}${entry ? '' : '（无票据，退化为基础提示）'}`);
  } catch (err) {
    log(`· 新地址通知发送失败: ${err.message}`);
  }
}
