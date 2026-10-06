// 语言包体积：按语言裁剪页面的回归测试（2026-09-27）。
//
// 为减小语言包体积，网关照旧读文件、发出去之前把**用不上的
// 语言**摘掉（客户端一行都不用改，也不多发请求）。这个测试守四件事：
//
//   ① 三种语言都裁得对：中文（key 就是中文，整份字典都不需要）、英文、西语
//   ② 裁完**页面还是完整的**：标签数不变、大括号收支不变、文件没被腰斩
//   ③ **钉过指纹的共享与 DSH Lite JS 一个都不许裁** —— 同一个 URL 按语言发不同内容，
//      会让「切一次语言」看起来像「代码被改过」（手机会弹红字拒绝执行）
//   ④ 裁不了就原样发（不认识的写法、语法不过、抛异常，一律退回原文）
//
// 跑法: node scripts/test-dict-trim.js   （网关在跑时额外验一次真实响应）
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const dictTrim = require('./dict-trim.js');
const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');

const PORT = 8080;
const PAGES = ['pwa/console.html', 'pwa/go.html'];
const PINNED = ['polyfill.js', 'compat.js', 'e2ee.js', 'i18n.js', 'voice.js', 'route.js', 'boot.js', 'first-load.js',
  'prove.js', 'dsh-directory-picker.js', 'dsh-lite-pin.js', 'dsh-lite-adapter.js', 'dsh-lite-ui.js',
  'dsh-lite-switch.js', 'dsh-lite-legacy.js', 'dsh-lite-router.js', 'dsh-lite-lang.js'];
const staticOnly = process.argv.includes('--static-only');

let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};
const skip = (n, why) => { skipped++; console.log(`  · ${n} —— 跳过（${why}）`); };

const countOf = (s, needle) => s.split(needle).length - 1;
const balance = (s) => countOf(s, '{') - countOf(s, '}');

/**
 * 只数**字典块里**的语言条目。
 *
 * 为什么不能直接对整份文件 grep `en:` —— console.html 第 1542 行有
 *   `var locale = { zh:'zh-CN', en:'en-US', es:'es-ES' }[lang]`
 * 那是「语言代码 → Intl 区域」的映射，**本来就该留着**（第一版就是被它判失败的）。
 */
function dictRegion(src, marker) {
  const at = src.indexOf(marker || 'DshI18n.register(');
  if (at < 0) return '';
  const braceAt = src.indexOf('{', at);
  const close = dictTrim.findClose(src, dictTrim.scan(src), braceAt);
  return close < 0 ? '' : src.slice(braceAt + 1, close);
}

console.log('\n=== 语言包体积：按语言裁剪 · 回归 ===\n');

