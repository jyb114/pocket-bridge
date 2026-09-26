// 「切出去再切回来，不用刷新」—— 这条测试守的就是它。
//
// 使用者 2026-09-26 的原话：
//     「现在切到外面的应用，再切回来，又必须刷新才能继续了，以前都不用刷新的」
//
// 日志里那个现场（他那台 iPhone，20:08）：
//     403 未通过挑战应答: GET /__deepseek/balance（…**不在开页面的窗口里，直接拒**）
//     WS 被拒：设备「iPhone · Safari」还没通过挑战应答       ← 连着 6 次
//     ……40 秒里一次证明尝试都没有……
//     20:08:53 登记设备「iPhone · Safari」                    ← 他手动刷新了
//
// 两个原因，各对应这里的一组断言：
//   ① **进门证明只存在内存里**，而我又连着重启了几次网关（验配对码）→ 全清空。
//      现在落盘（logs/auth-proven.json，同一个 12 小时有效期），重启不再清空。
//   ② 客户端回到前台时用 prove(false)，本地认为「我证过」就直接返回 ——
//      服务端都不认了，它一个请求都不发。现在回前台**强制**证一次。
//
// 但落盘**不等于**开门：这条测试同时盯住「没证明的设备照样 403」，
// 免得哪天把「重启不清空」写成「谁都不用证明」。
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
const E2EE = fs.readFileSync(path.join(BASE, 'pwa', 'e2ee.js'), 'utf8');
const PROVEN_FILE = path.join(BASE, 'logs', 'auth-proven.json');
const LIVE = process.argv.includes('--live');

let pass = 0; let fail = 0; let skipped = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); } };
const skip = (n, why) => { skipped++; console.log(`  · ${n}（跳过：${why}）`); };

console.log('\n[1] 证明要落盘（重启不再把人踢出去）');
{
  ok('有读回磁盘的函数', /function loadAuthProven\(/.test(SRC));
  ok('有写回磁盘的函数', /function saveAuthProven\(/.test(SRC));
  ok('文件名是 logs/auth-proven.json', /auth-proven\.json/.test(SRC));
  ok('启动时读回来（在 listen 成功之后）',
    /中间层已启动[\s\S]{0,200}loadAuthProven\(\)/.test(SRC));
  ok('证明通过时写回', /authProven\.set\(parts\[0\], Date\.now\(\)\);\s*\n\s*saveAuthProven\(\)/.test(SRC));
  ok('有效期还是 12 小时（没有顺手放宽）',
    /AUTH_PROVEN_TTL_MS = 12 \* 60 \* 60 \* 1000/.test(SRC));
  ok('文件里只有「设备 id → 时间」，不写任何凭据',
    /obj\[id\] = at/.test(SRC) && !/saveAuthProven[\s\S]{0,400}(token|secret|key)/i.test(SRC));
}

console.log('\n[2] 客户端：回到前台要真的去证一次');
{
  ok('visibilitychange 走的是强制证明 prove(true)',
    /visibilityState === 'visible'\)[\s\S]{0,1200}?prove\(true\)/.test(E2EE));
  ok('不再用 prove(false)（本地「我证过」会把它变成空操作）',
    !/visibilityState === 'visible'\)\s*prove\(false\)/.test(E2EE));
  ok('没有钥匙时不乱发请求', /if \(global\.__dshE2eeSecret\) prove\(true\)/.test(E2EE));
}

console.log('\n[3] 落盘不等于开门：该拦的还要拦');
{
  ok('第三道门仍然按「这台设备证明过没有」判断',
    /if \(REQUIRE_PROOF && dev\.ok && dev\.device && !authProvenAt\(dev\.device\.id\)\)/.test(SRC));
  ok('过期的条目会被清掉（内存 + 磁盘）',
    /Date\.now\(\) - t > AUTH_PROVEN_TTL_MS\) \{ authProven\.delete\(deviceId\); saveAuthProven\(\); return false; \}/.test(SRC));
}

// ── 真网关：一台真设备证明一次 → 文件里出现它；没证明的设备照样 403 ──────────
console.log('\n[4] 真网关（--live 才跑）');
if (!LIVE) {
  skip('真设备证明一次会写进日志文件', '没带 --live');
  skip('没证明的设备仍然 403', '没带 --live');
} else {
  const { proveWith } = require('./proof-helper.js');
  const readLog = (f) => { try { return fs.readFileSync(path.join(BASE, 'logs', f), 'utf8').trim(); } catch (e) { return null; } };
  const HOST = readLog('last-tunnel-url.txt') ? String(readLog('last-tunnel-url.txt')).replace(/^https?:\/\//, '') : 'localhost';
  // ★ 每次跑都要是一个**真的新设备**：网关会按（UA + 来源 IP）复用已有的设备记录，
  //   上一版这两样都写死，于是第二次跑拿到的是上一台「已经证明过」的设备，
  //   「没证明的设备要内容 → 403」那条断言就变成了 200（测试自己制造出的假失败）。
  const IP = `198.51.100.${10 + Math.floor(Math.random() * 200)}`;
  const UA_TAG = 'proof-persist-test/' + Math.random().toString(16).slice(2);
  const req = (pathname, opts) => new Promise((resolve) => {
    const o = opts || {};
    const r = http.request({
      host: '127.0.0.1', port: 8080, method: o.method || 'GET', path: pathname,
      headers: Object.assign({ host: HOST, 'CF-Connecting-IP': IP, 'user-agent': UA_TAG }, o.headers || {})
    }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
    if (o.body) r.write(o.body);
    r.end();
  });

  (async () => {
    const up = await req('/__health').then((r) => r.status !== 0).catch(() => false);
    if (!up) { skip('真设备证明一次会写进日志文件', '网关没在 8080 上跑'); skip('没证明的设备仍然 403', '同上'); return done(); }

    const pair = await req(`/pair?code=${readLog('pair-code.txt')}`);
    const cookies = (pair.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
    const hasDevice = /dsh-gw-session=/.test(cookies);
    ok('配对拿到设备 cookie', pair.status === 200 && hasDevice, `HTTP ${pair.status}`);

    // 还没证明：内容必须被拒
    const refused = await req('/__targets', { headers: { cookie: cookies } });
    ok('没证明的设备要内容 → 403 + need-proof 标记',
      refused.status === 403 && refused.headers['x-dsh-need-proof'] === '1', `HTTP ${refused.status}`);

    const proof = await proveWith((o) => req(o.path, { method: o.method, headers: o.headers, body: o.body }),
      { headers: { cookie: cookies } });
    ok('用钥匙证明成功', proof.ok === true, proof.reason || '');

    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(PROVEN_FILE, 'utf8')); } catch (e) { }
    ok('证明结果写进了 logs/auth-proven.json', !!saved && Object.keys(saved).length > 0,
      saved ? JSON.stringify(saved).slice(0, 80) : '(没有文件)');

    const allowed = await req('/__targets', { headers: { cookie: cookies } });
    ok('证明之后内容放行', allowed.status === 200, `HTTP ${allowed.status}`);
    return done();
  })().catch((e) => { fail++; console.log(`  ✗ 真网关那一段出错：${e.message}`); done(); });
}

function done() {
  console.log(`\n${fail ? `${fail} 处问题` : '全部通过'}（${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}）\n`);
  process.exitCode = fail ? 1 : 0;
}
