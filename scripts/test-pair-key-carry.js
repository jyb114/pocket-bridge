// 「配对完还是进不去」这条的回归测试（2026-09-26 走查发现）。
//
// 走查实录：外网新设备打开完整链接 → 被要求配对 → 配对码输对了、
// 设备身份也发了 → 跳到 / 之后 /__targets **依旧 403**。
// 因为配对码**本来就不带钥匙**（设计如此），而钥匙只在地址的 # 后面 ——
// 表单提交那一刻把它丢了。使用者看到的是「配对成功 → 又让我回电脑复制完整地址」，
// 那个「去配对页」的入口等于白给。
//
// 修法（两端各一半，都不经过服务器）：
//   配对页：提交前把 location.hash 存进 sessionStorage；
//   成功页：落地时如果地址里没有 # 就把存下的那把接回去；
//   需要配对那一页：「去配对页」那颗按钮的链接也带上 #。
//
// 怎么测：这几段都是**页面里的内联脚本**，所以从真网关把页面抓回来
// （外网形状的头，才走得到配对页 / 需要配对页），
// 再把 <script> 抠出来在假 DOM 里真跑一遍 —— 只看字符串在不在是不够的。
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
const PORT = 8080;
const HOST = 'tube-match-around-rob.trycloudflare.com';
const IP = '198.51.100.' + (10 + Math.floor(Math.random() * 200));
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Safari/604.1 sim/' + Math.random().toString(16).slice(2);
const STATIC_ONLY = process.argv.includes('--static-only');

let pass = 0; let fail = 0; let skipped = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); } };
const skip = (n, why) => { skipped++; console.log(`  · ${n}（跳过：${why}）`); };
const readLog = (f) => { try { return fs.readFileSync(path.join(BASE, 'logs', f), 'utf8').trim(); } catch (e) { return null; } };

function get(pathname, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: pathname,
      headers: Object.assign({ host: HOST, 'CF-Connecting-IP': IP, 'user-agent': UA, cookie: o.cookie || '' }, o.headers || {})
    }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
    r.end();
  });
}
const inlineScripts = (html) => {
  const out = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m; while ((m = re.exec(String(html)))) out.push(m[1]);
  return out;
};
/** 在假 DOM 里跑一遍某段内联脚本 */
function runInline(src, sandbox) {
  sandbox.window = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'inline' });
}

console.log('\n[1] 文案：配对页不能再写「每次重启都换」（规则今天已经改了）');
{
  ok('中文不再是旧规则', !/配对码每次重启网关都会更换/.test(SRC) && /配对码不会因为重启而更换/.test(SRC));
  ok('英文不再是旧规则', !/issued every time the gateway restarts/.test(SRC));
  ok('西语不再是旧规则', !/cambia cada vez que se reinicia/.test(SRC));
}

