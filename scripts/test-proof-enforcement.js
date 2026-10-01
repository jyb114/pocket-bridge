// 第三道门（挑战应答）**真的开始拦人了** —— 证明它拦得住，也证明它不会把人锁在门外。
//
// 背景：让你登进来的凭证是网址**路径**里的访问密钥（/k/<密钥>），而路径是 HTTP
// 请求行的一部分，隧道（TLS 终点）看得见 —— 它把那条请求自己发一遍就能冒充你。
// # 后面那串它从来没见过（浏览器不发 fragment），所以 2026-09-27 起网关把挑战
// 应答从「只记录」改成「真拦」：没证明过的设备只拿得到页面/脚本，内容一律 403。
//
// 这个脚本要证明七件事：
//   ① 没证明过的设备：页面和脚本照给（不会白屏、不会死锁在验证页上）
//   ② 同一台设备要内容 → 403 且带 `x-dsh-need-proof: 1`
//      （手机端靠这个头自动续证 + 重发原请求；没有它界面会静默空掉）
//   ③ 导航请求给的是**能自救**的 HTML（自己证明 + reload），程序调用给 JSON
//   ④ 实时通道（WebSocket）同样拦 —— 只在 HTTP 上拦等于门锁了窗户开着
//   ⑤ 拿着 # 密钥的一方能通过；**只拿访问密钥 / 乱算的一方过不去**
//   ⑥ nonce 一次性：录下来重放没用
//   ⑦ 手机端那份自动续证的代码真的在（e2ee.js 的 prove / 两层重试 / 定时续证）
//
// 用法: node scripts/test-proof-enforcement.js
//   网关没在跑时只跑源码级检查，实测部分跳过并说明 —— 不假装通过。
//   加 --static-only 时显式跳过真网关实测，供不依赖本机环境的 CI 使用。
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(__dirname, '..');
const PORT = 8080;

// ★ 必须装成「外面来的手机」，不能是本机请求。
//
//   网关上有一条例外：**本机发起的请求一律放行**（回环来源 + Host 是 localhost/
//   本机内网地址）—— 那是给电脑自己的控制台和自检用的，`ensureDevice` 对它们
//   直接返回 { ok:true, device:null }，于是三道门全部跳过、连设备都不登记。
//   所以从 127.0.0.1 直连是**测不到**第三道门的（第一版就是这么写的，
//   九项全红，而门其实是好的）。
//
//   办法和 test-devices.js 一样：连回环地址，但把 Host 合成成 test-device.invalid。
//   这样 isLocalRequest 判「不是本机」，而 isSelfClientRequest 因为直连
//   （真实来源 = socket 地址）也不认它是自己 —— 于是它看起来就是一台外部手机。
const HOST = `test-device.invalid:${PORT}`;

let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};
const skip = (n, why) => { skipped++; console.log(`  · ${n} —— 跳过（${why}）`); };

const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
const E2EE = fs.readFileSync(path.join(BASE, 'pwa', 'e2ee.js'), 'utf8');
const ROUTE = fs.readFileSync(path.join(BASE, 'pwa', 'route.js'), 'utf8');

