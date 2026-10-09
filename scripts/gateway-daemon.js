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

require('./runtime-requirements.js').assertSupportedRuntime();

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const cfg = require('./config.js');
const tunnel = require('./tunnel.js');
const webPushNotify = require('./webpush-notify.js');
const e2eeBridge = require('./ws-e2ee-bridge.js');

const LOG_DIR = cfg.LOG_DIR;
const DAEMON_LOG = path.join(LOG_DIR, 'daemon.log');
const STATUS_FILE = path.join(LOG_DIR, 'status.json');
const PROXY_PORT_RANGE = [8080, 8099];

// The tray observes presence, including incomplete/unreadable directories.
// There is no stale-age or PID-only takeover: an interrupted spawn is evidence,
// not permission for a second watchdog to create another public endpoint.
function createDaemonOperationLease({ logDir, owner, fileSystem = fs }) {
  const directory = path.join(logDir, 'daemon-operation.lock');
  const ownerFile = path.join(directory, 'owner.json');
  const nonce = crypto.randomBytes(24).toString('hex');
  let directoryIdentity, expectedOwnerIdentity, expectedBytes, uncertain = false, released = false, stopObserved = false;
  const children = [];
  const failure = code => Object.assign(new Error(code), { code });
  fileSystem.mkdirSync(logDir, { recursive: true });
  try { fileSystem.mkdirSync(directory, { mode: 0o700 }); }
  catch (_) { throw failure('daemon-operation-pending'); }
  directoryIdentity = fileSystem.lstatSync(directory);
  function sameDirectory() {
    const current = fileSystem.lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino)
      throw failure('daemon-operation-unverified');
  }
  function assertOwned() {
    if (released || uncertain) throw failure('daemon-operation-unverified');
    try {
      sameDirectory();
      const stat = fileSystem.lstatSync(ownerFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== expectedOwnerIdentity.dev ||
          stat.ino !== expectedOwnerIdentity.ino || stat.size !== expectedBytes.length ||
          !fileSystem.readFileSync(ownerFile).equals(expectedBytes)) throw failure('daemon-operation-unverified');
      const afterRead = fileSystem.lstatSync(ownerFile);
      if (afterRead.dev !== stat.dev || afterRead.ino !== stat.ino) throw failure('daemon-operation-unverified');
    } catch (_) { uncertain = true; throw failure('daemon-operation-unverified'); }
  }
  function save(initial = false) {
    if (!initial) assertOwned();
    const bytes = Buffer.from(JSON.stringify({ version: 1, ...owner, nonce,
      children: children.map(value => ({ kind: value.kind, pid: value.child.pid || null, state: value.state })) }));
    const temporary = path.join(directory, `owner-${crypto.randomBytes(12).toString('hex')}.tmp`);
    let fd;
    try {
      sameDirectory(); fd = fileSystem.openSync(temporary, 'wx', 0o600);
      fileSystem.writeFileSync(fd, bytes); fileSystem.fsyncSync(fd); fileSystem.closeSync(fd); fd = undefined;
      if (!initial) assertOwned();
      fileSystem.renameSync(temporary, ownerFile); expectedBytes = bytes;
      expectedOwnerIdentity = fileSystem.lstatSync(ownerFile);
      if (!expectedOwnerIdentity.isFile() || expectedOwnerIdentity.isSymbolicLink() || expectedOwnerIdentity.nlink !== 1)
        throw failure('daemon-operation-unverified');
    } catch (_) { uncertain = true; throw failure('daemon-operation-unverified'); }
    finally { if (fd !== undefined) fileSystem.closeSync(fd); }
  }
  save(true);
  function checkpoint() {
    assertOwned();
    if (stopObserved) throw failure('daemon-stop-requested');
    try { fileSystem.lstatSync(path.join(logDir, 'user-stopped.flag')); stopObserved = true; throw failure('daemon-stop-requested'); }
    catch (error) { if (error.code !== 'ENOENT') throw error.code === 'daemon-stop-requested' ? error : failure('daemon-stop-unverified'); }
  }
  function bindInstallation(instanceId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId || '') ||
        owner.instanceId && owner.instanceId !== instanceId) throw failure('daemon-operation-unverified');
    owner.instanceId = instanceId; save();
  }
  function observeSpawn(child, kind) {
    if (!child || typeof child.once !== 'function' || !['gateway', 'tunnel'].includes(kind)) {
      uncertain = true; throw failure('daemon-spawn-unverified');
    }
    let resolveReady, rejectReady, resolveClose, observedBoundary = false;
    const value = { child, kind, state: 'spawning', ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
      close: new Promise(resolve => { resolveClose = resolve; }) };
    // Install handlers before persistence so a journal write failure cannot
    // leave the real child unobserved or emit an unhandled spawn error.
    children.push(value);
    const timer = setTimeout(() => { value.state = 'unknown'; uncertain = true; rejectReady(failure('daemon-spawn-unverified')); }, 10000);
    child.once('spawn', () => {
      observedBoundary = true;
      clearTimeout(timer);
      value.state = Number.isSafeInteger(child.pid) && child.pid > 0 ? 'live' : 'unknown';
      try { save(); if (value.state === 'unknown') throw failure('daemon-spawn-unverified'); resolveReady(); }
      catch (error) { uncertain = true; rejectReady(error); }
    });
    child.once('error', () => { observedBoundary = true; clearTimeout(timer); value.state = child.pid ? 'unknown' : 'failed'; rejectReady(failure('daemon-spawn-unverified')); });
    child.once('close', () => { clearTimeout(timer); value.state = 'closed'; resolveClose();
      if (!observedBoundary) { uncertain = true; rejectReady(failure('daemon-spawn-unverified')); }
      if (!released) try { save(); } catch (_) { uncertain = true; } });
    value.ready.catch(() => {});
    try { save(); } catch (error) { value.ready.catch(() => {}); throw error; }
    return value.ready;
  }
  async function quiesce() {
    let timer;
    try {
      await Promise.race([Promise.allSettled(children.map(value => value.ready)).then(() =>
        Promise.all(children.filter(value => ['failed', 'unknown'].includes(value.state)).map(value => value.close))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('daemon-spawn-unverified')), 10000); })]);
      if (children.some(value => !['live', 'closed'].includes(value.state))) throw failure('daemon-spawn-unverified');
    } catch (error) { uncertain = true; throw error; }
    finally { clearTimeout(timer); }
  }
  function release({ stopRequested = false } = {}) {
    assertOwned();
    if (children.some(value => !['live', 'closed'].includes(value.state)) ||
        stopRequested && children.some(value => value.kind === 'gateway' && value.state !== 'closed')) {
      throw failure('daemon-operation-pending');
    }
    // Known live tunnels are handed off only after provider continuations have
    // quiesced. The tray then recaptures their fresh argv/birth/held handles.
    // Claim the manifest under a nonce-specific name before deleting it. A
    // file swapped during the claim is retained as uncertain evidence, rather
    // than unlinked merely because its old pathname was ours.
    assertOwned();
    const closingFile = path.join(directory, `release-${nonce}.json`);
    fileSystem.renameSync(ownerFile, closingFile); sameDirectory();
    const claimed = fileSystem.lstatSync(closingFile);
    if (!claimed.isFile() || claimed.isSymbolicLink() || claimed.nlink !== 1 ||
        claimed.dev !== expectedOwnerIdentity.dev || claimed.ino !== expectedOwnerIdentity.ino ||
        !fileSystem.readFileSync(closingFile).equals(expectedBytes)) {
      uncertain = true; throw failure('daemon-operation-unverified');
    }
    sameDirectory(); fileSystem.unlinkSync(closingFile); sameDirectory(); fileSystem.rmdirSync(directory); released = true;
  }
  return { checkpoint, bindInstallation, observeSpawn, quiesce, release, children, retain() { uncertain = true; },
    status() { return { uncertain, released, children: children.map(value => ({ kind: value.kind, state: value.state })) }; } };
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { if (!process.argv.includes('--status')) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(DAEMON_LOG, line);
  } } catch (err) { /* 日志失败不影响主流程 */ }
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
function probeGateway(port, timeoutMs = 1500, expected = {}) {
  return new Promise((resolve) => {
    let req, settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(deadline); resolve(value); };
    // Socket inactivity alone is not a deadline: an incomplete response can
    // keep sending bytes. Destroy only this request at the absolute boundary.
    const deadline = setTimeout(() => { req?.destroy(); finish(null); }, timeoutMs);
    try { req = http.get(
      { host: '127.0.0.1', port, path: '/__health', timeout: timeoutMs },
      (res) => {
        let body = '', bytes = 0;
        res.on('data', (d) => { bytes += d.length; if (bytes > 16384) { req.destroy(); finish(null); }
          else body += d; });
        res.on('error', () => finish(null));
        res.on('aborted', () => finish(null));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            finish(j && j.service === 'pocket-bridge-gateway' && j.port === port && Number.isSafeInteger(j.pid) && j.pid > 0 &&
              (!expected.instanceId || j.instanceId === expected.instanceId) &&
              (!expected.pid || j.pid === expected.pid) ? j : null);
          } catch (err) {
            finish(null);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
    } catch (_) { finish(null); }
  });
}

async function findRunningGateway(expected = {}) {
  for (let p = PROXY_PORT_RANGE[0]; p <= PROXY_PORT_RANGE[1]; p++) {
    const info = await probeGateway(p, 1500, expected);
    if (info) return { port: p, info };
  }
  return null;
}

async function startGateway(nodeExe, admission, identity) {
  const proxyJs = path.join(cfg.BASE, 'scripts', 'mobile-proxy.js');
  admission.checkpoint();
  const child = spawn(nodeExe, [proxyJs], {
    detached: true,
    stdio: 'ignore',
    cwd: cfg.BASE,
    // ★ 确定性隐藏：别指望「detached + stdio:ignore 在 Windows 上本来就不给控制台」
    //   这种平台细节 —— 写死 windowsHide，桌面上就一定不会闪黑窗。
    windowsHide: true
  });
  const ready = admission.observeSpawn(child, 'gateway'); child.unref(); await ready;
  admission.checkpoint();

  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    admission.checkpoint();
    const found = await findRunningGateway({ instanceId: identity.instanceId, pid: child.pid });
    admission.checkpoint();
    if (found) return found;
  }
  throw Object.assign(Error('daemon-owned-gateway-unverified'), { code: 'daemon-owned-gateway-unverified' });
}

