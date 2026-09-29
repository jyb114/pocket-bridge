// 进门证明脚本（pwa/prove.js）的测试 —— 补的是 2026-09-27 查出来的两个洞：
//
//   曾出现发送成功但页面未显示任务状态、刷新后才恢复的情况。
//   日志实锤是那台设备**没通过证明**（403 未通过挑战应答 / WS 被拒）。而为什么它会
//   证不了？因为证明这件事原来只有两处会做，正好漏了两页：
//     · codex.html 只引 e2ee.js —— 手机上缓存着**旧版** e2ee.js（没有 prove()）时，
//       这一页永远证不了 → 整页 403；
//     · go.html 只引 i18n.js —— 从来没有人证过 → /__targets 必被 403。
//
//   补法：新增 pwa/prove.js，由网关注入这两页；它只用 e2ee.js 里**一直就有**的
//   authResponse（对旧客户端也管用）。
//
// 这个测试守四件事：
//   ① 两页都真的被注入了 /prove.js（而且没被注入到不该注入的地方）
//   ② 旧客户端（只有 authResponse、没有 prove）也能证明成功
//   ③ 一次往返被拒（时间戳不对）会自动退回两个来回
//   ④ 被拦时补证并**重发原请求**（网关重启后开着的页面能自己缓过来）
//
// 跑法: node scripts/test-prove-injection.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
const PROVE_SRC = fs.readFileSync(path.join(BASE, 'pwa', 'prove.js'), 'utf8');
const PORT = 8080;
const staticOnly = process.argv.includes('--static-only');

let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};
const skip = (n, why) => { skipped++; console.log(`  · ${n} —— 跳过（${why}）`); };

console.log('\n=== 进门证明脚本（codex / go 两页）· 回归 ===\n');

