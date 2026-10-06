#!/usr/bin/env node
/**
 * 回归测试：PWA 安装能力（manifest / 图标）必须真的接上
 *
 * 为什么要有这个文件
 * ------------------
 * `manifest.webmanifest`、`icon-192.png`、`apple-touch-icon.png` 全都在服务器上，
 * 路由也都在 —— 但**没有任何页面引用它们**。于是：
 *
 *   · manifest 形同虚设：`display: standalone`、`short_name`、maskable 图标
 *     一个都不生效，「添加到主屏幕」不是真 PWA；
 *   · iOS 不认 manifest，它自己去探测 `/apple-touch-icon-120x120.png`，
 *     而路由表只有**无后缀**的精确名 → 404 → 主屏图标是空的。
 *     日志里两条 404 来自两场真实 iPhone 会话。
 *
 * 这两种「文件都在、就是没接上」的毛病静态看不出来，所以这里**真的发请求**。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const BASE = path.join(__dirname, '..');
let expectedInstance = null, PORT = 0;
try {
  expectedInstance = JSON.parse(fs.readFileSync(path.join(BASE, 'logs', 'instance.json'), 'utf8')).instanceId;
  PORT = Number(fs.readFileSync(path.join(BASE, 'logs', 'gateway-port.txt'), 'utf8').trim());
} catch (_) {}
let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failed++;
  return ok;
}

function get(pathname, cookie) {
  return new Promise((resolve) => {
    if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) return resolve({status:0,body:'No scoped gateway port',headers:{}});
    const headers = { host: '127.0.0.1:' + PORT };
    if (cookie) headers.cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (d) => { if (b.length < 400000) b += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message, headers: {} }));
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, body: 'TIMEOUT', headers: {} }); });
    r.end();
  });
}

// ★ 只有 apple-touch-icon，**故意不要 `rel="manifest"`**。
//
//   manifest 里 `start_url` 是 `/`。iOS「添加到主屏幕」时用的是 manifest 的
//   start_url，**不是你当前那条链接** —— 于是链接里的 `#k=` 被丢掉。没有密钥，
//   实时通道就被拒绝，手机打开主屏幕图标只看到「连上了但对话是空的」。
//   实测就是这条把使用者坑了：图标修好了，主屏幕却打不开了。
//
//   图标那个修复靠的是 apple-touch-icon，不需要 manifest。所以：
//   图标要留，manifest 链接必须没有 —— 谁再手滑加回去，这条断言会红。
const NEEDS = ['apple-touch-icon'];

console.log('\n【PWA 安装能力】');

// ── 1. 静态：仓库里的页面本身要声明 ────────────────────────────────────
for (const f of ['go.html', 'dsh-lite.html', 'console.html']) {
  const src = fs.readFileSync(path.join(BASE, 'pwa', f), 'utf8');
  const head = src.slice(0, src.indexOf('</head>') + 7 || 4000);
  for (const need of NEEDS) {
    check(`pwa/${f} 的 <head> 里有 ${need}`, head.includes(need));
  }
}

// ── 2. 静态：服务端渲染的页面也要声明 ──────────────────────────────────
{
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
  for (const fn of ['launcherPage', 'pairPage']) {
    const at = src.indexOf(`function ${fn}(`);
    // 取这个函数往后 60 行，够覆盖它的 <head>
    const body = at < 0 ? '' : src.slice(at, at + 6000).split('\n').slice(0, 60).join('\n');
    check(`${fn} 渲染的页面里有 apple-touch-icon`, body.includes('apple-touch-icon'));
    // 反过来：**不许**有 manifest 链接。理由见上面 NEEDS 那段注释 ——
    // manifest 的 start_url 会让「加到主屏幕」丢掉 #k=，把主屏幕入口弄成废的。
    check(`${fn} 渲染的页面里**没有** manifest 链接（它会弄丢 #k=）`,
      !body.includes('rel="manifest"'), '有人把 manifest 链接加回来了');
  }
  check('带尺寸后缀的图标有兜底路由',
    /apple-touch-icon\[\^\/\]\*\\\.png/.test(src), 'mobile-proxy.js 里没找到那条模式匹配');
}

// ── 3. 现场：真的发请求（网关没跑就记提示，不假装通过）─────────────────
(async () => {
  const health = await get('/__health');
  if (health.status !== 200) {
    console.log(`  · 网关没在跑（/__health = ${health.status}）—— 跳过现场检查（不算通过）`);
    return finish();
  }
  let identity;
  try { identity = JSON.parse(health.body); } catch (_) {}
  if (!expectedInstance || !identity || identity.service !== 'pocket-bridge-gateway' || identity.instanceId !== expectedInstance || identity.port !== PORT || !Number.isInteger(identity.pid)) {
    console.log('  · Scoped gateway identity is unconfirmed; live checks were not run and no credential was sent.');
    return finish();
  }

  // 免认证就能取的
  const man = await get('/manifest.webmanifest');
  let parsed = null;
  try { parsed = JSON.parse(man.body); } catch (err) { /* 下面报 */ }
  check('/manifest.webmanifest 取得到且是合法 JSON', man.status === 200 && !!parsed, `status=${man.status}`);
  if (parsed) {
    check('manifest 里没有引用别人的产品名',
      !/DeepSeek|DSH/.test(String(parsed.name) + String(parsed.short_name)),
      `name=${parsed.name} short_name=${parsed.short_name}`);
    const themeMeta = fs.readFileSync(path.join(BASE, 'pwa', 'dsh-lite.html'), 'utf8')
      .match(/name="theme-color" content="([^"]+)"/);
    check('manifest 的 theme_color 和页面 <meta theme-color> 一致',
      !!themeMeta && parsed.theme_color === themeMeta[1],
      `manifest=${parsed.theme_color} 页面=${themeMeta && themeMeta[1]}`);
    // manifest 里声明的每个图标都要真能取到
    for (const ic of parsed.icons || []) {
      const r = await get(ic.src);
      check(`manifest 声明的图标 ${ic.src} 取得到`, r.status === 200, `status=${r.status}`);
    }
  }

  // iOS 自动探测的那两个名字 —— 就是它们 404 掉的
  for (const p of ['/apple-touch-icon-120x120.png',
                   '/apple-touch-icon-120x120-precomposed.png',
                   '/apple-touch-icon-180x180.png',
                   '/apple-touch-icon.png']) {
    const r = await get(p);
    check(`iOS 探测的 ${p} 不再 404`, r.status === 200, `status=${r.status}`);
  }

  // 需要认证的页面
  let key = '';
  try { key = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim(); } catch (err) { /* 没有 */ }
  if (!key) { console.log('  · 读不到访问密钥，跳过页面检查（不算通过）'); return finish(); }
  const auth = await get('/k/' + encodeURIComponent(key));
  const cookie = (auth.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  for (const p of ['/?target=lite', '/dsh-lite']) {
    const r = await get(p, cookie);
    const ok = r.status === 200 && NEEDS.every((n) => r.body.includes(n));
    check(`现场 ${p} 的响应里有 apple-touch-icon`, ok, `status=${r.status}`);
  }

  finish();
})();

function finish() {
  console.log(failed === 0
    ? '\nConfigured PWA checks passed; any explicitly omitted live checks remain unverified.\n'
    : `\n结论: ${failed} 项不通过 —— 手机「添加到主屏幕」会拿到没有图标的壳。\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
