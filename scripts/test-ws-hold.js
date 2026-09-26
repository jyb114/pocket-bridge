// DSH 移动端网关 — WebSocket 长连接诊断
//
// 上一个探测脚本握手成功就立刻销毁了 socket，所以看不出问题。
// 这个脚本会保持连接若干秒，记录收到的每一个数据帧和时间点，
// 从而区分两种情况：
//   - 收到 ready 帧后保持连接   → 正常
//   - 一直没收到 ready 帧 / 很快被断开 → 就是「界面打得开但没有数据」的原因
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [, , wsUrl, cookieFile, logFile, holdMsArg, hostOverride] = process.argv;
require('./probe-args.js').requireArgs(process.argv, ['wsUrl', 'cookieFile', 'logFile'],
  'node scripts/test-ws-hold.js <wsUrl> <cookieFile> <logFile> [holdMs] [host]');

let cookie = '';
try {
  cookie = fs.readFileSync(cookieFile, 'utf8').replace(/^\uFEFF/, '').trim();
} catch (err) {
  cookie = '';
}

const HOLD_MS = Number(holdMsArg || 12000);
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

try {
  const u = new URL(wsUrl);
  const secure = u.protocol === 'wss:';
  const transport = secure ? https : http;
  const key = crypto.randomBytes(16).toString('base64');

  const headers = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    cookie
  };
  // 直连 DSH 时，端口是它真实监听的端口，但 cookie 的 authority 绑的是
  // 中间层固定用的那个 Host，所以这里要能手动覆盖。
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
    out.events.push({ t: tick(), event: 'upgraded', status: res.statusCode, headBytes: head.length });
    if (head.length) {
      out.events.push({ t: tick(), event: 'head-frame', bytes: head.length, preview: head.subarray(0, 240).toString('utf8') });
    }
    s.on('data', (d) => {
      // 记十六进制：2 字节的帧看不到内容，但 opcode 能说明它是 ping 还是 close
      out.events.push({
        t: tick(),
        event: 'data',
        bytes: d.length,
        hex: d.subarray(0, 32).toString('hex'),
        opcode: d.length ? '0x' + d[0].toString(16) : null,
        preview: d.subarray(0, 240).toString('utf8')
      });
    });
    s.on('close', (hadErr) => {
      out.events.push({ t: tick(), event: 'closed', hadError: !!hadErr });
      done();
    });
    s.on('error', (e) => {
      out.events.push({ t: tick(), event: 'socketError', msg: e.message });
      done();
    });
  });

  req.on('response', (res) => {
    out.events.push({ t: tick(), event: 'rejected', status: res.statusCode });
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => { out.bodyPreview = body.slice(0, 300); done(); });
  });

  req.on('error', (e) => {
    out.events.push({ t: tick(), event: 'reqError', msg: e.message });
    done();
  });

  req.end();
} catch (err) {
  out.events.push({ event: 'exception', msg: err.message });
  done();
}

setTimeout(() => {
  out.events.push({ t: tick(), event: 'holdExpired' });
  done();
}, HOLD_MS);
