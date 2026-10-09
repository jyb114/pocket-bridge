// DSH 移动端网关 — 本地中间层（替代 Caddy 版本）
//
// 职责，按请求顺序：
//   1. PWA 资源（manifest / 图标 / service worker / 兼容层）—— 必须在认证之前，
//      因为浏览器取这些时还没有 cookie
//   2. 访问密钥校验，通过则种下会话 cookie 并返回一个自动跳转的过渡页
//   3. 没有 cookie 的一律 403
//   4. 其余请求反代到 DSH，并把 Host 固定成回环地址（DSH 的信任栅栏据此放行）
//   5. 对 HTML 响应注入 Iterator 兼容层 —— 这一步是 Caddy 做不到的，
//      也是老版本 Safari / iOS 能打开 DSH 的关键
//   6. WebSocket 升级转发（DSH 的实时通道走这里）
//
// 只用 Node 内置模块，不依赖任何第三方包。
'use strict';

require('./runtime-requirements.js').assertSupportedRuntime();

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// zlib 是内置的 —— 发 PWA 静态文件时用来压缩（见 servePwa）。
// 之前一个字节都没压，手机上「加载半天」最大的一块就是这个。
const zlib = require('zlib');
const { Readable } = require('stream');
const { spawn, execFile } = require('child_process');

const { sendWebPush } = require('./webpush.js');
const cfg = require('./config.js');
const retiredTargets = require('./retired-targets.js');
const dshPhoneSurface = require('./dsh-phone-surface.js');
const requestOrigin = require('./request-origin.js');
const routes = require('./routes.js');
const sessions = require('./sessions.js');
const e2eeBridge = require('./ws-e2ee-bridge.js');
const e2ee = require('./e2ee.js');
const replayAdmission = require('./replay-store.js');
const dshRuntime = require('./dsh-runtime.js');
const dshLazyImages = require('./dsh-lazy-images.js');
const dshLazyImageStore = require('./dsh-lazy-image-store.js');
const dictTrim = require('./dict-trim.js');   // 按语言裁剪页面（省语言包体积）
const phonePagePolicy = require('./phone-page-policy.js');
const privateHttpsAdmission = require('./private-https-admission.js');
const privateHttpsStatus = require('./tailscale-private-https.js');

const BASE = path.resolve(__dirname, '..');
// 实际监听端口要到启动时才定：配置/环境变量给个偏好，被占用就自动往后找
let PORT = Number(process.env.DSH_GW_PORT || 8080);
// 本机实例身份，启动时由 config.js 确认，/__health 会报给启动器
let INSTANCE_ID = null;
// Installation identity persists across restarts. This separate identity names
// only this process boot and is never used as an authentication credential.
const GATEWAY_BOOT_ID = crypto.randomUUID();
const TARGET_HOST = '127.0.0.1';

// DSH 每次启动都会换端口（启动日志里能看到 52224 → 53322 → … → 58347），
// 而会话 cookie 的 authority 是签发时就绑定死的。所以这里把两件事拆开：
//
//   INTERNAL_HOST  永远固定 —— 它既是我们发给 DSH 的 Host 头，
//                  也是 cookie payload 里的 authority。固定住，已配对的手机
//                  就不会因为 DSH 换端口而失效。
//   TARGET_PORT    实际连接的端口 —— 定期从 DSH 启动日志里重新发现。
const INTERNAL_HOST = '127.0.0.1:58347';
// 显式指定的端口优先于自动发现。
// 否则任何想手动指定端口的人都会被自动探测悄悄覆盖，很难排查。
const EXPLICIT_TARGET_PORT = process.env.DSH_GW_TARGET_PORT
  ? Number(process.env.DSH_GW_TARGET_PORT)
  : null;
let TARGET_PORT = EXPLICIT_TARGET_PORT || 58347;
const LOG_DIR = path.join(BASE, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');
const PWA_DIR = path.join(BASE, 'pwa');
const DSH_LAZY_IMAGE_DIR = path.join(LOG_DIR, 'dsh-onboarding-images');
const dshDirectories = require('./dsh-directories.js').createDirectoryService({ defaultPath: BASE });
const serveDshDirectoriesE2ee = e2eeWrap(dshDirectories.handle);
const serveDshLiteAddressesE2ee = e2eeWrap(serveDshLiteAddresses);
const dshLiteAttachment = require('./dsh-lite-attachment.js');
const dshRuntimeIdentity = require('./dsh-runtime-identity.js').runtimeIdentity;
// Tiny mobile DSH UI uses only four fixed unary RPCs. The browser never
// supplies an upstream URL; this transport always targets the verified local
// DSH listener and leaves the full desktop application untouched.
function callDshLiteUpstream(call) {
  return refreshDshRuntimeState().then(state => {
    if (!state.ready || DSH_UPSTREAM_AUTH_OK === false) throw new Error('dsh-unavailable');
    if (call.verifiedRuntime && dshRuntimeIdentity(call.verifiedRuntime) !== dshRuntimeIdentity(state.runtime))
      throw new Error('legacy-runtime-changed');
    const upstreamPort = call.verifiedRuntime ? call.verifiedRuntime.port : TARGET_PORT;
    markActivity();
    return new Promise((resolve, reject) => {
      const headers = Object.assign({}, call.headers, {
        host: INTERNAL_HOST, origin: `http://${INTERNAL_HOST}`
      });
      if (UPSTREAM_COOKIE) headers.cookie = `${UPSTREAM_COOKIE.name}=${UPSTREAM_COOKIE.value}`;
      let upstream, currentResponse, settled = false;
      function fail(error) {
        if (settled) return;
        settled = true;
        reject(error);
        // Reject once before closing the owned pair. Re-emitting an Error via
        // a completed request's socket can become an unhandled Socket error.
        if (currentResponse) currentResponse.destroy();
        if (upstream) upstream.destroy();
      }
      upstream = http.request({ host: TARGET_HOST, port: upstreamPort,
        method: 'POST', path: call.path, headers, signal: call.signal,
        timeout: 15000 }, response => {
        currentResponse = response;
        const chunks = [];
        let bytes = 0;
        // Only this fixed, read-only official image operation can carry the
        // bounded base64 raster envelope. Other RPCs retain their existing cap.
        const responseCap = call.path === '/api/session/attachment' && call.method === 'POST' ?
          dshLiteAttachment.MAX_RESPONSE_BYTES : 1024 * 1024;
        const responseLimit = Number.isSafeInteger(call.maxResponseBytes) &&
          call.maxResponseBytes > 0 && call.maxResponseBytes <= responseCap ?
          call.maxResponseBytes : 512 * 1024;
        response.on('data', chunk => {
          if (settled) return;
          if (bytes + chunk.length > responseLimit) {
            fail(new Error('dsh-response-too-large'));
            return;
          }
          bytes += chunk.length;
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks, bytes) });
        });
        response.on('error', fail);
      });
      upstream.on('timeout', () => fail(new Error('dsh-timeout')));
      upstream.on('error', fail);
      upstream.end(call.body);
    });
  });
}
const serveDshLiteRpcE2ee = e2eeWrap(require('./dsh-lite-rpc.js')
  .createDshLiteRpc({ callUpstream: callDshLiteUpstream }));
const serveDshLiteUploadE2ee = e2eeWrap(require('./dsh-lite-upload.js')
  .createDshLiteUpload({ callUpstream: callDshLiteUpstream }));
const serveDshLiteDownloadE2ee = e2eeWrap(require('./dsh-lite-download.js')
  .createDshLiteDownload());
const serveDshLiteFilesE2ee = e2eeWrap(require('./dsh-lite-files.js')
  .createDshLiteFiles());
const serveDshLiteAttachmentE2ee = e2eeWrap(dshLiteAttachment.createDshLiteAttachment({
  callUpstream: callDshLiteUpstream,
  resolveRuntime: async () => {
    const state = await refreshDshRuntimeState();
    return state.ready ? state.runtime : null;
  }
}));
// ── 抓屏：把电脑屏幕送到手机上 ─────────────────────────────────────────────────
//
// 使用者人不在电脑前时，最缺的不是"再点一个按钮"，而是**看见电脑现在什么样**：
// 哪个窗口弹出来了、进度卡在哪、桌面上那个报错框写了什么。
// 抓屏是**只读**的 —— 不注入、不抢焦点、不模拟按键。唯一的敏感点是画面本身，因此它和会话内容
// 走同一道门（E2EE_CONTENT_PATHS），而且每抓一次都写日志，事后可查。
const serveDshLiteScreenE2ee = e2eeWrap(require('./dsh-lite-screen.js')
  .createDshLiteScreen({ log: (line) => log(`抓屏：${line}`) }));
const dshLegacyAttachments = require('./dsh-legacy-attachments.js').createDshLegacyAttachments({
  getRuntime: async force => { const state = await refreshDshRuntimeState(force); return state.ready ? state.runtime : null; }
});
const serveDshLegacyUploadE2ee = e2eeWrap(dshLegacyAttachments.handle);
const serveDshLiteLegacyRpcE2ee = e2eeWrap(require('./dsh-lite-legacy-rpc.js')
  .createDshLiteLegacyRpc({ callUpstream: callDshLiteUpstream,
    resolveAttachments: async (sessionId, receipts) => {
      const state = await refreshDshRuntimeState(true);
      return { ...dshLegacyAttachments.resolveForPrompt(sessionId, receipts, state.ready ? state.runtime : null), runtime: state.runtime };
    },
    runtimeProfile: async (method) => {
      const mutates = ['workspace.create', 'session.create', 'session.prompt', 'session.cancel', 'session.selectModel', 'agentPreset.select'].includes(method);
      const state = await refreshDshRuntimeState(mutates);
      return state.ready && state.runtime ? state.runtime.profile : null;
    } }));
const legacyRuntimeIdentity = require('./dsh-legacy-interactions.js').runtimeIdentity;
function openDshLegacyWebSocket(runtime) {
  if (UPSTREAM_COOKIE) return Promise.reject(new Error('legacy-websocket-auth-unavailable'));
  return new Promise((resolve, reject) => {
    const stream = new (require('node:stream').PassThrough)();
    stream.on('error', () => {});
    // Official rc.8/rc.2 client-connection exposes its event downlink as
    // WebSocket; its pure ApiProxy fetch seam exposes the same frames as SSE.
    // This socket remains loopback-only. The phone gets filtered E2EE JSON.
    const ws = new WebSocket(`ws://${TARGET_HOST}:${runtime.port}/api/events.mux`);
    let opened = false;
    const timer = setTimeout(() => { reject(new Error('legacy-stream-timeout')); ws.close(); }, 3000);
    ws.addEventListener('open', () => { opened = true; clearTimeout(timer); stream.write(': connected\n\n'); resolve(stream); });
    ws.addEventListener('message', event => {
      if (stream.destroyed) return;
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1024 * 1024) {
        stream.destroy(new Error('legacy-event-invalid')); return;
      }
      stream.write('data: ' + event.data + '\n\n');
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('legacy-stream-unavailable'));
      if (!stream.destroyed) stream.destroy(new Error('legacy-stream-unavailable')); });
    ws.addEventListener('close', () => { clearTimeout(timer);
      if (!opened) reject(new Error('legacy-stream-unavailable'));
      if (!stream.destroyed) stream.destroy(new Error('legacy-stream-unavailable')); });
    stream.once('close', () => { clearTimeout(timer); if (ws.readyState < 2) ws.close(); });
  });
}
async function openDshLegacyEvents(runtime) {
  const state = await refreshDshRuntimeState();
  if (!state.ready || legacyRuntimeIdentity(runtime) !== legacyRuntimeIdentity(state.runtime))
    throw new Error('legacy-runtime-changed');
  return new Promise((resolve, reject) => {
    const headers = { host: INTERNAL_HOST, origin: `http://${INTERNAL_HOST}`,
      accept: 'text/event-stream', 'accept-encoding': 'identity' };
    if (UPSTREAM_COOKIE) headers.cookie = `${UPSTREAM_COOKIE.name}=${UPSTREAM_COOKIE.value}`;
    const request = http.get({ host: TARGET_HOST, port: runtime.port, path: '/api/events.mux', headers,
      timeout: 3000 }, response => {
      if (response.statusCode === 426 && /^websocket$/i.test(response.headers.upgrade || '')) {
        response.destroy();
        openDshLegacyWebSocket(runtime).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200 || !/^text\/event-stream(?:;|$)/i.test(response.headers['content-type'] || '')) {
        response.destroy(); reject(new Error('legacy-stream-unavailable')); return;
      }
      response.once('close', () => request.destroy());
      resolve(response);
    });
    request.on('timeout', () => request.destroy(new Error('legacy-stream-timeout')));
    request.on('error', reject);
  });
}
const serveDshLegacyInteractionsE2ee = e2eeWrap(require('./dsh-legacy-interactions.js')
  .createDshLegacyInteractions({
    getRuntime: async force => { const state = await refreshDshRuntimeState(force); return state.ready ? state.runtime : null; },
    openEvents: openDshLegacyEvents,
    respond: async (runtime, message) => {
      const body = Buffer.from(JSON.stringify(message));
      const upstream = await callDshLiteUpstream({ verifiedRuntime: runtime, path: '/api/respond', method: 'POST', body,
        maxResponseBytes: 65536, headers: { 'content-type': 'application/json', 'content-length': String(body.length),
          accept: 'application/json', 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10000) });
      if (upstream.statusCode !== 200) throw new Error('legacy-response-unavailable');
      return JSON.parse(upstream.body.toString('utf8'));
    }
  }));
const COOKIE_MAX_AGE = 2592000; // 30 天

/**
 * 日志上限。
 *
 * proxy.log 只涨不缩 —— 实测跑到 10 MB 还在长，而且它记的是**每一帧 WebSocket**
 * （手机连着的时候一秒好几行）。使用者的盘本来就紧张，日志不该是压垮它的那根稻草。
 *
 * 到上限就把旧内容挪到 proxy.log.1，当前文件重新开始。
 *
 * ★ 原来是「读整个文件 → 截掉前 3/4 → 写回去」—— 那是一次**同步**的
 *   3MB 读 + 1MB 写，而 log() 是在请求路径上被调的（每个请求、每帧 WebSocket）。
 *   赶上一次轮转，那几百毫秒里整个网关是卡住的。
 *   改成改名：rename 在同一分区上是常数时间，不碰内容。
 *   代价是磁盘上最多留两份（当前 + 上一份），仍然是有界的。
 */
const LOG_MAX_BYTES = 3 * 1024 * 1024;
let logWrites = 0;

function rotateLogIfNeeded() {
  let size = 0;
  try { size = fs.statSync(LOG_FILE).size; } catch (e) { return; }
  if (size <= LOG_MAX_BYTES) return;
  try {
    // 只留一份历史：先删掉更早的那份，再把当前这份改名过去
    try { fs.unlinkSync(`${LOG_FILE}.1`); } catch (e) { /* 本来就没有 */ }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.writeFileSync(LOG_FILE,
      `${new Date().toISOString()} （日志超过 ${(LOG_MAX_BYTES / 1048576).toFixed(0)} MB，` +
      `旧内容已挪到 proxy.log.1）\n`, 'utf8');
  } catch (e) { /* 转不动就继续写，不能因为日志把服务搞挂 */ }
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) { /* 日志失败不影响服务 */ }
  // 每 500 次才查一次文件大小 —— statSync 不贵，但也没必要每行都做
  if (++logWrites % 500 === 0) rotateLogIfNeeded();
}

// ── 读取凭据 ──────────────────────────────────────────────────────────────────
let COOKIE_NAME = '';
let COOKIE_VALUE = '';
let ACCESS_KEY = '';
let UPSTREAM_COOKIE = null;
let DSH_UPSTREAM_AUTH_OK = null;
const dshUpstreamAuth = require('./dsh-upstream-auth.js').createUpstreamAuth({ authority: INTERNAL_HOST });

try {
  const firstRun = require('./first-run.js').ensureFirstRun(BASE);
  if (firstRun.createdAccessKey || firstRun.createdE2eeKey) {
    log('首次启动：已在本机生成访问密钥和端到端加密密钥');
  }
  ACCESS_KEY = fs.readFileSync(path.join(LOG_DIR, 'access-key.txt'), 'utf8').trim();

  if (firstRun.dshCookie === 'existing' || firstRun.dshCookie === 'created') {
    const cj = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'mint-cookie.json'), 'utf8'));
    COOKIE_NAME = cj.cookieName;
    COOKIE_VALUE = cj.cookieValue;
  } else {
    // DSH is optional. The console still needs a gateway when DSH is not installed login cookie,
    // but must never pretend to hold a valid DSH session.
    COOKIE_NAME = 'pocket-bridge-auth';
    COOKIE_VALUE = crypto.createHmac('sha256', ACCESS_KEY)
      .update('gateway-cookie-v1').digest('base64url');
    log('未找到可用的 DSH 会话凭据：控制台仍可使用；请配置 DSH 的真实凭据后重试');
  }
} catch (err) {
  log(`FATAL 无法初始化本机密钥: ${err.message}`);
  process.exit(1);
}

// 只用于告诉手机“这已经不是上一次的访问密钥了”。它是截断哈希，不能
// 反推出密钥；手机据此清除旧版的加密脚本缓存，避免轮换后卡在安全拒绝页。
const ACCESS_KEY_EPOCH = crypto.createHash('sha256').update(ACCESS_KEY).digest('hex').slice(0, 16);

// ★ SameSite 必须是 Lax，**不能是 Strict**。
//
//   Strict 的语义是「任何跨站导航都不带这个 cookie」。而 iOS「从主屏幕图标
//   启动网页 App」这次导航，系统把它当成来自外部（桌面）的导航 —— 于是
//   cookie **不会被发送**。实测：手机用密钥登录成功（日志「密钥认证成功」），
//   紧接着 GET / 却是「403 无会话 cookie」，页面上只留一行
//   「access key required」—— 主屏幕图标因此永远打不开。
//
//   Lax 会在**顶级导航**时带上 cookie（正是主屏启动、点链接进来这两种），
//   而 POST、iframe、子资源这些跨站请求仍然不带 —— 挡 CSRF 的那部分作用保留了。
UPSTREAM_COOKIE = { name: COOKIE_NAME, value: COOKIE_VALUE };
// Browser cookies are shared across ports on one host. Keep DSH's upstream
// cookie separate from the browser login so two gateways cannot log each
// other out. The final listener port is added before server.listen below.
let GATEWAY_AUTH_COOKIE = '';
let SET_COOKIE_VALUE = '';

// ── 设备会话（第二道门）───────────────────────────────────────────────────────
//
// 为什么还要多一道：访问密钥是所有设备共用的一把锁，某一台手机丢了的话，
// 你只能把锁整个换掉 —— 所有设备一起重新配对。设备令牌把这把锁变成「每台一把」，
// 可以只看某台、只关某台。
//
// 为什么不能只留这一道：DSH 自己会校验它那个 cookie 的值（伪造值返回 401，
// 实测见 scripts/probe-cookie-authority.js），所以浏览器仍然必须持有它。
const LEGACY_DEVICE_COOKIE = 'dsh-gw-session';
let DEVICE_COOKIE = '';
// SameSite 用 Lax 而不是 Strict —— 理由见上面 SET_COOKIE_VALUE 那段注释：
// Strict 会让 iOS 从主屏幕图标启动时不带 cookie，主屏入口直接变成
// 「access key required」。
const DEVICE_COOKIE_ATTRS = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;

function configureAuthCookieScope(port) {
  const scope = crypto.createHmac('sha256', ACCESS_KEY)
    .update('gateway-cookie-scope-v1\n' + BASE + '\n' + String(port)).digest('hex').slice(0, 16);
  GATEWAY_AUTH_COOKIE = `${COOKIE_NAME}-${scope}`;
  DEVICE_COOKIE = `${LEGACY_DEVICE_COOKIE}-${scope}`;
  SET_COOKIE_VALUE = `${GATEWAY_AUTH_COOKIE}=${COOKIE_VALUE}; ${DEVICE_COOKIE_ATTRS}`;
}

function readNamedCookie(req, name) {
  for (const segment of String(req.headers.cookie || '').split(';')) {
    const pair = segment.trim();
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return null;
}

function hasLegacyAuthCookie(req) {
  const value = readNamedCookie(req, COOKIE_NAME);
  return value !== null && safeEqualStr(value, COOKIE_VALUE);
}

/** Migrate a matching old login without deleting other gateways' cookies. */
function migrateLegacyRequestCookies(req, res) {
  if (readNamedCookie(req, GATEWAY_AUTH_COOKIE) !== null || !hasLegacyAuthCookie(req)) return;
  const token = readNamedCookie(req, LEGACY_DEVICE_COOKIE);
  const issued = authCookies(token);
  res.__pendingCookies.push(...issued);
  replaceIssuedRequestCookies(req, issued);
}

function deviceCookieValue(token) {
  return `${DEVICE_COOKIE}=${token}; ${DEVICE_COOKIE_ATTRS}`;
}

/** 一次认证要同时种下两个 cookie，所以 set-cookie 必须是数组。 */
function authCookies(token) {
  return token ? [SET_COOKIE_VALUE, deviceCookieValue(token)] : [SET_COOKIE_VALUE];
}

/** Reflect freshly issued cookies in an internally redispatched request. */
function replaceIssuedRequestCookies(req, issued) {
  const fresh = new Map();
  for (const cookie of issued) {
    const pair = String(cookie).split(';')[0].trim();
    const separator = pair.indexOf('=');
    if (separator > 0) fresh.set(pair.slice(0, separator), pair);
  }
  const retained = String(req.headers.cookie || '').split(';').map(pair => pair.trim())
    .filter(pair => pair && !fresh.has(pair.slice(0, pair.indexOf('='))));
  req.headers.cookie = retained.concat([...fresh.values()]).join('; ');
}

function readDeviceToken(req) {
  const scoped = readNamedCookie(req, DEVICE_COOKIE);
  if (scoped !== null) return scoped || null;
  // A scoped login must never inherit an unrelated port's old device token.
  if (readNamedCookie(req, GATEWAY_AUTH_COOKIE) !== null || !hasLegacyAuthCookie(req)) return null;
  return readNamedCookie(req, LEGACY_DEVICE_COOKIE) || null;
}

// ── 配对码 ────────────────────────────────────────────────────────────────────
// 长 URL 在手机上很难输入，所以再给一个 6 位数字入口：手机打开 /pair
// 输入这串数字就能登记一台**还没登记过的新设备**。
//
// 配对码不随网关重启更换：已配对设备使用独立的设备令牌，重复更换配对码
// 不会撤销那些设备，却会让需要重新配对的手机无法使用原码。
// 启动时复用文件里的码；签发满 90 天后首次读取时更换，也可在控制台手动更换。
// 安全边界与轮换逻辑见 pair-code.js。
const PAIR_CODE_FILE = path.join(BASE, 'logs', 'pair-code.txt');
const pairCode = require('./pair-code.js');
// 用 crypto.randomInt（在 pair-code.js 里）—— 不用 Math.random：
// 它可预测（V8 的 xorshift128+ 拿到几个输出就能反推内部状态），而这是进门凭证。
let PAIR_CODE = pairCode.loadOrCreate(PAIR_CODE_FILE).code;
/**
 * 把配对码写进文件。
 *
 * ★ **一定要等 listen 成功之后再写**，不能在这一步就写。
 *
 *   看门狗每 5 分钟拉一次中间层，而它判断「已经在跑」靠的是探 /__health ——
 *   那一探偶尔会超时（网关正忙的时候实测撞到过）。于是它会再起一个进程，
 *   那个进程**端口抢不到、随即 FATAL 退出**；但它退出前已经执行到模块顶层，
 *   把 pair-code.txt 覆盖成了**它自己那把、根本没人认的码**。
 *   实测就是这么发生的：日志里网关的码是 485106，文件里却是 815456 ——
 *   而 connect.js、启动器的状态输出都是读这个文件的，照着念给使用者就是错的码。
 *
 *   写文件是**副作用**，副作用只能在「我确实是那个活着的实例」之后做。
 */
function writePairCodeFile() {
  try {
    // 只有内容变了才写：每次启动都重写会把「这张码什么时候发出去的」刷新成
    // 「现在」，于是 90 天过期这条判据永远不成立（一条永久有效的码）。
    if (pairCode.writeIfChanged(PAIR_CODE_FILE, PAIR_CODE)) {
      log(`配对码已更新：${PAIR_CODE}（重启不再更换；要换在控制台点「换一个配对码」）`);
    } else {
      log('配对码沿用上一张（重启不更换；签发满 90 天或手动更换才会变）');
    }
  } catch (err) {
    // 不能把没有落盘的内存码当作可用；currentPairCode 会拒绝新设备配对。
    log(`配对码落盘失败：${err.message}`);
  }
}

/**
 * 配对入口和电脑控制台共用这一张码。每次读取都检查签发时间：网关连续运行
 * 超过 90 天也会更新，而不是等下一次重启。写文件失败时暂停新设备配对，
 * 不能退回已过期的内存缓存。
 */
function currentPairCode() {
  try {
    const active = pairCode.current(PAIR_CODE_FILE);
    if (active.code !== PAIR_CODE) {
      PAIR_CODE = active.code;
      log(`配对码已更新：${PAIR_CODE}（签发满 90 天或文件被更换）`);
    }
    return PAIR_CODE;
  } catch (err) {
    log(`配对码文件不可用，暂停新设备配对：${err.message}`);
    return null;
  }
}

// ── 页面语言（服务端直出）─────────────────────────────────────────────────────
//
// 配对页 / 选择页 / 启动页 / 过渡页都是**服务端直出**的：浏览器拿到它们的时候，
// pwa/i18n.js 还没跑（那要等进了 DSH 之后），所以语言只能由服务端定。
//
// 选语言的优先级（见 pickLang）：
//   1. 地址上的 ?lang=xx —— 使用者刚在页面上点的那一下
//   2. dsh-lang cookie  —— 以前点过的那一下（记一年）
//   3. Accept-Language  —— 浏览器天生会带，而且已经按使用者的偏好排好序（q 值）
//   4. 英语             —— 兜底
//
// ★ 为什么 ?lang= 必须压过 cookie：cookie 记的是「以后都按这个来」，
//   而带参数的那一次是「就现在这一下，我要看那个语言」。顺序反了的话，
//   在页面上点「English」会毫无反应（cookie 里存着旧语言，页面照旧），
//   使用者只会认为切换坏了。
//
// 兜底为什么是英语：和 pwa/i18n.js 的取舍一致 —— 三种语言里它最可能被当第二语言
// 看懂。另外**故意不看 localStorage**：这几个页面恰恰是还没有 cookie 的时候要看的
// （配对页本身就是来换 cookie 的），而且它们里面没有脚本，读不了 localStorage。
const PAGE_LANGS = ['zh', 'en', 'es'];
const LANG_NAMES = { zh: '中文', en: 'English', es: 'Español' };
const LANG_COOKIE = 'dsh-lang';
const LANG_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;   // 一年

/** ?lang= 里明确指定的语言；没写 / 不是我们支持的 → null。 */
function langFromQuery(req) {
  try {
    const u = new URL(String((req && req.url) || '/'), 'http://localhost');
    const v = String(u.searchParams.get('lang') || '').trim().toLowerCase().split('-')[0];
    return PAGE_LANGS.indexOf(v) >= 0 ? v : null;
  } catch (err) {
    return null;   // 地址都解析不了，就当下面的判断不存在
  }
}

/** 以前手选过、记在 cookie 里的语言（没选过 / 值不认识 → null）。 */
function langFromCookie(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  for (const seg of raw.split(';')) {
    const s = seg.trim();
    if (!s.startsWith(`${LANG_COOKIE}=`)) continue;
    const v = s.slice(LANG_COOKIE.length + 1);
    return PAGE_LANGS.indexOf(v) >= 0 ? v : null;
  }
  return null;
}

/**
 * 按 Accept-Language 挑一个语言。
 *
 * 头长这样：`zh-CN,zh;q=0.9,en;q=0.8`。规则：
 *   · 只认主语言（zh-CN → zh。不做地区变体：zh-TW / es-419 照样给 zh / es）
 *   · 按 q 从大到小挑，q 相同就按出现顺序（浏览器已经按偏好排过了）
 *   · q=0 是「明确不要」，跳过
 *   · 一个都不认识（比如只有 fr-FR）、或者压根没带这个头 → 英语
 */
function langFromHeader(req) {
  const header = String((req && req.headers && req.headers['accept-language']) || '');
  const wanted = [];
  header.split(',').forEach((part, at) => {
    const bits = part.trim().split(';');
    const tag = String(bits[0] || '').trim().toLowerCase().split('-')[0];
    if (!tag) return;
    let q = 1;
    for (let i = 1; i < bits.length; i++) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(bits[i]);
      if (m && isFinite(Number(m[1]))) q = Number(m[1]);
    }
    wanted.push({ tag, q, at });
  });
  wanted.sort((a, b) => (b.q - a.q) || (a.at - b.at));
  for (const w of wanted) {
    if (w.q > 0 && PAGE_LANGS.indexOf(w.tag) >= 0) return w.tag;
  }
  return 'en';
}

/** 这一页该用什么语言。优先级：?lang= → dsh-lang cookie → Accept-Language → 英语。 */
function pickLang(req) {
  return langFromQuery(req) || langFromCookie(req) || langFromHeader(req);
}

/**
 * 页面入口用这个：挑语言，并且把**这一次的手选**记进 cookie。
 *
 * 只有带 ?lang= 来的那一次才记 —— 自动协商出来的语言不写 cookie。否则
 * 「按浏览器偏好猜的」会被固化成「使用者选的」，以后再改浏览器语言就不生效了，
 * 而使用者根本不知道自己什么时候选过。
 */
function pageLanguage(req, res) {
  const chosen = langFromQuery(req);
  if (chosen && res && res.__pendingCookies) {
    // 用 __pendingCookies 而不是 setHeader：/pair 成功那一条要同时种三个 cookie
    // （DSH 会话 + 设备令牌 + 语言），而 writeHead 传的 set-cookie 会盖掉先 setHeader 的。
    // 这个队列由 installCookieMerger 统一合并，写在哪个分支都不会漏。
    res.__pendingCookies.push(
      `${LANG_COOKIE}=${chosen}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax`);
  }
  return pickLang(req);
}

/** 归一化：不认识的语言一律当英语（pickLang 已经保证了，这里是第二道保险）。 */
function normLang(lang) {
  return PAGE_TEXT[lang] ? lang : 'en';
}

/** 取某个语言的文案包。 */
function pageText(lang) {
  return PAGE_TEXT[normLang(lang)];
}

/**
 * 页面底部的语言切换：中文 · English · Español。
 *
 * 每条就是一个普通链接，指向「当前这个地址 + ?lang=xx」—— 点一下浏览器重新请求
 * 一次，服务端按新语言直出同一页。所以切换不需要页面里有任何脚本，也不在页面
 * 这一层引入状态：刷新之后人还在同一页，只是换了语言。
 *
 * 其它查询参数原样保留（比如 /pair 上的 code），换语言不会把上下文丢掉。
 * `light` 给那些没铺深色底的页面（只有一句话的提示页）用，免得浅底上写浅灰字。
 */
function langSwitcher(req, lang, light) {
  let pathname = '/';
  let query = '';
  try {
    const u = new URL(String((req && req.url) || '/'), 'http://localhost');
    pathname = u.pathname;
    u.searchParams.delete('lang');
    query = u.searchParams.toString();
  } catch (err) { /* 解析不了就退回根路径 */ }

  const idle = light ? '#666' : '#8a8a92';
  const active = light ? '#111' : '#eee';
  const links = PAGE_LANGS.map((code) => {
    const style = `color:${code === lang ? active : idle};text-decoration:none;padding:2px 6px`;
    if (code === lang) return `<span style="${style};font-weight:600">${LANG_NAMES[code]}</span>`;
    // 属性里的 & 要写成 &amp;，否则严格一点的解析器会把它当成实体开头
    const href = `${pathname}?${query ? `${query}&` : ''}lang=${code}`.replace(/&/g, '&amp;');
    return `<a href="${href}" style="${style}">${LANG_NAMES[code]}</a>`;
  }).join('<span style="opacity:.45"> · </span>');

  return `<div style="text-align:center;font-size:12.5px;margin-top:20px">${links}</div>`;
}

/**
 * 页面文案（中 / 英 / 西）。
 *
 * 中文那一份就是**原文**，一个标点都没动 —— 中文页面和加多语言之前逐字节一样。
 *
 * 为什么把文案抽成数据、而不是写三份 HTML：页面结构只有一份，`id` / `name` /
 * `action` 这些于是也只在一处出现。三个语言各抄一份 HTML 的话，以后改一次界面
 * 就得记得改三遍，漏一遍就是某个语言少了元素 —— 而这种错只有那一种语言的使用者
 * 会碰到，我们这边根本看不见。
 *
 * 英文 / 西语里的键仍然是中文原文 —— 和 pwa/i18n.js 的约定一致（那边也是拿中文
 * 原文当 key），两边对照着看时一眼能找到同一句话。
 *
 * 术语口径（三个页面统一）：
 *   配对码 = pairing code / código de emparejamiento
 *   访问密钥 = access key / clave de acceso
 *   加密 = encrypted / cifrado      隧道 = tunnel / túnel
 *   内网 = local network / red local  工作台 = workbench / escritorio de trabajo
 */
