// DSH 移动端网关 — 常驻启动器（跨平台）
//
// 这个文件取代了原来的 gateway-daemon.ps1。用 Node 写的理由很直接：
// PowerShell 版只能在 Windows 跑，而启动逻辑（找 Node、拉中间层、挑隧道、
// 记状态）在每个平台上完全一样，没必要维护两份。
//
// 它自己跑完就退出，中间层和隧道都以 detached 方式启动 —— 所以关闭 DSH、
// 关闭这个启动器，都不会影响已经在跑的服务。
//
// 用法：
//   node gateway-daemon.js            # 正常启动
//   node gateway-daemon.js --status   # 只报告当前状态，什么都不启动
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const cfg = require('./config.js');
const tunnel = require('./tunnel.js');
const webPushNotify = require('./webpush-notify.js');
const e2eeBridge = require('./ws-e2ee-bridge.js');

const LOG_DIR = cfg.LOG_DIR;
const DAEMON_LOG = path.join(LOG_DIR, 'daemon.log');
const STATUS_FILE = path.join(LOG_DIR, 'status.json');
const PROXY_PORT_RANGE = [8080, 8099];

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(DAEMON_LOG, line);
  } catch (err) { /* 日志失败不影响主流程 */ }
  // 同时打到 stdout，方便手动运行时直接看到
  try { process.stdout.write(line); } catch (err) { }
}

/**
 * 隧道地址变了，就推一条通知给手机。
 *
 * 为什么必须做这个：Cloudflare 免费隧道的地址**每次重启都换**。
 * 使用者书签里存的是旧地址，电脑一重启他就连不上了 —— 而且他没有任何办法
 * 知道新地址是什么（连不上，自然也看不到控制台）。
 *
 * 推送走的是 ntfy / Bark **它们自己的通道**，不依赖我们这条链路可达，
 * 所以「连不上的时候」恰恰是它还能工作的时候。这是唯一能把新地址送到
 * 手机上的办法。
 *
 * ── 推什么进去：一次性票据，不是访问密钥 ──────────────────────────────
 *
 * 这里原来推的是 `${url}/k/${ACCESS_KEY}` —— 把**长期访问密钥**写进了推送正文。
 * 而 ntfy.sh 的 topic 默认公开、无需认证：谁拿到 topic 名，谁就能从历史里
 * 捞走这把钥匙，然后进使用者的电脑。实测那个 topic 里累积了 9 条带密钥的消息。
 *
 * 现在改成推一枚一次性票据：
 *   · 用一次就废 —— 正常情况下点开一次它就烧掉了
 *   · 绑新地址 —— 挪到别的入口上兑换会被拒
 *   · 由访问密钥派生 —— 一换密钥，所有在途票据立刻作废
 * 长期密钥从此不再出现在任何第三方服务器上。
 */
