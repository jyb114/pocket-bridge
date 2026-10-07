// WebSocket 帧编解码的自测。
//
// 这一段是整个加密方案里最容易出错的地方 —— 协议细节多（长度三档、
// 掩码、控制帧），而且错了之后表现是「连不上 / 消息乱掉」，
// 很难看出根因。所以单独测，测透了再往网关里接。
'use strict';
const wsf = require('./ws-frame.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

console.log('\n=== WebSocket 帧编解码 ===\n');

// ── 1. 各种长度都要正确（三档编码的分界点）──────────────────────────
const lens = [0, 1, 125, 126, 127, 128, 65535, 65536, 70000];
let lenOk = 0;
for (const n of lens) {
  const payload = Buffer.alloc(n, 0x41);
  for (const mask of [true, false]) {
    const frame = wsf.buildFrame(wsf.OP_TEXT, payload, mask);
    const { frames, rest } = wsf.parseFrames(frame);
    if (frames.length === 1 && rest.length === 0 &&
        frames[0].payload.equals(payload) && frames[0].opcode === wsf.OP_TEXT) lenOk++;
    else console.log(`      长度 ${n} mask=${mask} 失败`);
  }
}
ok('三档长度（0/125/126/127/65535/65536/70000）都能原样还原',
  lenOk === lens.length * 2, `${lenOk}/${lens.length * 2}`);

// ── 2. 客户端帧的掩码必须还原正确 ──────────────────────────────────
const secret = Buffer.from('这是一段会被掩码打乱的内容');
const masked = wsf.buildFrame(wsf.OP_TEXT, secret, true);
ok('带掩码的帧解析后内容正确',
  wsf.parseFrames(masked).frames[0].payload.equals(secret));
ok('掩码后的字节流确实和原文不同（掩码生效了）',
  masked.subarray(masked.length - secret.length).indexOf(secret) < 0);

// ── 3. 粘包 / 拆包 ────────────────────────────────────────────────
const a = wsf.buildFrame(wsf.OP_TEXT, Buffer.from('AAAA'), true);
const b = wsf.buildFrame(wsf.OP_TEXT, Buffer.from('BBBBBB'), true);
const both = wsf.parseFrames(Buffer.concat([a, b]));
ok('两个帧粘在一起能都拆出来', both.frames.length === 2 && both.rest.length === 0);
ok('拆出来的内容顺序正确',
  both.frames[0].payload.toString() === 'AAAA' && both.frames[1].payload.toString() === 'BBBBBB');

const half = wsf.parseFrames(a.subarray(0, 4));
ok('半个帧不会被误当成完整帧', half.frames.length === 0 && half.rest.length === 4);

// 先给半个，再补上另一半
const p1 = wsf.parseFrames(a.subarray(0, 3));
const p2 = wsf.parseFrames(Buffer.concat([p1.rest, a.subarray(3)]));
ok('补齐之后能正常拆出', p2.frames.length === 1 && p2.frames[0].payload.toString() === 'AAAA');

// ── 4. 控制帧不能被当成数据 ───────────────────────────────────────
ok('ping/pong/close 不算数据帧',
  !wsf.isData(wsf.OP_PING) && !wsf.isData(wsf.OP_PONG) && !wsf.isData(wsf.OP_CLOSE));
ok('text/binary/continuation 算数据帧',
  wsf.isData(wsf.OP_TEXT) && wsf.isData(wsf.OP_BIN) && wsf.isData(wsf.OP_CONT));

// ── 5. 改写载荷后，结构要完好（这是网关要做的事）─────────────────────
const original = wsf.buildFrame(wsf.OP_TEXT, Buffer.from('原始内容'), true);
const parsed = wsf.parseFrames(original);
const rewritten = wsf.buildFrame(parsed.frames[0].opcode,
  Buffer.from('替换后的内容，长很多很多很多'), true);
const reParsed = wsf.parseFrames(rewritten);
ok('改写载荷后仍是一帧合法数据',
  reParsed.frames.length === 1 &&
  reParsed.frames[0].payload.toString() === '替换后的内容，长很多很多很多');

// ── 6. 乱码输入不能把进程搞崩 ─────────────────────────────────────
let crashed = false;
for (let i = 0; i < 200; i++) {
  try {
    const junk = require('crypto').randomBytes(Math.floor(Math.random() * 40));
    wsf.parseFrames(junk);
  } catch (err) {
  // 数据错位时抛异常是可以接受的（调用方会断开连接），
  // 但不能是「无声地解析出错误的帧」——那个更危险
    if (err.code !== 'ws-frame-too-large' || err.message !== 'WebSocket frame refused.') crashed = true;
  }
}
ok('随机字节不会导致异常崩溃', !crashed);

let oversizedError;
try { wsf.parseFrames(Buffer.from([0x82,0x7f,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff])); }
catch (err) { oversizedError = err; }
ok('无法表示的 64 位帧长度明确拒绝', oversizedError &&
  oversizedError.code === 'ws-frame-too-large' && oversizedError.message === 'WebSocket frame refused.');

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
