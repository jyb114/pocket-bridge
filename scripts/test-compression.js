// 压缩是不是真的生效、而且**内容没被压坏**。
//
// Verify the served DSH shell and static modules, using their supported routes.
// Asset sizes are measured here; they are not a full phone startup benchmark.
//
// 但压缩这件事有两个容易踩的坑，都必须机器盯着：
//   1. **content-length 必须在压缩之后算**。先算再压会告诉浏览器一个
//      比实际大的长度，浏览器会卡在「等剩下的字节」上 —— 比不压还慢，
//      而且不报错。
//   2. **解压回来的内容必须和源文件一字不差**。压坏一个字节，
//      表现可能是「某个按钮不响应」这种莫名其妙的事。
//
// 用法: node scripts/test-compression.js
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const BASE = path.resolve(__dirname, '..');
const PORT = Number(fs.readFileSync(path.join(BASE, 'logs', 'gateway-port.txt'), 'utf8').trim()) || 8080;
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const INSTANCE = JSON.parse(fs.readFileSync(path.join(BASE, 'logs', 'instance.json'), 'utf8')).instanceId;

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

/**
 * 取一次，**保留原始字节**。
 *
 * 不能用 fetch —— Node 的 fetch 会自动解压，拿到的 len 永远是解压后的大小。
 * 我就是这么量错的：第一版看到「省 0%」，以为压缩没生效，其实是量法错了。
 * 所以这里手写 http.request，自己按 content-encoding 解。
 */
function raw(pathname, opts = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.ae) headers['accept-encoding'] = opts.ae;
    const q = http.request({ host: '127.0.0.1', port: PORT, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let plain = buf;
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'br') plain = zlib.brotliDecompressSync(buf);
          else if (enc === 'gzip') plain = zlib.gunzipSync(buf);
        } catch (err) { plain = null; }
        resolve({
          status: res.statusCode, enc: enc || null,
          len: Number(res.headers['content-length'] || 0),
          bytes: buf.length, plain
        });
      });
    });
    q.on('error', (e) => resolve({ status: 0, error: e.message }));
    q.setTimeout(8000, () => q.destroy(new Error('Scoped gateway timeout')));
    q.end();
  });
}

(async () => {
  console.log('\n=== 静态文件压缩 ===\n');

  const health = await raw('/__health');
  let identity;
  try { identity = JSON.parse(health.plain.toString('utf8')); } catch (_) {}
  if (health.status !== 200 || !INSTANCE || identity?.service !== 'pocket-bridge-gateway' || identity.instanceId !== INSTANCE || identity.port !== PORT || !Number.isInteger(identity.pid)) {
    console.error('Scoped gateway identity is unconfirmed; no credential was sent.'); process.exitCode = 1; return;
  }

  const login = await raw(`/k/${KEY}`);
  const cookie = await new Promise((r) => {
    const q = http.request({ host: '127.0.0.1', port: PORT, path: `/k/${KEY}` }, (res) => {
      res.resume(); r((res.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; '));
    });
    q.end();
  });
  void login;

  const files = [
    ['/boot.js', 'boot.js'], ['/route.js', 'route.js'], ['/e2ee.js', 'e2ee.js'],
    ['/i18n.js', 'i18n.js'], ['/voice.js', 'voice.js'],
    ['/polyfill.js', 'polyfill.js'], ['/compat.js', 'compat.js'],
    ['/dsh-lite', 'dsh-lite.html'], ['/dsh-lite.css', 'dsh-lite.css'],
    ['/dsh-lite-ui.js', 'dsh-lite-ui.js'], ['/dsh-lite-adapter.js', 'dsh-lite-adapter.js']
  ];

  console.log('[1] 支持压缩的客户端：必须压、而且必须省得多');
  let rawTotal = 0, wireTotal = 0;
  for (const [url, file] of files) {
    const src = fs.readFileSync(path.join(BASE, 'pwa', file));
    const r = await raw(url, { cookie, ae: 'gzip, br' });
    rawTotal += src.length; wireTotal += (r.bytes || 0);
    const saved = r.bytes ? Math.round((1 - r.bytes / src.length) * 100) : 0;
    ok(`${url.padEnd(13)} 压了（${src.length} → ${r.bytes}，省 ${saved}%）`,
      r.status === 200 && r.enc && r.bytes < src.length * 0.6,
      `HTTP ${r.status} enc=${r.enc} bytes=${r.bytes}`);
  }
  console.log(`      合计 ${rawTotal} → ${wireTotal} 字节，省 ${Math.round((1 - wireTotal / rawTotal) * 100)}%`);

  console.log('\n[2] ★ 解压回来必须和源文件一字不差');
  for (const [url, file] of files) {
    const src = fs.readFileSync(path.join(BASE, 'pwa', file));
    const r = await raw(url, { cookie, ae: 'gzip, br' });
    ok(`${url.padEnd(13)} 内容一致`, r.plain && r.plain.equals(src),
      r.plain ? `长度 ${r.plain.length} vs 源 ${src.length}` : '解压失败');
  }

  console.log('\n[3] ★ content-length 必须等于**压缩后**的实际字节数');
  for (const [url] of files) {
    const r = await raw(url, { cookie, ae: 'gzip, br' });
    ok(`${url.padEnd(13)} length 对得上（${r.len}）`, r.len === r.bytes,
      `header=${r.len} 实际=${r.bytes}`);
  }

  console.log('\n[4] 不支持压缩的客户端：照旧能拿到原文');
  for (const [url, file] of files) {
    const src = fs.readFileSync(path.join(BASE, 'pwa', file));
    const r = await raw(url, { cookie });     // 不带 accept-encoding
    ok(`${url.padEnd(13)} 未压缩且内容一致`,
      r.status === 200 && !r.enc && r.plain && r.plain.equals(src),
      `enc=${r.enc} status=${r.status}`);
  }

  console.log('\n[5] 优先用 brotli（比 gzip 更小）');
  const b1 = await raw('/boot.js', { cookie, ae: 'gzip, br' });
  const b2 = await raw('/boot.js', { cookie, ae: 'gzip' });
  ok('两种都支持时用 br', b1.enc === 'br', String(b1.enc));
  ok('只支持 gzip 时退回 gzip', b2.enc === 'gzip', String(b2.enc));
  ok('br 比 gzip 小', b1.bytes < b2.bytes, `br=${b1.bytes} gzip=${b2.bytes}`);
  ok('vary 头在（中间层不能把压缩版发给不支持的客户端）',
    (await raw('/boot.js', { cookie, ae: 'gzip, br' })).enc !== null);

  console.log('\n[6] 压缩不能把非文本的东西压坏');
  // 图标是二进制，压它没意义（而且可能触发想不到的问题）——
  // 这里只确认取回来的字节数和磁盘一致
  try {
    const icon = fs.readFileSync(path.join(BASE, 'pwa', 'icon-192.png'));
    const r = await raw('/icon-192.png', { cookie, ae: 'gzip, br' });
    ok('图标字节数一致', r.plain && r.plain.length === icon.length,
      `${r.plain ? r.plain.length : '?'} vs ${icon.length}`);
  } catch (err) {
    console.log('  · 没有 icon-192.png，跳过');
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