const PAGE_TEXT = {
  zh: {
    pair: {
      title: '连接 DSH',
      heading: '连接 DSH',
      lead: '输入电脑控制台上「配对码」那张卡里的 6 位数字。',
      submit: '连接',
      hint: '配对码不会因为重启而更换；签发满 90 天后，或你在电脑控制台点「换一个配对码」时才会更换。已连上的手机不受影响。',
      // ★ 2026-09-27 起必须说清这件事：
      //   挑战应答开成真拦之后，「配对成功」只等于**把这台设备登记进来**，
      //   而内容要另一样东西 —— 地址 # 后面那把钥匙（只有电脑控制台
      //   「复制地址」给的完整链接里才有）。不写这句，只拿配对码进来的使用者
      //   会看到「配对成功、然后什么都没有」，而完全不知道差在哪。
      keyNote: '配对只是把这台设备登记进来。要**看到内容**，还需要用电脑控制台'
        + '「复制地址」里的完整链接打开一次 —— 那条链接 <code>#</code> 后面带着钥匙。',
      warn: '⚠️ 配对成功后，这台设备就拥有你电脑的完全访问权。<br>\n' +
        '    不要把配对码或访问地址分享给任何人。'
    },
    launcher: {
      title: '选择要连的东西',
      heading: '要用哪个？',
      sub: '选择这台电脑上可用的应用，之后会记住你的选择。',
      checking: '正在检查…',
      none: '没有找到可连的东西',
      noneHint: '请先在电脑上安装 DSH，再点「重新检查」。',
      missing: '这台电脑上没有找到 {name}。请先安装它，或选择下面可用的应用。',
      retry: '重新检查',
      // 「拿不到列表」和「没装东西」是两回事，必须分开说 —— 不然使用者会去
      // 检查电脑上装没装，而真正的原因在他手里那条地址上。
      needKey: '这条地址打不开目标列表。请用电脑控制台「复制链接」给的完整地址'
        + '重新打开一次（地址末尾 # 后面那串不能少）。',
      open: '打开 ',
      start: '启动',
      stop: '停止',
      starting: '启动中…',
      stopping: '停止中…',
      // {name} 由页面里的脚本替换成目标名（比如 DSH）
      stopConfirm: '停止 {name} ？',
      stopDsh: 'DSH 自己的窗口也会关掉。',
      stopOther: '只停远程服务，桌面版不受影响。',
      failed: '操作失败',
      failedWith: '操作失败：',
      listFailed: '读不到目标列表：',
      foot: '没在运行的可以先在这里启动，不用跑到电脑跟前。<br>\n' +
        '  选错了也不要紧 —— 进去之后页面右下角有切换入口。'
    },
    enter: {
      dsh: '正在进入 DSH…',
    },
    starting: {
      title: '正在启动 DSH',
      heading: '正在启动 DSH',
      body: '电脑上的 DSH 之前没在运行，已经帮你打开了。<br>\n' +
        '     首次启动需要几秒，这个页面会自动刷新。'
    },
    errors: {
      tooMany: '尝试次数过多，请稍后再试。',
      wrongCode: '配对码不对，回上一页重试。',
      pairUnavailable: '暂时无法读取配对码。请在电脑控制台检查网关日志后重试。',
      ticketTitle: '这条链接不能用了',
      ticketUsed: '这条链接已经用过或过期了。<br><br>' +
        '到电脑上打开控制台，重新复制一条地址。',
      ticketFresh: '这条链接一分钟内有效。<br>' +
        '回到原来那个页面，重新点一次「切到这条」。',
      needProofTitle: '正在验证这台设备',
      needProofBody: '等几秒就行，这一页会自己通过。<br>'
        + '现在是空的，是因为这台设备还没验证完。',
      needProofHealing: '正在自动验证…',
      needProofRetry: '重试一次',
      needProofHint: '还停在这一页时：<br>'
        + '1. 先看手机上打开的是不是**完整地址** —— 末尾要有 <code>#</code> 加一串字符。'
        + '少了它，怎么重试都进不去；<br>'
        + '2. 点「重试一次」；<br>'
        + '3. 还不行就到电脑上打开控制台 →「复制链接」→ 用那条完整地址在手机上重新打开一次。',
      needProofPair: '去配对页',
      needPairTitle: '需要重新配对',
      needPairHint: '在电脑上打开控制台，输入里面的 6 位配对码即可。',
      device: {
        revoked: '这台设备已被注销。想继续用，请在电脑控制台里重新配对。',
        expired: '登录已过期。到电脑控制台复制一条新地址，或用配对码重新进入。',
        unknown: '这台设备不在名单里。到电脑控制台复制一条新地址，或用配对码重新进入。',
        superseded: '这台设备的登录已被更新的取代。到电脑控制台复制一条新地址，或用配对码重新进入。'
      },
      deviceOther: '这台设备的身份验证没通过，请重新配对。',
      noKey: 'access key required. 实际访问: ',
      // 「这个地址里没有访问密钥」那一页（主屏图标 / 旧书签点开时看到的）
      noKeyTitle: '这个地址里没有访问密钥',
      noKeyWhy: '这个地址（或图标）里少了访问密钥，所以打不开。',
      noKeyHow: '两条出路，随便哪条都行：',
      noKeyStep1: '<b>用完整地址重开一次：</b>到电脑上打开控制台 →「复制手机地址」→ '
        + '把那条地址发到手机上打开。要重加主屏图标，<b>就在那条地址上加</b>。',
      noKeyStep2: '<b>或者用配对码：</b>点下面的按钮，输入电脑控制台上显示的 6 位数字。',
      noKeyFix: '换过访问密钥的话，旧地址会立刻失效 —— 重新复制一条新地址即可。',
      noKeyPair: '用配对码进入',
      noKeyAsked: '这次请求的是：'
    }
  },
  en: {
    pair: {
      title: 'Connect to DSH',
      heading: 'Connect to DSH',
      lead: 'Enter the 6 digits shown on the “Pairing code” card in the console '
        + 'on your computer.',
      submit: 'Connect',
      hint: 'Restarting does not change the pairing code. It changes 90 days after issue, or when you choose “New pairing code” in the console. Paired phones are unaffected.',
      // Pairing only registers the device — content needs the key from the console link
      keyNote: 'Pairing only registers this device. To **see content**, open once the ' +
        'full link from “Copy address” in the console on your computer — that link ' +
        'carries the key after <code>#</code>.',
      warn: '⚠️ Once paired, this device has full access to your computer.<br>\n' +
        '    Never share the pairing code or the access address with anyone.'
    },
    launcher: {
      title: 'Choose what to connect to',
      heading: 'What do you want to connect to?',
      sub: 'Choose an available app on this computer. Your choice will be remembered.',
      checking: 'Checking…',
      none: 'Nothing to connect to',
      noneHint: 'Install DSH on the computer, then tap Check again.',
      missing: '{name} was not found on this computer. Install it, or choose an available app below.',
      retry: 'Check again',
      needKey: 'This address cannot load the target list. Open the complete address '
        + 'from “Copy address” in the console on your computer again (the part after '
        + '# must not be dropped).',
      open: 'Open ',
      start: 'Start',
      stop: 'Stop',
      starting: 'Starting…',
      stopping: 'Stopping…',
      stopConfirm: 'Stop {name}?',
      stopDsh: 'This also closes the DSH window itself.',
      stopOther: 'Only the remote service stops — the desktop app keeps running.',
      failed: 'Action failed',
      failedWith: 'Action failed: ',
      listFailed: 'Could not load the target list: ',
      foot: 'Anything that is not running can be started right here — no need to walk ' +
        'over to the computer.<br>\n' +
        '  Picked the wrong one? No problem — there is a switcher in the ' +
        'bottom-right corner once you are in.'
    },
    enter: {
      dsh: 'Entering DSH…',
    },
    starting: {
      title: 'Starting DSH',
      heading: 'Starting DSH',
      body: 'DSH was not running on your computer, so it has been started for you.<br>\n' +
        '     The first launch takes a few seconds; this page refreshes itself.'
    },
    errors: {
      tooMany: 'Too many attempts. Please try again later.',
      wrongCode: 'That pairing code is not right. Go back and try again.',
      pairUnavailable: 'Pairing is temporarily unavailable. Check the gateway log in the computer console, then try again.',
      ticketTitle: 'This link no longer works',
      ticketUsed: 'This link has already been used or has expired.<br><br>' +
        'Open the console on your computer and copy a fresh address.',
      ticketFresh: 'This link works for one minute.<br>' +
        'Go back to the page you came from and tap “Switch to this” again.',
      needProofTitle: 'Verifying this device',
      needProofBody: 'Wait a few seconds — this page passes on its own.<br>' +
        'It is empty because this device is still being verified.',
      needProofHealing: 'Verifying automatically…',
      needProofRetry: 'Try again',
      needProofHint: 'Still on this page?<br>' +
        '1. Check that the address on your phone is the **complete** one — it must end ' +
        'with <code>#</code> followed by a string of characters. Without it, retrying ' +
        'will never work.<br>' +
        '2. Tap “Try again”.<br>' +
        '3. If it still fails: on your computer, open the console → “Copy link” → ' +
        'open that complete address once on your phone.',
      needProofPair: 'Go to pairing',
      needPairTitle: 'Pairing required',
      needPairHint: 'Open the console on your computer and enter the 6-digit pairing code shown there.',
      device: {
        revoked: 'This device has been revoked. To keep using it, pair again with the ' +
          'pairing code or the access key.',
        expired: 'This device’s session has expired. Please pair again.',
        unknown: 'This device is not on the list. Please pair again.',
        superseded: 'This device’s session was replaced by a newer one. Please pair again.'
      },
      deviceOther: 'This device failed verification. Copy a fresh address from the console, or pair again.',
      noKey: 'Access key required. Requested: ',
      noKeyTitle: 'This address has no access key',
      noKeyWhy: 'This address (or home-screen icon) is missing the access key, so it cannot open.',
      noKeyHow: 'Either way out works:',
      noKeyStep1: '<b>Open the full address again:</b> on your computer, open the console → '
        + '“Copy phone address” → send that address to your phone and open it. '
        + 'To re-add the Home Screen icon, <b>add it from that address</b>.',
      noKeyStep2: '<b>Or use the pairing code:</b> tap the button below and enter the '
        + '6-digit number shown in the console.',
      noKeyFix: 'If the access key was rotated, old addresses stop working — copy a fresh address.',
      noKeyPair: 'Enter with a pairing code',
      noKeyAsked: 'This request was for: ',
      // 票据被拒的原因（redeemTicket 的返回值）本身是**给逻辑用的**：
      // 调用处那个 /过期/ 判断和日志都在用它，所以不动返回值，只在这里翻给使用者看。
      ticketReason: {
        '票据格式不对': 'This ticket is malformed.',
        '签名不对': 'This ticket’s signature does not match.',
        '内容读不出来': 'This ticket could not be read.',
        '票据已过期': 'This ticket has expired.',
        '票据不是发给这个地址的': 'This ticket was issued for a different address.',
        '票据已经用过了': 'This ticket has already been used.',
        '这台设备已经被注销了': 'This device has been revoked.'
      }
    }
  },
  es: {
    pair: {
      title: 'Conectar con DSH',
      heading: 'Conectar con DSH',
      lead: 'Escribe los 6 dígitos que aparecen en la tarjeta «Código de '
        + 'emparejamiento» de la consola de tu computadora.',
      submit: 'Conectar',
      hint: 'Reiniciar no cambia el código. Cambia 90 días después de emitirse o al elegir «Nuevo código de emparejamiento» en la consola. Los teléfonos ya emparejados no se ven afectados.',
      // Emparejar solo registra el dispositivo; el contenido necesita la clave del enlace
      keyNote: 'Emparejar solo registra este dispositivo. Para **ver contenido**, abre una ' +
        'vez el enlace completo de «Copiar dirección» en la consola de tu computadora: ' +
        'ese enlace lleva la clave después de <code>#</code>.',
      warn: '⚠️ Una vez emparejado, este dispositivo tiene acceso completo a tu ' +
        'computadora.<br>\n' +
        '    No compartas el código de emparejamiento ni la dirección de acceso con nadie.'
    },
    launcher: {
      title: 'Elige a qué conectarte',
      heading: '¿A qué quieres conectarte?',
      sub: 'Elige una aplicación disponible en esta computadora. Se recordará tu elección.',
      checking: 'Comprobando…',
      none: 'No se encontró nada a lo que conectarse',
      noneHint: 'Instala DSH en la computadora y pulsa Comprobar de nuevo.',
      missing: 'No se encontró {name} en esta computadora. Instálalo o elige una aplicación disponible abajo.',
      retry: 'Comprobar de nuevo',
      needKey: 'Esta dirección no puede cargar la lista. Vuelve a abrir la dirección '
        + 'completa de «Copiar dirección» en la consola de tu computadora (la parte '
        + 'después de # no se puede perder).',
      open: 'Abrir ',
      start: 'Iniciar',
      stop: 'Detener',
      starting: 'Iniciando…',
      stopping: 'Deteniendo…',
      stopConfirm: '¿Detener {name}?',
      stopDsh: 'También se cerrará la ventana de DSH.',
      stopOther: 'Solo se detiene el servicio remoto; la versión de escritorio no se ve afectada.',
      failed: 'No se pudo completar la acción',
      failedWith: 'No se pudo completar la acción: ',
      listFailed: 'No se pudo leer la lista de destinos: ',
      foot: 'Lo que no esté en ejecución lo puedes iniciar aquí mismo, sin acercarte a la ' +
        'computadora.<br>\n' +
        '  Si eliges mal, no pasa nada: al entrar hay un acceso para cambiar en la ' +
        'esquina inferior derecha.'
    },
    enter: {
      dsh: 'Entrando en DSH…',
    },
    starting: {
      title: 'Iniciando DSH',
      heading: 'Iniciando DSH',
      body: 'DSH no estaba en ejecución en tu computadora, así que lo hemos iniciado por ' +
        'ti.<br>\n' +
        '     El primer arranque tarda unos segundos; esta página se actualiza sola.'
    },
    errors: {
      tooMany: 'Demasiados intentos. Vuelve a intentarlo más tarde.',
      wrongCode: 'El código de emparejamiento no es correcto. Vuelve atrás e inténtalo de nuevo.',
      pairUnavailable: 'El emparejamiento no está disponible temporalmente. Revisa el registro de la puerta de enlace en la consola y vuelve a intentarlo.',
      ticketTitle: 'Este enlace ya no funciona',
      ticketUsed: 'Este enlace ya se usó o ha caducado.<br><br>' +
        'Abre la consola en el ordenador y copia una dirección nueva.',
      ticketFresh: 'Este enlace dura un minuto.<br>' +
        'Vuelve a la página anterior y pulsa otra vez «Cambiar a este».',
      needProofTitle: 'Verificando este dispositivo',
      needProofBody: 'Espera unos segundos: esta página se resuelve sola.<br>' +
        'Está vacía porque el dispositivo aún se está verificando.',
      needProofHealing: 'Verificando automáticamente…',
      needProofRetry: 'Reintentar',
      needProofHint: '¿Sigues en esta página?<br>' +
        '1. Comprueba que la dirección del teléfono sea la **completa**: debe terminar ' +
        'en <code>#</code> seguido de una cadena de caracteres. Sin eso, reintentar no ' +
        'servirá.<br>' +
        '2. Pulsa «Reintentar».<br>' +
        '3. Si sigue fallando: en el ordenador, abre la consola → «Copiar enlace» → ' +
        'abre esa dirección completa una vez en el teléfono.',
      needProofPair: 'Ir al emparejamiento',
      needPairTitle: 'Hace falta volver a emparejar',
      needPairHint: 'Abre la consola en el ordenador e introduce el código de 6 dígitos que aparece ahí.',
      device: {
        revoked: 'Este dispositivo ha sido dado de baja. Para seguir usándolo, vuelve a ' +
          'emparejarlo con el código de emparejamiento o la clave de acceso.',
        expired: 'La sesión de este dispositivo ha caducado. Vuelve a emparejarlo.',
        unknown: 'Este dispositivo no está en la lista. Vuelve a emparejarlo.',
        superseded: 'La sesión de este dispositivo fue reemplazada por una nueva. ' +
          'Vuelve a emparejarlo.'
      },
      deviceOther: 'Este dispositivo no pasó la verificación. Copia una dirección nueva desde la consola o vuelve a emparejarlo.',
      noKey: 'Se requiere la clave de acceso. Petición: ',
      noKeyTitle: 'Esta dirección no lleva la clave de acceso',
      noKeyWhy: 'A esta dirección (o al icono) le falta la clave de acceso, por eso no abre.',
      noKeyHow: 'Cualquiera de las dos salidas sirve:',
      noKeyStep1: '<b>Vuelve a abrir la dirección completa:</b> en el ordenador, abre la '
        + 'consola → «Copiar la dirección del teléfono» → envía esa dirección al teléfono '
        + 'y ábrela. Para volver a añadir el icono a la pantalla de inicio, '
        + '<b>añádelo desde esa dirección</b>.',
      noKeyStep2: '<b>O usa el código de emparejamiento:</b> pulsa el botón de abajo e '
        + 'introduce el número de 6 dígitos que aparece en la consola.',
      noKeyFix: 'Si se cambió la clave de acceso, las direcciones antiguas dejan de funcionar: copia una nueva.',
      noKeyPair: 'Entrar con un código de emparejamiento',
      noKeyAsked: 'Esta petición era para: ',
      ticketReason: {
        '票据格式不对': 'Este ticket tiene un formato incorrecto.',
        '签名不对': 'La firma de este ticket no coincide.',
        '内容读不出来': 'No se pudo leer este ticket.',
        '票据已过期': 'Este ticket ha caducado.',
        '票据不是发给这个地址的': 'Este ticket se emitió para otra dirección.',
        '票据已经用过了': 'Este ticket ya se ha usado.',
        '这台设备已经被注销了': 'Este dispositivo ha sido dado de baja.'
      }
    }
  }
};

/**
 * 「这个地址里没有访问密钥」—— 主屏图标 / 旧书签点开时看到的那一页。
 *
 * 为什么值得单独做一页：这一刻使用者**人在外面、手上只有这部手机**，
 * 而原来的响应是一行 33 字节的纯文本（`Access key required. Requested: /`），
 * 他既不知道发生了什么，也不知道下一步该做什么 —— 表现就是「无法打开」。
 *
 * 这一页给两条出路，而且**第二条能救活已经存坏的图标**：
 *   ① 用电脑控制台里那条完整地址重开（要重加图标，就在那条地址上加）；
 *   ② 就在这里配对：cookie 会落进**这个图标自己的**存储里，于是 '/' 也能用了。
 *      （主屏 App 与 Safari 的 cookie 是两套独立存储，所以这一条必须在本页里走。）
 */
