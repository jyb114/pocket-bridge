// DSH 移动端网关 — 全能力自检
//
// 一条命令回答「现在到底能不能用、哪些能力真的生效」。
// 原则：每项都做真实探测，不读配置猜、不靠代码里写了什么就宣称支持。
//
// 用法：
//   node self-check.js              全部检查
//   node self-check.js --quick      跳过需要联网的项（隧道可达性、外网入口）
'use strict';

// 这台机器的系统解析器优先返回 IPv6，而 Node 自带的解析器有时拿不到结果 ——
// 表现为「外网入口」这一项报 ENOTFOUND，但 curl / 浏览器其实是通的。
// 强制 v4 优先，让自检的结论跟真实情况一致。
require('dns').setDefaultResultOrder('ipv4first');

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
// execFileSync 用来问 Codex 的版本号（`codex --version`）。
//
// ★ 这个 require 一度是漏的 —— 于是 checkCodexVersion 里那次调用每次都抛
//   「execFileSync is not defined」，而那个 catch 又把错误吞掉了，
//   自检常年只报一句「（读不到版本号）」，完全看不出是缺了个 require。
//   教训是两层的：一是别漏 import，二是 **catch 里不能把错误扔掉** ——
//   扔掉的代价是我在「超时 / 占用 / 代理」上白猜了好几轮。
const { execFileSync } = require('child_process');

const cfg = require('./config.js');
const tunnel = require('./tunnel.js');

const BASE = cfg.BASE;
const LOG_DIR = cfg.LOG_DIR;
const QUICK = process.argv.includes('--quick');

