// 端到端加密 —— 电脑这一侧。
//
// 与之配对的是 pwa/e2ee.js（浏览器侧）。**两边的结果必须完全一致**，
// 所以两边都严格按 RFC 5869 (HKDF) 和 NIST SP 800-38D (GCM) 来，
// 不自己发明任何东西 —— 自定义的密码学是出事故最快的方式。
//
// 设计要点（详见 PLAN-E2EE.md）：
//   · 长期密钥放在网址的 # 后面，浏览器不会把它发给服务器，隧道看不到
//   · 真正的加密密钥每 30 分钟从长期密钥派生一次 —— 书签不用变
//   · 两个方向用不同的密钥（A: 手机→电脑，B: 电脑→手机）
'use strict';
const crypto = require('crypto');

/** 换密钥的周期：30 分钟 */
const SLOT_MS = 30 * 60 * 1000;

/** 当前时间段编号。两边各自按本地时间算，所以要容忍时钟偏差。 */
function slotAt(now = Date.now()) {
  return Math.floor(now / SLOT_MS);
}

/**
 * HKDF-SHA256（RFC 5869）。
 * @param {Buffer|string} ikm  长期密钥
 * @param {Buffer|string} salt
 * @param {string} info
 * @param {number} len  输出字节数
 */
function hkdf(ikm, salt, info, len = 32) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));
}

/**
 * 从长期密钥派生某个时间段的两把会话密钥。
 *
 * 两个方向分开派生：一把用来加密手机发来的，一把用来加密发给手机的。
 * 用同一把也能跑，但分开之后一边泄露不会连累另一边，而且实现上更清楚。
 *
 * @returns {{a: Buffer, b: Buffer}} a = 手机→电脑，b = 电脑→手机
 */
function deriveKeys(longTermSecret, slot) {
  const salt = Buffer.from(String(slot));
  return {
    a: hkdf(longTermSecret, salt, 'dsh-gw|phone->pc|v1', 32),
    b: hkdf(longTermSecret, salt, 'dsh-gw|pc->phone|v1', 32)
  };
}

/**
 * 解密时要试两个时间段。
 *
 * 两边的时钟不可能完全同步，而且正好跨过 30 分钟边界时必然一边用一个。
 * 所以解密方**同时接受当前和上一个**时间段的密钥。
 * （只影响解密尝试，不影响安全：多试一个 32 字节密钥等于没多。）
 */
function candidateKeys(longTermSecret, now = Date.now()) {
  const cur = slotAt(now);
  return [
    deriveKeys(longTermSecret, cur),
    deriveKeys(longTermSecret, cur - 1)
  ];
}

/** AES-256-GCM 加密。返回 iv(12) + tag(16) + 密文 */
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/**
 * AES-256-GCM 解密。失败返回 null（**不要抛异常**）。
 *
 * 为什么会失败：密钥不对（换了时间段）、数据被改过、或者这段本来就没加密。
 * 调用方需要能区分这几种情况，所以失败就安静地返回 null。
 */
function decrypt(key, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  } catch (err) {
    return null;
  }
}

/** 生成一把新的长期密钥（给「更换密钥」按钮用） */
function newLongTermSecret() {
  return crypto.randomBytes(24).toString('base64url');   // 192 位
}

module.exports = {
  SLOT_MS, slotAt, hkdf, deriveKeys, candidateKeys,
  encrypt, decrypt, newLongTermSecret
};
