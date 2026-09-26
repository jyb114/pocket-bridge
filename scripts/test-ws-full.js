// DSH 移动端网关 — 完整 Remote 协议诊断
//
// 之前的探测只做了 WebSocket 握手，所以什么也收不到 —— 这个协议要求客户端
// 先发一条「开流」消息，服务器才会推送：
//
//   客户端 → { type: "open", streamId, endpoint, payload }
//   服务器 → { type: "item", streamId, value } | { type: "end", streamId } | { type: "error", ... }
//
// 事件流用 endpoint = "$events"、payload = { args: {} }，而且它的第一个 item
// 必须是 { type: "ready", clientId, host: { home } } —— 客户端只有收到 ready
// 才会认为连接建立成功。收不到就无限重连，界面表现为「打得开但没有数据」。
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [, , wsUrl, cookieFile, logFile, holdMsArg, hostOverride] = process.argv;
require('./probe-args.js').requireArgs(process.argv, ['wsUrl', 'cookieFile', 'logFile'],
  'node scripts/test-ws-full.js <wsUrl> <cookieFile> <logFile> [holdMs] [host]');

let cookie = '';
try {
  cookie = fs.readFileSync(cookieFile, 'utf8').replace(/^\uFEFF/, '').trim();
} catch (err) { cookie = ''; }

const HOLD_MS = Number(holdMsArg || 15000);
const out = { ranAt: new Date().toISOString(), wsUrl, hostOverride: hostOverride || null, events: [] };

const t0 = Date.now();
const tick = () => Date.now() - t0;
let finished = false;
let socket = null;

function done() {
  if (finished) return;
  finished = true;
  if (socket) { try { socket.destroy(); } catch (err) { } }
  out.totalMs = tick();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
}

/** 编码一个客户端 → 服务器的文本帧（客户端必须加掩码）。 */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x81; // FIN + text
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

/** 把累积缓冲里的完整帧切出来。 */
function drainFrames(buf, onFrame) {
  let offset = 0;
  for (;;) {
    if (offset + 2 > buf.length) break;
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p)); p += 8;
    }
    let maskKey = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4); p += 4;
    }
    if (p + len > buf.length) break;
    let payload = buf.subarray(p, p + len);
    if (maskKey) {
      const un = Buffer.alloc(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i % 4];
      payload = un;
    }
    onFrame(opcode, payload);
    offset = p + len;
  }
  return offset;
}

try {
  const u = new URL(wsUrl);
  const secure = u.protocol === 'wss:';
  const transport = secure ? https : http;

  const headers = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
    cookie
  };
  if (hostOverride) headers.host = hostOverride;

  const req = transport.request({
    host: u.hostname,
    port: u.port || (secure ? 443 : 80),
    path: u.pathname + u.search,
    method: 'GET',
    headers
  });

  req.on('upgrade', (res, s, head) => {
    socket = s;
    out.events.push({ t: tick(), event: 'upgraded', status: res.statusCode });

    let acc = Buffer.alloc(0);
    const feed = (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      const consumed = drainFrames(acc, (opcode, payload) => {
        const rec = {
          t: tick(),
          event: 'frame',
          opcode: '0x' + opcode.toString(16)
        };
        if (opcode === 0x1) {
          const text = payload.toString('utf8');
          rec.text = text.slice(0, 400);
          try {
            const parsed = JSON.parse(text);
            rec.parsedType = parsed.type;
            if (parsed.type === 'item') rec.itemValueType = parsed.value && parsed.value.type;
          } catch (err) { }
        } else {
          rec.bytes = payload.length;
          rec.hex = payload.subarray(0, 24).toString('hex');
        }
        out.events.push(rec);
      });
      acc = acc.subarray(consumed);
    };

    if (head && head.length) feed(head);

    // 关键一步：发开流消息，请求 $events
    const streamId = crypto.randomUUID();
    out.streamId = streamId;
    const openMsg = JSON.stringify({
      type: 'open',
      streamId,
      endpoint: '$events',
      payload: { args: {} }
    });
    s.write(encodeTextFrame(openMsg));
    out.events.push({ t: tick(), event: 'sentOpen', endpoint: '$events', len: openMsg.length });

    s.on('data', feed);
    s.on('close', () => { out.events.push({ t: tick(), event: 'closed' }); done(); });
    s.on('error', (e) => { out.events.push({ t: tick(), event: 'socketError', msg: e.message }); done(); });
  });

  req.on('response', (res) => {
    out.events.push({ t: tick(), event: 'rejected', status: res.statusCode });
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => { out.bodyPreview = body.slice(0, 300); done(); });
  });

  req.on('error', (e) => { out.events.push({ t: tick(), event: 'reqError', msg: e.message }); done(); });
  req.end();
} catch (err) {
  out.events.push({ event: 'exception', msg: err.message });
  done();
}

setTimeout(() => { out.events.push({ t: tick(), event: 'holdExpired' }); done(); }, HOLD_MS);