const results = [];
function record(id, title, status, detail) {
  results.push({ id, title, status, detail });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 通用探测 ──────────────────────────────────────────────────────────────────
function httpGet(url, options = {}) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith('https:');
    const mod = isHttps ? require('https') : http;
    // 自报家门：自检会连自己的内网地址（那正是「内网入口可用」要验的事），
    // 而服务端在 HTTP 层面分不出「自检」和「局域网里真有台手机」。
    // 带上这个头，服务端就不会把自检当成一台新设备登记进来（仅本机来源有效）。
    // 验设备登记的那一项会显式关掉它 —— 那里需要服务端把自己当成一台外来设备。
    const base = options.deviceProbe ? {} : { 'x-dsh-selfcheck': '1' };
    const headers = Object.assign(base, options.headers || {});
    const req = mod.get(url, { timeout: options.timeout || 8000, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
        // 注意：node:http 的 headers 没有 getSetCookie（那是 fetch API 的），
        // 这里的 set-cookie 本身就是数组
        setCookies: res.headers['set-cookie'] || []
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function probeHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__health', timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve(j && j.service === 'pocket-bridge-gateway' ? j : null);
        } catch (err) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function findGateway() {
  for (let p = 8080; p <= 8099; p++) {
    const info = await probeHealth(p);
    if (info) return { port: p, info };
  }
  return null;
}

function readLog(name) {
  try { return fs.readFileSync(path.join(LOG_DIR, name), 'utf8').trim(); }
  catch (err) { return null; }
}

// ── 检查 0：DSH 版本变化（升级检测）──────────────────────────────────────────
// 升级本身没法预防，但可以做到「升级后第一次自检就提醒你重点复查什么」，
// 而不是等到手机上出现空白或报错才发现。
/**
 * 探测 DSH 的版本号。**新旧版走不同的地方，按可靠性依次尝试。**
 *
 * 为什么必须几条都留：这个探测原来只认 `harness-runtimes` 目录，而新版 DSH
 * 已经不再创建它（实测 0.1.7-rc.2 上那个目录**根本不存在**）。于是每次探测都
 * 退化成「exe 的修改日期」，版本变化检测就名存实亡了 —— 而它恰恰是
 * 「DSH 升级了，请重点看兼容性」这条提醒的**唯一来源**。
 *
 * 顺序：
 *   ① 旧版：%APPDATA%\DeepSeek Harness Desktop\harness-runtimes\<版本号>
 *   ② 新版：<安装目录>\resources\app.asar 头部内嵌的 package.json 版本号
 *   ③ 注册表 DisplayVersion —— **新旧版都写**，最通用的一条
 *   ④ 兜底：exe 的修改日期（拿不到真版本号时至少还能感知「文件变了」）
 */
function detectDshVersion(exePath) {
  return require('./dsh-adapter.js').readDesktopVersion(exePath).version || 'unknown';
}

function readVersionFromAsar(asarPath) {
  return require('./dsh-adapter.js').readAsarVersion(asarPath);
}

async function checkDshVersion() {
  const api = require('./dsh-runtime.js');
  const conf = cfg.loadConfig();
  const runtime = await api.resolveRuntime(conf);
  const installed = api.detectInstallation(conf);
  if (!runtime.running && !installed.installed) {
    record('dsh-version', 'DSH 版本变化检测', 'warn', '找不到 DSH，无法记录版本基线');
    return;
  }
  const version = runtime.version || installed.version || 'unknown';

  const stampFile = path.join(LOG_DIR, 'dsh-version.txt');
  let previous = null;
  try { previous = fs.readFileSync(stampFile, 'utf8').trim(); } catch (err) { /* 首次 */ }
  try { fs.writeFileSync(stampFile, version, 'utf8'); } catch (err) { /* 写不了就算了 */ }

  if (previous && previous !== version) {
    record('dsh-version', 'DSH 版本变化检测', 'warn',
      `从 ${previous} 变成 ${version} —— 说明升级过。请重点看下面各项，` +
      '尤其「前端兼容补丁注入」和 WebSocket：新版本可能用到新的 Web API 或改了协议');
  } else {
    record('dsh-version', 'DSH 版本变化检测', 'pass',
      `版本 ${version}${previous ? '（与上次一致）' : '（首次记录为基线）'}`);
  }
}

// ── 检查 1：DSH 可执行文件自动发现（目标 1）────────────────────────────────────
async function checkDshDiscovery() {
  const config = cfg.loadConfig();
  const found = cfg.findDshExecutable(config.dshExecutable);
  if (found.path) {
    record('dsh-discovery', 'DSH 路径自动发现（目标 1 的一部分）', 'pass',
      `来源「${found.source}」→ ${found.path}`);
  } else {
    record('dsh-discovery', 'DSH 路径自动发现（目标 1 的一部分）', 'fail',
      '找不到 DSH 可执行文件 —— 自动拉起 DSH 会失效');
  }
}

// ── 检查 2：每机独立密钥（目标 2）─────────────────────────────────────────────
async function checkInstanceIdentity() {
  const instPath = cfg.INSTANCE_FILE;
  if (!fs.existsSync(instPath)) {
    record('instance-identity', '每机独立密钥（目标 2）', 'warn',
      '还没有 instance.json —— 下次启动会生成');
    return;
  }
  let inst;
  try { inst = JSON.parse(fs.readFileSync(instPath, 'utf8')); }
  catch (err) {
    record('instance-identity', '每机独立密钥（目标 2）', 'fail', `instance.json 损坏: ${err.message}`);
    return;
  }
  const current = cfg.machineFingerprint();
  if (inst.fingerprint === current) {
    record('instance-identity', '每机独立密钥（目标 2）', 'pass',
      `指纹匹配，实例 ${String(inst.instanceId).slice(0, 8)}…；拷贝到别的机器会自动换钥匙`);
  } else {
    record('instance-identity', '每机独立密钥（目标 2）', 'warn',
      '指纹与当前机器不符 —— 密钥会在下次启动时作废重建');
  }
}

// ── 检查 3：网络环境探测（目标 3 的一部分）────────────────────────────────────
let detectedNetwork = null;
async function checkNetworkDetect() {
  const net = cfg.detectNetwork();
  detectedNetwork = net;
  const parts = [];
  parts.push(`内网 IPv4 ${net.lanV4.length} 个`);
  if (net.lanV4.length) parts.push(`(${net.lanV4.map((x) => x.address).join(', ')})`);
  parts.push(`公网 IPv6 ${net.publicV6.length} 个`);
  record('network-detect', '网络环境探测（目标 3 的一部分）', 'pass', parts.join(' '));
}

// ── 检查 4：隧道可用性（目标 3 的一部分）──────────────────────────────────────
async function checkTunnelProviders() {
  const providers = tunnel.listProviders();
  const exe = providers.filter((p) => p.executable);
  const ready = providers.filter((p) => p.ready);
  if (ready.length > 0) {
    record('tunnel-providers', '隧道方案可用性（目标 3 的一部分）', 'pass',
      `${ready.length} 个就绪：${ready.map((p) => p.id).join(', ')}`);
  } else if (exe.length > 0) {
    record('tunnel-providers', '隧道方案可用性（目标 3 的一部分）', 'warn',
      `有可执行文件但都不就绪：${exe.map((p) => p.id).join(', ')}（检查 Cloudflare 隧道配置）`);
  } else {
    record('tunnel-providers', '隧道方案可用性（目标 3 的一部分）', 'fail',
      '没有任何隧道客户端 —— 外网入口会不可用');
  }
}

// ── 检查 5：端口避让（目标 4）────────────────────────────────────────────────
async function checkPortAvoidance() {
  const blocker = net.createServer();
  let blocked = false;
  try {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(18080, '0.0.0.0', resolve);
    });
    blocked = true;
    const picked = await cfg.findAvailablePort(18080, 5);
    if (picked && picked !== 18080) {
      record('port-avoidance', '端口自动避让（目标 4）', 'pass',
        `占住 18080 后自动选中 ${picked}`);
    } else {
      record('port-avoidance', '端口自动避让（目标 4）', 'fail', `占住 18080 后仍返回 ${picked}`);
    }
  } catch (err) {
    record('port-avoidance', '端口自动避让（目标 4）', 'warn', `测试受阻: ${err.message}`);
  } finally {
    if (blocked) await new Promise((r) => blocker.close(r));
  }
}

// ── 检查 6：跨平台入口文件（目标 5）──────────────────────────────────────────
async function checkCrossPlatform() {
  const files = [
    { p: path.join(BASE, 'scripts', 'start-gateway.bat'), label: 'Windows 入口' },
    { p: path.join(BASE, 'scripts', 'start-gateway.sh'), label: 'Unix 入口' },
    { p: path.join(BASE, 'scripts', 'gateway-daemon.js'), label: '共用启动逻辑' },
    { p: path.join(BASE, 'scripts', 'install-autostart.js'), label: '自启安装器' }
  ];
  const missing = files.filter((f) => !fs.existsSync(f.p));

  // .bat 必须是纯 ASCII：cmd.exe 用 OEM 代码页读它，非 ASCII 会破坏解析
  let batIssue = null;
  const batPath = path.join(BASE, 'scripts', 'start-gateway.bat');
  if (fs.existsSync(batPath)) {
    const bytes = fs.readFileSync(batPath);
    const nonAscii = bytes.filter((b) => b > 127).length;
    if (nonAscii > 0) batIssue = `start-gateway.bat 含 ${nonAscii} 个非 ASCII 字节，会导致执行失败`;
  }

  if (missing.length === 0 && !batIssue) {
    record('cross-platform', '跨平台入口（目标 5）', 'pass',
      `4 个入口文件齐全；.bat 编码检查通过（纯 ASCII）`);
  } else if (batIssue) {
    record('cross-platform', '跨平台入口（目标 5）', 'fail', batIssue);
  } else {
    record('cross-platform', '跨平台入口（目标 5）', 'fail',
      `缺失: ${missing.map((m) => m.label).join(', ')}`);
  }
}

