// DSH 移动端网关 — WebSocket 实时通道探测
//
// 为什么单独测这个：DSH 的界面能加载（HTTP 200）不代表能用 —— 它的实时通信
// 全走 /api/remote.mux 这条 WebSocket。如果这条通道被中间层或隧道掐断，
// 手机上会表现为「页面打开了，但一直不刷新」。
//
// 浏览器发 WebSocket 时会自动带上同源 cookie，所以只要 cookie 有效就能认证。
// 这里用原始 HTTP 握手模拟同样的请求。
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [, , wsUrl, rawCookieArg, logFile] = process.argv;
require('./probe-args.js').requireArgs(process.argv, ['wsUrl', 'logFile'],
  'node scripts/test-ws.js <wsUrl> <rawCookie> <logFile>');

// 第二个参数既可以直接是 cookie 字符串，也可以是存放 cookie 的文件路径。
// 走文件更稳：cookie 值长度可观，且能避开命令行的字符转义问题。
let cookieHeader = rawCookieArg;
if (rawCookieArg && fs.existsSync(rawCookieArg)) {
  cookieHeader = fs.readFileSync(rawCookieArg, 'utf8').replace(/^\uFEFF/, '').trim();
}

const out = { ranAt: new Date().toISOString(), wsUrl };
let settled = false;

function finish() {
  if (settled) return;
  settled = true;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
}

try {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');

  // 内网走明文 ws://，隧道走加密 wss:// —— 两种都要能测
  const secure = u.protocol === 'wss:';
  const transport = secure ? https : http;

  const req = transport.request({
    host: u.hostname,
    port: u.port || (secure ? 443 : 80),
    path: u.pathname + u.search,
    method: 'GET',
    timeout: 25000,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      cookie: cookieHeader
    }
  });

  req.on('upgrade', (res, socket, head) => {
    out.status = 'upgraded';
    out.handshake = {
      statusCode: res.statusCode,
      upgrade: res.headers.upgrade,
      connection: res.headers.connection,
      protocol: res.headers['sec-websocket-protocol'] || null
    };
    // head 是握手后立刻到达的帧。DSH 的 $events 流第一项应是 {"type":"ready",...}
    out.firstFrame = {
      bytes: head.length,
      preview: head.subarray(0, 300).toString('utf8')
    };
    socket.destroy();
    finish();
  });

  req.on('response', (res) => {
    out.status = 'rejected';
    out.responseStatus = res.statusCode;
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      out.bodyPreview = body.slice(0, 300);
      finish();
    });
  });

  req.on('timeout', () => { out.status = 'timeout'; req.destroy(); finish(); });
  req.on('error', (e) => { out.status = 'error'; out.error = e.message; finish(); });
  req.end();
} catch (err) {
  out.status = 'error';
  out.error = err.message;
  finish();
}

// 兜底，避免脚本挂死
setTimeout(() => { finish(); }, 30000);
