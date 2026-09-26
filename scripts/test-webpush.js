// DSH 移动端网关 — Web Push 实现自测
//
// 为什么必须测：aes128gcm 加密或 VAPID 签名写错了，推送不会报错，
// 只会静默地送不到手机。这里做两件事：
//   1. 模拟一个浏览器订阅，加密后用浏览器侧的算法解回来，比对明文
//   2. 生成 VAPID 头并验证 JWT 结构、aud、以及签名是否真的验得过
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { encryptPayload, vapidHeaders } = require('./webpush.js');

const BASE = path.resolve(__dirname, '..');
const OUT = path.join(BASE, 'logs', 'test-webpush.json');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) =>
  Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hkdf = (salt, ikm, info, len) =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

const out = { ranAt: new Date().toISOString() };

try {
  // ── 1. 加密 / 解密往返 ──────────────────────────────────────────────────────
  // 扮演浏览器：生成订阅用的密钥
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const uaPublic = ua.getPublicKey();          // p256dh
  const authSecret = crypto.randomBytes(16);   // auth

  const plaintext = JSON.stringify({ title: '测试标题', body: '任务完成，回来看看' });
  const body = encryptPayload(Buffer.from(plaintext, 'utf8'), uaPublic, authSecret);

  // 按浏览器侧的方式解回来
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen, body.length - 16);
  const tag = body.subarray(body.length - 16);

  const shared = ua.computeSecret(asPublic);
  const ikm = hkdf(
    authSecret, shared,
    Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]), 32
  );
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const separator = decrypted[decrypted.length - 1];
  const recovered = decrypted.subarray(0, decrypted.length - 1).toString('utf8');

  out.encryption = {
    bodyBytes: body.length,
    recordSize: rs,
    keyIdLength: idlen,
    separatorByte: separator,
    matchesPlaintext: recovered === plaintext,
    recoveredPreview: recovered.slice(0, 80)
  };

  // ── 2. VAPID ────────────────────────────────────────────────────────────────
  const vapid = JSON.parse(fs.readFileSync(path.join(BASE, 'logs', 'vapid.json'), 'utf8'));
  const endpoint = 'https://fcm.googleapis.com/fcm/send/dummy-endpoint-id';
  const headers = vapidHeaders(endpoint, vapid.publicKey, vapid.privateKey, 'mailto:test@localhost');

  const m = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization || '');
  if (!m) throw new Error('Authorization 头格式不对: ' + headers.Authorization);

  const [h, p, s] = m[1].split('.');
  const jwtHeader = JSON.parse(unb64url(h).toString('utf8'));
  const jwtPayload = JSON.parse(unb64url(p).toString('utf8'));
  const rawPublic = unb64url(vapid.publicKey);

  const verifyKey = crypto.createPublicKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64url(rawPublic.subarray(1, 33)),
      y: b64url(rawPublic.subarray(33, 65))
    },
    format: 'jwk'
  });

  const signatureValid = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`, 'utf8'),
    { key: verifyKey, dsaEncoding: 'ieee-p1363' },
    unb64url(s)
  );

  out.vapid = {
    headerAlg: jwtHeader.alg,
    headerTyp: jwtHeader.typ,
    audience: jwtPayload.aud,
    audienceMatchesEndpoint: jwtPayload.aud === new URL(endpoint).origin,
    subject: jwtPayload.sub,
    expiresInHours: Math.round((jwtPayload.exp * 1000 - Date.now()) / 3600000),
    signatureBytes: unb64url(s).length,
    signatureValid,
    contentEncoding: headers['Content-Encoding'],
    keyHeaderMatches: m[2] === vapid.publicKey
  };

  out.pass =
    out.encryption.matchesPlaintext &&
    out.encryption.separatorByte === 2 &&
    out.encryption.recordSize === 4096 &&
    out.vapid.signatureValid &&
    out.vapid.audienceMatchesEndpoint &&
    out.vapid.headerAlg === 'ES256';

  out.status = 'ok';
} catch (err) {
  out.status = 'error';
  out.error = err.message;
  out.stack = String(err.stack).slice(0, 500);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
