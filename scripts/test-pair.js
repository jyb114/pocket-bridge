// DSH 移动端网关 — 动态配对码测试
'use strict';

const fs = require('fs');
const path = require('path');

const [, , baseUrl, code, logFile] = process.argv;
require('./probe-args.js').requireArgs(process.argv, ['baseUrl', 'code', 'logFile'],
  'node scripts/test-pair.js <baseUrl> <配对码> <logFile>');
const out = { ranAt: new Date().toISOString(), baseUrl };
const T = 20000;

(async () => {
  try {
    // ① 配对页面本身要能匿名打开（手机还没有 cookie 时就要看到输入框）
    const r1 = await fetch(`${baseUrl}/pair`, { redirect: 'manual', signal: AbortSignal.timeout(T) });
    const b1 = await r1.text();
    out.pairPage = {
      status: r1.status,
      pass: r1.status === 200,
      hasInputForm: b1.includes('name="code"'),
      bytes: b1.length
    };

    // ② 错误的配对码必须被拒，且不能种 cookie
    const r2 = await fetch(`${baseUrl}/pair?code=000000`, { redirect: 'manual', signal: AbortSignal.timeout(T) });
    const sc2 = typeof r2.headers.getSetCookie === 'function' ? r2.headers.getSetCookie() : [];
    out.wrongCode = {
      status: r2.status,
      pass: r2.status === 403 && !sc2.some((s) => s.startsWith('dsh-auth-')),
      leakedCookie: sc2.some((s) => s.startsWith('dsh-auth-'))
    };
    await r2.text();

    // ③ 正确的配对码：种下 cookie 并自动进入
    const r3 = await fetch(`${baseUrl}/pair?code=${encodeURIComponent(code)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(T)
    });
    const sc3 = typeof r3.headers.getSetCookie === 'function' ? r3.headers.getSetCookie() : [];
    const b3 = await r3.text();
    out.rightCode = {
      status: r3.status,
      pass: r3.status === 200 && sc3.some((s) => s.startsWith('dsh-auth-')),
      mintedCookie: sc3.some((s) => s.startsWith('dsh-auth-')),
      autoRedirects: /refresh/i.test(b3)
    };

    out.allPassed = Object.values(out).every((v) => typeof v !== 'object' || v.pass !== false);
    out.status = 'ok';
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
