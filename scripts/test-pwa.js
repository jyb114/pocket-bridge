// DSH 移动端网关 — PWA 资源可访问性测试
//
// 这些资源必须在认证之前就能取到：浏览器获取 manifest 和图标时还没有会话
// cookie，如果被 403 挡掉，iPhone「添加到主屏幕」只会得到一个网页截图。
// 同时校验 sw.js 带 Service-Worker-Allowed: /，否则它的作用域会被限制在
// 自身所在目录，无法接管整站。
'use strict';

const fs = require('fs');
const path = require('path');

const [, , baseUrl, logFile] = process.argv;
require('./probe-args.js').requireArgs(process.argv, ['baseUrl', 'logFile'],
  'node scripts/test-pwa.js <baseUrl> <logFile>');
const out = { ranAt: new Date().toISOString(), baseUrl, resources: {} };

const targets = [
  { p: '/manifest.webmanifest', kind: 'json' },
  { p: '/sw.js', kind: 'js' },
  { p: '/icon-192.png', kind: 'png' },
  { p: '/icon-512.png', kind: 'png' },
  { p: '/apple-touch-icon.png', kind: 'png' }
];

(async () => {
  for (const t of targets) {
    try {
      const res = await fetch(`${baseUrl}${t.p}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20000)
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const rec = {
        status: res.status,
        ok: res.status === 200,
        contentType: res.headers.get('content-type'),
        bytes: buf.length
      };

      if (t.kind === 'json') {
        rec.preview = buf.toString('utf8').slice(0, 220);
        try {
          const parsed = JSON.parse(buf.toString('utf8'));
          rec.validJson = true;
          rec.iconCount = Array.isArray(parsed.icons) ? parsed.icons.length : 0;
          rec.hasPngIcon = (parsed.icons || []).some((i) => /\.png$/.test(i.src || ''));
        } catch {
          rec.validJson = false;
        }
      }
      if (t.kind === 'png') {
        rec.isRealPng =
          buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG';
      }
      if (t.kind === 'js') {
        rec.preview = buf.toString('utf8').slice(0, 120);
        rec.serviceWorkerAllowed = res.headers.get('service-worker-allowed');
        rec.scopeUnlocked = res.headers.get('service-worker-allowed') === '/';
      }

      out.resources[t.p] = rec;
    } catch (err) {
      out.resources[t.p] = { error: err.message };
    }
  }

  out.allOk = Object.values(out.resources).every((r) => r.ok === true);
  out.status = 'ok';

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify(out, null, 2), 'utf8');
})();
