// 认证边界回归测试。
//
// 这三条都是**实测复现过的真漏洞**（安全审计发现，我逐一复现后才修的），
// 而且都属于「代码看起来没问题、边界却漏了」那一类 —— 不写测试盯着，
// 下次重构很容易再漏回去：
//
//   1. `/codex/file` 的允许范围由请求方的 `?root=` 决定 → 能读整块磁盘
//      （实测读到过 access-key.txt、e2ee-secret.txt、C:\Windows\win.ini）
//   2. WebSocket 升级那条路只有一道门，而且 `hasAuthCookie` 只比 **cookie 名字**
//      → `dsh-auth-x=bogus` 就能换到 101，「注销设备」对实时通道无效
//   3. `/__notify` 用 `isOwnAddress`（只看 socket 来源、不看 Host）
//      → 电脑上任意网页都能让使用者手机弹推送
//
// ★ 这个测试**故意不触发真通知**：它只验「该被拒的确实被拒」。
//   「该放行的确实放行」由 test-devices.js（设备令牌）和 browser-check.js
//   （真浏览器走完整流程）覆盖 —— 那些路径本来就会被跑到，不必在这里再响一次。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const BASE = path.resolve(__dirname, '..');
const KEY = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
const PORT = Number(fs.readFileSync(path.join(BASE, 'logs', 'gateway-port.txt'), 'utf8').trim()) || 8080;
const sessions = require('./sessions.js');
// 假设备也要过第三道门（挑战应答）—— 见 proof-helper.js 开头那段说明
const { proveWith } = require('./proof-helper.js');

// 用合成 Host 模拟「外面的一台手机」：回环直连会被判成本机，
// 那样测不出真实设备的路径（见 test-devices.js 开头的说明）。
const PHONE_HOST = `auth-boundary.invalid:${PORT}`;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) ' +
           'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

function req(pathname, opts = {}) {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: opts.method || 'GET',
      headers: Object.assign({ host: opts.host || PHONE_HOST, 'user-agent': UA },
        opts.headers || {})
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(c).toString('utf8'),
        setCookie: res.headers['set-cookie'] || []
      }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message, setCookie: [] }));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function wsUpgrade(pathname, cookie) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${PHONE_HOST}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        (cookie ? `Cookie: ${cookie}\r\n` : '') + '\r\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]); }
    });
    sock.on('error', (e) => resolve('ERR ' + e.message));
    sock.setTimeout(5000, () => { sock.destroy(); resolve('TIMEOUT ' + buf.split('\r\n')[0]); });
  });
}