// ── ① 三种语言都裁得对 ──────────────────────────────────────────────────────
console.log('[1] 每种语言只留自己那一门');
for (const f of PAGES) {
  const src = fs.readFileSync(path.join(BASE, f), 'utf8');
  const raw = Buffer.byteLength(src, 'utf8');

  const zh = dictTrim.trimToLanguage(src, ['zh'], null, { isHtml: true });
  const zhRegion = dictRegion(zh.text);
  ok(`${f} 中文：整份字典被摘掉（省 ${raw - Buffer.byteLength(zh.text, 'utf8')} 字节）`,
    zh.changed && zhRegion.length < 3000 &&
    !/\ben\s*:\s*['"]/.test(zhRegion) && !/\bes\s*:\s*['"]/.test(zhRegion),
    zh.note + ' region=' + zhRegion.length);

  const en = dictTrim.trimToLanguage(src, ['zh', 'en'], null, { isHtml: true });
  const enRegion = dictRegion(en.text);
  ok(`${f} 英文：西语被摘掉、英文还在`,
    en.changed && !/\bes\s*:\s*['"]/.test(enRegion) && /\ben\s*:\s*['"]/.test(enRegion),
    en.note);

  const es = dictTrim.trimToLanguage(src, ['zh', 'es'], null, { isHtml: true });
  const esRegion = dictRegion(es.text);
  ok(`${f} 西语：英文被摘掉、西语还在`,
    es.changed && !/\ben\s*:\s*['"]/.test(esRegion) && /\bes\s*:\s*['"]/.test(esRegion),
    es.note);

  ok(`${f} 三种裁法都比原文小`,
    Buffer.byteLength(zh.text, 'utf8') < raw &&
    Buffer.byteLength(en.text, 'utf8') < raw &&
    Buffer.byteLength(es.text, 'utf8') < raw);
}

// ── ② 裁完还是完整的页面 ────────────────────────────────────────────────────
console.log('\n[2] 裁完页面不能坏');
for (const f of PAGES) {
  const src = fs.readFileSync(path.join(BASE, f), 'utf8');
  for (const keep of [['zh'], ['zh', 'en'], ['zh', 'es']]) {
    const r = dictTrim.trimToLanguage(src, keep, null, { isHtml: true });
    const sameTags = countOf(src, '<script') === countOf(r.text, '<script') &&
      countOf(src, '</script>') === countOf(r.text, '</script>');
    const sameBraces = balance(src) === balance(r.text);
    const intactTail = r.text.trimEnd().endsWith('</html>');
    const notGutted = r.text.length > src.length * 0.5;
    ok(`${path.basename(f)} 留 ${keep.join('+')}：标签数/括号收支/结尾都在`,
      sameTags && sameBraces && intactTail && notGutted,
      `tags=${sameTags} braces=${sameBraces} tail=${intactTail} size=${notGutted}`);
  }
}

// ── ③ 钉过指纹的文件一个都不许裁 ────────────────────────────────────────────
console.log('\n[3] 钉过指纹的共享与 DSH Lite JS：不许按语言改写');
{
  // Only the shared console and selector HTML are language-trimmed. DSH Lite
  // scripts are fingerprinted exact assets, never rewritten per language.
  const calls = [...SRC.matchAll(/trimHtmlToLanguage\(req, res, path\.join\(PWA_DIR, '([^']+)'\)\)/g)]
    .map((m) => m[1]);
  ok('裁剪只用在 console.html / go.html 上',
    calls.length === 2 && new Set(calls).size === 2 && calls.every((c) => ['console.html', 'go.html'].indexOf(c) >= 0),
    calls.join(','));
  for (const name of PINNED) {
    ok(`没有对 ${name} 做按语言裁剪`, calls.indexOf(name) < 0);
  }
  // 指纹名单本身也要在（防止有人顺手把它删了）
  ok('网关里仍保留共享与 DSH Lite 文件的指纹名单',
    PINNED.every((n) => SRC.indexOf(`'/${n}'`) >= 0 || SRC.indexOf(`'${n}'`) >= 0));
}

// ── ④ 裁不了就原样发 ────────────────────────────────────────────────────────
console.log('\n[4] 认不出来 / 改坏了 / 抛异常 —— 一律原样发');
{
  const weird = "var TEXT = { zh: { a: '一' }, en: { a: 'one' }";     // 大括号不配平
  const r1 = dictTrim.trimToLanguage(weird, ['zh'], null, {});
  ok('大括号不配平 → 原样返回', r1.text === weird && r1.changed === false, r1.note);

  const plain = 'function hello() { return 1; }\n';
  const r2 = dictTrim.trimToLanguage(plain, ['zh'], null, {});
  ok('没有任何可裁的形状 → 原样返回', r2.text === plain && r2.changed === false, r2.note);

  let threw = null;
  try {
    for (const f of fs.readdirSync(path.join(BASE, 'pwa'))) {
      if (!/\.(js|html)$/.test(f)) continue;
      const src = fs.readFileSync(path.join(BASE, 'pwa', f), 'utf8');
      for (const keep of [['zh'], ['zh', 'en'], ['zh', 'es'], ['en'], []]) {
        dictTrim.trimToLanguage(src, keep, null, { isHtml: /\.html$/.test(f) });
      }
    }
  } catch (err) { threw = err.message; }
  ok('把 pwa 下每个文件、每种语言都过一遍：不抛异常', !threw, threw || '');
}

// ── ⑤ 真网关：同一个 URL 按语言给不同体积 ───────────────────────────────────
(async () => {
  console.log('\n[5] 真网关：/go 按 dsh-lang 给不同体积');
  if (staticOnly) {
    skip('真网关那一段', '明确使用 --static-only；没有发起真实请求');
    console.log(`\n${pass} 通过 / ${fail} 失败 / ${skipped} 跳过\n`);
    process.exit(fail ? 1 : 0);
  }
  const up = await new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/__probe', timeout: 1500 }, (res) => {
      res.resume(); resolve(res.statusCode === 204 || res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
  if (!up) {
    skip('真网关那一段', `网关没在 127.0.0.1:${PORT} 上跑`);
  } else {
    const key = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
    const req = (opts) => new Promise((resolve) => {
      const r = http.request({
        host: '127.0.0.1', port: PORT, method: opts.method || 'GET', path: opts.path,
        headers: Object.assign({ host: `127.0.0.1:${PORT}` }, opts.headers || {})
      }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8'), headers: res.headers }));
      });
      r.on('error', (e) => resolve({ status: 0, body: String(e.message), headers: {} }));
      r.end();
    });

    // 先用密钥路径换 cookie（真手机上也是这么进来的）
    const login = await req({ path: `/k/${key}`, headers: { 'user-agent': `dict-trim-test/${crypto.randomBytes(3).toString('hex')}` } });
    const cookie = (login.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');

    const zh = await req({ path: '/go', headers: { cookie: `${cookie}; dsh-lang=zh` } });
    const en = await req({ path: '/go', headers: { cookie: `${cookie}; dsh-lang=en` } });
    ok('两种语言都能拿到页面（HTTP 200）', zh.status === 200 && en.status === 200,
      `zh=${zh.status} en=${en.status}`);
    if (zh.status === 200 && en.status === 200) {
      ok('中文那份更小（字典整份摘掉）', zh.body.length < en.body.length,
        `zh=${zh.body.length} en=${en.body.length}`);
      const zhRegion = dictRegion(zh.body);
      const enRegion = dictRegion(en.body);
      ok('中文那份的字典被摘干净，英文那份还留着 en 条目',
        !/\ben\s*:\s*['"]/.test(zhRegion) && !/\bes\s*:\s*['"]/.test(zhRegion) &&
        /\ben\s*:\s*['"]/.test(enRegion),
        `zhRegion=${zhRegion.length} enRegion=${enRegion.length}`);
      ok('两份都是完整页面（结尾 </html>）',
        zh.body.trimEnd().endsWith('</html>') && en.body.trimEnd().endsWith('</html>'));
    }
  }
  console.log(`\n${pass} 通过 / ${fail} 失败` + (skipped ? ` / ${skipped} 跳过` : '') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('跑挂了：' + (e && e.stack)); process.exit(1); });
