#!/usr/bin/env node
/**
 * 回归测试：交给使用者的地址必须带加密密钥（#k=…）
 *
 * 为什么要有这个文件
 * ------------------
 * 服务端的实时通道有一道门：**经中继 + 配了长期密钥 + 请求里没有 e2ee=1
 * → 拒绝升级，不降级发明文**。而 e2ee.js 只在页面 hash 里有 `#k=` 的时候
 * 才会自动补上那个 `e2ee=1`。
 *
 * 于是「地址里少一段 #k=」的后果不是「降级成明文」，而是**连接直接被掐掉**：
 * 手机打开链接、登录也成功、页面也出来了，但 `/api/remote.mux` 那条 WebSocket
 * 被自家网关 403 掉 —— 使用者看到的就是「登录了，可一个对话都没有」。
 * 日志里留的是一串「WS 被拒：经中继但没要求加密（拒绝明文，不降级）」。
 *
 * 这个坑真的漏出去过，而且是**两个不同的地方**同时漏：
 *   1. routes.js  —— 控制台「复制手机地址」按钮复制的候选地址
 *   2. gateway-daemon.js —— 守护进程写的 status.json，connect.js 会念给使用者
 * 两边漏的原因还不一样，所以光修一处不够，得拿测试把两条路都钉住。
 *
 * 最后一条是**静态护栏**：那两个写入者将来谁再手搓一次 `/k/${key}` 就会红。
 */
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');
const routes = require('./routes.js');

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : '  → ' + detail}`);
  if (!ok) failed++;
  return ok;
}

const SECRET = 'TEST-SECRET-abcdefghijklmnop';
const KEY = 'TESTKEY12345';

function netStub() {
  return { lanV4: [{ address: '192.168.1.3', iface: 'WLAN' }], publicV6: [] };
}

console.log('\n【地址必须带加密密钥】');

// ── 1. 配了加密：每条候选地址都要带上 #k= ────────────────────────────────
{
  const list = routes.enumerate({
    port: 8080,
    httpsPort: 8081,
    key: KEY,
    secret: SECRET,
    lang: 'zh',
    tunnelUrl: 'https://demo.trycloudflare.com',
    ipv6Listening: false,
    netInfo: netStub()
  });

  check('候选地址至少有一条（不然下面的断言都是空的）', list.length > 0, `实际 ${list.length} 条`);

  for (const c of list) {
    let hash = null;
    try { hash = new URL(c.url).hash; } catch (err) { /* 下面报出来 */ }
    check(`${c.kind} 的地址带 #k=`, hash === `#k=${SECRET}`, `${c.url} 解析出的 hash=${hash}`);
  }
}

// ── 2. 没配加密：不能凭空造一个 #k= 出来 ────────────────────────────────
{
  const list = routes.enumerate({
    port: 8080,
    key: KEY,
    lang: 'zh',
    tunnelUrl: null,
    ipv6Listening: false,
    netInfo: netStub()
  });
  check('没配加密时不能凭空加 #k=',
    list.every((c) => !c.url.includes('#k=')),
    list.map((c) => c.url).join(' | '));
}

// ── 3. 静态护栏：谁再造不含 #k= 的 /k/ 地址就红 ──────────────────────────
//
//    只看「把地址交给使用者」的那几个文件。判定很直白：一行里出现 `/k/${`
//    就必须同时出现 #k= 或者负责拼它的 frag/kfrag 变量 —— 例外只有
//    routes.js 里那个 suffix 定义（它只是个后缀，frag 在使用处补）。
{
  const FILES = ['routes.js', 'gateway-daemon.js', 'connect.js', 'mobile-proxy.js'];
  const offenders = [];

  for (const f of FILES) {
    const abs = path.join(BASE, 'scripts', f);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch (err) { continue; }

    src.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      // 注释里会**引用**这个坏写法讲历史（"这里原来是 /k/${ACCESS_KEY} 就完了"），
      // 那是文档不是代码 —— 不排掉就会把注释判成违规，测试从此没人信。
      if (/^(\/\/|\*|\/\*)/.test(t)) return;
      if (!/\/k\/\$\{/.test(line)) return;                       // 不含 /k/${...}
      if (/#k=|frag/.test(line)) return;                          // 自己就带上了
      if (/const\s+suffix\s*=/.test(line)) return;                // 例外：纯后缀定义
      offenders.push(`${f}:${i + 1}  ${t}`);
    });
  }

  check('没有手搓出缺 #k= 的 /k/ 地址', offenders.length === 0,
    offenders.length ? '\n      ' + offenders.join('\n      ') : '');
}