// ── 检查 7：网关是否在运行 ────────────────────────────────────────────────────
let gateway = null;
async function checkGatewayAlive() {
  gateway = await findGateway();
  if (gateway) {
    record('gateway-alive', '中间层运行状态', 'pass',
      `端口 ${gateway.port}，DSH 后端端口 ${gateway.info.dshPort}`);
  } else {
    record('gateway-alive', '中间层运行状态', 'fail',
      '8080-8099 上都找不到中间层 —— 请先运行 start-gateway');
  }
}

// ── 检查 8：DSH 是否在运行 + 自动拉起能力 ────────────────────────────────────
async function checkDshAutostart() {
  const dshPort = gateway ? gateway.info.dshPort : null;
  let dshAlive = false;
  if (dshPort) {
    dshAlive = await new Promise((resolve) => {
      const s = net.connect(dshPort, '127.0.0.1');
      s.setTimeout(1500);
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('timeout', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(false));
    });
  }

  // 中间层是否具备自动拉起能力：看源码里有没有那段逻辑
  let hasAutostartCode = false;
  try {
    const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
    hasAutostartCode = src.includes('ensureDshRunning') && src.includes('ECONNREFUSED');
  } catch (err) { /* 读不到 */ }

  if (!hasAutostartCode) {
    record('dsh-autostart', 'DSH 未启动时自动拉起', 'fail', '中间层里找不到自动拉起逻辑');
    return;
  }

  if (dshAlive) {
    record('dsh-autostart', 'DSH 未启动时自动拉起', 'pass',
      `代码路径已就绪（端口 ${dshPort} 上的 DSH 正在运行，` +
      '所以这条分支此刻无法实测 —— 要验证请关掉 DSH 后用手机访问）');
  } else {
    record('dsh-autostart', 'DSH 未启动时自动拉起', 'warn',
      'DSH 当前没在运行；下次手机访问时中间层会尝试拉起它');
  }
}

// ── 检查 9：内网入口可用 ──────────────────────────────────────────────────────
let lanOk = false;
async function checkLanEntry() {
  if (!gateway) { record('lan-entry', '内网入口', 'fail', '中间层没运行，跳过'); return; }
  const key = readLog('access-key.txt');
  if (!detectedNetwork || detectedNetwork.lanV4.length === 0) {
    record('lan-entry', '内网入口', 'warn', '没有局域网地址，无法生成内网入口');
    return;
  }
  const ip = detectedNetwork.lanV4[0].address;
  const url = `http://${ip}:${gateway.port}/k/${key}`;
  const res = await httpGet(url, { timeout: 10000 });
  // 入口现在返回 302（服务端直接跳到 /，这样带密钥的地址不会渲染出来、
  // 也不会在屏幕上停留）。所以 2xx 和 3xx 都算通 —— 只认 200 会把
  // 一个安全改进误报成故障。
  const okStatus = res && (res.status === 200 || (res.status >= 300 && res.status < 400));
  if (okStatus) {
    lanOk = true;
    record('lan-entry', '内网入口', 'pass',
      `${url} → HTTP ${res.status}${res.status === 302 ? '（已跳转，地址栏不会留下密钥）' : ''}`);
  } else {
    record('lan-entry', '内网入口', 'fail', `${url} → ${res ? 'HTTP ' + res.status : '请求失败'}`);
  }
}

// ── 检查 10：外网隧道入口可用 ────────────────────────────────────────────────
async function checkWanEntry() {
  if (QUICK) { record('wan-entry', '外网入口', 'warn', '--quick 模式跳过'); return; }
  const statusFile = path.join(LOG_DIR, 'status.json');
  let wan = null;
  try { wan = (JSON.parse(fs.readFileSync(statusFile, 'utf8')).entries || {}).wan; }
  catch (err) { /* 没有状态文件 */ }

  if (!wan) { record('wan-entry', '外网入口', 'warn', '状态文件里没有隧道地址'); return; }

  const base = wan.split('/k/')[0];
  const res = await httpGet(`${base}/pair`, { timeout: 20000 });
  if (res && res.status === 200) {
    record('wan-entry', '外网入口', 'pass', `${base} → HTTP 200（经 Cloudflare）`);
  } else {
    record('wan-entry', '外网入口', 'fail',
      `${base} → ${res ? 'HTTP ' + res.status : '请求失败或超时'}`);
  }
}

// ── 检查 11：配对页 + 前端注入 + WebSocket ───────────────────────────────────
async function checkPairPage() {
  if (!gateway) { record('pair-page', '配对页', 'fail', '中间层没运行'); return; }
  const res = await httpGet(`http://127.0.0.1:${gateway.port}/pair`, { timeout: 8000 });
  if (res && res.status === 200 && res.body.includes('name="code"')) {
    const code = readLog('pair-code.txt');
    record('pair-page', '配对页', 'pass', `可访问，当前配对码 ${code}`);
  } else {
    record('pair-page', '配对页', 'fail', res ? `HTTP ${res.status}` : '请求失败');
  }
}