// ── ① 注入接线 ─────────────────────────────────────────────────────────────
console.log('[1] 注入接线');
{
  const calls = [...SRC.matchAll(/injectProofAssets\(raw\.toString\('utf8'\)\)/g)].length;
  // 原来是 2 处（codex.html / go.html）。2026-09-26 加了第 3 处：**选目标页**
  // —— 它才是新设备第一眼看到的那一页，而它自己要用 /__targets（要证明）。
  ok('三处注入（codex.html / go.html / 选目标页）', calls === 2, `实际 ${calls}`);
  ok('选目标页也注入了', /res\.end\(injectProofAssets\(launcherPage\(req, lang[,)]/.test(SRC));
  ok('/prove.js 在放行名单里（证明之前必须能取到）', /['\"]\/prove\.js['\"]/.test(SRC.slice(SRC.indexOf('const BOOTSTRAP_PATHS'), SRC.indexOf('function isBootstrapRequest'))));
  ok('/prove.js 进了指纹名单（它拿着进门凭证做 HMAC，必须钉住）',
    /const files = \[[\s\S]*?'\/prove\.js'\]/.test(SRC));
  ok('/prove.js 有独立路由', /'\/prove\.js': \{ file: 'prove\.js'/.test(SRC));
  ok('注入时先裁剪语言（两步都在）',
    /trimHtmlToLanguage\(req, res, path\.join\(PWA_DIR, 'codex\.html'\)\)[\s\S]{0,120}injectProofAssets/.test(SRC));

  // ★ 这条是 2026-09-26 那个事故的回归断言：**只注入 prove.js 等于没注入**。
  //   prove.js 的 ready() 等 DshE2EE.authResponse（在 e2ee.js 身上），
  //   secret() 等 __dshE2eeSecret（也只有 e2ee.js 赋值）—— 两个都没有时它
  //   一次挑战都不取，页面永远证不了（使用者手机上就是「这条地址打不开目标列表」）。
  const fn = SRC.slice(SRC.indexOf('function injectProofAssets'), SRC.indexOf('function trimHtmlToLanguage'));
  ok('注入函数一次给两个脚本（e2ee.js + prove.js）',
    /\/e2ee\.js/.test(fn) && /\/prove\.js/.test(fn), '少了一个就等于没注入');
  ok('e2ee.js 排在 prove.js 前面（先有钥匙和 authResponse，再去证明）',
    fn.indexOf("'/e2ee.js'") < fn.indexOf("'/prove.js'"));
}

// ── ①b 客户端那份「我证过了」必须能被服务端一句话推翻 ──────────────────────
//
// 2026-09-27 实测踩到：网关重启之后页面还开着，服务端已经不认了，而客户端本地
// 还写着「我证过了」—— 于是「补证」被自己的三秒节流挡掉，重发还是 403，
// 页面一直坏到手动刷新。
console.log('\n[1b] 被服务端否定时，本地判断必须先作废');
{
  const e2ee = fs.readFileSync(path.join(BASE, 'pwa', 'e2ee.js'), 'utf8');
  const proveSrc = fs.readFileSync(path.join(BASE, 'pwa', 'prove.js'), 'utf8');
  const pairs = [
    ['prove.js 的 fetch 重试', proveSrc, /isNeedProof\(res\)\) return res;\s*\n[\s\S]{0,400}?state\.ok = false;[\s\S]{0,80}?prove\(true\)/],
    ['e2ee.js 的 fetch 重试', e2ee, /isNeedProof\(res\)\) return res;\s*\n[\s\S]{0,400}?proofState\.ok = false;[\s\S]{0,80}?prove\(true\)/],
    ['e2ee.js 的 XHR 重放', e2ee, /__dshProofRetried = true;\s*\n[\s\S]{0,200}?proofState\.ok = false;[\s\S]{0,80}?prove\(true\)/],
    ['e2ee.js 的 WS 重连', e2ee, /nativeAdd\('close'[\s\S]{0,200}?proofState\.ok = false;\s*prove\(true\)/]
  ];
  for (const [name, src, re] of pairs) {
    ok(`${name}：先作废再补证`, re.test(src));
  }
}

// ── 假 DOM：模拟「旧客户端」的 e2ee.js（只有 authResponse / bytesToB64url） ──
function fakeEnv(opts) {
  const o = opts || {};
  const secret = o.secret || null;
  const calls = { paths: [], bodies: [] };
  let proven = false;                          // 服务端状态：证明通过了才算
  let challengeUsed = false;

  // 核 HMAC 一律用**这个环境自己的**密钥（第一版用的是磁盘上那把，
  // 于是「退回两个来回」那条永远核不过 —— 那是测试桩的 bug，不是功能的）
  const CLIENT_SECRET = o.secret || 'test-secret-abcdefghijklmnop';
  const authKey = (sec) => require('./e2ee.js').hkdf(Buffer.from(sec, 'utf8'),
    Buffer.from('dsh-gw-auth'), 'dsh-gw|auth|v1', 32);

  const fetchShim = (url, init) => {
    const p = String(url);
    calls.paths.push(p);
    if (init && init.body) calls.bodies.push(String(init.body));
    const json = (obj) => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(obj)
    });
    if (p === '/__auth/challenge') {
      challengeUsed = true;
      return Promise.resolve(json({ ok: true, nonce: 'server-nonce-' + crypto.randomBytes(6).toString('hex') }));
    }
    if (p === '/__auth/verify') {
      const body = JSON.parse(String(init.body || '{}'));
      if (body.ts !== undefined) {
        // 一次往返：按 oneShotOk 决定接受还是回 stale-ts
        if (o.oneShotOk === false) {
          return Promise.resolve(json({ ok: false, code: 'stale-ts', reason: '时间戳不对' }));
        }
        proven = true;
        return Promise.resolve(json({ ok: true }));
      }
      // 老路：核 HMAC（用这个环境自己的密钥）
      const want = crypto.createHmac('sha256', authKey(CLIENT_SECRET)).update(body.nonce).digest('base64url');
      const good = want === body.response;
      if (good) proven = true;
      return Promise.resolve(json({ ok: good, code: good ? null : 'bad-hmac' }));
    }
    // 内容请求：没证明过就 403 + 那个头（gateContent 时才拦）
    if (p === '/content') {
      if (!o.gateContent || proven) {
        return Promise.resolve(json({ ok: true, content: 'yes' }));
      }
      return Promise.resolve({
        status: 403,
        headers: { get: (k) => (k === 'x-dsh-need-proof' ? '1' : null) },
        json: () => Promise.resolve({ ok: false, error: 'need-proof' })
      });
    }
    return Promise.resolve(json({ ok: true }));
  };

  const win = {
    crypto: crypto.webcrypto,
    fetch: fetchShim,
    document: { readyState: 'complete', visibilityState: 'visible', addEventListener() { } },
    location: { hash: secret ? '#k=' + secret : '' },
    setTimeout, clearTimeout, setInterval: () => 0,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    Uint8Array, ArrayBuffer, URLSearchParams, Request, Promise, Date, JSON, Math, String, Object,
    console: { log() { }, warn() { }, error() { } }
  };
  if (secret) win.__dshE2eeSecret = secret;
  // 「旧客户端」的 e2ee.js：只有 authResponse 和 bytesToB64url（**没有 prove**）
  win.DshE2EE = {
    bytesToB64url: (bytes) => Buffer.from(bytes).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    authResponse: function (sec, nonceStr) {
      return Promise.resolve(crypto.createHmac('sha256', authKey(sec))
        .update(String(nonceStr)).digest('base64url'));
    }
  };
  win.window = win;
  win.globalThis = win;
  win.__calls = calls;
  win.__setProven = (v) => { proven = !!v; };   // 测试用：模拟「服务端把证明忘了」
  return win;
}

const flush = () => new Promise((r) => setTimeout(r, 60));

// ── ② 旧客户端也能证明 ─────────────────────────────────────────────────────
(async () => {
  console.log('\n[2] 旧客户端（只有 authResponse、没有 prove）');
  {
    const env = fakeEnv({ secret: 'test-secret-abcdefghijklmnop' });
    const sandbox = Object.assign(Object.create(null), env);
    vm.createContext(sandbox);
    vm.runInContext(PROVE_SRC, sandbox, { filename: 'prove.js' });
    await flush();
    const verified = env.__calls.paths.filter((p) => p === '/__auth/verify').length;
    ok('加载后会自己去证明（发出 /__auth/verify）', verified >= 1, env.__calls.paths.join(','));
    ok('用的是「一个来回」那条路（没先取挑战）',
      env.__calls.paths.indexOf('/__auth/challenge') < 0 && verified === 1,
      env.__calls.paths.join(','));
    ok('证明状态可查（ok=true）', env.DshProve.state().ok === true,
      JSON.stringify(env.DshProve.state()));
  }

  // ── ③ 一次往返被拒 → 自动退回两个来回 ────────────────────────────────────
  console.log('\n[3] 一次往返被拒（手机时间不对）→ 自动退回两个来回');
  {
    const env = fakeEnv({ secret: 'test-secret-abcdefghijklmnop', oneShotOk: false });
    const sandbox = Object.assign(Object.create(null), env);
    vm.createContext(sandbox);
    vm.runInContext(PROVE_SRC, sandbox, { filename: 'prove.js' });
    await flush();
    const usedChallenge = env.__calls.paths.indexOf('/__auth/challenge') >= 0;
    ok('被拒之后去取了挑战（退回老路）', usedChallenge, env.__calls.paths.join(','));
    ok('老路也走通了（ok=true）', env.DshProve.state().ok === true,
      JSON.stringify(env.DshProve.state()));
  }

  // ── ④ 被拦 → 补证 + 重发原请求 ───────────────────────────────────────────
  console.log('\n[4] 被拦（403 + need-proof）→ 补证并重发原请求');
  {
    const env = fakeEnv({ secret: 'test-secret-abcdefghijklmnop', gateContent: true });
    const sandbox = Object.assign(Object.create(null), env);
    vm.createContext(sandbox);
    vm.runInContext(PROVE_SRC, sandbox, { filename: 'prove.js' });
    await flush();
    // 模拟「网关重启了」：服务端把证明忘了，但页面还开着（客户端以为自己还是好的）
    env.__setProven(false);
    env.__calls.paths.length = 0;
    const res = await env.fetch('/content');
    const j = await res.json();
    ok('内容请求最终拿到了数据（自动补证 + 重发）',
      res.status === 200 && j.content === 'yes', `status=${res.status}`);
    ok('中间确实补了一次证明',
      env.__calls.paths.some((p) => p === '/__auth/verify'), env.__calls.paths.join(','));
  }

  // ── ⑤ 没有钥匙就安静 ─────────────────────────────────────────────────────
  console.log('\n[5] 没有钥匙 / 没有加密接口时：什么都不做');
  {
    const env = fakeEnv({ secret: null });
    const sandbox = Object.assign(Object.create(null), env);
    vm.createContext(sandbox);
    vm.runInContext(PROVE_SRC, sandbox, { filename: 'prove.js' });
    await flush();
    ok('没有钥匙 → 不发任何请求、不报错',
      env.__calls.paths.length === 0 && env.DshProve.state().ok === false,
      env.__calls.paths.join(','));
  }

  // ── ⑥ 真网关：两页都带上了 /prove.js ─────────────────────────────────────
  console.log('\n[6] 真网关：两页都带上了 /prove.js');
  if (staticOnly) {
    skip('真网关那一段', '明确使用 --static-only；没有发起真实请求');
    console.log(`\n${pass} 通过 / ${fail} 失败 / ${skipped} 跳过\n`);
    process.exit(fail ? 1 : 0);
  }
  const up = await new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/__probe', timeout: 1500 }, (res) => {
      res.resume(); resolve(res.statusCode === 204 || res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
  if (!up) {
    skip('真网关那一段', `网关没在 127.0.0.1:${PORT} 上跑`);
  } else {
    const key = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
    const req = (opts) => new Promise((resolve) => {
      const r = http.request({
        host: '127.0.0.1', port: PORT, method: 'GET', path: opts.path,
        headers: Object.assign({ host: `127.0.0.1:${PORT}` }, opts.headers || {})
      }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8'), headers: res.headers }));
      });
      r.on('error', (e) => resolve({ status: 0, body: String(e.message), headers: {} }));
      r.end();
    });

    const login = await req({
      path: `/k/${key}`,
      headers: { 'user-agent': `prove-test/${crypto.randomBytes(3).toString('hex')}` }
    });
    const cookie = (login.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
    // ★ 这台设备此刻**还没通过证明** —— 而 codex 是我们的应用页，必须能打开
    //   （日志曾出现 `403 未通过挑战应答: GET /codex（…不在开页面的窗口里，
    //    直接拒）`，使用者的 Codex 页整页打不开，还以为是「要我重新配对」）。
    const codex = await req({ path: '/codex', headers: { cookie } });
    const go = await req({ path: '/go', headers: { cookie } });
    ok('/codex 页面里注入了 /prove.js',
      codex.status === 200 && codex.body.indexOf('src="/prove.js"') > 0, `HTTP ${codex.status}`);
    ok('未证明的设备也能打开 codex 应用页（不该被拦成「正在验证」页）',
      codex.status === 200 && /id="body"|class="msg/.test(codex.body), `HTTP ${codex.status}`);
    ok('/go 页面里也注入了 prove.js', go.status === 200 && go.body.indexOf('src="/prove.js"') > 0, `HTTP ${go.status}`);
    // go.html 原来**只引 i18n.js** —— 连 e2ee.js 都没有，所以「注入了 prove.js」
    // 这句话以前是空的（prove.js 没有钥匙可用）。现在两个都在。
    ok('/go 页面里也有 e2ee.js（prove.js 没它等于没有）',
      go.status === 200 && go.body.indexOf('src="/e2ee.js"') > 0, `HTTP ${go.status}`);
    const menu = await req({ path: `/k/${key}`, headers: { cookie } });
    ok('选目标页也带上了两个脚本（新设备第一眼看到的就是它）',
      menu.status === 200 && menu.body.indexOf('src="/prove.js"') > 0 && menu.body.indexOf('src="/e2ee.js"') > 0,
      `HTTP ${menu.status}`);
    ok('注入在页面自己的脚本之前（否则那些请求会先吃 403）',
      codex.body.indexOf('/prove.js') < codex.body.indexOf('/e2ee.js'));
    const script = await req({ path: '/prove.js', headers: { cookie } });
    ok('/prove.js 本身能取到（未证明的设备也放行）',
      script.status === 200 && script.body.indexOf('DshProve') > 0, `HTTP ${script.status}`);
    const manifest = await req({ path: '/code-manifest.json', headers: { cookie } });
    ok('/prove.js 在指纹名单里（防隧道掉包）',
      manifest.status === 200 && manifest.body.indexOf('prove.js') > 0, `HTTP ${manifest.status}`);
  }

  console.log(`\n${pass} 通过 / ${fail} 失败` + (skipped ? ` / ${skipped} 跳过` : '') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('跑挂了：' + (e && e.stack)); process.exit(1); });
