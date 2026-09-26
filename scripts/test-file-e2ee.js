// 图片和文件也要加密 —— 不能只有对话内容加密。
//
// 为什么单独测这一项：文件走的是另一个代码路径（/codex/file），
// 和 WebSocket 完全不同。而且这条路上出过一次严重事故：漏了一个 require，
// 抛出的异常直接把整个网关搞崩了（FATAL），手机上表现为「突然全都连不上」。
//
// 所以要验四件事：
//   1. 不带 e2ee=1 时照旧是明文（老书签、没配密钥的情况不能被影响）
//   2. 带 e2ee=1 时，响应体是密文，且标了 x-dsh-e2ee
//   3. 密文能解开，且解开后还是原来那张图（一个字节都不差）
//   4. 网关不能因为这条路出错就崩掉
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const BASE = path.resolve(__dirname, '..');
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const e2ee = require('./e2ee.js');

// 内网地址现探测 —— 写死的话 DHCP 一换地址，这个测试就连不上，
// 而它报的会是「文件没加密」之类，完全指不到真正的原因。
const LAN_IP = (() => {
  try {
    const v4 = require('./config.js').detectNetwork().lanV4;
    return v4.length ? v4[0].address : '127.0.0.1';
  } catch (e) { return '127.0.0.1'; }
})();
const HTTPS_PORT = (() => {
  try { return Number(fs.readFileSync(path.join(BASE, 'logs', 'https-port.txt'), 'utf8').trim()) || 8081; }
  catch (e) { return 8081; }
})();

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

function get(p, cookie) {
  return new Promise((resolve) => {
    const req = https.get({
      host: LAN_IP, port: HTTPS_PORT, path: p, rejectUnauthorized: false,
      headers: Object.assign({ host: `${LAN_IP}:${HTTPS_PORT}` }, cookie ? { cookie } : {})
    }, (r) => {
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => resolve({
        status: r.statusCode, headers: r.headers, body: Buffer.concat(c)
      }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, error: '超时' }); });
  });
}

/** 找一张真实的、够大的图片来测 */
function findImage() {
  let best = null;
  const walk = (d, depth) => {
    if (depth > 4 || best) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const x of items) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(png|jpe?g)$/i.test(x.name)) continue;
      try { if (fs.statSync(p).size > 100 * 1024) { best = p; return; } } catch (e) { }
    }
  };
  for (const r of ['Documents', 'Desktop', 'Pictures']) walk(path.join(os.homedir(), r), 0);
  return best;
}

const isImage = (b) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8);

(async () => {
  console.log('\n=== 图片 / 文件加密 ===\n');

  const img = findImage();
  if (!img) { console.log('  找不到测试图片，跳过\n'); process.exitCode = 1; return; }
  console.log(`  测试图片: ${path.basename(img)}（${Math.round(fs.statSync(img).size / 1024)} KB）`);

  const secret = fs.readFileSync(path.join(BASE, 'logs', 'e2ee-secret.txt'), 'utf8').trim();
  console.log(`  长期密钥: ${secret.slice(0, 6)}…`);

  const enter = await get(`/k/${KEY}`);
  const cookie = (enter.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');

  const q = `/codex/file?path=${encodeURIComponent(img)}&root=${encodeURIComponent(path.dirname(img))}`;

  // ── 1. 不加密时照旧（老书签、没配密钥的情况）──────────────────────
  //
  // 注：这里曾经改成「不带 e2ee=1 也必须加密」，理由是冒充者不会主动要求加密。
  // 但那个改动会把**所有没带 #k= 的客户端**一起废掉（收到密文解不开，
  // 页面卡死），需要配套的 403 提示和测试脚手架改造，是一个完整的改动。
  // 所以暂时回到原来的行为 —— **这条缺口还在，记在 mobile-proxy.js 里**。
  const plain = await get(q, cookie);
  ok('不带 e2ee=1 → HTTP 200', plain.status === 200, String(plain.status));
  ok('不带 e2ee=1 → 是明文图片（老路径不受影响）', isImage(plain.body));
  ok('不带 e2ee=1 → 没有加密标记', !plain.headers['x-dsh-e2ee']);

  // ── 2. 加密 ────────────────────────────────────────────────────
  const enc = await get(q + '&e2ee=1', cookie);
  ok('带 e2ee=1 → HTTP 200', enc.status === 200, enc.error || String(enc.status));
  ok('带 e2ee=1 → 标了 x-dsh-e2ee', enc.headers['x-dsh-e2ee'] === '1');
  ok('带 e2ee=1 → 记下了原来的类型',
    !!enc.headers['x-dsh-e2ee-type'], String(enc.headers['x-dsh-e2ee-type']));
  ok('带 e2ee=1 → 响应体不是可读图片（是密文）', !isImage(enc.body));
  ok('带 e2ee=1 → content-type 是不透明的二进制流',
    /octet-stream/.test(String(enc.headers['content-type'])),
    String(enc.headers['content-type']));

  // ── 3. 能解开，而且和原文件一模一样 ──────────────────────────────
  const keys = e2ee.deriveKeys(secret, e2ee.slotAt());
  const back = e2ee.decrypt(keys.b, enc.body);
  ok('密文能解开', !!back);
  if (back) {
    const orig = fs.readFileSync(img);
    ok('解开后和原文件逐字节相同', back.equals(orig),
      `解开 ${back.length} / 原始 ${orig.length}`);
  }

  // ── 4. 网关没被这条路径搞崩 ─────────────────────────────────────
  //
  // 注意：/__health 只允许回环访问，所以从内网地址打过去会返回 403。
  // **403 恰恰说明网关活着**（它做出了判断并回了话）。这里只要"有响应"就算过，
  // 不能要求 200 —— 之前写成 200，把一次正常行为误报成了故障。
  const health = await get('/__health');
  ok('网关仍然活着（这条路径出错不能把它带走）',
    health.status > 0, health.error || ('HTTP ' + health.status));

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