async function checkInjection() {
  if (!gateway) { record('injection', '前端兼容补丁注入', 'fail', '中间层没运行'); return; }
  const key = readLog('access-key.txt');
  const res = await httpGet(`http://127.0.0.1:${gateway.port}/k/${key}`, { timeout: 10000 });
  if (!res) { record('injection', '前端兼容补丁注入', 'fail', '取首页失败'); return; }

  // /k/ 返回的是自动跳转页，真正的首页需要带 cookie
  const cookieName = (() => {
    try { return JSON.parse(readLog('mint-cookie.json')).cookieName; }
    catch (err) { return null; }
  })();
  const cookieValue = (() => {
    try { return JSON.parse(readLog('mint-cookie.json')).cookieValue; }
    catch (err) { return null; }
  })();
  if (!cookieName) { record('injection', '前端兼容补丁注入', 'fail', '读不到 cookie 记录'); return; }

  const home = await httpGet(`http://127.0.0.1:${gateway.port}/`, {
    timeout: 10000,
    headers: { cookie: `${cookieName}=${cookieValue}` }
  });
  if (!home || home.status !== 200) {
    record('injection', '前端兼容补丁注入', 'fail', `带 cookie 访问首页返回 ${home ? home.status : '失败'}`);
    return;
  }
  const hasPolyfill = home.body.includes('/polyfill.js');
  const hasCompat = home.body.includes('/compat.js');
  const hasBoot = home.body.includes('/boot.js');
  const hasRoute = home.body.includes('/route.js');
  const hasFirstLoad = home.body.includes('/first-load.js');
  const beforeApp = home.body.indexOf('/polyfill.js') < home.body.indexOf('__ModuleLoader__');
  if (hasPolyfill && hasCompat && hasBoot && hasRoute && hasFirstLoad && beforeApp) {
    record('injection', '前端脚本注入', 'pass',
      'polyfill / compat / route / boot / first-load 都已注入，且排在 DSH 代码之前');
  } else {
    record('injection', '前端脚本注入', 'fail',
      `polyfill=${hasPolyfill} compat=${hasCompat} route=${hasRoute} boot=${hasBoot} ` +
      `first-load=${hasFirstLoad} 顺序正确=${beforeApp}`);
  }
}

// ── 检查 17：连接方式自动选择 ────────────────────────────────────────────────
//
// 这一项的要点是「服务端能不能认出手机从哪条路进来」—— 认不出就谈不上推荐。
// 所以这里用不同的 Host 头模拟三种进入方式，看识别结果对不对。
async function checkRouteSelection() {
  if (!gateway) { record('route-select', '连接方式自动选择', 'fail', '中间层没运行'); return; }

  let routesMod, netInfo;
  try {
    routesMod = require('./routes.js');
    netInfo = require('./config.js').detectNetwork();
  } catch (err) {
    record('route-select', '连接方式自动选择', 'fail', `模块加载失败: ${err.message}`);
    return;
  }

  // 探针必须免认证可用 —— 手机在登录前就要能测路
  const probe = await httpGet(`http://127.0.0.1:${gateway.port}/__probe`, { timeout: 5000 });
  if (!probe || probe.status !== 204) {
    record('route-select', '连接方式自动选择', 'fail',
      `连通性探针 /__probe 返回 ${probe ? probe.status : '失败'}（应为 204）`);
    return;
  }

  // /__routes 必须认证后才能看（候选地址里含密钥）
  const noAuth = await httpGet(`http://127.0.0.1:${gateway.port}/__routes`, { timeout: 5000 });
  if (!noAuth || noAuth.status !== 403) {
    record('route-select', '连接方式自动选择', 'fail',
      `未认证访问 /__routes 返回 ${noAuth ? noAuth.status : '失败'}（应为 403）`);
    return;
  }

  const key = readLog('access-key.txt');
  const cookieName = (() => {
    try { return JSON.parse(readLog('mint-cookie.json')).cookieName; }
    catch (err) { return null; }
  })();
  const cookieValue = (() => {
    try { return JSON.parse(readLog('mint-cookie.json')).cookieValue; }
    catch (err) { return null; }
  })();
  const authed = await httpGet(`http://127.0.0.1:${gateway.port}/__routes`, {
    timeout: 12000, headers: { cookie: `${cookieName}=${cookieValue}` }
  });
  if (!authed || authed.status !== 200) {
    record('route-select', '连接方式自动选择', 'fail',
      `认证后访问 /__routes 返回 ${authed ? authed.status : '失败'}`);
    return;
  }

  let data = null;
  try { data = JSON.parse(authed.body); } catch (err) { }
  if (!data || !Array.isArray(data.candidates)) {
    record('route-select', '连接方式自动选择', 'fail', '返回内容不是预期的结构');
    return;
  }

  // 三种进入方式都要认得出
  const probes = [
    ['内网地址', { host: `${netInfo.lanV4[0] ? netInfo.lanV4[0].address : '192.168.1.3'}:${gateway.port}` }, 'lan'],
    ['隧道域名', { host: 'x.trycloudflare.com', 'x-forwarded-proto': 'https' }, 'tunnel'],
    ['回环', { host: `127.0.0.1:${gateway.port}` }, 'loopback']
  ];
  const wrong = [];
  for (const [name, headers, expect] of probes) {
    const got = routesMod.arrivalOf({ headers, socket: { remoteAddress: '9.9.9.9' } }, netInfo);
    if (got.kind !== expect) wrong.push(`${name} 认成 ${got.kind}（应为 ${expect}）`);
  }
  if (wrong.length) {
    record('route-select', '连接方式自动选择', 'fail', wrong.join('；'));
    return;
  }

  const kinds = data.candidates.map((c) => c.kind);
  const uniq = kinds.filter((k, i) => kinds.indexOf(k) === i);
  record('route-select', '连接方式自动选择', 'pass',
    `认出 ${uniq.length} 类路径（${uniq.join('/')}），进入方式识别正确，探针免认证、分析需认证`);
}

