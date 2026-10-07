// 加密变换层的自测：模拟真实的 WebSocket 数据流，验证
//   · 手机发的密文 → 网关解出明文
//   · 网关发的明文 → 变成密文
//   · 分片到达、粘包、控制帧穿插都不出错
//
// 这一段错了的表现是「连不上」或「消息乱掉」，很难查，所以要测透。
'use strict';
require('./replay-isolated-fixture.js').install();
const { WsCrypto } = require('./ws-crypt.js');
const wsf = require('./ws-frame.js');
const e2ee = require('./e2ee.js');

const SECRET = 'interop-test-longterm-secret-xyz';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

/** 把一段字节喂给变换层，收集所有输出 */
function feed(crypto, chunks) {
  const out = [];
  for (const c of chunks) {
    const r = crypto.push(c);
    if (r.length) out.push(r);
  }
  return Buffer.concat(out);
}

console.log('\n=== WebSocket 加密变换层 ===\n');

// ── 1. 手机加密的消息，网关能解出明文 ──────────────────────────────
{
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const json = JSON.stringify({ jsonrpc: '2.0', method: 'thread/list', params: { limit: 5 } });

  // 手机侧：加密后按 binary 帧发出（带掩码，因为是客户端发的）
  const ct = e2ee.encrypt(keys.a, json);
  const wire = wsf.buildFrame(wsf.OP_BIN, ct, true);

  const gw = new WsCrypto(SECRET, 'decrypt');
  const out = feed(gw, [wire]);
  const frames = wsf.parseFrames(out).frames;

  ok('手机发的密文 → 网关解出明文',
    frames.length === 1 && frames[0].payload.toString('utf8') === json,
    frames.length ? frames[0].payload.toString('utf8').slice(0, 50) : '没有输出');
  ok('解开后 opcode 改回 text（因为我们知道它是 JSON）',
    frames.length === 1 && frames[0].opcode === wsf.OP_TEXT);
}

// ── 2. 网关发出的明文变成密文，且看不到原文 ────────────────────────
{
  const plain = JSON.stringify({ type: 'agentMessage', text: '这段中文绝不该出现在隧道里' });
  const wire = wsf.buildFrame(wsf.OP_TEXT, Buffer.from(plain), false);  // 服务端发的帧不带掩码

  const gw = new WsCrypto(SECRET, 'encrypt');
  const out = feed(gw, [wire]);
  const frames = wsf.parseFrames(out).frames;

  ok('明文 → 密文', frames.length === 1);
  ok('密文标成 binary（不会被当文本解码）',
    frames.length === 1 && frames[0].opcode === wsf.OP_BIN);
  ok('密文里看不到原文', out.toString('utf8').indexOf('绝不该出现') < 0);

  // 手机侧能解开
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const back = e2ee.decrypt(keys.b, frames[0].payload);
  ok('手机侧能解开', back && back.toString('utf8') === plain);
}

// ── 3. 分片到达（TCP 不保证一次一个完整帧）─────────────────────────
{
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const json = JSON.stringify({ text: '分片测试' });
  const wire = wsf.buildFrame(wsf.OP_BIN, e2ee.encrypt(keys.a, json), true);

  const gw = new WsCrypto(SECRET, 'decrypt');
  // 一个字节一个字节地喂 —— 最极端的分片情况
  const chunks = [];
  for (let i = 0; i < wire.length; i++) chunks.push(wire.subarray(i, i + 1));
  const out = feed(gw, chunks);
  const frames = wsf.parseFrames(out).frames;

  ok('逐字节喂也能正确解出',
    frames.length === 1 && frames[0].payload.toString('utf8') === json);
}

// ── 4. 粘包（一次来三个帧）─────────────────────────────────────────
{
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const msgs = ['第一条', '第二条', '第三条'];
  const wire = Buffer.concat(msgs.map((m) =>
    wsf.buildFrame(wsf.OP_BIN, e2ee.encrypt(keys.a, m), true)));

  const gw = new WsCrypto(SECRET, 'decrypt');
  const out = feed(gw, [wire]);
  const frames = wsf.parseFrames(out).frames;

  ok('三个帧粘在一起能全部解出',
    frames.length === 3 && frames.every((f, i) => f.payload.toString('utf8') === msgs[i]),
    `${frames.length} 帧`);
}

// ── 5. 控制帧原样透传（不能加密，否则协议会断）─────────────────────
{
  const gw = new WsCrypto(SECRET, 'encrypt');
  const ping = wsf.buildFrame(wsf.OP_PING, Buffer.from('ka'), false);
  const out = feed(gw, [ping]);
  const frames = wsf.parseFrames(out).frames;

  ok('ping 帧原样透传（没被加密）',
    frames.length === 1 && frames[0].opcode === wsf.OP_PING &&
    frames[0].payload.toString() === 'ka');
}

// ── 6. 协商加密后，第一条数据帧也必须通过认证 ─────────────────────
{
  // HTTP upgrade is handled by ws-e2ee-bridge, not by this data-frame layer.
  const plainFrame = wsf.buildFrame(wsf.OP_TEXT, Buffer.from('{"hello":1}'), true);
  const gw = new WsCrypto(SECRET, 'decrypt');
  const out = feed(gw, [plainFrame]);
  const frames = wsf.parseFrames(out).frames;

  ok('加密连接拒绝未认证首帧',
    frames.length === 0 && gw.rejected === 1,
    `${frames.length} 帧`);
}

// ── 7. 明文和密文混着来 ────────────────────────────────────────────
{
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const plainFrame = wsf.buildFrame(wsf.OP_TEXT, Buffer.from('明文一'), true);
  const encFrame = wsf.buildFrame(wsf.OP_BIN, e2ee.encrypt(keys.a, '密文二'), true);

  const gw = new WsCrypto(SECRET, 'decrypt');
  const out = feed(gw, [Buffer.concat([plainFrame, encFrame])]);
  const frames = wsf.parseFrames(out).frames;

  ok('混合输入只放行经过认证的密文',
    frames.length === 1 &&
    frames[0].payload.toString('utf8') === '密文二',
    frames.map((f) => f.payload.toString('utf8')).join(' | '));
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
