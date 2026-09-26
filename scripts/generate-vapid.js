// DSH 移动端网关 — 生成 Web Push 用的 VAPID 密钥对
//
// VAPID 是 Web Push 的发送方身份：手机订阅时带上公钥，中间层发送时用私钥签名。
// 一对密钥长期有效，订阅和它绑定，所以不要随意重新生成 —— 换了密钥，
// 已经订阅过的设备会全部失效，需要重新订阅。
//
// 输出：logs\vapid.json
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const OUT = path.join(BASE, 'logs', 'vapid.json');

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let existing = null;
try {
  existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
} catch (err) {
  existing = null;
}

if (existing && existing.publicKey && existing.privateKey) {
  console.log('已存在 VAPID 密钥，保持不变（换了会让所有已订阅设备失效）');
  console.log('公钥: ' + existing.publicKey);
} else {
  // prime256v1 (P-256) 是 Web Push 规定的曲线
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();

  const record = {
    createdAt: new Date().toISOString(),
    // 公钥必须是 65 字节未压缩格式，浏览器才认
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
    curve: 'prime256v1'
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2), 'utf8');

  console.log('已生成新的 VAPID 密钥对');
  console.log('公钥长度: ' + record.publicKey.length + ' 字符');
  console.log('公钥: ' + record.publicKey);
}