// ── 检查 18：设备身份可分辨、可单独吊销 ──────────────────────────────────────
//
// 这一项验的是「能不能只把一台设备关在门外」。所以不只看接口在不在，
// 而是真的登记两台、真的吊销一台、再看另一台是否完好。
async function checkDevices() {
  if (!gateway) { record('devices', '设备登记与单独吊销', 'fail', '中间层没运行'); return; }

  let sessions;
  try { sessions = require('./sessions.js'); }
  catch (err) { record('devices', '设备登记与单独吊销', 'fail', `模块加载失败: ${err.message}`); return; }

  const key = readLog('access-key.txt');
  const uaA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1';
  const uaB = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36';

  // 要验设备登记，就得让请求看起来像是从外面来的手机。
  // Host 用内网地址是没用的 —— 从本机连自己的内网地址，服务端仍然认得出来是本机。
  // 所以用一个明确合成的主机名，模拟「经隧道进来的手机」。
  const host = `selfcheck.invalid:${gateway.port}`;
  const hdr = (ua) => ({ 'user-agent': ua, host });

  const a = await httpGet(`http://127.0.0.1:${gateway.port}/k/${key}`,
    { timeout: 8000, headers: hdr(uaA), deviceProbe: true });
  const b = await httpGet(`http://127.0.0.1:${gateway.port}/k/${key}`,
    { timeout: 8000, headers: hdr(uaB), deviceProbe: true });
  if (!a || !b) { record('devices', '设备登记与单独吊销', 'fail', '配对请求失败'); return; }

  const cookieOf = (r) => (r.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
  const cA = cookieOf(a);
  const cB = cookieOf(b);

  if (!/dsh-gw-session=/.test(cA)) {
    record('devices', '设备登记与单独吊销', 'fail', '配对后没有拿到设备令牌');
    return;
  }

  const list = sessions.list();
  const devA = list.find((d) => /iPhone/.test(d.label) && d.active);
  const devB = list.find((d) => /Android/.test(d.label) && d.active);
  if (!devA || !devB) {
    record('devices', '设备登记与单独吊销', 'fail',
      `设备名识别异常: ${list.map((d) => d.label).join(', ')}`);
    return;
  }

  // 关掉 A，看 B 有没有被误伤 —— 这是这个功能存在的全部理由
  sessions.revoke(devA.id);
  const afterA = await httpGet(`http://127.0.0.1:${gateway.port}/`, { timeout: 8000, headers: { cookie: cA, host } });
  const afterB = await httpGet(`http://127.0.0.1:${gateway.port}/`, { timeout: 8000, headers: { cookie: cB, host } });

  const aBlocked = !afterA || afterA.status !== 200;
  const bFine = afterB && afterB.status === 200 && afterB.body.includes('__ModuleLoader__');

  // 收尾：把自检造出来的这两台彻底删掉，别污染使用者自己的设备列表。
  // 用 remove 而不是 revoke —— 「注销」是留给真实设备的状态，自检的痕迹不该留下。
  sessions.remove(devA.id);
  sessions.remove(devB.id);

  if (aBlocked && bFine) {
    record('devices', '设备登记与单独吊销', 'pass',
      '两台设备各自登记、各自命名；吊销其中一台后，另一台不受影响');
  } else {
    record('devices', '设备登记与单独吊销', 'fail',
      `被吊销的设备是否被拦住=${aBlocked}，另一台是否正常=${bFine}`);
  }
}

// ── 检查 19：内网 HTTPS ───────────────────────────────────────────────────────
//
// 这一项即使在「没开启」的时候也要给出结论 —— 「没开」本身就是一个需要被看见的
// 安全状态（内网是明文），而不是「没什么可报的」。
async function checkLanHttps() {
  let certMod;
  try { certMod = require('./make-cert.js'); }
  catch (err) { record('lan-https', '内网 HTTPS', 'fail', `模块加载失败: ${err.message}`); return; }

  let conf = {};
  try { conf = require('./config.js').loadConfig(); } catch (err) { }
  const enabled = !!(conf.lanHttps && conf.lanHttps.enabled);

  const info = certMod.inspect();
  if (!info.present) {
    record('lan-https', '内网 HTTPS', enabled ? 'fail' : 'warn',
      enabled
        ? '配置里开着，但证书还没生成 —— 重启服务会自动建'
        : '未开启（内网是明文 HTTP，同一 WiFi 下可被嗅探）。想开启：控制台里有开关');
    return;
  }
  if (info.broken) {
    record('lan-https', '内网 HTTPS', 'fail', info.broken);
    return;
  }

  const v = certMod.verify();
  if (!v.ok) {
    record('lan-https', '内网 HTTPS', 'fail', v.problems.join('；'));
    return;
  }

  if (!enabled) {
    record('lan-https', '内网 HTTPS', 'warn',
      `未开启（内网是明文 HTTP，同一 WiFi 下可被嗅探）。证书已备好，还剩 ${info.daysLeft} 天`);
    return;
  }

  // gateway 的结构是 { port, info }，加密端口在 info 里（findGateway 的返回值形状）
  const httpsPort = (gateway.info && gateway.info.httpsPort) || 0;
  if (!gateway || !httpsPort) {
    record('lan-https', '内网 HTTPS', 'fail',
      '配置里开着，但服务端没有在加密端口上监听（看 logs/proxy.log 里证书相关的报错）');
    return;
  }

  // 真的连一次，并且验证「用本地 CA 能验过、不用 CA 验不过」
  const ca = fs.readFileSync(certMod.CA_CERT);
  const https = require('https');
  const fetchOnce = (useCa) => new Promise((resolve) => {
    const r = https.request({
      host: '127.0.0.1', port: httpsPort, path: '/__probe',
      servername: 'localhost',
      ...(useCa ? { ca } : {}),
      rejectUnauthorized: true
    }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', (e) => resolve(e.code || e.message));
    r.end();
  });

  const trusted = await fetchOnce(true);
  const untrusted = await fetchOnce(false);

  if (trusted === 204 && typeof untrusted === 'string') {
    record('lan-https', '内网 HTTPS', 'pass',
      `:${httpsPort} 已在监听；证书由本地 CA 签发（还剩 ${info.daysLeft} 天），` +
      '装了 CA 能验过、没装则提示自签 —— 符合预期');
  } else {
    record('lan-https', '内网 HTTPS', 'fail',
      `带 CA 请求=${trusted}（应为 204），不带 CA=${untrusted}（应为证书错误）`);
  }
}

// ── 检查 20：Codex 的版本与路径 ──────────────────────────────────────────────
//
// 升级这件事对这个项目有两层影响：
//   1. CLI 装在 LocalAppData 下一个**带哈希的目录**里，升级会换目录 ——
//      写死路径的话一次更新就废了，而且会静默地继续用旧版本
//   2. 协议可能变。这个只能做到「发现变了」，不保证兼容
async function checkCodexVersion() {
  let t;
  try { t = require('./targets.js').codex; }
  catch (err) { record('codex-version', 'Codex 版本与路径', 'warn', `模块加载失败: ${err.message}`); return; }

  const d = t.detect();
  if (!d.installed) {
    record('codex-version', 'Codex 版本与路径', 'warn', '没找到 Codex（这一项跳过，不影响 DSH）');
    return;
  }

  // 版本目录是带哈希的，路径里应当有那一层 —— 说明是自动发现的
  const autoFound = /bin[\\/][0-9a-f]{8,}/i.test(d.exe || '');

  // 读版本号。
  //
  // ★ 失败原因必须留下来。
  //   原来这里写的是 `catch (err) { ver = ''; }` —— 把错误**直接扔掉**了。
  //   结果就是自检报告里只有一句「（读不到版本号）」，而单独运行
  //   同一条命令明明能拿到版本。没有错误信息，就只能靠猜（我猜过是超时、
  //   是文件被占用、是代理干扰），全是白费功夫。
  let ver = '';
  let verErr = '';
  try {
    ver = execFileSync(d.exe, ['--version'], { encoding: 'utf8', timeout: 12000, windowsHide: true })
      .trim().split('\n')[0];
  } catch (err) {
    verErr = (err && (err.message || String(err))) || '未知错误';
    if (err && err.stderr) verErr += ' | stderr: ' + String(err.stderr).slice(0, 120);
  }

  const file = path.join(LOG_DIR, 'codex-version.txt');
  const prev = (() => { try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return null; } })();

  // 只写**真的版本号**。
  //
  // 原来是 `ver || d.exe` —— 读不到版本就把**可执行文件的路径**写进版本文件。
  // 后果有两层：
  //   1. 那个文件从此装的是一行路径，名字叫 version 却存着别的东西；
  //   2. 下一次运行拿它当「上一个版本」比对，会报出
  //      「Codex 从 C:\...\codex.exe 变成了 0.154…」这种莫名其妙的告警。
  // 读不到就不写 —— 保留上一次的真实版本号，比写进去一行假的强。
  if (ver) { try { fs.writeFileSync(file, ver, 'utf8'); } catch (e) { /* 写不了不影响 */ } }

  if (!autoFound) {
    record('codex-version', 'Codex 版本与路径', 'warn',
      `可执行文件不是自动发现的（来源：${d.source}）—— 升级后可能失效`);
    return;
  }

  // 只拿**看起来像版本号**的历史值来比。文件里可能是早期版本写进去的路径，
  // 拿它比会报出无意义的「版本变化」。
  const prevLooksLikeVersion = !!prev && /^[a-z-]*\s*\d+\.\d+/.test(prev) && !/[\\/]/.test(prev);

  if (prevLooksLikeVersion && ver && prev !== ver) {
    record('codex-version', 'Codex 版本与路径', 'warn',
      `Codex 从 ${prev} 变成了 ${ver} —— 路径是自动发现的，已经跟上了；` +
      '但协议可能有变化，建议把手机上的会话、审批、发消息各试一遍');
    return;
  }

  record('codex-version', 'Codex 版本与路径', ver ? 'pass' : 'warn',
    ver
      ? `${ver}；路径自动发现，升级换了目录也能跟上（来源：${d.source}）`
      : `读不到版本号（${verErr}）—— 不影响使用，只是升级后没法自动提醒你协议可能变了`);
}

// ── 检查 21：任务完成通知 ────────────────────────────────────────────────────
//
// 这一项之前完全没有 —— 于是「通知没来」的时候，使用者只能猜。
// 通知要三样东西同时在位：配了通道、手机订阅了 Web Push、干完活有人触发。
// 缺哪一样都静默失败，所以这里逐样查。
async function checkNotifications() {
  const conf = (() => {
    try { return require('./config.js').loadConfig(); } catch (err) { return {}; }
  })();

  const targetsFile = path.join(LOG_DIR, 'notify-targets.json');
  let targets = null;
  try { targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8')); } catch (err) { targets = null; }

  const channels = [];
  if (targets && targets.bark) channels.push('Bark');
  if (targets && targets.ntfy) channels.push('ntfy');

  let subs = 0;
  try {
    subs = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'push-subscriptions.json'), 'utf8')).length;
  } catch (err) { subs = 0; }

  if (!channels.length && !subs) {
    record('notifications', '任务完成通知', 'warn',
      '一个推送通道都没配，所以干完活不会响。两种配法（选一个就行）：'
      + '① 手机上打开页面点「开启通知」（需要走 HTTPS 那条件，比如隧道地址）；'
      + `② 在 ${targetsFile} 里填 {"ntfy":"https://ntfy.sh/你的主题"}（安卓）`
      + '或 {"bark":"https://api.day.app/你的key"}（iPhone）');
    return;
  }

  const parts = [];
  if (channels.length) parts.push(`推送通道：${channels.join(' + ')}`);
  else parts.push('没有配置外部推送通道');

  // 「手机订阅 N 台」这句话原来只数 Web Push —— 而用 ntfy/Bark 的人
  //（也就是绝大多数）**永远是 0**。使用者看到「手机订阅：0 台」会以为
  // 通知没配好，实际上他的 ntfy 订阅得好好的。
  //
  // 两路要分开说：
  //   · ntfy / Bark —— 手机在**它们自己的 App**里订阅，我们这边看不到订阅数，
  //     所以只能报「已配置 + 实测投递成不成功」，不能报「0 台」；
  //   · Web Push —— 订阅记录在我们自己的文件里，才数得出来。
  const extChannels = channels.filter((c) => /ntfy|Bark/i.test(c));
  if (extChannels.length) {
    parts.push(`${extChannels.join('/')} 的订阅在手机 App 里，这边看不到数量（下面实测投递）`);
  }
  if (subs > 0) parts.push(`网页推送订阅：${subs} 台`);
  else if (!extChannels.length) parts.push('网页推送订阅：0 台');

  // 真的发一条试试 —— 只报「配置存在」是不够的，通道可能早失效了
  let delivered = null;
  if (channels.length && gateway) {
    const r = await httpGet(
      `http://127.0.0.1:${gateway.port}/__notify?title=${encodeURIComponent('自检')}` +
      `&body=${encodeURIComponent('这是一条测试通知，收到就说明通了')}`,
      { timeout: 20000 });
    if (r && r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        delivered = (j.results || []).map((x) => `${x.channel}:${x.ok ? 'ok' : (x.error || x.status)}`);
      } catch (err) { delivered = ['返回读不出来']; }
    } else {
      delivered = [`请求失败 ${r ? r.status : ''}`];
    }
    parts.push(`实测投递：${(delivered || []).join(' ')}`);
  }

  const allOk = channels.length > 0 && (!delivered || delivered.every((d) => /ok$/.test(d)));
  record('notifications', '任务完成通知', allOk ? 'pass' : 'warn', parts.join('；'));
}

