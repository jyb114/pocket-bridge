// DSH 移动端网关 — 安全审计
//
// 原则：不把「代码里写了检查」当成安全，而是真的发请求去试。
//
// 覆盖：
//   · 未认证访问（无密钥 / 错误密钥 / 无 cookie）
//   · 路径遍历与编码绕过
//   · 敏感端点的访问控制（含从局域网发起）
//   · Host / Origin / 伪造头
//   · 静态资源是否泄露信息
//   · 「别人不知道网址」这个前提能提供多少保护
//
// 用法：node security-audit.js [--quick]
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const cfg = require('./config.js');

const BASE = cfg.BASE;
const LOG_DIR = cfg.LOG_DIR;
const QUICK = process.argv.includes('--quick');

const findings = [];
function finding(severity, title, detail) {
  // severity: ok | info | low | medium | high
  findings.push({ severity, title, detail });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, options = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? require('https') : http;
    const req = mod.request(url, {
      method: options.method || 'GET',
      timeout: options.timeout || 8000,
      headers: options.headers || {}
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function readLog(name) {
  try { return fs.readFileSync(path.join(LOG_DIR, name), 'utf8').trim(); }
  catch (err) { return null; }
}

async function findGateway() {
  for (let p = 8080; p <= 8099; p++) {
    const r = await request(`http://127.0.0.1:${p}/__health`, { timeout: 1200 });
    if (r && r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        if (j.service === 'pocket-bridge-gateway') return { port: p, info: j };
      } catch (err) { /* 不是我们的服务 */ }
    }
  }
  return null;
}

// ── ① 未认证访问 ──────────────────────────────────────────────────────────────
async function auditUnauthenticated(port, key) {
  const paths = [
    '/', '/api/remote.mux', '/assets/index.js', '/pair',
    '/__push/vapid', '/__push/subscribe',
    '/k/', '/k', '/k/wrong', '/k/' + 'x'.repeat(200)
  ];
  const leaked = [];

  // 设计上就公开的路径。**每一条都要写明理由**，不然这份名单迟早会变成
  // 「把报错的东西塞进来让它别响」的垃圾桶 —— 那就等于把审计废掉了。
  const publicByDesign = {
    '/pair': '配对页本身。手机还没有任何凭证时就要能打开它输配对码',
    // /assets/ 是 DSH 打包好的前端 JS/CSS（构建产物，不含使用者的任何数据）。
    // 2026-09 放行的，起因是实测到
    //     403 无会话 cookie: GET /assets/vendor-CCJJTK99.js
    // 一个资源被挡、依赖它的整块界面就起不来，表现为「加载半天」。
    // 它们和早就公开的 /polyfill.js、/custom.css 同类：是**代码**，不是内容。
    // 真正的内容（/api/**、/codex/**、/__console/**）照旧要两道门。
    '/assets/index.js': '/assets/ 是 DSH 的前端构建产物，不含使用者数据（详见上方说明）'
  };

  for (const p of paths) {
    const r = await request(`http://127.0.0.1:${port}${p}`, { timeout: 6000 });
    if (!r) { leaked.push(`${p} → 请求失败`); continue; }
    if (publicByDesign[p]) continue;
    if (r.status !== 403) {
      leaked.push(`${p} → HTTP ${r.status}（期望 403）`);
    }
  }
  if (leaked.length === 0) {
    finding('ok', '未认证访问全部被拦',
      `${paths.length} 条路径，除 ${Object.keys(publicByDesign).join(' / ')} 这些设计上公开的之外均返回 403`);
  } else {
    finding('high', '存在未认证访问的路径', leaked.join('; '));
  }
}

// ── ② 路径遍历与编码绕过 ──────────────────────────────────────────────────────
async function auditTraversal(port) {
  const probes = [
    '/../../logs/access-key.txt',
    '/..%2f..%2flogs%2faccess-key.txt',
    '/%2e%2e%2f%2e%2e%2flogs%2faccess-key.txt',
    '/polyfill.js/../../logs/mint-cookie.json',
    '/./../../logs/access-key.txt',
    '/k/../logs/access-key.txt',
    '/__health/../../logs/access-key.txt'
  ];
  const bad = [];
  for (const p of probes) {
    const r = await request(`http://127.0.0.1:${port}${p}`, { timeout: 6000 });
    if (!r || !r.body) continue;
    // 判断标准很直接：有没有把不该给的东西吐回来
    if (r.body.includes('dsh-auth-')) bad.push(`${p} 泄露了 cookie 记录`);
    if (/sk-[a-zA-Z0-9]{16,}/.test(r.body)) bad.push(`${p} 泄露了 API key`);
    if (r.body.includes('client-connection/browser-session')) bad.push(`${p} 泄露了凭据文件内容`);
  }
  // 顺带确认静态资源白名单之外的文件取不到
  const extra = await request(`http://127.0.0.1:${port}/config.js`, { timeout: 6000 });
  if (extra && extra.status === 200 && extra.body.includes('detectNetwork')) {
    bad.push('/config.js 可以被直接读取');
  }

  if (bad.length === 0) {
    finding('ok', '路径遍历探测未成功', `${probes.length} 种遍历/编码写法都没能读到服务端文件`);
  } else {
    finding('high', '路径遍历可以读到文件', bad.join('; '));
  }
}

// ── ③ 敏感端点的访问控制 ──────────────────────────────────────────────────────
async function auditSensitiveEndpoints(port, lanIp) {
  const results = [];

  // 回环应当可用
  for (const p of ['/__health', '/__notify?title=audit&body=x']) {
    const r = await request(`http://127.0.0.1:${port}${p}`, { timeout: 12000 });
    results.push(`回环 ${p.split('?')[0]} → ${r ? r.status : '失败'}${r && r.status === 200 ? ' ✓' : ' ✗'}`);
  }

  // 局域网来源的 /__health 应当被拒
  if (lanIp) {
    const r = await request(`http://${lanIp}:${port}/__health`, { timeout: 8000 });
    results.push(`局域网 /__health → ${r ? r.status : '失败'}${r && r.status === 403 ? ' ✓' : ' ✗'}`);
  }

  // /__notify 的判据是「来源是不是本机地址」，而审计就跑在本机 ——
  // 无论连回环还是连自己的内网 IP，来源都是本机，所以**必然**通过。
  // 这条既不能算漏洞也不能算通过，它压根测不出结论。真正要验的是判据本身：
  // 拿一个不属于本机的地址去问它，必须返回否。
  let predicateOk = false;
  let predicateDetail = '';
  try {
    const cfgMod = require('./config.js');
    const foreign = ['203.0.113.7', '198.51.100.9', '2001:db8::1', '192.168.99.99'];
    const own = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
    const foreignRejected = foreign.every((a) => cfgMod.isOwnAddress(a) === false);
    const ownAccepted = own.every((a) => cfgMod.isOwnAddress(a) === true);
    predicateOk = foreignRejected && ownAccepted;
    predicateDetail = `外部地址一律被拒=${foreignRejected}　本机地址被认=${ownAccepted}`;
  } catch (err) {
    predicateDetail = `验不了: ${err.message}`;
  }
  results.push(`/__notify 的本机判据 → ${predicateOk ? '正确 ✓' : '有问题 ✗'}（${predicateDetail}）`);

  // Web Push 订阅端点需要认证
  const pushVapid = await request(`http://127.0.0.1:${port}/__push/vapid`, { timeout: 6000 });
  results.push(`未认证 /__push/vapid → ${pushVapid ? pushVapid.status : '失败'}${pushVapid && pushVapid.status === 403 ? ' ✓' : ' ✗'}`);

  const pushSub = await request(`http://127.0.0.1:${port}/__push/subscribe`, {
    method: 'POST', timeout: 6000, body: '{}'
  });
  results.push(`未认证 /__push/subscribe → ${pushSub ? pushSub.status : '失败'}${pushSub && pushSub.status === 403 ? ' ✓' : ' ✗'}`);

  const allOk = results.every((r) => r.includes('✓'));
  finding(allOk ? 'ok' : 'high', '敏感端点访问控制', results.join('  '));
}

// ── ④ Host / Origin 伪造 ─────────────────────────────────────────────────────
async function auditHeaderSpoofing(port, key) {
  const results = [];

  // 伪造 Host：中间层自己会固定 Host，所以伪造不该影响上游
  const fakeHost = await request(`http://127.0.0.1:${port}/`, {
    timeout: 8000, headers: { host: 'evil.example.com' }
  });
  results.push(`伪造 Host → HTTP ${fakeHost ? fakeHost.status : '失败'}`);

  // 伪造 Origin 指向外部域名 —— 中间层会改写它，不该造成越权
  const fakeOrigin = await request(`http://127.0.0.1:${port}/k/${key}`, {
    timeout: 8000, headers: { origin: 'https://evil.example.com' }
  });
  results.push(`伪造 Origin → HTTP ${fakeOrigin ? fakeOrigin.status : '失败'}`);
  if (fakeOrigin && fakeOrigin.headers['set-cookie']) {
    results.push('（注：带密钥时本就会种 cookie，属预期）');
  }

  // 带密钥但尝试用恶意 Host 访问 API
  const apiSpoof = await request(`http://127.0.0.1:${port}/api/__probe`, {
    timeout: 8000, headers: { host: 'evil.example.com', origin: 'https://evil.example.com' }
  });
  results.push(`伪造头访问 /api → HTTP ${apiSpoof ? apiSpoof.status : '失败'}`);

  finding('info', '头部伪造探测', results.join('  '));
}

// ── ⑤ 静态资源是否泄露信息 ────────────────────────────────────────────────────
async function auditStaticLeak(port) {
  const files = ['/polyfill.js', '/compat.js', '/boot.js', '/sw.js', '/manifest.webmanifest'];
  const suspicious = [];
  const key = readLog('access-key.txt');
  for (const f of files) {
    const r = await request(`http://127.0.0.1:${port}${f}`, { timeout: 6000 });
    if (!r || r.status !== 200) continue;
    // 这些文件是公开的，所以必须确认它们不含任何机密
    if (key && r.body.includes(key)) suspicious.push(`${f} 含访问密钥`);
    if (r.body.includes('dsh-auth-')) suspicious.push(`${f} 含 cookie 名或值`);
    if (/sk-[a-zA-Z0-9]{16,}/.test(r.body)) suspicious.push(`${f} 含 API key`);
  }

  if (suspicious.length === 0) {
    finding('ok', '公开静态资源不含机密', `${files.length} 个公开文件均无密钥/cookie 内容`);
  } else {
    finding('high', '公开静态资源可能泄露机密', suspicious.join('; '));
  }
}

// ── ⑥ 「不知道网址」能提供多少保护 ───────────────────────────────────────────
async function auditObscurityValue(port) {
  const notes = [];

  // 无密钥时是否泄露任何可识别信息
  const r = await request(`http://127.0.0.1:${port}/`, { timeout: 6000 });
  if (r && r.status === 403) {
    notes.push(`未认证返回的内容: "${r.body.trim().slice(0, 80)}"`);
    if (r.body.includes('DSH') || r.body.includes('pocket-bridge')) {
      notes.push('⚠ 403 页面暴露了服务身份（别人扫到就知道这里是什么）');
    }
  }

  // 隧道地址本身是随机的，但服务标识可被识别
  const health = await request(`http://127.0.0.1:${port}/__health`, { timeout: 5000 });
  if (health && health.status === 200) {
    notes.push('/__health 会返回实例 ID 与 DSH 端口（仅回环，外网取不到）');
  }

  finding('info', '「网址保密」的实际保护程度', notes.join('  '));
}

// ── ⑦ 已知风险（不是测试出来的，是设计事实）──────────────────────────────────
function reportDesignRisks() {
  finding('medium', '访问密钥出现在 URL 路径里',
    '首次进入用 /k/<key>，这个路径会进入浏览器历史、书签同步，以及 Cloudflare 的访问日志' +
    '（Cloudflare 是 TLS 终止点，能看到完整路径）。配对码同理。' +
    '已做的缓解：① 入口现在是 302 服务端跳转，带密钥的地址不会被渲染、不在屏幕上停留，' +
    '地址栏立刻变成 /；② 全站 Referrer-Policy: no-referrer，密钥不会顺着 Referer 漏给外部资源；' +
    '③ 进过一次后改用 cookie，不再走 URL；④ 换连接方式走 60 秒一次性票据；⑤ 密钥可轮换。' +
    '仍未消除：密钥本身就在路径里，能同时看到 URL 与访问日志的人（Cloudflare、浏览器同步、截图）' +
    '依然拿得到。彻底解决要改成「一次性入口 + 短票据」，代价是手机书签不能长期有效。');

  // 「内网是明文 HTTP」这一条不写在这里 —— 它取决于实际配置（开着还是关着），
  // 所以由上面的动态检查给结论。写死一句「是明文」会在开了 HTTPS 之后
  // 和动态结论互相矛盾，那种自相矛盾的审计报告比没有报告更糟。

  finding('low', 'cookie 没有 Secure 标记',
    '这是有意为之 —— 加了 Secure 内网 HTTP 就用不了。' +
    '外网经 HTTPS 时浏览器仍会发送该 cookie，只是缺少额外一层约束。');

  // 下面几条不凭印象写，而是真的去查代码和文件 —— 修好了就该显示修好了
  let hasPairRateLimit = false;
  let hasRotateTool = false;
  let hasDeviceTokens = false;
  let hasRouteTickets = false;
  try {
    const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
    hasPairRateLimit = src.includes('PAIR_MAX_FAILURES') && src.includes('pairRateCheck');
    hasDeviceTokens = src.includes('dsh-gw-session') && src.includes('ensureDevice');
    hasRouteTickets = src.includes('mintTicket') && src.includes('redeemTicket');
  } catch (err) { /* 读不到就是没有 */ }
  try {
    hasRotateTool = fs.existsSync(path.join(BASE, 'scripts', 'rotate-key.js'));
  } catch (err) { /* 同上 */ }

  finding(hasPairRateLimit ? 'ok' : 'medium', '配对码暴力枚举防护',
    hasPairRateLimit
      ? '已限速：同一来源连续失败 5 次锁定 15 分钟（PAIR_MAX_FAILURES / PAIR_LOCK_MS）'
      : '未发现限速逻辑 —— 6 位数字的配对码理论上可以被慢慢枚举出来');

  finding(hasRotateTool ? 'ok' : 'medium', '访问密钥轮换能力',
    hasRotateTool
      ? '有 rotate-key.js：可单独更换访问密钥（已配对设备不受影响）；' +
        '加 --revoke-sessions 还能一并作废所有设备的登录态'
      : '没有轮换工具，密钥一旦泄露只能手工处理');

  finding(hasDeviceTokens ? 'ok' : 'medium', '设备级身份与单独吊销',
    hasDeviceTokens
      ? '每台设备有独立令牌（dsh-gw-session），可在控制台或 scripts/devices.js 里单独注销；' +
        '注销一台不影响其他设备。注意：这管的是「已配对的设备」，要连根锁门仍需轮换访问密钥。'
      : '没有设备级令牌 —— 任何拿到密钥的人都是一个不具名的访客，丢了手机只能整体轮换');

  finding(hasRouteTickets ? 'ok' : 'low', '换路径不暴露长期密钥',
    hasRouteTickets
      ? '手机切换连接方式走一次性票据（60 秒有效、用一次即废、绑定目标地址），' +
        '不会把长期密钥写进新地址的 URL'
      : '未发现票据机制 —— 换路径时可能需要重新在 URL 里带上长期密钥');

  // ── 两者都先去查实际状态，再下结论，不凭印象 ──────────────────────────────
  let lanHttpsOn = false;
  let certOk = false;
  try {
    const conf = require('./config.js').loadConfig();
    lanHttpsOn = !!(conf.lanHttps && conf.lanHttps.enabled);
    const info = require('./make-cert.js').inspect();
    certOk = !!(info.present && !info.broken && !info.expired);
  } catch (err) { /* 读不到就当没开 */ }

  finding(lanHttpsOn && certOk ? 'ok' : 'medium', '内网入口的传输加密',
    lanHttpsOn && certOk
      ? '已开启内网 HTTPS：同一 WiFi 下的被动嗅探看不到会话内容。' +
        '注意它是自签证书 —— 挡得住被动嗅探，挡不住能主动劫持网络的人'
      : '内网是明文 HTTP：同一 WiFi 下的任何设备都能嗅探到会话 cookie 与内容。' +
        '缓解：在本地控制台里一键开启内网 HTTPS（自签证书，手机首次访问提示一次）');

  // 二维码是用公共接口画的，图里的内容会离开这台机器。
  //
  // ★ 2026-09-26 修正：二维码**已经从控制台删掉了**（连带 api.qrserver.com 这个
  //   唯一的外链），所以这条现在是「已通过」。原来的判据是去找控制台里那两句文案
  //   （e.pairPage / 把链接内容发给第三方服务）—— 文案删了之后它就一直报「低危」，
  //   也就是**一个假警报**：报告上永远挂着一项本来不存在的问题。
  //   新判据：控制台里不再有任何会向第三方发请求的图片/脚本引用才算通过
  //   （注释里提到 qrserver 不算 —— 那是在解释「为什么删掉」）。
  let qrLeaks = false;
  let qrNote = '控制台不再有二维码，也没有任何外链图片/脚本（整个项目不外联）';
  try {
    const html = fs.readFileSync(path.join(BASE, 'pwa', 'console.html'), 'utf8');
    const live = html.replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    qrLeaks = /qrserver|chart\.googleapis|api\.qr|<img[^>]+src=["']https?:/i.test(live);
    if (qrLeaks) qrNote = '控制台里还有会向外发请求的图片/脚本';
  } catch (err) { /* 读不到就不下结论 */ }
  finding(qrLeaks ? 'low' : 'ok', '二维码 / 第三方外链',
    qrLeaks
      ? qrNote
      : qrNote);
}

// ── 输出 ──────────────────────────────────────────────────────────────────────
function print() {
  const icon = { ok: '[通过]', info: '[信息]', low: '[低]  ', medium: '[中]  ', high: '[高]  ' };
  const line = '='.repeat(72);
  process.stdout.write(`\n${line}\n  DSH 移动端网关 — 安全审计\n${line}\n\n`);

  const order = { high: 0, medium: 1, low: 2, info: 3, ok: 4 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of sorted) {
    process.stdout.write(`${icon[f.severity]} ${f.title}\n`);
    process.stdout.write(`        ${f.detail}\n\n`);
  }

  const high = findings.filter((f) => f.severity === 'high').length;
  const medium = findings.filter((f) => f.severity === 'medium').length;
  process.stdout.write(`${line}\n`);
  process.stdout.write(`  高危 ${high} 项   中危 ${medium} 项   其余为信息与已通过项\n`);
  process.stdout.write(`${line}\n`);

  try {
    fs.writeFileSync(path.join(LOG_DIR, 'security-audit.json'),
      JSON.stringify({ ranAt: new Date().toISOString(), findings }, null, 2), 'utf8');
    process.stdout.write(`  结果已存: ${path.join(LOG_DIR, 'security-audit.json')}\n`);
  } catch (err) { /* 忽略 */ }
  process.stdout.write('\n');
}

(async () => {
  const gw = await findGateway();
  if (!gw) {
    process.stdout.write('中间层没在运行，无法审计。请先运行 start-gateway。\n');
    process.exitCode = 1;
    return;
  }

  const key = readLog('access-key.txt');
  const net = cfg.detectNetwork();
  const lanIp = net.lanV4.length ? net.lanV4[0].address : null;

  process.stdout.write(`审计目标: 127.0.0.1:${gw.port}（DSH 后端 ${gw.info.dshPort}）\n`);

  await auditUnauthenticated(gw.port, key);
  await auditTraversal(gw.port);
  await auditSensitiveEndpoints(gw.port, lanIp);
  if (!QUICK) await auditHeaderSpoofing(gw.port, key);
  await auditStaticLeak(gw.port);
  await auditObscurityValue(gw.port);
  reportDesignRisks();
  print();
})();
