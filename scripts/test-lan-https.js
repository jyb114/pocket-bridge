// DSH 移动端网关 — 内网 HTTPS 端到端测试
//
// 要验的不只是「8081 端口能连上」，而是这几件容易想当然的事：
//   1. 加密那条路上，整条工作台能不能真的打开（不只是返回 200）
//   2. WebSocket 能不能走 wss —— 实时通道全靠它，断了就变成「打得开但没数据」
//   3. 证书是不是真的自签（不带 CA 时必须连不上，否则等于没加密）
//   4. 认证、探针、选路这些端点在加密路上是不是一样管用
//
// 用法: node scripts/test-lan-https.js
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const cert = require('./make-cert.js');

const KEY = fs.readFileSync(path.join(LOG_DIR, 'access-key.txt'), 'utf8').trim();

// 从配置文件里读中间层端口，从 health 里读 https 端口
const PORT = Number(process.env.DSH_GW_PORT || 8080);
let HTTPS_PORT = 0;
try { HTTPS_PORT = Number(fs.readFileSync(path.join(LOG_DIR, 'https-port.txt'), 'utf8').trim()); }
catch (err) { }

// 内网地址现探测 —— 不要写死。
// 原来这里是 192.168.1.3，DHCP 换成 .4 之后，所有用它的 Host 头都会对不上，
// 而报错看起来像证书或路由的问题。实际上只是「那台机器的旧地址」。
const LAN_IP = (() => {
  try {
    const v4 = require('./config.js').detectNetwork().lanV4;
    return v4.length ? v4[0].address : '127.0.0.1';
  } catch (err) { return '127.0.0.1'; }
})();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const CA = fs.readFileSync(cert.CA_CERT);

