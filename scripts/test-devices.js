// DSH 移动端网关 — 设备令牌端到端测试
//
// 要验的核心命题是一条：**能不能只把一台设备关在门外，而不影响其他设备。**
// 所以每一项都发真实 HTTP 请求，并且真的去吊销、真的再访问一次。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
// 假设备也要过第三道门（挑战应答）—— 见 proof-helper.js 开头那段说明。
// ★ 必须放在**模块顶层**：proveDevice 是模块级函数，引用块里的 const 会 ReferenceError。
const { proveWith } = require('./proof-helper.js');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const PORT = Number(process.env.DSH_GW_PORT || 8080);
const KEY = fs.readFileSync(path.join(LOG_DIR, 'access-key.txt'), 'utf8').trim();

// 用一个明确合成的主机名当 Host，而不是内网地址。
//
// 两个原因，都是实测出来的：
//   1. 服务端会把「本机来源 + 本机地址」判为「本机请求」，而本机请求不登记设备
//      （设备令牌是用来分辨外面哪台手机的）。从本机连自己的内网 IP，
//      来源地址就是那个内网 IP —— 服务端认得出是自己，所以用内网地址模拟不了手机。
//   2. 用回环地址更不行，那是最典型的本机请求。
// 隧道域名也满足条件，但那个地址每次重启都变，测试里写死没意义。
const REMOTE_HOST = `test-device.invalid:${PORT}`;
console.log(`模拟设备来源 Host: ${REMOTE_HOST}`);

/**
 * 裸发一个 WebSocket 升级请求，只读回响应状态行。
 *
 * 为什么不能用普通 HTTP 请求代替：实时通道走的是 `upgrade` 事件，
 * 是一条独立的路（`handleUpgrade`），HTTP 那边的门过得了**不代表**这边也过得了。
 * 历史上这里就漏过一次（只查 cookie 名字、没走设备令牌），
 * 所以这一段必须真的发升级请求，不能拿 HTTP 的结果推。
 */
function rawUpgrade(cookie) {
  return new Promise((resolve) => {
    let buf = '';
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(
        `GET / HTTP/1.1\r\n` +
        `Host: ${REMOTE_HOST}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Cookie: ${cookie}\r\n\r\n`);
    });
    const done = () => { try { sock.destroy(); } catch (e) { } resolve(buf); };
    sock.on('data', (c) => { buf += c.toString('utf8'); if (buf.includes('\r\n\r\n')) setTimeout(done, 60); });
    sock.on('error', done);
    sock.setTimeout(8000, done);
    // 绝对兜底：**升级成功**那条路和 403 那条不一样 —— 101 之后连接就变成
    // 一条真的 WebSocket 交给上游了，`setTimeout`（空闲超时）在有数据流动时
    // 不会触发，于是这个 Promise 可能永远不 resolve，整个测试静默退出。
    // 所以不管发生什么，3 秒后一定resolve（那时 buf 里已经有状态行了）。
    setTimeout(done, 3000);
  });
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