function noKeyPage(req, lang) {
  const code = normLang(lang);
  const E = PAGE_TEXT[code].errors;
  const asked = String(req.url || '/').slice(0, 160)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="${code}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${E.noKeyTitle}</title>
<style>
 body{font-family:-apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
      background:#0b0b0c;color:#eee;margin:0;padding:26px 18px 40px}
 .card{max-width:460px;margin:0 auto;background:#17171a;border:1px solid #232329;
       border-radius:16px;padding:22px}
 h1{font-size:18px;margin:0 0 10px}
 p{font-size:13.5px;color:#b9b9c0;line-height:1.85;margin:0 0 12px}
 .why{background:#231d0d;border:1px solid #6b5a1f;color:#ffe9a8;border-radius:12px;
      padding:12px 14px;font-size:13px;line-height:1.8;margin:0 0 16px}
 ol{font-size:13.5px;color:#b9b9c0;line-height:1.9;padding-left:20px;margin:0 0 16px}
 b{color:#eee}
 a.btn{display:inline-block;margin-top:4px;padding:12px 18px;border-radius:10px;
       background:#4d6bfe;color:#fff;font-weight:600;text-decoration:none;font-size:14px}
 code{background:#00000055;border-radius:6px;padding:2px 6px;word-break:break-all;font-size:12px}
 .asked{margin-top:16px;font-size:11.5px;color:#6b6b73;line-height:1.7}
</style></head><body>
<div class="card">
  <h1>${E.noKeyTitle}</h1>
  <div class="why">${E.noKeyWhy}</div>
  <p>${E.noKeyHow}</p>
  <ol>
    <li>${E.noKeyStep1}</li>
    <li>${E.noKeyStep2}</li>
  </ol>
  <p>${E.noKeyFix}</p>
  <a class="btn" href="/pair">${E.noKeyPair}</a>
  ${langSwitcher(req, code, false)}
  <div class="asked">${E.noKeyAsked}<code>${asked}</code></div>
</div></body></html>`;
}

/**
 * 「这台设备还没证明自己」那一页 —— 挑战应答开成**真拦**之后（2026-09-27）才用得上。
 *
 * 为什么是一页能**自救**的 HTML，而不是一段干巴巴的 403 文字：
 *
 *   卡在这一页的两种人，修法完全不同，而他们看到的画面必须自己说话：
 *     · 手机上有钥匙（地址里带 #k=，或本地存过），只是网关重启/12 小时过期导致
 *       证明作废 —— 这种**必须自己通过**，不该让使用者去电脑上折腾；
 *     · 手机上根本没钥匙（只有配对码配过对）—— 这种怎么等都不会通过，必须
 *       明确告诉他「去电脑控制台复制地址」，而不是让页面一直转圈。
 *
 *   所以：先自己证明一次（e2ee.js 就在旁边，放行名单里有它），成功就 reload；
 *   失败再把「怎么做」显示出来。等待期间显示「正在自动验证…」。
 *
 * ★ 只在**导航请求**上用这一页（fetch/XHR 给 JSON，见 rejectNeedProof）。
 *   给子资源（图片/接口）回一页 HTML 毫无意义，而且 reload 会变成刷新整页。
 */
function needProofPage(req, lang) {
  const code = normLang(lang);
  const E = PAGE_TEXT[code].errors;
  return `<!doctype html>
<html lang="${code}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${E.needProofTitle}</title>
<style>
 body{font-family:-apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
      background:#0b0b0c;color:#eee;margin:0;padding:26px 18px 40px}
 .card{max-width:460px;margin:0 auto;background:#17171a;border:1px solid #232329;
       border-radius:16px;padding:22px}
 h1{font-size:18px;margin:0 0 10px}
 p{font-size:13.5px;color:#b9b9c0;line-height:1.85;margin:0 0 12px}
 .spin{display:flex;align-items:center;gap:9px;font-size:13.5px;color:#8fa4ff;margin:0 0 14px}
 .dot{width:9px;height:9px;border-radius:50%;background:#4d6bfe;animation:p 1s infinite}
 @keyframes p{0%,100%{opacity:.25}50%{opacity:1}}
 .fix{background:#231d0d;border:1px solid #6b5a1f;color:#ffe9a8;border-radius:12px;
      padding:12px 14px;font-size:13px;line-height:1.8}
 .fix[hidden]{display:none}
 a.btn{display:inline-block;margin-top:14px;padding:12px 18px;border-radius:10px;
       background:#4d6bfe;color:#fff;font-weight:600;text-decoration:none;font-size:14px}
 code{background:#00000055;border-radius:6px;padding:2px 6px;word-break:break-all;font-size:12px}
</style></head><body>
<div class="card">
  <h1>${E.needProofTitle}</h1>
  <p>${E.needProofBody}</p>
  <div class="spin" id="spin"><span class="dot"></span>${E.needProofHealing}</div>
  <div class="fix" id="fix" hidden>${E.needProofHint}</div>
  <div id="retry" hidden><a class="btn" href="javascript:location.reload()">${E.needProofRetry}</a></div>
  <div id="pair" hidden><a class="btn" href="/pair" id="pairlink">${E.needProofPair}</a></div>
  ${langSwitcher(req, code, false)}
</div>
<script src="/e2ee.js"></script>
<script>
(function () {
  var spin = document.getElementById('spin');
  function fail() {
    if (spin) spin.hidden = true;
    // ★ 该给哪条出路，取决于这台设备**有没有钥匙**：外出时无法查看电脑上的配对码。
    //   原来不管三七二十一都摆一个「去配对页」—— 而配对码在电脑屏幕上，
    //   人在外面点它就是死路。有钥匙的设备只该「重试」：过一会儿自己就好了。
    var hasKey = false;
    try { hasKey = !!(window.__dshE2eeSecret || (window.DshE2EE && window.DshE2EE.secretSource &&
      window.DshE2EE.secretSource())); } catch (e) { }
    var f = document.getElementById('fix'); if (f) f.hidden = false;
    var r = document.getElementById('retry');
    var p = document.getElementById('pair');
    if (hasKey) { if (r) r.hidden = false; if (p) p.hidden = true; }
    else { if (p) p.hidden = false; }
    // 去配对页时，把地址里那把钥匙一起带上（它只在 # 后面，不带上就白配对一场：
    // 配对码只登记设备、不给钥匙，配完还是看不到内容 —— 走查实测过）。
    try {
      if (p && !p.hidden) {
        var a = document.getElementById('pairlink');
        if (a && /[#&]k=/.test(String(location.hash || ''))) a.setAttribute('href', '/pair' + location.hash);
      }
    } catch (e) { }
  }
  function go() {
    try {
      var api = window.DshE2EE;
      if (!api || !api.prove) return fail();      // 旧版脚本：只能照说明做
      api.prove(true).then(function (ok) {
        // 证成功就重新请求**原来那个地址** —— 这一次能过
        if (ok) { location.reload(); return; }
        fail();
      }).catch(function () { fail(); });
    } catch (e) { fail(); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go);
  } else { go(); }
})();
</script>
</body></html>`;
}

/**
 * 配对页（手机输 6 位配对码那一页）。
 *
 * 页面结构只写一份，语言往里填 —— `action="/pair"`、`name="code"` 这些
 * 因此天然只有一处，三种语言不可能写得不一样。
 *
 * `req` 只用来给语言切换链接拼地址（保住当前的查询参数），不影响页面内容。
 */
function pairPage(req, lang) {
  const code = normLang(lang);
  const T = PAGE_TEXT[code];
  return `<!doctype html>
<html lang="${code}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${T.pair.title}</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#eee;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 .card{width:min(90vw,360px);padding:28px;border-radius:16px;background:#17171a}
 h1{font-size:18px;margin:0 0 6px}
 p{font-size:13px;color:#9a9aa2;margin:0 0 20px;line-height:1.6}
 input{width:100%;box-sizing:border-box;font-size:28px;letter-spacing:.3em;text-align:center;
       padding:14px;border-radius:10px;border:1px solid #333;background:#0f0f11;color:#fff}
 button{width:100%;margin-top:14px;padding:14px;font-size:16px;border:0;border-radius:10px;
        background:#4d6bfe;color:#fff;font-weight:600}
 .hint{margin-top:14px;font-size:12px;color:#6b6b73;text-align:center}
 .warn{margin-top:16px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.7;
       background:#3a2f0b;color:#ffe9a8;border:1px solid #6b5a1f;text-align:left}
 .keynote{margin-top:14px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.75;
          background:#101a33;color:#bcd0ff;border:1px solid #29406e;text-align:left}
 .keynote code{background:#00000055;border-radius:5px;padding:1px 5px}
</style></head><body>
<div class="card">
  <h1>${T.pair.heading}</h1>
  <p>${T.pair.lead}</p>
  <form method="get" action="/pair">
    <input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6"
           placeholder="000000" autocomplete="one-time-code" autofocus>
    <button type="submit">${T.pair.submit}</button>
  </form>
  <script>
  // 表单提交会走一个新的 URL（/pair?code=…），**# 后面那把钥匙就是这一刻丢的**。
  // 先把它存起来，配对成功那一页再接回地址栏（见 enterPage 里的另一半）。
  // 存的是片段，不发往服务器 —— 和钥匙一直以来的走法一致。
  (function () {
    try {
      var f = document.querySelector('form');
      if (!f) return;
      f.addEventListener('submit', function () {
        try {
          if (/[#&]k=/.test(String(location.hash || ''))) {
            sessionStorage.setItem('dsh-pair-hash', location.hash);
          }
        } catch (e) { }
      });
    } catch (e) { }
  })();
  </script>
  <div class="hint">${T.pair.hint}</div>
  <div class="keynote">${T.pair.keyNote}</div>
  <div class="warn">
    ${T.pair.warn}
  </div>
  ${langSwitcher(req, code, false)}
</div></body></html>`;
}

/**
 * 配对成功后的过渡页。
 *
 * `target` 给 'codex' 时是进 Codex 的那一份 —— 两个页面的差别只有跳转地址、
 * title 和一句话，所以放在一个函数里，免得两份几乎一样的 HTML 各改一遍。
 *
 * 仍然用 meta refresh 而不是 302：这是原来就有的行为，本次只把文案抽出来
 * 按语言选，跳转方式一个字没动。
 *
 * ⚠ 这一页是「0 秒跳走」的，那个语言切换链接实际上点不到（页面还没画完就跳了）。
 *   这里仍然放上去，是为了和别的页面一致、以及万一浏览器没执行 meta refresh 时
 *   使用者还有办法换语言；真正管用的是配对页那一次选择种下的 cookie。
 */
function enterPage(req, lang, target) {

  const code = normLang(lang);
  const T = PAGE_TEXT[code];
  const dest = '/';
  return "<!doctype html><meta charset='utf-8'>" +
    `<meta http-equiv='refresh' content='0;url=${dest}'>` +
    `<title>DSH</title>` +
    `<p style='font-family:sans-serif;padding:2rem'>${T.enter.dsh}</p>` +
    langSwitcher(req, code, true) +
    `<script>
    // 配对成功 → 把配对页存下的那把钥匙接回地址栏，再去目标页。
    // 不接回去的话，这台设备虽然登记了，却看不到任何内容（钥匙只认 # 后面那一份），
    // 使用者会看到「配对成功 → 还是打不开」——实测过。
    (function () {
      try {
        var h = '';
        try { h = sessionStorage.getItem('dsh-pair-hash') || ''; } catch (e) { }
        if (h && !location.hash) { location.replace(${JSON.stringify(dest)} + h); return; }
        try { sessionStorage.removeItem('dsh-pair-hash'); } catch (e) { }
      } catch (e) { }
    })();
    </script>`;
}

/**
 * 只有一句话的提示页（配对失败、被限速…）。骨架和原来一样，只换那句话。
 * 这一页没有铺深色底，所以语言切换用浅底配色。
 */
function noticePage(req, lang, message) {
  return "<!doctype html><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    `<p style='font-family:sans-serif;padding:2rem'>${message}</p>` +
    langSwitcher(req, normLang(lang), true);
}

/**
 * 票据被拒的页面（换路径链接 / 恢复链接）。
 *
 * `reason` 是 redeemTicket 返回的**原始原因**（中文，逻辑和日志都在用它），
 * 这里只把给使用者看的那一份翻掉；翻不到就照原样显示 —— 宁可露出中文，
 * 也不要显示一个空的错误框。
 */
function ticketErrorPage(req, lang, reason, isRecover) {
  const code = normLang(lang);
  const E = PAGE_TEXT[code].errors;
  const shown = (E.ticketReason && E.ticketReason[reason]) || reason;
  return "<!doctype html><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<div style='font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#eee;" +
    "padding:2rem;min-height:100vh'>" +
    `<h2>${E.ticketTitle}</h2>` +
    `<p style='color:#f88'>${shown}</p>` +
    "<p style='color:#aaa;line-height:1.7'>" +
    (isRecover ? E.ticketUsed : E.ticketFresh) +
    "</p>" +
    langSwitcher(req, code, false) +
    "</div>";
}

/** 这台设备没通过第二道门（被吊销 / 过期 / 不认识）时的页面。 */
function deviceErrorPage(req, lang, reason) {
  const code = normLang(lang);
  const E = PAGE_TEXT[code].errors;
  const msg = E.device[reason] || E.deviceOther;
  return "<!doctype html><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<div style='font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#eee;" +
    "padding:2rem;min-height:100vh;line-height:1.8'>" +
    `<h2>${E.needPairTitle}</h2>` +
    `<p style='color:#f0a0a0'>${msg}</p>` +
    `<p style='color:#aaa'>${E.needPairHint}</p>` +
    langSwitcher(req, code, false) +
    "</div>";
}

// ── 活动监视：判断「这一轮干完了」────────────────────────────────────────────
// 为什么不依赖 DSH 的 hook 插件或事件订阅：那两条都要 DSH 内部配合
// （插件加载 / $on 订阅），行为受版本影响，而且实测没能可靠触发。
//
// 中间层本来就坐在数据通路上 —— agent 干活时 WebSocket 与 API 上必然有流量，
// 干完就安静下来。所以判据很直接：有过活动，然后安静了一段时间。
//
// 这个功能的目标场景正是「手机连着等结果」，所以只在有人连着时才有意义。
const IDLE_NOTIFY_MS = 12000;
let lastActivityAt = 0;
let activitySeen = false;
let idleTimer = null;
let suppressUntil = 0;   // 刚推送过就别立刻再推

function markActivity() {
  lastActivityAt = Date.now();
  if (Date.now() < suppressUntil) return;   // 冷却期内不重新计时
  activitySeen = true;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(onIdle, IDLE_NOTIFY_MS);
}

function onIdle() {
  idleTimer = null;
  if (!activitySeen) return;
  activitySeen = false;
  suppressUntil = Date.now() + 60000;

  const idleSec = Math.round((Date.now() - lastActivityAt) / 1000);
  log(`活动静默 ${idleSec} 秒，判定这一轮结束 —— 推送完成通知`);

  // 通知的标题正文是服务端拼的，而这条路**没有请求上下文**（是个定时器），
  // 所以语言只能从推送配置里读 —— 那是在「配置推送通道」那一步写进去的
  // （那一步有请求上下文，知道使用者用什么语言）。
  const M = NOTIFY_TEXT[require('./notify.js').targetLang()] || NOTIFY_TEXT.zh;
  pushNotification(M.doneTitle, M.doneBody)
    .then((results) => {
      const any = results.some((r) => r.ok);
      log(`完成通知${any ? '已送达' : '未送达（没有配置推送通道？）'}: ${JSON.stringify(results)}`);
    })
    .catch((err) => log(`完成通知发送异常: ${err.message}`));
}

// ── 通知推送 ──────────────────────────────────────────────────────────────────
//
// 通知的标题与正文是**服务端拼**的。两条路各有各的难处：
//   · 空闲检测那条是定时器，没有请求上下文 → 语言从推送配置里读（见下面 NOTIFY_TEXT）
//   · /__notify 那条有 req → 直接用请求自己的语言
// 不处理的话，英文使用者收到的永远是中文。
const NOTIFY_TEXT = {
  zh: {
    doneTitle: 'DSH 任务完成',
    doneBody: '电脑上的活干完了，回来看看。',
    testTitle: 'DSH 网关测试',
    testBody: '如果你在别的应用里或锁屏时看到了这条，说明推送是通的。'
  },
  en: {
    doneTitle: 'DSH task finished',
    doneBody: 'The work on your computer is done — come take a look.',
    testTitle: 'DSH gateway test',
    testBody: 'If you can see this while you are in another app or the screen is locked, notifications are working.'
  },
  es: {
    doneTitle: 'Tarea de DSH terminada',
    doneBody: 'El trabajo en el ordenador ha terminado: vuelve a echar un vistazo.',
    testTitle: 'Prueba de la pasarela DSH',
    testBody: 'Si ves esto mientras estás en otra app o con la pantalla bloqueada, las notificaciones funcionan.'
  }
};
// 设计取舍：DSH 的 hook 只调用本地中间层（纯 HTTP、无需 TLS、无需凭据），
// 由常驻在这里的进程去推 Bark / ntfy。这样 hook 侧永远不用碰 HTTPS，
// 换推送通道也不用改 DSH 的配置。
//
// 推送目标写在 logs\notify-targets.json，形如：
//   { "bark": "https://api.day.app/你的KEY", "ntfy": "https://ntfy.sh/你的topic" }
const NOTIFY_TARGETS_FILE = path.join(BASE, 'logs', 'notify-targets.json');
const VAPID_FILE = path.join(BASE, 'logs', 'vapid.json');
const SUBSCRIPTIONS_FILE = path.join(BASE, 'logs', 'push-subscriptions.json');

/** 已订阅 Web Push 的浏览器列表（每台设备一条）。 */
function loadSubscriptions() {
  try {
    const list = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function loadNotifyTargets() {
  try {
    return JSON.parse(fs.readFileSync(NOTIFY_TARGETS_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

async function pushNotification(title, body) {
  const targets = loadNotifyTargets();
  const results = [];
  const timeout = () => AbortSignal.timeout(10000);

  // Bark（iOS）：路径式 API，标题和正文都在 URL 里
  if (targets.bark) {
    try {
      const base = String(targets.bark).replace(/\/+$/, '');
      const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=dsh&level=timeSensitive`;
      const res = await fetch(url, { signal: timeout() });
      results.push({ channel: 'bark', status: res.status, ok: res.ok });
    } catch (err) {
      results.push({ channel: 'bark', error: err.message });
    }
  }

  // ntfy（安卓 / 可自建）
  if (targets.ntfy) {
    try {
      // 注意：HTTP 头只能是 ASCII。中文标题若直接放进 Title 头，fetch 会抛
      // 「Cannot convert argument to a ByteString」—— 实测踩过这个坑，
      // 结果是中文用户的通知永远发不出去。改走查询参数，它允许 URL 编码。
      const base = String(targets.ntfy).split('?')[0];
      const url = `${base}?title=${encodeURIComponent(title)}&tags=robot`;
      const res = await fetch(url, {
        method: 'POST',
        body,
        signal: timeout()
      });
      results.push({ channel: 'ntfy', status: res.status, ok: res.ok });
    } catch (err) {
      results.push({ channel: 'ntfy', error: err.message });
    }
  }

  // Web Push：推给所有已订阅的浏览器（手机零安装那条路）
  const subs = loadSubscriptions();
  if (subs.length > 0) {
    let vapid = null;
    try {
      vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } catch (err) {
      vapid = null;
    }

    if (vapid && vapid.publicKey && vapid.privateKey) {
      const payload = { title, body, url: '/', tag: 'dsh-task' };
      const survivors = [];
      let delivered = 0;

      for (const sub of subs) {
        try {
          const r = await sendWebPush(sub, payload, vapid);
          if (r.ok) {
            delivered++;
            survivors.push(sub);
          } else if (r.gone) {
            // 订阅已作废（404/410），直接丢弃，免得每次推送都白打一遍
          } else {
            survivors.push(sub);
          }
        } catch (err) {
          // 网络抖动不该丢掉订阅
          survivors.push(sub);
        }
      }

      if (survivors.length !== subs.length) {
        try {
          fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(survivors, null, 2), 'utf8');
          log(`清理了 ${subs.length - survivors.length} 个失效的 Web Push 订阅`);
        } catch (err) { /* 写不了就下次再说 */ }
      }

      results.push({
        channel: 'webpush',
        devices: subs.length,
        delivered,
        ok: delivered > 0
      });
    } else {
      results.push({ channel: 'webpush', error: 'VAPID 密钥缺失' });
    }
  }

  return results;
}

// ── 认证之前就要能取到的资源 ──────────────────────────────────────────────────
const PWA_ROUTES = {
  '/pocket-bridge.svg': { file: 'pocket-bridge.svg', type: 'image/svg+xml' },
  '/icon-maskable.png': { file: 'icon-maskable.png', type: 'image/png' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json', noCache: true },
  '/sw.js': { file: 'sw.js', type: 'application/javascript; charset=utf-8', noCache: true, swAllowed: true },
  '/polyfill.js': { file: 'polyfill.js', type: 'application/javascript; charset=utf-8', noCache: true },
  // 「第一次打开会比较慢，别刷新」—— 它自己被注入在 `polyfill.js` **之前**
  // （顺序在下面 proxyRequest 的注入那一段定，不是这张表定的）。
  '/first-load.js': { file: 'first-load.js', type: 'application/javascript; charset=utf-8', noCache: true },
  // 多语言。放在 polyfill 之后、其它之前 —— 后面那些脚本要用它的 t()
  '/i18n.js': { file: 'i18n.js', type: 'application/javascript; charset=utf-8', noCache: true },
  // 轻量版自己的三套文案（中 / 英 / 西）。紧跟在 i18n.js 后面注册词条。
  '/dsh-lite-lang.js': { file: 'dsh-lite-lang.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/compat.js': { file: 'compat.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/dsh-directory-picker.js': { file: 'dsh-directory-picker.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/boot.js': { file: 'boot.js', type: 'application/javascript; charset=utf-8', noCache: true },
  // 给「自己不会证明」的页面用（codex / go）—— 见 pwa/prove.js 开头那段说明
  '/prove.js': { file: 'prove.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/route.js': { file: 'route.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/e2ee.js': { file: 'e2ee.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/dsh-lite.css': { file: 'dsh-lite.css', type: 'text/css; charset=utf-8', noCache: true },
  '/dsh-lite-ui.js': { file: 'dsh-lite-ui.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/dsh-lite-adapter.js': { file: 'dsh-lite-adapter.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/dsh-lite-legacy.js': { file: 'dsh-lite-legacy.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/dsh-lite-router.js': { file: 'dsh-lite-router.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/dsh-lite-pin.js': { file: 'dsh-lite-pin.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/dsh-lite-switch.js': { file: 'dsh-lite-switch.js', type: 'application/javascript; charset=utf-8', noCache: true },
  // 更新提示脚本。**名字必须是新的**：指纹名单按路径匹配，旧名单里没有这个名字，
  // 所以它一定加载得出来 —— 而旧名字（dsh-lite-pin.js）已经被旧指纹拒掉了，
  // 提示画不出来，使用者因此永远看不到"更新"按钮，只能自己去清站点数据。
  '/dsh-lite-update.js': { file: 'dsh-lite-update.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/voice.js': { file: 'voice.js', type: 'application/javascript; charset=utf-8', noCache: true },
  // 使用者可编辑的覆盖层 —— 「用对话改界面」就是改这两个文件
  '/custom.css': { file: 'custom.css', type: 'text/css; charset=utf-8', noCache: true },
  '/custom.js': { file: 'custom.js', type: 'application/javascript; charset=utf-8', noCache: true },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png' },
  '/apple-touch-icon-precomposed.png': { file: 'apple-touch-icon.png', type: 'image/png' },
  '/favicon.ico': { file: 'icon-192.png', type: 'image/png' }
};

// ── 配对失败限速 ──────────────────────────────────────────────────────────────
// 访问密钥有约 96 位熵，枚举不可行；但配对码只有 6 位数字（约 100 万种），
// 没有限速的话理论上可以被慢慢试出来。这里按来源做失败计数，超阈值就锁一段。
const PAIR_MAX_FAILURES = 5;
const PAIR_LOCK_MS = 15 * 60 * 1000;
const pairAttempts = new Map();   // peer -> { failures, lockedUntil }

function pairRateCheck(peer) {
  const now = Date.now();
  const rec = pairAttempts.get(peer);
  if (rec && rec.lockedUntil && now < rec.lockedUntil) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - now };
  }
  return { allowed: true };
}

function pairRecordFailure(peer) {
  const now = Date.now();
  const rec = pairAttempts.get(peer) || { failures: 0, lockedUntil: 0 };
  rec.failures += 1;
  if (rec.failures >= PAIR_MAX_FAILURES) {
    rec.lockedUntil = now + PAIR_LOCK_MS;
    rec.failures = 0;
    log(`配对失败次数达上限，锁定 ${peer} 至 ${new Date(rec.lockedUntil).toISOString()}`);
  }
  pairAttempts.set(peer, rec);
}

function pairClearFailures(peer) {
  pairAttempts.delete(peer);
}

// 过渡页（ENTER_PAGE）搬到了上面 —— 它现在要按语言出，见 enterPage()。

/**
 * 发一个 PWA 静态文件。
 *
 * ★ 加了压缩 —— 这是手机端「加载半天」最大的一块。
 *
 *   实测（2026-09）：这些文件原来**一个字节都没压**就发出去了，
 *   哪怕客户端明确说了 `accept-encoding: gzip, br`：
 *       /boot.js  31158 字节  content-encoding=(无)
 *       /route.js 28315 字节  content-encoding=(无)
 *   而它们全是文本（JS / HTML / CSS / JSON），压缩率好得离谱：
 *       codex.html  171883 → gzip 56559（33%）/ br 45219（26%）
 *       boot.js      31158 → gzip 11358（36%）
 *   经隧道传（实测延迟 3 秒），168KB 和 45KB 是两个完全不同的体验。
 *
 *   顺便：`content-length` 必须在压缩**之后**再算 —— 先算再压会发出错误的长度，
 *   浏览器会卡在等剩余字节上（比不压还慢）。
 */
/**
 * 只发使用者那一门语言（2026-09-27）。
 *
 * 目标是减小语言包体积。我们自己这几个页面各自带一份三语字典
 * （codex 41.9KB / console 65.1KB / go 4.7KB），而一次只用得上一门 ——
 * 中文使用者更极端：key 本身就是中文原文，**整份字典都是多余的**。
 * 实测能省：中文 codex −41KB、console −62KB、go −4.7KB（brotli 后 −24.6KB）。
 *
 * ★ 为什么只对**没有钉指纹**的页面做：`/boot.js`、`/route.js`、`/i18n.js` 等 8 个
 *   文件是被手机端 pin 住的（指纹对不上就拒绝执行并弹红字）。同一个 URL 按语言
 *   发不同内容，会让「切一次语言」看起来像「代码被改过」—— 那是个很糟的假警报。
 *   所以那几个文件**一个字节都不动**，只裁 codex.html / console.html / go.html。
 *
 * ★ 语言怎么定（宁可不省，也不能让使用者看到错的语言）：
 *   · cookie 里有 → 用它（那是我方 i18n.js 亲手写的，和 localStorage 一致）
 *   · 没有 cookie → 用 Accept-Language，但**同时保留中文源**（只摘第三门）。
 *     因为「手机里存着别的语言选择、cookie 还没写上」的那一次加载真实存在
 *     （升级后的第一次），保守一点最坏只是少省几 KB。
 *   · 一个都定不下来 → 原样发。
 *
 * ★ 裁剪失败一律原样发（绝不因为省字节把页面发坏）。
 *
 * @returns {Buffer} 要发出去的字节
 */
/**
 * 往「网关自己直出 / 自己拼」的页面注入进门证明需要的**两个**脚本。
 *
 * ★ 两个都要，缺一个都等于没证：
 *   · `e2ee.js` —— 从地址 `#k=` 或本地存储里学到长期密钥，挂上 `DshE2EE`
 *     （`authResponse` 就在它身上），并给 `__dshE2eeSecret` 赋值；
 *   · `prove.js` —— 拿上面这两样去 `/__auth/verify` 证明、被拦了补证并重发。
 *   prove.js 的 `ready()` 等 `DshE2EE.authResponse`、`secret()` 等
 *   `__dshE2eeSecret` —— 这两个**只有 e2ee.js 提供**。只注入 prove.js
 *   的后果不是「证得慢」，而是**一次挑战都不取**（日志原话：
 *   「等了 2500 ms 也没等到证明」），页面永远拿不到内容。
 *   2026-09-26 就是这么踩的：给选目标页只补了 prove.js，使用者手机上
 *   依旧是「这条地址打不开目标列表」。
 *
 * 起因（早先那一批）：codex.html 只引 e2ee.js（旧缓存那份没有 prove），
 * go.html 只引 i18n.js —— 两页都证不了，页面上要用的 /__targets 必被 403。
 *
 * 注入位置：<head> 之后，e2ee.js 在 prove.js **前面** —— 都要赶在页面自己的
 * 脚本发请求之前，否则那些请求会先吃一个 403（网关会等，但早证早好）。
 */
function injectProofAssets(html) {
  if (!html) return html;
  return html.replace(/<head([^>]*)>/i, (m) => {
    var out = m;
    if (html.indexOf('/e2ee.js') < 0) out += '<script src="/e2ee.js"></script>';
    if (html.indexOf('/prove.js') < 0) out += '<script src="/prove.js"></script>';
    return out;
  });
}

function trimHtmlToLanguage(req, res, file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    return null;
  }
  try {
    const cookieLang = langFromCookie(req);
    let keep = null;
    if (cookieLang) {
      keep = [cookieLang];
    } else {
      const hinted = langFromHeader(req);
      if (hinted) keep = hinted === 'zh' ? ['zh'] : ['zh', hinted];
    }
    if (!keep) return raw;

    const st = fs.statSync(file);
    const r = dictTrim.trimToLanguage(raw.toString('utf8'), keep,
      `${file}|${st.size}|${Math.round(st.mtimeMs)}|${keep.join('+')}`,
      { isHtml: /\.html$/.test(file) });
    if (!r.changed) return raw;
    log(`按语言裁剪页面：${path.basename(file)} 只留 ${keep.join('+')}（${r.note}）`);
    return Buffer.from(r.text, 'utf8');
  } catch (err) {
    log(`按语言裁剪失败（原样发）：${err.message}`);
    return raw;
  }
}

function servePwa(req, res, route) {
  // 客户端支持哪种就压哪种。brotli 明显更小，优先；不行退 gzip。
  const ae = String((req && req.headers && req.headers['accept-encoding']) || '');
  let enc = null;
  if (/\bbr\b/.test(ae)) enc = 'br';
  else if (/\bgzip\b/.test(ae)) enc = 'gzip';

  let representation;
  try {
    // Only fixed, public PWA files enter this bounded cache. Source identity
    // and raw bytes are checked on every request, including conditional GETs.
    if (!servePwa.publicAssets) servePwa.publicAssets = require('./public-static-representation-cache.js')
      .createPublicStaticRepresentationCache({ root: PWA_DIR,
        files: Array.from(new Set(Object.values(PWA_ROUTES).map(item => item.file).concat('dsh-lite.html'))) });
    representation = servePwa.publicAssets.read(route.file, enc);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`missing ${route.file}`);
    return;
  }
  const body = representation.body;
  enc = representation.encoding;

  // Validate the exact public source representation, including compression.
  // This does not apply to authenticated history, files, or content handlers.
  const etag = representation.etag;
  const cacheControl = route.noCache ? 'no-cache' : 'public, max-age=86400';
  const headers = {
    'content-type': route.type,
    'content-length': body.length,
    'cache-control': cacheControl,
    etag,
    // Every representation varies by encoding, including an identity response.
    vary: 'Accept-Encoding'
  };
  if (route.file === 'dsh-lite.html') Object.assign(headers, phonePagePolicy.headersFor(req));
  if (enc) {
    headers['content-encoding'] = enc;
    // 告诉中间层和浏览器：这个响应随 accept-encoding 变。
    // 不写的话，Cloudflare 之类可能把压缩版发给不支持的客户端。
    headers['vary'] = 'Accept-Encoding';
  }
  if (route.swAllowed) headers['service-worker-allowed'] = '/';
  const ifNoneMatch = String(req?.headers?.['if-none-match'] || '');
  if ((!req.method || req.method === 'GET' || req.method === 'HEAD') &&
      ifNoneMatch.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) {
    delete headers['content-length'];
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** 时间无关的字符串比较 —— 别让对端靠响应时间逐字节猜出正确值 */
function safeEqualStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * 请求里带着**正确**的会话 cookie 吗？
 *
 * ★ 这里原来是 `seg.trim().startsWith(COOKIE_NAME + '=')` —— 只比**名字**，
 *   不看值。也就是说 `dsh-auth-xxxx=bogus` 就能过。
 *
 *   在 HTTP 那条路上这不算致命：后面还有 DSH 自己校验 cookie 值（伪造值返回 401）。
 *   但 WebSocket 升级那条路上，这道门是**唯一**的一道 —— 于是「名字对、值乱写」
 *   直接换到 101 Switching Protocols，实时通道整个敞开。安全审计实测复现过。
 *
 *   现在比的是完整的值，而且用时间无关比较 —— 和这个项目里其它地方
 *   （票据兑换、设备令牌）保持一致的口径。
 */
function hasAuthCookie(req) {
  const scoped = readNamedCookie(req, GATEWAY_AUTH_COOKIE);
  return scoped !== null ? safeEqualStr(scoped, COOKIE_VALUE) : hasLegacyAuthCookie(req);
}

/**
 * 处理过程中才决定要种的 cookie，统一在这里挂上。
 *
 * 为什么要在入口包一层：各个分支自己调用 res.writeHead，而反代那条路会
 * 用上游的响应头整份覆盖（Object.assign({}, up.headers)），先 setHeader 的
 * 东西就没了。曾经真的踩到：客户端收不到设备令牌 → 每次请求都重新登记一次
 * 设备 → 设备列表被刷成十几台。所以集中在这里合并，任何分支都不会漏。
 *
 * ★ 2026-09-27 又踩到同一个坑的**第二种形态**，所以这一段重写了：
 *
 *   原来只合并「排队的那几个」，**没有把已经 setHeader 过的一起带上**。
 *   而 writeHead 参数里的 set-cookie 会盖掉 setHeader 的值 —— 于是：
 *     · 「从密钥路径选 DSH」（`/k/<密钥>?target=dsh`）先 setHeader 两个 cookie
 *       （DSH 登录 + 记住选择），
 *     · 紧接着反代那一步 writeHead 带上了「排队里的那一个」，
 *     · 结果：记住选择的那个 cookie **在响应里消失** → 手机下次还要再问一遍
 *       「你要用哪个」，而「同一台设备冒出好几条记录」也跟着回来了
 *       （cookie 丢了 → 下次请求又被当成新设备）。
 *
 *   现在：参数里的 + 已经 setHeader 的 + 排队的，三份一起合，按名字去重、
 *   **后来的覆盖先前的、位置保持** —— 和浏览器的取用规则一致（同名取最后一条）。
 */
function installCookieMerger(res) {
  // ★ 幂等：已经装过就直接返回，**不要**重建这个队列。
  //
  //   为什么：第三道门（挑战应答）会「先 return、过一会儿把同一个请求重走一遍」，
  //   而重走时会再调一次这个函数。原来它第一行是 `res.__pendingCookies = []` ——
  //   于是第一遍里 `ensureDevice` 排队要种的那张设备令牌被**悄悄丢掉**，
  //   表现是「设备登记了、cookie 却没发出去」，手机下次请求又被当成新设备。
  if (res.__dshCookieMerger) return;
  res.__dshCookieMerger = true;
  res.__pendingCookies = [];
  const orig = res.writeHead.bind(res);

  res.writeHead = function (status, a, b) {
    if (res.__pendingCookies.length) {
      const extra = res.__pendingCookies.slice();
      res.__pendingCookies.length = 0;

      const headers = (a && typeof a === 'object') ? a
        : (b && typeof b === 'object') ? b : null;

      // 三份来源，顺序 = 旧 → 新（同名时后面的赢，浏览器就是这个规则）
      const fromArg = headers ? headers['set-cookie'] : null;
      const fromHeader = res.getHeader('set-cookie');
      const byName = new Map();
      const list = [];
      for (const c of [].concat(fromArg || [], fromHeader || [], extra)) {
        const s = String(c);
        const name = s.split('=')[0].trim();
        if (byName.has(name)) list[byName.get(name)] = s;   // 覆盖，但位置不变
        else { byName.set(name, list.length); list.push(s); }
      }

      if (headers) headers['set-cookie'] = list;
      else res.setHeader('set-cookie', list);
    }

    // 全局禁止把本机地址当 Referer 发出去。
    //
    // 为什么值得单独做一层：地址里带着访问密钥（/k/<密钥>），一旦某个页面
    // 引用了外部资源（图片、字体、CDN），浏览器会把当前地址塞进 Referer 头
    // 发给对方 —— 密钥就这么漏到第三方了。带密钥那一页现在已经是 302 直接跳走、
    // 不再渲染，但「以后万一有人加了个外链」这种事防不住，
    // 所以在出口统一掐掉，不依赖任何人记得。
    if (!res.getHeader('referrer-policy')) {
      try { res.setHeader('referrer-policy', 'no-referrer'); } catch (err) { /* 已发出就算了 */ }
    }

    if (b !== undefined) return orig(status, a, b);
    if (a !== undefined) return orig(status, a);
    return orig(status);
  };
}

/**
 * 这次请求是不是「就在这台电脑上」发出的？
 *
 * 只看 socket 来源地址是不够的，这里有个容易搞错的地方：
 * 隧道流量是**本机的 cloudflared** 转发进来的，socket 来源同样是 127.0.0.1。
 * 所以必须连 Host 一起看 —— Host 是隧道域名，就说明是外面来的手机。
 */
function fromLoopbackSocket(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/**
 * 对端地址是不是这台机器自己的地址？
 *
 * 实现搬到了 config.js —— 安全审计也要用同一份判断（它得验证「外面的机器会被拒」），
 * 两边各写一份的话，改了一处另一处就成了摆设。
 */
function isOwnAddress(req) {
  return cfg.isOwnAddress(null, req);
}

/**
 * 这个请求是不是**这台机器自己**发的？
 *
 * 和 isLocalRequest 的区别：那个看的是 socket 与 Host（能不能证明「就在本机」），
 * 这个看的是**真实来源地址**（CF-Connecting-IP），因此能认出「本机走隧道回来」
 * 那种 socket 是回环、Host 却是隧道域名的情况。
 *
 * 为什么不能只看地址：手机在家连隧道时，出口地址和电脑完全一样（同一条宽带）。
 * 所以还要看客户端像不像手机 —— 判据写在 sessions.isSelfClient 里，
 * 和设备列表那边共用一份，免得两处各判各的。
 */
function isSelfClientRequest(req) {
  if (privateHttpsAdmission.isForceRemote(req)) return false;
  const real = routes.clientIpOf(req);
  const sock = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');

  // 只在**确实经过转发**（真实来源 ≠ socket 地址）时才有意义。
  //
  // 直连时这两个值相同，那种情况 isLocalRequest 已经判过了 —— 而且必须让它判：
  // test-devices.js 正是靠「回环直连 + 合成 Host（test-device.invalid）」来模拟
  // 一台外部手机的（见那个文件开头的说明：用回环地址反而模拟不了手机，
  // 因为那是最典型的本机请求）。在这里把回环直连一律当成本机，
  // 等于把这个模拟手段废掉，整套设备测试会一起红。
  if (real === sock) return false;

  return sessions.isSelfClient(real, sessions.labelFromUa(req.headers['user-agent']));
}

/**
 * /__notify 的限速。
 *
 * 这个端点会让使用者手机**真的响**。正常一轮任务只打一次，打得密说明
 * 要么是有 bug 在刷，要么是有人拿它当玩具（它现在只允许本机来源，
 * 但本机上的脚本一样可能写出循环）。一分钟最多 12 次。
 */
let notifyHits = [];
function notifyRateOk() {
  const now = Date.now();
  notifyHits = notifyHits.filter((t) => now - t < 60000);
  if (notifyHits.length >= 12) return false;
  notifyHits.push(now);
  return true;
}

function isLocalRequest(req) {
  if (privateHttpsAdmission.isForceRemote(req)) return false;
  // A relay can forward to loopback with a local Host. Forwarding evidence
  // must never grant the direct-computer device/proof exemption.
  if (requestOrigin.viaRelay(req)) return false;
  if (!isOwnAddress(req)) return false;
  // 访问本机网卡地址也算本机，但只有本机 socket 来源才走到这里。
  // Host 的判定与 viaRelay 共用一处，避免一个入口接受的地址被另一个
  // 入口误认为公网隧道或本机控制台。
  return requestOrigin.isLocalHost(req);
}

/**
 * 自检脚本发的请求。
 *
 * 为什么需要这个标记：self-check 会去连自己的内网地址（那正是「内网入口能不能用」
 * 这一项要验的），而在 HTTP 层面，「自检连自己的内网地址」和「局域网里真有台手机」
 * 长得一模一样，服务端没法区分。结果是每跑一次自检，设备列表里就多一台「未知设备」。
 * 所以让自检自报家门，服务端据此跳过登记。必须同时满足本机来源
 * 与本机 Host；公网中继也会从回环地址连进来，单看 socket 不够。
 */
function isSelfCheck(req) {
  return req.headers['x-dsh-selfcheck'] === '1' && isLocalRequest(req);
}

/** 通过认证之后调用：确保「这台设备」有身份。
 *
 * 关于兼容：设备令牌是后加的功能，已经配好的手机会只有 DSH 的 cookie。
 * 这时候直接拒绝，等于让所有老设备突然进不来 —— 那是一次很糟的升级。
 * 所以第一次遇到没有令牌的请求就当场登记一个，门照开；从那一刻起它就能被单独吊销了。
 * 这不降低安全性（密钥仍是根凭证），只是把一个隐形的共享身份变成可见、可管理的。
 *
 * 本机请求不登记：设备令牌的用处是分辨「外面哪台手机」，而本机就是你自己。
 * 给本机也发令牌，只会让自检脚本、命令行工具在设备列表里刷出一堆「未知设备」。
 *
 * @returns {{ok: boolean, reason?: string, device?: object, created?: boolean, local?: boolean}}
 */
function ensureDevice(req, res, opts = {}) {
  const authority = String(req.headers.host || '');
  const ip = routes.clientIpOf(req);
  const token = readDeviceToken(req);

  if (token) {
    const v = sessions.verify(token, { authority, ip });
    if (v.ok) return { ok: true, device: v.device };

    // 「表里没这条记录」不等于「这台设备有问题」—— 多半是我们这边的记录丢了
    // （被删、被清、换机器）。签名是用当前访问密钥派生的，能验过就说明它当初
    // 确实拿着正确的密钥进来过，所以重新登记它，而不是把使用者挡在外面。
    // 真正的「不让它进」由 revokedAt（明确注销）和轮换密钥保证。
    if (v.reason === 'unknown') {
      const back = sessions.recover(token, { ua: req.headers['user-agent'], ip, authority });
      if (back) {
        log(`设备表里没有 ${back.id}，但签名有效 —— 已重新登记「${back.label}」（设备表可能丢过）`);
        return { ok: true, device: back, recovered: true };
      }
    }

    // ★ 「过期」和「被新令牌挤掉」也自愈，避免外出时无法重新配对。
    //
    //   原来这两类只能去要配对码 —— 而配对码在电脑屏幕上，人在外面等于失联。
    //   判据和上面那条**完全一样**：签名能用当前访问密钥验过。所以这不多给任何人
    //   新能力：能验过的人本来就能用 /k/<密钥> 重新登记（那条路一直开着）。
    //
    //   ★ 两条硬边界，写在这里也写在 refresh() 里：
    //     · **明确注销过的设备绝不复活**（revokedAt 一票否决，谁用都没用）；
    //     · 令牌失效超过 REFRESH_GRACE_MS（90 天）不再自愈，老实重新配对 ——
    //       否则一张被录下来的旧 cookie 就永久有效了。
    //   日志把「续过几次」也记下来（控制台里能看到 renewedCount）。
    if (v.reason === 'expired' || v.reason === 'superseded') {
      const back = sessions.refresh(token, { ip, authority });
      if (back && back.device) {
        log(`设备「${back.device.label}」的令牌${v.reason === 'expired' ? '过期了' : '被新令牌挤掉了'}` +
          `，但签名有效 —— 已自动换一张新的（第 ${back.device.renewedCount || 1} 次自愈），` +
          `不让使用者为这个回去找配对码`);
        const jar = deviceCookieValue(back.token);
        if (res && res.__pendingCookies) res.__pendingCookies.push(jar);
        return { ok: true, device: back.device, recovered: true };
      }
      log(`设备令牌被拒(${v.reason}) 来自 ${ip} —— 自愈没成（注销过 / 太旧 / 记录没了），` +
        `这种情况要重新配对`);
    }

    // 被吊销、过期、伪造 —— 都要拦，但原因不同，日志里要说清
    log(`设备令牌被拒(${v.reason}) 来自 ${ip}`);
    return { ok: false, reason: v.reason };
  }

  // 本机发起的请求不登记。
  //
  // 除了原来那两条（回环/本机地址、自检自报家门），还有第三种漏网的：
  // **本机访问自己的隧道**。那时 socket 是回环（cloudflared 转的），
  // Host 是隧道域名（不在网卡列表里），于是 isLocalRequest 判「不是本机」，
  // 平白多出一台设备。实测：本机拿 node 的 fetch 请求一次隧道地址，
  // 设备列表里就冒出一台「未知设备（2409:…）」—— 那串正是本机的公网 IPv6。
  // 判据收在 sessions.isSelfClient 里，和列表那边共用一份。
  if (isLocalRequest(req) || isSelfCheck(req) || isSelfClientRequest(req)) {
    return { ok: true, device: null, local: true };
  }

  const created = sessions.create({
    ua: req.headers['user-agent'],
    ip, authority, label: opts.label
  });
  // 已经认证过、只是缺令牌的老设备，这里补一张给它
  res.__pendingCookies.push(deviceCookieValue(created.token));
  log(`登记设备「${created.device.label}」${created.device.id} 来自 ${ip}`);
  return { ok: true, device: created.device, created: true };
}

// ── 路径切换票据 ──────────────────────────────────────────────────────────────
//
// 换一条路连过来，等于换了一个 authority，原来那份会话 cookie 用不了
// （cookie 是绑 authority 的，这是安全设计，不是缺陷）。所以切换时必须重新
// 认证一次。
//
// 但把长期密钥塞进新地址的 URL 是不行的 —— 那等于把钥匙抄一份贴在门上。
// 所以换成一枚一次性、一分钟内有效的票据：只有已经通过认证的页面能申请到它，
// 用它换到新路径的会话后就作废。这样切换既方便，又不扩大密钥的暴露面。
const TICKET_TTL_MS = 60 * 1000;

// 「地址变了」推送专用的一次性票据，有效期长得多。
//
// 为什么不能复用上面那个 60 秒的：换路径是**人正拿着手机点**，一分钟绰绰有余；
// 而地址变更通知是**推给一个可能正在睡觉的手机**，两小时后才看到是常态。
// 60 秒的票据推到那儿早烂了，使用者点开只会看到「票据已过期」—— 等于没修。
//
// 长有效期的代价：这枚票据在没用掉之前，谁读到谁就能进。
// 所以配套三条约束，缺一不可：
//   1. 一次性 —— 用过即废，正常点一次就烧掉了
//   2. 绑地址 —— 只能在新隧道那个 authority 上兑换，挪不到别处
//   3. 绑密钥 —— 由访问密钥派生，轮换密钥立刻全部作废
// 还有第四条在推送那一侧：第一条通知里就写明「别转发这条消息」。
const RECOVER_TTL_MS = 24 * 60 * 60 * 1000;

const usedTickets = new Map(); // nonce -> 过期时间，用于一次性校验

function ticketSecret() {
  // 用当前访问密钥派生，密钥轮换时旧票据自动失效
  return crypto.createHash('sha256').update(`dsh-gw-ticket|${ACCESS_KEY}`).digest();
}

function mintTicket(authority, deviceId, target, ttlMs) {
  const payload = {
    a: authority,
    e: Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : TICKET_TTL_MS),
    n: crypto.randomBytes(12).toString('base64url'),
    // 把设备身份一起带过去：换了条路还是同一台手机，不该在设备列表里变成两台
    s: deviceId || null,
    // 把「在哪个应用里」也带过去。切换路径会换 authority，cookie 不跟着走，
    // 不带的话使用者切一次网络就被重新问一遍「你要用哪个」—— 很烦，而且没必要。
    t: target === 'dsh' ? 'dsh' : null
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', ticketSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function redeemTicket(ticket, authority) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 2) return { ok: false, reason: '票据格式不对' };

  const expect = crypto.createHmac('sha256', ticketSecret()).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: '签名不对' };
  }

  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch (err) { return { ok: false, reason: '内容读不出来' }; }

  if (!payload || typeof payload.e !== 'number' || Date.now() > payload.e) {
    return { ok: false, reason: '票据已过期' };
  }
  // 票据只允许在它指明的那个地址上兑换，防止被挪用到别的入口
  if (authority && payload.a && payload.a !== authority) {
    return { ok: false, reason: '票据不是发给这个地址的' };
  }
  if (usedTickets.has(payload.n)) return { ok: false, reason: '票据已经用过了' };

  // 原设备如果已经被吊销，它申请的票据也跟着失效 —— 否则吊销就形同虚设
  if (payload.s && !sessions.isActive(payload.s)) {
    return { ok: false, reason: '这台设备已经被注销了' };
  }

  usedTickets.set(payload.n, payload.e);
  return { ok: true, deviceId: payload.s || null, target: payload.t || null };
}

// 定期清扫过期票据，避免这个表无限长
setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of usedTickets) if (exp < now) usedTickets.delete(n);
}, 60 * 1000).unref();

/** 读隧道地址（启动器写在 status.json 里）。 */
function currentTunnelUrl() {
  const st = readJsonFile(path.join(LOG_DIR, 'status.json'));
  return (st && st.tunnel && st.tunnel.url) || null;
}

/** 中间层是否在 IPv6 上监听 —— 决定公网 IPv6 那条路值不值得列出来。 */
function listeningOnV6() {
  if (gatewayListeners) return gatewayListeners.ipv6;
  try {
    const addrs = server.address();
    if (!addrs) return false;
    if (typeof addrs === 'object' && addrs.family === 'IPv6') return true;
  } catch (err) { /* 还没监听 */ }
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const a of ifaces[name] || []) {
        const f = a.family === 'IPv6' || a.family === 6;
        if (f && !a.internal) return true;
      }
    }
  } catch (err) { /* 读不到就当没有 */ }
  return false;
}

/** 组装给 routes.recommend 用的上下文。loopback 决定要不要附加密密钥。 */
function routeContext(key, lang, loopback) {
  return {
    port: PORT,
    httpsPort: HTTPS_PORT || 0,
    key,
    // 拼进候选地址的加密密钥（#k=）—— **只给回环调用者**。
    //
    // 少了它，控制台「复制手机地址」复制出去的就是一条会被自家网关拒掉的链接：
    // 手机打开后页面能出来、登录也成功，但 /api/remote.mux 那条 WebSocket 会被
    // 「拒绝明文，不降级」挡下，对话列表永远是空的。原因详见 routes.js 里 frag 那段。
    //
    // 为什么只给回环：这条边界和 /__console/status 是同一条 —— 泄露一个设备 cookie
    // 本来只能拿到密文，把密钥也塞进 /__routes 就等于连同解密能力一起送出去。
    // 手机不需要它：手机手里的链接本来就带 #k=（route.js 换路径时会自己补上 hash）。
    secret: loopback ? (e2eeSecretOrNull() || '') : '',
    // 服务端自己拼的文案（接口名、识别结果、建议）也要按语言来 ——
    // 不然英文手机上会出现整段中文（计划 H 的「各语言不混排」）。
    lang: lang || 'zh',
    tunnelUrl: currentTunnelUrl(),
    ipv6Listening: listeningOnV6(),
    netInfo: cfg.detectNetwork()
  };
}

function keyMatches(u) {
  const q = u.searchParams.get('k');
  // 用时间无关比较，和这个项目里其它凭证比较保持一致的口径。
  // （访问密钥有约 128 位熵，实际枚举不动；但同一个程序里几套口径不一
  //   本身就是隐患 —— 哪天有人把密钥改短，这里就是第一个破的。）
  if (q !== null && safeEqualStr(q, ACCESS_KEY)) return true;
  const m = /^\/k\/(.+)$/.exec(u.pathname);
  return !!m && safeEqualStr(decodeURIComponent(m[1]), ACCESS_KEY);
}

// ── 反代 ──────────────────────────────────────────────────────────────────────
/**
 * 这个响应要不要允许上游压缩？
 *
 * ★ 只对 DSH 的**静态模块**放行（`/assets/` 和 `/plugins/`），其余一律摘掉
 * accept-encoding —— 也就是回到改动前的行为。
 *
 * 为什么是这两个前缀：
 *   · `/assets/`  构建产物（四项合计 1439 KB → gzip 461 KB）
 *   · `/plugins/` 客户端插件模块。实测首页引用了 **71 个**，合计约 **12 MB**
 *     （最大的 dsh-client-ui-settings-account 单个 5.1 MB，conversation 696 KB、
 *      chat 518 KB、trajectory 412 KB、workspace 195 KB）。
 *     经隧道（实测约 250 KB/s）未压缩要 48 秒以上 —— 表现就是
 *     「选择工作区一直转圈」「对话点进去空白」：小模块先到、界面能画出来，
 *     大模块还在下。这两个目录都是**静态 ES 模块**，桥从不改写也不加密。
 *
 * 为什么**不**放宽到 /api：桥对一部分 API 响应是「读出来再自己加密」的
 * （wrapEncryptedResponse）。上游一压缩，它拿到的就是 gzip 字节，加密进去之后
 * 手机按 `x-dsh-e2ee-type: application/json` 去 parse 必然失败 ——
 * 那是对话内容通道，最不能出问题的地方。收益只有几百字节，不值得。
 */
const STATIC_MODULE_PREFIXES = ['/assets/', '/plugins/'];

function allowUpstreamCompression(req) {
  const path = String(req.url || '');
  for (const prefix of STATIC_MODULE_PREFIXES) {
    if (path.lastIndexOf(prefix, 0) === 0) return true;
  }
  return false;
}

/**
 * 构造发给 DSH 的请求头。
 *
 * 这里有两处改写是必须的，否则会出现「页面能打开、但读不到项目和对话」：
 *
 *   - Origin 必须与 Host 相同。DSH 的浏览器信任栅栏里，只要请求带了 Origin，
 *     就要求 new URL(origin).host === host，不相等直接 403。手机浏览器发的
 *     Origin 是隧道域名，而这里 Host 被固定成回环地址，所以 Origin 必须一并
 *     改写，否则 /api 下的 RPC 和 WebSocket 全部被拒。
 *   - sec-fetch-site: cross-site 会被无条件拒绝。经过隧道之后这个标记已经不
 *     代表真实关系，摘掉让上游按「没有该头」处理。
 */
function buildUpstreamHeaders(req) {
  const headers = Object.assign({}, req.headers, { host: INTERNAL_HOST });

  if (headers.origin !== undefined) {
    headers.origin = `http://${INTERNAL_HOST}`;
  }
  delete headers['sec-fetch-site'];
  if (UPSTREAM_COOKIE) {
    const otherCookies = String(headers.cookie || '').split(';').map(v => v.trim())
      .filter(v => v && !/^dsh-auth-|^pocket-bridge-auth(?:-|=)|^dsh-gw-session(?:-|=)/.test(v));
    otherCookies.push(UPSTREAM_COOKIE.name + '=' + UPSTREAM_COOKIE.value);
    headers.cookie = otherCookies.join('; ');
  }
  // The encrypted bridge owns WS framing, so compressed WS payloads must not
  // be negotiated independently by the native browser and DSH.
  if (headers.upgrade) delete headers['sec-websocket-extensions'];

  // ★ 只有静态资源放行压缩，其余一律摘掉（详见 allowUpstreamCompression 的说明）。
  //
  //   原来这里是无条件删掉的。注释给的理由（HTML 要明文才改得动）本身没错，
  //   但代价被摊到了**所有**请求上。实测 DSH 的前端资源：
  //     index.js 614.5 KB   vendor.js 723.2 KB   两个 CSS 101.4 KB
  //   未压缩合计 1439 KB，gzip 后只有 461 KB —— 差三倍，全部由手机承担。
  //
  //   而这条路上非 HTML 的响应本来就只是一句 `up.pipe(res)` 原样流式转发，
  //   压缩对它没有任何影响：不摘这个头，gzip 就会自动透传。
  if (!allowUpstreamCompression(req)) delete headers['accept-encoding'];

  return headers;
}

/**
 * 给 DSH 那些**内容哈希**的资源补上缓存头。
 *
 * 为什么必须补：DSH 自己**一个缓存头都不发** —— 实测直连它的 19387 端口，
 * `/assets/vendor-CCJJTK99.js` 的响应里没有 cache-control、没有 etag、也没有
 * last-modified（只有 vary 和 content-type）。没有这些，浏览器只能靠启发式规则，
 * 结果就是**每次打开手机都要把这四个文件重新下一遍**：
 *
 *     index-Q6zc2uHV.js  230.5 KB
 *     vendor-CCJJTK99.js 204.7 KB
 *     两个 CSS             26.2 KB
 *     ────────────────────────────
 *     合计 461.4 KB，占一次冷加载 528 KB 的 87%
 *
 * 而这几个文件名是**构建时按内容算出来的哈希**（Vite 的 `名字-哈希.ext`），
 * 内容一变名字就变 —— 所以它们本来就是可以长期缓存的，DSH 只是没声明。
 *
 * 只认这种形状，不是「/assets/ 下全都缓存」：
 *   路径在 /assets/ 下、GET、200、上游没自己给 cache-control，
 *   并且文件名以 `-<8 位以上哈希>.<扩展名>` 结尾、哈希里含大写字母或数字
 *   （这一条是为了排除 `my-long-component.js` 这种普通单词结尾的文件）。
 *
 * 用 30 天而不是 immutable+一年：正常使用下 30 天内不会重复下载，
 * 而万一 DSH 哪天复用同一个文件名换了内容，代价有上限，手动刷新也还能拿到新的。
 */
function cacheableAssetHeaders(req, up) {
  const headers = up.headers;
  if (req.method !== 'GET' || up.statusCode !== 200) return headers;
  if (headers['cache-control']) return headers;              // 上游给了就听上游的

  const url = String(req.url || '');
  const path = url.split('?')[0];
  const LONG_CACHE = { 'cache-control': 'public, max-age=2592000' };

  // ① 构建产物：/assets/<名字>-<内容哈希>.<扩展名>
  if (path.indexOf('/assets/') === 0) {
    const m = path.match(/-([A-Za-z0-9_-]{8,})\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico|map)$/i);
    if (m && /[A-Z0-9]/.test(m[1])) return Object.assign({}, headers, LONG_CACHE);
    return headers;                                          // 不是哈希形状就不缓存
  }

  // ② 插件模块：/plugins/??<模块名>&rev=<内容哈希>
  //
  //    ★ 注意模块名和哈希都在**查询串**里（第一个 `?` 之后全是查询），
  //      所以这里要看整条 URL，不能只看 pathname —— 只看 pathname 的话
  //      每条都是 `/plugins/`，永远判不出内容变没变。
  //    rev 是内容哈希，内容一变它跟着变，所以可以长期缓存。
  //    这 71 个模块合计约 12 MB，缓存之后手机第二次打开不用再下一遍。
  if (path.indexOf('/plugins/') === 0 && /[?&]rev=[0-9a-f]{8,}/i.test(url)) {
    return Object.assign({}, headers, LONG_CACHE);
  }

  return headers;
}

// ── DSH 按需启动 ──────────────────────────────────────────────────────────────
// 目标：只要电脑开着、网关在跑，手机上点一下就能用，不需要先跑到电脑前打开 DSH。
//
// 做法：只在反代碰到「端口没人监听」时才去启动它。刻意不做定期巡检 ——
//       否则你主动关掉 DSH 之后它又会被自动拉起来，那才叫烦人。
// DSH 装在哪交给 config.js 去发现：
//   环境变量 → config.json → 运行中的进程 → 常见安装路径 → 注册表
// 换电脑、换盘符、换操作系统都不用改这里的代码。
let DSH_EXE = process.env.DSH_EXE || null;

let dshStarting = false;
let dshStartStartedAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findDshExe() {
  if (DSH_EXE && fs.existsSync(DSH_EXE)) return DSH_EXE;
  const detected = dshRuntime.detectInstallation(cfg.loadConfig());
  return detected.launch ? detected.launch.exe : null;
}

/** 探测某个端口上有没有人在监听。 */
function portAlive(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect(port, TARGET_HOST);
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (err) { }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/**
 * 重新发现 DSH 的端口，变了就换上。
 *
 * DSH 每次重启都会换一个新端口（它自己在变），所以「启动时认一次就不管了」
 * 是不行的。这里只负责跟上，不负责启动 —— 由调用方按情况决定要不要启动。
 *
 * @returns {number} 现在该用的端口（发现不了就返回原值）
 */
function refreshDshPort() {
  if (EXPLICIT_TARGET_PORT) return TARGET_PORT;
  const current = dshRuntime.peekRuntime();
  if (current && current.running && current.port) TARGET_PORT = current.port;
  return current && current.running ? current.port : TARGET_PORT;
}

async function refreshDshRuntimeState(force = false) {
  const config = cfg.loadConfig();
  const runtime = await dshRuntime.resolveRuntime(EXPLICIT_TARGET_PORT
    ? { ...config, dshPort: EXPLICIT_TARGET_PORT } : config, { force });
  // A fixed target still needs live protocol and upstream-auth discovery.
  // Checking only TCP left legacy RPC with an expired five-second cache and
  // falsely reported a protocol upgrade. Never substitute another listener
  // when the explicitly selected application is unavailable.
  if (!runtime.running || (EXPLICIT_TARGET_PORT && runtime.port !== EXPLICIT_TARGET_PORT)) {
    DSH_UPSTREAM_AUTH_OK = null;
    UPSTREAM_COOKIE = null;
    return { ready: false, runtime: null };
  }
  if (!EXPLICIT_TARGET_PORT && runtime.port && runtime.port !== TARGET_PORT) {
    log(`DSH 端口变化: ${TARGET_PORT} -> ${runtime.port} (${runtime.kind}, ${runtime.version || 'unknown'})`);
    TARGET_PORT = runtime.port;
  }
  const authenticated = await dshUpstreamAuth.resolve(runtime, { force });
  DSH_UPSTREAM_AUTH_OK = authenticated.ok;
  UPSTREAM_COOKIE = authenticated.ok ? authenticated.cookie : null;
  // Return the result actually verified by this request, rather than reading
  // peekRuntime after auth I/O may have outlasted its cache lifetime.
  return { ready: authenticated.ok, runtime };
}

async function refreshDshRuntime(force = false) {
  return (await refreshDshRuntimeState(force)).ready;
}

/**
 * 看门狗：每隔几秒确认 DSH 还在原来的端口上。
 *
 * 为什么需要它：只靠「请求失败时补救」的话，使用者会先看到一个失败页面才恢复。
 * 这里提前把端口跟上，请求过来时已经是对的 —— 使用者完全感觉不到
 * DSH 中途重启过。这正是「重启后连不上」要根治的地方。
 */
function startDshWatchdog() {
  let probing = false;
  const timer = setInterval(async () => {
    if (dshStarting || probing) return;
    probing = true;
    try { await refreshDshRuntime(); }
    catch (err) { log(`DSH discovery failed: ${err.message}`); }
    finally { probing = false; }
  }, 5000);
  if (timer.unref) timer.unref();
}



/**
 * 确保 DSH 正在运行。返回 true 表示已就绪。
 * 并发触发时只会真正启动一次。
 */
async function ensureDshRunning() {
  if (await refreshDshRuntime(true)) return true;
  if (dshStarting || !findDshExe()) return false;
  dshStarting = true;
  dshStartStartedAt = Date.now();
  try {
    // Preserve explicit standalone/test commands. Normal desktop/CLI startup is
    // shared with the target console and never downloads an npm package.
    if (DSH_EXE && fs.existsSync(DSH_EXE)) {
      const args = require('./dsh-adapter.js').tokenizeCommandLine(String(process.env.DSH_ARGS || ''));
      const child = spawn(DSH_EXE, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', err => log(`DSH start failed: ${err.message}`));
      child.unref();
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await sleep(1000);
        if (await refreshDshRuntime(true)) return true;
      }
      return false;
    }
    const result = await require('./targets.js').dsh.start();
    if (!result.ok) log(`DSH auto-start failed: ${result.message}`);
    return Boolean(result.ok && await refreshDshRuntime(true));
  } catch (err) { log(`DSH auto-start failed: ${err.message}`); return false; }
  finally { dshStarting = false; }
}

// DSH 未运行时给手机看的页面：中文说明 + 自动刷新重试，
// 而不是一个 upstream error。
/**
 * 「电脑上的 DSH 没在运行，已经帮你打开了」这一页。
 *
 * 它也是服务端直出的（这段时间浏览器那边还没有任何脚本在跑），所以和配对页一样
 * 按 Accept-Language 出语言。页面 5 秒自刷一次，DSH 起来之后自然会进去。
 *
 * 语言切换链接里的 ?lang= 会被这个自刷新带走（刷新的是当前地址），
 * 所以在这一页上换语言之后，后续几次自刷也还是新语言。
 */
function dshStartingPage(req, lang) {
  const code = normLang(lang);
  const T = PAGE_TEXT[code].starting;
  return `<!doctype html>
<html lang="${code}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>${T.title}</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#eee;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 .card{width:min(90vw,380px);padding:28px;border-radius:16px;background:#17171a;text-align:center}
 h1{font-size:17px;margin:0 0 10px}
 p{font-size:13px;color:#9a9aa2;margin:0;line-height:1.7}
 .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4d6bfe;
      margin-right:6px;animation:p 1s infinite alternate}
 @keyframes p{from{opacity:.25}to{opacity:1}}
</style></head><body>
<div class="card">
  <h1><span class="dot"></span>${T.heading}</h1>
  <p>${T.body}</p>
  ${langSwitcher(req, code, false)}
</div></body></html>`;
}

// ── 本机控制台 ────────────────────────────────────────────────────────────────
// 让使用者不必敲命令就能看到状态、复制地址、扫码。所有控制台端点都只允许
// 回环来源 —— 手机和外网拿不到，避免把管理面暴露出去。

function isLoopback(req) {
  if (privateHttpsAdmission.isForceRemote(req)) return false;
  // ★ 只看来路地址是不够的 —— **隧道流量也是从 127.0.0.1 进来的**。
  //
  //   cloudflared 就跑在这台机器上，它把公网请求转发到 127.0.0.1:8080，
  //   于是 req.socket.remoteAddress 永远是回环地址。只判这一项的话，管理面
  //   （/console、/__console/status、/__console/action）等于**对整个公网开放
  //   而且无需认证**：任何人拿到隧道网址，就能读到 access-key.txt 和
  //   e2ee-secret.txt 的原文 —— 完整登录权 + 端到端加密的钥匙。
  //   那正是这个项目存在要防的事，等于把门锁装在门框外面。
  //
  //   所以还必须排除「经中继进来」这一种。viaRelay 认 Cloudflare 头、
  //   常见转发头，以及一切非本机 Host（不限特定隧道域名）：
  //   客户端能伪造，但伪造只会让请求被当成**更需要加密**，对自己更严，
  //   不构成绕过。
  return requestOrigin.isLoopback(req);
}

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { return null; }
}

function tailFile(p, lines) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').slice(-lines).join('\n');
  } catch (err) { return ''; }
}

/**
 * 查 DeepSeek 余额并把结果原样回给前端。
 *
 * 抽出来是因为有两个入口：控制台页面（回环，在认证门之前）和手机（过了两道门之后）。
 * 两处各写一份的话，改了一处另一处就成了摆设 —— 这个项目已经因为同样的原因
 * 出过好几次问题（设备登记、隧道通知）。
 *
 * 永远返回 200：余额查不到是**业务结果**（没填 API key、上游不通），
 * 不是 HTTP 层面的错误。前端据此把话说清楚，而不是去猜状态码。
 */
// ── 挑战应答的服务端一半 ──────────────────────────────────────────────────────
//
// 非一次性的 nonce 表 + 限速桶。
const AUTH_CHALLENGE_TTL_MS = 60 * 1000;
const authChallenges = new Map();          // nonce -> 过期时间
let authRateHits = [];

// 哪台设备已经证明过身份（设备 id -> 通过时间）。
//
// ★ 2026-09-26：**改成落盘**（logs/auth-proven.json）。
//
//   原来这里写着「只存在内存里 —— 重启网关就作废，手机下次加载会重新证明一次。
//   这是刻意的不落盘，就不存在『一份被篡改的名单让冒名者混进来』」。
//   前半句是事实，后半句代价没算够：手机**正开着**的页面在网关重启后会被
//   立刻拒绝（日志原话「不在开页面的窗口里，直接拒」），而客户端未必会在
//   40 秒内自己补证 —— 使用者的体感就是「切出去再切回来就必须刷新」，
//   而这在第三道门之前从没发生过（那时重启不影响任何东西）。
//   触发它的往往不是攻击者，而是**我们自己重启**（看门狗、更新、我改完代码）。
//
//   落盘的安全账：文件里只有「设备 id → 通过时间」，没有任何凭据；能改它的
//   只有本机进程或使用者，而那种权限本来就能读 logs/access-key.txt；
//   隧道/中继碰不到文件系统。注销（revokedAt）与 12 小时有效期一个都没动。
const authProven = new Map();
const AUTH_PROVEN_TTL_MS = 12 * 60 * 60 * 1000;   // 12 小时，够一个使用周期
const AUTH_PROVEN_FILE = path.join(LOG_DIR, 'auth-proven.json');

/** 启动时读回来（过期的直接丢掉）。读不到/坏了就当空的，绝不因此起不来。 */
function loadAuthProven() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_PROVEN_FILE, 'utf8'));
    const now = Date.now();
    let kept = 0;
    for (const [id, at] of Object.entries(raw || {})) {
      if (typeof at === 'number' && now - at < AUTH_PROVEN_TTL_MS) { authProven.set(id, at); kept++; }
    }
    if (kept) log(`进门证明已从磁盘恢复 ${kept} 台设备（重启不再把它们踢出去）`);
  } catch (err) { /* 第一次跑没有这个文件，正常 */ }
}

/** 写回磁盘。证明很少发生，直接写就行；写不了也不影响内存里的那份。 */
function saveAuthProven() {
  try {
    const obj = {};
    const now = Date.now();
    for (const [id, at] of authProven) {
      if (now - at < AUTH_PROVEN_TTL_MS) obj[id] = at;
    }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(AUTH_PROVEN_FILE, JSON.stringify(obj), 'utf8');
  } catch (err) { /* 写不了就退化成纯内存（和以前一样） */ }
}
const authObserved = new Set();                    // 已经记过"没证明"日志的设备，别刷屏

// ── 「等一等证明」的窗口（2026-09-27 按慢链路重写过，见下面那段） ─────────────
//
// 开了强制之后立刻冒出来的一个真问题：**页面自己的启动请求和它的证明是同时出发的**。
// 手机打开页面 → 浏览器一边加载脚本、一边就打 /api/session/list 了，而证明
// （挑战 → 应答）要两个来回。日志里实测就是这样：先一串 /api/*，证明落在后面。
//
// 直接 403 的后果：界面首次加载是空的，用户得手动刷新一次 —— 而"看起来坏掉了"
// 正是这一整轮需求里最不能接受的表现。
//
// 所以未证明的设备发来的**内容**请求先挂住（不回复）。这个等待**不泄露任何
// 东西** —— 没证明就一个字节都不发，只是把"拒绝"推迟了一会儿。

// 每台设备最多「等」几次（一次开页面之内）。
//
// 为什么需要上限：手里**根本没有钥匙**的设备（只配对码进来的、或者拿访问密钥
// 冒充的）永远等不到证明 —— 不设上限的话，它的每一个内容请求都要占着等待，
// 一屏十几个请求就是十几个挂着的连接。等过几次还不来，就当场拒。
// 真手机不会碰到这个上限：它开页面几秒内就把证明交了（交了就把计数清零）。
const PROOF_WAIT_MAX_PER_DEVICE = 40;
const proofWaitHits = new Map();   // deviceId -> 本次开页面已经为它等过几次

// ── 2026-09-27 修正：等待策略按「慢链路」重写 ────────────────────────────────
//
// 慢链路上首次加载接近一分钟。查下来主因是**隧道那条路**（守护进程自己的
// 探测：2.8–5 秒一次请求；同一时刻内网 HTTPS 是 0–4 毫秒），但原来那套等待把
// 隧道上的痛苦**放大了**：
//
//   证明要走两个来回（取挑战 → 交应答）。在 4 秒/请求的链路上，光证明就 ~8 秒。
//   而原来最多只等 2.5 秒 —— 于是开页面那一屏请求**全部**超时拿到 403，
//   手机端再逐条重试（每条又要一个来回），一个来回叠一个来回，正好解释
//   「要 1 分钟」。
//
// 现在的规则（只在服务端，老手机不用更新就能受益）：
//
//   1. **只有「刚开页面」才等**。网关给这台设备发过应用外壳之后的
//      PROOF_BOOT_WINDOW_MS 之内算刚开页面；之后（页面开着很久、或者压根
//      不是页面请求）**立即 403**，不再一条条挂 2.5 秒 —— 陈旧页面要么已经
//      有证明，要么本来就该刷新，挂着只会让人觉得卡。
//   2. **等就等到底**：这台设备**已经来取过挑战**（说明它手里有钥匙、正在证），
//      就把等待放到 PROOF_WAIT_FULL_MS（10 秒）—— 一个来回慢就慢一次，
//      证明一到立刻放行，不再让手机端走「403 → 重新证明 → 重试」那圈。
//   3. 没取过挑战的设备（多半根本没有钥匙）只等 PROOF_WAIT_MS（2.5 秒），
//      和以前一样，不会更差。
const PROOF_WAIT_MS = 2500;              // 没见过来取挑战的：等这么久就拒
const PROOF_WAIT_FULL_MS = 10000;        // 正在证明的：等到底（慢链路上一个来回）
const PROOF_WAIT_STEP_MS = 120;
const PROOF_BOOT_WINDOW_MS = 120 * 1000; // 「刚开页面」的窗口：外壳发出去之后 2 分钟
const PROOF_CHALLENGE_FRESH_MS = 60 * 1000;  // 多久之内取过挑战算「正在证明」

const proofShellAt = new Map();       // deviceId -> 上次给它发应用外壳的时间
const proofChallengeAt = new Map();   // deviceId -> 上次它来取挑战的时间

/** 这台设备刚刚开了页面？（等证明只在刚开页面时做，见上面那段说明） */
function proofBootWindowOpen(deviceId) {
  const t = proofShellAt.get(deviceId) || 0;
  return t > 0 && (Date.now() - t) < PROOF_BOOT_WINDOW_MS;
}

/** 这台设备正在证明？（来取过挑战 —— 说明它手里有钥匙，值得等） */
function proofLooksInProgress(deviceId) {
  const t = proofChallengeAt.get(deviceId) || 0;
  return t > 0 && (Date.now() - t) < PROOF_CHALLENGE_FRESH_MS;
}

function authProvenAt(deviceId) {
  const t = authProven.get(deviceId);
  if (!t) return false;
  if (Date.now() - t > AUTH_PROVEN_TTL_MS) { authProven.delete(deviceId); saveAuthProven(); return false; }
  return true;
}

/** 这个端点会被外面打（手机在还没认证时就要用），必须限速 */
function authRateOk(req) {
  const now = Date.now();
  authRateHits = authRateHits.filter((t) => now - t < 60000);
  if (authRateHits.length >= 120) return false;   // 一分钟 120 次，正常用远远够
  authRateHits.push(now);
  return true;
}

/**
 * 从长期密钥派生**认证专用**的钥匙。
 *
 * 为什么要密钥分离：加密和认证用同一把钥匙，一边泄露就连累另一边。
 * 用 HKDF 加一个不同的 salt/info 派生出来，两把钥匙互不可推。
 * （和 test-challenge-response.js 里验证过的参数完全一致 —— 那里跑通过 8/0。）
 */
function authKeyOf(longTermSecret) {
  return require('./e2ee.js').hkdf(
    Buffer.from(longTermSecret, 'utf8'),
    Buffer.from('dsh-gw-auth'),
    'dsh-gw|auth|v1', 32);
}

/**
 * 核一次挑战应答。nonce **一次性** —— 不管成不成立，用过就作废，防重放。
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyAuthResponse(nonce, response) {
  if (!nonce) return { ok: false, reason: '没给 nonce' };
  const exp = authChallenges.get(nonce);
  if (!exp) return { ok: false, reason: 'nonce 不认识（没发过 / 已用过 / 已过期）' };
  authChallenges.delete(nonce);
  if (Date.now() > exp) return { ok: false, reason: 'nonce 过期' };

  let secret = null;
  try { secret = e2eeBridge.readSecret(); } catch (err) { }
  if (!secret) return { ok: false, reason: '这台电脑上没配加密密钥' };

  const want = crypto.createHmac('sha256', authKeyOf(secret)).update(nonce).digest();
  const got = Buffer.from(String(response), 'base64url');
  if (got.length !== want.length) return { ok: false, reason: '应答长度不对' };
  // 时间无关比较 —— 别让对端靠响应时间逐字节猜
  if (!crypto.timingSafeEqual(got, want)) return { ok: false, reason: '应答对不上' };
  return { ok: true };
}

// ── 一次往返的证明（2026-09-27，慢链路优化）─────────────────────────────────
//
// 为什么加：原来的挑战应答要两个来回（取挑战 → 交应答）。在内网那是 0 毫秒的事，
// 但在隧道上（实测 2.8–5 秒一个来回）光证明就要 8 秒以上，使用者感觉到的是
// 「开页面要等」。
//
// 做法：手机自己产生随机数 + 当前时间戳，一次把 {ts, nonce, response} 发过来：
//
//     response = HMAC-SHA256( authKey , ts + '|' + nonce )
//
// 服务端核三件事：时间戳在窗口内、这个 nonce 没用过、HMAC 对得上。
//
// ★ 加密**一个字都没动**，这一点很重要，所以说清楚：
//   · 这里用的 authKey 仍然是 HKDF(长期密钥, salt='dsh-gw-auth',
//     info='dsh-gw|auth|v1') —— 当初刻意做的**密钥分离**，认证钥匙和加密钥匙
//     是两把；
//   · 内容加密的时段密钥（AES-GCM）、WS 的端到端加密、请求/响应正文加密，
//     一条都不经过这段代码，它们的派生参数一个字节没改；
//   · 「证明自己知道 # 里那串」这件事本身没变 —— 变的只是**要几个来回**。
//
// 防重放和原来同级：
//   · nonce 一次性（用过的进黑名单，同一个包再发一次直接拒）；
//   · 时间戳窗口 AUTH_TS_SKEW_MS：窗口外的包直接拒（连 HMAC 都不算）。
//   两者叠加的效果：隧道即使录下一个完整的证明包，也只能在「正主还没用掉它」
//   的那一瞬间抢先重放一次 —— 和原来「录下应答抢先用」是同一类、同一量级的
//   窗口，没有变宽。
//
// ★ 唯一的**新失败面**是手机的时钟（原来那套不看时间）。所以：
//   · 窗口给宽（±5 分钟），手机时间差几分钟照样能用；
//   · 差太多就回一个带 code 的拒绝（stale-ts），手机端**自动退回两个来回**的
//     老路 —— 也就是说最坏情况是「不快」，不是「进不去」。
const AUTH_TS_SKEW_MS = 5 * 60 * 1000;      // 时间戳窗口：±5 分钟
const AUTH_USED_NONCE_TTL_MS = 15 * 60 * 1000;  // 用过的 nonce 记这么久（> 窗口）

/**
 * 核一次「一次往返」的证明。
 * @returns {{ok: boolean, reason?: string, code?: string}}
 */
function verifyOneShotProof(ts, nonce, response) {
  const t = Number(ts);
  if (!Number.isSafeInteger(t) || t <= 0) return { ok: false, code: 'no-ts', reason: '没给时间戳' };
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256 || /[\u0000-\u0020\u007f]/.test(nonce)) {
    return { ok: false, code: 'bad-nonce', reason: 'nonce 太短' };
  }
  const skew = Math.abs(Date.now() - t);
  if (skew > AUTH_TS_SKEW_MS) {
    return {
      ok: false, code: 'stale-ts',
      reason: `时间戳差了 ${Math.round(skew / 1000)} 秒（手机的时间对不对？）`
    };
  }
  let secret = null;
  try { secret = e2eeBridge.readSecret(); } catch (err) { }
  if (!secret) return { ok: false, code: 'no-secret', reason: '这台电脑上没配加密密钥' };

  const want = crypto.createHmac('sha256', authKeyOf(secret))
    .update(`${t}|${nonce}`).digest();
  const got = Buffer.from(String(response), 'base64url');
  if (got.length !== want.length) return { ok: false, code: 'bad-length', reason: '应答长度不对' };
  if (!crypto.timingSafeEqual(got, want)) return { ok: false, code: 'bad-hmac', reason: '应答对不上' };

  // Persist only an authenticated nonce, before granting proof. A storage or
  // capacity failure is refusal, never an in-memory or eviction fallback.
  let admitted;
  try { admitted = replayAdmission.defaultStore.consume(replayAdmission.scopeOf(secret),
    'proof:' + crypto.createHash('sha256').update(nonce).digest('hex'), Date.now() + AUTH_USED_NONCE_TTL_MS); }
  catch (_) { admitted = { ok: false, code: 'replay-store-unavailable' }; }
  if (!admitted || admitted.ok !== true) return { ok: false,
    code: admitted && admitted.code === 'replayed-request' ? 'replayed' : admitted && admitted.code || 'replay-store-unavailable',
    reason: '这次证明未获准；重复证明或防重放存储不可用。请检查电脑上的桥。' };
  return { ok: true };
}

/**
 * 「还没证明身份的首次访问」允许取哪些路径。
 *
 * ★ 关键设计：**限内容，不限时**。
 *
 * 上一版我想的是给 60 秒宽限期 —— 那是错的：60 秒足够把会话列表、文件、
 * 余额全捞一遍，等于白做。
 *
 * 正确的划法是只放行**这台设备自己的程序**：页面、脚本、样式、图标。
 * 为什么放行这些是安全的 —— **它们正是隧道本来就在转发的东西**。
 * 隧道早就有一份了，放行等于没给它任何新东西。
 *
 * 而它真正想要的那些（会话预览、文件、余额、实时通道），一条都不在这里，
 * 全都要先证明「我知道 # 里那串」。
 *
 * 于是第一次使用是顺的：手机打开链接 → 页面和脚本照常加载 →
 * route.js 跑挑战应答（几秒）→ 通过 → 转正 → 内容全部开放。
 * 使用者不需要输入任何东西、点任何确认 —— #k= 已经在地址里了。
 */
const BOOTSTRAP_PATHS = new Set([
  '/', '/index.html', '/dsh-lite',
  '/polyfill.js', '/compat.js', '/dsh-directory-picker.js', '/i18n.js', '/dsh-lite-lang.js', '/e2ee.js', '/voice.js', '/route.js', '/boot.js',
  '/dsh-lite.css', '/dsh-lite-pin.js', '/dsh-lite-ui.js', '/dsh-lite-adapter.js',
  '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-lite-switch.js', '/dsh-lite-update.js',
  // ★ 这个漏了会**静默失效**：它在认证之前就要能取到（第一次打开时手机还没
  //   转正）。漏掉的表现是「横幅时有时无」，而且只在真机上、只在第一次出现 ——
  //   最难查的那种。
  '/first-load.js',
  // ★ 这一份必须能在**证明之前**取到：它就是用来证明的（漏了 = codex/go 两页永远 403）。
  '/prove.js',
  '/custom.js', '/custom.css', '/sw.js',
  '/manifest.json', '/manifest.webmanifest', '/pocket-bridge.svg', '/icon-maskable.png',
  // ★ 配对页 / 恢复票据 / 选择页。挑战应答开成真拦之后（2026-09-27）这三条必须放行 ——
  //   它们的使用者**正是还没有钥匙的那台设备**：让他证明「我知道 # 里那串」，
  //   等于要求他用他还没有的东西进门。放行的代价很小：配对页要配对码、
  //   恢复票据是一次性的，页面上没有任何内容。
  '/pair', '/__recover', '/go', '/go/',
  // ★ codex 是我们的**应用页**（它自己带 /prove.js，加载时会证明）。不放行的话，
  //   没证明过的设备连这一页都打不开 —— 只会看到「正在验证」页，而使用者会理解成
  //   「要我重新配对」。它和 `/` 是同一类东西：这台设备自己的程序。
  '/__auth/challenge', '/__auth/verify',
  '/__health', '/__probe',
  // 「你是不是缺密钥」——**故意不加密**，因为它要回答的正是"没有密钥怎么办"。
  // 漏出去的只有两个布尔值（见处理里那段说明）。
  '/__dsh/lite-status',
  // 推送订阅：只上行一个推送地址，不含任何会话内容；挡了它只会让「隧道换地址」
  // 时那条通知悄悄失效 —— 而那正是最需要它工作的时刻。
  '/__push/vapid', '/__push/subscribe'
]);

function isBootstrapRequest(pathname) {
  const p = String(pathname || '').split('?')[0];
  if (BOOTSTRAP_PATHS.has(p)) return true;
  // ★ DSH 自己那些静态资源也是「这台设备的程序」，不是内容。
  //
  //   /assets/** 是 DSH 打包出来的 JS/CSS/图标（日志里实测：/assets/index.js、
  //   /assets/vendor-*.js、/assets/favicon-*.ico）。它们里面没有使用者的任何数据，
  //   而且**隧道本来就在转发它们** —— 挡下来等于没给它新东西，却会让界面加载不出来
  //   （一个资源 403，依赖它的整块界面就起不来，使用者看到的是「一直转圈」）。
  //
  //   /plugins/ 刻意**不**放行：它下面有个 /plugins/events（客户端插件的 HMR
  //   SSE 通道），是被真机请求过的东西，手机端不需要它，那就别开这个口子。
  //   真正的内容（会话、文件、余额、实时通道）全在 /api/** 上，那条路照旧要证明。
  if (/^\/assets\//.test(p)) return true;
  // ★ /plugins/** 必须放行 —— 这条是 2026-09-27 用真机日志查出来的。
  //
  //   原来这里刻意**不**放行，理由是「/plugins/ 下面只是个 /plugins/events
  //   （插件的 HMR 热重载 SSE 通道），手机端不需要」。那在旧版 DSH 上是对的。
  //
  //   但 DSH 0.1.7-rc.2 把**全部客户端插件模块**都搬到了这个前缀下：
  //   实测首页引用 **71 个**（dsh-client-ui-conversation 696KB、
  //   dsh-client-ui-chat 518KB、dsh-client-ui-workspace、
  //   dsh-client-ui-trajectory、dsh-api-remotes …），合计约 12 MB ——
  //   那已经是手机界面的绝大部分，不再是「开发用的通道」。
  //
  //   挡住它的后果是**死锁**，而且表现极难归因：
  //     界面要靠这些插件模块才跑得起来 → 模块被证明门挡住 → 应用起不来
  //     → 应用起不来就没法发起证明 → 模块继续被挡。
  //   日志实测就是这三行：
  //     403 未通过挑战应答: GET /plugins/（…等了 2500 ms 也没等到证明）
  //   使用者看到的是「对话点进去空白 / 选择工作区一直转圈 / 项目打不开」。
  //
  //   HMR 那条 SSE（/plugins/events）继续挡着 —— 手机端确实不需要它，
  //   原来那条理由在这个具体路径上仍然成立，所以只放开其余部分。
  if (/^\/plugins\//.test(p) && !/^\/plugins\/events(\/|$)/.test(p)) return true;
  // 图标这类静态资源
  return /^\/(icon|apple-touch-icon|favicon)[^/]*\.(png|ico|svg|webp)$/i.test(p);
}

/**
 * 回「这台设备还没通过挑战应答」。
 *
 * ★ 必须带 `x-dsh-need-proof: 1` 这个头。
 *
 *   手机端（e2ee.js 的 installProofRetry / installXhrProofRetry）靠它认出
 *   「不是坏了，是该重新证明」，然后自动续证 + **重试原来那条请求**。
 *   只回 403 而不带标记，表现是界面静默空掉（请求失败了、没人重试、也没提示），
 *   那是最难查的一类故障 —— 所以标记和状态码一样重要。
 *
 *   导航请求给一页能自救的 HTML（见 needProofPage），程序调用给 JSON：
 *   给 fetch/XHR 回 HTML 毫无意义。
 */
function rejectNeedProof(req, res) {
  const accept = String((req && req.headers && req.headers.accept) || '');
  const mode = String((req && req.headers && req.headers['sec-fetch-mode']) || '');
  const isNavigation = mode === 'navigate' || (/text\/html/i.test(accept) && !/application\/json/i.test(accept));
  const head = {
    'cache-control': 'no-store',
    'x-dsh-need-proof': '1',
    'x-dsh-need-proof-why': 'never-or-expired'
  };
  if (isNavigation) {
    head['content-type'] = 'text/html; charset=utf-8';
    res.writeHead(403, head);
    res.end(needProofPage(req, pageLanguage(req, res)));
    return;
  }
  head['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(403, head);
  res.end(JSON.stringify({
    ok: false,
    error: 'need-proof',
    hint: 'reopen the full link (the part after # is the key), or reload the page'
  }));
}

function serveBalance(req, res) {
  let force = false;
  try { force = new URL(req.url, 'http://x').searchParams.get('force') === '1'; }
  catch (err) { /* URL 解析不了就按不强制 */ }

  const send = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  Promise.resolve()
    .then(() => require('./deepseek.js').balance(force))
    .then(send)
    .catch((err) => send({ ok: false, error: err.message }));
}



/**
 * 换地址这类操作**不可撤销**，加一道冷却。
 *
 * 起因是一次真实事故：我派去审 UI 的自动化脚本在浏览器里「点着看」，
 * 点中了「换一个新地址」—— 访问密钥当场作废、使用者手机上的书签立刻失效。
 * 它没有恶意，只是没人告诉它那个按钮不能点。
 *
 * 靠「记得别点」是防不住的（人也会手滑、脚本更不会读心）。所以加一道
 * 时间闸：距离上次换密钥不到两分钟就不让换。
 *   · 正常人不会在两分钟内连换两次
 *   · 自动化脚本四处乱点时会撞上它
 *   · 真的要连换：等两分钟，或者走命令行 `node scripts/rotate-key.js`
 *
 * 判据用 access-key.txt 的**修改时间**，不另存状态 —— 重启后依然有效。
 */
const ROTATE_COOLDOWN_MS = 2 * 60 * 1000;

function rotateCoolingDown() {
  try {
    const st = fs.statSync(path.join(BASE, 'logs', 'access-key.txt'));
    const age = Date.now() - st.mtimeMs;
    if (age < ROTATE_COOLDOWN_MS) {
      return Math.ceil((ROTATE_COOLDOWN_MS - age) / 1000);
    }
  } catch (err) { /* 读不到时间就不拦 */ }
  return 0;
}

/**
 * 「这个设置要重启才生效」——那就自己重启，别丢给使用者。
 *
 * 换访问密钥、开/关内网 HTTPS 都是启动时读进内存的，改完不重启就还是旧的。
 * 原来这三处（加上换地址策略一共四处）都只丢一句话给使用者：
 * 「托盘图标右键 → 停止服务 → 再点一下启动」。那不是操作说明，
 * 那是把活推给他 —— 要记住托盘在哪、菜单里哪一项、点完还要再点回来，
 * 而且很容易只做一半（停了没启，手机直接连不上）。
 *
 * 重启的是**中间层**，隧道不动 —— 端口没变，守护进程会直接复用现有隧道，
 * 所以外网地址不变。这一点很关键：刚点完一个按钮就把人家手机书签换掉，
 * 是这个项目已经犯过一次的错。
 *
 * @returns {boolean} Whether controlled restart was accepted/scheduled. This
 * does not claim that drain, helper startup, or restart has completed.
 */
const desktopLifecycle = require('./gateway-lifecycle.js').createGatewayLifecycle({
  async spawnRestart(detail) {
    const args = [path.join(BASE, 'scripts', 'restart-gateway.js')];
  // 把自己**实际在用的端口**告诉助手。
  //
  // 不能让它去猜 8080：网关的端口是选出来的（8080 被占就往后挪到 8099），
  // 而助手要靠轮询健康检查来判断「中间层退了没有」。端口猜错的话它永远
  // 轮询一个没人监听的端口 —— 表现是白等 20 秒然后放弃重启，
  // 使用者看到的是「点了没反应」。这个信息我们这里百分之百确定，直接传。
    args.push('--port', String(PORT));
  // 更改地址要把新地址推到手机上 —— 那一步会让手机当场被踢下线，
  // 而它书签里还是旧地址；人在外面时没有这条推送就是死结。
    if (detail?.notifyAddress) args.push('--notify-address');
    // A returned ChildProcess is not proof of successful startup. Only its
    // spawn event permits the already-drained gateway to exit.
    await new Promise((resolve, reject) => {
      const helper = require('child_process').spawn(process.execPath, args,
        { cwd: BASE, detached: true, stdio: 'ignore', windowsHide: true });
      helper.once('error', reject);
      helper.once('spawn', () => { helper.unref(); resolve(); });
    });
    log(`设置已改（${detail?.reason}），桌面操作已结束，正在重启中间层（端口 ${PORT}）`);
  },
  exit(code) {
    // Preserve the response flush delay only after all actual owned children
    // have closed, all receipts have settled, and the helper has started.
    return new Promise(resolve => setTimeout(() => { process.exit(code); resolve(); }, 700));
  },
  onState(state) {
    if (state.phase === 'draining') log('Controlled gateway shutdown: desktop admission stopped; waiting for owned actions.');
    if (state.phase === 'failed') log(`Controlled gateway shutdown blocked (${state.code}); ownership evidence retained, no forced exit.`);
  }
});
function restartSelfSoon(reason, opts) {
  return desktopLifecycle.scheduleRestart(reason, opts);
}

function requestControlledGatewayAction(req, body) {
  const restarting = body?.action === 'restart-gateway';
  const reply = (status, code, scheduled = false) => ({ status, body: {
    ok: scheduled,
    ...(restarting ? { restarting: scheduled, restartScheduled: scheduled,
      restartState: desktopLifecycle.status(), restartBootId: GATEWAY_BOOT_ID } :
      { stopping: scheduled, shutdownScheduled: scheduled }),
    shutdown: desktopLifecycle.status(), bootId: GATEWAY_BOOT_ID, instanceId: INSTANCE_ID, pid: process.pid,
    ...(code ? { code } : {})
  } });
  // Unlike an OS process search, this request is pinned to one installation
  // and one exact boot. Browser-origin equality prevents local cross-site
  // forms from turning a public page into a stop button for the computer.
  if (!isLoopback(req)) return reply(403, 'invalid-source');
  try {
    const protocol = req.socket?.encrypted ? 'https:' : 'http:';
    const expectedOrigin = `${protocol}//${req.headers?.host}`;
    const parsed = new URL(expectedOrigin);
    const expectedPort = req.socket?.encrypted ? HTTPS_PORT : PORT;
    if (parsed.origin !== expectedOrigin || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
        Number(parsed.port || (protocol === 'https:' ? 443 : 80)) !== expectedPort ||
        req.headers?.origin !== expectedOrigin) return reply(403, 'invalid-source');
  } catch (_) { return reply(403, 'invalid-source'); }
  const uuid = value => typeof value === 'string' && value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const allowed = restarting ? ['action', 'expectedBootId', 'expectedInstanceId', 'expectedPid'] : ['action', 'expectedBootId', 'expectedInstanceId'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !['stop-gateway', 'restart-gateway'].includes(body.action) ||
      Object.keys(body).length !== allowed.length || Object.keys(body).some(key => !allowed.includes(key)) ||
      !uuid(body.expectedBootId) || !uuid(body.expectedInstanceId) ||
      restarting && (!Number.isSafeInteger(body.expectedPid) || body.expectedPid < 1 || body.expectedPid > 0xffffffff)) {
    return reply(400, restarting ? 'invalid-restart-request' : 'invalid-stop-request');
  }
  if (body.expectedBootId !== GATEWAY_BOOT_ID || body.expectedInstanceId !== INSTANCE_ID ||
      restarting && body.expectedPid !== process.pid) return reply(409, 'gateway-identity-mismatch');
  const state = desktopLifecycle.status();
  if (state.phase === 'failed') return reply(503, 'desktop-drain-failed');
  if (state.kind && state.kind !== (restarting ? 'restart' : 'shutdown')) return reply(409, 'shutdown-already-scheduled');
  if (restarting) {
    // Only the coordinator may launch the helper after durable close and
    // physical child drain. Restart never writes or clears a user stop marker.
    if (!desktopLifecycle.scheduleRestart('scoped local reload')) return reply(503, 'desktop-drain-failed');
    return reply(202, null, true);
  }
  // The daemon already observes this per-install flag. Persist it before an
  // accepted stop can exit; never remove private state or another install's
  // marker. A pre-existing regular flag is retained byte-for-byte.
  const flag = path.join(LOG_DIR, 'user-stopped.flag');
  try {
    let fd;
    try {
      fd = fs.openSync(flag, 'wx', 0o600);
      fs.writeFileSync(fd, 'Controlled local gateway stop requested.\n');
      fs.fsyncSync(fd);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = fs.lstatSync(flag);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw Error('unsafe-stop-flag');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  } catch (_) { return reply(503, 'stop-marker-unavailable'); }
  if (!desktopLifecycle.scheduleShutdown()) return reply(503, 'desktop-drain-failed');
  return reply(202, null, true);
}

async function buildConsoleStatus(lang) {
  const netInfo = cfg.detectNetwork();
  const status = readJsonFile(path.join(LOG_DIR, 'status.json')) || {};
  const dshAlive = await refreshDshRuntime();

  // 目标列表用缓存的那份：控制台每 5 秒刷一次，不能每次都去探端口
  if (Date.now() - targetCache.at > 8000) {
    try { await refreshTargets(); } catch (err) { /* 拿不到就用上一次的 */ }
  }

  // ★ 给出的地址必须**带上加密密钥**（#k=…）。
  //
  // 这里原来是 `/k/${ACCESS_KEY}` 就完了 —— 于是「从客户端复制地址 → 手机打开」
  // 得到的**永远是明文**：不报错、界面照常，只是隧道能看懂一切。
  // 使用者反复问「复制过来的地址为啥显示未加密」，根源就在这一行。
  //
  // 为什么加在这里是安全的：
  //   · entries 只出现在 /__console/status 里，那个端点**只认回环**，
  //     手机和外网都拿不到；
  //   · 控制台页面对这些地址**只给一个「复制」按钮，不画二维码** ——
  //     二维码是外包给 api.qrserver.com 画的，把密钥画进去等于送给第三方
  //     （配对页那个二维码至今仍然不带密钥，那是故意的）。
  //
  // 加密密钥没配（readSecret 返回 null）时，地址保持原样 —— 那种情况下
  // 明文就是设计如此，硬塞一个 #k= 反而会让手机解不开。
  const e2eeSecret = (() => {
    try { return e2eeBridge.readSecret(); } catch (err) { return null; }
  })();
  const kfrag = e2eeSecret ? `#k=${e2eeSecret}` : '';

  const conf = cfg.loadConfig();
  const tunnelDisabled = conf.tunnelProvider === 'none' || status.tunnel?.disabled === true;
  const entries = { lan: [], wan: null, pairPage: null, pairCode: currentPairCode(), lanHttps: [], encrypted: !!e2eeSecret,
    lanDisabled: conf.enableLanAccess === false && !HTTPS_PORT, publicTunnelDisabled: tunnelDisabled, privateHttps: null };
  const privateOrigin = conf.privateHttps?.enabled === true && privateHttpsStatus.normalizePrivateOrigin(conf.privateHttps.origin);
  if (privateOrigin) entries.privateHttps = `${privateOrigin.origin}/k/${ACCESS_KEY}${kfrag}`;
  for (const x of netInfo.lanV4) {
    if (conf.enableLanAccess !== false) entries.lan.push(`http://${x.address}:${PORT}/k/${ACCESS_KEY}${kfrag}`);
    if (HTTPS_PORT) {
      entries.lanHttps.push(`https://${x.address}:${HTTPS_PORT}/k/${ACCESS_KEY}${kfrag}`);
    }
  }
  if (netInfo.lanV4.length && conf.enableLanAccess !== false) {
    // 配对页**不带**密钥：它是给二维码用的，而且配对流程本来就会重新认证。
    entries.pairPage = `http://${netInfo.lanV4[0].address}:${PORT}/pair`;
  }
  if (!tunnelDisabled && status.tunnel && status.tunnel.url) {
    entries.wan = `${status.tunnel.url}/k/${ACCESS_KEY}${kfrag}`;
  }

  const domainMode = conf.tunnelDomainMode || 'dynamic';
  // “已经选好下次用哪种”与“这一条正在跑的隧道是什么”不是同一件事。
  // 切换策略刻意不立即重启（不能惊吓式换掉手机书签），所以控制台必须
  // 同时给出这两个状态，不能把配置值冒充成当前公网入口。
  const tunnelProvider = !tunnelDisabled && status.tunnel?.provider || null;
  const activeDomainMode = tunnelProvider === 'cloudflare-named' ? 'fixed'
    : tunnelProvider ? 'dynamic' : null;

  return {
    updatedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    instanceId: INSTANCE_ID,
    gateway: { port: PORT, running: true, bootId: GATEWAY_BOOT_ID, httpsPort: HTTPS_PORT || 0, dshPort: TARGET_PORT, dshAlive,
      desktopShutdown: desktopLifecycle.status(),
      dshRuntime: dshRuntime.serializeRuntime(dshRuntime.peekRuntime()), dshAuthReady: DSH_UPSTREAM_AUTH_OK },
    domain: {
      mode: domainMode,
      modeLabel: domainMode === 'fixed' ? '固定地址（自有域名）' : '动态地址（每次更换）',
      activeMode: activeDomainMode,
      pendingModeChange: !!(activeDomainMode && activeDomainMode !== domainMode),
      fixedConfigured: !!(conf.fixedTunnel && conf.fixedTunnel.name && conf.fixedTunnel.hostname),
      fixedHostname: (conf.fixedTunnel && conf.fixedTunnel.hostname) || null
    },
    lanHttps: (() => {
      const on = !!(conf.lanHttps && conf.lanHttps.enabled);
      let cert = null;
      try { cert = require('./make-cert.js').inspect(); } catch (err) { cert = null; }
      return {
        enabled: on,
        running: !!HTTPS_PORT,
        port: HTTPS_PORT || 0,
        certReady: !!(cert && cert.present && !cert.broken),
        daysLeft: cert && typeof cert.daysLeft === 'number' ? cert.daysLeft : null,
        caFile: require('./make-cert.js').CA_CERT,
        caFingerprint: cert && cert.ca ? cert.ca.fingerprint256 : null
      };
    })(),
    tunnel: {
      disabled: tunnelDisabled,
      url: !tunnelDisabled && status.tunnel?.url || null,
      provider: tunnelProvider,
      // 「进程在不在」和「公网通不通」必须分开报给界面。
      //
      // 原来这里只透 url 和 provider，把 running / reachable 丢掉了 ——
      // 于是界面只能写一句「已配置 · 可达性未验证」。而使用者真正会遇到的
      // 恰恰是那个中间态：cloudflared 进程活着、域名已被 Cloudflare 回收，
      // 电脑上看着一切正常，手机怎么都连不上。分开报才说得清。
      running: !tunnelDisabled && typeof status.tunnel?.running === 'boolean' ? status.tunnel.running : null,
      reachable: !tunnelDisabled && status.tunnel && typeof status.tunnel.reachable === 'boolean'
        ? status.tunnel.reachable : null,      // null = 守护进程这轮还没探
      probeMs: (status.tunnel && status.tunnel.probeMs) || null,
      probeError: (status.tunnel && status.tunnel.probeError) || null,
      checkedAt: status.updatedAt || null
    },
    devices: sessions.list(),
    // 语言得**当参数传进来**：这个函数没有 req。
    //
    // 原来我在这里直接写了 pickLang(req) —— 而 buildConsoleStatus() 是没有
    // req 参数的，于是 ReferenceError，整个 /__console/status 500，
    // 控制台一片空白。是 browser-check 和 test-balance-ui 同时变红才暴露的。
    targets: require('./targets.js').localize(targetCache.list, lang),
    // 通知：配了哪些通道、手机订阅了几台、扫码订阅的地址是什么
    notify: (() => {
      let t = {};
      try { t = JSON.parse(fs.readFileSync(NOTIFY_TARGETS_FILE, 'utf8')); } catch (err) { }
      let subs = 0;
      try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8')).length; } catch (err) { }
      return {
        bark: t.bark || null,
        ntfy: t.ntfy || null,
        // 把这个地址做成二维码，手机扫一下就订阅了 —— 比让使用者自己去
        // 装 App、搜主题、拼字符串现实得多
        subscribeUrl: t.ntfy || null,
        webPushDevices: subs,
        configured: !!(t.bark || t.ntfy || subs)
      };
    })(),
    entries,
    // Codex 桌面版登不上时最常见的原因：Rust 程序不读系统代理，而用户环境里
    // 没有代理变量 —— 于是登录时的「令牌交换」直连被墙，报 token_exchange_failed。
    // 这里把状态给控制台，控制台据此显示警告 + 一键修好的按钮。
    recentLog: [
      '# 中间层',
      tailFile(LOG_FILE, 12),
      '# 启动器',
      tailFile(path.join(LOG_DIR, 'daemon.log'), 6)
    ].join('\n')
  };
}

// Address URLs include the gateway access key in their path. This handler is
// reached only after the normal device/proof gates and e2eeWrap decryption.
function serveDshLiteAddresses(req, res) {
  const reply = (status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (req.method !== 'POST') { reply(405, { error: 'method-not-allowed' }); return; }
  if (!req.__dshE2eeDecrypted || !req.headers || req.headers['x-dsh-e2ee'] !== '1') {
    reply(403, { error: 'encrypted-request-required' }); return;
  }
  buildConsoleStatus(pickLang(req)).then((data) => {
    // The phone already owns the fragment key, so return only address URLs.
    const strip = value => typeof value === 'string' ? value.split('#')[0] : null;
    const entries = (data && data.entries) || {};
    reply(200, { ok: true,
      lan: Array.isArray(entries.lan) ? entries.lan.map(strip).filter(Boolean) : [],
      lanHttps: Array.isArray(entries.lanHttps) ? entries.lanHttps.map(strip).filter(Boolean) : [],
      wan: strip(entries.wan), pairPage: strip(entries.pairPage),
      encrypted: entries.encrypted === true, needsKey: false });
  }).catch((err) => {
    log(`地址面板读取失败: ${err.message}`);
    reply(500, { ok: false, error: 'addresses-unavailable' });
  });
}

function handleConsole(req, res, u) {
  if (u.pathname === '/__private-https') {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('loopback only');
      return true;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('method not allowed');
      return true;
    }
    var privateOptions = cfg.loadConfig().privateHttps || {};
    privateHttpsStatus.readStatus({ enabled: privateOptions.enabled, origin: privateOptions.origin, gatewayPort: PORT })
      .then(function (status) {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ...status, gatewayAdmissionImplemented: true }));
      }).catch(function () {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, code: 'private-https-status-unavailable' }));
      });
    return true;
  }
  // 控制台资源
  if (u.pathname === '/console' || u.pathname === '/console/') {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('console is loopback only');
      return true;
    }
    let html;
    // This loopback-only console switches languages live; keep its complete
    // dictionary. Phone/selector assets retain their existing trimming policy.
    try { html = fs.readFileSync(path.join(PWA_DIR, 'console.html'), 'utf8'); }
    catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('console.html 缺失');
      return true;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return true;
  }

  // 余额：控制台页面自己要用，所以必须放在认证门**之前**。
  //
  // 这是实测出来的 bug：控制台是「人坐在电脑前」的页面，只认回环；
  // 而它发的 /__deepseek/balance 原来落在认证门之后，于是电脑上的余额
  // 一直读不出来 —— 界面上显示的是 JSON 解析错误的原文
  // （Unexpected token 'a', "access key "...），看着像接口坏了，
  // 其实是**被我们自己的认证门拦了**，那句话是 403 的正文。
  //
  // 只对回环放开：手机走下面认证之后的同一个处理函数，边界一点没松。
  if (u.pathname === '/__deepseek/balance' && isLoopback(req)) {
    serveBalance(req, res);
    return true;
  }

  // Codex 的额度，同一个道理：控制台要用，而控制台是回环页面。


  if (u.pathname === '/__console/status') {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('loopback only');
      return true;
    }
    buildConsoleStatus(pickLang(req)).then((data) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data, null, 2));
    }).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return true;
  }

  // ── 「你是不是缺密钥」——一条**故意不加密**的小端点 ─────────────────────────
  //
  // 为什么它必须能在没有密钥时也能取到：这正是它要回答的问题。
  // 放在闸门里就自相矛盾了 —— 缺密钥的请求会被闸门 403 掉，于是界面永远
  // 说不清"发送键为什么变灰"（使用者报的就是这个）。
  //
  // 漏出去的是什么：**两个布尔值**。没有地址、没有密钥、没有任何内容。
  // 代价为零，换来的是"缺密钥时界面能明确说清楚"。
  if (u.pathname === '/__dsh/lite-status') {
    let sealed = false;
    try { sealed = !!e2eeBridge.readSecret(); } catch (err) { sealed = false; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, encrypted: sealed, needsKey: sealed && !clientWantsE2ee(req, u) }));
    return true;
  }

  if (u.pathname === '/__console/action' && req.method === 'POST') {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('loopback only');
      return true;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    // 这个回调里有 await（发测试通知要等推送结果），必须是 async
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch (err) { body = {}; }

      if (body?.action === 'stop-gateway' || body?.action === 'restart-gateway') {
        const stopped = requestControlledGatewayAction(req, body);
        res.writeHead(stopped.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(stopped.body));
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
      if (body.action === 'fix-codex-proxy' || /^(?:codex|dot)(?:-|$)/i.test(String(body.action || ''))) {
        retiredTargets.replyHttp(req, res); return;
      }

      let result = { ok: false, message: '未知操作' };
      if (body.action === 'export-diagnostic') {
        // 生成脱敏诊断包 —— 手机连不上时，人需要把「现场」发给别人看，
        // 而现场里到处是访问密钥、加密密钥、推送凭据、设备指纹。
        // 脚本里是「先脱敏、再拿真实凭据回搜产物、搜到就拒绝写出」，
        // 所以这里只管跑它、把结果如实报回来，不自己拼内容。
        try {
          const r = require('child_process').spawnSync(
            process.execPath, [path.join(BASE, 'scripts', 'diagnostic-bundle.js')],
            { cwd: BASE, encoding: 'utf8', timeout: 60000, windowsHide: true });
          const out = `${r.stdout || ''}${r.stderr || ''}`;
          const m = out.match(/已写入\s+(\S+)/);
          if (r.status === 0 && m) {
            result = { ok: true, message: `诊断包已生成：${m[1]}（已确认不含密钥与正文）` };
          } else {
            // 非零退出意味着**自检搜到了不该有的东西，所以没有写出文件** ——
            // 这不是「生成失败」，是脱敏规则有漏洞，必须原样告诉使用者。
            result = { ok: false, message: `没有生成：${out.trim().split('\n').slice(-2).join(' ')}` };
          }
        } catch (err) {
          result = { ok: false, message: `生成诊断包出错: ${err.message}` };
        }
      } else if (body.action === 'open-logs') {
        try {
          const cmd = process.platform === 'win32' ? 'explorer'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';
          const child = spawn(cmd, [LOG_DIR], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          result = { ok: true, message: `已请求打开日志目录: ${LOG_DIR}` };
        } catch (err) {
          result = { ok: false, message: `打不开目录: ${err.message}` };
        }
      } else if (body.action === 'refresh-tunnel') {
        // 重建隧道，拿一个新地址。
        //
        // 原来的实现是**假的** —— 只回一句
        //   「隧道由启动器管理。请在命令行运行 gateway-daemon.js」
        // 那不是操作说明，是把活推给使用者。而这件事该发生的时候恰恰是
        // 手机已经连不上了（今天就是：Cloudflare 把快速隧道回收了，
        // 域名指向空气），他还要跑去命令行敲东西 —— 最不该让他折腾的时刻。
        //
        // 现在真的做：拉一个 detach 的助手，杀掉卡死的 cloudflared、
        // 重建一条、并让守护进程把新地址推给手机。
        try {
          const conf = cfg.loadConfig();
          const fixedMode = conf.tunnelDomainMode === 'fixed';
          if (fixedMode && !(conf.fixedTunnel && conf.fixedTunnel.name && conf.fixedTunnel.hostname)) {
            throw new Error('固定隧道尚未配置，不能用临时地址替代。');
          }
          const helper = require('child_process').spawn(
            process.execPath, [path.join(BASE, 'scripts', 'refresh-tunnel.js')]
              .concat(fixedMode ? ['--expect-same-address'] : []),
            { cwd: BASE, detached: true, stdio: 'ignore', windowsHide: true });
          helper.unref();
          log(fixedMode ? '收到「重连固定隧道」请求' : '收到「刷新隧道地址」请求，正在重建隧道');
          result = {
            ok: true,
            restarting: true,   // 让控制台显示"正在重启"并等它回来
            message: fixedMode
              ? '正在请求固定隧道重连（十几秒）。\n\n' +
                '· 固定 hostname 不会改变\n' +
                '· 若配置或 Cloudflare 凭据有问题，控制台会明确显示外网不可用，不会悄悄换成临时地址'
              : '正在重建临时隧道（十几秒）。\n\n' +
                '· 新地址会和旧的不一样，这是免费隧道的机制，没法保持\n' +
                '· 建好之后会自动往你手机推一条能直接点开的新链接\n' +
                '· 如果你刚才只是网卡了一下，不用刷新 —— 刷新会白白换掉地址'
          };
        } catch (err) {
          result = { ok: false, message: `刷新隧道失败: ${err.message}` };
        }
      } else if (body.action === 'forget-self-devices') {
        // 清掉「电脑自己打开控制台」留下的记录。
        //
        // 为什么不自动清：判据再稳也只是判据，而删错的代价是把使用者的手机
        // 从列表里抹掉（那台手机还连得上，但再也看不到、也断不掉了）。
        // 所以只在使用者按下按钮时清，而且只清能证明是本机的那些。
        try {
          const r = sessions.forgetSelf();
          log(`清理本机记录：删掉 ${r.removed} 条，剩 ${r.kept} 条`);
          result = r.removed
            ? { ok: true, message: `清掉了 ${r.removed} 条本机自己开的窗口记录。` }
            : { ok: true, message: '没有需要清理的记录。' };
        } catch (err) {
          result = { ok: false, message: `清理失败: ${err.message}` };
        }
      } else if (body.action === 'revoke-device') {
        try {
          const r = sessions.revoke(String(body.id || ''));
          result = r.ok
            ? { ok: true, message: `已注销「${r.label}」。那台设备下次访问会要求重新配对。` }
            : { ok: false, message: r.reason };
        } catch (err) {
          result = { ok: false, message: `注销失败: ${err.message}` };
        }
      } else if (body.action === 'rotate-and-refresh-dynamic') {
        // 这一项必须在服务端完成：rotate-all 会让网关很快重启，前端无法
        // 可靠地再发第二个「刷新隧道」请求，曾经会留下只换半套凭据的状态。
        const wait = rotateCoolingDown();
        const conf = cfg.loadConfig();
        if (conf.tunnelDomainMode === 'fixed') {
          result = { ok: false, message: '固定隧道不能更换地址；请使用「更换密钥」或「重新连接」。' };
        } else if (wait) {
          result = { ok: false, message: `刚刚换过地址，请等 ${wait} 秒再换。` };
        } else {
          try {
            require('child_process').execFileSync(
              process.execPath, [path.join(BASE, 'scripts', 'rotate-key.js'), '--revoke-sessions'],
              { encoding: 'utf8', timeout: 20000, windowsHide: true }
            );
            require('child_process').execFileSync(
              process.execPath, [path.join(BASE, 'scripts', 'rotate-e2ee.js')],
              { encoding: 'utf8', timeout: 20000, windowsHide: true,
                env: Object.assign({}, process.env, { DSH_GW_NO_NOTIFY: '1' }) }
            );
            const helper = require('child_process').spawn(
              process.execPath, [path.join(BASE, 'scripts', 'refresh-tunnel.js')],
              { cwd: BASE, detached: true, stdio: 'ignore', windowsHide: true });
            helper.unref();
            result = {
              ok: true,
              restarting: restartSelfSoon('更换临时地址和凭据', { notifyAddress: true }),
              message: 'Access credentials changed. Restart and tunnel refresh are scheduled after desktop actions finish. Old links and paired devices are invalidated.'
            };
          } catch (err) {
            result = { ok: false, message: `更换临时地址失败: ${err.message}` };
          }
        }
      } else if (body.action === 'rotate-all') {
        const wait = rotateCoolingDown();
        if (wait) {
          result = { ok: false, message: `刚刚换过地址，请等 ${wait} 秒再换。\n\n` +
            '（这道冷却防的是误触和自动化脚本乱点 —— 换地址不可撤销，' +
            '手机上的旧书签会立刻失效。）' };
        } else {
        // 「换一个新地址」= 访问密钥 + 加密密钥一起换。
        //
        // 原来是两个按钮（更改地址 / 更改密钥），使用者指出它们其实是一回事：
        // **两个操作的结果都是「手机必须重新存一次地址」**（地址在路径里、
        // 密钥在 # 后面，哪个变了旧链接都不能再用）。区别只在「旧手机会不会
        // 被踢下线」，而那是个使用者做选择时根本不该关心的细节。
        // 合成一个，两样一起换 —— 那也是最安全的做法。
        //
        // 「只换钥匙、不断开手机」那种轻量轮换仍然留着（rotate-e2ee），
        // 收在设置页的高级里。
        try {
          const out1 = require('child_process').execFileSync(
            process.execPath,
            [path.join(BASE, 'scripts', 'rotate-key.js'), '--revoke-sessions'],
            { encoding: 'utf8', timeout: 20000, windowsHide: true }
          );
          log(`换新地址：已轮换访问密钥 ${out1.trim().split('\n').join(' | ')}`);

          // 加密密钥也换。这里不发推送 —— 马上要重启，重启助手会统一推一条
          // 带一次性票据的新地址，推两次只会让人以为出了两回事。
          require('child_process').execFileSync(
            process.execPath,
            [path.join(BASE, 'scripts', 'rotate-e2ee.js')],
            {
              encoding: 'utf8', timeout: 20000, windowsHide: true,
              env: Object.assign({}, process.env, { DSH_GW_NO_NOTIFY: '1' })
            }
          );

          result = {
            ok: true,
            restarting: restartSelfSoon('换新地址', { notifyAddress: true }),
            message: 'Access credentials changed. Restart is scheduled after desktop actions finish.\n' +
              'The new phone address will appear after restart; configured notifications will receive the new link.'
          };
        } catch (err) {
          result = { ok: false, message: `换新地址失败: ${err.message}` };
        }
        }
      } else if (body.action === 'rotate-key') {
        const waitKey = rotateCoolingDown();
        if (waitKey) {
          result = { ok: false, message: `刚刚换过地址，请等 ${waitKey} 秒再换。` };
        } else
        try {
          const out = require('child_process').execFileSync(
            process.execPath,
            [path.join(BASE, 'scripts', 'rotate-key.js'), '--revoke-sessions'],
            { encoding: 'utf8', timeout: 20000, windowsHide: true }
          );
          log(`已轮换访问密钥: ${out.trim().split('\n').join(' | ')}`);
          result = {
            ok: true,
            restarting: restartSelfSoon('换访问密钥', { notifyAddress: true }),
            message: 'Access credentials changed and paired devices were revoked. Restart is scheduled after desktop actions finish.'
          };
        } catch (err) {
          result = { ok: false, message: `更改地址失败: ${err.message}` };
        }
      } else if (body.action === 'rotate-pair-code') {
        // 手动换一张。**只影响「下一台还没登记的新设备」** —— 已经连上的手机
        // 靠自己的设备令牌，不用重连、也不受影响（前端那句确认框就是这么写的）。
        try {
          PAIR_CODE = pairCode.rotate(PAIR_CODE_FILE);
          log('已换配对码（控制台按钮）：旧码立刻作废');
          result = {
            ok: true,
            pairCode: PAIR_CODE,
            message: '已换一张新配对码。已经连上的手机不受影响；下次有新设备要连时用新的这 6 位。'
          };
        } catch (err) {
          result = { ok: false, message: `换配对码失败: ${err.message}` };
        }
      } else if (body.action === 'rotate-e2ee') {
        // 换端到端加密密钥。**只能从电脑上的这个按钮触发** ——
        // 代码里没有任何定时器或启动钩子会自己调它。
        //
        // 换完立刻生效（不用重启）：密钥是每次请求现读文件的，
        // 和访问密钥不一样。但手机书签里带的旧 #k= 会失效。
        try {
          const out = require('child_process').execFileSync(
            process.execPath,
            [path.join(BASE, 'scripts', 'rotate-e2ee.js')],
            {
              encoding: 'utf8', timeout: 20000, windowsHide: true,
              // 按钮触发的轮换不顺手发推送 —— 人就在电脑前，直接复制地址就行。
              // 想推的话去命令行跑 `node scripts/rotate-e2ee.js --notify`。
              env: Object.assign({}, process.env, { DSH_GW_NO_NOTIFY: '1' })
            }
          );
          log('已轮换加密密钥（控制台按钮）');
          // 把脚本打印出来的手机地址原样抠出来返回给前端。
          //
          // 为什么不自己在前端拼：拼地址需要「当前有哪些入口」（内网 IP、
          // 隧道地址），那是 routes/status.json 才知道的事。
          // rotate-e2ee.js 已经算好并打印了，直接复用它的结果，
          // 免得两处逻辑各算各的、早晚不一致。
          const urls = (out.match(/https?:\/\/[^\s]+#k=[A-Za-z0-9_-]{16,}/g) || []);
          const m = out.match(/#k=([A-Za-z0-9_-]{16,})/);
          result = {
            ok: true,
            message: '加密密钥已更换，立刻生效。手机上的旧书签**不能用了**'
              + '（旧密钥解不开新密文，实时通道会直接断开 —— 不是降级成明文），'
              + '必须到控制台复制新地址重新存一次。',
            secret: m ? m[1] : null,
            urls
          };
        } catch (err) {
          result = { ok: false, message: `换加密密钥失败: ${err.message}` };
        }
      } else if (body.action === 'set-notify-topic') {
        // 让使用者能直接填自己的主题，不用去改 JSON 文件 ——
        // 「装个 App 还要编辑配置文件」这一步足以让大多数人放弃。
        //
        // body.auto = true 时**替他生成一个**：主题名是我们这边生成的东西
        // （随机串），却要使用者自己想一个填进去，这本身就不合理 ——
        // 他能想出来的多半是 dsh、codex 这种别人一猜就中的名字，
        // 而 ntfy.sh 的主题默认公开：猜到就等于能看到你电脑发出来的所有通知。
        try {
          let topic = String(body.topic || '').trim();
          let generated = false;
          if (body.auto === true) {
            topic = 'https://ntfy.sh/dsh-gw-' + crypto.randomBytes(6).toString('hex');
            generated = true;
          }
          const file = NOTIFY_TARGETS_FILE;
          let t = {};
          try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { }
          // 顺手记下使用者现在的语言。发完成通知的是定时器、没有请求上下文，
          // 它只能靠这里存下来的语言来选文案（否则英文使用者永远收到中文）。
          t.lang = pickLang(req);

          if (!topic) {
            delete t.ntfy;
            fs.writeFileSync(file, JSON.stringify(t, null, 4), 'utf8');
            result = { ok: true, message: '已清掉 ntfy 主题，通知不再发往手机（Bark 没动）' };
          } else {
            // 只接受 http(s) 地址，避免把乱七八糟的东西写进去
            if (!/^https?:\/\//i.test(topic)) {
              result = { ok: false, message: '要填完整地址，例如 https://ntfy.sh/我的主题' };
            } else {
              t.ntfy = topic;
              delete t._ntfy怎么填;
              fs.writeFileSync(file, JSON.stringify(t, null, 4), 'utf8');
              log(`通知主题已设为 ${topic}`);
              // 这里原来写的是「现在扫下面的二维码订阅」—— 二维码早就删掉了
              // （为了缩短页面，顺带去掉了那个第三方接口）。提示跟着改：
              // 主题名就在上面那张卡里，抄过去即可。
              result = {
                ok: true,
                message: (generated
                  ? '已经替你生成一个随机主题（名字越随机越安全）。\n'
                  : '已保存。\n') +
                  '接下来：手机装 ntfy → 订阅上面那串主题名 → 回来点「发一条测试通知」。\n' +
                  '把手机锁屏或切到别的应用，看能不能响。'
              };
            }
          }
        } catch (err) {
          result = { ok: false, message: `保存失败: ${err.message}` };
        }
      } else if (body.action === 'set-notify-bark') {
        try {
          const url = String(body.url || '').trim();
          const file = NOTIFY_TARGETS_FILE;
          let t = {};
          try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { }
          // 顺手记下使用者现在的语言。发完成通知的是定时器、没有请求上下文，
          // 它只能靠这里存下来的语言来选文案（否则英文使用者永远收到中文）。
          t.lang = pickLang(req);

          if (!url) {
            delete t.bark;
            fs.writeFileSync(file, JSON.stringify(t, null, 4), 'utf8');
            result = { ok: true, message: '已清掉 Bark，iPhone 不再收到通知' };
          } else if (!/^https?:\/\//i.test(url)) {
            result = {
              ok: false,
              message: '要填 Bark App 里显示的那一整条地址，形如 https://api.day.app/你的key'
            };
          } else {
            // 顺手把结尾的斜杠去掉，推送时是拼在后面的
            t.bark = url.replace(/\/+$/, '');
            delete t._bark怎么填;
            fs.writeFileSync(file, JSON.stringify(t, null, 4), 'utf8');
            log(`Bark 已设为 ${t.bark}`);
            result = {
              ok: true,
              message: '已保存。现在点「发一条测试通知」，把手机锁屏或切到别的应用，看能不能弹出来。'
            };
          }
        } catch (err) {
          result = { ok: false, message: `保存失败: ${err.message}` };
        }
      } else if (body.action === 'test-notify') {
        try {
          // 这一步有请求上下文，语言直接用它自己的
          const TM = NOTIFY_TEXT[pickLang(req)] || NOTIFY_TEXT.zh;
          const rs = await pushNotification(TM.testTitle, TM.testBody);
          const any = rs.some((r) => r.ok);
          log(`手动测试通知: ${JSON.stringify(rs)}`);
          result = {
            ok: any,
            message: any
              ? `已发出：${rs.map((r) => `${r.channel}(HTTP ${r.status})`).join('、')}。` +
                '现在把手机切到别的应用或锁屏，看有没有弹出来 —— 没弹就是手机上还没订阅。'
              : `没发出去：${JSON.stringify(rs)} —— 检查主题地址填对了没。`
          };
        } catch (err) {
          result = { ok: false, message: `发送失败: ${err.message}` };
        }
      } else if (body.action === 'open-tls-dir') {
        try {
          const dir = require('path').dirname(require('./make-cert.js').CA_CERT);
          const cmd = process.platform === 'win32' ? 'explorer'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';
          const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          result = { ok: true, message: `已请求打开证书目录: ${dir}` };
        } catch (err) {
          result = { ok: false, message: `打不开目录: ${err.message}` };
        }
      } else if (body.action === 'set-lan-https') {
        try {
          const conf = cfg.loadConfig();
          const on = body.enabled === true;
          conf.lanHttps = Object.assign({ enabled: false, port: 0 }, conf.lanHttps, { enabled: on });

          if (on) {
            // 真要开的话，先把证书准备好 —— 起不来就别改配置，
            // 否则重启后是一个「说开着、实际没监听」的状态，比不开更让人困惑
            const cert = require('./make-cert.js').ensure();
            conf.lanHttps.port = Number(conf.lanHttps.port) || 0;
            cfg.saveConfig(conf);
            result = {
              ok: true,
              restarting: restartSelfSoon('开内网 HTTPS'),
              message: 'LAN HTTPS is configured on. Restart is scheduled after desktop actions finish.\n\n'
                + 'The phone may show a self-signed certificate warning when opening the LAN HTTPS address.\n'
                + `To trust the local certificate, install this CA file on the phone: ${require('./make-cert.js').CA_CERT}`
            };
          } else {
            cfg.saveConfig(conf);
            result = {
              ok: true,
              restarting: restartSelfSoon('关内网 HTTPS'),
              message: 'LAN HTTPS is configured off. Restart is scheduled after desktop actions finish. LAN HTTP traffic will be readable to observers on the same network.'
            };
          }
        } catch (err) {
          result = { ok: false, message: `切换失败: ${err.message}` };
        }
      } else if (body.action === 'set-domain-mode') {
        const mode = body.mode === 'fixed' ? 'fixed' : 'dynamic';
        try {
          const conf = cfg.loadConfig();
          if (mode === 'fixed' && !(conf.fixedTunnel && conf.fixedTunnel.name && conf.fixedTunnel.hostname)) {
            result = {
              ok: false,
              message: '要固定地址，得先有自己的域名和 Cloudflare 隧道。'
                + '请在 config.json 里填 fixedTunnel.name 与 fixedTunnel.hostname（credentialsFile 可选），再选固定。'
            };
          } else {
            conf.tunnelDomainMode = mode;
            cfg.saveConfig(conf);
            // 这一条**故意不自动重启**。
            //
            // 其它三个设置重启中间层就行，隧道不受影响、地址不变。
            // 而「换地址策略」要换的是**隧道本身** —— 一旦重启隧道，
            // Cloudflare 快速隧道会分配一个全新地址，使用者手机书签当场失效。
            // 他刚点的是一个「更安全」的选项，结果地址没了、手机连不上，
            // 这个惊吓比「设置暂时没生效」严重得多。
            // 所以：只存配置，明确告诉他什么时候生效、以及现在什么都不用做。
            result = {
              ok: true,
              message: mode === 'fixed'
                ? '已切换为固定地址。**下次启动服务时**生效，现在不用做任何事。'
                  + '固定地址长期不变 —— 一旦泄露就是长期暴露，请确保链接只给自己。'
                : '已切换为动态地址（更安全）。**下次启动服务时**生效，现在不用做任何事。'
                  + '（这次不自动重启，就是为了不把你手机书签里的地址换掉。）'
            };
          }
        } catch (err) {
          result = { ok: false, message: `切换失败: ${err.message}` };
        }
      }

      if (result.restarting !== undefined && desktopLifecycle.status().kind === 'restart') {
        // Preserve the legacy synchronous boolean while naming its actual
        // meaning. Completion is visible separately in console status.
        result.restartScheduled = result.restarting === true;
        result.restartState = desktopLifecycle.status();
        result.restartBootId = GATEWAY_BOOT_ID;
        if (!result.restartScheduled) {
          result.ok = false;
          result.message = 'Settings were saved, but controlled restart is blocked. Existing desktop ownership evidence is preserved.';
        }
      }
      log(`控制台操作 ${body.action}: ${result.message}`);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return true;
  }

  return false;
}

// rc.2 embeds eight onboarding PNGs in an account plug-in script. Only the
// HTML URLs marked by rewriteKnownHtml enter this path. A different build or
// body fingerprint is forwarded unchanged, so old/new DSH versions retain
// their original behavior. The images are persisted before the smaller script
// is sent, otherwise a later image request could point at a missing file.
function proxyLazyDshModule(req, res, up, originalUrl) {
  const originalHeaders = cacheableAssetHeaders(req, up);
  const chunks = [];
  let size = 0;
  let overflow = false;
  const MAX_ENCODED_BYTES = 16 * 1024 * 1024;
  function writeChunk(chunk) {
    if (!res.write(chunk)) {
      up.pause();
      res.once('drain', () => up.resume());
    }
  }
  up.on('data', (chunk) => {
    if (overflow) { writeChunk(chunk); return; }
    chunks.push(chunk);
    size += chunk.length;
    if (size <= MAX_ENCODED_BYTES) return;
    overflow = true;
    res.writeHead(up.statusCode, originalHeaders);
    for (const buffered of chunks) writeChunk(buffered);
    chunks.length = 0;
  });
  up.on('end', () => {
    if (overflow) { res.end(); return; }
    const encoded = Buffer.concat(chunks);
    let body = encoded;
    try {
      const encoding = String(up.headers['content-encoding'] || '').toLowerCase();
      if (encoding === 'gzip') body = zlib.gunzipSync(encoded);
      else if (encoding === 'br') body = zlib.brotliDecompressSync(encoded);
      else if (encoding && encoding !== 'identity') throw new Error('unknown encoding');
      const plan = dshLazyImages.planDshLazyImages(originalUrl, body);
      if (!plan) throw new Error('unknown DSH module fingerprint');
      dshLazyImageStore.storeImages(DSH_LAZY_IMAGE_DIR, plan.images);

      const accept = String(req.headers['accept-encoding'] || '');
      let output = plan.script;
      let outputEncoding = null;
      if (/\bbr\b/i.test(accept)) {
        output = zlib.brotliCompressSync(output);
        outputEncoding = 'br';
      } else if (/\bgzip\b/i.test(accept)) {
        output = zlib.gzipSync(output, { level: 6 });
        outputEncoding = 'gzip';
      }
      const headers = Object.assign({}, originalHeaders);
      delete headers['content-encoding'];
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      delete headers.etag;
      delete headers['last-modified'];
      headers['content-length'] = output.length;
      headers['vary'] = 'Accept-Encoding';
      headers['x-dsh-lazy-images'] = '1';
      if (outputEncoding) headers['content-encoding'] = outputEncoding;
      res.writeHead(up.statusCode, headers);
      res.end(output);
    } catch (error) {
      // The optimization must never make a working DSH build unloadable.
      log(`DSH 图片按需加载跳过：${error.message}`);
      res.writeHead(up.statusCode, originalHeaders);
      res.end(encoded);
    }
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end();
  });
}

function proxyRequest(req, res, runtimeChecked = false) {
  // Only requests proved to originate on this computer may use the raw
  // upstream proxy. Phone/LAN/relay clients use the owned encrypted handlers.
  if (!isLocalRequest(req)) return dshPhoneSurface.replyHttp(req, res);
  if (!EXPLICIT_TARGET_PORT && !runtimeChecked) {
    refreshDshRuntime().then(running => {
      if (res.writableEnded || res.destroyed) return;
      if (running) proxyRequest(req, res, true);
      else {
        if (DSH_UPSTREAM_AUTH_OK === false) { serveDshAuthUnavailable(req, res); return; }
        if (handleMissingDsh(req, res)) return;
        ensureDshRunning().catch(err => log(`DSH startup failed: ${err.message}`));
        const lang = pageLanguage(req, res);
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(dshStartingPage(req, lang));
      }
    }).catch(() => { if (!res.headersSent) serveLauncherPage(req, res, 503, 'dsh'); else res.end(); });
    return;
  }
  const lazyOriginalUrl = dshLazyImageStore.originalModuleUrl(req.url);
  const headers = buildUpstreamHeaders(req);

  // API 调用也算「在干活」，用于判断这一轮什么时候结束
  if (String(req.url).startsWith('/api')) markActivity();

  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: lazyOriginalUrl || req.url,
      headers
    },
    (up) => {
      const contentType = String(up.headers['content-type'] || '');
      const isHtml = contentType.includes('text/html');

      if (!isHtml) {
        if (lazyOriginalUrl && req.method === 'GET' && up.statusCode === 200) {
          proxyLazyDshModule(req, res, up, lazyOriginalUrl);
          return;
        }
        // 其余一律流式转发：SSE、文件下载、大响应体都靠这条路径。
        // 排查「页面能打开但读不到数据」时，/api 下的请求是第一手证据，
        // 所以这里无论成败都记一笔。
        if (up.statusCode >= 400 || String(req.url).startsWith('/api')) {
          log(`${up.statusCode} ${req.method} ${String(req.url).slice(0, 140)}`);
        }
        res.writeHead(up.statusCode, cacheableAssetHeaders(req, up));
        up.pipe(res);
        return;
      }

      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        let raw = Buffer.concat(chunks);

        // 万一上游还是压了（比如某个非文档请求意外返回了 HTML），先解开再改写 ——
        // 把 gzip 字节当成 utf8 去 replace，写出的是一个彻底坏掉的页面。
        const upstreamEnc = String(up.headers['content-encoding'] || '').toLowerCase();
        if (upstreamEnc) {
          try {
            raw = upstreamEnc.includes('br') ? zlib.brotliDecompressSync(raw) : zlib.gunzipSync(raw);
          } catch (err) {
            // 解不开就原样转发：和上游保持一致，绝不因为解压把本来能用的响应弄坏
            if (!res.headersSent) res.writeHead(up.statusCode, up.headers);
            res.end(raw);
            return;
          }
        }

        let body = raw.toString('utf8');

        // 注入几段脚本：
        //   全部以普通 script 同步注入，赶在 DSH 的 module script 之前：
        //     first-load.js 「第一次打开会比较慢，别刷新」—— 排在**最前面**，
        //                   它要在使用者开始怀疑「是不是坏了」之前就把话说出来
        //     polyfill.js  Iterator（Safari 18.4 才有）
        //     compat.js    AbortSignal.any 等较新的 Web API（Safari 17.4 才有）
        //     route.js     连接路径角标与断线自救（唯一会碰 DOM 的一个）
        //     boot.js      service worker 注册与通知订阅，放最后、延后执行即可
        if (!body.includes('/polyfill.js')) {
          // 告诉页面「服务端到底配没配加密密钥」。
          //
          // 为什么非要知道这个：加密是三态的 ——
          //   没配密钥         → 明文，这是设计如此，没什么可说的
          //   配了密钥但没带 #k= → 明文，这是**意外**，使用者以为加密了其实没有
          // 光看 __dshE2eeOn 分不出后两种。分不出来就没法在界面上给正确的提示，
          // 只能要么一直不提示（漏报），要么一直提示（狼来了）。
          let e2eeConfigured = false;
          try { e2eeConfigured = !!e2eeBridge.readSecret(); } catch (err) { }
          body = body.replace(
            /<head([^>]*)>/i,
            '<head$1><script>window.__dshE2eeConfigured=' + (e2eeConfigured ? 'true' : 'false') + ';' +
        // ★ 标一下「这一页是 DSH 应用页，不是我们自己那个页面」。
        //
        //   为什么需要：语言这件事上，我们自己那套（i18n.js 的 localStorage 选择）
        //   和 DSH 自己那套（它读 navigator.languages，另有它自己的设置项）是**两套**。
        //   在 DSH 这一页上切语言必须多做两件事 —— 把选择写成 cookie（服务端直出的
        //   页面跟着走），以及重载一次让 DSH 用它那边的语言重新启动。
        //   在 codex / go / console 那几页上则不该重载。所以要有个明确的标记，
        //   而不是靠猜（比如猜页面上有没有某个 DOM）。
        'window.__dshGwEmbedded=true;window.__POCKET_BRIDGE_DSH__=' +
        JSON.stringify(dshRuntime.serializeRuntime(dshRuntime.peekRuntime())).replace(/</g, '\\u003c') + ';</script>' +
            '<script src="/first-load.js"></script>' +
            '<script src="/polyfill.js"></script>' +
            '<script src="/i18n.js"></script>' +
            '<script src="/compat.js"></script>' +
            '<script src="/e2ee.js"></script>' +
            '<script src="/dsh-directory-picker.js"></script>' +
            '<script src="/voice.js"></script>' +
            '<script src="/route.js"></script>' +
            '<script src="/dsh-lite-switch.js"></script>' +
            // custom.css 放在最后 —— 它是覆盖层，必须在所有内置样式之后
            // manifest / 图标：DSH 自己的页面没有这几行，手机把这一页
            // 「添加到主屏幕」时 iOS 只能去探测 /apple-touch-icon-120x120.png，
            // 404，图标是空的。带上它就正常了。
                        '<link rel="icon" href="/icon-192.png">' +
            '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
            '<link rel="stylesheet" href="/custom.css">' +
            '<script src="/boot.js" defer></script>' +
            '<script src="/custom.js" defer></script>'
          );
        }

        // ★ 剥掉 DSH 自己那个 `<link rel="manifest">`。
        //
        //   为什么非剥不可：manifest 里的 `start_url` 会**覆盖**「添加到主屏幕」
        //   存下来的地址（这个项目实测过：上一版 start_url 是 "/"，图标里存下的
        //   就是 "/" 而不是当时那条 `/k/<密钥>#k=<加密密钥>`）。而地址一旦不含
        //   密钥，主屏 App 就永远是 403 白屏 —— 使用者反复反映的
        //   「保存到屏幕后无法打开」有两层原因，这是第二层（第一层是选目标那次
        //   302，已经改成就地服务）。
        //
        //   为什么不能用 manifest 解决：`start_url` 想带上密钥就只能写成
        //   `/k/<访问密钥>#k=<加密密钥>`，而这个文件是**免认证**就能取的
        //   （iOS 在添加图标时会自己去拉）—— 等于把钥匙发给任何来拿的人。
        //   所以正确的方向只有一个：**让图标存下当时那条自带认证的地址**，
        //   也就是别让 manifest 插手地址。
        //
        //   代价（如实写在这儿）：安卓那边会因此少一个「安装应用」提示，
        //   iOS 上图标以 Safari 标签页打开而不是独立 App 窗口。两者都换得来 ——
        //   独立窗口看着更像 App，但它的 cookie 存储和 Safari 是**两套**，
        //   而标签页模式反而和 Safari 共用登录状态，图标更容易直接可用。
        if (/<link[^>]+rel=["']?manifest/i.test(body)) {
          body = body.replace(/<link[^>]+rel=["']?manifest[^>]*>/gi, '');
          log('已剥掉页面里的 manifest 链接（它会让主屏图标存成 / ，永远打不开）');
        }

        // ★ 把 DSH 的 `<base href="./">` 归一到根路径。
        //
        //   为什么非改不可：这一页现在会**就地**在 `/k/<访问密钥>` 这条路径上返回
        //   （这是有意的 —— 主屏图标因此能自己带密钥、自己换 cookie，见上面那段）。
        //   而 DSH 的 HTML 里写的是 `<base href="./">`，在 `/k/<密钥>` 这个
        //   **没有结尾斜杠**的路径上，`./assets/index-xxx.js` 会被浏览器解析成
        //   `/k/assets/index-xxx.js` —— 全部 404：
        //     404 GET /k/assets/index-Q6zc2uHV.js     ← 应用主包
        //     404 GET /k/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=…
        //   JS 主包拿不到，页面就永远停在 first-load 那条横幅上（手机上实测就是这个现象）。
        //
        //   改成 "/" 之后，无论这一页是从 "/" 还是从 "/k/<密钥>" 打开的，相对路径
        //   都落在根上 —— 而在 "/" 上这一步本来就是等价的，不改动原行为。
        //   只在值确实是相对写法（`./` / `.` / 空）时才动，DSH 万一换成别的基址不会被我们覆盖。
        if (/<base\b[^>]*\bhref=(["'])(?:\.\/?)?\1/i.test(body)) {
          body = body.replace(/(<base\b[^>]*\bhref=)(["'])(?:\.\/?)?\2/i, '$1$2/$2');
          log('已把页面 base 归一到根路径（/k/<密钥> 上的相对资源才解析得到）');
        }

        // 只为已校验的 DSH rc.2 模块加新缓存键：旧手机缓存中同 rev 的未裁图
        // 代码不能冒充新响应。其它版本的 HTML 保持原样。
        body = dshLazyImageStore.rewriteKnownHtml(body);

        // 改完之后按客户端支持的方式重新压一遍 —— 和 servePwa / codex.html
        // 用的是同一套判断（brotli 优先，太小就不压，压不了就原样发）。
        //
        // 为什么值得多做这一步：HTML 明文 33.9 KB，gzip 后 5.7 KB。
        // 现在它是「明文取回来改写、改完再压给手机」，改写能力和体积两头都不丢。
        const accepts = String((req.headers && req.headers['accept-encoding']) || '');
        let out = Buffer.from(body, 'utf8');
        let outEnc = null;
        if (/\bbr\b/.test(accepts)) outEnc = 'br';
        else if (/\bgzip\b/.test(accepts)) outEnc = 'gzip';
        if (outEnc && out.length > 512) {
          try {
            out = outEnc === 'br' ? zlib.brotliCompressSync(out) : zlib.gzipSync(out, { level: 6 });
          } catch (err) {
            out = Buffer.from(body, 'utf8');   // 压不了就原样发
            outEnc = null;
          }
        }

        const outHeaders = Object.assign({}, up.headers);
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = out.length;
        // ★ 首页这一份**不能被缓存**。
        //
        //   它每读一次都要被改写（注入脚本、剥 manifest、归一 base），而且 DSH
        //   升级之后它引用的资源哈希会整批换掉。DSH 自己不发 cache-control，
        //   浏览器于是按启发式规则缓存它 —— 后果是「改了却看不到效果」：
        //   手机上刷新仍然是旧文档，仍然指着已经 404 的旧哈希。
        //   （这正是 /k/<密钥> 白屏那个修复必须配的一步：不 no-store 的话，
        //     已经缓存了坏文档的手机刷新也不会变好。）
        //   它压缩后只有 3.8 KB，每次重取的成本可以忽略；资源本身该缓存照旧缓存。
        outHeaders['cache-control'] = 'no-store';
        if (outEnc) {
          outHeaders['content-encoding'] = outEnc;
          // 告诉中间层和浏览器：这个响应随 accept-encoding 变。
          outHeaders['vary'] = 'Accept-Encoding';
        }

        res.writeHead(up.statusCode, outHeaders);
        res.end(out);
      });
    }
  );

  upstream.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      // 端口没人监听有两种可能，必须先分清：
      //   a) DSH 真的没开 → 把它拉起来
      //   b) DSH 开着，但**换了端口**（重启后端口会变）→ 跟上它就行
      //
      // 原来只有 (a)：一旦 DSH 自己重启换了端口，网关还拿着旧端口去连，
      // 判定「DSH 没运行」→ 又去启动一个 → 屏幕上一直转圈，手机就是连不上。
      // 使用者反馈的「重启后连不上」就是这个。
      const before = TARGET_PORT;
      const moved = refreshDshPort();
      if (moved && moved !== before) {
        log(`DSH 换了端口 ${before} → ${moved}，让浏览器重试`);
        if (!res.headersSent) {
          // 让浏览器立刻按同一个地址重来一次 —— 它会打到新端口上。
          // 比返回一个错误页好：使用者什么都不用做。
          res.writeHead(307, { location: req.url, 'cache-control': 'no-store' });
          res.end();
        } else {
          res.end();
        }
        return;
      }

      // No executable means no possible auto-start: do not send a refresh loop.
      if (handleMissingDsh(req, res)) return;

      log(`DSH 未运行（${req.method} ${String(req.url).slice(0, 80)}），触发自动启动`);
      ensureDshRunning().then((ok) => {
        log(ok ? 'DSH 已就绪，刷新页面即可使用' : 'DSH 自动启动未成功');
      });
      if (!res.headersSent) {
        // 语言要在 writeHead 之前定（它会往待种 cookie 队列里塞「记住这个语言」）
        const lang = pageLanguage(req, res);
        res.writeHead(503, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(dshStartingPage(req, lang));
      } else {
        res.end();
      }
      return;
    }

    log(`反代失败 ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`upstream error: ${err.message}`);
    } else {
      res.end();
    }
  });

  // ── 带正文的 DSH 请求：客户端加密过就先解开，再转给 DSH ─────────────────────
  //
  // ★ 为什么必须做（2026-09-24 查出来的缺口）：DSH 自己的 HTTP API 是**明文**的，
  //   而它传的恰恰是使用者打出去的字 —— `POST /api/session/prompt` 的请求体就是
  //   `content:[{type:'text',text:…}]`（粘贴的图片是 base64 也在里面）。
  //   这一路不加密的话，「隧道看不到用户发出去的消息」这条底线就不成立
  //   （不需要主动攻击，正常转发就能看到）。
  //
  // 为什么只挑这几条：客户端那边的补丁只覆盖「带使用者正文」的端点
  // （见 pwa/e2ee.js 的 CONTENT_API_PATHS）。其余 /api/** 不动 ——
  // 里面有 SSE 长连接，动它们会把界面弄坏。
  //
  // 为什么是「客户端要求才解」而不是「必须加密」：老客户端（手机还加载着旧
  // e2ee.js）发的仍是明文，硬拦会把人挡在门外。所以先做成机会式：
  // 带了标记就解，没带就照旧转发 —— 两边都能用，不制造新的连不上。
  const wantsE2eeBody = req.headers['x-dsh-e2ee'] === '1' &&
    String(req.headers['content-type'] || '').includes('octet-stream');
  if (wantsE2eeBody) {
    const chunks2 = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_E2EE_BODY) { tooBig = true; return; }
      chunks2.push(c);
    });
    req.on('end', () => {
      if (tooBig) {
        log(`请求体超过 ${Math.round(MAX_E2EE_BODY / 1048576)}MB，拒绝转发（不降级发明文）`);
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('request too large');
        return;
      }
      const raw = Buffer.concat(chunks2);
      const secret = e2eeSecretOrNull();
      let plain = null;
      if (secret && raw.length) {
        for (const k of e2ee.candidateKeys(secret)) {
          plain = e2ee.decrypt(k.a, raw);
          if (plain) break;
        }
      }
      if (!plain) {
        // 解不开**不能**把密文转给 DSH（它会当成坏 JSON，而使用者看到的是一句
        // 莫名其妙的解析错误）。明确回 400，并把「没见过这把钥匙」记进日志。
        log(`/api 加密请求解不开（密文 ${raw.length} 字节）—— 没有转发`);
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('this request could not be decrypted; nothing was forwarded');
        return;
      }
      // 换成明文 + 原始 content-type 再转发（DSH 那边完全不知道有加密这回事）
      //
      // ★ 必须用 upstream.setHeader：上面的 `headers` 对象在 http.request()
      //   那一刻就已经被拷进去了，之后改它**没有任何效果**（这是个很容易踩的坑：
      //   改了、看着像对的、实际发出去的还是旧的）。
      const origType = req.headers['x-dsh-e2ee-type'] || 'application/json; charset=utf-8';
      upstream.removeHeader('x-dsh-e2ee');
      upstream.removeHeader('x-dsh-e2ee-type');
      upstream.setHeader('content-type', origType);
      upstream.setHeader('content-length', String(plain.length));
      log(`/api 加密请求：解开成功（密文 ${raw.length} → 明文 ${plain.length} 字节）→ ${req.method} ${String(req.url).slice(0, 60)}`);
      upstream.end(plain);
    });
    return;
  }

  req.pipe(upstream);
}

// ── HTTP 服务 ─────────────────────────────────────────────────────────────────
//
// 处理函数单独抽出来，是为了让明文和 HTTPS 两个监听器共用同一套逻辑 ——
// 内网 HTTPS 开启时，同一份代码会挂在两个端口上。复制一份的话，
// 以后改了一边忘了另一边，就会出现「https 那条路少了某个端点」这种难查的问题。
// ── 内容通道的「经中继不许明文」闸门 ─────────────────────────────────────────
//
// 使用者定的安全底线只有一句话：**隧道不能看到收发的信息**。
//
// 而这里原来是「客户端要加密才加密」—— 换句话说，冒充者只要不明说支持加密，
// 网关就照发明文。代码里早把这条记成「当前最大的安全缺口」，当时没敢改，
// 因为它同时会废掉所有没带 #k= 的客户端（实测：browser-check 83 通过 → 43 并超时）。
//
// 现在反过来：电脑上有长期密钥、请求又是**从中继进来**的，那内容通道必须加密，
// 不加密就直接拒绝 —— 而不是降级发明文。这就是计划 D 要的「失败拒绝而非明文回退」。
//
// 为什么只拦中继：这条底线针对的就是中继。本机控制台和测试脚手架都在这台机器上、
// 不出门，拦了只会把能用的东西弄坏。内网明文另有 :8081 的 HTTPS 那条路。
//
// 客户端怎么表示「我加密」：页面用 #k= 拿钥匙（片段不会发给服务端），
// e2ee.js 会给 WS 地址补 e2ee=1；HTTP 通道用自己的 ?e2ee=1。

/**
 * 这次请求是不是**可能经过中继**进来的？
 *
 * 公网中继常通过回环连接本机，且不一定有 Cloudflare 专属头。
 * 来源判定统一交给 request-origin.js，非本机 Host 一律走严格路径。
 */
function viaRelay(req) {
  return requestOrigin.viaRelay(req);
}

/** Return a usable content key, or null without exposing storage errors. */
function e2eeSecretOrNull() {
  try {
    const secret = e2eeBridge.readSecret();
    return typeof secret === 'string' && secret.length >= 16 ? secret : null;
  } catch (err) { return null; }
}

/** A lost key must never turn a protected remote request into plaintext. */
function refuseEncryptionUnavailable(res) {
  res.writeHead(503, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify({ ok: false, code: 'encryption-unavailable',
    message: 'Encrypted content is temporarily unavailable. Check the computer gateway and retry.' }));
}

function refuseEncryptionUnavailableUpgrade(socket) {
  let response = '';
  refuseEncryptionUnavailable({
    writeHead(status, headers) {
      response = `HTTP/1.1 ${status} Service Unavailable\r\nConnection: close\r\n`;
      for (const [name, value] of Object.entries(headers)) response += `${name}: ${value}\r\n`;
    },
    end(body) {
      socket.end(response + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` + body);
    }
  });
}

const PLAINTEXT_REFUSED = {
  zh: {
    head: '这条通道必须加密，这次没有加密，所以被拒绝了',
    body: '明文不会发给中继。这不是出错，是这道闸门在按你定的规矩办事。',
    how: '回电脑上的控制台，点「复制连接地址」，用它重新打开一次并存成书签。地址里 # 后面那段就是钥匙，别删。'
  },
  en: {
    head: 'This channel must be encrypted, and this request was not, so it was refused',
    body: 'Plaintext is never handed to the relay. Nothing is broken — this gate is doing exactly what you asked it to.',
    how: 'Go back to the console on your computer, tap "Copy connection address", open it once on your phone and save it as a bookmark. The part after # in the address is the key — do not remove it.'
  },
  es: {
    head: 'Este canal debe ir cifrado y esta petición no lo iba, así que se rechazó',
    body: 'El texto sin cifrar nunca se entrega al repetidor. No hay ningún fallo: esta puerta hace justo lo que pediste.',
    how: 'Vuelve a la consola del ordenador, pulsa «Copiar dirección de conexión», ábrela una vez en el teléfono y guárdala como marcador. La parte después de # es la clave: no la borres.'
  }
};

/** 回一个「明文被拒」的页面。返回后调用方直接 return。 */
function refusePlaintext(req, res, what) {
  let lang = 'zh';
  try { lang = pickLang(req) || 'zh'; } catch (err) { }
  const m = PLAINTEXT_REFUSED[lang] || PLAINTEXT_REFUSED.zh;
  log(`拒绝明文（${what}）：经中继但没要求加密`);
  const html = '<!doctype html><html lang="' + lang + '"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + m.head + '</title>' +
    '<style>body{margin:0;background:#0c0d11;color:#e8eaf0;font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.w{max-width:34em;margin:0 auto;padding:14vh 22px}' +
    'h1{font-size:19px;line-height:1.5;margin:0 0 14px;font-weight:600}' +
    'p{color:#9aa1b1;margin:0 0 12px}.k{color:#e8eaf0}</style>' +
    '<div class="w"><h1>' + m.head + '</h1><p>' + m.body + '</p>' +
    '<p class="k">' + m.how + '</p></div></html>';
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

/** 客户端这次有没有要求加密？两种约定都认。 */
function clientWantsE2ee(req, u) {
  // The original DSH /api proxy decrypts a request body only when both the
  // marker and binary envelope are present. A bare ?e2ee=1 must not pass the
  // relay gate for these POSTs: it would then reach req.pipe(upstream) as
  // plaintext while the tunnel had already seen the prompt or file bytes.
  if (u.pathname === '/api/session/prompt' || u.pathname === '/api/session/uploadFileBinary') {
    return req.headers['x-dsh-e2ee'] === '1' &&
      String(req.headers['content-type'] || '').includes('octet-stream');
  }
  if (u.searchParams.get('e2ee') === '1') return true;      // 文件/WS 那套：加在地址上
  if (req.headers['x-dsh-e2ee'] === '1') return true;        // 请求体信封那套：加在头上
  return false;
}

/** 携带使用者正文、经中继时必须加密的通道 */
const E2EE_CONTENT_PATHS = new Set([
  '/__dsh/directories', // 手机选择电脑目录（请求路径与目录名加密）
  '/__dsh/lite-rpc', // 轻量 DSH：项目路径、发送内容和交互应答
  '/__dsh/lite-upload', // 轻量 DSH：绑定会话的附件字节与回执
  '/__dsh/lite-download', // 轻量 DSH：限定会话工作区内的文件下载
  '/__dsh/lite-files', // 轻量 DSH：限定会话工作区内的单层文件列表
  '/__dsh/lite-attachment', // Verified session attachment IDs; encrypted image bytes, never raw paths
  '/__dsh/screen-shot', // 抓电脑屏幕给手机看 —— 画面本身就是敏感内容，必须加密
  '/__dsh/legacy-rpc', // 旧版 DSH：仅已验证的点号 RPC，密文包裹
  '/__dsh/legacy-interactions', // Official legacy pending requests, never raw SSE to the phone
  '/__dsh/legacy-response', // Responses bound to an observed, still-pending Session/rpcId
  '/__dsh/legacy-upload', // In-memory, session/runtime-bound raster image receipts
  // 原版 DSH 界面也能发提示词和附件。旧版脚本的加密失败回退
  // 可能重新发明文；经中继时必须在网关拒绝这种回退。
  '/api/session/prompt',
  '/api/session/uploadFileBinary',
  // C17 地址面板。回的是**访问密钥所在的地址**，所以和上面那些一样必须加密：
  // 控制台能明文拿到它是因为它只认回环，手机这条走中继。
  '/__dsh/lite-addresses'
]);

// 加密请求体的上限。上传那边的业务上限是 20MB，密文多 28 字节，
// 留够余量；主要目的是别让人用一个超大请求把内存吃光。
const MAX_E2EE_BODY = 64 * 1024 * 1024;

/**
 * 把响应体加密回去。
 *
 * 两个细节容易踩：
 *   1. **writeHead 要推迟**。原处理器是先 writeHead 再 end，而长度只有到 end
 *      才知道（密文比明文长 28 字节）。先发头的话长度就对不上，只能靠 chunked，
 *      而且加密一旦失败就来不及改成错误码了。所以这里把头存下来，等 end 一起发。
 *   2. 原始 content-type 要**存进 x-dsh-e2ee-type**，客户端的
 *      installFetchDecrypt 靠它把类型还原回去（否则 json 解不出来）。
 */
function wrapEncryptedResponse(res, secret) {
  const origWriteHead = res.writeHead.bind(res);
  const origEnd = res.end.bind(res);
  let pending = null;

  res.writeHead = function (code, a, b) {
    const headers = (a && typeof a === 'object') ? a : ((b && typeof b === 'object') ? b : {});
    pending = { code, headers: Object.assign({}, headers) };
    return res;                     // 先不回话，等 end 时连密文一起发
  };

  res.end = function (body, enc, cb) {
    const p = pending || { code: 200, headers: {} };
    const type = p.headers['content-type'] || res.getHeader('content-type') ||
      'application/json; charset=utf-8';
    const buf = body == null ? Buffer.alloc(0)
      : Buffer.isBuffer(body) ? body
        : Buffer.from(String(body), typeof enc === 'string' ? enc : 'utf8');

    let ct = null;
    try { ct = e2ee.encrypt(e2ee.deriveKeys(secret, e2ee.slotAt()).b, buf); }
    catch (err) { log(`响应加密失败，本次不发送（不降级明文）: ${err.message}`); }

    if (!ct) {
      // 宁可这次什么都没有，也不能把明文发出去 —— 客户端要的是密文。
      try { res.destroy(); } catch (err) { }
      return;
    }

    const headers = Object.assign({}, p.headers);
    delete headers['content-length'];
    headers['content-type'] = 'application/octet-stream';
    headers['x-dsh-e2ee'] = '1';
    headers['x-dsh-e2ee-type'] = type;
    headers['cache-control'] = 'no-store';
    origWriteHead(p.code, headers);
    return origEnd(ct, enc, cb);
  };
  return res;
}

/**
 * 给一个 HTTP 处理器套上端到端加密（请求体解开、响应体加密）。
 *
 * 为什么套在外面而不是改处理器内部：队列和上传这两个处理器完全不关心加密，
 * 它们只认 req/res。加解密放在外面有三个好处 ——
 *   1. 它们一行都不用改，也就不会改坏（上传那 20MB 的分片限流逻辑很细）；
 *   2. 每条通道的加密行为**天然一致**，不会出现「队列加了、上传忘了」；
 *   3. 客户端响应方向也不用改：e2ee.js 的 installFetchDecrypt 已经会自动
 *      解开带 x-dsh-e2ee 的响应，还带跨时间段的密钥重试。
 */
function e2eeWrap(handler, options) {
  options = options || {};
  return function (req, res) {
    const secret = e2eeSecretOrNull();
    // ★ 判据必须和闸门**共用同一个函数**。
    //
    //   闸门（handleRequest 里那道「经中继 + 配了密钥 + 没要求加密 → 403」）
    //   认「?e2ee=1 或 x-dsh-e2ee:1」两种写法，而这里原来只认请求头。
    //   于是带 ?e2ee=1 的请求**过了闸门、却按明文返回** —— 中间谁都不报错。
    //   偏偏这道门防的就是中继本身：它加个 ?e2ee=1 重放一次就能读到明文。
    //   实测：经中继 GET /codex/threads?e2ee=1 → 200 + JSON + 真实会话标题。
    let wants = false;
    try { wants = clientWantsE2ee(req, new URL(req.url, 'http://localhost')); } catch (err) { wants = false; }
    // The entry gate marks protected relay requests in process, never through
    // a client header. Recheck if the key was removed after that gate ran.
    if (!secret && req.__dshRequireE2ee === true) return refuseEncryptionUnavailable(res);
    if (!secret || !wants) return handler(req, res);

    let finished = false;
    const bail = (why, code) => {
      if (finished) return; finished = true;
      log(`加密通道没能解开请求（${req.url}）：${why}`);
      try {
        if (!res.headersSent) {
          const refusalCode = typeof code === 'string' && /^(?:replayed-request|replay-[a-z-]+|encrypted-body-required)$/.test(code) ? code : 'decryption-failed';
          const replayed = refusalCode === 'replayed-request';
          res.writeHead(replayed ? 409 : refusalCode.startsWith('replay-') ? 503 : 400,
            { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, code: refusalCode, attemptDispatched: false,
            // Unavailable storage cannot prove that a prior copy was unsent.
            originalOutcomeUnknown: replayed || refusalCode.startsWith('replay-'),
            message: replayed ? 'This encrypted request was already received and was not forwarded again. Check the current task before sending a new command.' :
              'This request was not forwarded. Encrypted admission is unavailable; check the computer bridge before retrying.' }));
        } else { res.destroy(); }
      } catch (err) { try { res.destroy(); } catch (e) { } }
    };

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      if (finished) return;
      size += c.length;
      if (size > MAX_E2EE_BODY) { bail(`请求体超过 ${Math.round(MAX_E2EE_BODY / 1048576)}MB`); try { req.destroy(); } catch (e) { } return; }
      chunks.push(c);
    });
    req.on('error', () => bail('读取请求体出错'));
    req.on('end', () => {
      if (finished) return;
      let plain = null;
      try {
        const raw = Buffer.concat(chunks);
        // 空请求体是**正常情况**，不是解不开：GET/HEAD 按规范不能带 body，
        // 而客户端仍然要表明「这次响应请加密」。这时候只需要加密响应，
        // 没有东西要解 —— 当成解不开回 400 的话，只读的几条通道就全废了。
        if (raw.length === 0) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return bail('缺少加密请求体', 'encrypted-body-required');
          plain = Buffer.alloc(0);
        } else {
          const admitted = e2ee.openIncoming(secret, raw);
          if (!admitted.ok) return bail('加密请求未获准', admitted.code);
          plain = admitted.plain;
        }
      } catch (err) { plain = null; }
      if (!plain) return bail('解不开（密钥不匹配或密文损坏）');

      finished = true;
      // 把解开后的明文做成一个可读流交给原处理器，其余属性照抄。
      // （处理器读的是 req.method / req.url / req.headers / 事件流。）
      const shim = new Readable({ read() { } });
      shim.push(plain);
      shim.push(null);
      shim.method = req.method;
      shim.url = req.url;
      shim.headers = Object.assign({}, req.headers, {
        'content-length': String(plain.length),
        'content-type': req.headers['x-dsh-e2ee-type'] || 'application/json; charset=utf-8'
      });
      // Only this in-process shim can carry successful decryption proof. A
      // client-supplied header alone must never authorize the Lite file routes.
      shim.__dshE2eeDecrypted = true;
      shim.__dshRequireE2ee = req.__dshRequireE2ee === true;
      shim.socket = req.socket;
      privateHttpsAdmission.inheritRemote(req, shim);
      shim.setTimeout = function () { return shim; };
      if (!options.responseEncryptedByHandler) wrapEncryptedResponse(res, secret);
      handler(shim, res);
    });
    req.resume();
  };
}

function serveDshAuthUnavailable(req, res) {
  const lang = pageLanguage(req, res);
  const messages = {
    zh: '检测到了 DSH，但尚未验证它的网页授权。请先打开并登录 DSH 桌面版或 Web 版，再重新检查。',
    en: 'DSH was found, but its web authorization is not ready. Open and sign in to DSH desktop or Web, then check again.',
    es: 'Se encontró DSH, pero su autorización web no está lista. Abre e inicia sesión en DSH de escritorio o Web y vuelve a comprobar.'
  };
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  const html = launcherPage(req, lang).replace('<body>', '<body><p style="padding:16px;line-height:1.6">' + (messages[lang] || messages.en) + '</p>');
  res.end(injectProofAssets(html));
}

function serveLauncherPage(req, res, statusCode = 200, missingTarget = null) {
  // Language selection can queue a cookie, so it must precede writeHead.
  const lang = pageLanguage(req, res);
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  // The selector calls /__targets, which needs the same device proof as other content.
  res.end(injectProofAssets(launcherPage(req, lang, missingTarget)));
}

function handleMissingDsh(req, res) {
  if (findDshExe()) return false;
  if (!res.headersSent) serveLauncherPage(req, res, 503, 'dsh');
  else res.end();
  return true;
}



// This page has no user content until an authenticated, encrypted Connect POST.


/**
 * 每一次 HTTP 请求的入口。
 *
 * ★ 为什么要拆成两层：第三道门（挑战应答）需要「等一等证明再决定」——
 *   而等待不能靠 sleep（会把整个 event loop 卡住），只能先 return、
 *   过一会儿**把同一个请求重新走一遍**。于是真正干活的是 handleRequestInner，
 *   它多带一个 deadline 参数，重入时把门的判断再算一次。
 *
 *   重入是安全的：前面那些门（cookie、设备令牌）都是幂等的
 *   —— 设备已经登记过，再走一遍只是又确认一次；cookie 合并器也不怕重复安装。
 */
function handleRequest(req, res) {
  if (retiredTargets.isRetiredRequest(req.url)) return retiredTargets.replyHttp(req, res);
  return handleRequestInner(req, res, 0);
}

function handleRequestInner(req, res, proofDeadline) {
  if (privateHttpsAdmission.enforceHttp(req, res, cfg.loadConfig().privateHttps)) return;
  // 先把 cookie 合并器装上，之后无论哪个分支调用 writeHead 都不会丢掉要种的 cookie
  installCookieMerger(res);
  migrateLegacyRequestCookies(req, res);

  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
    return;
  }

  const route = PWA_ROUTES[u.pathname];
  if (route) {
    servePwa(req, res, route);
    return;
  }

  // These files are stock DSH onboarding art, never user content. Their names
  // are complete SHA-256 digests produced only by the verified rc.2 module
  // transform. Serve them like other public static UI assets so a newly opened
  // onboarding screen does not race the proof handshake.
  if (dshLazyImageStore.imageDigestFromPath(u.pathname)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const image = dshLazyImageStore.readImage(DSH_LAZY_IMAGE_DIR, u.pathname);
    if (!image) {
      res.writeHead(404, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': image.length,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : image);
    return;
  }

  // iOS 不认 manifest，它自己去探测 `apple-touch-icon-120x120[-precomposed].png`
  // 这类**带尺寸后缀**的名字。上面那张表是精确名，一个都匹配不上 ——
  // 实测 iPhone 上「添加到主屏幕」就是这么 404 掉的（日志里两条 404，
  // 来自两场真实 iPhone 会话）。这里按模式兜住：`/apple-touch-icon*` 一律交给
  // 同一个文件。免认证静态白名单（isPwaAsset）本来就认这个模式，两边终于一致。
  if (/^\/apple-touch-icon[^/]*\.png$/i.test(u.pathname)) {
    servePwa(req, res, { file: 'apple-touch-icon.png', type: 'image/png' });
    return;
  }

  // ── 内容通道：经中继时必须加密，否则拒绝（不降级）──────────────────────────
  //
  // 放在这么靠前是有意的：这些端点分散在下面几百行里，挨个加判断迟早会漏一个，
  // 而漏掉的那条就是缺口。集中成一张表，加通道只改这张表。
  if (E2EE_CONTENT_PATHS.has(u.pathname) && !isLocalRequest(req)) {
    req.__dshRequireE2ee = true;
    if (!e2eeSecretOrNull()) {
      refuseEncryptionUnavailable(res);
      return;
    }
    if (!clientWantsE2ee(req, u)) {
      refusePlaintext(req, res, u.pathname);
      return;
    }
  }

  // 本机控制台（页面 + 状态 + 操作），全部只允许回环来源
  if (handleConsole(req, res, u)) return;

  // 连通性探针：手机页面用它来判断「这条路现在通不通、有多快」。
  // 不需要认证 —— 它不返回任何内容，只是证明这个地址上有人在监听。
  // 这一点信息量和「端口开着」是同级的，不构成泄露。
  if (u.pathname === '/__probe') {
    res.writeHead(204, {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    res.end();
    return;
  }

  // 健康检查：让启动器能确认「这个端口上的确实是我们这个中间层」，
  // 而不是别的恰好占了端口的程序。只接受回环来源，且不返回敏感信息。
  // ── 挑战应答（白名单机制的第一步）────────────────────────────────────────
  //
  // 要解决的问题：访问密钥写在网址**路径**里 /k/<密钥>，而路径是 HTTP 请求行
  // 的一部分，TLS 在 Cloudflare 那儿就终止了 —— **隧道看得见**。
  // 它把那条请求自己发一遍就拿到一样的登录凭证，然后以你的身份读会话预览、
  // 明文文件、余额。
  //
  // 办法：进门要证明「我知道 # 里那串」，而不是「我知道路径里那串」。
  //   # 里那串隧道**从来没见过**（浏览器根本不发 fragment，实测过）。
  //
  // ★ 这一版是**纯新增**：只加两个接口，**不动任何认证判定**。
  //   现在谁都不会被挡，包括隧道。这么做的原因是 ——
  //   改认证路径出错的代价是"手机当场连不上"，而那时候你人在外面连
  //   控制台都开不了（控制台在电脑上）。所以先观察，确认手机每次都通过，
  //   再谈开不开强制。
  //
  // 落地顺序（写在这里，免得下一轮忘）：
  //   1) 【本次】接口就位，不拦人
  //   2) 手机端 route.js 开始发挑战应答；服务端在日志里记
  //      「如果开启强制，这次会被挡下」—— 跑一阵，看手机是不是每次通过
  //   3) 观察期全绿之后，一个开关切过去
  if (u.pathname === '/__auth/challenge') {
    if (!authRateOk(req)) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '太频繁' }));
      return;
    }
    const nonce = crypto.randomBytes(24).toString('base64url');
    authChallenges.set(nonce, Date.now() + AUTH_CHALLENGE_TTL_MS);
    // ★ 顺手记下「这台设备正在证明」。
    //
    //   第三道门靠它区分两种等待：来取过挑战的（手里有钥匙，值得等它走完
    //   两个来回 —— 慢链路上一个来回好几秒）和压根没来取的（多半没有钥匙，
    //   只等 2.5 秒就拒）。没有这一笔，隧道上就会退化成
    //   「403 → 手机重试 → 再 403」，叠成几十秒。
    try {
      const tok = readDeviceToken(req);
      if (tok) {
        const parts = String(tok).split('.');
        if (parts[0]) proofChallengeAt.set(parts[0], Date.now());
      }
    } catch (err) { /* 记不上不影响取挑战本身 */ }
    // 顺手清掉过期的，免得这张表无限长
    if (authChallenges.size > 500) {
      const now = Date.now();
      for (const [k, exp] of authChallenges) if (now > exp) authChallenges.delete(k);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, nonce, ttlMs: AUTH_CHALLENGE_TTL_MS }));
    return;
  }

  if (u.pathname === '/__auth/verify' && req.method === 'POST') {
    if (!authRateOk(req)) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '太频繁' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (err) { }
      // ★ 两种形式都收（2026-09-27）：
      //   · 带 ts 的「一次往返」：手机自己出随机数和时间戳（隧道上省一个来回）
      //   · 老的「两个来回」：先取挑战再交应答
      //   老形式必须一直留着 —— 手机上可能还跑着旧 e2ee.js，而且新手机在
      //   时钟不对 / 遇上老网关时会自动退回它。少一条路就是把人锁在门外。
      const oneShot = body.ts !== undefined && body.ts !== null;
      const verdict = oneShot
        ? verifyOneShotProof(body.ts, String(body.nonce || ''), String(body.response || ''))
        : verifyAuthResponse(String(body.nonce || ''), String(body.response || ''));
      log(`${oneShot ? '进门证明（一次往返）' : '挑战应答'}: ` +
        `${verdict.ok ? '通过' : '不通过（' + verdict.reason + '）'}` +
        `  来源 ${routes.clientIpOf(req)}`);
      // 通过了就记在这台设备名下 —— 第三道门（观察中）靠它判断谁能进
      if (verdict.ok) {
        try {
          const tok = readDeviceToken(req);
          if (tok) {
            const parts = String(tok).split('.');
            if (parts[0]) {
              // 「第一次转正」和「续证」要分开记 ——
              // 排查时这两件事的意义完全不同：前者是新人进门，后者是页面
              // 到期前自己续了一次（说明自动续证在工作，或者是刚重启过网关）。
              const first = !authProvenAt(parts[0]);
              authProven.set(parts[0], Date.now());
  saveAuthProven();
              authObserved.delete(parts[0]);
              proofWaitHits.delete(parts[0]);      // 证明到了，等过的次数清零
              log(first
                ? `★ 设备 ${parts[0].slice(0, 8)}… 通过挑战应答，内容已开放` +
                  `（有效期 ${Math.round(AUTH_PROVEN_TTL_MS / 3600000)} 小时）`
                : `★ 设备 ${parts[0].slice(0, 8)}… 续证成功，重新计时 ` +
                  `${Math.round(AUTH_PROVEN_TTL_MS / 3600000)} 小时`);
            }
          }
        } catch (err) { /* 记不上不影响验证本身 */ }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      // code 是给手机端看的：带上它才能分清「该退回两个来回」（时钟不对/形式不认识）
      // 和「真的证明不了」（钥匙不对）。没有 code 的老手机看 ok/reason，行为不变。
      res.end(JSON.stringify({
        ok: verdict.ok, reason: verdict.reason || null, code: verdict.code || null
      }));
    });
    return;
  }

  if (u.pathname === '/__health') {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('loopback only');
      return;
    }
    // 顺带告诉调用方 DSH 到底活没活着 —— 启动器和控制台都要这个判断
    portAlive(TARGET_PORT).then((dshAlive) => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({
        service: 'pocket-bridge-gateway',
        instanceId: INSTANCE_ID,
        bootId: GATEWAY_BOOT_ID,
        port: PORT,
        httpsPort: HTTPS_PORT || 0,
        dshPort: TARGET_PORT,
        dshAlive,
        pid: process.pid
      }));
    });
    return;
  }

  // 本地通知入口：DSH 的 hook 干完一轮就打这里。
  //
  // 「本地」不能只看回环：hook 脚本连过来时用的是内网地址，来源就变成 192.168.x.x。
  // 所以判据是「来源是不是这台机器自己的地址」。
  //
  // ★ 但**光看来源地址不够** —— isOwnAddress 完全不看 Host 头。安全审计实测：
  //   使用者在电脑上开着任意一个网页，那个页面只要
  //     fetch('http://<内网IP>:8080/__notify?title=…&body=…')
  //   就能让他的手机弹推送，标题正文还全由那个网页决定（DNS 重绑定同理）。
  //
  //   项目里本来就有更严的那把尺 —— isLocalRequest：来源是本机**并且**
  //   Host 也指向本机自己的地址/回环。使用者正常使用（浏览器开 127.0.0.1:8080
  //   或内网 IP）两条都满足，所以换成它不会误伤任何正常路径。
  //
  //   顺带把这个端点的判定口径和 /__health、/__console/* 统一起来 ——
  //   同一个程序里几套松紧不一的判定，本身就是漏洞的温床。
  if (u.pathname === '/__notify') {
    if (!isLocalRequest(req)) {
      log(`拒绝非本地通知请求，来源 ${req.socket.remoteAddress} Host ${req.headers.host}`);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('loopback only');
      return;
    }

    // 限速：这个端点会真的让手机响。正常一轮任务只该打一次，
    // 打得太密说明要么是 bug 在刷，要么是有人拿着这个端点当玩具。
    if (!notifyRateOk()) {
      log('通知被限速（一分钟内打太多次）');
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '通知太频繁，已限速' }));
      return;
    }

    // 这条路**有**请求上下文，语言直接用请求自己的；
    // 调用方显式传了 title/body 就用它的（那是它自己拼好的文案）。
    const NM = NOTIFY_TEXT[pickLang(req)] || NOTIFY_TEXT.zh;
    const title = u.searchParams.get('title') || NM.doneTitle;
    const body = u.searchParams.get('body') || NM.doneBody;

    pushNotification(title, body)
      .then((results) => {
        const anyOk = results.some((r) => r.ok);
        log(`通知推送 ${anyOk ? '成功' : '未送达'}: ${JSON.stringify(results)}`);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: anyOk, results }));
      })
      .catch((err) => {
        log(`通知推送异常: ${err.message}`);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  // 动态配对码入口：给手机一个比长 URL 好输入得多的方式
  if (u.pathname === '/pair') {
    const code = u.searchParams.get('code');
    // 这一页（以及下面这些提示页）都是服务端直出的：浏览器那边还没有脚本在跑，
    // 所以语言在这一刻就要定下来 —— 见 pickLang。pageLanguage 还会把页面上
    // 手选的语言（?lang=）记进 cookie。
    const lang = pageLanguage(req, res);
    const activePairCode = currentPairCode();
    if (!activePairCode) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(noticePage(req, lang, pageText(lang).errors.pairUnavailable));
      return;
    }
    if (code === null) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(pairPage(req, lang));
      return;
    }
    // 限速检查放在最前面：配对码熵很低（6 位数字），必须防枚举。
    //
    // ★ peer 不能用 req.socket.remoteAddress。
    //   隧道流量是 cloudflared 从回环转进来的，那个值**永远是 127.0.0.1** ——
    //   于是所有人的失败次数都记在同一个桶里：
    //     · 外面随便一个人试错 5 次，就把**使用者自己的手机**锁在门外 15 分钟
    //     · 攻击者换个出口就重置了桶，限速对他形同虚设
    //   clientIpOf 会优先取 CF-Connecting-IP（而且只在来源确实是本机时才采信，
    //   见 routes.js），拿到的才是真正的对端。
    const peer = routes.clientIpOf(req) || 'unknown';
    const rate = pairRateCheck(peer);
    if (!rate.allowed) {
      const waitSec = Math.ceil(rate.retryAfterMs / 1000);
      log(`配对被限速：${peer} 还需等待 ${waitSec} 秒`);
      res.writeHead(429, {
        'content-type': 'text/html; charset=utf-8',
        'retry-after': String(waitSec)
      });
      res.end(noticePage(req, lang, pageText(lang).errors.tooMany));
      return;
    }

    // 时间无关比较 —— 配对码只有 6 位数字，用 `===` 比较会随匹配前缀长度
    // 产生可测量的时间差，理论上能一位一位试出来。票据兑换那边一直用的是
    // 时间无关比较，这里漏了。
    if (safeEqualStr(code, activePairCode)) {
      pairClearFailures(peer);
      const cookies = (isLocalRequest(req) || isSelfCheck(req) || isSelfClientRequest(req))
        ? [SET_COOKIE_VALUE]
        : (() => {
          const made = sessions.create({
            ua: req.headers['user-agent'],
            ip: routes.clientIpOf(req),
            authority: String(req.headers.host || '')
          });
          log(`配对成功，登记设备「${made.device.label}」${made.device.id}`);
          return authCookies(made.token);
        })();

      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': cookies,
        'cache-control': 'no-store'
      });
      res.end(enterPage(req, lang));
      return;
    }
    pairRecordFailure(peer);
    log(`配对失败，收到 code=${code}`);
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
    res.end(noticePage(req, lang, pageText(lang).errors.wrongCode));
    return;
  }

  // 换路径票据入口：手机从一条路切到另一条路时走这里。
  // 放在密钥校验之前 —— 它本身就是一次认证（票据即凭证）。
  if (u.pathname.startsWith('/t/')) {
    const authority = String(req.headers.host || '');
    const lang = pageLanguage(req, res);
    const r = redeemTicket(u.pathname.slice(3), authority);
    if (!r.ok) {
      log(`换路径票据被拒: ${r.reason}`);
      // 「一分钟」是原来写死的，现在有两档有效期（换路径 60 秒 / 恢复 24 小时），
      // 写死会误导 —— 恢复票据的失败原因和换路径完全不同，得分开讲。
      const isRecover = /过期/.test(r.reason);
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(ticketErrorPage(req, lang, r.reason, isRecover));
      return;
    }
    // 换路径：沿用原来那台设备的身份，没带就当场登记一个新的
    let ticketToken = null;
    if (r.deviceId) {
      const db = sessions.list().find((d) => d.id === r.deviceId);
      if (db) ticketToken = sessions.reissue(r.deviceId, authority);
    }
    log(`换路径成功: ${authority}${r.target ? `（目标 ${r.target}）` : ''}`);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // 连同「在哪个应用里」一起带过去，免得切一次网络就被重问一次「用哪个」
      'set-cookie': r.target
        ? [...authCookies(ticketToken), targetCookie(r.target)]
        : authCookies(ticketToken),
      'cache-control': 'no-store'
    });
    res.end(enterPage(req, lang));
    return;
  }

  // 给「地址变了」的推送申请一枚恢复票据。
  //
  // 只认本机：这个端点会**凭空签发一张能进门的凭证**，如果外面也能调，
  // 那就等于把锁挂在门上还插着钥匙。启动器在本机调它，不需要任何认证 ——
  // 能连上回环就已经证明自己是本机了。
  //
  // 为什么要有这个端点：启动器和中间层是两个进程，票据逻辑（以及 ACCESS_KEY）
  // 都在中间层这边，启动器没法自己算。所以中间层出借一个口子。
  //
  // ★ 它必须待在**认证之前**，和 /t/ 一个区域。
  //   最初我把它放在了 /__switch 旁边（也就是会话 cookie 校验之后），
  //   结果启动器来调时被挡在门外：日志里只有一句
  //   「403 无会话 cookie: GET /__recover」，票据一次都没签出来过，
  //   地址变更推送只能退化成不带凭证的基础地址。
  //   这类错误很隐蔽 —— 端点本身写得没问题，是**它站的位置**不对。
  //   判定「本机」用的是 isLocalRequest，和有没有会话无关。
  if (u.pathname === '/__recover') {
    // 用 isLoopback 而**不是** isLocalRequest。
    //
    // 这两个判定的严格程度不一样：isLocalRequest 认为「本机访问自己的内网地址」
    // 也算本机（那是为 hook 脚本留的口子），而 isLoopback 只认回环。
    // 这个端点凭空签发一张能进门的凭证，必须用最严的那把尺 ——
    // 和 /__health、控制台这些同样敏感的端点保持一致。
    //
    // 只靠 isLocalRequest 实际上也不会漏（真正的手机来源地址不是本机，
    // 照样会被拒），但那是**推理出来的安全**；换成 isLoopback 之后，
    // 无论网络怎么变都不会漏。安全的事不靠推理，靠判定。
    if (!isLoopback(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: '只允许本机调用' }));
      return;
    }
    const tunnel = currentTunnelUrl();
    if (!tunnel) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: '还没有隧道地址' }));
      return;
    }
    let authority = '';
    try { authority = new URL(tunnel).host; } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '隧道地址解析不了' }));
      return;
    }
    // 绑到最近活跃的那台设备上 —— 这样手机恢复后还是原来那台，
    // 设备列表里不会每换一次地址就多出一条。
    let devId = null;
    try {
      // 这里原来写的是 d.lastSeen —— 存储里的字段其实叫 lastSeenAt，
      // 所以比较的是两个 undefined，localeCompare 恒等于 0，**排序是空操作**。
      // 结果碰巧是对的（sessions.list() 本身已经按 lastSeenAt 倒序），
      // 但代码看起来在排序、其实没排 —— 哪天 list() 的排序改了这个就会悄悄选错设备。
      // 直接用 list() 的顺序，并把它写明白，不再假装排一次。
      const list = sessions.list().filter((d) => !d.revokedAt);   // 已按最后出现时间倒序
      if (list.length) devId = list[0].id;
    } catch (err) { /* 没有设备也照样能签，票据会当场登记一台新的 */ }

    const t = mintTicket(authority, devId, null, RECOVER_TTL_MS);
    const url = `${tunnel.replace(/\/+$/, '')}/t/${t}`;
    log(`签发恢复票据 → ${authority}（${RECOVER_TTL_MS / 3600000} 小时内一次性有效，设备 ${devId || '新登记'}）`);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, url, authority, expiresInSec: RECOVER_TTL_MS / 1000 }));
    return;
  }

  if (keyMatches(u)) {
    // 拿着密钥进来的，就是一次完整的认证 —— 给它登记一台设备。
    // 本机（自己打开控制台）和自检不登记，否则设备列表里全是自己。
    const cookies = (isLocalRequest(req) || isSelfCheck(req) || isSelfClientRequest(req))
      // A valid local key login does not use a device identity. Clear a token
      // left by another bridge on this host before redispatch, and in the
      // browser, rather than letting that stale token reject this fresh login.
      ? [SET_COOKIE_VALUE, `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]
      : (() => {
        const made = sessions.create({
          ua: req.headers['user-agent'],
          ip: routes.clientIpOf(req),
          authority: String(req.headers.host || '')
        });
        log(`密钥认证成功，登记设备「${made.device.label}」${made.device.id}`);
        return authCookies(made.token);
      })();

    // ★ 必须用**客户端跳转**，不能用 302。
    //
    //   原来是 302 → '/'，理由是「不想让带密钥的地址在地址栏里停留，被截屏或
    //   被旁边的人瞄到」。那个顾虑是真的，但它赢了功能的代价太大：
    //
    //   **Safari 在 302 跳转时会丢掉 `#` 后面的片段。** 于是 `#k=<加密密钥>`
    //   根本没到页面 —— 徽标显示「未加密」、WS 不带 e2ee=1 被网关拒绝、
    //   对话列表永远是空的，而且每 2 秒重试一次。Chromium 不丢片段，
    //   所以 browser-check 一直是绿的，这个坑只在真机 Safari 上出现。
    //
    //   改成「内联脚本 + 解析阶段就跳」：脚本在浏览器**绘制之前**执行完，
    //   地址栏不会停留（远小于原来担心的 <meta refresh> 那种一两秒），
    //   而 location.hash 是浏览器已经拿到的，能原样带到 '/'。
    // ★ 不跳转 —— 就在 /k/<密钥> 这个地址上把应用服务出来。
    //
    //   原来这一页会跳到 '/'。但 iOS「添加到主屏幕」保存的是**当时的地址**：
    //   一跳转，图标里存下的就是 '/'，没有密钥、也没有那次换 cookie 的机会。
    //   而实测（17:15~17:16）主屏幕 App 与 Safari 用的是**两套完全独立的
    //   cookie 存储** —— 主屏 App 打开 '/' 时一个 cookie 都带不过来，日志里
    //   永远是「403 无会话 cookie: GET /」，而 Safari 那边明明登录着。
    //
    //   留在这个地址上，图标里存下的就是 `/k/<密钥>#k=<加密密钥>` 这条
    //   **自带认证**的地址：点开时自己换 cookie、自己带密钥，不依赖任何已有
    //   登录状态，也不依赖两个上下文是否共享存储。
    //
    //   DSH 前端用的是绝对路径（/api/...、/polyfill.js），所以停在 /k/ 下面
    //   照样能跑 —— 这正是「只动根路径、其余全部反代」那个设计的前提。
    const jar = [].concat(cookies);
    if (res.__pendingCookies) res.__pendingCookies.push(...jar);
    // ★ 必须**同时**用 setHeader 发一次 Set-Cookie。
    //
    //   __pendingCookies 只在「网关自己渲染的页面」那条路上被合并进响应头；
    //   重新分发到 '/' 之后走的是**反代 DSH** 那条路，它不碰这个队列 ——
    //   实测结果是：GET /k/<密钥> 返回 200，但响应里**一个 set-cookie 都没有**。
    //   于是主屏幕 App（它和 Safari 是两套独立存储）永远拿不到 cookie，
    //   下一次请求就是「403 无会话 cookie」—— 图标点开永远是白屏。
    //   直接 setHeader 是兜底：Node 会把它并进最后的响应头，
    //   无论下游走的是哪条路。
    res.setHeader('set-cookie', jar);
    // 把新 cookie 也塞进**请求头**：重新分发时会再过一次认证门，而那道门读的是
    // `req.headers.cookie`，不是响应里待发的 cookie。带上它，这次请求就已经是登录状态。
    // Browser cookies are shared across ports. An old bridge session can thus
    // arrive first under the same name. Replace all matching pairs, including
    // the device token, so redispatch reads the credentials just issued here.
    replaceIssuedRequestCookies(req, jar);
    // ★ 把「这次是从密钥路径进来的」这件事传下去。
    //
    //   下面按根路径重新分发时，地址栏里其实还停在 /k/<密钥>。而「选目标」那一段
    //   原来会 302 跳到 '/' —— 一跳，地址栏里的 /k/<密钥> 就没了。
    //   后果是使用者**在应用里**点「添加到主屏幕」时，图标存下的是 '/'：
    //   主屏 App 与 Safari 是两套独立存储、又没有任何 cookie，点开就是
    //   「403 无会话 cookie: GET /」—— 也就是他说的「保存到屏幕后无法打开」。
    //   实测日志（2026-09-24 21:13）就是这条 `GET /`。
    req.__dshViaKeyPath = true;
    req.url = '/' + (u.search || '');
    return handleRequestInner(req, res, proofDeadline);
  }

  // DSH 的前端静态资源（/assets/**）不要求会话 —— 它们**不含使用者的任何数据**，
  // 只是打包好的 JS/CSS，和我们自己那些 /polyfill.js、/custom.css 同类。
  //
  // 为什么要单独放行：日志里实测到
  //     403 无会话 cookie: GET /assets/vendor-CCJJTK99.js
  // 一个资源被挡，依赖它的那一整块界面就起不来 —— 使用者看到的是「加载半天」。
  // 而这类请求**本来就不该带登录门槛**：它们是代码，不是内容。
  //
  // 安全边界没松：放行的只有 /assets/ 和 /plugins/ 这两段路径，而且只是「转发给 DSH」，
  // 不涉及任何会话、文件、会话列表。真正的内容（/api/**、/codex/**）照旧要两道门。
  //
  // ★ /plugins/ 必须和 /assets/ 一样放行（2026-09-27 实测）：新版 DSH 把全部
  //   客户端插件模块都放在那里（首页引用 71 个），性质完全相同 —— 都是**代码**，
  //   不含使用者的任何数据。
  //
  //   这一条直接对应「刚才还好、现在又不行」这种间歇性故障：**ES 模块的 import
  //   不会重试**。任何一个模块请求撞上这道门（403），整个模块图当场断掉、应用白屏，
  //   而使用者什么都没做错。放行之后，模块加载不再取决于会话 cookie 的时序。
  //
  //   /plugins/events 仍然不放行：那是插件的 HMR 热重载 SSE 通道，手机端不需要它。
  const isStaticAsset = /^\/assets\//.test(u.pathname) ||
    (/^\/plugins\//.test(u.pathname) && !/^\/plugins\/events(\/|$)/.test(u.pathname));
  if (!hasAuthCookie(req) && !isStaticAsset) {
    // ★ 日志要能回答「这是从哪来的、哪个地址、什么设备」。
    //
    //   原来只记路径，于是「主屏图标打不开」这件事只能靠猜：日志里一行
    //   `403 无会话 cookie: GET /`，既不知道 Host 是隧道还是内网，也不知道
    //   是「完全没 cookie」还是「cookie 不对」（换过密钥的旧 cookie 属于后者）。
    //   这三种情况的修法完全不同，所以必须记下来。
    const host = String(req.headers.host || '-');
    const ua = String(req.headers['user-agent'] || '-').slice(0, 70);
    const jar = req.headers.cookie ? '有但没通过' : '完全没有';
    log(`403 无会话 cookie: ${req.method} ${req.url}` +
      `（Host=${host} UA=${ua} cookie=${jar}）`);
    const lang = pageLanguage(req, res);   // 要在 writeHead 之前（见上面 launcher 那段的说明）
    // 浏览器导航（Accept 带 text/html）给一页**能照着修**的说明；
    // 程序调用（/api、/__routes 之类）照旧回纯文本，免得把 JSON 客户端带偏。
    const wantsHtml = /text\/html/i.test(String(req.headers.accept || ''));
    if (wantsHtml) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-dsh-auth-required': '1' });
      res.end(noKeyPage(req, lang));
      return;
    }
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8',
      'x-dsh-auth-required': '1', 'cache-control': 'no-store' });
    res.end(`${pageText(lang).errors.noKey}${req.url}`);
    return;
  }

  // 第二道门：这台设备登记过吗、被吊销了吗。
  //
  // ★ 等证明会把这个请求**重走一遍**（每 120 毫秒一次，最多十几秒）。重走时
  //   不要再算一次设备校验 —— `ensureDevice` 里 `sessions.verify` 每次都会
  //   更新 lastSeenAt 并**写一次设备表文件**，十几遍就是十几次磁盘写，
  //   而结论一个字都不会变。所以第一次算完就挂在 req 上复用。
  let dev = req.__dshDevice || null;
  if (!dev) {
    dev = ensureDevice(req, res);
    req.__dshDevice = dev;
  }
  // 第三道门：这台设备证明过「它知道 # 里那串」吗？
  //
  // 要解决的问题：访问密钥写在网址**路径**里，而路径是 HTTP 请求行的一部分，
  // 隧道（TLS 终点）看得见。它把那条请求自己发一遍就能拿到一样的登录凭证，
  // 然后以你的身份读会话预览、明文文件、余额。
  //
  // # 后面那串它**从来没见过**（浏览器根本不发 fragment，实测过），
  // 所以拿它当进门凭证。挑战应答能区分这两者（test-challenge-response.js
  // 验证过：只拿访问密钥的一方怎么算都过不去）。
  //
  // ── 2026-09-27：从「只记录」改成**真拦** ─────────────────────────────────
  //
  // 观察期（9/23 起）日志里手机每次都通过，所以打开。打开前补齐了三件事，
  // 少一件都会变成「把自己锁在门外」：
  //   1. 手机端先能发出应答 —— route.js 的 proveIdentity 早就在跑；
  //      这次又加了 e2ee.js 的 prove() + 收到 403 自动续证重试（installProofRetry）；
  //   2. 12 小时过期 / 网关重启（证明存在内存里）之后，页面能**自己**重新证明，
  //      不用人去电脑上操作；
  //   3. 还没有钥匙的设备（只有配对码）要有话可说，不能白屏 —— 见 needProofPage。
  //
  // 放行的是**这台设备自己的程序**（BOOTSTRAP_PATHS + /assets /plugins）：
  // 那些正是隧道本来就在转发的东西，放行等于没给它任何新东西。
  // 它真正想要的（会话预览、文件、余额、实时通道）一条都不在里面。
  const REQUIRE_PROOF = true;      // ← 观察期全绿，2026-09-27 打开
  if (REQUIRE_PROOF && dev.ok && dev.device && !authProvenAt(dev.device.id)) {
    // 记下「刚给它发过应用外壳」—— 等证明只在这个窗口里做（见上面那段说明）
    // ★ 这里必须把 codex / go 也算上（2026-09-27 漏了它们，实测代价：
    //   日志里 `403 未通过挑战应答: GET /codex（…不在开页面的窗口里，直接拒）`——
    //   使用者的 Codex 页整页打不开，还以为是「要我重新配对」）。
    if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/dsh-lite' ||

      u.pathname === '/go' || u.pathname === '/go/' ||
      req.__dshViaKeyPath) {
      const wasAway = !proofBootWindowOpen(dev.device.id);
      proofShellAt.set(dev.device.id, Date.now());
      if (wasAway) proofWaitHits.delete(dev.device.id);   // 新的一次开页面，计数重来
    }
    if (!isBootstrapRequest(u.pathname)) {
      // ★ 先等一等，别急着 403 —— 但只在这台设备**刚开页面**的时候等。
      //
      //   页面自己的启动请求（/api/session/list 等等）和它的证明是**同时**出发的，
      //   而证明要多走两个来回（慢链路上一个来回就是好几秒）。直接拒的后果是
      //   首次加载空白、要用户手动刷新 —— 看起来就是"坏了"。
      //
      //   两种等待（2026-09-27 按慢链路修正）：
      //     · 它已经来取过挑战（手里有钥匙、正在证）→ 等到底（10 秒），
      //       证明一到立刻放行；不要让它走「403 → 重新证明 → 重试」那一圈 ——
      //       那在隧道上会叠成几十秒。
      //     · 它没来取过挑战（多半没有钥匙）→ 只等 2.5 秒，和以前一样，不会更差。
      //
      //   窗口之外（页面开着很久了）**不等**：那种情况下挂着只会让人觉得卡，
      //   该刷新就刷新。
      const now = Date.now();
      const inBoot = proofBootWindowOpen(dev.device.id);
      const proving = proofLooksInProgress(dev.device.id);
      const capMs = proving ? PROOF_WAIT_FULL_MS : PROOF_WAIT_MS;
      const deadline = proofDeadline || (now + capMs);
      const waitedBefore = proofWaitHits.get(dev.device.id) || 0;
      if (inBoot && now < deadline && waitedBefore < PROOF_WAIT_MAX_PER_DEVICE && !res.headersSent) {
        if (!proofDeadline) proofWaitHits.set(dev.device.id, waitedBefore + 1);
        const waited = capMs - (deadline - now);
        setTimeout(() => {
          try {
            // 等的时候客户端可能已经走了（关页面、切网络）—— 那就别再往下走了
            if (res.writableEnded || res.destroyed || req.destroyed) return;
            handleRequestInner(req, res, deadline);
          } catch (err) { log(`等待证明后重入失败: ${err.message}`); }
        }, PROOF_WAIT_STEP_MS);
        if (waited >= PROOF_WAIT_STEP_MS * 3 && !proofDeadline) {
          log(`未通过挑战应答：${req.method} ${u.pathname} 先等着（最多 ${capMs} ms` +
            `${proving ? '，它正在证明' : ''}）——设备「${dev.device.label}」`);
        }
        return;
      }
      log(`403 未通过挑战应答: ${req.method} ${u.pathname}` +
        `（设备「${dev.device.label}」——${inBoot ? `等了 ${capMs} ms 也没等到证明` :
          '不在开页面的窗口里，直接拒（陈旧页面挂着只会更卡）'}；` +
        `该设备只拿到页面/脚本，内容一律不发）`);
      rejectNeedProof(req, res);
      return;
    }
    if (!authObserved.has(dev.device.id)) {      // 每个设备只记一次，别刷爆日志
      authObserved.add(dev.device.id);
      log(`设备「${dev.device.label}」还没通过挑战应答：只放行页面和脚本，` +
        `内容（/api 等）要等它证明完才给 —— 正常情况下几秒内它自己会证明`);
    }
  }

  if (!dev.ok) {
    // 那句话里没有一个字进日志（日志照旧只记 reason 代号），所以它只影响使用者
    // 看到的那一页 —— 按请求头出语言，见 deviceErrorPage。
    log(`403 设备校验失败(${dev.reason}): ${req.method} ${req.url}`);
    const lang = pageLanguage(req, res);   // 要在 writeHead 之前（见 launcher 那段的说明）
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(deviceErrorPage(req, lang, dev.reason));
    return;
  }

  // ── 连接方式分析（认证之后：候选地址里含访问密钥，不能给未认证的人看）──
  if (u.pathname === '/__routes') {
    routes.recommend(req, routeContext(ACCESS_KEY, pickLang(req), isLoopback(req))).then((data) => {
      // 顺带把「装了几个目标」告诉前端 —— 注入的角标脚本据此决定要不要显示切换按钮
      data.installedTargets = targetCache.installedCount;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data, null, 2));
    }).catch((err) => {
      log(`路径分析失败: ${err.message}`);
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // 申请一枚换路径票据。只有已经认证的页面能拿到 —— 这是票据方案的关键。
  if (u.pathname === '/__switch') {
    const want = u.searchParams.get('to') || '';
    routes.ownEgress().then(() => {
      const ctx = routeContext(ACCESS_KEY, pickLang(req), isLoopback(req));
      const list = routes.enumerate(ctx);
      const target = list.find((c) => c.id === want || c.authority === want);
      if (!target) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: `没有这条路径: ${want}` }));
        return;
      }
      const t = mintTicket(target.authority,
        dev && dev.device ? dev.device.id : null,
        u.searchParams.get('target'));
      log(`发出换路径票据 → ${target.authority}`);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        url: `${target.origin}/t/${t}`,
        kind: target.kind,
        authority: target.authority,
        expiresInSec: TICKET_TTL_MS / 1000
      }));
    }).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // 路径选择页：手机上「连不上 / 想换条更快的路」时的落地页
  if (u.pathname === '/go' || u.pathname === '/go/') {
    let html;
    try {
      const raw = trimHtmlToLanguage(req, res, path.join(PWA_DIR, 'go.html'));
      if (!raw) throw new Error('go.html 读不到');   // 抛出去让下面的 catch 照旧回 500
      html = Buffer.from(injectProofAssets(raw.toString('utf8')), 'utf8');
    }
    catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('go.html 缺失');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  // ── 代码清单（指纹）────────────────────────────────────────────────────────
  //
  // 为什么需要它：内容加密挡住的是「隧道偷看」，但挡不住「隧道把发给手机的
  // JS 换掉」——换掉的代码可以在明文还没加密时抄一份，或者直接偷走密钥。
  //
  // 做法：把网关会发给手机的每个 JS 算一个指纹，手机端 pin 住；
  // 以后每次取这些文件都核对，**对不上就用缓存里的旧版**。
  // 这样隧道即使改了代码也执行不了。
  //
  // 局限要说清楚：第一次 pin 的时候如果已经被掉包就防不住了（信任首次）。
  // 所以指纹也会通过推送通道发一份，使用者可以拿来核对。
  if (u.pathname === '/code-manifest.json') {
    // ★ i18n.js 必须在这里。
    //   做多语言时它被漏掉了 —— 而它恰恰是**决定界面显示什么语言**的那个文件。
    //   不在名单里意味着：有人把它换掉，Service Worker 不拦、也不弹红字。
    //   而它每个页面都会加载（配对页、工作台、codex、go 都引它）。
    const files = ['/polyfill.js', '/compat.js', '/dsh-directory-picker.js', '/e2ee.js', '/i18n.js', '/voice.js', '/route.js', '/boot.js',
      // Lite 页在手机上处理加密消息；官方页注入的入口也可能携带 /k/ 与 #k=。
      // 这些脚本必须与其它桥脚本受同一份 Service Worker 指纹约束。
      '/dsh-lite-pin.js', '/dsh-lite-adapter.js', '/dsh-lite-ui.js', '/dsh-lite-switch.js',
      '/dsh-lite-legacy.js', '/dsh-lite-router.js',
      // ★ 轻量版的三套文案。和 i18n.js 同一类：它决定界面显示什么语言、
      //   说什么话，每个页面都要加载 —— 不钉住就等于留了一个没人看着的口子。
      '/dsh-lite-lang.js',
      // 新加的这一份也钉进来：它是注入到**页面 HTML** 里的第一段脚本，
      // 正是「隧道往页面里插一段」最想冒充的位置。钉住之后，改过就会被发现。
      '/first-load.js',
    // 它拿着进门凭证做 HMAC —— 和别的注入脚本一样必须钉住
    '/prove.js'];
    const out = {};
    for (const f of files) {
      const route = PWA_ROUTES[f];
      if (!route) continue;
      try {
        const body = fs.readFileSync(path.join(PWA_DIR, route.file));
        out[f] = crypto.createHash('sha256').update(body).digest('hex');
      } catch (err) { /* 缺文件就跳过 */ }
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ at: Date.now(), files: out }));
    return;
  }

  // ── Codex 会话列表（预热缓存，手机上毫秒级拿到）────────────────────────────
  //
  // 为什么要这个端点：手机打开 Codex 界面，第一屏原来要等 10 秒 ——
  // 量下来不是渲染慢，是 app-server 列会话本身要 8~10 秒（它得读每条会话的
  // 元数据，这台机器上有好几条 GB 级的）。手机上的 localStorage 缓存只在
  // 第二次访问管用，冷启动照样等满。
  //
  // 现在改成：网关在电脑上每隔一分钟自己去问一次，结果存住；手机直接拿缓存。


  // ── DeepSeek 余额（够不够钱、该不该充值）────────────────────────────────────
  // 回环请求在上面（认证门之前）已经处理掉了；走到这里的是远程设备，
  // 已经过了两道门。两边共用 serveBalance，避免两处逻辑各写一份。
  if (u.pathname === '/__deepseek/balance') {
    serveBalance(req, res);
    return;
  }

  // Codex 额度：回环请求在上面（认证门之前）已经处理掉了；走到这里的是
  // 远程设备，已经过了两道门。两边共用 serveCodexQuota。


  // ── 看 Codex 产出的文件（图片 / pdf / 文本…）────────────────────────────────
  //
  // 为什么需要它：手机上看不到产出，就没法判断它做的方向对不对 ——
  // 会话里说「生成了 3 张图」，而使用者只能看到一行路径文字。
  //
  // 这是个**能读磁盘的端点**，所以边界必须写死：
  //   1. 在认证之后（和会话一样要过设备令牌）
  //   2. 只允许读「这个会话的工作目录」和 Codex 自己的目录（生成图片放那儿）
  //   3. 解析后再比对，挡住 ../ 这种绕法
  // 越界的请求一律拒绝并记日志 —— 宁可少看一个文件，也不能让这条路径变成任意读。
  // 内容通道的闸门已经统一提到前面的 E2EE_CONTENT_PATHS 那张表里了
  // （这里原来是一条只认 /codex/file 的判断，现在不再单独立一份）。


  // ── 目标管理（认证之后：列表里有本机路径这类信息）──────────────────────────
  if (u.pathname === '/__targets') {
    require('./targets.js').list({ lang: pickLang(req) }).then((list) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        targets: list,
        // 只有一个装了的时候，界面就别再问「你要用哪个」—— 没得选
        choiceNeeded: list.filter((t) => t.installed).length > 1,
        current: readTargetCookie(req) || null
      }, null, 2));
    }).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  if (u.pathname === '/__dsh/directories') {
    serveDshDirectoriesE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/lite-addresses') {
    serveDshLiteAddressesE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/lite-rpc') {
    serveDshLiteRpcE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/screen-shot') {
    serveDshLiteScreenE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/lite-upload') {
    serveDshLiteUploadE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/lite-download') {
    serveDshLiteDownloadE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/lite-files') {
    serveDshLiteFilesE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/lite-attachment') {
    serveDshLiteAttachmentE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/legacy-rpc') {
    serveDshLiteLegacyRpcE2ee(req, res);
    return;
  }

  if (u.pathname === '/__dsh/legacy-interactions' || u.pathname === '/__dsh/legacy-response') {
    serveDshLegacyInteractionsE2ee(req, res);
    return;
  }
  if (u.pathname === '/__dsh/legacy-upload') {
    serveDshLegacyUploadE2ee(req, res);
    return;
  }

  if (u.pathname === '/__targets/action' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (err) { }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, code: 'invalid-target-action' })); return;
      }
      if (retiredTargets.isRetiredTarget(body.target)) { retiredTargets.replyHttp(req, res); return; }
      const t = require('./targets.js').get(String(body.target || ''));
      if (!t) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: `不认识的目标: ${body.target}` }));
        return;
      }

      let result;
      try {
        // 语言要带下去：起停之后的提示语是服务端拼的
        const tLang = pickLang(req);

        if (body.action === 'start') result = await t.start(tLang);
        else if (body.action === 'stop') result = await t.stop(tLang);
        else result = { ok: false, message: `不认识的操作: ${body.action}` };
      } catch (err) {
        result = { ok: false, message: `操作出错: ${err.message}` };
      }

      log(`目标操作 ${body.target}/${body.action}: ${result.message}`);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // ── Codex 的界面（我们自己写的，所以路径完全可控，不需要改写任何资源引用）──





  // Legacy lock URLs always fail closed, including confirmed stale requests.
  // The existing encrypted wrapper preserves the caller's response channel.



  if (u.pathname === '/dsh-lite') {
    servePwa(req, res, { file: 'dsh-lite.html', type: 'text/html; charset=utf-8', noCache: true });
    return;
  }

  // ── 选目标（只改根路径，其余路径照旧全部反代给 DSH）─────────────────────────
  //
  // 为什么只动根路径：DSH 的前端用的是绝对路径（/api/...、/polyfill.js），
  // 把它挪到 /dsh/ 下面就得改写所有资源引用，那是一条又长又容易出错的路。
  // 而 Codex 的界面是我们自己写的，路径怎么写都行 —— 于是两边都能待在舒服的位置上。
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const want = u.searchParams.get('target');
    // Serve the owned shell in place: redirects can lose Safari's # key. This
    // policy does not depend on a user-agent, stale runtime profile or cookie.
    if (!isLocalRequest(req)) {
      if (u.searchParams.get('view') === 'classic') return dshPhoneSurface.replyHttp(req, res);
      const previousCookies = res.getHeader('set-cookie');
      res.setHeader('set-cookie', [].concat(previousCookies || [], [targetCookie('dsh')]));
      servePwa(req, res, { file: 'dsh-lite.html', type: 'text/html; charset=utf-8', noCache: true });
      return;
    }
    if (want === 'lite') {
      // A full /k/<key>?target=lite#k=<secret> link stays on this URL.
      // Redirecting here would lose Safari's fragment and break E2EE.
      const previousCookies = res.getHeader('set-cookie');
      res.setHeader('set-cookie', [].concat(previousCookies || [], [targetCookie('dsh')]));
      servePwa(req, res, { file: 'dsh-lite.html', type: 'text/html; charset=utf-8', noCache: true });
      return;
    }
    // 这一次是不是已经「就地」服务了（见下面 want==='dsh' 那个分支）——
    // 是的话，后面几条「该跳哪儿」的判断都不该再插手。
    let servedInPlace = false;

    // 换一个目标：把记住的选择清掉，重新问一次
    if (want === 'pick') {
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${TARGET_COOKIE}=; Path=/; Max-Age=0`
      });
      res.end();
      return;
    }

    if (want === 'dsh') {
      // ★ 从 /k/<密钥> 进来的「打开 DSH」**必须就地服务，不能跳**。
      //
      //   原来这里一律 302 → '/'。两个后果，第二个是使用者反复反映的那个：
      //     1. Safari 在 302 时**丢掉 `#` 后面的片段**（`#k=` 那串加密密钥），
      //        页面于是「未加密」，经中继时实时通道还会被拒；
      //     2. 地址栏变成 '/' —— 使用者**在应用里**点「添加到主屏幕」，
      //        图标里存下的就是 '/'。主屏 App 有独立的 cookie 存储、又没带密钥，
      //        点开只会得到「403 无会话 cookie」（实测日志 2026-09-24 21:13）。
      //
      //   就地服务之后：地址栏一直停在 `/k/<密钥>#k=<加密密钥>` 上 ——
      //   那是一条**自带认证**的地址，任何时候（加书签、加图标、换手机）
      //   点开都能自己换 cookie、自己带密钥，不依赖已有登录状态。
      //
      //   Codex 那边照旧跳 /codex：它是我们自己写的页面，本来就在认证之后，
      //   而且没有密钥路径这回事。
      if (want === 'dsh' && req.__dshViaKeyPath) {
        const prev = res.getHeader('set-cookie');
        res.setHeader('set-cookie', [].concat(prev || [], [targetCookie('dsh')]));
        // 转发给 DSH 时把 target 摘掉：它只是我们内部用来记选择的，
        // 不该出现在上游眼里（地址栏里那份留着，无害）。
        const sp = new URL(req.url, 'http://localhost').searchParams;
        sp.delete('target');
        const qs = sp.toString();
        req.url = '/' + (qs ? `?${qs}` : '');
        servedInPlace = true;
        // **不 return** —— 继续往下走：认证门已经过了，接着反代给 DSH。
      } else {
        res.writeHead(302, {
          location: '/',
          'set-cookie': targetCookie(want)
        });
        res.end();
        return;
      }
    } else if (!servedInPlace && shouldShowLauncher(req)) {
      // ★ 语言必须在 writeHead **之前**定下来：pageLanguage() 会往
      //   res.__pendingCookies 里塞「记住这个语言」，而那个队列是在 writeHead
      //   那一刻才合并进 set-cookie 的。写成 res.end(launcherPage(req,
      //   pageLanguage(req, res))) 的话，push 发生在响应头已经发出去之后 ——
      //   页面语言是对的，cookie 却永远不会到浏览器（实测踩过）。
      const lang = pageLanguage(req, res);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      // ★ 注入进门证明脚本：这一页自己要用 /__targets，而那是要证明的内容接口。
      //   不注入 = 页面永远证不了 = 列表永远拿不到（新设备首屏就是这个样子）。
      res.end(injectProofAssets(launcherPage(req, lang)));
      return;
    }

  }

  // ── Web Push 订阅端点（放在认证之后：只有已经进到 DSH 的浏览器才需要订阅）──
  if (u.pathname === '/__push/vapid') {
    let pub = '';
    try {
      pub = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')).publicKey || '';
    } catch (err) {
      pub = '';
    }
    if (!pub) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('vapid key not generated yet');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pub);
    return;
  }

  if (u.pathname === '/__push/subscribe' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const sub = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!sub || !sub.endpoint) throw new Error('订阅内容缺少 endpoint');

        const list = loadSubscriptions();
        const at = list.findIndex((s) => s.endpoint === sub.endpoint);
        if (at >= 0) { list[at] = sub; } else { list.push(sub); }

        fs.mkdirSync(path.dirname(SUBSCRIPTIONS_FILE), { recursive: true });
        fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(list, null, 2), 'utf8');

        log(`收到 Web Push 订阅，当前共 ${list.length} 台设备`);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, total: list.length }));
      } catch (err) {
        log(`订阅保存失败: ${err.message}`);
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  proxyRequest(req, res);
}

