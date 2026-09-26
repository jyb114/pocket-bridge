// DSH 移动端网关 — 外网路径探测
//
// 经 Cloudflare 隧道的那一段是全新的链路，不能假设和内网一样。
// 这里验证：首页能否取到、注入是否生效、/api 是否放行。
'use strict';

const fs = require('fs');

const [, , baseUrl, cookieFile, logFile] = process.argv;

const out = { ranAt: new Date().toISOString(), baseUrl };

(async () => {
  let cookie = '';
  try {
    cookie = fs.readFileSync(cookieFile, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch (err) {
    out.cookieError = err.message;
  }

  try {
    const res = await fetch(`${baseUrl}/`, {
      headers: { cookie },
      signal: AbortSignal.timeout(30000)
    });
    const html = await res.text();
    out.home = {
      status: res.status,
      bytes: html.length,
      looksLikeDsh: html.includes('__ModuleLoader__'),
      injectedPolyfill: html.includes('/polyfill.js'),
      injectedCompat: html.includes('/compat.js'),
      injectedBoot: html.includes('/boot.js')
    };
  } catch (err) {
    out.home = { error: err.message };
  }

  try {
    const res = await fetch(`${baseUrl}/api/__probe`, {
      headers: { cookie, origin: baseUrl },
      signal: AbortSignal.timeout(30000)
    });
    await res.text();
    out.api = { status: res.status };
  } catch (err) {
    out.api = { error: err.message };
  }

  try {
    const res = await fetch(`${baseUrl}/compat.js`, { signal: AbortSignal.timeout(30000) });
    const body = await res.text();
    out.compat = { status: res.status, bytes: body.length };
  } catch (err) {
    out.compat = { error: err.message };
  }

  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