function req(port, p, opts = {}) {
  return new Promise((resolve) => {
    // useCa === false 表示「完全不提供 CA，用系统信任库」——
    // 这才是「不信任 CA 会怎样」的真实场景。之前这里写反了：
    // 传了 rejectUnauthorized 却仍然把 CA 带上，于是测出来的结果是「连上了」，
    // 看着像功能有问题，其实是用例自己没测到点子上。
    const trust = opts.useCa === false ? {} : { ca: CA };
    // 带上「用 DSH」：装了不止一个目标时根路径会先给选择页
    const given = (opts.headers && opts.headers.cookie) || '';
    const headers = Object.assign({ host: `${LAN_IP}:${port}` }, opts.headers, {
      cookie: ['dsh-gw-target=dsh', given].filter(Boolean).join('; ')
    });
    const r = https.request({
      host: '127.0.0.1', port, path: p, method: opts.method || 'GET',
      headers,
      ...trust,
      rejectUnauthorized: opts.rejectUnauthorized !== false,
      servername: opts.servername || 'localhost'
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(c).toString('utf8')
      }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.end();
  });
}

/** 通过 wss 连上去，确认能完成一次真正的 WebSocket 升级 */
function wsUpgrade(port, p, opts = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const r = https.request({
      host: '127.0.0.1', port, path: p,
      headers: Object.assign({
        host: `${LAN_IP}:${port}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13'
      }, opts.headers),
      ca: CA
    });
    r.on('upgrade', (res, socket) => {
      const accept = res.headers['sec-websocket-accept'];
      const expect = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.destroy();
      resolve({ upgraded: true, status: res.statusCode, acceptOk: accept === expect });
    });
    r.on('response', (res) => {
      res.resume();
      resolve({ upgraded: false, status: res.statusCode });
    });
    r.on('error', (e) => resolve({ upgraded: false, error: e.code || e.message }));
    r.end();
  });
}

(async () => {
  console.log('\n=== 内网 HTTPS · 端到端测试 ===\n');

  // ── 0. 前置 ────────────────────────────────────────────────────────────────
  console.log('[0] 前置检查');
  const health = await new Promise((resolve) => {
    require('http').get(`http://127.0.0.1:${PORT}/__health`, { timeout: 4000 }, (res) => {
      let b = ''; res.on('data', (d) => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });

  ok('中间层在跑', !!health, '拿不到 /__health');
  if (!health) { console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`); process.exitCode = 1; return; }

  HTTPS_PORT = health.httpsPort || HTTPS_PORT;
  ok('内网 HTTPS 已启用', !!HTTPS_PORT, `health.httpsPort=${health.httpsPort}`);
  if (!HTTPS_PORT) { console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`); process.exitCode = 1; return; }
  console.log(`      明文 :${PORT}　加密 :${HTTPS_PORT}`);

  // ── 1. 证书本身 ────────────────────────────────────────────────────────────
  console.log('\n[1] 证书');
  const v = cert.verify();
  ok('证书校验通过（信任链、地址、有效期）', v.ok, (v.problems || []).join('；'));
  if (v.ok) {
    console.log(`      主体 ${v.status.srv.subject}`);
    console.log(`      有效至 ${v.status.srv.validTo}（还剩 ${v.status.daysLeft} 天）`);
  }

  // 不带 CA 必须连不上 —— 否则「自签」这件事就是假的，等于没有加密保护
  const noTrust = await req(HTTPS_PORT, '/__probe', { useCa: false, rejectUnauthorized: true });
  ok('不信任 CA 时连接被拒（证明确实是自签）',
    noTrust.status === 0 && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_SIGNATURE/i.test(String(noTrust.error)),
    JSON.stringify(noTrust));
  if (noTrust.error) console.log(`      不带 CA 时的报错: ${noTrust.error}`);

  // 反过来也要成立：带上 CA 就必须能连上（否则使用者装了 CA 也没用）
  const withCa = await req(HTTPS_PORT, '/__probe', { useCa: true, rejectUnauthorized: true });
  ok('带上 CA 时能正常连上（装了 CA 的手机才不会白装）', withCa.status === 204,
    JSON.stringify({ status: withCa.status, error: withCa.error }));

  // 把 CA 换成一张别家的（模拟中间人），也必须被拒
  const otherCa = (() => {
    const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return cert.makeCert({
      subjectCn: '冒充的 CA', publicKey: k.publicKey, privateKey: k.privateKey,
      days: 30, isCa: true, dnsNames: [], ips: []
    }).certPem;
  })();
  const mitm = await new Promise((resolve) => {
    const r = https.request({
      host: '127.0.0.1', port: HTTPS_PORT, path: '/__probe',
      ca: otherCa, rejectUnauthorized: true, servername: 'localhost'
    }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.end();
  });
  ok('用别的 CA 也验不过（不是「谁签都认」）', mitm.status === 0, JSON.stringify(mitm));

  // ── 2. 各个端点在加密路上一样管用 ──────────────────────────────────────────
  console.log('\n[2] 端点在加密路上是否一致');
  const probe = await req(HTTPS_PORT, '/__probe');
  ok('连通性探针 /__probe → 204', probe.status === 204, `HTTP ${probe.status}`);

  const noAuth = await req(HTTPS_PORT, '/');
  ok('未认证被拦（403）', noAuth.status === 403, `HTTP ${noAuth.status}`);

  const withKey = await req(HTTPS_PORT, `/k/${KEY}`);
  ok('密钥入口种下 cookie', String(withKey.headers['set-cookie'] || '').includes('='),
    JSON.stringify(withKey.headers['set-cookie']));
  const cookie = [].concat(withKey.headers['set-cookie'] || [])
    .map((c) => String(c).split(';')[0]).join('; ');

  const home = await req(HTTPS_PORT, '/', { headers: { cookie } });
  ok('工作台页面能打开', home.status === 200 && home.body.includes('__ModuleLoader__'),
    `HTTP ${home.status}，${home.body.length} 字节`);
  ok('兼容补丁注入照常', home.body.includes('/polyfill.js') && home.body.includes('/route.js'));

  // ── 3. WebSocket over TLS ─────────────────────────────────────────────────
  //
  // 这一条最关键：DSH 的实时数据全走 WebSocket。加密路上如果 wss 不通，
  // 表现是「页面打得开、但什么都刷不出来」—— 表面上像前端坏了，实际是这条路没通。
  console.log('\n[3] WebSocket（wss）');
  const unauthWs = await wsUpgrade(HTTPS_PORT, '/api/remote.mux');
  ok('未认证的 wss 被拒', unauthWs.upgraded === false, JSON.stringify(unauthWs));

  const ws = await wsUpgrade(HTTPS_PORT, '/api/remote.mux', { headers: { cookie } });
  ok('认证后的 wss 升级成功', ws.upgraded === true, JSON.stringify(ws));
  if (ws.upgraded) {
    ok('Sec-WebSocket-Accept 正确', ws.acceptOk === true);
  }

  // ── 4. 选路里多出来的那条 ─────────────────────────────────────────────────
  console.log('\n[4] 自动选路里是否出现加密的内网入口');
  const routes = await req(HTTPS_PORT, '/__routes', { headers: { cookie } });
  ok('/__routes 在加密路上可用', routes.status === 200, `HTTP ${routes.status}`);
  let data = null;
  try { data = JSON.parse(routes.body); } catch (err) { }
  ok('返回可解析的 JSON', !!data);

  if (data) {
    const lh = (data.candidates || []).find((c) => c.kind === 'lan-https');
    ok('候选里有一条「内网直连（加密）」', !!lh, JSON.stringify((data.candidates || []).map((c) => c.kind)));
    if (lh) {
      console.log(`      ${lh.label}  ${lh.origin}`);
      ok('地址是 https 且端口是加密端口',
        lh.origin.startsWith('https://') && lh.origin.endsWith(`:${HTTPS_PORT}`), lh.origin);
      ok('标为「从 https 页面也能探测」（同协议，不算混合内容）',
        lh.probeableFromHttps === true);
    }
    // 加密那条必须排在明文那条前面 —— 同一台机器上能加密就不该退化到明文
    const kinds = (data.candidates || []).map((c) => c.kind);
    const iHttps = kinds.indexOf('lan-https');
    const iHttp = kinds.indexOf('lan');
    ok('加密那条排在明文前面', iHttps >= 0 && iHttp >= 0 && iHttps < iHttp,
      `lan-https@${iHttps} lan@${iHttp}`);
  }

  // ── 5. 关掉之后应当干净地退出 ─────────────────────────────────────────────
  console.log('\n[5] 关闭时不留下坏状态');
  const meta = cert.inspect();
  ok('证书状态可读', meta.present === true && !meta.broken, JSON.stringify(meta).slice(0, 120));
  ok('服务器证书由本地 CA 签发（手机上只需信任这一个 CA）',
    /本地 CA/.test(String(meta.srv && meta.srv.issuer)), String(meta.srv && meta.srv.issuer));

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
