// 重放防护的**真·端到端**验证：对着跑着的网关打一条重放，看它到底拦不拦。
//
// 为什么不能只靠单元测试：test-replay.js 验的是 WsCrypto 这一层的判断逻辑，
// 而「网关有没有真的把这一层接上去、拦下之后有没有记账」是另一回事 ——
// 恰恰是这种「逻辑对但没接线」的缺口最容易被单元测试放过。
//
// 做法：照客户端的规矩开一条加密 WS（带会话 cookie + e2ee=1），
// 把**同一个加密帧发两次**，然后去 proxy.log 里找那行体检日志。
//
// 注意：发的是无意义的 JSON，DSH 那边顶多回一个解析错误，不会启动任何任务。
// 目标用 /codex/ws 而不是 DSH 那条 `/`：
// DSH 的 WS 端点不接受这种裸请求（网关会装上加密、把请求转给上游，
// 然后上游直接关连接，客户端什么都收不到 —— 实测过）。
// Codex 这条同样承载内容（审批就走它），而且接受裸升级，适合做探针。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const PORT = Number(process.env.DSH_GW_PORT || 8080);
const LOG = path.join(BASE, 'logs', 'proxy.log');
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const SECRET = fs.readFileSync(path.join(BASE, 'logs', 'e2ee-secret.txt'), 'utf8').trim();

const e2ee = require('./e2ee.js');
const wsf = require('./ws-frame.js');

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`);
  if (!cond) failed++;
};

/** 取一个会话（顺带拿到设备令牌 cookie） */
function getSession() {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port: PORT, path: `/k/${KEY}`,
      headers: { host: `127.0.0.1:${PORT}` }
    }, (res) => {
      const raw = res.headers['set-cookie'] || [];
      res.resume();
      resolve(raw.map((c) => String(c).split(';')[0]).join('; '));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('取会话超时')));
  });
}

/** 开一条加密 WS，返回 socket 和「握手是否成功」 */
function openEncryptedWs(cookie) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      const head =
        `GET /codex/ws?e2ee=1 HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${PORT}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Cookie: ${cookie}\r\n\r\n`;
      sock.write(head);
    });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (okHandshake) => { if (!done) { done = true; resolve({ sock, okHandshake }); } };
    sock.on('data', (c) => {
      if (done) return;                    // 后续数据还会带着同一段响应头，别重复报
      buf = Buffer.concat([buf, c]);
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) {
        const statusLine = buf.subarray(0, i).toString('utf8').split('\r\n')[0];
        console.log(`  [诊断] 服务端响应: ${statusLine}`);
        finish(/^HTTP\/1\.1 101/.test(buf.subarray(0, i).toString('utf8')));
      }
    });
    sock.on('error', (e) => { console.log(`  [诊断] socket 错误: ${e.message}`); finish(false); });
    sock.on('close', () => { console.log('  [诊断] socket 被关闭'); finish(false); });
    sock.setTimeout(12000, () => finish(false));
  });
}

/** 造一个手机样式（二进制帧）的加密帧 */
function encryptedFrame(plaintext) {
  const keys = e2ee.deriveKeys(SECRET, e2ee.slotAt());
  const ct = e2ee.encrypt(keys.a, Buffer.from(plaintext, 'utf8'));
  return wsf.buildFrame(wsf.OP_BIN, ct, true);      // 客户端发出的帧是带掩码的
}

(async () => {
  console.log('\n=== 重放防护 · 对着真网关 ===\n');

  const before = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').length : 0;
  const cookie = await getSession();
  if (!cookie) { console.log('  拿不到会话 cookie，中止\n'); process.exitCode = 1; return; }
  console.log(`  网关 127.0.0.1:${PORT}，会话已建立`);

  const { sock, okHandshake } = await openEncryptedWs(cookie);
  console.log(`  [诊断] 握手结果 = ${okHandshake}`);
  ok('加密 WS 握手成功（101）', okHandshake === true);
  if (!okHandshake) { try { sock.destroy(); } catch (e) { } process.exitCode = 1; return; }
  console.log('  WS 已升级，准备发同一个帧两次…');

  const frame = encryptedFrame('{"jsonrpc":"2.0","id":999001,"method":"__e2ee_replay_probe","params":{}}');
  sock.write(frame);                       // 第一次：正常
  await new Promise((r) => setTimeout(r, 700));
  sock.write(frame);                       // 第二次：原样重放
  await new Promise((r) => setTimeout(r, 900));

  try { sock.destroy(); } catch (e) { }
  // 等网关把体检日志写出来（连接关闭时才打）
  await new Promise((r) => setTimeout(r, 1500));

  const tail = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').slice(before) : '';
  const statsLine = (tail.split('\n').find((l) => /加密通道体检/.test(l)) || '').trim();

  ok('网关记下了这次重放（体检日志出现）', /拦下重放 [1-9]/.test(statsLine), statsLine || '(没有体检日志)');
  ok('日志里说明了拦下多少帧', /拦下重放 \d+ 帧/.test(statsLine));

  console.log(`\n${failed ? failed + ' 项失败' : '全部通过'}\n`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