(async () => {
  console.log('\n=== 认证边界 · 回归 ===\n');

  const before = sessions.list().length;
  const login = await req(`/k/${KEY}`);
  const cookie = login.setCookie.map((c) => String(c).split(';')[0]).join('; ');
  if (!cookie.includes('dsh-gw-session=')) {
    console.log('  拿不到设备令牌，这个测试需要一台正常设备。跳过。\n');
    process.exitCode = 0;
    return;
  }

  // ★ 先证明自己，再往下测。
  //
  //   2026-09-27 起网关把挑战应答开成真拦：没证明过的设备只拿得到页面和脚本，
  //   内容（/codex/file、票据…）一律 403。真手机是自己在浏览器里算的，测试里的
  //   这台假设备得补上同一步 —— 否则这里测的就不是「边界划得对不对」，
  //   而是「假设备有没有证明」，全红。
  const proof = await proveWith(async (o) => {
    const r = await req(o.path, { method: o.method, headers: o.headers, body: o.body });
    return { status: r.status, body: r.body };
  }, { headers: { cookie } });
  console.log(proof.ok
    ? '[0] 这台假设备已通过挑战应答（内容对它是开放的）\n'
    : `[0] ⚠ 挑战应答没通过（${proof.reason}）—— 下面的内容类断言会因为 403 而失败\n`);

  try {
    // ── 1. /codex/file 的允许范围不能由请求方决定 ──────────────────────────
    console.log('[1] /codex/file 不能读任意文件');

    const logsDir = path.join(BASE, 'logs');
    for (const [name, target, root] of [
      ['访问密钥', path.join(logsDir, 'access-key.txt'), logsDir],
      ['加密密钥', path.join(logsDir, 'e2ee-secret.txt'), logsDir],
      ['系统目录', 'C:\\Windows\\win.ini', 'C:\\Windows']
    ]) {
      const r = await req(`/codex/file?path=${encodeURIComponent(target)}` +
        `&root=${encodeURIComponent(root)}`, { headers: { cookie } });
      ok(`带 ?root= 也读不到${name}`, r.status !== 200, `HTTP ${r.status}`);
    }

    // 正路不能一起堵死：~/.codex 下的文件仍然要能读
    const os = require('os');
    let probeFile = null;
    try {
      const walk = (dir, depth) => {
        if (depth > 2 || probeFile) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (probeFile) return;
          const p = path.join(dir, e.name);
          if (e.isFile() && /\.(json|jsonl|toml|md|txt)$/.test(e.name)) { probeFile = p; return; }
          if (e.isDirectory()) walk(p, depth + 1);
        }
      };
      walk(path.join(os.homedir(), '.codex'), 0);
    } catch (err) { /* 没有就算了 */ }
    if (probeFile) {
      const r = await req(`/codex/file?path=${encodeURIComponent(probeFile)}`,
        { headers: { cookie } });
      ok('正常路径没被一起堵死（~/.codex 下的文件仍可读）', r.status === 200, `HTTP ${r.status}`);
    } else {
      console.log('  · 跳过「正常路径仍可读」：~/.codex 下没找到可测的文件');
    }

    // ── 2. WebSocket 升级要有第二道门，且要比 cookie 的值 ──────────────────
    console.log('\n[2] WebSocket 升级的设备校验');

    const dshOnly = cookie.split('; ').filter((c) => !c.startsWith('dsh-gw-session=')).join('; ');

    const bad = [
      ['不带任何 cookie', ''],
      ['cookie 名对、值乱写', 'dsh-auth-xxxxxxxxxxxxxxxxxxxx=bogus'],
      ['真 DSH cookie + 伪造设备令牌', `${dshOnly}; dsh-gw-session=FORGED.VALUE.HERE`],
      ['真 DSH cookie + 乱格式设备令牌', `${dshOnly}; dsh-gw-session=abc`]
    ];
    for (const [name, c] of bad) {
      const line = await wsUpgrade('/codex/ws', c);
      ok(`WS 拒绝：${name}`, !/101/.test(line), line);
    }

    // 真设备必须能连 —— 否则这次修复就是把功能改坏了
    const good = await wsUpgrade('/codex/ws', cookie);
    ok('WS 放行：真设备能连', /101/.test(good), good);

    // ── 3. /__notify 必须看 Host ───────────────────────────────────────────
    console.log('\n[3] /__notify 的来源判定');

    // 只测「该被拒的」。合法来源那一侧**故意不测** —— 它会让手机真的响，
    // 而这个测试每跑一次回归都会执行。那一路由使用者平时在用，坏了会立刻发现。
    const lanIp = (() => {
      const i = os.networkInterfaces();
      for (const n of Object.keys(i)) {
        for (const x of i[n] || []) if (x.family === 'IPv4' && !x.internal) return x.address;
      }
      return null;
    })();

    if (lanIp) {
      const forged = await req('/__notify?title=x&body=y',
        { host: lanIp, headers: { host: 'evil.example.com' } });
      ok('Host 被换掉时 /__notify 被拒（防 DNS 重绑定/跨站触发）',
        forged.status === 403, `HTTP ${forged.status} ${forged.body.slice(0, 40)}`);
    } else {
      console.log('  · 跳过：这台机器没有内网 IPv4 地址');
    }

    // 顺带守一下口径：这个端点必须用 isLocalRequest，不能用更松的 isOwnAddress
    const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
    const at = src.indexOf("u.pathname === '/__notify'");
    const block = src.slice(at, at + 900);
    ok('/__notify 用的是 isLocalRequest（不是只看来源地址的 isOwnAddress）',
      /isLocalRequest\(req\)/.test(block) && !/!isOwnAddress\(req\)/.test(block),
      block.split('\n').slice(0, 3).join(' | ').slice(0, 100));
    ok('/__notify 有限速（它会真的让手机响）', /notifyRateOk\(\)/.test(block));

    // ── 4. cookie 比较要用时间无关的方式 ───────────────────────────────────
    console.log('\n[4] cookie 值比较');
    ok('hasAuthCookie 比的是完整的值（不是只比名字）',
      /safeEqualStr\(s\.slice\(COOKIE_NAME\.length \+ 1\), COOKIE_VALUE\)/.test(src));
    ok('用的是时间无关比较', /function safeEqualStr/.test(src) && /timingSafeEqual/.test(src));
  } finally {
    // 收尾：把这次测试登记的设备删掉，别留在使用者的列表里
    const added = sessions.list().filter((d) =>
      d.lastIp === '127.0.0.1' && /iPhone/.test(d.label));
    for (const d of added) sessions.remove(d.id);
    const now = sessions.list().length;
    console.log(`\n  收尾：删掉测试造的 ${added.length} 条记录，设备数 ${before} → ${now}`);
    if (now !== before) { fail++; console.log('  ✗ 设备数没还原'); }
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