// ── 4. status.json 那条路：守护进程写出来的也得带 ────────────────────────
//
//    这条是行为断言，不是静态的 —— 直接读现场那份文件。
//
//    但有个前提必须说清楚：status.json 只有**守护进程真的跑过一次**才会更新，
//    而跑守护进程有重建隧道的风险（地址一变，使用者的书签就废了）。所以这里拿
//    「文件比守护进程的代码还旧」来判定证据失效：那份文件是修复之前写的，
//    它绿不了也红不了，只能记一条提示。否则这条断言会长期假红，红了就没人看了。
{
  const st = path.join(BASE, 'logs', 'status.json');
  const daemonSrc = path.join(BASE, 'scripts', 'gateway-daemon.js');

  let j = null;
  let fresh = false;
  try {
    j = JSON.parse(fs.readFileSync(st, 'utf8'));
    fresh = fs.statSync(st).mtimeMs > fs.statSync(daemonSrc).mtimeMs;
  } catch (err) { /* 没有或读不动 */ }

  let liveSecret = '';
  try { liveSecret = fs.readFileSync(path.join(BASE, 'logs', 'e2ee-secret.txt'), 'utf8').trim(); } catch (err) { /* 没配 */ }

  if (!j || !j.entries) {
    console.log('  · status.json 里没有 entries，跳过现场检查（不算通过）');
  } else if (!liveSecret) {
    console.log('  · 本机没配加密密钥，跳过现场检查（不算通过）');
  } else if (!fresh) {
    console.log('  · status.json 比守护进程的代码还旧 —— 是修复前的产物，'
      + '等守护进程下次自然跑过再看（不算通过，也不算失败）');
  } else {
    const urls = [...(j.entries.lan || []), j.entries.wan].filter(Boolean);
    // 必须是**恰好一份**。#k= 出现两次（`#k=旧#k=新`）时浏览器把 `#` 之后整段
    // 都当 fragment，e2ee.js 解出来的密钥是错的 —— 手机会连不上，而不是降级成明文。
    check('现场 status.json 的地址都带且只带一份 #k=',
      urls.length > 0 && urls.every((u) => (u.match(/#k=/g) || []).length === 1),
      urls.map((u) => `${u}  (#k= ×${(u.match(/#k=/g) || []).length})`).join(' | '));
  }
}

// ── 5. 边界：密钥只给回环，不给手机 ─────────────────────────────────────
//
//    这条守的是**安全**，不是功能。手机不需要这个字段（它手里的链接本来就带
//    #k=，换路径时 route.js 会自己补 hash），而 /__routes 手机拿得到 ——
//    一旦密钥从这里出去，泄露一个设备 cookie 就等于连解密能力一起送出去。
{
  const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');

  const field = src.match(/secret:\s*([^,\n]+),/);
  check('routeContext 的 secret 走回环判断',
    !!field && /loopback/.test(field[1]),
    field ? `实际写成: ${field[1].trim()}` : '没找到 secret 字段');

  // 调用处按**行**看：routeContext( … ACCESS_KEY … ) 那一行必须同时出现
  // isLoopback(req)。用正则去抠参数列表会被嵌套括号骗到（pickLang(req) 里
  // 那个 ) 会把匹配提前截断），所以这里不抠参数，直接看整行。
  const callLines = src.split(/\r?\n/)
    .filter((l) => /routeContext\s*\(/.test(l) && /ACCESS_KEY/.test(l) && !/^\s*(function|\/\/|\*)/.test(l));
  check('routeContext 的每个调用处都传了 isLoopback(req)',
    callLines.length > 0 && callLines.every((l) => /isLoopback\s*\(\s*req\s*\)/.test(l)),
    callLines.length ? callLines.map((l) => l.trim()).join('  |  ') : '一个调用处都没找到');
}

// ── 6. 双份 #k= —— 一个生产者、多个消费者各自追加的后果 ─────────────────
//
//    status.json 里的地址**本身带 #k=**（控制台和守护进程写的那两份都带），
//    而 rotate-e2ee.js / connect.js 都会再往后拼一次自己的 #k=。不先切掉已有的
//    fragment 就会得到 `#k=旧#k=新`。这一条钉住那两个追加点必须先切。
{
  // 先自检断言本身有效：构造一个双份的地址，计数必须能看出来是 2
  const doubled = 'https://x.trycloudflare.com/k/KEY#k=AAA#k=BBB';
  check('计数断言本身能识破双份 #k=', (doubled.match(/#k=/g) || []).length === 2,
    `实际数到 ${(doubled.match(/#k=/g) || []).length}`);

  for (const f of ['rotate-e2ee.js', 'connect.js']) {
    const src = fs.readFileSync(path.join(BASE, 'scripts', f), 'utf8');
    check(`${f} 追加 #k= 前会先切掉已有 fragment`,
      /\.replace\(\s*\/#\.\*\$\//.test(src),
      '文件里找不到 replace(/#.*$/, ...) —— 追加前没切 fragment');
  }
}

// ── 7. 换地址的空窗期里，任何复制入口都必须被挡住 ────────────────────────
//
//    服务端重建隧道是异步的，点完到新地址可用有 15~20 秒。这段时间 entries 里
//    还是旧域名 —— 复制出去就是死链。
//
//    这条断言是拿一次真实返工换来的：第一版只把首页那个大按钮禁掉了，而每张
//    入口卡片上还各有一个「复制链接」，仍能复制到旧地址。
{
  const src = fs.readFileSync(path.join(BASE, 'pwa', 'console.html'), 'utf8');

  const at = src.indexOf('function copy(');
  const end = src.indexOf('\nfunction ', at + 1);
  const body = at < 0 ? '' : src.slice(at, end < 0 ? src.length : end);
  check('copy() 自己在换地址期间会拒绝复制（唯一的出口）',
    /addressChanging/.test(body),
    'copy() 里没有 addressChanging 判断 —— 卡片上的「复制链接」会漏过去');

  // 不许有绕过 copy() 直接写剪贴板的地方，否则它就是第二个出口。
  // 注意别只数关键字：copy() 内部本来就有一处能力检测 + 一处真调用，
  // 按「全文件的处数 == copy() 内的处数」比才对（第一版按绝对数比，误报过一次）。
  const total = (src.match(/\.writeText\s*\(/g) || []).length;
  const inside = (body.match(/\.writeText\s*\(/g) || []).length;
  check('所有写剪贴板的地方都在 copy() 里（没有第二个出口）',
    total > 0 && total === inside, `全文件 ${total} 处，其中 copy() 里 ${inside} 处`);
}

// ── 8. 不许把服务端点当成隧道地址 ──────────────────────────────────────
//
//    cloudflared 申请隧道失败时，报错正文里带的是 API 端点：
//        Post "https://api.trycloudflare.com/tunnel": context deadline exceeded
//    而原来的模式是 [a-z0-9-]+\.trycloudflare\.com —— `api` 照样匹配。
//    于是「申请失败」被当成「拿到地址」：日志写「✓ 隧道就绪」、status.json
//    存下这个垃圾地址、还把「新地址」推送给了手机。
//    使用者点开那个链接到的是 Cloudflare 的 API，不是自己的电脑。
{
  const tunnel = require('./tunnel.js');
  const cases = [
    ['https://hybrid-store-blink-locations.trycloudflare.com', true],
    ['Post "https://api.trycloudflare.com/tunnel": context deadline exceeded', false],
    ['https://www.trycloudflare.com', false],
    ['https://dash.trycloudflare.com', false],
    ['https://xxxx.ngrok-free.app', true]
  ];
  const wrong = cases.filter(([txt, want]) => (tunnel.extractPublicUrl(txt) !== null) !== want);
  check('隧道地址解析器不会把 api/www/dash 这些服务主机当地址',
    wrong.length === 0,
    wrong.map(([txt, want]) => `want=${want} got=${JSON.stringify(tunnel.extractPublicUrl(txt))} <- ${txt.slice(0, 60)}`).join(' | '));
}

console.log(failed === 0
  ? '\n结论: 地址都带着加密密钥 —— 这条链是通的。\n'
  : `\n结论: ${failed} 项不通过 —— 使用者会拿到一条「能打开、但看不到对话」的地址。\n`);

process.exitCode = failed === 0 ? 0 : 1;