function req(p, opts = {}) {
  return new Promise((resolve) => {
    // 装了不止一个目标时，根路径会先给一个选择页。真实设备选过一次之后
    // cookie 里就有「用 DSH」，所以这里默认带上 —— 否则所有「打开工作台」的
    // 断言都会看到一个选择页，然后被误判成设备令牌坏了。
    const given = (opts.headers && opts.headers.cookie) || '';
    const cookie = ['dsh-gw-target=dsh', given].filter(Boolean).join('; ');
    const headers = Object.assign({ host: REMOTE_HOST }, opts.headers, { cookie });

    const r = http.request({
      host: '127.0.0.1', port: PORT, method: opts.method || 'GET', path: p,
      headers
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(c).toString('utf8')
      }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/** 从响应里把两个 cookie 都抠出来，拼成下次请求要带的 Cookie 头 */
function cookiesFrom(res) {
  const raw = res.headers['set-cookie'] || [];
  return raw.map((c) => String(c).split(';')[0]).join('; ');
}

/**
 * 让一台**假设备**过第三道门（挑战应答）—— 真手机在浏览器里自己会做这件事。
 *
 * 为什么这个文件需要它：2026-09-27 起网关真的开始拦人了，没证明过的设备
 * 只拿得到页面和脚本。假设备不补这一步，红的是「内容/实时通道拿不到」，
 * 看起来像功能坏了，其实是这台假设备没证明自己。算法在 proof-helper.js 里。
 */
async function proveDevice(cookie, label) {
  const v = await proveWith(async (o) => {
    const r = await req(o.path, {
      method: o.method, body: o.body,
      headers: Object.assign({ cookie }, o.headers || {})
    });
    return { status: r.status, body: r.body };
  });
  if (!v.ok) {
    console.log(`  · ⚠ ${label} 挑战应答没通过（${v.reason}）` +
      ' —— 下面的内容/实时通道断言会因 403 失败');
  }
  return v.ok;
}

function isWorkbench(res) {
  return res.status === 200 && res.body.includes('__ModuleLoader__');
}

(async () => {
  console.log('\n=== 设备令牌 · 端到端测试 ===\n');

  // ── 先备份真实的设备表，测完原样还原 ─────────────────────────────────────
  //
  // ★ 这个测试原来直接 `unlinkSync(devices.json)`，把**使用者真实的设备登记删掉**。
  //   后果非常严重而且完全看不出来：每跑一次测试套件，手机就被踢下线一次，
  //   而日志里只会留下一条「403 设备校验失败(revoked)」。
  //   使用者那边表现是「又要重新配对」「老是连不上」——
  //   而我在电脑这边跑测试，一切正常，根本联想不到。
  //
  //   测试需要确定性的计数，这个诉求是对的；错的是**拿别人的数据当草稿纸**。
  //   test-rotate-e2ee.js 早就是「备份 → 跑 → 还原」的写法，这里照抄。
  const sessions = require('./sessions.js');
  const DEVICES_FILE = path.join(LOG_DIR, 'devices.json');
  let devicesBackup = null;
  let hadDevicesFile = false;
  try {
    devicesBackup = fs.readFileSync(DEVICES_FILE, 'utf8');
    hadDevicesFile = true;
  } catch (err) { /* 本来就没有 */ }

  try { fs.unlinkSync(DEVICES_FILE); } catch (err) { }

  // 兜底：不管这个测试是正常结束、断言失败、还是中途抛异常，
  // 退出前一定把真实设备表放回去。
  // 光靠结尾那段还原是不够的 —— 中途 throw 的话根本走不到那里，
  // 而「测试跑到一半失败，顺手把使用者的手机踢下线」正是最难查的一种。
  let restored = false;
  const restoreDevices = () => {
    if (restored) return;
    restored = true;
    try {
      if (hadDevicesFile) fs.writeFileSync(DEVICES_FILE, devicesBackup, 'utf8');
      else fs.unlinkSync(DEVICES_FILE);
    } catch (err) { /* 退出路径上没法再报错了 */ }
  };
  process.on('exit', restoreDevices);
  process.on('uncaughtException', (err) => {
    console.log(`\n  未捕获异常: ${err.message}`);
    restoreDevices();
    process.exitCode = 1;
  });

  const before = sessions.list().length;
  console.log(`[0] 起始状态：设备记录 ${before} 条` +
    (hadDevicesFile ? `（真实设备表 ${JSON.parse(devicesBackup).devices.length} 条，已备份）` : '') + '\n');
  ok('测试开始前设备表是空的', before === 0, `实际 ${before}`);

  // ── 1. 用密钥配对，应当登记一台设备并种下两个 cookie ────────────────────────
  console.log('[1] 密钥配对');
  const a1 = await req(`/k/${KEY}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1' } });
  // 入口现在返回 302（服务端直接跳 /，带密钥的地址不会渲染出来）。
  // 2xx 或 3xx 都算认证成功 —— 只认 200 会把一个安全改进误报成故障。
  ok('配对请求返回 200 或 302',
    a1.status === 200 || (a1.status >= 300 && a1.status < 400), `实际 ${a1.status}`);

  const rawCookies = a1.headers['set-cookie'] || [];
  ok('种下了两个 cookie（DSH 的 + 设备令牌）', rawCookies.length === 2,
    `实际 ${rawCookies.length}: ${rawCookies.map((c) => String(c).split('=')[0]).join(', ')}`);

  const names = rawCookies.map((c) => String(c).split('=')[0]);
  ok('其中一个是我们自己的设备 cookie', names.some((n) => /^dsh-gw-session(?:-[a-f0-9]{16})?$/.test(n)), names.join(', '));

  const devCookie = rawCookies.find((c) => /^dsh-gw-session(?:-[a-f0-9]{16})?=/.test(String(c)));
  const deviceName = String(devCookie).split('=')[0];
  // SameSite 要 Lax，**不能是 Strict**。
  //
  //  这里原来钉的是 Strict。后来发现 Strict 会让 iOS「从主屏幕图标启动」
  //  这次导航不带 cookie —— 手机用密钥登录成功、紧接着 GET / 却是
  //  「403 无会话 cookie」，主屏幕入口永远只显示一行 access key required。
  //  Lax 在顶级导航时带 cookie（主屏启动、点链接进来），而 POST / iframe /
  //  子资源这些跨站请求仍然不带，挡 CSRF 的作用保留。
  //  断言因此改成「必须是 Lax」—— 谁改回 Strict，这条会红。
  ok('设备 cookie 带 HttpOnly 与 SameSite=Lax（Strict 会让主屏入口打不开）',
    /HttpOnly/i.test(String(devCookie)) && /SameSite=Lax/i.test(String(devCookie)),
    String(devCookie));

  const cookieA = cookiesFrom(a1);
  // 假设备先过第三道门（真手机是浏览器里自己证的）—— 不然下面全是 403
  await proveDevice(cookieA, '设备 A');

  // ── 2. 带着两个 cookie 能进工作台 ───────────────────────────────────────────
  console.log('\n[2] 设备 A 正常工作');
  const homeA = await req('/', { headers: { cookie: cookieA } });
  ok('能看到工作台', isWorkbench(homeA), `HTTP ${homeA.status}`);

  // ── 3. 第二台设备独立登记 ───────────────────────────────────────────────────
  console.log('\n[3] 第二台设备（另一部手机）');
  const a2 = await req(`/k/${KEY}`, { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' } });
  const cookieB = cookiesFrom(a2);
  ok('第二台也拿到了 cookie', cookieB.includes('dsh-gw-session'), cookieB.slice(0, 60));
  await proveDevice(cookieB, '设备 B');

  const homeB = await req('/', { headers: { cookie: cookieB } });
  ok('第二台也能看到工作台', isWorkbench(homeB), `HTTP ${homeB.status}`);

  const devices = sessions.list();
  ok('设备列表里有两台', devices.length === 2, `实际 ${devices.length}`);
  const labels = devices.map((d) => d.label);
  console.log(`      识别出的设备名: ${labels.join(' / ')}`);
  ok('设备名能认出是 iPhone / Android',
    labels.some((l) => /iPhone/.test(l)) && labels.some((l) => /Android/.test(l)),
    labels.join(' / '));
  ok('两台设备 id 不同', devices[0].id !== devices[1].id);

  // ── 4. 核心命题：只吊销一台 ────────────────────────────────────────────────
  console.log('\n[4] 只吊销设备 A，看设备 B 受不受影响');
  const targetA = devices.find((d) => /iPhone/.test(d.label)) || devices[0];
  const r = sessions.revoke(targetA.id);
  ok('吊销操作成功', r.ok, JSON.stringify(r));

  // 语言钉成中文：服务端直出的页面现在按 Accept-Language 协商，
  // 不带头就出英文（兜底），这条断言就永远看不到「需要重新配对」四个字。
  // 断言本身没错，缺的是「告诉服务端我要中文」——补上，别去放宽断言。
  const homeA2 = await req('/', {
    headers: { cookie: cookieA, 'accept-language': 'zh-CN,zh;q=0.9' }
  });
  ok('设备 A 被挡住了', !isWorkbench(homeA2), `HTTP ${homeA2.status}`);
  ok('设备 A 看到的是「需要重新配对」', homeA2.body.includes('需要重新配对'),
    homeA2.body.slice(0, 120));

  const homeB2 = await req('/', { headers: { cookie: cookieB } });
  ok('设备 B 完全不受影响', isWorkbench(homeB2), `HTTP ${homeB2.status}`);

  // ── 4b. 实时通道（WebSocket）也要挡住被吊销的设备 ──────────────────────────
  //
  // 这一段是**单独补的**，因为历史教训很具体：WS 升级那条路原来**只查了
  // 会话 cookie 的名字**，完全没走 `ensureDevice` —— 也就是说
  // 「注销这台设备」对实时通道毫无作用：被吊销的手机照常收发消息。
  // 而 HTTP 那条路上两道门都在，偏偏最长的那条（一直开着的 WebSocket）
  // 只有一道。修好之后**没有测试守着**，所以这里补上。
  console.log('\n[4b] 被吊销的设备，实时通道也要挡住');
  const wsA = await rawUpgrade(cookieA);
  ok('设备 A 的 WebSocket 被拒（403）', /^HTTP\/1\.1 403/.test(wsA), wsA.split('\r\n')[0]);
  const wsB = await rawUpgrade(cookieB);
  // 断言写「**没被 403 挡住**」而不是「拿到了 101」，因为这两条路的响应来源不同：
  //   · A 被设备门当场拒了 → 网关自己立刻回 403
  //   · B 过了设备门 → 请求被转给上游，101 由**上游**回（这里的 Host 是合成的
  //     `test-device.invalid`，上游未必搭理它，所以不能拿 101 当判据）
  // 这个文件要验的命题本来就是「能不能**只**把一台关在门外」——
  // 所以关键是**区分度**：A 被挡、B 没被挡。
  ok('设备 B 没有被设备门挡住（A 挡、B 不挡 = 只吊销了一台）',
    !/^HTTP\/1\.1 403/.test(wsB), wsB.split('\r\n')[0] || '(没等到上游响应)' );

  // ── 5. 被吊销的设备可以重新配对 ────────────────────────────────────────────
  console.log('\n[5] 被吊销的设备重新配对');
  const a1b = await req(`/k/${KEY}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' } });
  const cookieA2 = cookiesFrom(a1b);
  const homeA3 = await req('/', { headers: { cookie: cookieA2 } });
  ok('重新配对后又能进', isWorkbench(homeA3), `HTTP ${homeA3.status}`);
  ok('设备列表现在有 3 条记录（旧的已注销 + 新的）',
    sessions.list().length === 3, `实际 ${sessions.list().length}`);
  // 数量对不上时，把表里的名字打出来 —— 只报一个数字没法定位是谁多出来的
  if (sessions.list().length !== 3) {
    console.log('      表里是: ' + sessions.list()
      .map((d) => `${d.label}${d.revokedAt ? '(已注销)' : ''} id=${String(d.id).slice(0, 12)}` +
        ` ua=${String(d.ua || '').slice(0, 46)}`).join('\n              '));
  }

  // ★ 这台假设备先过第三道门（挑战应答）。
  //
  //   2026-09-27 起网关把挑战应答开成真拦：没证明过的设备只拿得到页面/脚本，
  //   内容类请求（/__switch 换路径票据就是）一律 403 —— 真手机是自己在浏览器里
  //   算的，假设备得补上同一步，否则下面测的就不是「换路径身份延不延续」，
  //   而是「假设备有没有证明」。
  await proveDevice(cookieA2, '设备 A（重新配对后）');

  // ── 6. 老设备兼容：只有 DSH cookie、没有设备令牌 ───────────────────────────
  // 这一条决定升级会不会把已经配好的手机全部踢下线。
  console.log('\n[6] 老设备（升级前配对的，没有设备令牌）');
  const dshOnly = cookieB.split('; ').filter((c) => !c.startsWith(deviceName + '=')).join('; ');
  const legacy = await req('/', { headers: { cookie: dshOnly } });
  ok('老设备没有被踢下线', isWorkbench(legacy), `HTTP ${legacy.status}`);
  const issued = legacy.headers['set-cookie'] || [];
  ok('给它补发了一张设备令牌',
    issued.some((c) => String(c).startsWith(deviceName + '=')),
    JSON.stringify(issued.map((c) => String(c).split('=')[0])));

  const nBefore = sessions.list().length;
  const legacy2 = await req('/', {
    headers: { cookie: dshOnly + '; ' + String(issued[0]).split(';')[0] }
  });
  ok('第二次访问不再重复登记',
    sessions.list().length === nBefore, `登记数从 ${nBefore} 变成 ${sessions.list().length}`);
  ok('补齐令牌后照常可用', isWorkbench(legacy2), `HTTP ${legacy2.status}`);

  // ── 7. 伪造与篡改 ─────────────────────────────────────────────────────────
  console.log('\n[7] 伪造的设备令牌');
  const forge = await req('/', { headers: { cookie: `${dshOnly}; ${deviceName}=abc.def.ghi` } });
  ok('乱写的令牌被拒', !isWorkbench(forge), `HTTP ${forge.status}`);

  const parts = cookieB.match(/dsh-gw-session(?:-[a-f0-9]{16})?=([^;]+)/);
  if (parts) {
    const seg = parts[1].split('.');
    const tampered = `${seg[0]}.${seg[1]}.${'A'.repeat(seg[2].length)}`;
    const tamper = await req('/', { headers: { cookie: `${dshOnly}; ${deviceName}=${tampered}` } });
    ok('改过签名的令牌被拒', !isWorkbench(tamper), `HTTP ${tamper.status}`);
  }

  // ── 8. 换路径时设备身份要延续，不能变成两台 ────────────────────────────────
  console.log('\n[8] 换路径后设备身份延续');
  const nBeforeSwitch = sessions.list().length;
  const sw = await req('/__switch?to=' + encodeURIComponent('lan-' + require('./config.js').detectNetwork().lanV4[0].address),
    { headers: { cookie: cookieA2 } });
  let swj = null;
  try { swj = JSON.parse(sw.body); } catch (err) { }
  ok('能申请到换路径票据', !!(swj && swj.ok), sw.body.slice(0, 150));

  if (swj && swj.url) {
    const ticketPath = new URL(swj.url).pathname;
    const redeem = await req(ticketPath, { headers: { host: swj.authority } });

    // 关键：换路径不该在设备列表里凭空多出一台
    const nAfterSwitch = sessions.list().length;
    const activeAfter = sessions.list({ activeOnly: true }).length;
    ok('设备总数没有因为换路径而增加',
      nAfterSwitch === nBeforeSwitch, `${nBeforeSwitch} → ${nAfterSwitch}`);
    console.log(`      换路径后：共 ${nAfterSwitch} 台，有效 ${activeAfter} 台`);

    // 被吊销设备的票据也要失效
    const revoked = sessions.list().find((d) => d.revoked);
    if (revoked) {
      const sessionsMod = require('./sessions.js');
      ok('已注销的设备无法通过 isActive 检查',
        sessionsMod.isActive(revoked.id) === false);
    }
  }

  // ── 9. 同一台设备只占一条 ─────────────────────────────────────────────────
  //
  // 使用者提过两次：
  //   第一次「只要是识别同一个手机就合并？不然我开多少个网页就多少个」
  //   第二次「有哪些设备链接还是要有，不要完全删掉，但是同一个设备、
  //          不同网址合为一个」
  //
  // ★ 这一节**改过判据**，如实说明：原来断言的是「来源地址不同 = 另一台设备」，
  //   那是第一版（按 UA + 当前地址匹配）的行为。使用者第二次明确要求
  //   「同一台设备走不同网址也要合成一条」—— 他的设备表里就同时躺着同一个
  //   iPhone 的两条记录（一条内网、一条 IPv6）。
  //   所以判据改成「同一个 UA 就是同一台设备」，断言跟着改。
  //   这不是「测试红了就改测试」，是需求变了。
  //
  //   代价写在这里而不是藏着：两台**完全相同**的手机（同型号同浏览器）
  //   会被并成一条，吊销一台会连带另一台。使用者已经明确选了这个取舍 ——
  //   不合并的代价（列表永远在变长、真设备被重复项淹没）他先遇到的。
  console.log('\n[9] 同一台设备只占一条');
  const UA_X = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) ' +
               'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1';

  const n0 = sessions.list().length;
  const c1 = sessions.create({ ua: UA_X, ip: '203.0.113.7', authority: 'home.example:8080' });
  ok('第一次登记会新建一条',
    sessions.list().length === n0 + 1, `${n0} → ${sessions.list().length}`);

  const c2 = sessions.create({ ua: UA_X, ip: '203.0.113.7', authority: 'home.example:8080' });
  ok('同一台设备、同一个地址再连一次：复用同一条',
    sessions.list().length === n0 + 1 && c2.device.id === c1.device.id,
    `${n0} → ${sessions.list().length}`);

  const c3 = sessions.create({ ua: UA_X, ip: '203.0.113.8', authority: 'wan.example.com' });
  ok('同一台设备换了地址（在家走内网 / 在外面走隧道）：仍然只占一条',
    sessions.list().length === n0 + 1 && c3.device.id === c1.device.id,
    `${n0} → ${sessions.list().length}`);
  ok('换了地址之后，那条记录上的来源地址跟着更新',
    sessions.list().find((d) => d.id === c1.device.id).lastIp === '203.0.113.8');
  ok('复用时补发了新令牌（不是把旧的还回去）', c3.token !== c2.token);
  ok('旧令牌仍然有效（手机上原来那个页面可能还开着）',
    sessions.verify(c1.token).ok === true, JSON.stringify(sessions.verify(c1.token)));

  const c4 = sessions.create({ ua: 'Android 15 Pixel', ip: '203.0.113.7' });
  ok('换了浏览器（不同 UA）= 另一台设备',
    sessions.list().length === n0 + 2 && c4.device.id !== c1.device.id,
    `${n0} → ${sessions.list().length}`);

  // 拿到密钥重新配对一次（比如换地址之后），不该在列表里变成第二台
  const nBeforeRepair = sessions.list().length;
  sessions.revoke(c1.device.id);
  const c5 = sessions.create({ ua: UA_X, ip: '203.0.113.9' });
  ok('被注销过的设备重新配对：复活原记录，不新开一行',
    sessions.list().length === nBeforeRepair && c5.device.id === c1.device.id,
    `${nBeforeRepair} → ${sessions.list().length}`);
  ok('复活之后是有效状态', sessions.list().find((d) => d.id === c1.device.id).active === true);

  // 没有 UA 的请求（命令行工具、探针）绝不能互相合并成一条 ——
  // 它们本来就没有能区分身份的东西，合并等于把它们混成一台。
  const nUA = sessions.list().length;
  sessions.create({ ua: '', ip: '203.0.113.9' });
  sessions.create({ ua: '', ip: '203.0.113.9' });
  ok('拿不到 UA 时不合并（无法区分身份就不能猜）',
    sessions.list().length === nUA + 2, `${nUA} → ${sessions.list().length}`);

  // dedupe：把历史上攒下的重复并掉，而且只留还在用的那条。
  //
  // 这里必须**手工往文件里塞一条**重复记录 —— create() 现在不会再制造重复了，
  // 所以只靠调接口是复现不出「历史遗留」那种情况的。
  // （使用者真实遇到的就是这种：他的设备表里躺着同一个 iPhone 的两条，
  //   一条走内网、一条走 IPv6，是旧版本攒下来的。）
  const ddb = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
  const proto = ddb.devices.find((d) => d.ua === UA_X);
  ddb.devices.push(Object.assign({}, proto, {
    id: 'dup-old-1',
    lastIp: '198.51.100.9',
    lastSeenAt: new Date(Date.now() - 86400000).toISOString(),  // 更旧
    revokedAt: null
  }));
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(ddb, null, 2), 'utf8');

  const nDup = sessions.list().length;
  const dr = sessions.dedupe();
  ok('去重把同一 UA 的重复记录并掉', dr.merged === 1,
    `并掉 ${dr.merged} 条，${nDup} → ${sessions.list().length}`);
  ok('留下的是最近出现的那一条', !sessions.list().some((d) => d.id === 'dup-old-1'));
  ok('去重后再跑一次不会继续减少（幂等）', sessions.dedupe().merged === 0,
    `又并了 ${sessions.dedupe().merged} 条`);


  //
  // 这里做一次「显式还原 + 校验」，上面那个 exit 兜底只是保险。
  // 显式做一遍是为了能**打印出来给人看** —— 「已还原 N 条」这句话本身有价值，
  // 它让「测试有没有动到我的手机」变成看得见的事实。
  try {
    if (hadDevicesFile) {
      const want = JSON.parse(devicesBackup).devices.length;
      restoreDevices();
      const got = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')).devices.length;
      console.log(`\n  ✓ 已还原真实设备表（${want} 条）—— 测试不能把使用者的手机踢下线`);
      if (got !== want) { console.log(`  ✗ 还原数量不对: 期望 ${want}，实际 ${got}`); fail++; }
    } else {
      restoreDevices();
      console.log('\n  ✓ 本来就没有设备表，已清理测试留下的记录');
    }
  } catch (err) {
    console.log(`\n  ✗ 还原设备表失败: ${err.message}`);
    console.log('    使用者的手机可能需要重新配对一次。');
    fail++;
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