async function notifyUrlChange(url) {
  const FILE = path.join(LOG_DIR, 'last-tunnel-url.txt');
  let prev = '';
  try { prev = fs.readFileSync(FILE, 'utf8').trim(); } catch (err) { }
  try { fs.writeFileSync(FILE, url, 'utf8'); } catch (err) { }

  if (!prev) {
    log(`· 记下隧道地址（首次）: ${url}`);
    return;                       // 第一次运行只记录，不打扰
  }
  if (prev === url) {
    log('· 隧道地址没变，无需通知');
    return;
  }

  log(`! 隧道地址变了 —— 旧: ${prev}  新: ${url}`);

  // 向中间层要一枚恢复票据。中间层此刻已经在跑（地址就是它连上的），
  // 而且票据逻辑和访问密钥都在它那边，这边算不了。
  const entry = await mintRecoverUrl(url);
  const recoveryUrl = entry || `${url}/pair`;
  // Web Push 的 payload 在浏览器推送协议里加密，push 服务和隧道都看不到
  // 这里的 fragment。它只交给手机浏览器，用来在新域名首次打开时恢复 E2EE。
  // 注意：第三方 ntfy/Bark 绝不能拿到这个版本，下面仍只发送 recoveryUrl。
  let webRecoveryUrl = recoveryUrl;
  try {
    const secret = e2eeBridge.readSecret();
    if (secret && /^https:\/\//i.test(webRecoveryUrl)) webRecoveryUrl += `#k=${encodeURIComponent(secret)}`;
  } catch (err) { /* 无密钥时保持普通恢复链接 */ }
  const body = entry
    ? '连接地址已更新。点开这条一次性恢复链接即可继续使用。'
    : '连接地址已更新。点开后用电脑上的配对码继续。';

  // Web Push goes from this computer straight to the browser’s push service;
  // the old trycloudflare address is not part of this delivery path.
  try {
    const r = await webPushNotify.sendStored({
      title: 'DSH 地址已更新', body, url: webRecoveryUrl,
      forceOpen: true, tag: 'dsh-address-change'
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
    const legacyBody = entry
      ? `新地址（点开即用）：${entry}\n` +
        `这条链接只能用一次，别转发给别人。`
      : `新地址：${url}/pair\n` +
        `（没拿到一次性链接，请用配对码进入 —— 配对码在电脑控制台上）`;
    const r = await push.send('手机地址变了', legacyBody);
    log(`· 地址变更通知已发: ${JSON.stringify(r)}${entry ? '' : '（无票据，退化为基础地址）'}`);
  } catch (err) {
    log(`· 地址变更通知发送失败: ${err.message}`);
  }
}

/**
 * 向本机中间层申请一枚「地址变了」用的恢复票据。
 *
 * 拿不到就返回 null —— 退化成推一个不带凭证的基础地址。
 * 宁可让使用者多走一步「用配对码进」，也不能把长期密钥再写回去。
 */
async function mintRecoverUrl(tunnelUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      // 端口要现读 —— 中间层的端口是**选**出来的（8080 被占就往后挪），
      // 不是常量。这里原来想当然写了 PROXY_PORT，而那个标识符根本不存在，
      // 传进去就是 undefined，http 会默默按 80 端口发 —— 失败得毫无线索。
      const port = readGatewayPort() || PROXY_PORT_RANGE[0];
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/__recover',
        method: 'GET',
        timeout: 8000
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (j && j.ok && j.url) {
              log(`· 已取得一次性恢复链接（${Math.round((j.expiresInSec || 0) / 3600)} 小时内有效，绑定 ${j.authority}）`);
              finish(j.url);
            } else {
              log(`· 中间层没给恢复票据: ${(j && j.error) || '原因不明'}`);
              finish(null);
            }
          } catch (err) { finish(null); }
        });
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { try { req.destroy(); } catch (e) { } finish(null); });
      req.end();
    } catch (err) {
      finish(null);
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找到可用的 Node 运行时：优先打包进来的，其次系统 PATH 里的。 */
function resolveNodeExecutable() {
  const runtimeDir = path.join(cfg.BASE, 'runtime');
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';

  try {
    const entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('node-')) continue;
      const candidate = path.join(runtimeDir, e.name, 'bin', exeName);
      if (fs.existsSync(candidate)) return candidate;
      const flat = path.join(runtimeDir, e.name, exeName);
      if (fs.existsSync(flat)) return flat;
    }
  } catch (err) { /* runtime 目录不存在 */ }

  return process.execPath; // 兜底：就用当前这个 Node
}

/** 探测某个端口上是不是我们的中间层。 */
function probeGateway(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/__health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(j && j.service === 'pocket-bridge-gateway' ? j : null);
          } catch (err) {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function findRunningGateway() {
  for (let p = PROXY_PORT_RANGE[0]; p <= PROXY_PORT_RANGE[1]; p++) {
    const info = await probeGateway(p);
    if (info) return { port: p, info };
  }
  return null;
}

async function startGateway(nodeExe) {
  const proxyJs = path.join(cfg.BASE, 'scripts', 'mobile-proxy.js');
  const child = spawn(nodeExe, [proxyJs], {
    detached: true,
    stdio: 'ignore',
    cwd: cfg.BASE
  });
  child.unref();

  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const found = await findRunningGateway();
    if (found) return found;
  }
  return null;
}