console.log('\n[2] 静态接线：三处钩子都在');
{
  ok('配对页在提交前存下 #', /dsh-pair-hash/.test(SRC) && /addEventListener\('submit'/.test(SRC));
  ok('成功页把 # 接回地址栏',
    /sessionStorage\.getItem\('dsh-pair-hash'\)/.test(SRC) && /location\.replace\(\$\{JSON\.stringify\(dest\)\} \+ h\)/.test(SRC));
  ok('「去配对页」按钮会带上 #', /pairlink/.test(SRC) && /setAttribute\('href', '\/pair' \+ location\.hash\)/.test(SRC));
}

(async () => {
  if (STATIC_ONLY) {
    skip('真网关配对与页面脚本验证', '--static-only：不读取真实配对码或请求 8080');
    return done();
  }
  const key = readLog('access-key.txt');
  const code = readLog('pair-code.txt');

  // ── ① 配对页（外网形状）→ 提交时要把 # 存下来 ──────────────────────────
  console.log('\n[3] 真页面里的内联脚本，在假 DOM 里跑一遍');
  const pair = await get('/pair');
  if (pair.status !== 200) { skip('配对页那一段', `网关没在 ${PORT} 上跑（HTTP ${pair.status}）`); return done(); }
  {
    const handlers = {}; const store = {};
    const form = { addEventListener: (ev, fn) => { handlers[ev] = fn; } };
    const scripts = inlineScripts(pair.body);
    for (const s of scripts) {
      runInline(s, {
        document: { querySelector: (x) => (x === 'form' ? form : null) },
        sessionStorage: { setItem: (k, v) => { store[k] = v; }, getItem: (k) => store[k] || null },
        location: { hash: '#k=THE-KEY-0123456789abcdef' }
      });
    }
    if (typeof handlers.submit !== 'function') fail('配对页没有挂上 submit 处理（钥匙会在提交那一刻丢掉）');
    else {
      handlers.submit();
      ok('配对页：提交时把 # 存进了 sessionStorage',
        store['dsh-pair-hash'] === '#k=THE-KEY-0123456789abcdef', JSON.stringify(store));
    }
  }

  // ── ② 配对成功页（外网形状、正确的码）→ 落地把 # 接回来 ────────────────
  const enter = await get(`/pair?code=${code}`);
  ok('配对成功页拿得到（HTTP 200）', enter.status === 200, `HTTP ${enter.status}`);
  {
    const scripts = inlineScripts(enter.body);
    const calls = [];
    for (const s of scripts) {
      runInline(s, {
        sessionStorage: { getItem: () => '#k=THE-KEY-0123456789abcdef', removeItem: () => { } },
        location: { hash: '', replace: (u) => calls.push(u), href: 'http://x/' }
      });
    }
    ok('配对成功页：地址换成了「/ + 钥匙」',
      calls.length === 1 && calls[0] === '/#k=THE-KEY-0123456789abcdef', JSON.stringify(calls));
  }
  {
    // 地址里本来就带着钥匙时：不许覆盖（别把新的顶掉）
    const scripts = inlineScripts(enter.body);
    const calls = [];
    for (const s of scripts) {
      runInline(s, {
        sessionStorage: { getItem: () => '#k=OLD', removeItem: () => { } },
        location: { hash: '#k=NEW', replace: (u) => calls.push(u), href: 'http://x/#k=NEW' }
      });
    }
    ok('地址里本来就有钥匙时不覆盖', calls.length === 0, JSON.stringify(calls));
  }

  // ── ③ 需要配对那一页：按钮要把 # 带上 ──────────────────────────────────
  //
  // 这一页是「**已经登记、但还没证明**的设备要内容」时给的（例如 /__routes）。
  // ★ 两个前提缺一不可：
  //   · 带 Accept: text/html —— 不带的话网关回的是单行文本
  //     「Access key required…」（那是设备门那一道，不是这一页）；
  //   · 先配对拿到设备 cookie —— 连设备都没有的设备看到的是另一页
  //     （「需要访问密钥」那一页，按钮没有 id="pairlink"）。
  const pairForCookie = await get(`/pair?code=${code}`);
  const cookie = (pairForCookie.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
  const need = await get('/__routes', { cookie, headers: { accept: 'text/html,application/xhtml+xml' } });
  ok('需要配对那一页拿得到（未证明的设备）', need.status === 403 && /id="pairlink"/.test(need.body),
    `HTTP ${need.status}`);
  {
    const scripts = inlineScripts(need.body);
    const attrs = {};
    const link = { setAttribute: (k, v) => { attrs[k] = v; }, hidden: false };
    const p = { hidden: true };
    for (const s of scripts) {
      runInline(s, {
        document: {
          getElementById: (id) => (id === 'pairlink' ? link : id === 'pair' ? p : null),
          querySelector: () => null,
          addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') fn(); },
          readyState: 'complete'
        },
        location: { hash: '#k=THE-KEY-0123456789abcdef', reload: () => { } },
        DshE2EE: { prove: () => Promise.resolve(false), secretSource: () => null },
        sessionStorage: { getItem: () => null, setItem: () => { } },
        setInterval, clearInterval, setTimeout
      });
    }
    // fail() 是异步走完 prove 之后才调的，给它一拍
    await new Promise((x) => setTimeout(x, 300));
    ok('需要配对那一页：「去配对页」链接带上了 #',
      attrs.href === '/pair#k=THE-KEY-0123456789abcdef', JSON.stringify(attrs));
  }

  return done();
})().catch((e) => { fail++; console.log(`  ✗ 出错：${e && e.message}`); done(); });

function done() {
  console.log(`\n${fail ? `${fail} 处问题` : '全部通过'}（${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}）\n`);
  process.exitCode = fail ? 1 : 0;
}