// ── WebSocket 升级转发 ────────────────────────────────────────────────────────
function handleUpgrade(req, socket, head, runtimeChecked = false) {
  if (socket.destroyed) return;                 // 等证明的时候对端可能已经走了
  if (privateHttpsAdmission.enforceUpgrade(req, socket, cfg.loadConfig().privateHttps)) return;
  if (retiredTargets.isRetiredRequest(req.url)) return retiredTargets.replyUpgrade(socket);
  const url = String(req.url || '');
  // 等证明会重入这个函数 —— 日志只在第一遍记，否则刷屏
  if (!req.__dshProofStart) log(`WS 升级请求: ${url.slice(0, 120)}`);

  if (!hasAuthCookie(req)) {
    log('WS 被拒：没有会话 cookie');
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // ★ 第二道门：设备令牌。
  //
  //   这里原来**只**查了那个会话 cookie，完全没有 ensureDevice —— 也就是说
  //   「注销这台设备」对实时通道毫无作用：被注销的手机照常收发消息、
  //   turn/start 照常能发。HTTP 那条路上两道门都在，偏偏最长的这条
  //   （一直开着的 WebSocket）只有一道，这是个很难注意到的缺口。
  //
  //   升级请求没法用普通 res 回话（响应要按 HTTP/1.1 101 的格式裸写），
  //   所以给它一个最小的替身：能收下 cookie（这里发不出去，但 HTTP 那侧
  //   下一次请求会补上）、writeHead/end 什么都不做。
  const wsRes = {
    __pendingCookies: [],
    setHeader() { }, getHeader() { return undefined; },
    writeHead() { }, end() { }
  };
  // ★ 等证明会把升级请求重走一遍 —— 重走时不再算一次设备校验
  //   （每算一次都要写一遍设备表文件，而结论不会变）。
  let dev = req.__dshWsDevice || null;
  if (!dev) {
    dev = ensureDevice(req, wsRes);
    req.__dshWsDevice = dev;
  }
  if (!dev.ok) {
    log(`WS 被拒：设备令牌不通过（${dev.reason}）`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // ★ 第三道门：挑战应答。HTTP 那条路上有，这条路上原来**没有** ——
  //   而这条恰恰是最长的一条（整个对话都在上面，一开就是几小时）。
  //   只在 HTTP 上拦、把 WS 留着，等于门锁了、窗户开着：拿访问密钥进来的一方
  //   照样能升级这条连接，然后明文收发全部消息。
  //
  //   和 HTTP 那条路一样带 x-dsh-need-proof: 1 —— 手机端的 WS 补丁看到
  //   「没打开就关了」会立刻重新证明一次，下一次重连就能过。
  //
  // ★ dev.device 可能为 null（本机请求不登记设备）—— 必须先判它。
  //   第一版漏了这个判断，表现是整个网关 FATAL 崩掉（读 null 的 id），
  //   而崩的时机恰好是「手机正在连实时通道」。见 test-auth-boundary.js。
  if (dev.device && !authProvenAt(dev.device.id)) {
    // 和 HTTP 那条路同一套规则（2026-09-27 按慢链路修正）：
    //   · 刚开页面 → 等；这台设备正在证明（来取过挑战）→ 等到底（10 秒）
    //   · 没来取过挑战 → 只等 2.5 秒
    //   · 页面开着很久了（不在开机窗口）→ 直接拒，不再挂着
    // 这条通道一开就是几小时、整个对话都在上面，所以它比 HTTP 更值得等一次。
    //
    // ★ 上限用**挂钟**算，不用「重试了几次 × 间隔」：每一遍都要重新走一遍
    //   前面的门，实际间隔比 setTimeout 的 120 毫秒长不少 —— 按次数算会等过头
    //   （实测：说好 2.5 秒，结果 4 秒还没回，客户端自己先超时了）。
    const now = Date.now();
    const capMs = proofLooksInProgress(dev.device.id) ? PROOF_WAIT_FULL_MS : PROOF_WAIT_MS;
    const first = !req.__dshProofStart;
    if (first) req.__dshProofStart = now;
    const deadline = req.__dshProofStart + capMs;
    if (proofBootWindowOpen(dev.device.id) && now < deadline && !socket.destroyed) {
      setTimeout(() => {
        try { if (!socket.destroyed) handleUpgrade(req, socket, head); } catch (err) { }
      }, PROOF_WAIT_STEP_MS);
      if (first) {
        log(`WS 升级：设备「${dev.device.label}」还没证明自己，先等着（最多 ${capMs} ms）`);
      }
      return;
    }
    log(`WS 被拒：设备「${dev.device.label}」还没通过挑战应答（这条通道要证明过才给）`);
    socket.write('HTTP/1.1 403 Forbidden\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'x-dsh-need-proof: 1\r\n' +
      'Connection: close\r\n\r\n' +
      'Prove that you know the key from the address (the part after #). Reconnect after that.\n');
    socket.destroy();
    return;
  }

  // ★ 加密门：经中继的内容通道必须加密。
  //
  //   前两道门（会话 cookie、设备令牌）管的是「你是谁」；
  //   挑战应答那道门管的是「你证没证明过自己拿着钥匙」；
  //   这一道管的是「这条路上跑的是不是明文」—— 三件事互不替代。
  //   网关原来只做到「客户端要求就加密」，所以冒充者不要求就能拿明文，
  //   而 WS 恰恰是最长的那条通道（整个对话都在上面）。
  // Remote upgrades require a usable key and e2ee=1. Missing key material
  // returns 503; a plaintext request with an available key returns 403.
  const wsGateSecret = e2eeSecretOrNull();
  const remotePhone = !isLocalRequest(req);
  if (remotePhone) {
    if (!wsGateSecret) {
      refuseEncryptionUnavailableUpgrade(socket);
      return;
    }
    // Pin this connection's checked key through asynchronous upstream setup.
    // A later unreadable key file must not change the connection to plaintext.
    req.__dshWsE2eeSecret = wsGateSecret;
  }
  if (wsGateSecret && remotePhone && !e2eeBridge.wanted(req.url, wsGateSecret)) {
    log('WS 被拒：经中继但没要求加密（拒绝明文，不降级）');
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      'This channel must be encrypted. Open the address copied from the console ' +
      '(the part after # is the key).\n');
    socket.destroy();
    return;
  }

  // Old phone clients and unknown plugin/event paths must not bypass Lite's
  // encrypted transport by opening an arbitrary upstream WebSocket.
  if (remotePhone && !dshPhoneSurface.isRemoteMux(req.url)) return dshPhoneSurface.replyUpgrade(socket);
  if (!EXPLICIT_TARGET_PORT && !runtimeChecked) {
    refreshDshRuntime().then(running => {
      if (socket.destroyed) return;
      if (running) handleUpgrade(req, socket, head, true);
      else {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    }).catch(() => { if (!socket.destroyed) socket.destroy(); });
    return;
  }

  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headers = buildUpstreamHeaders(req);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const key of Object.keys(headers)) {
      const value = headers[key];
      if (Array.isArray(value)) {
        for (const v of value) raw += `${key}: ${v}\r\n`;
      } else if (value !== undefined) {
        raw += `${key}: ${value}\r\n`;
      }
    }
    raw += '\r\n';
    upstream.write(raw);

    // Direct local clients keep optional encryption. Relay clients passed the
    // mandatory gate above; retain its checked key during upstream setup.
    const secret = req.__dshWsE2eeSecret || e2eeBridge.readSecret();
    const useE2ee = e2eeBridge.wanted(req.url, secret);
    let bridge = null;
    let encryptedStreamClosed = false;
    const encryptedFailureCodes = new Set([
      'ws-frame-invalid', 'ws-frame-too-large', 'ws-frame-count-limit',
      'ws-control-invalid', 'ws-fragmentation-unsupported', 'ws-buffer-too-large',
      'ws-data-unsupported', 'ws-upgrade-too-large', 'ws-upgrade-invalid', 'ws-bridge-closed',
      'invalid-ciphertext', 'replayed-request', 'replay-invalid', 'replay-clock-rollback',
      'replay-capacity', 'replay-store-linked', 'replay-store-write', 'replay-store-incomplete',
      'replay-store-changed', 'replay-store-corrupt', 'replay-store-busy',
      'replay-store-unavailable', 'replay-store-lock-changed', 'replay-store-lock-unavailable'
    ]);
    const refuseEncryptedStream = (error) => {
      if (encryptedStreamClosed) return;
      encryptedStreamClosed = true;
      // Neither raw upstream bytes nor an exception's possibly sensitive
      // message may become a response or a diagnostic fallback.
      let code = 'ws-encrypted-stream-refused';
      try { const candidate = error && error.code; if (encryptedFailureCodes.has(candidate)) code = candidate; } catch (_) { }
      log('WS encrypted channel refused an invalid stream; owned sockets closed (' + code + ')');
      try { if (bridge && typeof bridge.close === 'function') bridge.close(); } catch (_) { }
      upstream.destroy();
      socket.destroy();
    };
    const transform = (chunk, direction) => {
      if (encryptedStreamClosed) return null;
      try {
        const output = bridge ? bridge[direction](chunk) : chunk;
        if (!Buffer.isBuffer(output)) throw new Error('invalid-encrypted-transform');
        return output;
      } catch (error) { refuseEncryptedStream(error); return null; }
    };
    try { if (useE2ee) bridge = e2eeBridge.attach(secret); }
    catch (error) { refuseEncryptedStream(error); return; }
    upstream.once('close', () => {
      try { if (bridge && typeof bridge.close === 'function') bridge.close(); } catch (_) { }
    });
    if (useE2ee) log('WS 通道已启用端到端加密（隧道只能看到密文）');

    if (head && head.length) {
      const output = transform(head, 'fromClient');
      if (output === null) return;
      upstream.write(output);
    }

    // 双向逐帧记录。
    //
    // ★ 默认**不记内容**，只记帧的大小和类型。
    //
    //   原来这里把每帧前 160 字节按 UTF-8 打进日志，注释写的是「只记前若干帧，
    //   免得日志爆掉」。但 `frames` 是**每条连接**的闭包变量 —— 手机每刷新一次
    //   页面就再记 40 帧。于是 logs/proxy.log 里慢慢堆起了使用者的真实对话正文
    //   （实测 2MB 的文件里有几百条 snapshot / projection / assistant）。
    //   那是个纯文本文件，没有任何保护，而他以为「端到端加密」就意味着
    //   内容不会落盘 —— 加密保护的是**线路上**，不包括我们自己写的日志。
    //
    //   排查「手机连不上」时确实需要看到帧的内容，但那是**临时**需求，
    //   不该拿「把所有对话写进日志」来换。要看内容就显式开：
    //     set DSH_GW_LOG_FRAMES=1   然后重启服务（自动重启按钮就支持这个）
    const LOG_FRAME_BODY = process.env.DSH_GW_LOG_FRAMES === '1';
    let frames = 0;
    const MAX_FRAMES = LOG_FRAME_BODY ? 40 : 12;
    const describe = (chunk) => {
      const op = chunk.length ? '0x' + (chunk[0] & 0x0f).toString(16) : '?';
      const head = `${chunk.length}B op=${op}`;
      if (!LOG_FRAME_BODY) return head;
      const text = chunk.subarray(0, 160).toString('utf8').replace(/[\r\n\t]+/g, ' ');
      return `${head} ${text}`;
    };

    upstream.on('data', (chunk) => {
      // ★ 先加密，再记日志 —— 顺序反了会得出完全相反的结论。
      //
      // 原来这里是「先 log(chunk) 再 bridge.fromUpstream(chunk)」，也就是
      // **记的是加密之前的明文**。后果很严重：加密明明开着，日志里却满眼
      // 可读 JSON（{"type":"item","value":{"type":"snapshot"... 甚至真实对话内容），
      // 看起来就像「下行根本没加密」。我自己就据此差点判定成一个严重漏洞。
      //
      // 这个日志的用途是「手机连不上时，看看隧道那头到底收到了什么」——
      // 那当然要记**线路上的字节**。上行那边本来就是这么做的（记的是手机发来的
      // 原始密文），只有下行记反了，于是两边看起来不对称，更容易误导。
      const wire = transform(chunk, 'fromUpstream');
      if (wire === null) return;
      if (frames < MAX_FRAMES) {
        log(`WS DSH→手机  ${describe(wire)}`);
        frames++;
      }
      // 活动检测看**解密前**的内容：DSH 每 2 秒一个 ping，ping 是控制帧，
      // 不能算「agent 在干活」。加密之后整条都是 binary 帧，
      // 拿 wire 去判类型就永远是 false 了。
      if (chunk.length && (chunk[0] & 0x0f) === 0x1) markActivity();
      socket.write(wire);
    });

    socket.on('data', (chunk) => {
      if (frames < MAX_FRAMES) {
        log(`WS 手机→DSH  ${describe(chunk)}`);
        frames++;
      }
      // 只把文本帧算作活动 —— DSH 每 2 秒一个 ping，那不能算「在干活」。
      // 注意要看**解密之后**的内容：加密过的上行是 binary 帧，
      // 直接看原始字节的话这里永远是 false，活动检测就废了。
      const out = transform(chunk, 'fromClient');
      if (out === null) return;
      if (out.length && (out[0] & 0x0f) === 0x1) markActivity();
      upstream.write(out);
    });

    // 加密通道的体检数据：拦下多少重放、拒收多少文本帧、放行多少解不开的帧。
    //
    // 这三个数不记的话，丢帧就是**完全静默**的 —— 表现是「连上了但没反应」，
    // 日志里一个字都没有，是这一层最难查的失败方式（重放防护刚加上时
    // 就是这么个性质）。所以只在有数字的时候打一行，没数字就不刷屏。
    const logCryptoStats = (why) => {
      if (!bridge || !bridge.stats) return;
      const s = bridge.stats();
      if (!s.replayed && !s.rejected && !s.undecryptable) return;
      log(`WS 加密通道体检（${why}）：拦下重放 ${s.replayed} 帧，拒收解不开的文本帧 ${s.rejected} 帧，` +
        `放行解不开的二进制帧 ${s.undecryptable} 帧`);
    };
    upstream.on('end', () => { log('WS 上游结束'); logCryptoStats('上游结束'); socket.end(); });
    socket.on('end', () => { log('WS 客户端结束'); upstream.end(); });
    upstream.on('close', () => { log('WS 上游关闭'); logCryptoStats('上游关闭'); });
  });

  upstream.on('error', (err) => {
    log(`WS 上游错误 ${req.url}: ${err.message}`);
    // DSH 没开时实时通道也会连不上，同样顺手把它拉起来
    if (err.code === 'ECONNREFUSED') {
      ensureDshRunning().then((ok) => {
        log(ok ? 'DSH 已就绪（由 WebSocket 触发）' : 'DSH 自动启动未成功（由 WebSocket 触发）');
      });
    }
    socket.destroy();
  });
  socket.on('error', (err) => {
    log(`WS 客户端错误: ${err.message}`);
    upstream.destroy();
  });
}


