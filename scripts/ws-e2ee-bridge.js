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

  return {
    /** 处理手机发来的字节（已经跳过了 HTTP 请求头，全是帧） */
    fromClient(chunk) {
      return up.push(chunk);
    },

    /**
     * 处理电脑发来的字节。
     * 会自动把前面的 HTTP 握手响应原样摘出来 —— 那部分不是帧。
     * @returns {Buffer} 该发给手机的全部字节
     */
    fromUpstream(chunk) {
      if (downHandshakeDone) return down.push(chunk);

      pendingDown = Buffer.concat([pendingDown, chunk]);
      const idx = pendingDown.indexOf('\r\n\r\n');

      if (idx < 0) {
        // 保险阀：握手响应不可能这么长。
        // 如果攒了这么多还没找到分隔符，说明对面回的根本不是 HTTP 响应
        // （或者格式异常）——这时候必须放行，不能一直吞着。
        // 否则表现是「连上了但一个字节都不来」，最难查的那种。
        if (pendingDown.length > 8192) {
          const raw = pendingDown;
          pendingDown = Buffer.alloc(0);
          downHandshakeDone = true;
          return raw;
        }
        return Buffer.alloc(0);      // 握手响应还没收全
      }

      const head = pendingDown.subarray(0, idx + 4);
      const body = pendingDown.subarray(idx + 4);
      downHandshakeDone = true;
      pendingDown = Buffer.alloc(0);

      if (!body.length) return head;
      return Buffer.concat([head, down.push(body)]);
    },

    /** 握手响应收全了吗（用来决定日志怎么写） */
    isReady() { return downHandshakeDone; },

    /**
     * 体检数据：上行方向拦下了多少重放、拒收了多少解不开的文本帧。
     *
     * 这两个数必须能被看到 —— 这一层最危险的失败方式是**静默丢帧**：
     * 表现是「连上了但没反应」，而日志里什么都没有，完全查不出原因。
     */
    stats() {
      return { replayed: up.replayed, rejected: up.rejected, undecryptable: up.undecryptable };
    }
  };
}

module.exports = { readSecret, writeSecret, wanted, attach, SECRET_FILE };