/** 隧道当前有没有在跑。 */
function tunnelRunning() {
  // ★ 判据是「**我们自己的**隧道在不在跑」，而且拿不准时要**倾向于说在跑**。
  //
  //   这里原来在 Windows 上跑 `tasklist /FI "IMAGENAME eq cloudflared.exe"`：
  //     · 太宽 —— 别的项目装的 cloudflared 也算数；
  //     · 而且命令一出错就 `return false`。
  //
  //   进程枚举在机器忙的时候是会失败/超时的。实测踩过（13:35，browser-check
  //   正压着中间层）：这里返回 false → 守护进程判定「隧道没在跑」→
  //   直接**又建了一条**，而旧的那条还活着。结果电脑上同时有两个公网域名，
  //   其中一个没人追踪，日志里却只有一句「✓ 隧道就绪」，看不出任何异常。
  //
  //   所以：① 按本项目路径过滤；② 出错时返回 true。
  //   「以为在跑」最坏是这一轮什么都不做 —— 下一轮靠公网探测照样能兜回来
  //   （探不通两次就判死重建）；「以为没跑」的代价是多开一个公网入口。
  try {
    if (process.platform === 'win32') {
      const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'cloudflared.exe\'" | ' +
        'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress';
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
      let list = [];
      if (out) { try { list = JSON.parse(out); } catch (err) { return true; } }
      return tunnel.ownTunnelPids(list, cfg.BASE).length > 0;
    }
    const out = execFileSync('pgrep', ['-f', 'cloudflared tunnel'], { encoding: 'utf8', timeout: 8000 });
    return String(out).trim().length > 0;
  } catch (err) {
    // 枚举失败 ≠ 没有隧道。
    return true;
  }
}

/** 从隧道日志里读回它公布过的地址。 */
function readTunnelUrl() {
  const candidates = [
    path.join(LOG_DIR, 'cloudflared.err.log'),
    path.join(LOG_DIR, 'cloudflared-daemon.log'),
    path.join(LOG_DIR, 'ngrok.log')
  ];
  for (const f of candidates) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const url = tunnel.extractPublicUrl(text);
      if (url) return url;
    } catch (err) { /* 换下一个 */ }
  }
  return null;
}

// 隧道可达性探测的实现放在 tunnel.js 里 —— 那边是正经模块，
// 测试能直接 require 它来验「死地址判不通、活地址判得通」。
// 留在这里的话是个脚本，require 一下就把守护进程整个跑起来了。
const probeTunnelUrl = (url, timeoutMs) => tunnel.probeUrl(url, timeoutMs);

/**
 * 连续探测失败了几次。
 *
 * 要跨进程记：这个守护进程每次都是新起的（定时任务每 5 分钟跑一次），
 * 存在内存里等于没存。之所以要「连续」而不是「一次」—— 网络抖一下
 * 就重建隧道的话，地址会被无谓地换掉，而换地址对使用者是有代价的
 * （手机书签失效）。宁可晚 5 分钟恢复，也不要因为一次抖动换掉地址。
 */
const PROBE_STATE_FILE = path.join(LOG_DIR, 'tunnel-probe.json');

function readProbeState() {
  try {
    const s = JSON.parse(fs.readFileSync(PROBE_STATE_FILE, 'utf8'));
    return { fails: Number(s && s.fails) || 0, lastError: (s && s.lastError) || null, lastOkAt: (s && s.lastOkAt) || null };
  } catch (err) { return { fails: 0, lastError: null, lastOkAt: null }; }
}

function writeProbeState(s) {
  try { fs.writeFileSync(PROBE_STATE_FILE, JSON.stringify(s, null, 2)); } catch (err) { }
}

function readGatewayPort() {
  try {
    const raw = fs.readFileSync(path.join(LOG_DIR, 'gateway-port.txt'), 'utf8').trim();
    if (/^\d+$/.test(raw)) return Number(raw);
  } catch (err) { /* 没有这个文件 */ }
  return null;
}

/**
 * 隧道当前指向哪个端口。
 * 优先从隧道自己的日志推断 —— 那反映的是事实，而不是我们以为的配置。
 * 中间层端口变过而隧道没跟上，表现就是「隧道在运行但访问一律 502」，
 * 从表面完全看不出来。
 */