// A phone is a read connection. Closing or reconnecting it must never resume,
// unsubscribe, hand back, interrupt, or stop a desktop-owned conversation.
const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);
let gatewayListeners = null;

// ── 内网 HTTPS（可选）────────────────────────────────────────────────────────
//
// 内网那条路默认是明文 HTTP：同一个 WiFi 下的任何设备都能嗅探。
// 打开这一项之后会多一个 HTTPS 监听，内网入口变成加密的。
//
// 两个必须说清楚的代价：
//   1. 用的是自签证书，手机上第一次打开会看到证书警告 —— 选「继续访问」即可。
//      想彻底不看到警告，得把 tls/ca.crt 装到手机上信任一次（可选，不装也能用）。
//   2. 它挡的是**被动嗅探**。有人能在网络里主动劫持的话，自签证书挡不住 ——
//      因为使用者已经被训练成「看到警告就点继续」了。真要防这个，
//      得用受信任的证书，而那要么需要自己的域名，要么需要装描述文件。
//
// 端口用中间层端口 +1，并且同样会避让占用。之所以不复用同一个端口做协议嗅探：
// 那要在现有的明文链路上再加一层原始 TCP 处理，风险落到了一条本来工作正常的路径上。
// 多一个端口换来的是「新功能坏了不会连带弄坏旧功能」。
let HTTPS_PORT = 0;
let httpsServer = null;