// ── 检查 12：安全基础 ─────────────────────────────────────────────────────────
async function checkSecurityBasics() {
  if (!gateway) { record('security-basics', '安全基础', 'fail', '中间层没运行'); return; }
  const port = gateway.port;
  const key = readLog('access-key.txt');
  const notes = [];
  let ok = true;

  // 无密钥访问首页 → 必须 403
  const noKey = await httpGet(`http://127.0.0.1:${port}/`, { timeout: 8000 });
  if (noKey && noKey.status === 403) notes.push('无密钥→403 ✓');
  else { notes.push(`无密钥→${noKey ? noKey.status : '失败'} ✗`); ok = false; }

  // 错误密钥 → 必须 403
  const badKey = await httpGet(`http://127.0.0.1:${port}/k/definitely-not-the-key`, { timeout: 8000 });
  if (badKey && badKey.status === 403) notes.push('错误密钥→403 ✓');
  else { notes.push(`错误密钥→${badKey ? badKey.status : '失败'} ✗`); ok = false; }

  // 无密钥时必须不种 cookie
  if (noKey && noKey.setCookies.some((c) => c.startsWith('dsh-auth-'))) {
    notes.push('无密钥却种了 cookie ✗'); ok = false;
  } else {
    notes.push('无密钥不种 cookie ✓');
  }

  record('security-basics', '安全基础（无密钥/错误密钥）', ok ? 'pass' : 'fail', notes.join('  '));
}