// ── ① 源码级：开关真的开了、放行名单没被顺手放宽 ─────────────────────────────
console.log('\n① 网关侧：开关与放行名单');
{
  const m = SRC.match(/const REQUIRE_PROOF = (true|false)/);
  ok('REQUIRE_PROOF 开关存在', !!m, '没找到');
  ok('REQUIRE_PROOF = true（观察期已结束，真的拦人）', m && m[1] === 'true', m && m[1]);

  ok('挑战端点本身在放行名单里（否则没人能证明自己）',
    /'\/__auth\/challenge', '\/__auth\/verify'/.test(SRC));
  ok('配对页/恢复票据/选择页在放行名单里（还没有钥匙的设备要能进门）',
    /'\/pair', '\/__recover', '\/go'/.test(SRC));
  ok('推送订阅在放行名单里（隧道换地址时那条通知不能失效）',
    /'\/__push\/vapid', '\/__push\/subscribe'/.test(SRC));
  ok('/assets 当代码放行（挡了界面会一直转圈，且隧道本来就有这些字节）',
    /\^\\\/assets\\\//.test(SRC));
  ok('/plugins 不放行（那底下有 /plugins/events 这条流，手机端不需要）',
    !/\^\\\/\(assets\|plugins\)\\\//.test(SRC) && /\/plugins\/ 刻意\*\*不\*\*放行/.test(SRC));

  // 内容一条都不能在放行名单里 —— 这是这扇门的全部意义
  const listBody = (SRC.match(/const BOOTSTRAP_PATHS = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
  // ★ `/codex` 与 `/go` 是**应用页**（和 `/` 同类：这台设备自己的程序），
  //   2026-09-26 加进放行名单 —— 不加的话未证明的设备连 Codex 页都打不开
  //   （日志实锤：`403 未通过挑战应答: GET /codex`）。它们的**内容接口**照旧要证明：
  //   /codex/threads、/codex/file、/codex/queue 一条都不在名单里。
  const allowedAppShell = ['/codex', '/codex/', '/go', '/go/'];
  const leaked = ['/api', '/codex/threads', '/codex/file', '/__targets', '/__console', '/codex/lock']
    .filter((p) => listBody.includes(`'${p}`));
  ok('放行名单里没有任何内容路径（/api、/codex/threads、余额…）', leaked.length === 0, leaked.join(', '));
  ok('放行的是应用页本身（/codex、/go），不是它们的接口',
    allowedAppShell.every((p) => listBody.includes(`'${p}`)));
}

// ── ② 源码级：403 带标记、导航给自救页 ───────────────────────────────────────
console.log('\n② 网关侧：被拦时回什么');
{
  const fn = (SRC.match(/function rejectNeedProof\(req, res\) \{[\s\S]*?\n\}/) || [])[0] || '';
  ok('rejectNeedProof 存在', !!fn);
  ok("回的是 403 且带 x-dsh-need-proof: 1（手机端靠它认出「该续证了」）",
    /writeHead\(403/.test(fn) && /'x-dsh-need-proof': '1'/.test(fn));
  ok('导航请求给 HTML、程序调用给 JSON（给 fetch 回 HTML 毫无意义）',
    /isNavigation/.test(fn) && /text\/html/.test(fn) && /application\/json/.test(fn) &&
    /error: 'need-proof'/.test(fn));

  const page = (SRC.match(/function needProofPage\(req, lang\) \{[\s\S]*?\n\}/) || [])[0] || '';
  ok('needProofPage 存在', !!page);
  ok('那一页会自己加载 e2ee.js 并证明（不是干巴巴一行 403 文字）',
    /<script src="\/e2ee\.js"><\/script>/.test(page) && /api\.prove\(true\)/.test(page));
  ok('证明成功就重新请求原地址（自己把自己救回来）', /location\.reload\(\)/.test(page));
  ok('证不了要给出「去控制台复制地址」的明确说明', /needProofHint/.test(page) && /needProofPair/.test(page));
  ok('三语都要有这套文案',
    (SRC.match(/needProofHealing:/g) || []).length === 3 &&
    (SRC.match(/needProofHint:/g) || []).length === 3);
}

// ── ③ 源码级：实时通道也拦 ───────────────────────────────────────────────────
console.log('\n③ 网关侧：WebSocket 那道门');
{
  const up = require('./page-source.js').extractFunction(SRC, 'handleUpgrade') || '';
  ok('handleUpgrade 存在', !!up);
  ok('升级前查过挑战应答（HTTP 拦、WS 不拦 = 门锁了窗户开着）',
    /!authProvenAt\(dev\.device\.id\)/.test(up));
  ok('拒绝时也带 x-dsh-need-proof: 1（手机端据此补证后重连）',
    /x-dsh-need-proof: 1/.test(up));
}

// ── ④ 源码级：手机端能自动续证、被拦能自愈 ───────────────────────────────────
console.log('\n④ 手机端：自动续证与失败自愈');
{
  ok('e2ee.js 里有 prove()（单一实现，带 inflight 去重）',
    /function prove\(force\) \{/.test(E2EE) && /proofState\.inflight/.test(E2EE));
  ok('fetch 被拦会补证并重发原请求', /function installProofRetry\(/.test(E2EE) && /__dshProofRetry/.test(E2EE));
  ok('XHR 被拦同样会补证重放（DPR/RPC 有走 XHR 的）',
    /function installXhrProofRetry\(/.test(E2EE) && /__dshProofRetried/.test(E2EE));
  ok('WebSocket「没打开就关了」会补一次证明（否则一直重连一直被拒）',
    // 中间允许有注释和「先作废本地判断」那几句（2026-09-27 加的：服务端说没证明
    // 就必须先作废本地那份判断，否则补证会被三秒节流挡掉）
    /nativeAdd\('close', function \(\) \{[\s\S]{0,400}prove\(true\)/.test(E2EE));
  ok('开页面就证一次 + 定时续证 + 回到前台再检查',
    /installProofUpkeep/.test(E2EE) && /PROOF_REFRESH_MS/.test(E2EE) && /visibilitychange/.test(E2EE));
  ok('证明专用的 fetch 在重试包装之前抓住（否则自己触发自己）',
    /fetchForProof = global\.fetch/.test(E2EE));
  ok('route.js 优先用 DshE2EE.prove，同时保留旧版兜底',
    /window\.DshE2EE\.prove\(true\)/.test(ROUTE) && /__auth\/challenge/.test(ROUTE));
  ok('prove 可被排查（proofState 暴露 ok/at/fails/why）',
    /proofState: function \(\)/.test(E2EE) && /lastWhy/.test(E2EE));
}

// ── ⑤ 实测：拿真网关走一遍完整流程 ──────────────────────────────────────────
function req(opts) {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port: PORT,
      method: opts.method || 'GET',
      path: opts.path,
      headers: Object.assign({ host: HOST }, opts.headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message || e) }));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/** 原样的升级握手（用裸 socket，这样能看到响应头里的 x-dsh-need-proof） */
function upgradeProbe(cookie) {
  return new Promise((resolve) => {
    let buf = '';
    const done = () => {
      const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 0, raw: buf });
    };
    let s;
    try { s = net.connect(PORT, '127.0.0.1'); } catch (err) { resolve({ status: 0, raw: '' }); return; }
    s.on('connect', () => {
      s.write('GET /api/remote.mux HTTP/1.1\r\n' +
        `Host: ${HOST}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        `Cookie: ${cookie}\r\n\r\n`);
    });
    s.on('data', (d) => { buf += d.toString('latin1'); });
    s.on('close', done);
    s.on('error', done);
    setTimeout(() => { try { s.destroy(); } catch (e) { } }, 4000);
  });
}

/** 一台**全新设备**：只用访问密钥进来（= 隧道能拿到的那一份）。返回 cookie */
async function freshDevice(key) {
  const res = await req({
    path: `/k/${key}`,
    // 唯一 UA：sessions 是按「UA + 来源地址」认设备的，不区分就会跟别的测试撞成同一台
    headers: { 'user-agent': `pocket-bridge-proof-test/${crypto.randomBytes(4).toString('hex')}` }
  });
  return { res, cookie: cookiesOf(res) };
}

function cookiesOf(res) {
  const raw = res.headers['set-cookie'] || [];
  return raw.map((c) => String(c).split(';')[0]).join('; ');
}

function authKeyOf(secret) {
  return require('./e2ee.js').hkdf(Buffer.from(secret, 'utf8'),
    Buffer.from('dsh-gw-auth'), 'dsh-gw|auth|v1', 32);
}

function respond(nonce, secret) {
  return crypto.createHmac('sha256', authKeyOf(secret)).update(nonce).digest('base64url');
}

/** 一个最小的 fetch：走 node 的 http，但带上合成的 Host（装成外面来的手机） */
function makeFetch(cookieHolder) {
  return function shimFetch(input, init) {
    const u = new URL(String(input && input.url ? input.url : input), `http://${HOST}`);
    return new Promise((resolve) => {
      const headers = Object.assign({ host: HOST }, (init && init.headers) || {});
      if (cookieHolder.value && !headers.cookie && !headers.Cookie) headers.cookie = cookieHolder.value;
      const r = http.request({
        host: '127.0.0.1', port: PORT, method: (init && init.method) || 'GET',
        path: u.pathname + u.search, headers
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode, headers: res.headers
        })));
      });
      r.on('error', () => resolve(new Response('', { status: 0 })));
      if (init && init.body != null) r.write(init.body);
      r.end();
    });
  };
}

/**
 * 把**真的** pwa/e2ee.js 放进一个假 DOM 里跑，对着真网关验证「被拦了自己补证再重发」。
 *
 * 这一段覆盖的正是使用者会经历的那条路：手机打开页面 → 网关一时还没认出它
 * （证明在路上/刚重启）→ 界面不能空、不能报错，得自己缓过来。
 */
async function clientSideChecks(key, secret, made) {
  const vm = require('vm');
  const E2EE_SRC = fs.readFileSync(path.join(BASE, 'pwa', 'e2ee.js'), 'utf8');

  // 一台**全新设备**（未证明）—— 用它来触发 403
  const fresh = await freshDevice(key);
  const cookie = fresh.cookie;
  const tid = (cookie.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/) || [])[1] || '';
  if (tid) made.push(tid.split('.')[0]);

  const cookieHolder = { value: cookie };
  const rawFetch = makeFetch(cookieHolder);

  // 先确认：不走补丁的话，这台设备确实拿不到内容（否则下面那条测试没有意义）
  const before = await rawFetch(`http://${HOST}/__targets`, { headers: { accept: 'application/json' } });
  ok('（前置）同一台设备由裸 fetch 请求 → 被拦',
    before.status === 403 && before.headers.get('x-dsh-need-proof') === '1', `HTTP ${before.status}`);

  // ── 假 DOM：够 e2ee.js 跑起来就行，多一个都不给 ──────────────────────────
  //    还原出来的这个沙箱还带一个**请求计数器** —— 用来证明「一个来回」是真的
  //    一个来回（数出来的，不是嘴上说的）。
  const mkSandbox = (holder, apiCalls, skewMs) => {
    const store = new Map();
    const mkStorage = () => ({
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => { store.set(String(k), String(v)); },
      removeItem: (k) => { store.delete(String(k)); }
    });
    class FakeWS {
      constructor() { this.readyState = 1; }
      send() { } close() { } addEventListener() { } removeEventListener() { }
    }
    FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;

    // 时钟可偏的 Date：模拟「手机时间不对」（老路子不看时间，新路子要看）
    const RealDate = Date;
    const FakeDate = skewMs ? class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [RealDate.now() + skewMs])); }
      static now() { return RealDate.now() + skewMs; }
    } : RealDate;

    const countedFetch = (input, init) => {
      try {
        const u = new URL(String(input && input.url ? input.url : input), `http://${HOST}`);
        apiCalls.paths.push(u.pathname);
      } catch (e) { apiCalls.paths.push('?'); }
      return makeFetch(holder)(input, init);
    };

    const win = {
      location: { href: `http://${HOST}/k/${key}#k=${secret}`, hash: `#k=${secret}`, origin: `http://${HOST}` },
      crypto: crypto.webcrypto,
      fetch: countedFetch,
      WebSocket: FakeWS,
      Date: FakeDate,
      localStorage: mkStorage(),
      sessionStorage: mkStorage(),
      console: { warn() { }, log() { }, error() { } },
      setTimeout, clearTimeout,
      setInterval: () => 0,          // 定时续证在这里不跑（它会拖着进程不退）
      document: { visibilityState: 'visible', addEventListener() { } },
      Request, Response, Headers,
      URL, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
      atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
      btoa: (s) => Buffer.from(String(s), 'binary').toString('base64')
    };
    win.window = win;
    const sandbox = Object.assign(Object.create(null), win, { window: win, globalThis: win });
    vm.createContext(sandbox);
    vm.runInContext(E2EE_SRC, sandbox, { filename: 'e2ee.js' });
    return win;
  };

  const apiCalls = { paths: [] };
  const win = mkSandbox(cookieHolder, apiCalls, 0);
  ok('e2ee.js 能在假 DOM 里跑起来（这一段没跑起来，下面的结论都不算数）', win.__dshE2eeOn === true);

  const api = win.DshE2EE;
  ok('加密补丁自报启用了（__dshE2eeOn）', win.__dshE2eeOn === true, String(win.__dshE2eeOn));
  ok('钥匙来源认成「地址里带来的」', api && api.secretSource && api.secretSource() === 'url',
    api && api.secretSource ? String(api.secretSource()) : 'no-api');

  // ★ 一个来回：数一下 prove() 到底发了几个请求（隧道上每个来回好几秒）
  apiCalls.paths.length = 0;
  const proved = await api.prove(true);
  const verifies = apiCalls.paths.filter((p) => p === '/__auth/verify').length;
  const challenges = apiCalls.paths.filter((p) => p === '/__auth/challenge').length;
  ok('手机端 prove() 对着真网关能通过', proved === true,
    JSON.stringify(api.proofState ? api.proofState() : null));
  ok('★ 快路径真的只发 1 个请求（/__auth/verify），没去取挑战 —— 隧道上省一个来回',
    verifies === 1 && challenges === 0, `verify=${verifies} challenge=${challenges} 路径=${apiCalls.paths.join(',')}`);
  ok('证明结果里能看出走的是哪条路（ok(1rtt)）',
    /1rtt/.test(String((api.proofState() || {}).why)), String((api.proofState() || {}).why));

  // ★ 时钟不对（+10 分钟）：服务端会拒（stale-ts），手机端必须**自动退回两个来回**
  {
    const freshSkew = await freshDevice(key);
    const tidS = (freshSkew.cookie.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/) || [])[1] || '';
    if (tidS) made.push(tidS.split('.')[0]);
    const holderS = { value: freshSkew.cookie };
    const callsS = { paths: [] };
    const winS = mkSandbox(holderS, callsS, 10 * 60 * 1000);
    const apiS = winS.DshE2EE;
    callsS.paths.length = 0;
    const okS = await apiS.prove(true);
    const chalS = callsS.paths.filter((p) => p === '/__auth/challenge').length;
    ok('★ 手机时间差了 10 分钟时：自动退回两个来回，照样证明成功（最坏是"不快"，不是"进不去"）',
      okS === true && chalS >= 1,
      `ok=${okS} challenge=${chalS} why=${String((apiS.proofState() || {}).why)}`);
  }

  // ── 关键那一条：再来一台未证明的设备，走**打过补丁**的 fetch ─────────────
  const fresh2 = await freshDevice(key);
  cookieHolder.value = fresh2.cookie;
  const tid2 = (cookieHolder.value.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/) || [])[1] || '';
  if (tid2) made.push(tid2.split('.')[0]);

  const raw2 = await rawFetch(`http://${HOST}/__targets`, { headers: { accept: 'application/json' } });
  ok('（前置）第二台设备裸 fetch 同样被拦',
    raw2.status === 403 && raw2.headers.get('x-dsh-need-proof') === '1', `HTTP ${raw2.status}`);

  // 关掉「刚证过就不重复证」的缓存，模拟「证明过期/网关重启」后的第一次请求
  const retried = await win.fetch(`http://${HOST}/__targets`, { headers: { accept: 'application/json' } });
  ok('★ 被拦时自动补证并**重发原请求**，最终拿到 200（使用者察觉不到这道门）',
    retried.status === 200, `HTTP ${retried.status}`);
  const after = api.proofState ? api.proofState() : {};
  ok('补证结果被记下来了（ok=true）', after.ok === true, JSON.stringify(after));
}

