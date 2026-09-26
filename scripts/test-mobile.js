// DSH 移动端网关 — 模拟手机浏览器的端到端自测
//
// 验证三件事：
//   1. 第一次访问（不带 cookie）时，中间层有没有把 dsh-auth-* 种下来
//   2. 带上那个 cookie 再访问首页，DSH 是否返回真实页面（200）而不是 401
//   3. /api 路径是否通过了 DSH 的浏览器信任栅栏（403 = Host 被拒，其它 = 通过）
'use strict';

const fs = require('fs');
const path = require('path');

const [, , baseUrl, logFile] = process.argv;
const out = { ranAt: new Date().toISOString(), baseUrl, steps: {} };
const TIMEOUT = 30000;

(async () => {
  try {
    if (!baseUrl || !logFile) throw new Error('usage: test-mobile.js <baseUrl> <logFile>');

    // ── 步骤 1：冷访问，看中间层是否种 cookie ──────────────────────────────
    const r1 = await fetch(`${baseUrl}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT)
    });
    const rawSetCookie =
      typeof r1.headers.getSetCookie === 'function'
        ? r1.headers.getSetCookie()
        : [r1.headers.get('set-cookie')].filter(Boolean);

    out.steps.firstVisit = {
      status: r1.status,
      setCookieCount: rawSetCookie.length,
      cookieNames: rawSetCookie.map((s) => s.split('=')[0]),
      hasDshAuthCookie: rawSetCookie.some((s) => s.startsWith('dsh-auth-')),
      location: r1.headers.get('location')
    };
    await r1.text();

    const cookie = rawSetCookie.map((s) => s.split(';')[0]).join('; ');

    // ── 步骤 2：带 cookie 再访问首页 ───────────────────────────────────────
    const r2 = await fetch(`${baseUrl}/`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT)
    });
    const body2 = await r2.text();
    out.steps.withCookie = {
      status: r2.status,
      bodyLength: body2.length,
      looksLikeDshApp:
        body2.includes('__ModuleLoader__') || body2.includes('DeepSeek Harness'),
      bodyPreview: body2.slice(0, 160)
    };

    // ── 步骤 3：/api 的浏览器信任栅栏 ──────────────────────────────────────
    const r3 = await fetch(`${baseUrl}/api/__probe`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT)
    });
    const body3 = await r3.text();
    out.steps.apiProbe = {
      status: r3.status,
      bodyPreview: body3.slice(0, 200),
      verdict:
        r3.status === 403
          ? 'Host 被信任栅栏拒绝'
          : 'Host 通过信任栅栏（403 以外即为通过）'
    };

    out.status = 'ok';
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
