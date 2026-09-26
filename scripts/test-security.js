// DSH 移动端网关 — 安全性回归测试
//
// 验证三件事：
//   1. 不带访问密钥、不带 cookie 的陌生人  → 必须被拒（403），且不许种 cookie
//   2. 带对访问密钥的首次访问              → 302 + 种下 dsh-auth cookie
//   3. 持有 cookie 的正常访问              → 200 + 真实应用页面
'use strict';

const fs = require('fs');
const path = require('path');

const [, , baseUrl, accessKey, logFile] = process.argv;
require('./probe-args.js').requireArgs(process.argv, ['baseUrl', 'accessKey', 'logFile'],
  'node scripts/test-security.js <baseUrl> <访问密钥> <logFile>');
const out = { ranAt: new Date().toISOString(), baseUrl, steps: {} };
const T = 30000;

(async () => {
  try {
    if (!baseUrl || !accessKey || !logFile) {
      throw new Error('usage: test-security.js <baseUrl> <accessKey> <logFile>');
    }

    const setCookiesOf = (res) =>
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);

    // ① 陌生人：无密钥、无 cookie
    const r1 = await fetch(`${baseUrl}/`, { redirect: 'manual', signal: AbortSignal.timeout(T) });
    const b1 = await r1.text();
    const sc1 = setCookiesOf(r1);
    out.steps.stranger = {
      status: r1.status,
      expected: 403,
      pass: r1.status === 403,
      leakedCookie: sc1.some((s) => s.startsWith('dsh-auth-')),
      bodyPreview: b1.slice(0, 120)
    };

    // ①b 陌生人试着直接猜 API
    const r1b = await fetch(`${baseUrl}/api/remote.mux`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(T)
    });
    await r1b.text();
    out.steps.strangerApi = {
      status: r1b.status,
      expected: 403,
      pass: r1b.status === 403
    };

    // ② 带对密钥的首次访问：返回一个自带 meta refresh 的过渡页 + 种下 cookie
    const r2 = await fetch(`${baseUrl}/?k=${encodeURIComponent(accessKey)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(T)
    });
    const sc2 = setCookiesOf(r2);
    const b2 = await r2.text();
    const autoRedirects = /http-equiv='refresh'/i.test(b2);
    out.steps.withKey = {
      status: r2.status,
      expected: '200 + 自动跳转过渡页',
      pass: r2.status === 200 && autoRedirects,
      autoRedirects,
      mintedCookie: sc2.some((s) => s.startsWith('dsh-auth-'))
    };

    const cookie = sc2.map((s) => s.split(';')[0]).join('; ');

    // ③ 凭 cookie 正常访问
    const r3 = await fetch(`${baseUrl}/`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(T)
    });
    const b3 = await r3.text();
    out.steps.withCookie = {
      status: r3.status,
      expected: 200,
      pass: r3.status === 200,
      bodyLength: b3.length,
      looksLikeDshApp: b3.includes('__ModuleLoader__'),
      // 老版本 Safari 打开 DSH 会因缺 Iterator 而崩，中间层必须把它注进去
      polyfillInjected: b3.includes('/polyfill.js'),
      polyfillBeforeApp: b3.indexOf('/polyfill.js') < b3.indexOf('__ModuleLoader__'),
      // 网页通知的浏览器侧引导也应当被注入
      bootJsInjected: b3.includes('/boot.js')
    };

    // ③b 带 Origin 的 API 请求 —— 这才是手机的真实行为。
    //     中间层必须把 Origin 改写成与 Host 一致，否则 DSH 的信任栅栏返回 403，
    //     表现就是「页面能打开，但读不到项目和对话」。
    const r3b = await fetch(`${baseUrl}/api/__probe`, {
      headers: { cookie, origin: baseUrl },
      redirect: 'manual',
      signal: AbortSignal.timeout(T)
    });
    const b3b = await r3b.text();
    out.steps.apiWithOrigin = {
      status: r3b.status,
      expected: '非 403',
      pass: r3b.status !== 403,
      bodyPreview: b3b.slice(0, 120)
    };

    // ③c VAPID 公钥端点（需要认证）—— 手机订阅通知时要从这里取
    const r3c = await fetch(`${baseUrl}/__push/vapid`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(T)
    });
    const vapidKey = (await r3c.text()).trim();
    out.steps.vapidEndpoint = {
      status: r3c.status,
      pass: r3c.status === 200 && vapidKey.length > 40,
      keyLength: vapidKey.length
    };

    // ④ 错误密钥必须被拒
    const r4 = await fetch(`${baseUrl}/?k=wrong-key-000`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(T)
    });
    await r4.text();
    out.steps.wrongKey = { status: r4.status, expected: 403, pass: r4.status === 403 };

    out.allPassed = Object.values(out.steps).every((s) => s.pass !== false);
    out.status = 'ok';
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
