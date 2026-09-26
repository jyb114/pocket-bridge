// DSH 移动端网关 — Web Push 发送实现
//
// 只用 Node 内置 crypto，不依赖 web-push 之类的第三方包。
// 涉及两个规范：
//   RFC 8291  消息加密（aes128gcm）—— 载荷只有目标浏览器能解开
//   RFC 8292  VAPID（发送方身份）—— 让推送服务确认是我们发的
//
// 这两个东西实现错了通常不会报错，只会静默地推不出去，所以每一步都按规范写。
'use strict';

const crypto = require('crypto');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (s) =>
  Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** HKDF-SHA256，包一层只是为了读起来清楚。 */
function hkdf(salt, ikm, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * 按 RFC 8291 加密推送载荷。
 *
 * @param {Buffer} plaintext   要发送的 JSON 字节
 * @param {Buffer} uaPublic    订阅方的 p256dh（65 字节未压缩点）
 * @param {Buffer} authSecret  订阅方的 auth（16 字节）
 * @returns {Buffer} 完整的 aes128gcm 请求体
 */
function encryptPayload(plaintext, uaPublic, authSecret) {
  // 每次推送都用一个新的临时密钥对
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();          // 65 字节
  const shared = ecdh.computeSecret(uaPublic);   // 32 字节

  const salt = crypto.randomBytes(16);

  // IKM = HKDF(auth_secret, shared, "WebPush: info\0" || ua_public || as_public, 32)
  const ikm = hkdf(
    authSecret,
    shared,
    Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]),
    32
  );

  // CEK = HKDF(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);

  // NONCE = HKDF(salt, ikm, "Content-Encoding: nonce\0", 12)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // aes128gcm 的记录末尾必须有 0x02 作为分隔标记，少了浏览器会解密失败
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 头部：salt(16) | rs(4) | idlen(1) | keyid(65)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);

  return Buffer.concat([
    salt,
    rs,
    Buffer.from([asPublic.length]),
    asPublic,
    ciphertext,
    tag
  ]);
}

/**
 * 按 RFC 8292 生成 VAPID 授权头。
 *
 * @param {string} endpoint        订阅端点，用它推导 aud
 * @param {string} publicKeyB64    VAPID 公钥（base64url，65 字节未压缩点）
 * @param {string} privateKeyB64   VAPID 私钥（base64url，32 字节）
 * @param {string} subject         联系方式，规范要求非空
 */
function vapidHeaders(endpoint, publicKeyB64, privateKeyB64, subject) {
  const audience = new URL(endpoint).origin;

  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject || 'mailto:dsh-gateway@localhost'
  }), 'utf8'));

  const signingInput = `${header}.${payload}`;
  const rawPublic = unb64url(publicKeyB64);

  // Node 的 ECDSA 输出是 DER；JWT 要求定长 raw (r||s)，靠 dsaEncoding 切换
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: crypto.createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: privateKeyB64,
        x: b64url(rawPublic.subarray(1, 33)),
        y: b64url(rawPublic.subarray(33, 65))
      },
      format: 'jwk'
    }),
    dsaEncoding: 'ieee-p1363'
  });

  return {
    Authorization: `vapid t=${signingInput}.${b64url(signature)}, k=${publicKeyB64}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: '86400'
  };
}

/**
 * 向一个订阅推送一条消息。
 * @returns {Promise<{status:number, ok:boolean, gone:boolean, detail:string}>}
 */
async function sendWebPush(subscription, payload, vapid) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return { status: 0, ok: false, gone: false, detail: '订阅记录不完整' };
  }

  const body = encryptPayload(
    Buffer.from(JSON.stringify(payload), 'utf8'),
    unb64url(subscription.keys.p256dh),
    unb64url(subscription.keys.auth)
  );

  const headers = vapidHeaders(
    subscription.endpoint,
    vapid.publicKey,
    vapid.privateKey,
    vapid.subject
  );

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000)
  });

  // 404 / 410 表示订阅已经作废，应当从列表里清掉
  const gone = res.status === 404 || res.status === 410;
  let detail = '';
  if (!res.ok) {
    try { detail = (await res.text()).slice(0, 200); } catch (err) { detail = ''; }
  }

  return { status: res.status, ok: res.ok, gone, detail };
}

module.exports = { encryptPayload, vapidHeaders, sendWebPush };