async function startHttpsIfEnabled() {
  const conf = cfg.loadConfig();
  const opts = conf.lanHttps || {};
  if (!opts.enabled) return;

  let tls;
  try {
    tls = require('./make-cert.js').ensure();
  } catch (err) {
    log(`内网 HTTPS 已开启，但证书准备失败: ${err.message} —— 这一项先跳过，明文入口不受影响`);
    return;
  }

  // 端口：优先用配置里指定的，其次从 PORT+1 往后找。
  // 注意 findAvailablePort 是异步的 —— 忘了 await 的话拿到的是个 Promise，
  // 直接喂给 listen 会抛异常，而且进程会当场死掉、日志里只留一句「已启动」。
  try {
    const wanted = Number(opts.port) > 0 ? Number(opts.port) : PORT + 1;
    HTTPS_PORT = (await cfg.findAvailablePort(wanted)) || 0;
    if (!HTTPS_PORT) {
      log('内网 HTTPS：从候选端口一路试到 65535 都没找到空闲的，这一项跳过');
      return;
    }
  } catch (err) {
    log(`内网 HTTPS：找端口时出错（${err.message}），这一项跳过`);
    return;
  }

  try {
    httpsServer = require('https').createServer(
      { cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' },
      handleRequest
    );
  } catch (err) {
    log(`内网 HTTPS：加载证书失败（${err.message}）—— 这一项跳过，明文入口不受影响`);
    HTTPS_PORT = 0;
    return;
  }

  httpsServer.on('upgrade', handleUpgrade);
  httpsServer.on('error', (err) => {
    log(`内网 HTTPS 监听失败: ${err.message}（明文入口不受影响）`);
    HTTPS_PORT = 0;
  });
  httpsServer.listen(HTTPS_PORT, () => {
    log(`内网 HTTPS 已启动: :${HTTPS_PORT}（自签证书，手机首次访问会提示一次）`);
    try {
      fs.writeFileSync(path.join(cfg.LOG_DIR, 'https-port.txt'), String(HTTPS_PORT), 'utf8');
    } catch (err) { /* 写不了不影响运行 */ }
  });
}

// ── 兜底：绝不允许「静默死掉」 ────────────────────────────────────────────────
//
// 这个进程是用 wscript 以「无窗口」方式起来的，stderr 直接进了虚空。
// 所以任何没接住的异常都会表现为「服务莫名其妙没了、日志里最后一句还是启动成功」——
// 排查起来毫无线索（这个坑刚踩过：findAvailablePort 忘了 await，
// 端口位置拿到一个 Promise，进程当场退出，日志里一句错都没有）。
// 这里把没接住的异常和未处理的 Promise 拒绝都写进日志。
process.on('uncaughtException', (err) => {
  log(`FATAL 未捕获异常: ${err && err.stack ? err.stack : err}`);
  // This is an abrupt crash, not an orderly drain. Retain durable owner and
  // child evidence for explicit recovery; never claim a graceful close.
  setTimeout(() => process.exit(1), 200);
});

process.on('unhandledRejection', (reason) => {
  log(`FATAL 未处理的 Promise 拒绝: ${reason && reason.stack ? reason.stack : reason}`);
});

// Health/listeners stay up while the same controlled transaction drains.
// Repeated signals do not bypass a pending or failed close with process.exit.
process.on('SIGINT', () => { desktopLifecycle.scheduleShutdown(); });
process.on('SIGTERM', () => { desktopLifecycle.scheduleShutdown(); });

/** 按扩展名给个 content-type。认不出来的当二进制流出去。 */
// ── 目标选择 ──────────────────────────────────────────────────────────────────
//
// 「这台电脑上有几个能用？要不要问使用者用哪个？」这件事每 10 秒算一次，
// 缓存起来给请求用。理由：查目标状态要探端口、发 HTTP，不能挂在每个页面请求上；
// 而这件事本身变化很慢（装了什么、起没起），10 秒的滞后无所谓。
const TARGET_COOKIE = 'dsh-gw-target';
let targetCache = { at: 0, list: [], installedCount: 0, runningCount: 0 };
let targetRefreshing = null;

async function refreshTargets() {
  if (targetRefreshing) return targetRefreshing;
  targetRefreshing = (async () => {
    try {
      const list = await require('./targets.js').list();
      targetCache = {
        at: Date.now(),
        list,
        installedCount: list.filter((t) => t.installed).length,
        runningCount: list.filter((t) => t.installed && t.running).length
      };
    } catch (err) {
      log(`刷新目标列表失败: ${err.message}`);
      targetCache = { at: Date.now(), list: [], installedCount: 0, runningCount: 0 };
    } finally {
      targetRefreshing = null;
    }
    return targetCache;
  })();
  return targetRefreshing;
}

// 启动就预热一次，免得第一个进来的请求看到空缓存
refreshTargets();
setInterval(() => { refreshTargets(); }, 10000).unref();

function readTargetCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const seg of raw.split(';')) {
    const s = seg.trim();
    if (s.startsWith(`${TARGET_COOKIE}=`)) {
      const v = s.slice(TARGET_COOKIE.length + 1);
      return v === 'dsh' ? v : null;
    }
  }
  return null;
}