function readTunnelTargetPort() {
  const logs = [
    path.join(LOG_DIR, 'cloudflared.err.log'),
    path.join(LOG_DIR, 'cloudflared-daemon.log'),
    path.join(LOG_DIR, 'ngrok.log')
  ];
  for (const f of logs) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const found = [...text.matchAll(/url:http:\/\/127\.0\.0\.1:(\d+)/g)];
      if (found.length) return Number(found[found.length - 1][1]);
    } catch (err) { /* 换下一个日志 */ }
  }
  try {
    const raw = fs.readFileSync(path.join(LOG_DIR, 'tunnel-target.txt'), 'utf8').trim();
    if (/^\d+$/.test(raw)) return Number(raw);
  } catch (err) { /* 没记录过 */ }
  return null;
}

function readAccessKey() {
  try {
    return fs.readFileSync(path.join(LOG_DIR, 'access-key.txt'), 'utf8').trim();
  } catch (err) {
    return null;
  }
}

function collectLanAddresses() {
  const net = cfg.detectNetwork();
  return net.lanV4.map((x) => x.address);
}

function writeStatus(status) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf8');
  } catch (err) { /* 写不了就算了 */ }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
(async () => {
  const wantStatusOnly = process.argv.includes('--status');

  // ── 单实例锁：同一时刻只允许一个守护进程动隧道 ────────────────────────────
  //
  // 会并发跑到这里的地方不止一处：
  //   · 看门狗计划任务（每 5 分钟一次）
  //   · refresh-tunnel.js（控制台按钮 → 它 detach 起一个守护进程）
  //   · 使用者手动跑
  // 而它们的动作是「**杀掉旧的 cloudflared → 起一条新的**」。
  // 两个撞在一起就会互相杀对方的隧道 —— 实测那次的时间线是：
  //
  //   03:59:56 #1 停掉旧的
  //   03:59:58 #1 起新的
  //   04:00:03 #2 把 #1 刚起的那个杀掉了 ← 就是这里
  //   04:00:03 #1 报「失败: 进程已退出」→「所有隧道方案都不可用」
  //   04:00:05 #2 重来，04:00:11 才就绪
  //
  // 结果是**外网入口断了 8 秒**、白重建一次。运气差一点（比如 #2 在 #1
  // 判定成功之后再杀）就会留下一个「进程在跑、域名还没生效」的中间态。
  //
  // `--status` 是只读查询，不抢锁 —— 否则控制台连状态都读不出来。
  const LOCK_FILE = path.join(LOG_DIR, 'daemon.lock');
  const LOCK_STALE_MS = 2 * 60 * 1000;   // 一轮正常只要几秒到半分钟
  function otherDaemonAlive() {
    let info = null;
    try { info = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (err) { return false; }
    if (!info || !info.pid) return false;
    if (Date.now() - (info.at || 0) > LOCK_STALE_MS) return false;   // 太旧，当它已经死了
    try { process.kill(info.pid, 0); return true; }   // 0 号信号 = 只探测存活性，不真发信号
    catch (err) { return false; }
  }
  if (!wantStatusOnly) {
    if (otherDaemonAlive()) {
      log('· 另一个守护进程正在跑，本次跳过（两个一起跑会互相杀掉对方的隧道）');
      return;
    }
    try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8'); }
    catch (err) { log(`· 写锁文件失败（${err.message}），继续，但这次没有并发保护`); }
  }

  // ★ 使用者主动关掉了 —— 那就不要再自己起来。
  //
  // 这个标记是「真正关闭」能成立的前提。
  //
  // 背景：看门狗计划任务每 5 分钟跑一次这个脚本，一发现中间层没在跑就把它拉起来。
  // 所以使用者从托盘里点了「退出 → 是（连后台一起停）」，当时确实停了，
  // 但**最多 5 分钟后又被拉回来**。他看到的景象是「关了，后台还在跑」，
  // 而这跟意志无关 —— 是我们自己在跟他拔河。
  //
  // 有了标记：他关，就一直关着；他从托盘点「启动服务」，标记清掉，恢复正常。
  // 「--status」是只读查询，不该被标记挡住（否则控制台连状态都读不出来）。
  const STOP_FLAG = path.join(LOG_DIR, 'user-stopped.flag');
  if (!wantStatusOnly && fs.existsSync(STOP_FLAG)) {
    log('· 使用者已手动关闭过 —— 这次不自动启动（要恢复：托盘右键 →「启动服务」）');
    process.exitCode = 0;
    return;
  }

  try {
    // 0. 本机身份：换机器就作废旧密钥
    const identity = cfg.ensureInstanceIdentity();
    if (identity.isFirstRun) log('首次在本机运行');
    else if (identity.isNewMachine) log('检测到换机器，旧密钥已作废，将重新签发');

    // 1. 中间层
    let gateway = await findRunningGateway();
    if (gateway) {
      log(`· 中间层已在运行，端口 ${gateway.port}`);
    } else if (wantStatusOnly) {
      log('· 中间层未运行（--status 模式，不启动）');
    } else {
      const nodeExe = resolveNodeExecutable();
      log(`启动中间层（node: ${nodeExe}）`);
      gateway = await startGateway(nodeExe);
      if (gateway) log(`✓ 中间层已启动，端口 ${gateway.port}`);
      else log('✗ 中间层启动失败（25 秒内没找到健康检查端点）');
    }

    const port = gateway ? gateway.port : (readGatewayPort() || PROXY_PORT_RANGE[0]);

    // 2. 隧道
    let tunnelUrl = null;
    let tunnelProvider = null;

    // 隧道是不是还指向正确的端口？中间层端口变过而隧道没跟上，会表现为
    // 「隧道在运行、但访问一律 502」—— 从表面完全看不出来，必须主动比对。
    const tunnelTargetFile = path.join(LOG_DIR, 'tunnel-target.txt');
    const tunnelTargetPort = readTunnelTargetPort();

    const tunnelUp = tunnelRunning();
    // 推断出的目标端口与中间层实际端口不一致，就说明隧道已经过期
    const tunnelStale = tunnelUp && tunnelTargetPort !== null && tunnelTargetPort !== port;

    // ② 隧道进程活着 —— 但**活着不等于能连上**。
    //
    // 免费快速隧道的域名会被 Cloudflare 回收：cloudflared 进程还在、日志里
    // 地址还在，那个域名却已经指向空气。原来这一段只查进程，于是手机连不上
    // 的时候，电脑这边一片正常、日志写着「隧道已在运行」—— 实测栽过两次，
    // 都是二十多分钟后靠人工重建才恢复。这就是计划 E 说的
    // 「区分进程存活 / 公网可达 / 执行端可用」。
    let tunnelDead = false;
    let tunnelProbe = null;
    if (tunnelUp && !tunnelStale) {
      tunnelUrl = readTunnelUrl();
      tunnelProvider = 'existing';
      if (!tunnelUrl) {
        log('· 隧道进程在跑，但读不到地址 —— 当作不可用处理');
        tunnelDead = true;
      } else {
        const st = readProbeState();
        tunnelProbe = await probeTunnelUrl(tunnelUrl);
        if (tunnelProbe.ok) {
          log(st.fails
            ? `· 隧道公网可达（${tunnelProbe.ms}ms），上次的连续失败已清零：${tunnelUrl}`
            : `· 隧道已在运行且公网可达（${tunnelProbe.ms}ms）：${tunnelUrl}`);
          writeProbeState({ fails: 0, lastError: null, lastOkAt: new Date().toISOString() });
          // 地址可能和我们上次记的不一样（上一次没来得及记录就退出了）。
          if (tunnelUrl) notifyUrlChange(tunnelUrl).catch(() => { });
        } else {
          // ★ 一次探测失败**不等于**隧道死了。
          //
          //   Cloudflare 免费隧道本来就会间歇性抽风 —— 实测同一秒里
          //   「302 → 000 → 302」，隔一会儿重试就通了。
          //   而两件事的代价完全不对等：
          //     · 短暂不通 → 会自己恢复，代价是使用者等一会儿；
          //     · 换地址   → **所有书签、主屏幕快捷方式永久失效**。
          //   所以先就地重试两次，全都失败才算一次「真失败」。
          let probed = tunnelProbe;
          for (let i = 0; i < 2 && !probed.ok; i++) {
            await sleep(1500);
            probed = await probeTunnelUrl(tunnelUrl, 15000);
            if (probed.ok) {
              log(`· 隧道探测第 ${i + 2} 次通了（${probed.ms}ms）—— 刚才那次是抖动，地址不动`);
            }
          }
          tunnelProbe = probed;

          if (probed.ok) {
            writeProbeState({ fails: 0, lastError: null, lastOkAt: new Date().toISOString() });
          } else {
            const why = probed.error || `HTTP ${probed.status}`;
            const fails = st.fails + 1;
            writeProbeState({ fails, lastError: why, lastOkAt: st.lastOkAt });
            // 阈值原来写死 2 —— 也就是十分钟内两次抽风就换地址。
            // 实测一晚上因此换了 8 次，使用者的书签一直在失效。
            // 按 5 分钟一轮算，5 次≈25 分钟持续不通才动手；真被回收的域名
            // 撑不了那么久，而偶发抖动根本到不了 5 次。
            if (fails < 5) {
              log(`· 隧道进程在跑，但公网不可达（${why}）—— 已连续 ${fails}/5 次，`
                + '继续观察（换地址会让所有书签失效，不轻易动手）');
            } else {
              log(`· 隧道连续 ${fails} 次不可达（${why}）—— 判定域名已被回收，重建`);
              tunnelDead = true;
            }
          }
        }
      }
      if (tunnelDead) tunnelUrl = null;    // 别把死地址当成可用入口报出去
    }

    if (tunnelUp && !tunnelStale && !tunnelDead) {
      // 在跑、而且真连得上 —— 什么都不用做（上面已经记完状态、通知完）
    } else if ((tunnelUp && tunnelStale) || tunnelDead) {
      if (tunnelStale) log(`· 隧道指向 ${tunnelTargetPort}，但中间层现在在 ${port} —— 重启隧道让它跟上`);
      tunnel.stopTunnels();
      await sleep(2000);
      const config = cfg.loadConfig();
      const res = await tunnel.startTunnel(port, config.tunnelProvider || 'auto');
      tunnelUrl = res.url;
      tunnelProvider = res.provider;
      if (res.url) {
        log(`✓ 隧道已指向 ${port}: ${res.url}`);
        // 重建成功，探测计数清零 —— 否则下次一进来就带着旧账
        writeProbeState({ fails: 0, lastError: null, lastOkAt: new Date().toISOString() });
        // 刚建好的隧道头几秒常常还没在边缘生效（实测要等十几秒），
        // 这里探一次只为**如实记录**，不据此再做什么决定 ——
        // 免得刚建好就判死、陷入重建循环。
        tunnelProbe = await probeTunnelUrl(res.url, 20000);
        log(tunnelProbe.ok
          ? `· 新隧道公网可达（${tunnelProbe.ms}ms）`
          : `· 新隧道暂时还探不通（${tunnelProbe.error || 'HTTP ' + tunnelProbe.status}）—— 边缘生效可能要十几秒，下一轮再看`);
        try { fs.writeFileSync(tunnelTargetFile, String(port), 'utf8'); } catch (err) { }
        // ★ 必须和另外两个分支一样通知手机 —— 这里原来漏了。
        //
        // 三个分支（已在跑 / 过期重启 / 全新启动）里，只有这一个没调
        // notifyUrlChange。后果是**这条路上的新地址从来没被推给手机过**：
        // 手机抱着一个已经死掉的地址反复重试，而电脑这边一切正常、
        // 日志里还写着「✓ 隧道已指向 8080」，看不出任何异常。
        //
        // 而这恰恰是最常发生的一条路 —— 中间层端口一变（DSH 换端口、
        // 8080 被占），隧道就会被判定为过期并重启，然后换一个新地址。
        // 否则手机上的旧外网入口会失效。
        notifyUrlChange(res.url).catch(() => { });
      } else {
        log('✗ 重启隧道失败，外网入口不可用（内网仍然可用）');
      }
    } else if (wantStatusOnly) {
      log('· 隧道未运行（--status 模式，不启动）');
    } else {
      // ★ 建新隧道之前，先把**自己的**旧隧道停掉。
      //
      //   另外两支（过期重建 / 判死重建）本来就会先 stopTunnels()，只有这一支
      //   漏了。于是「判定没在跑」时直接新建，而旧进程还活着 —— 电脑上就多出
      //   一个没人追踪的公网域名（实测发生过：两个 trycloudflare 域名同时返回 200）。
      //   补上之后三支一致：任何一次「重建」都从干净状态开始。
      const killed = tunnel.stopTunnels();
      if (killed) log(`· 建新隧道前先停掉 ${killed} 个残留的隧道进程`);
      await sleep(2000);
      const config = cfg.loadConfig();
      const res = await tunnel.startTunnel(port, config.tunnelProvider || 'auto');
      tunnelUrl = res.url;
      tunnelProvider = res.provider;
      if (res.url) {
        log(`✓ 隧道就绪: ${res.url}`);
        try { fs.writeFileSync(tunnelTargetFile, String(port), 'utf8'); } catch (err) { }
        notifyUrlChange(res.url).catch(() => { });
      } else {
        log('✗ 所有隧道方案都不可用，外网入口关闭（内网仍然可用）');
      }
    }

    // 3. 汇总写状态，供 UI / 脚本读取
    const key = readAccessKey();
    // ★ 地址里必须带上加密密钥（#k=…）。
    //
    //   守护进程写的这份 status.json 会**覆盖**中间层写的那份，而 connect.js
    //   正是从 entries.wan 里读地址念给使用者 —— 少一段 #k=，念出来的就是一条
    //   会被自家网关拒掉的链接：手机打开后页面能出来，但 /api/remote.mux 那条
    //   WebSocket 会被「拒绝明文，不降级」挡下，对话列表永远是空的。
    //   原因详见 routes.js 里 frag 那段注释。
    let e2eeSecret = '';
    try {
      e2eeSecret = fs.readFileSync(path.join(LOG_DIR, 'e2ee-secret.txt'), 'utf8').trim();
    } catch (err) { /* 还没配加密就是空 */ }
    const kfrag = e2eeSecret ? `#k=${e2eeSecret}` : '';
    const lan = collectLanAddresses();
    const status = {
      updatedAt: new Date().toISOString(),
      instanceId: identity.instanceId,
      platform: process.platform,
      hostname: os.hostname(),
      gateway: {
        port,
        healthUrl: `http://127.0.0.1:${port}/__health`,
        running: !!gateway
      },
      tunnel: {
        provider: tunnelProvider,
        url: tunnelUrl,
        // 「进程在不在」和「公网通不通」是**两件事**，分开报。
        // 混成一个布尔值正是这次要修的毛病：进程活着、地址是死的，
        // 界面上却显示「隧道正常」。
        running: tunnelRunning() || !!tunnelUrl,
        reachable: tunnelProbe ? tunnelProbe.ok : null,     // null = 这轮没探测
        probeMs: tunnelProbe ? tunnelProbe.ms : null,
        probeError: tunnelProbe && !tunnelProbe.ok
          ? (tunnelProbe.error || `HTTP ${tunnelProbe.status}`) : null,
        probeFails: readProbeState().fails
      },
      entries: {
        lan: lan.map((ip) => (key ? `http://${ip}:${port}/k/${key}${kfrag}` : `http://${ip}:${port}/`)),
        wan: tunnelUrl && key ? `${tunnelUrl}/k/${key}${kfrag}` : tunnelUrl,
        pairPage: lan.length ? `http://${lan[0]}:${port}/pair` : (tunnelUrl ? `${tunnelUrl}/pair` : null),
        pairCode: (() => {
          try { return fs.readFileSync(path.join(LOG_DIR, 'pair-code.txt'), 'utf8').trim(); }
          catch (err) { return null; }
        })()
      }
    };
    writeStatus(status);

    log('──────── 启动器结束 ────────');
  } catch (err) {
    log(`✗ 异常: ${err.message}`);
    writeStatus({ updatedAt: new Date().toISOString(), error: err.message });
    process.exitCode = 1;
  } finally {
    // 放锁。放不掉也不致命 —— 下一轮会因为「超过 LOCK_STALE_MS」把它当过期接管，
    // 所以这里不为此报错、更不改变退出码。
    if (!wantStatusOnly) {
      try { fs.unlinkSync(path.join(LOG_DIR, 'daemon.lock')); } catch (err) { }
    }
  }
})();
