// 经中继不许明文 —— 计划 D「失败拒绝而非明文回退」的验收测试。
//
// 背景：网关原来是「客户端要求加密才加密」。也就是说冒充者只要**不明说**
// 自己支持加密，网关就高高兴兴把明文递过去 —— mobile-proxy.js 里早把这条
// 记成「当前最大的安全缺口」。现在改成：有长期密钥 + 经中继 + 没要求加密
// → 直接拒绝，绝不降级发明文。
//
// 这个测试验四件事：
//   1. 经中继、不加密 → 拒绝（而且拒的是加密门，不是认证门）
//   2. 经中继、要求加密 → 放行，拿到的是密文
//   3. 本机直连、不加密 → 照常（本地使用不受影响，否则就是自伤）
//   4. WS 通道同样受这道门管 —— 它才是最长的通道，整个对话都在上面
//
// 怎么区分「加密门拒绝」和「认证门拒绝」：两者都是 403。所以先拿真会话，
// 认证过了再看响应体 —— 加密门回的是那句人话，认证门不是。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const e2ee = require('./e2ee.js');

const BASE = path.resolve(__dirname, '..');
const PORT = Number(process.env.DSH_GW_PORT || 8080);
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const SECRET = (() => {
  try { return fs.readFileSync(path.join(BASE, 'logs', 'e2ee-secret.txt'), 'utf8').trim(); }
  catch (err) { return ''; }
})();

const RELAY_HEADERS = {
  'cf-connecting-ip': '203.0.113.7',
  'cf-ray': '8a1b2c3d4e5f6789-SJC'
};

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

function request(pathname, headers, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: opts.method || 'GET',
      headers: Object.assign({ host: `127.0.0.1:${PORT}` }, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('超时')); });
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

/** 按网关那套布局加密（iv|tag|密文），用来伪造一个"会加密的客户端" */
function encryptForServer(plaintext) {
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  return e2ee.encrypt(keys.a, Buffer.from(plaintext));
}
/** 解开网关回的密文 */
function decryptFromServer(buf) {
  for (const k of e2ee.candidateKeys(SECRET)) {
    try { const p = e2ee.decrypt(k.b, buf); if (p) return p; } catch (err) { }
  }
  return null;
}

/** 裸发一个 WS 升级请求，只读回响应头 —— 升级成功是 101，被拒是 403。 */
function rawUpgrade(pathname, headers) {
  return new Promise((resolve) => {
    let buf = '';
    const sock = net.connect(PORT, '127.0.0.1', () => {
      const h = Object.assign({
        Host: `127.0.0.1:${PORT}`, Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
      }, headers || {});
      let raw = `GET ${pathname} HTTP/1.1\r\n`;
      for (const k of Object.keys(h)) raw += `${k}: ${h[k]}\r\n`;
      sock.write(raw + '\r\n');
    });
    const done = () => { try { sock.destroy(); } catch (e) { } resolve(buf); };
    sock.on('data', (c) => { buf += c.toString('utf8'); if (buf.includes('\r\n\r\n')) setTimeout(done, 60); });
    sock.on('error', done);
    sock.setTimeout(8000, done);
  });
}

/** 找一张够大的真图片当测试素材（和 test-file-e2ee.js 一套找法） */
function findImage() {
  let best = null;
  const walk = (d, depth) => {
    if (depth > 4 || best) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const x of items) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(png|jpe?g)$/i.test(x.name)) continue;
      try { if (fs.statSync(p).size > 100 * 1024) { best = p; return; } } catch (e) { }
    }
  };
  for (const r of ['Documents', 'Desktop', 'Pictures']) walk(path.join(os.homedir(), r), 0);
  return best;
}

const isPlainImage = (b) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8);
// 加密门回的那句人话（三种语言里认一个）
const looksRefused = (buf) => /必须加密|must be encrypted|debe ir cifrado/.test(buf.toString('utf8'));

