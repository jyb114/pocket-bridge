// DSH 那套 HTTP API 的「发出去的正文」加密了吗？
//
// 安全目标：发给电脑的消息正文应避开隧道的明文视野。
// 而查出来的缺口是：`POST /api/session/prompt` 的请求体就是
// `content:[{type:'text',text:…}]` —— 明文过隧道，正常转发就看得见。
//
// 这一条测试把整条链走一遍（不碰真 DSH、不发真消息）：
//   客户端补丁加密 → 网关解开 → 交给上游的那份**必须和原来一模一样**。
// 同时钉住：密文里绝对搜不到正文；解不开时**不许**把密文转发出去。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const e2ee = require('./e2ee.js');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { bad++; console.log(`  ✗ ${m}`); };

const SECRET = 'test-secret-for-dsh-api-0123456789';   // 32 字节量级
const SAY = '这是要发给电脑的一句话：把中药抗微生物那篇的结论改一下';

(async () => {
console.log('\n[客户端] 哪几条请求会被加密\n');
{
  const src = fs.readFileSync(path.join(BASE, 'pwa', 'e2ee.js'), 'utf8');
  assert.ok(/CONTENT_API_PATHS\s*=\s*\[/.test(src), '找不到 CONTENT_API_PATHS');
  assert.ok(src.includes("'/api/session/prompt'"), 'session/prompt 不在加密名单里');
  assert.ok(src.includes("'/api/session/uploadFileBinary'"), 'uploadFileBinary 不在加密名单里');
  ok('加密名单里有 session/prompt（你打出去的字）和 uploadFileBinary（附件字节）');
  assert.ok(/installRequestEncrypt\(secret\)/.test(src) && /installXhrRequestEncrypt\(secret\)/.test(src),
    'start() 里没有装上请求加密补丁');
  ok('start() 里两条通道（fetch / XHR）都装上了补丁');

  // 补丁的作用域必须**只**覆盖这几条，别的 /api/** 不能动（里面有 SSE）
  const m = src.match(/var CONTENT_API_PATHS = \[([\s\S]*?)\];/);
  const list = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(list, ['/__dsh/directories', '/__dsh/lite-rpc', '/__dsh/lite-upload',
    '/__dsh/lite-download', '/__dsh/lite-files', '/__dsh/legacy-rpc',
    '/api/session/prompt', '/api/session/uploadFileBinary']);
  ok('范围被钉住：目录、轻量 RPC 和消息正文加密，SSE 不变');
}

console.log('\n[链路] 客户端加密 → 网关解开 → 上游拿到的必须一字不差\n');
{
  // 假 DSH：把收到的请求体原样记下来
  let got = null;
  const up = http.createServer((req, res) => {
    const b = [];
    req.on('data', (c) => b.push(c));
    req.on('end', () => {
      got = { url: req.url, type: req.headers['content-type'], body: Buffer.concat(b).toString('utf8') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"accepted":true}');
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upPort = up.address().port;

  // 假网关：只跑 proxyRequest 里那段「带正文就解开」的逻辑
  // （不能直接把整个 mobile-proxy 拉起来 —— 那会碰真的 DSH 和真隧道）
  const plain = Buffer.from(JSON.stringify({ requestId: 'r1', sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: SAY }] }));
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const ct = e2ee.encrypt(keys.a, plain);

  // 密文里绝不能出现正文（这就是隧道会看到的东西）
  if (ct.includes(Buffer.from(SAY, 'utf8'))) fail('密文里居然能搜到正文');
  else ok(`密文里搜不到正文（密文 ${ct.length} 字节 / 明文 ${plain.length} 字节）`);
  if (/sessionId|content/.test(ct.toString('latin1'))) fail('密文里能搜到字段名 —— 那不是真密文');
  else ok('密文里也搜不到任何字段名（隧道看到的是一段二进制）');

  // 把密文交给「网关那一半」：解开 → 用明文转发给上游
  let plainAtGateway = null;
  for (const k of e2ee.candidateKeys(SECRET)) { plainAtGateway = e2ee.decrypt(k.a, ct); if (plainAtGateway) break; }
  assert.ok(plainAtGateway, '网关解不开自己客户端发来的密文');
  assert.equal(plainAtGateway.toString('utf8'), plain.toString('utf8'));
  ok('网关解出来的明文和客户端原来的请求体**完全一致**');

  // 真正转给上游（模拟 proxyRequest 的转发）
  await new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port: upPort, method: 'POST', path: '/api/session/prompt',
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(plainAtGateway.length) }
    }, (x) => { x.resume(); x.on('end', resolve); });
    r.end(plainAtGateway);
  });
  assert.ok(got, '上游没收到请求');
  assert.equal(got.type, 'application/json; charset=utf-8');
  assert.equal(got.body, plain.toString('utf8'));
  ok('上游 DSH 收到的 content-type 和 JSON 都和加密前一样（它完全不知道有加密这回事）');

  // ★ 解不开时**不许**把密文转给上游（否则 DSH 会当成坏 JSON，使用者看到一句莫名的错）
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
  const blk = require('./page-source.js').extractFunction(src, 'proxyRequest');
  assert.ok(blk, '找不到实际代理函数');
  assert.ok(/if \(!plain\)/.test(blk), '解不开时没有兜底分支');
  assert.ok(/upstream\.end\(plain\)/.test(blk), '没有把明文转发给上游');
  assert.ok(!/upstream\.end\(raw\)/.test(blk), '解不开时把密文原样转发了 —— 那是错的');
  ok('解不开时明确回 400 并且**不转发**（不把密文丢给 DSH）');

  up.close();
}