async function stopOwnedGatewayChildren(admission, identity) {
  for (const owned of admission.children.filter(value => value.kind === 'gateway' && value.state !== 'closed')) {
    if (owned.state !== 'live' || !identity?.instanceId) throw Error('daemon-owned-gateway-unverified');
    const found = await findRunningGateway({ instanceId: identity.instanceId, pid: owned.child.pid });
    const health = found?.info;
    if (!health || !/^[a-f0-9-]{36}$/i.test(health.bootId || '')) throw Error('daemon-owned-gateway-unverified');
    const origin = `http://127.0.0.1:${found.port}`;
    const bytes = Buffer.from(JSON.stringify({ action: 'stop-gateway', expectedBootId: health.bootId,
      expectedInstanceId: identity.instanceId }));
    await new Promise((resolve, reject) => {
      let request, settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(Error('daemon-owned-gateway-unverified')) : resolve(); };
      const deadline = setTimeout(() => { request?.destroy(); finish(true); }, 5000);
      try { request = http.request({ hostname: '127.0.0.1', port: found.port, path: '/__console/action', method: 'POST', timeout: 5000,
        headers: { Origin: origin, 'content-type': 'application/json', 'content-length': bytes.length } }, response => {
        const chunks = []; let size = 0;
        response.on('data', value => { size += value.length; if (size > 16384) { request.destroy(); finish(true); }
          else chunks.push(value); });
        response.on('end', () => {
          try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 202 || result.shutdownScheduled !== true || result.ok !== true ||
                result.bootId !== health.bootId || result.instanceId !== identity.instanceId || result.pid !== owned.child.pid) throw Error();
            finish(); } catch (_) { finish(true); }
        });
        response.on('error', () => finish(true));
        response.on('aborted', () => finish(true));
      });
      request.on('error', () => finish(true));
      request.on('timeout', () => { request.destroy(); finish(true); });
      request.end(bytes);
      } catch (_) { finish(true); }
    });
    let timer;
    try { await Promise.race([owned.close, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('daemon-owned-gateway-pending')), 95000); })]); }
    finally { clearTimeout(timer); }
  }
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
async function runDaemon() {
  const wantStatusOnly = process.argv.includes('--status');
  let admission = null, identity = null, stopped = false;
  let publicTunnelPreference;
  let publicTunnelActive = false;
  const checkpoint = () => {
    if (admission) admission.checkpoint();
    if (publicTunnelActive && cfg.loadConfig().tunnelProvider !== publicTunnelPreference) {
      throw Object.assign(Error('Tunnel policy changed; public tunnel work cancelled. Refresh status before retrying.'), { code: 'daemon-tunnel-policy-changed' });
    }
  };
  const tunnelAdmission = { beforeMutation: checkpoint, observeSpawn: (child, kind) => admission.observeSpawn(child, kind) };
  try {
    const tunnelPreference = cfg.loadConfig().tunnelProvider;
    const initialTunnelPolicy = tunnel.providerPolicy(tunnelPreference);
    if (initialTunnelPolicy.code) throw Object.assign(Error(initialTunnelPolicy.reason), { code: initialTunnelPolicy.code });
    if (!wantStatusOnly) {
      admission = createDaemonOperationLease({ logDir: LOG_DIR, owner: { pid: process.pid,
        base: path.resolve(cfg.BASE), executable: process.execPath, script: path.resolve(__filename) } });
      checkpoint();
    }
    // 0. 本机身份：换机器就作废旧密钥
    identity = wantStatusOnly ? JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'instance.json'), 'utf8')) : cfg.ensureInstanceIdentity();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity?.instanceId || '')) throw Error('daemon-installation-unverified');
    admission?.bindInstallation(identity.instanceId);
    checkpoint();
    if (identity.isFirstRun) log('首次在本机运行');
    else if (identity.isNewMachine) log('检测到换机器，旧密钥已作废，将重新签发');

    // 1. 中间层
    let gateway = await findRunningGateway({ instanceId: identity.instanceId });
    checkpoint();
    if (gateway) {
      log(`· 中间层已在运行，端口 ${gateway.port}`);
    } else if (wantStatusOnly) {
      log('· 中间层未运行（--status 模式，不启动）');
    } else {
      const nodeExe = resolveNodeExecutable();
      log(`启动中间层（node: ${nodeExe}）`);
      checkpoint();
      gateway = await startGateway(nodeExe, admission, identity);
      checkpoint();
      if (gateway) log(`✓ 中间层已启动，端口 ${gateway.port}`);
      else log('✗ 中间层启动失败（25 秒内没找到健康检查端点）');
    }

    const port = gateway ? gateway.port : (readGatewayPort() || PROXY_PORT_RANGE[0]);

    // Re-read after awaited gateway startup. A changed policy must never reuse
    // an earlier public-tunnel authorization. Subsequent awaits are fenced too.
    publicTunnelPreference = cfg.loadConfig().tunnelProvider;
    const tunnelPolicy = tunnel.providerPolicy(publicTunnelPreference);
    if (tunnelPolicy.code) throw Object.assign(Error(tunnelPolicy.reason), { code: tunnelPolicy.code });
    publicTunnelActive = tunnelPolicy.enabled;
    checkpoint();

    // 2. 隧道
    let tunnelUrl = null;
    let tunnelProvider = null;

    // 隧道是不是还指向正确的端口？中间层端口变过而隧道没跟上，会表现为
    // 「隧道在运行、但访问一律 502」—— 从表面完全看不出来，必须主动比对。
    const tunnelTargetFile = path.join(LOG_DIR, 'tunnel-target.txt');
    const tunnelTargetPort = tunnelPolicy.enabled ? readTunnelTargetPort() : null;

    const tunnelUp = tunnelPolicy.enabled && tunnelRunning();
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
        checkpoint();
        if (tunnelProbe.ok) {
          log(st.fails
            ? `· 隧道公网可达（${tunnelProbe.ms}ms），上次的连续失败已清零：${tunnelUrl}`
            : `· 隧道已在运行且公网可达（${tunnelProbe.ms}ms）：${tunnelUrl}`);
          if (!wantStatusOnly) writeProbeState({ fails: 0, lastError: null, lastOkAt: new Date().toISOString() });
          // 地址可能和我们上次记的不一样（上一次没来得及记录就退出了）。
          if (tunnelUrl && !wantStatusOnly) notifyUrlChange(tunnelUrl).catch(() => { });
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
            checkpoint();
            probed = await probeTunnelUrl(tunnelUrl, 15000);
            checkpoint();
            if (probed.ok) {
              log(`· 隧道探测第 ${i + 2} 次通了（${probed.ms}ms）—— 刚才那次是抖动，地址不动`);
            }
          }
          tunnelProbe = probed;

          if (probed.ok) {
            if (!wantStatusOnly) writeProbeState({ fails: 0, lastError: null, lastOkAt: new Date().toISOString() });
          } else {
            const why = probed.error || `HTTP ${probed.status}`;
            const fails = st.fails + 1;
            if (!wantStatusOnly) writeProbeState({ fails, lastError: why, lastOkAt: st.lastOkAt });
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

    checkpoint();
    if (!tunnelPolicy.enabled) {
      log('· Public tunnel startup and probing disabled (tunnelProvider: none). Existing external processes are not stopped by this setting.');
    } else if (wantStatusOnly) {
      log('· 只读状态检查，不启动或重建隧道');
    } else if (tunnelUp && !tunnelStale && !tunnelDead) {
      // 在跑、而且真连得上 —— 什么都不用做（上面已经记完状态、通知完）
    } else if ((tunnelUp && tunnelStale) || tunnelDead) {
      if (tunnelStale) log(`· 隧道指向 ${tunnelTargetPort}，但中间层现在在 ${port} —— 重启隧道让它跟上`);
      checkpoint();
      tunnel.stopTunnels();
      await sleep(2000);
      checkpoint();
      const res = await tunnel.startTunnel(port, publicTunnelPreference, tunnelAdmission);
      checkpoint();
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
        checkpoint();
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
      checkpoint();
      const killed = tunnel.stopTunnels();
      if (killed) log(`· 建新隧道前先停掉 ${killed} 个残留的隧道进程`);
      await sleep(2000);
      checkpoint();
      const res = await tunnel.startTunnel(port, publicTunnelPreference, tunnelAdmission);
      checkpoint();
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
        disabled: !tunnelPolicy.enabled,
        running: tunnelPolicy.enabled ? tunnelRunning() || !!tunnelUrl : null,
        reachable: tunnelProbe ? tunnelProbe.ok : null,     // null = 这轮没探测
        probeMs: tunnelProbe ? tunnelProbe.ms : null,
        probeError: tunnelProbe && !tunnelProbe.ok
          ? (tunnelProbe.error || `HTTP ${tunnelProbe.status}`) : null,
        probeFails: tunnelPolicy.enabled ? readProbeState().fails : 0
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
    checkpoint();
    if (!wantStatusOnly) writeStatus(status);

    log('──────── 启动器结束 ────────');
  } catch (err) {
    if (err.code === 'daemon-owned-gateway-unverified') admission?.retain();
    stopped = err.code === 'daemon-stop-requested';
    log(stopped ? '· Stop intent observed; no further daemon startup is admitted.' : `✗ 异常: ${err.message}`);
    const anotherOperation = !admission && err.code === 'daemon-operation-pending';
    if (!wantStatusOnly && !stopped && !anotherOperation) writeStatus({ updatedAt: new Date().toISOString(), error: err.message });
    process.exitCode = stopped || anotherOperation ? 0 : 1;
  } finally {
    if (admission) {
      try {
        await admission.quiesce();
        try { admission.checkpoint(); } catch (error) { if (error.code === 'daemon-stop-requested') stopped = true; else throw error; }
        if (stopped) await stopOwnedGatewayChildren(admission, identity);
        admission.release({ stopRequested: stopped });
      } catch (_) {
        log('Daemon operation remains unconfirmed; admission evidence retained and automatic startup blocked.');
        process.exitCode = 1;
      }
    }
  }
}
if (require.main === module) runDaemon().catch(() => { process.exitCode = 1; });
module.exports = { createDaemonOperationLease, runDaemon };
