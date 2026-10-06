// 把加密变换接进 WebSocket 转发。
//
// 这里只做一件事：给网关的两条 WS 转发路径套上「可选加密」。
//
// **必须是可以开关的** —— 手机书签里没有密钥的老用户，如果被强行加密，
// 表现就是「突然连不上了」，而且完全看不出原因。所以规则是：
//
//   1. 电脑上没生成长期密钥           → 一律不加密（跟以前完全一样）
//   2. 有密钥，但手机没说它支持加密   → 不加密（老书签照常能用）
//   3. 有密钥，手机也说了 e2ee=1      → 加密
//
// 手机"说"的方式是 WS 地址上带 `e2ee=1`。浏览器原生的 WebSocket 不能加
// 自定义头，所以只能走查询参数。
'use strict';
const fs = require('fs');
const path = require('path');
const { WsCrypto } = require('./ws-crypt.js');

const SECRET_FILE = path.join(__dirname, '..', 'logs', 'e2ee-secret.txt');

/** 读长期密钥。没有就返回 null（= 不加密）。 */
function readSecret() {
  // 让使用者能临时关掉：设了环境变量就当作没有密钥
  if (process.env.DSH_GW_NO_E2EE === '1') return null;
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    return s.length >= 16 ? s : null;
  } catch (err) {
    return null;
  }
}

/** 生成一把新的长期密钥（「更换密钥」按钮用） */
function writeSecret(secret) {
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, secret, 'utf8');
  return secret;
}

/**
 * 这次 WS 连接要不要加密？
 * 两边条件都得满足：电脑有密钥 + 手机明确表示支持。
 */
function wanted(reqUrl, secret) {
  if (!secret) return false;
  try {
    const u = new URL(reqUrl, 'http://x');
    return u.searchParams.get('e2ee') === '1';
  } catch (err) {
    return false;
  }
}

/**
 * 给一条已建立的 WS 连接装上加解密。
 *
 * 用法：拿到 upstream / socket 之后调用，返回一个 `pump(chunk, dir)`：
 *   dir = 'up'   手机 → 电脑（解开密文）
 *   dir = 'down' 电脑 → 手机（加密明文）
 *
 * 内部处理了一件容易漏的事：**握手响应不是帧**。
 * upstream 回来的第一段是 `HTTP/1.1 101 ...\r\n\r\n`，
 * 那一段必须原样发给手机，从它之后才是 WebSocket 帧。
 * 不区分的话，解析器会拿 HTTP 头去当帧解析，整个连接当场乱掉。
 */
function attach(secret) {
  const up = new WsCrypto(secret, 'decrypt');     // 手机发来的：解
  const down = new WsCrypto(secret, 'encrypt');   // 发给手机的：加
  let downHandshakeDone = false;
  let pendingDown = Buffer.alloc(0);
  let closed = false;
  let failureCode = null;
  const MAX_HANDSHAKE_BYTES = 8192;

  function close() {
    closed = true;
    pendingDown = Buffer.alloc(0);
    for (const transform of [up, down]) {
      transform.buf = Buffer.alloc(0);
      transform.keyCache = null;
      transform.secret = null;
      transform.invalidStream = true;
    }
  }
  function failure(code) {
    failureCode = code;
    close();
    throw Object.assign(new Error('Encrypted WebSocket upgrade refused.'), { code });
  }
  function checkOpen() {
    if (closed) throw Object.assign(new Error('Encrypted WebSocket bridge is closed.'),
      { code: failureCode || 'ws-bridge-closed' });
  }
  function validHandshake(head) {
    const lines = head.toString('latin1').slice(0, -4).split('\r\n');
    if (!/^HTTP\/1\.1 101(?: [\x20-\x7e]*)?$/.test(lines.shift() || '')) return false;
    const headers = new Map();
    for (const line of lines) {
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\x20-\x7e\t]*)$/.exec(line);
      if (!match) return false;
      const name = match[1].toLowerCase();
      const values = headers.get(name) || [];
      values.push(match[2].trim()); headers.set(name, values);
    }
    const upgrade = headers.get('upgrade'), accept = headers.get('sec-websocket-accept');
    const connection = (headers.get('connection') || []).join(',').split(',').map(v => v.trim().toLowerCase());
    return upgrade && upgrade.length === 1 && upgrade[0].toLowerCase() === 'websocket' &&
      connection.includes('upgrade') && accept && accept.length === 1 &&
      /^[A-Za-z0-9+/]{27}=$/.test(accept[0]) && !headers.has('transfer-encoding') &&
      !headers.has('content-length');
  }

  return {
    /** 处理手机发来的字节（已经跳过了 HTTP 请求头，全是帧） */
    fromClient(chunk) {
      checkOpen();
      return up.push(chunk);
    },

    /**
     * 处理电脑发来的字节。
     * 会自动把前面的 HTTP 握手响应原样摘出来 —— 那部分不是帧。
     * @returns {Buffer} 该发给手机的全部字节
     */
    fromUpstream(chunk) {
      checkOpen();
      if (downHandshakeDone) return down.push(chunk);

      pendingDown = Buffer.concat([pendingDown, chunk]);
      const idx = pendingDown.indexOf('\r\n\r\n');

      if (idx < 0) {
        // An invalid upstream response must never turn a mandatory encrypted
        // channel into a raw-byte fallback. The caller closes its owned pair.
        if (pendingDown.length > MAX_HANDSHAKE_BYTES) failure('ws-upgrade-too-large');
        return Buffer.alloc(0);      // 握手响应还没收全
      }

      if (idx + 4 > MAX_HANDSHAKE_BYTES) failure('ws-upgrade-too-large');

      const head = pendingDown.subarray(0, idx + 4);
      const body = pendingDown.subarray(idx + 4);
      if (!validHandshake(head)) failure('ws-upgrade-invalid');
      downHandshakeDone = true;
      pendingDown = Buffer.alloc(0);

      if (!body.length) return head;
      return Buffer.concat([head, down.push(body)]);
    },

    /** 握手响应收全了吗（用来决定日志怎么写） */
    isReady() { return downHandshakeDone && !closed; },
    close,

    /**
     * 体检数据：上行方向拦下了多少重放、拒收了多少解不开的文本帧。
     *
     * 这两个数必须能被看到 —— 这一层最危险的失败方式是**静默丢帧**：
     * 表现是「连上了但没反应」，而日志里什么都没有，完全查不出原因。
     */
    stats() {
      return { replayed: up.replayed, rejected: up.rejected, undecryptable: up.undecryptable,
        handshakeRejected: failureCode ? 1 : 0, closed };
    }
  };
}

module.exports = { readSecret, writeSecret, wanted, attach, SECRET_FILE };