// ── 检查 13：敏感端点的访问控制 ──────────────────────────────────────────────
async function checkSensitiveEndpoints() {
  if (!gateway) { record('sensitive-endpoints', '敏感端点访问控制', 'fail', '中间层没运行'); return; }
  const port = gateway.port;
  const notes = [];

  // /__notify 和 /__health 都只允许回环；从本机访问应成功
  const notify = await httpGet(`http://127.0.0.1:${port}/__notify?title=probe&body=self-check`, { timeout: 15000 });
  if (notify && notify.status === 200) notes.push('/__notify 本机可用 ✓');
  else notes.push(`/__notify ${notify ? notify.status : '失败'}`);

  const health = await httpGet(`http://127.0.0.1:${port}/__health`, { timeout: 5000 });
  if (health && health.status === 200) notes.push('/__health 本机可用 ✓');
  else notes.push(`/__health ${health ? health.status : '失败'}`);

  // 从局域网地址访问 /__health 应当被拒（它只认回环）
  if (detectedNetwork && detectedNetwork.lanV4.length) {
    const ip = detectedNetwork.lanV4[0].address;
    const lanHealth = await httpGet(`http://${ip}:${port}/__health`, { timeout: 5000 });
    if (lanHealth && lanHealth.status === 403) notes.push('局域网访问 /__health → 403 ✓');
    else notes.push(`局域网访问 /__health → ${lanHealth ? lanHealth.status : '失败'} ✗`);

    // /__recover 会**凭空签发一张能进门的凭证**，所以必须和 /__health 一样只认回环。
    //
    // 这条断言是拿一次虚惊换来的：我最初用 isLocalRequest 判定，而那个判定
    // 认为「本机访问自己的内网地址」也算本机 —— 于是我从本机连 192.168.1.3
    // 测试时它返回了 200，看着像个大洞。推理下来真手机其实进不来
    // （来源地址不是本机），但「推理出来的安全」不该当成安全。
    // 现在改用 isLoopback，并用这条断言把它钉死。
    const lanRecover = await httpGet(`http://${ip}:${port}/__recover`, { timeout: 5000 });
    if (lanRecover && lanRecover.status === 403) notes.push('局域网访问 /__recover → 403 ✓');
    else {
      notes.push(`局域网访问 /__recover → ${lanRecover ? lanRecover.status : '失败'} ✗（这等于把进门凭证发给整个局域网）`);
      ok = false;
    }
  }

  // /__notify 的判据是「来源是不是本机地址」，而自检就跑在本机 ——
  // 连回环、连自己的内网 IP，来源都是本机，所以必然通过，测不出结论。
  // 真正要验的是判据本身：拿不属于本机的地址去问，必须返回否。
  try {
    const cfgMod = require('./config.js');
    const foreignRejected = ['203.0.113.7', '198.51.100.9', '2001:db8::1', '192.168.99.99']
      .every((a) => cfgMod.isOwnAddress(a) === false);
    const ownAccepted = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
      .every((a) => cfgMod.isOwnAddress(a) === true);
    if (foreignRejected && ownAccepted) {
      notes.push('/__notify 只认本机判据正确 ✓（外部地址一律被拒）');
    } else {
      notes.push(`/__notify 判据有问题 ✗（外部被拒=${foreignRejected} 本机被认=${ownAccepted}）`);
    }
  } catch (err) {
    notes.push(`/__notify 判据验不了 ✗（${err.message}）`);
  }

  const allGood = notes.every((n) => n.includes('✓'));
  record('sensitive-endpoints', '敏感端点访问控制', allGood ? 'pass' : 'warn', notes.join('  '));
}