console.log('\n[红线] 旧界面加密失败时，经隧道不能降级发送明文\n');
{
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
  const blk = require('./page-source.js').extractFunction(src, 'proxyRequest');
  assert.ok(blk, '找不到实际代理函数');
  assert.ok(/req\.headers\['x-dsh-e2ee'\] === '1'/.test(blk), '没有按标记判断');
  assert.ok(/req\.pipe\(upstream\)/.test(src), '原本的明文转发被删了');
  const routes = (src.match(/const E2EE_CONTENT_PATHS = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
  for (const route of ['/api/session/prompt', '/api/session/uploadFileBinary']) {
    assert.ok(routes.includes(`'${route}'`), `${route} 没有列入隧道加密闸门`);
  }
  const gate = src.match(/if \(E2EE_CONTENT_PATHS\.has\(u\.pathname\)[\s\S]{0,180}refusePlaintext\(req, res, u\.pathname\);/) || [];
  assert.ok(gate.length, '内容路径未在代理前被拒绝明文');
  const wantsSource = require('./page-source.js').extractFunction(src, 'clientWantsE2ee');
  const wants = vm.runInNewContext(`${wantsSource}; clientWantsE2ee`, {});
  for (const route of ['/api/session/prompt', '/api/session/uploadFileBinary']) {
    assert.equal(wants({ headers: {} }, new URL(`http://relay.test${route}?e2ee=1`)), false,
      `${route} 被查询参数伪装为加密请求`);
    assert.equal(wants({ headers: { 'x-dsh-e2ee': '1', 'content-type': 'application/json' } },
      new URL(`http://relay.test${route}`)), false, `${route} 接受明文 JSON 标记`);
    assert.equal(wants({ headers: { 'x-dsh-e2ee': '1', 'content-type': 'application/octet-stream' } },
      new URL(`http://relay.test${route}`)), true, `${route} 拒绝已加密的二进制信封`);
  }
  ok('原版 DSH 的提示词及附件入口列入经中继必加密清单；明文会在进入代理前被拒绝');
  ok('只加 ?e2ee=1 或只伪造标记不能让原版 DSH 的明文请求越过闸门');
  ok('本机与内网保留旧版请求兼容；加密请求仍由网关解开后送给本机 DSH');
}

console.log(bad ? `\n${bad} 处问题\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
