// WebSocket 帧编解码 —— 为了让网关能在「帧」这一层加解密。
//
// 为什么需要它：网关要在中间把 WebSocket 里的**文本内容**解密后再转发给 DSH，
// 而 WebSocket 的每一段内容都包在帧里（有长度、掩码、opcode 等结构）。
// 想只换里面的内容、不动结构，就得能拆开再拼回去。
//
// 协议依据：RFC 6455 §5.2
//
//   byte0: FIN(1) RSV(3) opcode(4)
//   byte1: MASK(1) payloadLen(7)
//          len==126 → 后跟 2 字节长度
//          len==127 → 后跟 8 字节长度
//          MASK=1   → 后跟 4 字节掩码（客户端发的帧必须带掩码）
//   然后就是 payload（客户端发的要按掩码异或还原）
//
// 这个模块只做「拆帧 / 拼帧 / 改写文本载荷」，不做任何密码学 ——
// 加解密交给 e2ee.js。分开的好处是两边都能单独测。
'use strict';
const { isUtf8 } = require('node:buffer');

const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2;
const OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

/**
 * 从缓冲区里尽可能多地拆出完整帧。
 * @param {Buffer} buf
 * @returns {{frames: Array, rest: Buffer}} rest 是还没凑齐一个完整帧的尾巴
 */
function parseFrames(buf, options = {}) {
  const frames = [];
  let off = 0;
  const strict = options.strict === true;
  const maximum = options.maxPayloadBytes;
  const maxFrames = options.maxFrames;
  const refuse = code => { throw Object.assign(new Error('WebSocket frame refused.'), { code }); };
  if (strict && (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(maxFrames) || maxFrames < 1)) refuse('ws-frame-invalid');

  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (strict) {
      if ((b0 & 0x70) !== 0 || ![OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG, OP_CONT].includes(opcode)) refuse('ws-frame-invalid');
      // The current encrypted wire protocol carries a complete authenticated
      // envelope in one data frame. Never normalize a fragment into FIN=1.
      if (!fin || opcode === OP_CONT) refuse('ws-fragmentation-unsupported');
      if (frames.length >= maxFrames) refuse('ws-frame-count-limit');
    }

    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p); p += 2;
      if (strict && len < 126) refuse('ws-frame-invalid');
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(p); p += 8;
      // 一个帧超过 2GB 是不可能出现的；出现就说明流已经错位了
      if (strict && (big < 65536n || big > BigInt(maximum))) refuse(big < 65536n ? 'ws-frame-invalid' : 'ws-frame-too-large');
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) refuse('ws-frame-too-large');
      len = Number(big);
    }
    if (strict && len > maximum) refuse('ws-frame-too-large');
    if (strict && (opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) && (len > 125 || (opcode === OP_CLOSE && len === 1))) refuse('ws-control-invalid');

    let maskKey = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4); p += 4;
    }

    if (p + len > buf.length) break;      // 还没收全

    let payload = Buffer.from(buf.subarray(p, p + len));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    if (strict && opcode === OP_CLOSE && payload.length >= 2) {
      const code = payload.readUInt16BE(0);
      if (!((code >= 1000 && code <= 1014 && ![1004,1005,1006].includes(code)) || (code >= 3000 && code <= 4999)) || !isUtf8(payload.subarray(2))) refuse('ws-control-invalid');
    }

    frames.push({ fin, opcode, masked, maskKey, payload });
    off = p + len;
  }

  return { frames, rest: off < buf.length ? buf.subarray(off) : Buffer.alloc(0) };
}

/**
 * 拼一个帧。
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} mask  发给服务端的帧必须带掩码（RFC 要求）
 */
function buildFrame(opcode, payload, mask) {
  const len = payload.length;
  let head;

  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }

  head[0] = 0x80 | (opcode & 0x0f);      // FIN + opcode；分片帧我们不再产生

  if (!mask) return Buffer.concat([head, payload]);

  head[1] |= 0x80;
  const key = require('crypto').randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([head, key, masked]);
}

/** 这个 opcode 是不是「承载数据」的（控制帧不动） */
function isData(opcode) {
  return opcode === OP_TEXT || opcode === OP_BIN || opcode === OP_CONT;
}

module.exports = {
  parseFrames, buildFrame, isData,
  OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG
};
