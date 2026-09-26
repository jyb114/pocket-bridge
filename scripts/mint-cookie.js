// DSH 移动端网关 — 签发浏览器会话 cookie
//
// 背景：手机要访问 DSH，必须带上 DSH 签发的会话 cookie。正常流程是打开
// `dsh web` 打印的带 ?token= 的 URL，由 DSH 自己把 cookie 写进浏览器。
// 但那个 token 只存在于 DSH 进程内存里（模块级 WeakMap，按 root context 存），
// 外部拿不到。
//
// 替代办法：cookie 的签名密钥是持久化在 $DSH_HOME/.credentials.yaml 里的
// `client-connection/browser-session` grant 记录，算法也完全确定：
//
//   cookieName  = "dsh-auth-" + base64url(sha256(authority))
//   payload     = { version:1, authority, issuedAt, expiresAt }
//   cookieValue = "v1." + base64url(JSON.stringify(payload))
//                        + "." + base64url(HMAC-SHA256(secret, body))
//
// 照着这个格式自己签一个，DSH 的 isAuthenticated() 会认。
//
// 用法：
//   <Electron> mint-cookie.js <credentials.yaml> <authority> <日志路径> [自测URL]
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const SECRET_BYTES = 32;
const DAY_MS = 1440 * 60 * 1000;

const b64url = (b) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** 从 credentials.yaml 里取出 browser-session 的 32 字节签名密钥。 */
function readSecret(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(
    /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/
  );
  if (!m) throw new Error('credentials 里找不到 client-connection/browser-session 的 secret');
  const raw = unb64url(m[1]);
  if (raw.length !== SECRET_BYTES) {
    throw new Error(`secret 不是 ${SECRET_BYTES} 字节，实际 ${raw.length}`);
  }
  return raw;
}

/**
 * 按 DSH 的格式签一个 cookie。
 * @param authority - DSH 实际收到的 Host 头（含端口），例如 "127.0.0.1:58347"
 */
function mintCookie(authority, secret, maxAgeDays) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeDays * DAY_MS;
  const payload = { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const name =
    COOKIE_PREFIX + b64url(crypto.createHash('sha256').update(authority).digest());
  const value = `v1.${body}.${sig}`;
  return { name, value, cookieHeader: `${name}=${value}`, payload };
}

(async () => {
  const [, , credFile, authority, logFile, testUrl] = process.argv;
  const out = { ranAt: new Date().toISOString(), authority, maxAgeDays: 30 };

  try {
    if (!credFile || !authority || !logFile) {
      throw new Error('usage: mint-cookie.js <credentials.yaml> <authority> <logPath> [testUrl]');
    }

    const secret = readSecret(credFile);
    out.secretBytes = secret.length;

    const c = mintCookie(authority, secret, out.maxAgeDays);
    out.cookieName = c.name;
    out.cookieValue = c.value;
    out.expiresAt = new Date(c.payload.expiresAt).toISOString();

    // 自测：拿这个 cookie 直接请求 DSH，200 说明签名和格式都对
    if (testUrl) {
      const res = await fetch(testUrl, {
        headers: { cookie: c.cookieHeader },
        redirect: 'manual'
      });
      const text = await res.text();
      out.test = {
        url: testUrl,
        status: res.status,
        location: res.headers.get('location'),
        contentType: res.headers.get('content-type'),
        bodyPreview: text.slice(0, 300)
      };
    }

    out.status = 'ok';
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