// ── 输出报告 ──────────────────────────────────────────────────────────────────
function printReport() {
  const icon = { pass: '[OK]  ', warn: '[注意]', fail: '[失败]' };
  const line = '='.repeat(72);

  process.stdout.write(`\n${line}\n  DSH 移动端网关 — 全能力自检\n${line}\n`);
  process.stdout.write(`  机器: ${os.hostname()}  平台: ${process.platform}  时间: ${new Date().toLocaleString()}\n\n`);

  for (const r of results) {
    process.stdout.write(`${icon[r.status]} ${r.title}\n`);
    process.stdout.write(`        ${r.detail}\n`);
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const warn = results.filter((r) => r.status === 'warn').length;
  const fail = results.filter((r) => r.status === 'fail').length;

  process.stdout.write(`\n${line}\n`);
  process.stdout.write(`  通过 ${pass} 项   注意 ${warn} 项   失败 ${fail} 项\n`);
  process.stdout.write(`${line}\n`);

  if (fail === 0 && warn === 0) {
    process.stdout.write('  结论: 全部能力就绪。\n');
  } else if (fail === 0) {
    process.stdout.write('  结论: 核心能力可用，有若干项需要注意（详见上面）。\n');
  } else {
    process.stdout.write('  结论: 有失败项，部分能力不可用（详见上面）。\n');
  }

  // 把结果落盘，方便事后比对
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'self-check.json'),
      JSON.stringify({ ranAt: new Date().toISOString(), platform: process.platform,
        summary: { pass, warn, fail }, results }, null, 2), 'utf8');
    process.stdout.write(`  结果已存: ${path.join(LOG_DIR, 'self-check.json')}\n`);
  } catch (err) { /* 写不了就算了 */ }
  process.stdout.write('\n');
}

(async () => {
  await checkDshVersion();
  await checkDshDiscovery();
  await checkInstanceIdentity();
  await checkNetworkDetect();
  await checkTunnelProviders();
  await checkPortAvoidance();
  await checkCrossPlatform();
  await checkGatewayAlive();
  await checkDshAutostart();
  await checkLanEntry();
  await checkWanEntry();
  await checkPairPage();
  await checkInjection();
  await checkRouteSelection();
  await checkDevices();
  await checkLanHttps();
  await checkCodexVersion();
  await checkNotifications();
  await checkSecurityBasics();
  await checkSensitiveEndpoints();
  printReport();
})();
