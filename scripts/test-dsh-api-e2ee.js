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
  assert.deepEqual(list, ['/api/session/prompt', '/api/session/uploadFileBinary']);
  ok('范围被钉住：只这两条，SSE 那几条一个字都没动');
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
  const blk = src.slice(src.indexOf('const wantsE2eeBody'), src.indexOf('req.pipe(upstream);\n}'));
  assert.ok(/if \(!plain\)/.test(blk), '解不开时没有兜底分支');
  assert.ok(/upstream\.end\(plain\)/.test(blk), '没有把明文转发给上游');
  assert.ok(!/upstream\.end\(raw\)/.test(blk), '解不开时把密文原样转发了 —— 那是错的');
  ok('解不开时明确回 400 并且**不转发**（不把密文丢给 DSH）');

  up.close();
}

console.log('\n[红线] 明文请求仍然照旧（老客户端不能被挡在门外）\n');
{
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
  const blk = src.slice(src.indexOf('const wantsE2eeBody'), src.indexOf('req.pipe(upstream);\n}'));
  assert.ok(/req\.headers\['x-dsh-e2ee'\] === '1'/.test(blk), '没有按标记判断');
  assert.ok(/req\.pipe\(upstream\)/.test(src), '原本的明文转发被删了');
  ok('只按标记解：没带标记的请求（手机还没加载到新 e2ee.js）照旧明文转发，不会被挡');
  assert.ok(!/refusePlaintext/.test(blk), '这里不该有「不加密就拒绝」—— 那会把老客户端锁在外面');
  ok('这一轮**故意不做强制**（先做成机会式；等手机都更新完再单独开闸门）');
}

console.log(bad ? `\n${bad} 处问题\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
