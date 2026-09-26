// 验证「可选加密」的三条规则，以及握手响应不会被当成帧解析。
//
// 这几条任何一条错了，表现都是「突然连不上」——所以要说清楚、测清楚。
'use strict';
const fs = require('fs');
const path = require('path');
const bridge = require('./ws-e2ee-bridge.js');
const e2ee = require('./e2ee.js');
const wsf = require('./ws-frame.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

const SECRET = 'bridge-test-secret-0123456789';

console.log('\n=== 加密桥接：开关规则与握手处理 ===\n');

// ── 1. 三条开关规则 ──────────────────────────────────────────────
ok('没生成密钥 → 不加密（老用户完全不受影响）',
  bridge.wanted('/ws?e2ee=1', null) === false);

ok('有密钥但手机没说要 → 不加密（老书签照常能用）',
  bridge.wanted('/ws', SECRET) === false);

ok('有密钥且手机说了 e2ee=1 → 加密',
  bridge.wanted('/ws?e2ee=1', SECRET) === true);

ok('参数混在别的里面也认得出来',
  bridge.wanted('/codex/ws?foo=1&e2ee=1&bar=2', SECRET) === true);

// ── 2. 握手响应必须原样透传，不能被当帧解析 ──────────────────────
{
  const b = bridge.attach(SECRET);
  const handshake = Buffer.from(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: abc123\r\n\r\n');

  const out1 = b.fromUpstream(handshake);
  ok('握手响应原样返回（一个字节不改）', out1.equals(handshake),
    out1.length + ' vs ' + handshake.length);
  ok('握手之后才进入加密状态', b.isReady() === true);
}

// ── 3. 握手响应分片到达 ──────────────────────────────────────────
{
  const b = bridge.attach(SECRET);
  const handshake = Buffer.from('HTTP/1.1 101 X\r\nA: b\r\n\r\n');
  const half1 = b.fromUpstream(handshake.subarray(0, 10));
  const half2 = b.fromUpstream(handshake.subarray(10));
  ok('握手响应分两次到达也能拼对',
    half1.length === 0 && half2.equals(handshake),
    `${half1.length} + ${half2.length}`);
}

// ── 4. 握手响应和第一帧粘在一起 ──────────────────────────────────
{
  const b = bridge.attach(SECRET);
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const msg = JSON.stringify({ hello: 'world' });
  const frame = wsf.buildFrame(wsf.OP_TEXT, Buffer.from(msg), false);
  const handshake = Buffer.from('HTTP/1.1 101 X\r\n\r\n');

  const out = b.fromUpstream(Buffer.concat([handshake, frame]));
  const head = out.subarray(0, handshake.length);
  const rest = out.subarray(handshake.length);

  ok('握手和第一帧粘在一起也能正确切开', head.equals(handshake));
  const fr = wsf.parseFrames(rest).frames;
  ok('第一帧被加密了（标成 binary）', fr.length === 1 && fr[0].opcode === wsf.OP_BIN);
  const back = e2ee.decrypt(keys.b, fr[0].payload);
  ok('手机侧能解开第一帧', back && back.toString('utf8') === msg);
}

// ── 5. 双向走通一遍 ──────────────────────────────────────────────
{
  const b = bridge.attach(SECRET);
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  // 真实顺序：先握手，再走数据
  b.fromUpstream(Buffer.from('HTTP/1.1 101 X\r\n\r\n'));

  // 手机发来：加密的
  const ask = JSON.stringify({ method: 'thread/list' });
  const fromPhone = wsf.buildFrame(wsf.OP_BIN, e2ee.encrypt(keys.a, ask), true);
  const toUpstream = b.fromClient(fromPhone);
  const upFrames = wsf.parseFrames(toUpstream).frames;

  ok('手机→电脑：解开成明文',
    upFrames.length === 1 && upFrames[0].payload.toString('utf8') === ask);

  // 电脑回：明文，应当被加密
  const reply = JSON.stringify({ result: { data: [] } });
  const toPhone = b.fromUpstream(wsf.buildFrame(wsf.OP_TEXT, Buffer.from(reply), false));
  const downFrames = wsf.parseFrames(toPhone).frames;

  ok('电脑→手机：变成密文', downFrames.length === 1 && downFrames[0].opcode === wsf.OP_BIN,
    `${downFrames.length} 帧`);
  ok('密文里看不到回复内容', toPhone.toString('utf8').indexOf('result') < 0);
  const dec = downFrames.length ? e2ee.decrypt(keys.b, downFrames[0].payload) : null;
  ok('手机侧能解开回复', dec && dec.toString('utf8') === reply);
}

// ── 5b. 保险阀：握手响应异常时不能把连接吞死 ─────────────────────
{
  const b = bridge.attach(SECRET);
  // 对面回了一堆不是 HTTP 的东西
  const junk = Buffer.alloc(9000, 0x41);
  const out = b.fromUpstream(junk);
  ok('握手响应异常时会放行，不会一直吞（保险阀）',
    out.length > 0 && b.isReady() === true, out.length + ' 字节');
}

// ── 6. 控制帧在加密连接上也要透传 ────────────────────────────────
{
  const b = bridge.attach(SECRET);
  b.fromUpstream(Buffer.from('HTTP/1.1 101 X\r\n\r\n'));   // 先过握手
  const pong = wsf.buildFrame(wsf.OP_PONG, Buffer.from('hb'), false);
  const out = b.fromUpstream(pong);
  const fr = wsf.parseFrames(out).frames;
  ok('加密连接上 ping/pong 照样透传',
    fr.length === 1 && fr[0].opcode === wsf.OP_PONG && fr[0].payload.toString() === 'hb');
}

// ── 7. 密钥文件读写 ──────────────────────────────────────────────
{
  const s = e2ee.newLongTermSecret();
  ok('生成的密钥长度够（>= 16 字符）', s.length >= 16, s.length + ' 字符');
  ok('每次生成都不一样', e2ee.newLongTermSecret() !== e2ee.newLongTermSecret());
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
