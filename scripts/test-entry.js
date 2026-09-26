// DSH 移动端网关 — 两种入口写法都验证一遍
//
// 背景：手机上曾出现 403「access key required」。服务端两种写法都支持，
// 但扫码器 / 应用内置浏览器常常会把查询参数吃掉，所以这里把两种入口
// 各自跑一次，确认问题出在哪一侧。
'use strict';

const fs = require('fs');
const path = require('path');

const [, , baseUrl, key, logFile] = process.argv;
require('./probe-args.js').requireArgs(process.argv, ['baseUrl', 'key', 'logFile'],
  'node scripts/test-entry.js <baseUrl> <访问密钥> <logFile>');
const out = { ranAt: new Date().toISOString(), baseUrl, entries: {} };

(async () => {
  const cases = [
    { label: 'path', url: `${baseUrl}/k/${key}`, expect: 302 },
    { label: 'query', url: `${baseUrl}/?k=${encodeURIComponent(key)}`, expect: 302 }
  ];

  for (const c of cases) {
    try {
      const res = await fetch(c.url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const setCookies =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);
      const body = await res.text();

      out.entries[c.label] = {
        url: c.url,
        status: res.status,
        expect: c.expect,
        pass: res.status === c.expect,
        location: res.headers.get('location'),
        mintedCookie: setCookies.some((s) => s.startsWith('dsh-auth-')),
        bodyPreview: body.slice(0, 160)
      };
    } catch (err) {
      out.entries[c.label] = { url: c.url, pass: false, error: err.message };
    }
  }

  out.allPassed = Object.values(out.entries).every((e) => e.pass === true);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
