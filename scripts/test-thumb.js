// 缩略图端点：原图 vs ?w=900，传输量和耗时差多少。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const KEY = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();

// 找一张真正大的图来试
function biggestImage() {
  let best = null;
  const roots = [
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Pictures')
  ];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const x of items) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(png|jpe?g|webp)$/i.test(x.name)) continue;
      try {
        const st = fs.statSync(p);
        if (st.size > 1024 * 1024 && (!best || st.size > best.size)) best = { p, size: st.size };
      } catch (e) { /* 跳过 */ }
    }
  };
  for (const r of roots) walk(r, 0);
  return best;
}

const get = (p, cookie) => new Promise((res) => {
  const t0 = Date.now();
  http.get({ host: '127.0.0.1', port: 8080, path: p, headers: { cookie } }, (r) => {
    let n = 0;
    r.on('data', (d) => { n += d.length; });
    r.on('end', () => res({ s: r.statusCode, bytes: n, ms: Date.now() - t0, type: r.headers['content-type'] }));
  }).on('error', (e) => res({ s: 0, err: e.message }));
});

(async () => {
  const img = biggestImage();
  if (!img) { console.log('  没找到大于 1MB 的图，跳过'); return; }
  console.log(`\n  原图: ${img.p}`);
  console.log(`  大小: ${(img.size / 1048576).toFixed(2)} MB\n`);

  const cookie = await new Promise((r) => {
    http.get({ host: '127.0.0.1', port: 8080, path: '/k/' + KEY }, (res) => {
      r((res.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; '));
      res.resume();
    });
  });

  const root = path.dirname(img.p);
  const url = '/codex/file?path=' + encodeURIComponent(img.p) +
    '&root=' + encodeURIComponent(root);

  const a = await get(url, cookie);
  console.log(`  原图请求  : HTTP ${a.s}  ${(a.bytes / 1048576).toFixed(2)} MB  ${a.ms} ms`);
  if (a.bytes < 1000) { console.log('  （传输太小，可能被拒了）'); return; }

  const b = await get(url + '&w=900', cookie);
  console.log(`  缩略图    : HTTP ${b.s}  ${(b.bytes / 1024).toFixed(0)} KB  ${b.ms} ms  ${b.type}`);

  const c = await get(url + '&w=900', cookie);
  console.log(`  再取一次  : ${(c.bytes / 1024).toFixed(0)} KB  ${c.ms} ms  （走缓存）`);

  console.log('');
  console.log(`  传输量减少: ${(a.bytes / Math.max(b.bytes, 1)).toFixed(0)} 倍`);
  console.log(`  首屏快多少: ${a.ms} ms → ${b.ms} ms`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