function targetCookie(id) {
  return `${TARGET_COOKIE}=dsh; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

/** Keep normal DSH entry direct; missing targets and Codex-only PCs use the selector. */
function shouldShowLauncher(req) {
  if (isSelfCheck(req)) return false;
  if (Date.now() - targetCache.at > 30000) refreshTargets();
  const available = targetCache.list.filter((t) => t.id === 'dsh' && (t.installed || t.running));
  const chosen = readTargetCookie(req);
  if (chosen) {
    if (chosen === 'dsh' && EXPLICIT_TARGET_PORT) return false;
    return !available.some((t) => t.id === chosen);
  }
  // A manually configured upstream may run without a discoverable desktop install.
  if (EXPLICIT_TARGET_PORT && available.length <= 1) return false;
  return available.length !== 1 || available[0].id !== 'dsh';
}

/**
 * 「这台电脑上有不止一个能连的东西」—— 选择页。
 *
 * 页面里那段脚本的文案也是按语言出的：整包文案作为 JSON 注进 `var L`，脚本里
 * 一律读 L.xxx。这样脚本本身只有一份（三种语言各抄一份脚本是不可能同步维护的），
 * 而它做的事和老版本逐句一样 —— 请求 /__targets、渲染卡片、启动/停止、刷新。
 *
 * `t.blurb` / `t.note` 是目标模块（targets.js）给的说明文字，不在这里翻 ——
 * 那是数据，不是这一页的文案；它们跟着目标本身走。
 */
function launcherPage(req, lang, missingTarget = null) {
  const code = normLang(lang);
  const T = PAGE_TEXT[code].launcher;
  const sub = missingTarget ? T.missing.replace('{name}', 'DSH') : T.sub;
  return `<!doctype html>
<html lang="${code}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0b0c">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${T.title}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{font-family:-apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
       background:#0b0b0c;color:#eee;margin:0;padding:28px 20px 40px;
       max-width:520px;margin-inline:auto;min-height:100vh}
  h1{font-size:22px;margin:0 0 6px}
  .sub{color:#8a8a92;font-size:13.5px;margin-bottom:26px;line-height:1.7}
  .card{display:block;background:#17171a;border:1px solid #232329;border-radius:16px;
        padding:18px;margin-bottom:12px;text-decoration:none;color:inherit;
        transition:border-color .15s,transform .1s}
  .card:active{transform:scale(.985)}
  .card.on{border-color:#2c5ce6}
  .card.off{opacity:.66}
  .row{display:flex;align-items:center;gap:10px}
  .name{font-size:17px;font-weight:650;flex:1}
  .dot{width:9px;height:9px;border-radius:50%;flex:none}
  .dot.ok{background:#3ddc84}
  .dot.off{background:#5b5b64}
  .blurb{color:#8a8a92;font-size:13px;margin-top:7px;line-height:1.6}
  .state{font-size:12.5px;margin-top:8px}
  .state.ok{color:#6fcf97}
  .state.off{color:#c9a227}
  .acts{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}
  .acts a,.acts button{font:inherit;font-size:13.5px;padding:8px 16px;border-radius:10px;
    border:1px solid #2c2c34;background:#22222a;color:#eee;text-decoration:none;
    cursor:pointer;-webkit-tap-highlight-color:transparent}
  .acts a{background:#2c5ce6;border-color:#2c5ce6;color:#fff;font-weight:600}
  .acts button:disabled{opacity:.5}
  .foot{color:#6f6f78;font-size:12.5px;line-height:1.9;margin-top:26px}
  .err{background:#2a1c1c;border:1px solid #5a2a2a;border-radius:12px;padding:12px 14px;
       color:#f0a0a0;font-size:13px;margin-top:16px;display:none}
</style></head>
<body>
<h1>${T.heading}</h1>
<div class="sub">${sub}</div>
<div id="list"><div class="card"><div class="row"><span class="name">${T.checking}</span></div></div></div>
<div class="acts"><button type="button" onclick="location.reload()">${T.retry}</button></div>
<div class="err" id="err"></div>
<div class="foot">
  ${T.foot}
</div>
${langSwitcher(req, code, false)}
<script>
'use strict';
var L=${JSON.stringify({
    checking: T.checking, none: T.none, noneHint: T.noneHint, open: T.open,
    start: T.start, stop: T.stop, starting: T.starting, stopping: T.stopping,
    stopConfirm: T.stopConfirm, stopDsh: T.stopDsh, stopOther: T.stopOther,
    failed: T.failed, failedWith: T.failedWith, listFailed: T.listFailed,
    needKey: T.needKey
  })};
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function render(d){
  var box=document.getElementById('list');
  box.innerHTML='';
  var shown=(d.targets||[]).filter(function(t){return t.id==='dsh'&&(t.installed||t.running)});
  if(!shown.length){
    box.innerHTML='<div class="card"><div class="name">'+L.none+'</div>'+
      '<div class="blurb">'+L.noneHint+'</div></div>';
    return;
  }
  shown.forEach(function(t){
    var c=document.createElement('div');
    c.className='card '+(t.running?'on':'off');
    c.innerHTML='<div class="row"><span class="dot '+(t.running?'ok':'off')+'"></span>'+
      '<span class="name">'+esc(t.short)+'</span></div>'+
      '<div class="blurb">'+esc(t.blurb)+'</div>'+
      '<div class="state '+(t.running?'ok':'off')+'">'+esc(t.note)+'</div>';
    var acts=document.createElement('div');
    acts.className='acts';
    if(t.running){
      var a=document.createElement('a');
      // ★ 必须把 location.hash 带上 —— 那里面装着加密密钥（#k=…）。
      //
      // 不带的话，使用者点「打开 DSH」就进了 /?target=dsh，fragment 没了，
      // 于是**整场都是明文**：不报错、界面照常，只是隧道能看懂一切。
      // 这是「进入手机端显示未加密」的真正原因 —— 而且只装一个目标的人
      // 根本不会经过这一页，所以这个问题一直没被发现。
      //
      // fragment 天生不会发给服务器，所以它只能靠前端自己一站一站传下去。
      // ★ 必须带上 /k/<访问密钥> 这一段，不能只写 /?target=…
      //
      //   原来这里写的是 '/?target=' + t.id —— 点下去路径就变成 '/' 了，
      //   而「添加到主屏幕」保存的是**当时的地址**：图标里于是没有 /k/，
      //   主屏 App 又是独立存储（没有 cookie），打开就是 403 白屏。
      //   使用者反复反映的「存到屏幕打不开」，根子在这儿 —— 他是在选择页上
      //   点的「打开 DSH」，那一刻路径就丢了。
      //
      //   带 /k/ 之后，图标存下的是一条**自带认证**的地址：点开时自己换
      //   cookie、自己带密钥，不依赖任何已有登录状态。
      //
      //   注意：这一段在模板字符串里，注释中不能出现反引号，否则会截断它。
      a.href='/k/'+encodeURIComponent('${ACCESS_KEY}')+'?target='+encodeURIComponent(t.id)+location.hash;
      a.textContent=L.open+t.short;
      acts.appendChild(a);
      var s=document.createElement('button');
      s.textContent=L.stop;
      s.onclick=function(){
        if(!confirm(L.stopConfirm.split('{name}').join(t.short)+'\\n\\n'+(t.id==='dsh'?L.stopDsh:L.stopOther))) return;
        act(t.id,'stop',s);
      };
      acts.appendChild(s);
    }else{
      var b=document.createElement('button');
      b.textContent=L.start;
      b.style.cssText='background:#2c5ce6;border-color:#2c5ce6;color:#fff;font-weight:600';
      b.onclick=function(){ act(t.id,'start',b); };
      acts.appendChild(b);
    }
    c.appendChild(acts);
    box.appendChild(c);
  });
}

function act(id,action,btn){
  var old=btn.textContent;
  btn.disabled=true;
  btn.textContent=action==='start'?L.starting:L.stopping;
  fetch('/__targets/action',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({target:id,action:action})})
    .then(function(r){return r.json()})
    .then(function(j){
      btn.disabled=false; btn.textContent=old;
      if(!j.ok){ document.getElementById('err').style.display='block';
        document.getElementById('err').textContent=j.message||L.failed; }
      refresh();
    })
    .catch(function(e){ btn.disabled=false; btn.textContent=old;
      document.getElementById('err').style.display='block';
      document.getElementById('err').textContent=L.failedWith+e.message; });
}

function showErr(msg){
  document.getElementById('err').style.display='block';
  document.getElementById('err').textContent=msg;
}

function refresh(){
  fetch('/__targets',{cache:'no-store'}).then(function(r){
    // ★ 先看状态码，再决定要不要当成列表。
    //
    //   403 的正文也是合法 JSON，r.json() 会成功 —— 于是「没通过证明」
    //   被一路当成「列表是空的」，页面写出「没有找到可连的东西」。
    //   实测代价：使用者打开完整链接、配对完，看到的就是这一句，
    //   完全不知道真正的原因在他手里那条地址上。
    //   （注意：这一整段是服务端模板字符串里的内联脚本，注释与代码里
    //    都不能出现反引号，否则会把外层模板截断。）
    if(!r.ok){
      var needKey=r.headers.get('x-dsh-need-proof')==='1';
      showErr((needKey?L.needKey:L.listFailed)+'（HTTP '+r.status+'）');
      return null;
    }
    return r.json();
  }).then(function(j){
    if(j===null)return;
    if(!j||!Array.isArray(j.targets)){ showErr(L.listFailed); return; }
    render(j);
  }).catch(function(e){ showErr(L.listFailed+e.message); });
}
refresh();
</script>
</body></html>`;
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
// 端口在启动时才确定：配置/环境变量给偏好，被占用就自动往后找，并把最终端口
// 写进 logs\gateway-port.txt —— 启动器、防火墙规则、二维码都读那个文件，
// 这样端口换掉之后其它环节能自动跟上。
(async () => {
  const identity = cfg.ensureInstanceIdentity();
  INSTANCE_ID = identity.instanceId;
  if (identity.isFirstRun) {
    log('首次在本机运行，将签发全新的本机密钥');
  } else if (identity.isNewMachine) {
    log('检测到本目录被复制到了另一台机器，已作废旧密钥并重新签发');
  }
  log(`本机实例 ID: ${identity.instanceId}`);

  const config = cfg.loadConfig();
  try { await refreshDshRuntime(true); } catch (err) { log(`Initial DSH discovery failed: ${err.message}`); }
  const preferred = Number(process.env.DSH_GW_PORT || config.gatewayPort || 8080);
  try {
    gatewayListeners = await require('./gateway-listener.js').bindGateway({
      server,
      createSibling() {
        const sibling = http.createServer(handleRequest);
        sibling.on('upgrade', handleUpgrade);
        return sibling;
      },
      preferred, tries: 20, enableLan: config.enableLanAccess !== false,
      identity: { pid: process.pid, bootId: GATEWAY_BOOT_ID, instanceId: INSTANCE_ID },
      onPortBound(port) { PORT = port; configureAuthCookieScope(PORT); },
      onError(error) { log(`FATAL 监听失败: ${error.message}`); process.exit(1); }
    });
  } catch (error) {
    log(`Gateway listener unavailable (${error.code || 'startup-failed'}); no new port was advertised.`);
    process.exit(1);
  }
  if (PORT !== preferred) {
    log(`端口 ${preferred} 已被占用，改用 ${PORT}`);
  }

  try {
    fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.LOG_DIR, 'gateway-port.txt'), String(PORT), 'utf8');
  } catch (err) {
    log(`写 gateway-port.txt 失败: ${err.message}`);
  }

  {
    loadAuthProven();
    // 端口抢到了才写配对码文件（理由见 writePairCodeFile 的注释）
    writePairCodeFile();
    const activePairCode = currentPairCode();
    log(`中间层已启动: :${PORT} -> 127.0.0.1:${TARGET_PORT}  (Host 头固定 ${INTERNAL_HOST})  配对码 ${activePairCode || '不可用'}`);
    startHttpsIfEnabled();
    // DSH 重启会换端口，看门狗负责悄悄跟上，使用者不该感觉到
    startDshWatchdog();
    // Codex 挂了自动拉回来（但不主动启动没在用的它）


    // 把历史遗留的「同一台设备多条记录」并掉。
    // 同一设备经不同网址访问时应合并记录——
    // create() 现在不会再制造新的重复，但之前已经攒下的要清一次。
    try {
      const r = sessions.dedupe();
      if (r.merged) log(`设备表去重：并掉 ${r.merged} 条重复记录（同一台设备只留一条）`);
    } catch (err) { log(`设备表去重失败: ${err.message}`); }


  }
})();