(async () => {
  console.log('\n=== 经中继不许明文（拒绝而非降级）===\n');

  if (!SECRET) {
    console.log('  这台电脑上没有长期密钥（logs/e2ee-secret.txt 不存在），无从加密，跳过\n');
    process.exitCode = 1;
    return;
  }
  console.log(`  网关 127.0.0.1:${PORT}   长期密钥 ${SECRET.slice(0, 6)}…`);

  const img = findImage();
  if (!img) { console.log('  找不到测试图片，跳过\n'); process.exitCode = 1; return; }
  console.log(`  测试图片 ${path.basename(img)}（${Math.round(fs.statSync(img).size / 1024)} KB）\n`);

  // ── 先拿一个真会话，把「认证门」排除掉 ────────────────────────────────────
  const enter = await request(`/k/${KEY}`);
  const cookie = (enter.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
  if (!cookie) { console.log('  拿不到会话 cookie，后面的判断都不可信，中止\n'); process.exitCode = 1; return; }

  const filePath = `/codex/file?path=${encodeURIComponent(img)}&root=${encodeURIComponent(path.dirname(img))}`;

  // ── 1. 经中继、不加密 → 必须拒绝 ─────────────────────────────────────────
  console.log('[1] 经中继、不加密');
  const relayPlain = await request(filePath, Object.assign({ cookie }, RELAY_HEADERS));
  ok('被拒绝（403）', relayPlain.status === 403, String(relayPlain.status));
  ok('拒的是加密门，不是认证门', looksRefused(relayPlain.body));
  ok('没有把明文图片发出去', !isPlainImage(relayPlain.body));

  // 光靠 cf-* 头还不够 —— 隧道域名这条判据也要生效（有的部署未必带头）
  const relayByHost = await request(filePath, { cookie, host: 'demo-test.trycloudflare.com' });
  ok('只凭隧道域名也能认出来', relayByHost.status === 403 && looksRefused(relayByHost.body),
    String(relayByHost.status));

  // ── 2. 经中继、要求加密 → 放行，拿到密文 ─────────────────────────────────
  console.log('\n[2] 经中继、要求加密');
  const relayEnc = await request(filePath + '&e2ee=1', Object.assign({ cookie }, RELAY_HEADERS));
  ok('放行（200）', relayEnc.status === 200, relayEnc.status + ' ' + relayEnc.body.toString('utf8').slice(0, 100));
  ok('带上了加密标记 x-dsh-e2ee', relayEnc.headers['x-dsh-e2ee'] === '1');
  ok('发出来的不是明文图片（中继看不到内容）', !isPlainImage(relayEnc.body));
  ok('原始 MIME 通过头部告知，解开后仍能显示', !!relayEnc.headers['x-dsh-e2ee-type']);

  // ── 3. 本机直连、不加密 → 照常（否则就是自伤）────────────────────────────
  console.log('\n[3] 本机直连、不加密');
  const localPlain = await request(filePath, { cookie });
  ok('照常放行（200）', localPlain.status === 200, localPlain.status + ' ' + localPlain.body.toString('utf8').slice(0, 100));
  ok('本机拿到的仍是明文（局域网/本机另有 HTTPS 那条路）', isPlainImage(localPlain.body));

  // ── 4. WS 通道（最长的那条，整个对话都在上面）────────────────────────────
  console.log('\n[4] WS 通道');
  const wsPlain = await rawUpgrade('/codex/ws', Object.assign({ cookie }, RELAY_HEADERS));
  ok('经中继、不要求加密 → 拒绝升级', /^HTTP\/1\.1 403/.test(wsPlain), wsPlain.split('\r\n')[0]);
  ok('拒绝理由是加密，不是认证', looksRefused(wsPlain));

  const wsLocal = await rawUpgrade('/codex/ws', { cookie });
  ok('本机、不要求加密 → 不被加密门拦（仍然能升级）', !looksRefused(wsLocal), wsLocal.split('\r\n')[0]);

  // ── 5. 真中继（可选）──────────────────────────────────────────────────────
  //
  // 上面 [1][2] 是**伪造中继头**在回环上验的。这一段走真的 Cloudflare，
  // 验「拒绝」和「带钥匙仍能用」这两件事在真实链路上也成立 ——
  // 只验拒绝是不够的：万一连正常手机也一起拒了，那是把人锁在门外，
  // 而伪造头的测试看不出来。
  //
  // 默认不跑：它依赖外面那条隧道活着，而免费隧道随时会被回收
  // （这个项目一个会话里就被回收过 3 次）。要手动验一次真实中继：
  //   DSH_GW_E2EE_TUNNEL=1 node scripts/test-e2ee-failclosed.js
  if (process.env.DSH_GW_E2EE_TUNNEL === '1') {
    console.log('\n[5] 真中继（Cloudflare，可选段）');
    const https = require('https');
    const host = (() => {
      try {
        const log = fs.readFileSync(path.join(BASE, 'logs', 'daemon.log'), 'utf8');
        const m = [...log.matchAll(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/g)];
        return m.length ? m[m.length - 1][1] : null;
      } catch (err) { return null; }
    })();
    if (!host) {
      ok('能从 daemon.log 里找到隧道地址', false, '找不到，跳过这一段');
    } else {
      console.log(`  隧道 ${host}`);
      const viaTunnel = (p) => new Promise((resolve, reject) => {
        const req = https.get({ host, port: 443, path: p, headers: { cookie } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.setTimeout(45000, () => { req.destroy(new Error('超时')); });
      });

      const tPlain = await viaTunnel(filePath);
      ok('真中继、不加密 → 被拒绝', tPlain.status === 403 && looksRefused(tPlain.body), String(tPlain.status));
      ok('真中继 → 没有泄露明文图片', !isPlainImage(tPlain.body));

      const tEnc = await viaTunnel(filePath + '&e2ee=1');
      // 这一条是**不能弄坏正常手机**的证明：带钥匙的客户端必须照常拿到密文。
      ok('真中继、带钥匙 → 照常放行（手机不会被锁在门外）', tEnc.status === 200, String(tEnc.status));
      ok('真中继、带钥匙 → 拿到的是密文', tEnc.headers['x-dsh-e2ee'] === '1' && !isPlainImage(tEnc.body));
    }
  }

  const REQUEST_H = { 'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1' };

  // ── 6. 队列 / 上传 / 会话列表（正文通道，本轮新加的）──────────────────────
  //
  // 这三条原来整个是明文过中继的。现在客户端会加密（e2ee.js 的 encryptedFetch），
  // 网关侧统一套了一层（mobile-proxy.js 的 e2eeWrap），所以这里验两头：
  //   · 不加密 → 拒绝
  //   · 加密 → 真的解得开、响应也真的是密文
  console.log('\n[6] 队列 / 上传 / 会话列表');
  const relayH = Object.assign({ cookie }, RELAY_HEADERS);

  const thPlain = await request('/codex/threads', relayH);
  ok('会话列表：经中继不加密 → 拒绝', thPlain.status === 403 && looksRefused(thPlain.body), String(thPlain.status));

  const thEnc = await request('/codex/threads', Object.assign({ cookie, 'x-dsh-e2ee': '1' }, RELAY_HEADERS));
  ok('会话列表：带加密标记 → 放行', thEnc.status === 200, String(thEnc.status));
  ok('会话列表：响应是密文', thEnc.headers['x-dsh-e2ee'] === '1');
  const thJson = decryptFromServer(thEnc.body);
  ok('会话列表：解得开，还是原来的 JSON', !!thJson && (() => {
    try { return typeof JSON.parse(thJson.toString('utf8')).ok === 'boolean'; } catch (e) { return false; }
  })());
  ok('会话列表：原始类型通过头部还原', thEnc.headers['x-dsh-e2ee-type'] === 'application/json; charset=utf-8',
    String(thEnc.headers['x-dsh-e2ee-type']));

  const qPlain = await request('/codex/queue?threadId=x', relayH);
  ok('队列：经中继不加密 → 拒绝', qPlain.status === 403 && looksRefused(qPlain.body), String(qPlain.status));

  // 上传这条用「故意不合规的请求」验往返：加密体发过去，网关得先解开才知道
  // 少了 x-dsh-upload 头，然后回一个**加密的** 403 JSON。
  // 这样既证明了请求体真被解开、响应真被加密，又不会在磁盘上留下任何文件。
  const upEnc = await request('/codex/upload?name=e2ee-probe.txt',
    Object.assign({ cookie }, RELAY_HEADERS, REQUEST_H),
    { method: 'POST', body: encryptForServer('端到端加密往返探针') });
  ok('上传：请求体能被解开（网关认得出这是不合规请求）', upEnc.status === 403, String(upEnc.status));
  ok('上传：连错误响应也是密文，不是明文', upEnc.headers['x-dsh-e2ee'] === '1');
  const upJson = decryptFromServer(upEnc.body);
  ok('上传：错误 JSON 解得开', !!upJson && /无效上传请求/.test(upJson.toString('utf8')),
    upJson ? upJson.toString('utf8').slice(0, 60) : '(解不开)');

  // 坏密文必须被拒，不能当成明文处理
  const badCt = await request('/codex/queue?threadId=x',
    Object.assign({ cookie }, RELAY_HEADERS, REQUEST_H),
    { method: 'POST', body: Buffer.from('这不是密文，是随便一段字节') });
  ok('上传/队列：坏密文被拒绝（不会被当成明文）', badCt.status === 400, String(badCt.status));
  ok('坏密文的拒绝理由说得清', /没能解密|明文不会走中继/.test(badCt.body.toString('utf8')));

  console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
