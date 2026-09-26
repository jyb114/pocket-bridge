// 预热 Codex 的会话列表。
//
// 为什么要这个：手机上打开 Codex 界面，第一屏要等 **10 秒**。
// 量下来不是渲染的问题（DOM 才 142 个节点、滚动 0ms）—— 是
// **app-server 列会话本身就要 8~10 秒**：它得读每条会话的元数据，
// 而这台机器上有好几条 GB 级的会话。
//
// 手机上的 localStorage 缓存只在第二次访问才管用，冷启动照样等满 10 秒。
// 所以把这件事挪到电脑上：网关每隔一会儿自己去问一次，把结果存住。
// 手机直接拿缓存 —— 毫秒级。
//
// 这里用的是自己写的 WebSocket 帧编解码（ws-frame.js），不引任何依赖。
'use strict';
const net = require('net');
const crypto = require('crypto');
const wsf = require('./ws-frame.js');

const REFRESH_MS = 60 * 1000;
const TIMEOUT_MS = 25 * 1000;

let cache = { at: 0, list: null, error: null, warming: false };

/** 极简 WebSocket 客户端 —— 只够发 JSON-RPC、收 JSON-RPC 用 */
function connect(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, host, () => {
      sock.write(
        `GET / HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    const handlers = { message: null, close: null };
    let client = null;

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString('utf8');
        if (!/101/.test(head)) {
          reject(new Error('握手失败: ' + head.split('\r\n')[0]));
          sock.destroy();
          return;
        }
        handshakeDone = true;
        buf = buf.subarray(i + 4);

        // **握手完成之后才把 client 交出去。**
        // 之前是 net.connect 的回调里就 resolve 了 —— 那时候握手响应还没回来，
        // 立刻发出去的帧会被服务端直接丢掉，表现就是 initialize 永远超时。
        // 这是个很隐蔽的错：代码看起来完全正常，只是"对方不理我"。
        client = {
          sock,
          onMessage: (fn) => { handlers.message = fn; },
          onClose: (fn) => { handlers.close = fn; },
          send: (text) => sock.write(wsf.buildFrame(wsf.OP_TEXT, Buffer.from(text), true)),
          close: () => { try { sock.destroy(); } catch (e) { } }
        };
        resolve(client);
      }

      let parsed;
      try { parsed = wsf.parseFrames(buf); } catch (e) { return; }
      buf = parsed.rest;
      for (const f of parsed.frames) {
        if (f.opcode === wsf.OP_CLOSE) { if (handlers.close) handlers.close(); sock.destroy(); continue; }
        if (f.opcode === wsf.OP_PING) { sock.write(wsf.buildFrame(wsf.OP_PONG, f.payload, true)); continue; }
        if (f.opcode === wsf.OP_TEXT || f.opcode === wsf.OP_BIN) {
          if (handlers.message) handlers.message(f.payload.toString('utf8'));
        }
      }
    });

    sock.on('error', (e) => { if (!handshakeDone) reject(e); });
    sock.setTimeout(TIMEOUT_MS, () => { sock.destroy(); });
  });
}

/**
 * 去问一次会话列表。成功就更新缓存。
 * 失败不清空旧缓存 —— 旧的也比没有强。
 */
async function warm(port) {
  if (cache.warming) return cache;
  cache.warming = true;

  let ws = null;
  try {
    ws = await connect(port);
    const pending = new Map();
    let nextId = 1;

    const call = (method, params, ms) => new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(method + ' 超时')); }, ms || 20000);
      pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    });

    ws.onMessage((text) => {
      let m; try { m = JSON.parse(text); } catch (e) { return; }
      if (m.method) return;                    // 通知，不关心
      const h = pending.get(m.id);
      if (h) { pending.delete(m.id); h(m); }
    });

    await call('initialize', { clientInfo: { name: 'pocket-bridge-gw-warmer', version: '1.0.0' } }, 15000);
    const r = await call('thread/list', { limit: 60 }, 20000);

    if (r && r.result && Array.isArray(r.result.data)) {
      cache = { at: Date.now(), list: r.result.data, error: null, warming: false };
    } else {
      cache = Object.assign({}, cache, { error: '列表返回格式不对', warming: false });
    }
  } catch (err) {
    cache = Object.assign({}, cache, { error: err.message, warming: false });
  } finally {
    if (ws) ws.close();
  }
  return cache;
}

/** 拿缓存。没有就走一次（调用方自己决定等不等） */
function get() {
  return cache;
}

/** 启动后台预热：立刻来一次，之后每隔一分钟一次 */
function start(port, log) {
  const tick = async () => {
    const b = await warm(port);
    if (log) {
      if (b.list) log(`预热会话列表: ${b.list.length} 条（${Date.now() - b.at} ms 前）`);
      else if (b.error) log(`预热会话列表失败: ${b.error}`);
    }
  };
  tick();
  const t = setInterval(tick, REFRESH_MS);
  if (t.unref) t.unref();
  return t;
}

// 这个 connect 也导出给 codex-usage.js 用。
// 那边的额度查询要发别的 JSON-RPC 方法，但「怎么连上 app-server」这件事
// 只该有一份实现 —— 上面那条「握手完成之后才 resolve」的坑，
// 重写一遍就会再踩一遍。
module.exports = { warm, get, start, connect, REFRESH_MS };