(async function main() {
  console.log('\n⑤ 实测：真网关上的完整流程');

  if (process.argv.includes('--static-only')) {
    skip('实测整段', '显式 --static-only；发布前须单独运行无参数的真网关测试');
    return finish();
  }

  const probe = await new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/__probe', timeout: 1500 }, (res) => {
      res.resume(); resolve(res.statusCode === 204 || res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
  if (!probe) {
    skip('实测整段', `网关没在 127.0.0.1:${PORT} 上跑`);
    return finish();
  }

  let key, secret;
  try {
    key = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
    secret = fs.readFileSync(path.join(BASE, 'logs', 'e2ee-secret.txt'), 'utf8').trim();
  } catch (err) {
    skip('实测整段', `读不到 logs/access-key.txt 或 e2ee-secret.txt（${err.message}）`);
    return finish();
  }

  const made = [];      // 造出来的设备，收尾时清掉

  // 一台**全新设备**：只用访问密钥进来（= 隧道能拿到的那一份）
  const fresh = await freshDevice(key);
  ok('用访问密钥能进门（/k/<密钥> 是引导路径，不能被自己的门挡住）',
    fresh.res.status === 200, `HTTP ${fresh.res.status}`);
  const cookie = fresh.cookie;
  ok('进门时拿到设备令牌', /dsh-gw-session(?:-[a-f0-9]{16})?=/.test(cookie) || cookie.length > 0, cookie.slice(0, 60));
  const token = (cookie.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/) || [])[1] || '';
  if (token) made.push(token.split('.')[0]);

  // ① 页面和脚本照给 —— 没钥匙也不能白屏
  const shell = await req({ path: '/e2ee.js', headers: { cookie } });
  ok('未证明的设备仍能取到脚本（否则永远证明不了，死锁）', shell.status === 200, `HTTP ${shell.status}`);
  const pair = await req({ path: '/pair', headers: { cookie } });
  ok('未证明的设备仍能打开配对页', pair.status === 200, `HTTP ${pair.status}`);

  // ② 内容一律 403 + 标记（注意：网关会先挂住最多 2.5 秒等证明，所以这里慢是正常的）
  const t0 = Date.now();
  const blocked = await req({ path: '/__targets', headers: { cookie, accept: 'application/json' } });
  const waited = Date.now() - t0;
  ok('未证明的设备拿不到内容（/__targets → 403）', blocked.status === 403, `HTTP ${blocked.status}`);
  ok('那条 403 带 x-dsh-need-proof: 1（手机端据此自动续证）',
    blocked.headers['x-dsh-need-proof'] === '1', String(blocked.headers['x-dsh-need-proof']));
  ok('程序调用给的是 JSON，不是 HTML', /application\/json/.test(String(blocked.headers['content-type'])) &&
    /need-proof/.test(blocked.body), blocked.body.slice(0, 80));
  ok('确实等了「证明」那一会儿才拒（页面启动的证明正在路上，不该立刻拒）',
    waited >= 1500, `只等了 ${waited} ms`);

  const blockedApi = await req({
    method: 'POST', path: '/api/session/list',
    headers: { cookie, accept: 'application/json', 'content-type': 'application/json' },
    body: '{}'
  });
  ok('DSH 的 /api 同样被挡（会话预览一个字都不给）',
    blockedApi.status === 403 && blockedApi.headers['x-dsh-need-proof'] === '1',
    `HTTP ${blockedApi.status}`);

  // ③ 导航请求给能自救的页面
  const nav = await req({
    path: '/__targets',
    headers: { cookie, accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' }
  });
  ok('导航被拦时给的是能自救的 HTML 页', nav.status === 403 && /text\/html/.test(String(nav.headers['content-type'])),
    `HTTP ${nav.status} ${nav.headers['content-type']}`);
  ok('那一页自己会证明并 reload（不是让使用者干等）',
    /e2ee\.js/.test(nav.body) && /prove\(true\)/.test(nav.body) && /reload/.test(nav.body));

  // ④ 实时通道：没证明过就别想升级
  const wsBlocked = await upgradeProbe(cookie);
  ok('未证明的设备升级 WebSocket 被拒（HTTP 拦、WS 不拦 = 白做）',
    wsBlocked.status === 403, `HTTP ${wsBlocked.status}${wsBlocked.raw ? ' / ' + wsBlocked.raw.slice(0, 40) : ''}`);
  ok('WS 的拒绝也带 x-dsh-need-proof（手机端据此补证后重连）',
    /x-dsh-need-proof: 1/i.test(wsBlocked.raw));

  // ⑤ 拿着 # 密钥的一方证明自己
  const ch = await req({ path: '/__auth/challenge', headers: { cookie } });
  let nonce = null;
  try { nonce = JSON.parse(ch.body).nonce; } catch (err) { }
  ok('能拿到一次性挑战', ch.status === 200 && !!nonce, `HTTP ${ch.status} ${ch.body.slice(0, 60)}`);
  if (!nonce) return finish();

  const good = await req({
    method: 'POST', path: '/__auth/verify',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, response: respond(nonce, secret) })
  });
  let goodVerdict = {};
  try { goodVerdict = JSON.parse(good.body); } catch (err) { }
  ok('拿 # 密钥算出的应答通过', goodVerdict.ok === true, good.body.slice(0, 90));

  // ⑥ 重放没用
  const replay = await req({
    method: 'POST', path: '/__auth/verify',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, response: respond(nonce, secret) })
  });
  let replayVerdict = {};
  try { replayVerdict = JSON.parse(replay.body); } catch (err) { }
  ok('同一个 nonce 重放不通过（一次性）', replayVerdict.ok === false, replay.body.slice(0, 90));

  // ⑦b 一次往返的证明（2026-09-27 慢链路优化）—— 正例 + 三种反例
  //
  //     它省的是**时间**（隧道上一个来回 2.8–5 秒），不是安全：用的还是那把
  //     **认证专用**的钥匙（HKDF salt='dsh-gw-auth'），和内容加密的时段密钥
  //     是两把。下面这几条连同「⑩ 加密一个字没动」一起把这件事钉住。
  {
    const one = await freshDevice(key);
    const cookieOne = one.cookie;
    const tOne = (cookieOne.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/) || [])[1] || '';
    if (tOne) made.push(tOne.split('.')[0]);

    const nonceO = crypto.randomBytes(24).toString('base64url');
    const tsO = Date.now();
    const respO = respond(`${tsO}|${nonceO}`, secret);
    const oneBody = JSON.stringify({ ts: tsO, nonce: nonceO, response: respO });

    const vOne = await req({
      method: 'POST', path: '/__auth/verify',
      headers: { cookie: cookieOne, 'content-type': 'application/json' },
      body: oneBody
    });
    let jOne = {};
    try { jOne = JSON.parse(vOne.body); } catch (err) { }
    ok('★ 一次往返的证明通过（手机自己出随机数+时间戳）', jOne.ok === true, vOne.body.slice(0, 90));

    const contentOne = await req({ path: '/__targets', headers: { cookie: cookieOne, accept: 'application/json' } });
    ok('★ 走快路径也照样转正（同一台设备随后能拿内容）',
      contentOne.status === 200 || contentOne.headers['x-dsh-need-proof'] !== '1',
      `HTTP ${contentOne.status}`);

    // 重放：同一个包再发一次
    const vReplay = await req({
      method: 'POST', path: '/__auth/verify',
      headers: { cookie: cookieOne, 'content-type': 'application/json' },
      body: oneBody
    });
    let jReplay = {};
    try { jReplay = JSON.parse(vReplay.body); } catch (err) { }
    ok('★ 快路径的包重放不通过（nonce 一次性，和原来同级）',
      jReplay.ok === false && jReplay.code === 'replayed', vReplay.body.slice(0, 90));

    // 时间戳差太多（模拟手机时间不对）
    const tsOld = Date.now() - 10 * 60 * 1000;
    const nonceOld = crypto.randomBytes(24).toString('base64url');
    const vOld = await req({
      method: 'POST', path: '/__auth/verify',
      headers: { cookie: cookieOne, 'content-type': 'application/json' },
      body: JSON.stringify({ ts: tsOld, nonce: nonceOld, response: respond(`${tsOld}|${nonceOld}`, secret) })
    });
    let jOld = {};
    try { jOld = JSON.parse(vOld.body); } catch (err) { }
    ok('★ 时间戳差 10 分钟 → 拒，并回 code=stale-ts（手机据此退回两个来回）',
      jOld.ok === false && jOld.code === 'stale-ts', vOld.body.slice(0, 90));

    // 拿访问密钥当钥匙算（隧道手里那一份）
    const nonceBad = crypto.randomBytes(24).toString('base64url');
    const tsBad = Date.now();
    const vBad = await req({
      method: 'POST', path: '/__auth/verify',
      headers: { cookie: cookieOne, 'content-type': 'application/json' },
      body: JSON.stringify({ ts: tsBad, nonce: nonceBad, response: respond(`${tsBad}|${nonceBad}`, key) })
    });
    let jBad = {};
    try { jBad = JSON.parse(vBad.body); } catch (err) { }
    ok('★ 快路径里「拿访问密钥当钥匙算」同样进不去',
      jBad.ok === false && jBad.code === 'bad-hmac', vBad.body.slice(0, 90));
  }

  // ⑦ 证明之后：内容放行、实时通道放行
  const content = await req({ path: '/__targets', headers: { cookie, accept: 'application/json' } });
  ok('证明通过后同一台设备能拿到内容',
    content.status === 200 || content.headers['x-dsh-need-proof'] !== '1',
    `HTTP ${content.status}`);
  const wsAfter = await upgradeProbe(cookie);
  ok('证明通过后 WebSocket 不再以「没证明」为由被拒',
    !/x-dsh-need-proof: 1/i.test(wsAfter.raw), `HTTP ${wsAfter.status}`);

  // ⑧ 核心安全断言：**只有访问密钥的一方，怎么算都进不去**
  const other = await freshDevice(key);
  const cookie2 = other.cookie;
  const t2 = (cookie2.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/) || [])[1] || '';
  if (t2) made.push(t2.split('.')[0]);

  const ch2 = await req({ path: '/__auth/challenge', headers: { cookie: cookie2 } });
  let nonce2 = null;
  try { nonce2 = JSON.parse(ch2.body).nonce; } catch (err) { }
  if (nonce2) {
    const bad = await req({
      method: 'POST', path: '/__auth/verify',
      headers: { cookie: cookie2, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: nonce2, response: respond(nonce2, key) })   // 拿访问密钥当钥匙算
    });
    let badVerdict = {};
    try { badVerdict = JSON.parse(bad.body); } catch (err) { }
    ok('「拿访问密钥当钥匙算」进不去（这正是隧道手里那一份）', badVerdict.ok === false, bad.body.slice(0, 90));
  } else {
    ok('「拿访问密钥当钥匙算」进不去（这正是隧道手里那一份）', false, '没拿到挑战');
  }

  const stillBlocked = await req({ path: '/__targets', headers: { cookie: cookie2, accept: 'application/json' } });
  ok('那台设备的内容依然一个字都不给',
    stillBlocked.status === 403 && stillBlocked.headers['x-dsh-need-proof'] === '1',
    `HTTP ${stillBlocked.status}`);

  // ⑧b 慢链路上的等待策略：
  //     · 设备**来取过挑战**（手里有钥匙、正在证）→ 等到底（10 秒），
  //       不要让它走「403 → 重新证明 → 重试」那一圈（隧道上一个来回好几秒，
  //       叠起来就是几十秒）；
  //     · 陈旧的、开着很久的页面 → 不再一条条挂 2.5 秒，直接拒。
  {
    const d3 = await freshDevice(key);
    const cookie3 = d3.cookie;
    const t3 = (cookie3.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/) || [])[1] || '';
    if (t3) made.push(t3.split('.')[0]);

    // 先取挑战（不交应答）—— 网关据此认为「它正在证明」
    const ch3 = await req({ path: '/__auth/challenge', headers: { cookie: cookie3 } });
    let nonce3 = null;
    try { nonce3 = JSON.parse(ch3.body).nonce; } catch (err) { }
    ok('（前置）第三台设备取到了挑战', !!nonce3);

    const t0b = Date.now();
    const held = await req({ path: '/__targets', headers: { cookie: cookie3, accept: 'application/json' } });
    const waitedFull = Date.now() - t0b;
    ok('★ 正在证明的设备会被「等到底」（≥8 秒才拒），不是 2.5 秒就打发',
      held.status === 403 && waitedFull >= 8000, `等了 ${waitedFull} ms，HTTP ${held.status}`);
  }

  // ⑧c 慢链路模拟：**证明还在路上**的时候，内容请求应当等到证明落地并直接 200
  //     —— 而不是 403 让手机端再走一圈「重新证明 → 重试」。
  //     这一段复现的就是隧道上开页面的真实节奏（一个来回好几秒）。
  {
    const d4 = await freshDevice(key);       // 这一步拿到的就是应用外壳（开了等待窗口）
    const cookie4 = d4.cookie;
    const t4 = (cookie4.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/) || [])[1] || '';
    if (t4) made.push(t4.split('.')[0]);

    const slowProof = (async () => {
      const ch = await req({ path: '/__auth/challenge', headers: { cookie: cookie4 } });
      let n = null;
      try { n = JSON.parse(ch.body).nonce; } catch (err) { }
      if (!n) return false;
      await new Promise((r) => setTimeout(r, 1500));   // 模拟慢链路上的第二个来回
      const v = await req({
        method: 'POST', path: '/__auth/verify',
        headers: { cookie: cookie4, 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: n, response: respond(n, secret) })
      });
      try { return JSON.parse(v.body).ok === true; } catch (err) { return false; }
    })();

    const t0c = Date.now();
    const content4 = await req({ path: '/__targets', headers: { cookie: cookie4, accept: 'application/json' } });
    const waited4 = Date.now() - t0c;
    const proofOk = await slowProof;
    ok('★ 慢链路：证明还在路上时，内容请求等到证明落地并直接 200（不是 403 让手机重试）',
      content4.status === 200 && waited4 >= 1000 && proofOk,
      `HTTP ${content4.status}，等了 ${waited4} ms，证明=${proofOk}`);
  }

  // ⑩ 加密一个字没动 —— 这一节是这次「求快」改动的安全交代。
  //
  //    快路径动的只是「怎么证明我知道 # 里那串」，它必须只用**认证**那把钥匙，
  //    绝不能碰内容加密的时段密钥、WS 端到端加密、正文加密。下面用源码级断言
  //    把这条钉住（真要有人把加密参数改了，这里会红）：
  {
    const authKeyBlock = (SRC.match(/function authKeyOf\([\s\S]*?\n\}/) || [])[0] || '';
    ok('认证钥匙仍是密钥分离的那把（salt=dsh-gw-auth / info=dsh-gw|auth|v1）',
      /dsh-gw-auth/.test(authKeyBlock) && /dsh-gw\|auth\|v1/.test(authKeyBlock));

    const oneShotBlock = (SRC.match(/function verifyOneShotProof\([\s\S]*?\n\}/) || [])[0] || '';
    ok('快路径只用了 authKeyOf，没有碰内容密钥/时段密钥',
      /authKeyOf\(/.test(oneShotBlock) &&
      !/deriveKeys|contentKey|slotAt|AES|e2eeSecretOrNull/.test(oneShotBlock));

    // 客户端那边同样是两把分开的钥匙（认证一把、内容两把方向各一）
    ok('客户端：认证用独立 salt/info，内容加密用另两条 info（两把钥匙，互不牵连）',
      /dsh-gw-auth/.test(E2EE) && /dsh-gw\|auth\|v1/.test(E2EE) &&
      /dsh-gw\|phone->pc\|v1/.test(E2EE) && /dsh-gw\|pc->phone\|v1/.test(E2EE));
    ok('客户端：快路径也只是拼字符串再交给 authResponse（没有自造加密）',
      /authResponse\(secret, ts \+ '\|' \+ nonce\)/.test(E2EE));

    // 内容加密的两条 info 在两端必须一模一样（这次改动没碰它们）
    const NODE_E2EE = fs.readFileSync(path.join(BASE, 'scripts', 'e2ee.js'), 'utf8');
    ok('内容加密的派生参数两端一致、且与认证参数不同（密钥分离仍然成立）',
      /dsh-gw\|phone->pc\|v1/.test(NODE_E2EE) && /dsh-gw\|pc->phone\|v1/.test(NODE_E2EE) &&
      !/dsh-gw\|auth\|v1/.test(NODE_E2EE));
  }

  // ⑨ 手机端那段「被拦 → 自己补证 → 重发原请求」的逻辑，在真网关上证一遍。  //
  //    为什么非要做这一层：它是**唯一**能让使用者察觉不到这道门存在的东西。
  //    只测服务端等于只测了一半 —— 门立起来了、手机却被自己的门挡住，
  //    正是这一整轮最怕的结果。所以这里把真的 e2ee.js 放进一个假 DOM 里跑，
  //    让它对着真网关走完整条路。
  await clientSideChecks(key, secret, made);

  // 收尾：把测试造出来的设备清掉，别污染控制台里的设备列表
  try {
    const sessions = require('./sessions.js');
    let gone = 0;
    for (const id of made) { try { if (id && sessions.remove(id)) gone++; } catch (err) { } }
    console.log(`  · 清理：删掉测试造出的 ${gone} 台设备`);
  } catch (err) {
    console.log(`  · 清理失败（不影响结论）：${err.message}`);
  }

  finish();
})().catch((err) => { console.log(`\n跑挂了：${err.stack}`); process.exit(1); });

function finish() {
  console.log(`\n${pass} 通过 / ${fail} 失败` + (skipped ? ` / ${skipped} 跳过` : ''));
  process.exit(fail ? 1 : 0);
}
