// 让测试里的「假设备」也能过第三道门（挑战应答）。
//
// 2026-09-27 起网关把挑战应答开成**真拦**：没证明过的设备只拿得到页面/脚本，
// 内容（/api、/codex、票据、文件…）一律 403。真手机是自己在浏览器里算的
// （pwa/e2ee.js 的 prove()，被拦了还会自动重试），测试里的假设备得补上同一步，
// 否则一堆测试会红在「403 need-proof」上 —— 那不是功能坏了，是假设备没证明。
//
// 用法（每个测试都有自己的 request 助手，形状不一，所以这里只提供算法）：
//
//   const { proveWith } = require('./proof-helper.js');
//   const v = await proveWith(async (o) => {
//     const r = await myRequest(o.path, { method: o.method, headers: o.headers, body: o.body });
//     return { status: r.status, body: r.body };
//   }, { headers: { cookie } });
//
// 说明：这里**故意**只做「真手机做的那件事」，不碰任何内部状态 ——
// 谁要是把网关那边的判定改了，这些测试会跟着红，而不是悄悄放行。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FILE = path.join(__dirname, '..', 'logs', 'e2ee-secret.txt');

/** 网关那边读的就是这个文件（ws-e2ee-bridge.js 的 SECRET_FILE） */
function secretFromDisk() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    return s.length >= 16 ? s : null;
  } catch (err) { return null; }
}

/** 和网关 authKeyOf 一个字都不差：HKDF(salt='dsh-gw-auth', info='dsh-gw|auth|v1') */
function authKeyOf(longTermSecret) {
  return require('./e2ee.js').hkdf(
    Buffer.from(String(longTermSecret), 'utf8'),
    Buffer.from('dsh-gw-auth'), 'dsh-gw|auth|v1', 32);
}

function respond(nonce, longTermSecret) {
  return crypto.createHmac('sha256', authKeyOf(longTermSecret))
    .update(String(nonce)).digest('base64url');
}

/**
 * 走一遍挑战应答。
 * @param {(opts:{path:string,method?:string,headers?:object,body?:string}) => Promise<{status:number,body:string}>} request
 * @param {{headers?:object, secret?:string}} [opts] headers 里通常要带设备 cookie
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function proveWith(request, opts = {}) {
  const secret = opts.secret || secretFromDisk();
  if (!secret) return { ok: false, reason: '这台电脑上没有 logs/e2ee-secret.txt（没配加密密钥）' };

  const ch = await request({ path: '/__auth/challenge', headers: opts.headers || {} });
  let nonce = null;
  try { nonce = JSON.parse(ch.body).nonce; } catch (err) { }
  if (!nonce) return { ok: false, reason: `拿不到挑战（HTTP ${ch.status}）` };

  const v = await request({
    method: 'POST', path: '/__auth/verify',
    headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}),
    body: JSON.stringify({ nonce, response: respond(nonce, secret) })
  });
  let verdict = {};
  try { verdict = JSON.parse(v.body); } catch (err) { }
  return { ok: !!verdict.ok, reason: verdict.reason || null };
}

module.exports = { proveWith, respond, authKeyOf, secretFromDisk, SECRET_FILE };
