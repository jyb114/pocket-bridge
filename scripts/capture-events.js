// DSH 移动端网关 — 事件流捕获（诊断用）
//
// 目的：搞清楚「agent 干完一轮」在 DSH 的实时事件流里长什么样。
// 知道了这个信号，中间层就能直接据此触发通知 —— 不必依赖 DSH 的 hook 插件
// （那套依赖插件加载，而且升级可能变化；事件流是 DSH 的核心通信，更稳）。
//
// 用法：node capture-events.js <wsUrl> <cookieFile> <outFile> [holdMs]
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const [, , wsUrl, cookieFile, outFile, holdMsArg] = process.argv;
const HOLD = Number(holdMsArg || 60000);

let cookie = '';
try { cookie = fs.readFileSync(cookieFile, 'utf8').replace(/^\uFEFF/, '').trim(); } catch (err) { }

const out = { startedAt: new Date().toISOString(), wsUrl, frames: [], note: '' };
const t0 = Date.now();
const tick = () => Date.now() - t0;

function save() {
  try { fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8'); } catch (err) { }
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

function encodeTextFrame(text) {
  return encodeFrame(0x1, Buffer.from(text, 'utf8'));
}

function drain(buf, onFrame) {
  let off = 0;
  for (;;) {
    if (off + 2 > buf.length) break;
    const b1 = buf[off + 1];
    const opcode = buf[off] & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mk = null;
    if (masked) { if (p + 4 > buf.length) break; mk = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    let payload = buf.subarray(p, p + len);
    if (mk) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ mk[i % 4]; payload = u; }
    onFrame(opcode, payload);
    off = p + len;
  }
  return off;
}

try {
  const u = new URL(wsUrl);
  const secure = u.protocol === 'wss:';
  const transport = secure ? https : http;

  const req = transport.request({
    host: u.hostname,
    port: u.port || (secure ? 443 : 80),
    path: u.pathname + u.search,
    method: 'GET',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      cookie
    }
  });

  req.on('upgrade', (res, socket) => {
    out.note = '已升级';
    let acc = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      const used = drain(acc, (opcode, payload) => {
        // 收到 ping 必须回 pong。不回的话 DSH 会在几秒后直接关掉连接 ——
        // 这一点最初就踩过，捕获脚本因此只看到了 ready 帧。
        if (opcode === 0x9) {
          try { socket.write(encodeFrame(0xA, payload)); } catch (err) { /* 连接已断 */ }
        }

        if (out.frames.length >= 400) return;
        const rec = { t: tick(), op: '0x' + opcode.toString(16) };
        if (opcode === 0x1) {
          const text = payload.toString('utf8');
          rec.len = text.length;
          rec.text = text.slice(0, 500);
          try {
            const j = JSON.parse(text);
            rec.jsonType = j.type;
            if (j.value && typeof j.value === 'object') {
              rec.valueType = j.value.type;
              // 事件流里的转发事件通常带 event 字段
              if (j.value.event) rec.event = j.value.event;
            }
          } catch (err) { /* 不是 JSON */ }
        } else {
          rec.len = payload.length;
        }
        out.frames.push(rec);
      });
      acc = acc.subarray(used);
      save();
    });

    socket.on('close', () => { out.note = '连接已关闭'; save(); });
    socket.on('error', (err) => { out.note = 'socket 错误: ' + err.message; save(); });

    // 订阅事件流
    socket.write(encodeTextFrame(JSON.stringify({
      type: 'open',
      streamId: crypto.randomUUID(),
      endpoint: '$events',
      payload: { args: {} }
    })));
    save();
  });

  req.on('response', (res) => {
    out.note = '握手被拒: HTTP ' + res.statusCode;
    res.resume();
    save();
  });

  req.on('error', (err) => {
    out.note = '请求错误: ' + err.message;
    save();
  });

  req.end();
} catch (err) {
  out.note = '异常: ' + err.message;
  save();
}

setTimeout(() => {
  out.endedAt = new Date().toISOString();
  out.totalFrames = out.frames.length;
  save();
  process.exit(0);
}, HOLD);
