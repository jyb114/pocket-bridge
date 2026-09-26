#!/usr/bin/env node
/**
 * 场景化健壮性测试 —— 穷尽模拟使用者真实会走的路径
 * ============================================================================
 *
 * 这个文件要抓的**不是**「某个函数返回错了」，而是同一类反复出现过的毛病：
 *
 *     一个功能产出的东西，被另一个功能拒绝或误解，而且全程静默。
 *
 * 已经栽过的四个都是这一类（见 test-address-key.js / test-tunnel-single.js）：
 *   1. 控制台复制出的地址缺 `#k=` → 网关 WS 的「拒绝明文」闸门 403 →
 *      手机页面能开、登录成功、对话列表永远空，界面上没有一个字。
 *   2. 「更换临时地址」后服务端是异步重建隧道的 → 这段空窗期复制出去的是
 *      「旧域名 + 旧密钥」的死链。
 *   3. cloudflared 申请失败时把报错正文里的 `https://api.trycloudflare.com/tunnel`
 *      当成了隧道地址 → 程序报「✓ 隧道就绪」并把假地址推给手机。
 *   4. route.js 自动把手机切到没信任过证书的内网 HTTPS → 一整页证书错误。
 *
 * 所以这里的每一段都是**一条使用者会走的完整路径**，而不是一次函数调用。
 *
 * ---------------------------------------------------------------------------
 * 跑完之后发现的新问题（都是真跑出来的，不是读代码猜的）
 * ---------------------------------------------------------------------------
 *
 * ★★★ [严重 · 已被本文件测出并已修复] 控制台整个管理面暴露在公网
 *     —— `isLoopback` 把「隧道转发进来的请求」当成了「本机」
 *
 *     这个文件第一次跑出来就是红的（2026-09-22，修复前），现场证据（只读 GET，
 *     经**真实公网隧道地址**，不带任何 cookie，手机 UA）：
 *       GET  https://<隧道域名>/__console/status  → 200
 *            正文里同时含 logs/e2ee-secret.txt 与 logs/access-key.txt 的原文，
 *            外加设备列表、目标列表、日志尾部。
 *       GET  https://<隧道域名>/console           → 200（管理界面公网可读）
 *       POST https://<隧道域名>/__console/action  → 200 {"ok":false,"message":"未知操作"}
 *            这句话是处理器**跑过回环判断之后**才产生的 —— 写入端点同样公网可达，
 *            匿名者可以驱动 refresh-tunnel / rotate-e2ee / 清本机记录。
 *       GET  https://<隧道域名>/__health          → 200（次要：泄露端口与 instanceId）
 *     对照：/__routes、/go、/ 走的是 `hasAuthCookie` 那道门 → 403，正常。
 *
 *     根因：`mobile-proxy.js:1676 isLoopback(req)` 只看 `req.socket.remoteAddress`，
 *     而**隧道流量永远从 127.0.0.1 进来**（cloudflared 是另一个进程，连的是回环）。
 *     拿到那份 status 就等于拿到访问密钥（完整登录权）＋ 加密密钥（端到端加密失效）。
 *     已修（commit d3ec7fd）：`isLoopback` 末尾改成 `return !viaRelay(req);`。
 *     本文件现在钉的是**两个方向**：经中继/非回环一律 403（E2 第③组），
 *     本机回环必须仍然 200 可用（E2 第①组）—— 修安全不能把合法用途一起锁死。
 *     「这条断言真的能红」由 `--red-check` 的 L1/L2 现场证明（见下）。
 *
 * ★★ [中 · 仍然红] 「我要加密」有两种记号，闸门与产出方各认一个，
 *     谁都不知道对方不认 —— 于是「明文不许交给中继」这条底线可以被绕过
 *
 *     现场复现（Host 是隧道域名 = 经中继，带合法会话，2026-09-22 复测仍在）：
 *       GET /codex/threads?e2ee=1                  → 200，content-type: application/json，
 *                                                    24KB 会话列表（标题就是内容），
 *                                                    **没有 x-dsh-e2ee 头** —— 明文过中继。
 *       GET /codex/queue?e2ee=1                    → 200 {"entries":[]} 明文
 *       对照（同端点带头去要）：x-dsh-e2ee: 1 + application/octet-stream（真加密）
 *
 *     根因：闸门 `clientWantsE2ee()` 认「`?e2ee=1` **或** `x-dsh-e2ee: 1`」，
 *     而这三个端点外面套的 `e2eeWrap()` 只认 `x-dsh-e2ee: 1`。
 *     于是「查询参数那一半」成了绕过闸门的口令：只要在地址后面加 `?e2ee=1`，
 *     闸门就放行，而内容照旧明文出门。为什么这不是小事：这道闸门存在的理由
 *     就是「中继看得见路径与 cookie」，而**中继自己就能加上 `?e2ee=1` 重放一次**
 *     把内容读成明文 —— 它正是这套加密要防的那个人。
 *     （反过来说，手机端 fetch 走的是请求头，所以正常使用看不到这个洞；
 *       它伤的是「这道门到底守没守住」这件事本身。）
 *     对应断言：D4 三条现在必红（两条行为 + 一条静态根因），
 *     另有一条对照组必须绿（带头去要时确实返回密文）——证明红的那条不是误判。
 *
 * ★ [轻 · 仍然红] `pwa/e2ee.js` 的 `secretFromUrl()` 会把「两份 `#k=`」整段当成密钥
 *
 *     现场复现（把 pwa/e2ee.js 真的加载进一个假 window 里跑）：
 *       输入 hash = `#k=<真密钥>#k=<真密钥>`
 *       返回      = `"<真密钥>#k=<真密钥>"`（67 字符，含 `#`）而不是那把真密钥。
 *     后果与缺陷 #1 一模一样但更隐蔽：客户端**装上了加密**（`__dshE2eeOn=true`），
 *     WS 也带 `e2ee=1` 通过了闸门拿到 101，但每一帧都解不开（本文件实测：
 *     网关的密文用真密钥解得开、用这把坏密钥解不开）→ `failEncryptedTransport()`
 *     静默关掉连接 → 页面照常、对话列表空，而 route.js 的角标因为
 *     `__dshE2eeOn === true` 显示「一切正常」—— 界面主动撒了谎。
 *     为什么必须在这里测：test-address-key.js 只钉住了**产出方**（不许生成双份
 *     `#k=`），消费方一直没人管 —— 生产者守卫齐了、消费者照样把坏输入咽下去。
 *     对应断言：A5 两条（现在必红）。
 *
 * ★ [轻 · 现在绿，属于「还没退化」] 换地址空窗期：控制台放开「复制」的判据
 *     只有「地址字符串变了」，没有要求新地址**真的可达**。守护进程写完
 *     status.json 时可能刚探到「暂时还探不通（边缘生效可能要十几秒）」——
 *     `reachable:false` 就摆在同一个 JSON 里，控制台不看它，照样提示
 *     「现在可以复制了」并把地址推给手机。本文件暂时只钉住「等待预算 ≥ 20 秒」
 *     与「复制出口唯一」，把这条缺口写在注释里，不假装已经解决。
 *
 * ★ [记录] 仓库里两份「交给过使用者的地址」已经失效且不会被任何人更新：
 *     current-url.txt 里的访问密钥不是当前密钥（`XBe314-…` vs 现行 `Ygoks3B…`）；
 *     logs/手机地址.txt 里的隧道域名是另一个（已被回收）。它们现在是**明确失败**
 *     （403 / ENOTFOUND），所以不算「静默死链」，但谁也不该再照它念地址。
 *     它们同时也是 C2「旧链接必须明确失败」的**真实样本**。
 *
 * ---------------------------------------------------------------------------
 * 「每条断言都能失败」是怎么验的
 * ---------------------------------------------------------------------------
 * 跑 `node scripts/test-scenarios.js --red-check`。两种做法：
 *
 *   ① 离线注入：把坏数据喂给**同一个**判定函数，要求它必须报错；
 *      再喂一组好数据，要求它必须报「没问题」—— 两边都得会动，
 *      否则就是「无脑报错」或者「死的断言」。覆盖 R1~R6 共 14 条，例如：
 *        R1  公网地址形式：喂 `https://api.trycloudflare.com/tunnel`  → 报错 ✓
 *        R2  地址里的 #k=：喂两份 #k= / 喂旧密钥                      → 报错 ✓
 *        R3  隧道状态：喂 `{reachable:true, probeError:'boom'}`       → 报错 ✓
 *        R5  客户端解析：#k=A#k=B                                     → 报错 ✓
 *        R6  经中继明文：喂「200 但没有加密标记」                      → 报错 ✓
 *   ② 现场反向验证（网关在跑时才做）：
 *        L1 同一条断言喂两种来路必须给出不同结果：经中继 403 / 回环 200。
 *           两边一样就说明这条断言分不清「被挡住了」和「端点本来就坏」，
 *           也就永远不会因为守卫退化而变红。
 *        L2 把断言**反过来写**一次（要求「经中继 /console 不是 403」），
 *           确认它确实失败 —— 这就是「临时构造让它失败的条件」。
 *
 * 实跑结果（2026-09-22，网关在跑、隧道可达）：
 *   node scripts/test-scenarios.js             → 121 通过 / 5 失败 / 7 跳过
 *       5 条失败**全部**是上面那两个仍然存在的问题（2 条双份 #k=、3 条闸门记号不一致），
 *       不是环境抖动；结尾会把「已知还开着的」和「这次新冒出来的」分开列出来。
 *   node scripts/test-scenarios.js --red-check → 16 通过 / 0 失败（L1 实测 经中继 403 / 回环 200）
 *
 * 注意：这个文件名是 test-*.js，所以 run-all-tests.js 会自动带上它。
 * 上面那两个问题修好之前它会一直是红的 —— 那是**故意的**，不是把它关掉的理由。
 *
 * ---------------------------------------------------------------------------
 * 安全边界（这个测试自己也要守规矩）
 * ---------------------------------------------------------------------------
 *   · 不重启网关/守护进程、不动隧道、不轮换密钥、不发通知、不建会话、不跑回合。
 *   · 需要认证的请求一律带 `x-dsh-selfcheck: 1`（网关自己的自检通道），
 *     它走「本机请求不登记设备」那一支 —— 实测设备数前后不变。
 *   · 开局记一次设备数，收尾比对；不相等就报失败（自己造成的污染自己认）。
 *   · 唯一的写请求是 `/__console/action` 带一个**不存在的动作名**，用来证明
 *     该端点对未认证来源开放；它只会走到「未知操作」，不做任何事。
 *   · 网关没在跑时，所有需要现场的条件一律打印「跳过」并说明原因，不假装通过；
 *     也**不会**把「网关没起来」误判成「漏洞还在」。
 *   · 两道门分清楚，别混为一谈：
 *       回环门 isLoopback   → /console、/__console/status、/__console/action、/__health
 *                             本机打开控制台本来就不需要 cookie（合法）；
 *                             要挡的是「非回环」和「经中继」两种来路。
 *       认证门 hasAuthCookie → /__routes、/go、/codex/threads、/codex/file、/__targets
 *                             /__routes **不是**回环门：从回环不带 cookie 照样 403。
 *
 * 用法:
 *   node scripts/test-scenarios.js              跑全部
 *   node scripts/test-scenarios.js --red-check  只跑「断言能红」的自检
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');

const tunnel = require('./tunnel.js');
const e2ee = require('./e2ee.js');
const sessions = require('./sessions.js');
const wsf = require('./ws-frame.js');

// ── 现场文件 ────────────────────────────────────────────────────────────────
function readText(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (err) { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { return null; } }

const ACCESS_KEY = readText(path.join(LOG_DIR, 'access-key.txt')) || '';
const E2EE_SECRET = readText(path.join(LOG_DIR, 'e2ee-secret.txt')) || '';
const PAIR_CODE = readText(path.join(LOG_DIR, 'pair-code.txt')) || '';
const STATUS = readJson(path.join(LOG_DIR, 'status.json')) || {};
const EGRESS = (readJson(path.join(LOG_DIR, 'egress.json')) || {}).value || null;
const OLD_PHONE_URL = readText(path.join(LOG_DIR, '手机地址.txt')) || '';   // 历史上交给过使用者
const ROOT_URL = readText(path.join(BASE, 'current-url.txt')) || '';        // 仓库根那份
const PORT = Number(readText(path.join(LOG_DIR, 'gateway-port.txt'))) || 8080;
const HTTPS_PORT = Number(readText(path.join(LOG_DIR, 'https-port.txt'))) || 0;
const LAN_IP = (() => {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const x of ifaces[name] || []) {
      if (x && x.family === 'IPv4' && !x.internal) return x.address;
    }
  }
  return null;
})();

const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1';
const TUNNEL_HOST = (() => {
  try { return new URL(STATUS.tunnel.url).host; } catch (err) { return 'scenario.invalid'; }
})();

// ── 输出 ────────────────────────────────────────────────────────────────────
let pass = 0; let fail = 0; let skipped = 0;
let gatewayDown = false;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
  return !!cond;
}
function skip(name, why) {
  skipped++;
  console.log(`  · 跳过 ${name}（${why}）`);
}
function note(line) { console.log(`    ${line}`); }
function section(title) { console.log(`\n[${title}]`); }

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────
/**
 * 发一个请求。
 * connectHost 决定 **socket 来源地址**（判定「是不是回环」看的就是它），
 * hostHeader 决定网关看到的 Host（判定「是不是经中继」看的是它）。
 * 这两件事在真实世界里是分开的 —— 隧道那条路上 socket 是回环、Host 是隧道域名，
 * 本项目最严重的一个漏洞就出在把两者当成了一件事。
 */
function request(opts) {
  const useHttps = !!opts.https;
  const mod = useHttps ? https : http;
  return new Promise((resolve) => {
    const headers = Object.assign({ 'user-agent': PHONE_UA }, opts.headers || {});
    if (opts.hostHeader) headers.host = opts.hostHeader;
    const r = mod.request({
      host: opts.connectHost || '127.0.0.1',
      port: opts.port || PORT,
      path: opts.path,
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: false
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode, headers: res.headers,
          body: raw.toString('utf8'), raw
        });
      });
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: 'ERR ' + e.message, raw: Buffer.alloc(0) }));
    r.setTimeout(opts.timeout || 10000, () => { r.destroy(); resolve({ status: 0, headers: {}, body: 'TIMEOUT', raw: Buffer.alloc(0) }); });
    r.end(opts.body);
  });
}

/** 请求头：模拟「从公网隧道进来」 */
function relayHeaders(extra) {
  return Object.assign({
    host: TUNNEL_HOST,
    'cf-connecting-ip': '203.0.113.9',
    'cf-ray': '0000000000000000-SJC',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.9',
    'accept-language': 'en-US,en;q=0.9'
  }, extra || {});
}

/**
 * 裸 socket 发一次 WebSocket 升级，顺带把回来的帧收下来。
 * 返回 { statusLine, head, frames, firstData }。
 * 用裸 socket 而不是 ws 库：升级失败的响应体（那句给使用者看的人话）
 * 只有在裸连接上才拿得到，而「失败得说不说得清」正是这个测试要看的。
 */
function wsProbe(pathname, headers, opts) {
  opts = opts || {};
  // 升级失败时响应体是跟在头后面的：如果一见到 `\r\n\r\n` 就收工，
  // 那句写给使用者看的人话还没到，断言就会把「有话说」误判成「空响应」。
  // 所以拒绝分支也要多等一会儿（waitMs），把正文收全。
  const waitMs = opts.waitMs || (opts.collectBody ? 1500 : 0);
  return new Promise((resolve) => {
    const out = { statusLine: '', head: '', body: '', frames: [], raw: Buffer.alloc(0), firstData: null };
    const sock = net.connect(opts.port || PORT, opts.connectHost || '127.0.0.1', () => {
      let raw = `GET ${pathname} HTTP/1.1\r\n`;
      for (const k of Object.keys(headers)) raw += `${k}: ${headers[k]}\r\n`;
      raw += `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n';
      sock.write(raw);
    });
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = () => {
      if (settled) return; settled = true;
      try { sock.destroy(); } catch (err) { /* 已经断了 */ }
      const idx = buf.indexOf('\r\n\r\n');
      if (idx >= 0) {
        out.head = buf.subarray(0, idx).toString('utf8');
        out.statusLine = out.head.split('\r\n')[0];
        out.raw = buf.subarray(idx + 4);
        out.body = out.raw.toString('utf8');
        try {
          const parsed = wsf.parseFrames(out.raw);
          out.frames = parsed.frames;
          const data = parsed.frames.find((f) => wsf.isData(f.opcode) && f.payload.length);
          out.firstData = data || null;
        } catch (err) { /* 帧没解析出来，下面的断言会看到 frames 为空 */ }
      } else {
        out.head = buf.toString('utf8').slice(0, 400);
        out.statusLine = out.head.split('\r\n')[0];
      }
      resolve(out);
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!settled && !waitMs && buf.indexOf('\r\n\r\n') >= 0) return done();
    });
    sock.on('error', (e) => { out.statusLine = 'ERR ' + e.message; done(); });
    sock.setTimeout(opts.timeout || 9000, () => { out.statusLine = out.statusLine || 'TIMEOUT'; done(); });
    if (waitMs) setTimeout(done, waitMs);
  });
}

/** 隧道探测：免费快速隧道偶发一次 ECONNRESET，重试一次再下结论（不能把抖动当死链） */
async function probeWithRetry(origin, timeoutMs, attempts) {
  const n = attempts || 2;
  let last = null;
  for (let i = 0; i < n; i++) {
    last = await tunnel.probeUrl(origin, timeoutMs);
    if (last && last.ok) return last;
    if (i < n - 1) await new Promise((r) => setTimeout(r, 1200));
  }
  return last;
}

// ── 可注入的判定（--red-check 会拿坏数据喂它们）──────────────────────────────
/** 公网地址形式：必须是隧道服务商的正常主机名，绝不能是 Cloudflare 的服务端点 */
function publicHostProblem(url) {
  if (!url) return '没有地址';
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (err) { return `地址解析不了: ${url}`; }
  if (/(^|\.)(api|www|dash|developers)\.trycloudflare\.com$/.test(host)) {
    return `这是 Cloudflare 的服务端点，不是隧道地址: ${host}`;
  }
  if (!/^[a-z0-9-]+\.trycloudflare\.com$/.test(host) &&
      !/^[a-z0-9-]+\.ngrok(?:-free)?\.app$/.test(host) &&
      !/^[a-z0-9-]+\.ngrok\.io$/.test(host) &&
      !/^[a-z0-9-]+\.ts\.net$/.test(host)) {
    return `不是已知隧道服务商的地址形式: ${host}`;
  }
  return null;
}

/** 交给使用者的地址里的 `#k=`：必须恰好一份，而且必须是那把**真能解密**的密钥 */
function keyFragmentProblems(entry, realSecret) {
  const problems = [];
  if (!entry) return ['没有地址'];
  const count = (String(entry).match(/#k=/g) || []).length;
  if (realSecret && count !== 1) problems.push(`#k= 出现 ${count} 次（必须恰好一次）`);
  const m = String(entry).match(/#k=([^#&]*)/);
  const got = m ? m[1] : null;
  if (realSecret && got !== realSecret) {
    problems.push(`#k= 不是那把能解密的密钥（链接里 ${JSON.stringify(String(got).slice(0, 10))}…，实际 ${realSecret.slice(0, 10)}…）`);
  }
  return problems;
}

/** 隧道状态不能自相矛盾：说可达就不能同时有失败原因，反之亦然 */
function tunnelStateProblems(t) {
  const problems = [];
  if (!t) return ['没有隧道信息'];
  if (t.reachable === true && t.probeError) problems.push(`reachable=true 却同时带着 probeError=${t.probeError}`);
  if (t.reachable === false && !t.probeError) problems.push('reachable=false 却没有任何失败原因（界面说不清「为什么不通」）');
  if (t.running === true && !t.url) problems.push('running=true 却没有地址');
  return problems;
}

/** 现场地址必须现场就能用：探到的必须是「网关在监听」而不是 5xx/连不上 */
function entryUsabilityProblem(probe) {
  if (!probe) return '没有探测结果';
  if (probe.ok) return null;
  return `探测失败：${probe.error || 'HTTP ' + probe.status}`;
}

/**
 * 一条「经中继 + 已经过了闸门」的响应，到底有没有把明文交出去？
 * 判据：只要 200 了却没有 x-dsh-e2ee 标记，那段正文就是明文过中继。
 * （抽成纯函数是为了能拿两个方向的假响应喂它，证明它会红也会绿。）
 */
function relayPlaintextProblem(res) {
  if (!res) return '没有响应';
  if (res.status !== 200) return null;                       // 非 200 没有正文可漏
  if (res.headers && res.headers['x-dsh-e2ee'] === '1') return null;   // 加密了
  return `HTTP 200 但没有加密标记 —— ${res.raw ? res.raw.length : '?'} 字节正文是明文过中继`;
}

// ── 客户端逻辑：把 pwa/e2ee.js 真的跑起来 ───────────────────────────────────
/**
 * 在假 window 里加载 pwa/e2ee.js，返回它解析出来的密钥。
 *
 * 为什么值得这么麻烦：`#k=` 的消费方（浏览器里那段）从来没被测过 ——
 * 生产者那一侧 test-address-key.js 钉得很死，消费方却是「给什么吃什么」。
 * 这个函数就是拿来喂各种坏 fragment 的。
 */
function clientSecretFor(hash, sessionSecret) {
  const src = fs.readFileSync(path.join(BASE, 'pwa', 'e2ee.js'), 'utf8');
  const store = {};
  if (sessionSecret) store['dsh-e2ee-secret-v1'] = sessionSecret;

  const win = {
    location: { hash: hash || '', pathname: '/', search: '', href: 'https://x.trycloudflare.com/' },
    history: { replaceState() { } },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; }
    },
    addEventListener() { }
  };
  win.window = win;
  const sandbox = {
    window: win, self: win, globalThis: win,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder, TextDecoder, console, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { secret: win.__dshE2eeSecret || null, on: win.__dshE2eeOn === true, store };
}

// ══════════════════════════════════════════════════════════════════════════
//  --red-check：证明断言真的能红（坏数据只在内存里构造，不碰生产文件）
// ══════════════════════════════════════════════════════════════════════════
async function redCheck() {
  console.log('\n=== 自检：这些断言真的会红吗 ===');
  console.log('做法：把坏数据喂给**同一个**判定函数，要求它必须报错；');
  console.log('      再拿现场反向跑一次，要求它必须报「没问题」——两边都得会动。\n');

  let dead = 0;
  let checked = 0;
  const mustRed = (name, problem, detail) => {
    checked++;
    if (problem) { pass++; console.log(`  ✓ ${name} → 变红了：${problem}`); }
    else { fail++; dead++; console.log(`  ✗ ${name} → 喂了坏数据居然还是绿的（这条断言是死的）`); }
    if (detail) note(detail);
  };
  const mustGreen = (name, problem, detail) => {
    checked++;
    if (!problem) { pass++; console.log(`  ✓ ${name} → 好的数据是绿的（不是无脑报错）`); }
    else { fail++; dead++; console.log(`  ✗ ${name} → 好数据也被判成红的（假红）：${problem}`); }
    if (detail) note(detail);
  };

  // ── 离线注入 ─────────────────────────────────────────────────────────────
  mustRed('R1 公网地址形式（喂 api.trycloudflare.com）',
    publicHostProblem('https://api.trycloudflare.com/tunnel'));
  mustGreen('R1b 公网地址形式（喂正常快速隧道域名）',
    publicHostProblem('https://hybrid-store-blink-locations.trycloudflare.com'));

  const goodKey = E2EE_SECRET || 'REALSECRETREALSECRET';
  mustRed('R2 地址里的 #k= 只许一份（喂两份）',
    keyFragmentProblems(`https://x.trycloudflare.com/k/K#k=${goodKey}#k=${goodKey}`, goodKey).join(' / '));
  mustRed('R2b 地址里的 #k= 必须是能解密的那把（喂旧密钥）',
    keyFragmentProblems('https://x.trycloudflare.com/k/K#k=OLDSECRETOLDSECRET', goodKey).join(' / '));
  mustGreen('R2c 地址里的 #k=（喂正确的那把）',
    keyFragmentProblems(`https://x.trycloudflare.com/k/K#k=${goodKey}`, goodKey).join(' / '));

  mustRed('R3 隧道状态自相矛盾（喂 reachable=true + probeError）',
    tunnelStateProblems({ running: true, url: 'https://x.trycloudflare.com', reachable: true, probeError: 'boom' }).join(' / '));
  mustGreen('R3b 隧道状态（喂一致的一组）',
    tunnelStateProblems({ running: true, url: 'https://x.trycloudflare.com', reachable: true, probeError: null }).join(' / '));

  mustRed('R4 现场地址可用性（喂已被回收的域名）',
    entryUsabilityProblem({ ok: false, status: 0, error: 'getaddrinfo ENOTFOUND' }));
  mustGreen('R4b 现场地址可用性（喂探通的结果）',
    entryUsabilityProblem({ ok: true, status: 204, ms: 300 }));

  const doubled = `#k=${'a'.repeat(20)}#k=${'b'.repeat(20)}`;
  const doubledSecret = clientSecretFor(doubled, null).secret;
  mustRed('R5 客户端解析双份 #k=（喂 #k=A#k=B）',
    (!doubledSecret || /#/.test(doubledSecret))
      ? `解析成 ${JSON.stringify(String(doubledSecret))}`
      : null);
  const goodParse = clientSecretFor('#k=' + goodKey, null).secret;
  mustGreen('R5b 客户端解析正常 #k=（喂真密钥）',
    (goodParse === goodKey) ? null : `解析成 ${JSON.stringify(String(goodParse))}`);

  mustRed('R6 经中继明文判定（喂「200 但没有加密标记」）',
    relayPlaintextProblem({ status: 200, headers: { 'content-type': 'application/json' }, raw: Buffer.alloc(20361) }));
  mustGreen('R6b 经中继明文判定（喂「200 + 加密标记」）',
    relayPlaintextProblem({ status: 200, headers: { 'x-dsh-e2ee': '1' }, raw: Buffer.alloc(23492) }));
  mustGreen('R6c 经中继明文判定（喂「被闸门拒绝」）',
    relayPlaintextProblem({ status: 403, headers: {}, raw: Buffer.alloc(0) }));

  // ── 现场反向跑一次：证明「经中继被挡」那条断言分得清好坏 ──────────────────
  console.log('\n  ── 现场反向验证（网关没在跑就跳过）──');
  const health = await request({ path: '/__health', hostHeader: `127.0.0.1:${PORT}` });
  if (health.status !== 200) {
    skip('红色自检的现场部分', `网关没在跑（/__health = ${health.status}）—— 不当成「漏洞还在」`);
  } else {
    // L1：同一条断言，喂「经中继」必须报 403，喂「回环」必须报 200。
    //     两边结果一样的话，这条断言就分不清「被挡住了」和「端点本来就坏」，
    //     也就永远不会因为守卫退化而变红。
    const relayed = await request({ path: '/console', headers: relayHeaders() });
    const local = await request({ path: '/console', hostHeader: `127.0.0.1:${PORT}` });
    checked++;
    if (relayed.status === 403 && local.status === 200) {
      pass++; console.log(`  ✓ L1 同一条断言能分辨两种来路：经中继 ${relayed.status} / 回环 ${local.status}`
        + '（守卫一旦退化，经中继那条立刻变红）');
    } else {
      fail++; dead++;
      console.log(`  ✗ L1 分辨不出来：经中继 ${relayed.status} / 回环 ${local.status}` +
        ' —— 这条断言不可能因为守卫退化而变红');
    }

    // L2：把断言反过来写一次（要求「不是 403」），确认它会失败 ——
    //     这就是「临时构造让它失败的条件」，只不过构造的是期望值本身。
    checked++;
    const inverted = relayed.status !== 403;
    if (!inverted) {
      pass++; console.log('  ✓ L2 反向期望（要求 /console 经中继**不是** 403）确实失败了 → 正向断言不是空转');
    } else {
      fail++; dead++;
      console.log(`  ✗ L2 反向期望居然成立了（经中继 /console = ${relayed.status}）→ 说明管理面又漏给公网了`);
    }
  }

  console.log(fail === 0
    ? `\n=== ${pass} 通过 / ${fail} 失败 ===\n结论: ${checked} 条断言都验证过会红/会绿 —— 没有摆设。\n`
    : `\n=== ${pass} 通过 / ${fail} 失败 ===\n结论: ${dead} 条断言是死的，必须重写。\n`);
  process.exitCode = fail ? 1 : 0;
}

// ══════════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n=== 场景化健壮性 · 端到端 ===');
  console.log('模拟的是使用者真实会走的路：第一次打开 → 日常往返 → 换地址换钥匙 →');
  console.log('出故障 → 各种边界。每条都要么真发请求，要么真的把客户端的代码跑起来。');

  const devicesBefore = sessions.list().length;

  // ── 0. 前置：网关在不在 ───────────────────────────────────────────────────
  section('0 前置条件');
  const health = await request({ path: '/__health', hostHeader: `127.0.0.1:${PORT}` });
  const gatewayUp = health.status === 200 && health.body.includes('pocket-bridge-gateway');
  if (!gatewayUp) {
    // 网关没起来 = 环境不具备，**不是**「漏洞还在」。
    // 这里绝不假通过、也绝不报假红：整份跳过并说清原因（和 test-pwa-install.js 一个口径）。
    gatewayDown = true;
    skip('A~E 全部现场场景',
      `网关没在跑（http://127.0.0.1:${PORT}/__health 返回 ${health.status || '连不上'}）—— ` +
      '这个文件的场景全都要活的网关，所以一条都不跑；' +
      '这既不算通过，也不代表「漏洞还在」，等网关照常跑起来再跑一次');
    return;
  }
  ok('网关在跑且确实是本项目的中间层', true);
  let healthJson = {};
  try { healthJson = JSON.parse(health.body); } catch (err) { /* 上面已断言 */ }
  note(`端口 ${healthJson.port} · HTTPS ${healthJson.httpsPort} · DSH ${healthJson.dshPort} 活着=${healthJson.dshAlive}`);

  if (!ACCESS_KEY) {
    ok('读得到访问密钥', false, 'logs/access-key.txt 读不到');
    return;
  }
  if (!E2EE_SECRET) note('⚠ 本机没配加密密钥（e2ee-secret.txt 为空）—— 与加密有关的场景会跳过');

  // 一次本机自检式登录：拿一份可用的会话 cookie。
  // `x-dsh-selfcheck: 1` 走的是网关自己的自检通道 → 不登记设备（设备数是全局不变量）。
  const login = await request({
    path: '/k/' + encodeURIComponent(ACCESS_KEY),
    hostHeader: `127.0.0.1:${PORT}`,
    headers: { 'x-dsh-selfcheck': '1' }
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
  ok('密钥入口 /k/<key> 能换到会话 cookie', login.status === 200 && cookie.length > 10,
    `status=${login.status} cookie=${cookie.slice(0, 24)}`);
  // ★ 这里原来是「必须是 302」。改成 200 + 客户端跳转，理由是**真机 Safari**：
  //
  //   302 跳转时 Safari 会丢掉 `#` 后面的片段 —— `#k=<加密密钥>` 根本到不了
  //   页面，于是徽标显示「未加密」、WS 不带 e2ee=1 被网关拒绝、对话列表空的。
  //   Chromium 不丢片段，所以这条断言原来一直是绿的，坑只在真机上出现。
  //
  //   现在返回 200 + 一段**解析阶段就执行**的内联脚本，
  //   `location.replace("/" + location.search + location.hash)` ——
  //   地址栏不会停留（脚本在绘制前跑完），而 hash 能原样带走。
  //   所以断言改成正向要求：**必须把 hash 带走**。谁改回 302，这条会红。
  //  ★ 现在**根本不跳转**了 —— 就在 /k/<密钥> 原地把应用服务出来。
  //
  //   改这一版的理由（逐步被真实故障逼出来的）：
  //     ① 302 跳走时 Safari 会丢掉 `#` 片段 → 密钥到不了页面 → 未加密、WS 被拒；
  //     ② 就算用客户端跳转保住了片段，一跳转地址就变成 '/'，
  //        而「添加到主屏幕」保存的是**当时的地址** —— 图标里没有密钥，永远打不开；
  //     ③ iOS 主屏 App 和 Safari 是两套独立存储，cookie 也带不过去。
  //   所以唯一能穿过那道隔离的载体就是 URL 本身：停在 /k/ 上，
  //   图标存下的才是 `/k/<密钥>#k=<加密密钥>` 这条自带认证的地址。
  //
  //   断言因此守两件事：**不跳走**（status 200 且 pathname 还是 /k/）、
  //   **自带认证**（响应里必须有 set-cookie —— 少发过这个，主屏 App 就永远白屏）。
  ok('密钥入口原地服务、不跳走（跳转会弄丢 #k= 和 /k/ 路径）',
    login.status === 200 && !login.headers.location && login.headers['set-cookie'],
    `status=${login.status} location=${login.headers.location} 有cookie=${!!login.headers['set-cookie']}`);

  const AUTH = { cookie, 'x-dsh-selfcheck': '1' };
  const dshAlive = !!healthJson.dshAlive;

  // ══════════════════════════════════════════════════════════════════════
  //  A. 首次使用
  // ══════════════════════════════════════════════════════════════════════
  section('A1 用完整链接（带 #k=）打开');
  if (!E2EE_SECRET) {
    skip('A1 全部（带 #k= 打开）', '本机没配加密密钥，链接里本来就没有 #k=');
  } else {
    const parsed = clientSecretFor('#k=' + E2EE_SECRET);
    ok('链接里 #k= 那段能被客户端解析成正确的密钥',
      parsed.secret === E2EE_SECRET, `解析出 ${JSON.stringify(String(parsed.secret).slice(0, 12))}…`);
    ok('#k= 的密钥与服务端实际用来解密的密钥一致（否则手机就是「能开、看不到对话」）',
      parsed.secret === E2EE_SECRET && E2EE_SECRET.length >= 16, `长度 ${E2EE_SECRET.length}`);

    if (!dshAlive) {
      skip('A1 落地页（/）的脚本注入', 'DSH 没在跑，/ 会回 503 的「正在启动」页');
    } else {
      const home = await request({ path: '/', hostHeader: `127.0.0.1:${PORT}`, headers: AUTH });
      ok('带 cookie 打开 / 能拿到页面', home.status === 200, `status=${home.status}`);
      ok('页面注入了 __dshE2eeConfigured=true（客户端才分得清「没配」和「没带钥匙」）',
        home.body.includes('window.__dshE2eeConfigured=true'), '没找到那段注入');
      for (const f of ['/e2ee.js', '/route.js', '/polyfill.js']) {
        ok(`页面加载了 ${f}`, home.body.includes(f), '注入的脚本清单里没有它');
      }
    }
  }

  section('A1b 主屏图标那件事：从密钥路径进来之后，地址栏不能再丢掉 /k/');
  {
    // 主屏图标曾保存了错误入口，导致无法打开。
    // 日志里的实锤是一行 `403 无会话 cookie: GET /` —— 也就是说**图标里存的是 `/`**。
    //
    // 怎么丢的：选择页点「打开 DSH」→ `/k/<密钥>?target=dsh` → 服务端 302 到 `/`，
    // 地址栏里的 `/k/<密钥>` 就没了。而「添加到主屏幕」存的正是**当时那个地址**。
    // 所以这一组盯的是：**那次选目标不能再跳走**（就地服务），
    // 以及万一图标已经存坏了，点开时得给一页能照着修的说明。

    // ① 选 dsh：必须就地服务（没有 location 头），而且真的把应用吐出来
    const pick = await request({
      path: `/k/${ACCESS_KEY}?target=dsh`,
      hostHeader: `127.0.0.1:${PORT}`,
      headers: { 'user-agent': PHONE_UA, accept: 'text/html,application/xhtml+xml' }
    });
    ok('从密钥路径选「打开 DSH」不再跳走（一跳地址栏就丢 /k/，图标就存成 /）',
      pick.status === 200 && !pick.headers.location,
      `status=${pick.status} location=${pick.headers.location || '(无)'}`);
    ok('而且这一下真的把应用服务出来了（不是停在过渡页）',
      dshAlive ? pick.body.includes('__ModuleLoader__') || pick.body.includes('id="root"') : pick.status === 503,
      dshAlive ? `正文 ${pick.body.length} 字节` : 'DSH 没在跑，按 503 算');
    ok('顺手把「选过 DSH」记下来（下次不必再问）',
      /dsh-gw-target=dsh/.test(String(pick.headers['set-cookie'] || '')),
      String(pick.headers['set-cookie'] || '(没有 set-cookie)').slice(0, 80));

    // ② 选 codex 的老行为不能变（它没有密钥路径这回事）
    const pickCx = await request({
      path: `/k/${ACCESS_KEY}?target=codex`,
      hostHeader: `127.0.0.1:${PORT}`,
      headers: { 'user-agent': PHONE_UA, accept: 'text/html' }
    });
    ok('选 Codex 仍然跳 /codex（这条老行为不许被上面那条改掉）',
      pickCx.status === 302 && pickCx.headers.location === '/codex',
      `status=${pickCx.status} location=${pickCx.headers.location}`);

    // ③ 真正坏掉的那种图标：地址里没有密钥、也没有 cookie
    const dead = await request({
      path: '/', hostHeader: `127.0.0.1:${PORT}`,
      headers: { 'user-agent': PHONE_UA, accept: 'text/html,application/xhtml+xml' }
    });
    ok('没有密钥的裸地址被挡（不是把内容给出去）', dead.status === 403, `status=${dead.status}`);
    ok('但给的是一页**能照着修**的说明，不是一个 33 字节的英文短句',
      /text\/html/.test(String(dead.headers['content-type'] || '')) && dead.body.length > 600,
      `${String(dead.headers['content-type'])} ${dead.body.length} 字节`);
    ok('那一页里有通往配对页的路（已经存坏的图标能靠它救回来 —— '
      + '主屏 App 的 cookie 是它自己那套存储，只有在它自己窗口里配对才存得进去）',
      /href="\/pair"/.test(dead.body), '没找到 /pair 的链接');
    ok('并且说清了「地址里没有密钥」这件事',
      // 页面按请求的语言出（这里的请求没带 accept-language，多半是英文）——
      // 所以两种语言的判据都要认，不能只认中文。
      /(密钥|access key)/i.test(dead.body) && /(添加到主屏幕|主屏|Home Screen)/i.test(dead.body),
      `正文 ${dead.body.length} 字节，两个关键词没同时出现`);

    // ④ 程序调用（Accept 不含 text/html）照旧是纯文本，别把 JSON 客户端带偏
    const api = await request({ path: '/__routes', hostHeader: `127.0.0.1:${PORT}`, headers: { accept: 'application/json' } });
    ok('程序调用（Accept 不是 text/html）仍然是纯文本，行为不变',
      api.status === 403 && /text\/plain/.test(String(api.headers['content-type'] || '')),
      `${api.status} ${String(api.headers['content-type'])}`);

    // ⑤ 日志里要能看出「从哪来、哪个地址、有没有 cookie」——
    //    这三种情况的修法完全不同，原来只记一个路径，只能靠猜。
    const tail = readText(path.join(LOG_DIR, 'proxy.log')) || '';
    const line = tail.split('\n').reverse().find((l) => /403 无会话 cookie/.test(l)) || '';
    ok('403 的日志记下了 Host / UA / 有没有 cookie',
      /Host=/.test(line) && /UA=/.test(line) && /cookie=/.test(line),
      line ? line.slice(0, 120) : '(日志里没有这条)');

    // ⑥ 页面里那个 manifest 链接必须被剥掉
    //
    //    它是「图标打不开」的第二层原因：manifest 的 start_url 会**覆盖**
    //    「添加到主屏幕」存下来的地址，于是图标里存的是 start_url 而不是当时那条
    //    `/k/<密钥>#k=<加密密钥>`。而 start_url 又不可能写密钥（那个文件免认证可取）。
    if (dshAlive) {
      const page = await request({
        path: `/k/${ACCESS_KEY}`, hostHeader: `127.0.0.1:${PORT}`,
        headers: { 'user-agent': PHONE_UA, accept: 'text/html' }
      });
      const manifestLink = /<link[^>]+rel=["']?manifest/i.test(page.body);
      ok('页面里没有 manifest 链接（有它图标就会存成 start_url，永远打不开）',
        !manifestLink, manifestLink ? (page.body.match(/<link[^>]+manifest[^>]*>/i) || [])[0] : '已剥掉');
    }
  }

  section('A2 不带 #k= 打开 —— 必须给出明确提示，不能静默空白');
  {
    // 服务端这一半：经中继的实时通道，没要求加密就必须**明说被拒**。
    // collectBody：拒绝时的正文跟在响应头后面，要等一下才收得到。
    const wsPlain = await wsProbe('/api/remote.mux', Object.assign(
      { cookie, 'x-dsh-selfcheck': '1' }, relayHeaders()), { collectBody: true });
    ok('经中继 + 没带 e2ee=1 → 实时通道被拒（403，不是放行）',
      /^HTTP\/1\.1 403/.test(wsPlain.statusLine), wsPlain.statusLine || '(无响应)');
    ok('拒绝时给了一句人话（不是空响应）',
      wsPlain.body.trim().length > 30 && /encrypt/i.test(wsPlain.body),
      `正文 ${wsPlain.body.trim().length} 字节: ${JSON.stringify(wsPlain.body.trim().slice(0, 90))}`);

    // 客户端那一半：这条路要能被认成「缺密钥」而不是「加密中」。
    const routeSrc = fs.readFileSync(path.join(BASE, 'pwa', 'route.js'), 'utf8');
    ok('客户端会把「配了密钥但链接里没带」单独认出来（nokey 分支）',
      /'nokey'/.test(routeSrc) && /__dshE2eeConfigured/.test(routeSrc),
      'route.js 里没有 nokey 判断 —— 使用者只会看到角标一切正常');
    ok('缺密钥时角标会显示「未加密」而不是假装正常',
      /plaintextReason\(\)/.test(routeSrc) && /未加密/.test(routeSrc));
    const noKeyParse = clientSecretFor('', null);
    ok('没有 #k= 时客户端确实拿不到密钥（会走上面那条提示）', !noKeyParse.secret);
    for (const bad of ['#k=', '#k=&x=1', '#k=abc', '#k=' + 'a'.repeat(15)]) {
      const r = clientSecretFor(bad, null);
      ok(`坏输入 ${JSON.stringify(bad.slice(0, 12))} 不会被当成有效密钥`,
        !r.secret, `却解析出了 ${JSON.stringify(String(r.secret).slice(0, 20))}`);
    }
  }

  section('A3 配对流（/pair）');
  {
    const page = await request({ path: '/pair', hostHeader: `127.0.0.1:${PORT}` });
    ok('/pair 打不开要 200 且是配对页（免认证，手机要先能进来才能配对）',
      page.status === 200 && /action="\/pair"|action='\/pair'/.test(page.body),
      `status=${page.status}`);
    // ★ 故意错的那两次要**换一个「来源」**发。
    //
    //   配对失败是按来源计的限速（5 次锁 15 分钟）。同一个来源反复跑这条测试，
    //   就会把自己锁在门外 —— 表现是**「正确配对码」那一组全红**，错误信息只有
    //   一句 `status=429`，看起来像配对坏了。实测：连着跑两遍就复现。
    //
    //   来源怎么换：不能靠换 socket 地址（本机连 127.0.0.99 时，Windows 给的
    //   源地址仍然是 127.0.0.1 —— 实测，日志里照样记在 127.0.0.1 这个桶里）。
    //   正确的杠杆是 **cf-connecting-ip**：回环来源 + 这个头，正是隧道流量的形状
    //   （见 routes.clientIpOf）。每次跑随机取一个文档保留段里的地址
    //   （198.51.100.x / RFC 5737），永远不会撞上真地址，也就永远不会锁到别人。
    const THROWAWAY_IP = '198.51.100.' + (1 + Math.floor(Math.random() * 254));
    const wrong = await request({
      path: '/pair?code=000000', hostHeader: `127.0.0.1:${PORT}`,
      headers: { 'cf-connecting-ip': THROWAWAY_IP }
    });
    ok('错配对码 → 403 且有一句能看懂的话',
      wrong.status === 403 && wrong.body.length > 40 && !/^[{[]/.test(wrong.body),
      `status=${wrong.status} body=${wrong.body.slice(0, 60)}`);
    const huge = await request({
      path: '/pair?code=' + '9'.repeat(5000), hostHeader: `127.0.0.1:${PORT}`,
      headers: { 'cf-connecting-ip': THROWAWAY_IP }
    });
    ok('超长配对码不会把服务打崩（403 或 431，不是 5xx）',
      huge.status < 500 && huge.status !== 0, `status=${huge.status}`);

    if (!PAIR_CODE) {
      skip('A3 正确配对码走完流程', '读不到 logs/pair-code.txt');
    } else {
      const good = await request({
        path: '/pair?code=' + encodeURIComponent(PAIR_CODE),
        hostHeader: `127.0.0.1:${PORT}`,
        headers: { 'x-dsh-selfcheck': '1' }
      });
      const pairCookie = (good.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
      ok('正确配对码 → 200 并种下会话 cookie',
        good.status === 200 && pairCookie.length > 10, `status=${good.status} cookie=${pairCookie.slice(0, 20)}`);
      ok('配对成功后是往应用里跳（meta refresh / 302），不会停在空白页',
        /http-equiv='refresh'|http-equiv="refresh"|location/i.test(good.body),
        good.body.slice(0, 90));
      // 配对后拿到的那条路能不能用 —— 这才是「配对完了有没有用」
      const after = await request({
        path: '/__routes', hostHeader: `127.0.0.1:${PORT}`,
        headers: { cookie: pairCookie, 'x-dsh-selfcheck': '1' }
      });
      ok('配对后的 cookie 能直接打开应用（/__routes 200）',
        after.status === 200, `status=${after.status}`);
      const cj = (() => { try { return JSON.parse(after.body); } catch (err) { return null; } })();
      ok('配对后拿到的是「从这个地址进来」的候选路径',
        !!cj && !!cj.arrival && !!cj.arrival.authority, JSON.stringify(cj && cj.arrival));
    }
  }

  section('A4 坏密钥 / 超长密钥 / 错误密钥');
  {
    const wrong = await request({ path: '/k/WRONGKEYWRONGKEY', hostHeader: `127.0.0.1:${PORT}` });
    ok('错密钥 → 403 且正文里说清「需要访问密钥」',
      wrong.status === 403 && wrong.body.length > 10, `status=${wrong.status} body=${wrong.body.slice(0, 60)}`);
    const empty = await request({ path: '/k/', hostHeader: `127.0.0.1:${PORT}` });
    ok('空密钥 → 403（不是 200 的假页面，也不是 500）',
      empty.status === 403, `status=${empty.status}`);
    const huge = await request({ path: '/k/' + 'A'.repeat(20000), hostHeader: `127.0.0.1:${PORT}` });
    ok('超长密钥不会打崩服务（403/414/431，不是 5xx）',
      huge.status < 500 && huge.status !== 0, `status=${huge.status}`);
    const weird = await request({
      path: '/k/' + encodeURIComponent('a b+c/d?e#f\u0000'),
      hostHeader: `127.0.0.1:${PORT}`
    });
    ok('特殊字符密钥被拒且不崩', weird.status === 403 || weird.status < 500, `status=${weird.status}`);

    for (const bad of ['#k=', '#k=   ', '#k=' + 'a'.repeat(15)]) {
      const r = clientSecretFor(bad, null);
      ok(`${JSON.stringify(bad.slice(0, 8))} 后面是空/太短 → 当作没有密钥（会明确提示）`, !r.secret);
    }
    // 错误密钥（长度合法但内容不对）在服务端必须**显式拒绝**，不能 200 静默
    if (!E2EE_SECRET) {
      skip('A4 错误密钥在服务端的表现', '本机没配加密密钥，服务端解不了也拒不了');
    } else {
      const oldSecret = 'OLDSECRETOLDSECRETOLDSECRET';
      const ct = e2ee.encrypt(e2ee.deriveKeys(oldSecret, e2ee.slotAt()).a, Buffer.from('{"x":1}'));
      const r = await request({
        method: 'POST', path: '/codex/queue',
        headers: relayHeaders(Object.assign({
          'content-type': 'application/octet-stream',
          'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json'
        }, AUTH)),
        body: ct
      });
      ok('用错密钥加密的请求体 → 服务端显式拒绝（400 + 一句人话，不是 200 静默）',
        r.status === 400 && r.body.length > 10, `status=${r.status} body=${r.body.slice(0, 80)}`);
      ok('拒绝时说明了「明文不会走中继」这类可执行的话',
        /解密|明文|重试/.test(r.body), r.body.slice(0, 80));
      const ultra = 'Z'.repeat(4000);
      const ct2 = e2ee.encrypt(e2ee.deriveKeys(ultra, e2ee.slotAt()).a, Buffer.from('{}'));
      const r2 = await request({
        method: 'POST', path: '/codex/queue',
        headers: relayHeaders(Object.assign({
          'content-type': 'application/octet-stream',
          'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json'
        }, AUTH)),
        body: ct2
      });
      ok('超长密钥加出来的密文同样被显式拒绝', r2.status === 400, `status=${r2.status}`);
      const truncated = await request({
        method: 'POST', path: '/codex/queue',
        headers: relayHeaders(Object.assign({
          'content-type': 'application/octet-stream',
          'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json'
        }, AUTH)),
        body: Buffer.from('short')
      });
      ok('截断/垃圾密文被显式拒绝（不带异常栈出来）',
        truncated.status === 400 && !/at Object|Error:/.test(truncated.body),
        `status=${truncated.status} body=${truncated.body.slice(0, 60)}`);
    }
  }

  section('A5 #k= 重复两次 —— 消费方会不会把坏输入咽下去');
  {
    if (!E2EE_SECRET) {
      skip('A5 #k= 重复两次', '本机没配加密密钥');
    } else {
      const doubled = `#k=${E2EE_SECRET}#k=${E2EE_SECRET}`;
      const r = clientSecretFor(doubled, null);
      ok('双份 #k= 解析出来的密钥里不能再夹着 "#"（夹着就说明整段被当成了密钥）',
        !r.secret || !/#/.test(r.secret),
        `解析出 ${r.secret ? r.secret.length + ' 字符: ' + JSON.stringify(r.secret.slice(0, 24)) + '…' : 'null'}`);
      ok('解析不出唯一一把密钥时，必须当成「没有密钥」而不是硬用一段坏字符串',
        !r.secret, `实际给了 ${r.secret ? r.secret.length + ' 字符的坏密钥' : 'null'}`);

      // 这个坏密钥会带来什么后果：拿它去解网关真正发的密文
      const wrong = clientSecretFor(doubled, null).secret || '';
      const ct = e2ee.encrypt(e2ee.deriveKeys(E2EE_SECRET, e2ee.slotAt()).b, Buffer.from('{"type":"snapshot"}'));
      ok('网关的密文用真密钥解得开（对照组）',
        !!e2ee.decrypt(e2ee.deriveKeys(E2EE_SECRET, e2ee.slotAt()).b, ct));
      ok('用双份 #k= 解析出的密钥解不开（= 手机看到的是「连上了但什么都不来」）',
        !e2ee.decrypt(e2ee.deriveKeys(wrong, e2ee.slotAt()).b, ct),
        `那把坏密钥长 ${wrong.length} 字符`);

      // 而闸门是认「带了 e2ee=1」的，所以这条坏链接照样能拿到 101
      const ws = await wsProbe('/api/remote.mux?e2ee=1',
        Object.assign({ cookie, 'x-dsh-selfcheck': '1' }, relayHeaders()),
        { waitMs: 6000 });
      ok('带 e2ee=1 的坏密钥链接照样能拿到 101（所以失败一定是静默的）',
        /^HTTP\/1\.1 101/.test(ws.statusLine), ws.statusLine);
      if (ws.firstData) {
        const decrypted = e2ee.decrypt(e2ee.deriveKeys(E2EE_SECRET, e2ee.slotAt()).b, ws.firstData.payload) ||
          e2ee.decrypt(e2ee.deriveKeys(E2EE_SECRET, e2ee.slotAt() - 1).b, ws.firstData.payload);
        ok('第一帧确实是密文，且只有真密钥解得开（坏密钥的持有者只会看到「连上了没反应」）',
          !!decrypted, `帧 ${ws.firstData.payload.length} 字节，真密钥解出 ${decrypted ? decrypted.length + ' 字节' : 'null'}`);
      } else {
        skip('A5 第一帧取证',
          'DSH 要等客户端先开口才会推快照，而这个测试不往 DSH 发任何东西（发了就可能建状态），所以这里拿不到数据帧');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  B. 日常往返
  // ══════════════════════════════════════════════════════════════════════
  section('B1 同一个链接连开 3 次 —— 会不会互相顶掉');
  {
    const opens = [];
    for (let i = 0; i < 3; i++) {
      opens.push(await request({
        path: '/k/' + encodeURIComponent(ACCESS_KEY),
        hostHeader: `127.0.0.1:${PORT}`,
        headers: { 'x-dsh-selfcheck': '1' }
      }));
    }
    //  契约变了（见上面登录那条的说明）：现在不跳转，所以不再要求 302。
    //  真正要守的是「连开 3 次每次都能拿到一个可用的会话」—— 每次都 200
    //  且每次都发了 set-cookie。原来钉 302，红得没道理。
    ok('同一个链接连开 3 次都能进（每次都能拿到会话）',
      opens.every((o) => o.status === 200 && (o.headers['set-cookie'] || []).length > 0),
      opens.map((o) => `${o.status}/cookie=${(o.headers['set-cookie'] || []).length}`).join('  '));
    const cookies = opens.map((o) => (o.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; '));
    ok('3 次拿到的凭据是同一份（同一台设备不该被拆成 3 台）',
      new Set(cookies).size === 1, `${new Set(cookies).size} 份不同的 cookie`);
    const reused = [];
    for (let i = 0; i < 3; i++) {
      reused.push(await request({
        path: '/__routes', hostHeader: `127.0.0.1:${PORT}`,
        headers: { cookie: cookies[0], 'x-dsh-selfcheck': '1' }
      }));
    }
    ok('连开 3 次之后第 1 次拿到的会话仍然有效（没有互相顶掉）',
      reused.every((r) => r.status === 200), reused.map((r) => r.status).join(','));

    // 「设备令牌只认最近几张」是个会咬人的参数：连开次数超过它，最早的页面就被顶掉
    const sessionsSrc = fs.readFileSync(path.join(BASE, 'scripts', 'sessions.js'), 'utf8');
    const keep = Number((sessionsSrc.match(/KEEP_FINGERPRINTS\s*=\s*(\d+)/) || [])[1]);
    ok('保留的设备令牌份数 ≥ 3（否则「连开 3 次」就会把第一个页面顶下线）',
      Number.isFinite(keep) && keep >= 3, `KEEP_FINGERPRINTS=${keep}`);

    // 现场设备表：同一台设备不该有多条活记录（merge 逻辑退化的直接证据）
    const active = sessions.list().filter((d) => !d.revoked);
    const byUa = new Map();
    for (const d of active) {
      if (!d.ua) continue;
      byUa.set(d.ua, (byUa.get(d.ua) || 0) + 1);
    }
    const dupes = [...byUa.entries()].filter(([, n]) => n > 1);
    ok('现场设备表里没有「同一台设备被登记成多条活记录」',
      dupes.length === 0, dupes.map(([ua, n]) => `${String(ua).slice(0, 24)}… ×${n}`).join(' | '));
    note(`现场设备 ${active.length} 台，其中带 UA 的 ${[...byUa.keys()].length} 种`);
    skip('B1「真机连开 3 次各自独立」', '真机连开会在设备表里登记设备，这个测试不碰使用者的设备列表');
  }

  section('B2 手机在外面（走隧道）vs 在家里（内网 IP）');
  {
    // 在外面：Host 是隧道域名，socket 是回环（cloudflared 转的）—— 真实形状就是这样
    const away = await request({
      path: '/__routes', headers: relayHeaders(Object.assign({}, AUTH))
    });
    let awayJson = null;
    try { awayJson = JSON.parse(away.body); } catch (err) { /* 下面报 */ }
    ok('4G（Host=隧道域名）进来：/__routes 能用',
      away.status === 200 && !!awayJson, `status=${away.status} body=${away.body.slice(0, 80)}`);
    ok('网关认得出这一趟是经隧道进来的',
      !!awayJson && awayJson.arrival && awayJson.arrival.kind === 'tunnel',
      awayJson ? JSON.stringify(awayJson.arrival) : '(无解析结果)');
    ok('经隧道进来时，浏览器拦混合内容这件事被如实标注',
      !!awayJson && Array.isArray(awayJson.mixedContentBlocked) && awayJson.mixedContentBlocked.length >= 1,
      awayJson ? JSON.stringify(awayJson.mixedContentBlocked) : '');

    // 在家里：连内网地址、Host 也是内网地址
    if (!LAN_IP) {
      skip('B2 在家（内网）那条路', '这台机器没有内网 IPv4 地址');
    } else {
      const home = await request({
        path: '/__routes', connectHost: LAN_IP, hostHeader: `${LAN_IP}:${PORT}`,
        headers: AUTH
      });
      let homeJson = null;
      try { homeJson = JSON.parse(home.body); } catch (err) { /* 下面报 */ }
      ok('在家（Host=内网 IP）进来：/__routes 能用',
        home.status === 200 && !!homeJson, `status=${home.status}`);
      ok('网关认得出这一趟是从内网进来的',
        !!homeJson && homeJson.arrival && homeJson.arrival.kind === 'lan',
        homeJson ? JSON.stringify(homeJson.arrival) : '(无解析结果)');
    }

    // 两条路都得真能连上 —— 不是「列出来了」就算
    const cands = (awayJson && awayJson.candidates) || [];
    ok('候选路径里同时有隧道和内网两条（不然「两条路」是假的）',
      cands.some((c) => c.kind === 'tunnel') && cands.some((c) => c.kind === 'lan'),
      cands.map((c) => c.kind).join(','));

    for (const c of cands) {
      if (c.kind === 'ipv6') { skip(`B2 探测 ${c.kind}（${c.authority}）`, '本机访问自己的公网 IPv6 走回环，测出来的「通」不代表外面能连进来'); continue; }
      if (c.kind === 'lan-https') continue;      // 下面单独说
      const p = await probeWithRetry(c.origin, 15000);
      const problem = entryUsabilityProblem(p);
      ok(`候选「${c.label}」(${c.authority}) 现在真的连得上`,
        !problem, problem ? `${problem}${c.selfTestOnly ? '（selfTestOnly）' : ''}` : `${p.ms}ms`);
    }

    // 内网 HTTPS：证书没被信任过，自动切换**必须**避开它（缺陷 #4 的回归）
    const lanHttps = cands.find((c) => c.kind === 'lan-https');
    if (!lanHttps) {
      skip('B2 内网 HTTPS 候选', '这台机器没开内网 HTTPS');
    } else {
      const strict = await tunnel.probeUrl(lanHttps.origin, 12000);
      const relaxed = await request({ path: '/__probe', https: true, connectHost: LAN_IP, port: HTTPS_PORT, hostHeader: `${LAN_IP}:${HTTPS_PORT}` });
      note(`内网 HTTPS：校验证书时 ${strict.ok ? '通过' : '失败（' + (strict.error || 'HTTP ' + strict.status) + '）'}；` +
        `不校验证书时 HTTP ${relaxed.status}`);
      ok('内网 HTTPS 被标注成「需要先信任证书」',
        lanHttps.needsCertTrust === true, JSON.stringify({ needsCertTrust: lanHttps.needsCertTrust }));
      const routeSrc = fs.readFileSync(path.join(BASE, 'pwa', 'route.js'), 'utf8');
      ok('自动切换把 lan-https 排除在外（否则手机会被送去一整页证书错误，比不切还糟）',
        /kind\s*!==\s*'lan-https'/.test(routeSrc) && /safe\[0\]/.test(routeSrc),
        'route.js 里找不到「自动切换排除 lan-https」的那一段');
    }
  }

  section('B3 短时间大量请求 —— 会不会被限速误伤');
  {
    const burst = [];
    for (let i = 0; i < 40; i++) burst.push(request({ path: '/__probe?_=' + i, hostHeader: `127.0.0.1:${PORT}` }));
    for (let i = 0; i < 12; i++) {
      burst.push(request({ path: '/__routes', hostHeader: `127.0.0.1:${PORT}`, headers: AUTH }));
    }
    const t0 = Date.now();
    const res = await Promise.all(burst);
    const ms = Date.now() - t0;
    const codes = {};
    for (const r of res) codes[r.status] = (codes[r.status] || 0) + 1;
    ok('52 个并发请求里没有一个 429（正常刷页面不会被自己的限速误伤）',
      !codes['429'], JSON.stringify(codes));
    ok('52 个并发请求里没有一个 5xx', !Object.keys(codes).some((c) => Number(c) >= 500), JSON.stringify(codes));
    ok('52 个并发请求全部有响应（没有挂死/超时）',
      !codes['0'], JSON.stringify(codes));
    note(`52 个请求总耗时 ${ms}ms（${(ms / 52).toFixed(0)}ms/个）`);
    skip('B3 把限速桶打满看会不会 429', '挑战应答的桶是 120 次/分钟，打满会把使用者自己的手机锁在门外一分钟');
  }

  // ══════════════════════════════════════════════════════════════════════
  //  C. 地址/密钥变更
  // ══════════════════════════════════════════════════════════════════════
  section('C1 现在发出去的每一条地址，现在就必须能用');
  {
    const console_ = await request({ path: '/__console/status', hostHeader: `127.0.0.1:${PORT}` });
    let cj = null;
    try { cj = JSON.parse(console_.body); } catch (err) { /* 下面报 */ }
    ok('/__console/status 能读到（控制台复制的就是这里的地址）',
      console_.status === 200 && !!cj, `status=${console_.status}`);

    if (!cj) {
      skip('C1 地址一致性', '拿不到 /__console/status');
    } else {
      const entries = cj.entries || {};
      const all = [entries.wan].concat(entries.lan || [], entries.lanHttps || []).filter(Boolean);
      ok('控制台给出了至少一条地址', all.length > 0, JSON.stringify(entries));

      // ① 地址里必须带且只带一份 #k=，而且必须是**那把真能解密的**密钥。
      //
      //    这一条是整个文件里最值钱的一条：拿控制台**真正复制出去的那把钥匙**
      //    去解网关**真正发出的那段密文**。解不开就说明使用者手里的链接是死的 ——
      //    而且他看到的会是「页面能开、对话列表永远空」，界面上一个字都没有。
      let realKey = null;
      let keyEvidence = '没配加密密钥';
      const consoleKey = (() => {
        const m = String(entries.wan || (entries.lan || [])[0] || '').match(/#k=([^#&]+)/);
        return m ? m[1] : null;
      })();
      if (!E2EE_SECRET) {
        note('本机没配加密密钥 —— 「链接里的钥匙能不能解开网关的密文」这一条跳过');
      } else if (!consoleKey) {
        note('控制台给的地址里没有 #k=（下面 keyFragmentProblems 会报出来）');
      } else {
        const enc = await request({
          path: '/codex/threads', headers: relayHeaders(Object.assign({ 'x-dsh-e2ee': '1' }, AUTH))
        });
        if (enc.status !== 200 || enc.headers['x-dsh-e2ee'] !== '1') {
          keyEvidence = `拿不到加密响应（status=${enc.status} x-dsh-e2ee=${enc.headers['x-dsh-e2ee']}）`;
        } else {
          const slot = e2ee.slotAt();
          let plain = null;
          for (const s of [slot, slot - 1]) {
            plain = e2ee.decrypt(e2ee.deriveKeys(consoleKey, s).b, enc.raw);
            if (plain) break;
          }
          realKey = plain ? consoleKey : null;
          keyEvidence = plain
            ? `用链接里的 #k= 解开了 ${plain.length} 字节（${slot} 或 ${slot - 1} 时段）`
            : `解不开：链接里那把钥匙不对（密文 ${enc.raw.length} 字节）`;
        }
      }
      for (const e of all) {
        const problems = keyFragmentProblems(e, E2EE_SECRET || null);
        ok(`地址 ${e.replace(/#k=.*/, '#k=…')} 的密钥片段没问题`, problems.length === 0, problems.join(' / '));
      }
      if (E2EE_SECRET && consoleKey) {
        ok('控制台给的 #k= 就是网关真正用来加密的那把（对不上手机就是「能开、对话全空」）',
          realKey === consoleKey, keyEvidence);
      }

      // ② 每条地址现在真的连得上（缺陷 #2：复制出去的是死链）
      for (const e of all) {
        let origin;
        try { origin = new URL(e).origin; } catch (err) { ok(`地址 ${e} 能解析`, false, '解析不了'); continue; }
        if (/^https:\/\/(\d|\[)/.test(origin)) {
          const strict = await tunnel.probeUrl(origin, 12000);
          note(`内网 HTTPS 地址 ${origin}：${strict.ok ? '可探测' : '证书未信任（' + (strict.error || '') + '）'} —— 手机没装过本机 CA 时这是预期的`);
          continue;
        }
        const p = await probeWithRetry(origin, 15000);
        const problem = entryUsabilityProblem(p);
        ok(`地址 ${origin} 现在真的连得上（复制出去就能用）`,
          !problem, problem || `${p.ms}ms`);
      }

      // ③ 控制台里的隧道域名必须和守护进程记的那份一致
      const liveWan = (entries.wan || '').replace(/\/k\/.*$/, '');
      const statusWan = (STATUS.tunnel && STATUS.tunnel.url) || '';
      ok('控制台的公网地址与 status.json 里的隧道地址一致（两份数据源不能各说各话）',
        !!liveWan && !!statusWan && liveWan === statusWan, `控制台=${liveWan} status.json=${statusWan}`);
    }
  }

  section('C2 换地址之后：旧链接必须明确失败，新地址的恢复路径要指着新地址');
  {
    // 旧隧道地址：logs/手机地址.txt 是历史上真正交给过使用者的那份
    const oldHost = (() => { try { return new URL(OLD_PHONE_URL).host; } catch (err) { return null; } })();
    if (!oldHost) {
      skip('C2 旧隧道地址必须失败', 'logs/手机地址.txt 里没有可解析的旧地址');
    } else if (oldHost === TUNNEL_HOST) {
      note(`旧地址和现行地址是同一个（${oldHost}）—— 没换过地址，这一条没有可测的旧地址`);
    } else {
      const p = await tunnel.probeUrl('https://' + oldHost, 15000);
      ok('旧隧道地址（' + oldHost + '）现在明确失败 —— 不是一个「看起来能打开」的页面',
        !p.ok, `意外地还能通：HTTP ${p.status} ${p.ms}ms`);
      note(`旧地址探测结果：${p.ok ? 'HTTP ' + p.status : (p.error || 'HTTP ' + p.status)}`);
    }

    // 旧访问密钥：仓库根 current-url.txt 里那个
    const oldKey = (() => {
      const m = String(ROOT_URL).match(/\/k\/([^#/?]+)/);
      return m ? m[1] : null;
    })();
    if (!oldKey) {
      skip('C2 旧访问密钥必须失败', 'current-url.txt 里没有 /k/<密钥>');
    } else if (oldKey === ACCESS_KEY) {
      note(`current-url.txt 里的密钥就是现行密钥 —— 不用测「旧密钥」`);
    } else {
      const r = await request({ path: '/k/' + encodeURIComponent(oldKey), hostHeader: `127.0.0.1:${PORT}` });
      ok('旧访问密钥（current-url.txt 里那个）明确失败：403 + 人话，不是 200 的假页面',
        r.status === 403 && r.body.length > 10, `status=${r.status} body=${r.body.slice(0, 60)}`);
      note('current-url.txt 是仓库根那份「当前地址」，里面的密钥已经不是现行的了 —— 谁也不该再照它念地址');
    }

    // 旧加密密钥：换过钥匙之后，旧 #k= 必须解不开新密文
    const oldSecret = (() => {
      const m = String(OLD_PHONE_URL).match(/#k=([^#&]+)/);
      return m ? m[1] : null;
    })();
    if (!E2EE_SECRET) {
      skip('C2 旧加密密钥必须失败', '本机没配加密密钥');
    } else if (!oldSecret || oldSecret === E2EE_SECRET) {
      skip('C2 旧加密密钥必须失败', oldSecret ? '历史地址里的密钥与现行相同（没换过钥匙）' : '历史地址里没有 #k=');
    } else {
      const slot = e2ee.slotAt();
      const ct = e2ee.encrypt(e2ee.deriveKeys(E2EE_SECRET, slot).b, Buffer.from('{"type":"snapshot"}'));
      ok('旧加密密钥解不开现在的密文（换钥匙之后旧书签必然失效，且是拒绝而不是明文回退）',
        !e2ee.decrypt(e2ee.deriveKeys(oldSecret, slot).b, ct) &&
        !e2ee.decrypt(e2ee.deriveKeys(oldSecret, slot - 1).b, ct));
      const r = await request({
        method: 'POST', path: '/codex/queue',
        headers: relayHeaders(Object.assign({
          'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/json'
        }, AUTH)),
        body: e2ee.encrypt(e2ee.deriveKeys(oldSecret, slot).a, Buffer.from('{"x":1}'))
      });
      ok('用旧钥匙加密的请求体被服务端显式拒绝（旧手机不会「静默半死」）',
        r.status === 400, `status=${r.status}`);
    }

    // 换地址之后手机靠什么回来：恢复票据必须指着**现在**这个隧道地址
    const rec = await request({ path: '/__recover', hostHeader: `127.0.0.1:${PORT}`, headers: { 'x-dsh-selfcheck': '1' } });
    let rj = null;
    try { rj = JSON.parse(rec.body); } catch (err) { /* 下面报 */ }
    if (rec.status === 503) {
      ok('没有隧道时 /__recover 如实说「还没有隧道地址」，不伪造一个',
        !!rj && rj.ok === false && /隧道/.test(String(rj.error)), rec.body.slice(0, 80));
      skip('C2 恢复票据指向新地址', '现在没有隧道地址');
    } else {
      ok('/__recover 能签出恢复票据', rec.status === 200 && !!rj && rj.ok === true, rec.body.slice(0, 100));
      if (rj && rj.ok) {
        ok('恢复票据指向的就是**当前**隧道地址（指着旧地址 = 手机拿到一条死链）',
          rj.authority === TUNNEL_HOST, `票据 authority=${rj.authority} 现行=${TUNNEL_HOST}`);
        const frag = String(rj.url).match(/#k=/g) || [];
        ok('恢复链接里不会夹带密钥片段（它是给推送用的，改成明文地址反而更危险）',
          frag.length === 0, `出现了 ${frag.length} 份 #k=`);
        ok('恢复票据的有效期是按「人可能几小时后才看到推送」设计的（> 1 小时）',
          Number(rj.expiresInSec) > 3600, `${rj.expiresInSec} 秒`);
        skip('C2 真的去兑换这张恢复票据', '兑换会给最近活跃的那台真机重新签发令牌并改写它的 authority —— 不碰使用者的设备');
      }
    }
  }

  section('C3 换地址的 15~20 秒空窗期有没有被封住');
  {
    const consoleSrc = fs.readFileSync(path.join(BASE, 'pwa', 'console.html'), 'utf8');
    ok('换地址期间所有「复制」入口都被挡住（堵在 copy() 这唯一出口上）',
      /function copy\(/.test(consoleSrc) && /addressChanging/.test(consoleSrc.slice(consoleSrc.indexOf('function copy('), consoleSrc.indexOf('function copy(') + 900)));
    const totalWrites = (consoleSrc.match(/\.writeText\s*\(/g) || []).length;
    const copyBody = consoleSrc.slice(consoleSrc.indexOf('function copy('), consoleSrc.indexOf('function fallbackCopy('));
    const insideWrites = (copyBody.match(/\.writeText\s*\(/g) || []).length;
    ok('没有绕过 copy() 直接写剪贴板的第二个出口',
      totalWrites > 0 && totalWrites === insideWrites, `全文件 ${totalWrites} 处，copy() 里 ${insideWrites} 处`);
    ok('换地址时比的是「域名变了」而不是「整串变了」（不然密钥一变就提前放开复制）',
      /ignoreKey/.test(consoleSrc) && /replace\(\/#\.\*\$\//.test(consoleSrc));

    const tries = Number((consoleSrc.match(/tries\s*>\s*(\d+)/) || [])[1]);
    const pollMs = Number((consoleSrc.match(/setTimeout\(tick\s*,\s*(\d+)\)/) || [])[1]);
    ok('等新地址的总时长 ≥ 20 秒（隧道边缘生效就要十几秒，等太短会让人复制到旧地址）',
      Number.isFinite(tries) && Number.isFinite(pollMs) && tries * pollMs >= 20000,
      `tries>${tries} × ${pollMs}ms = ${tries * pollMs}ms`);
    skip('C3 实测「换地址后新地址多久可用」',
      '实测必须真的换一次地址（会作废使用者手机里的书签），这个测试不动隧道');
    const tn = await tunnel.probeUrl((STATUS.tunnel && STATUS.tunnel.url) || '', 15000);
    if (tn.ok) note(`参考：当前隧道 /__probe 往返 ${tn.ms}ms（换完之后头几秒通常还要等边缘生效）`);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  D. 故障恢复
  // ══════════════════════════════════════════════════════════════════════
  section('D1 隧道不通时，界面/接口要如实说「不通」');
  {
    const cs = await request({ path: '/__console/status', hostHeader: `127.0.0.1:${PORT}` });
    let cj = null;
    try { cj = JSON.parse(cs.body); } catch (err) { /* 下面报 */ }
    if (!cj || !cj.tunnel) {
      ok('控制台给得出隧道状态', false, `status=${cs.status}`);
      skip('D1 隧道状态一致性', '拿不到 console.tunnel');
    } else {
      const problems = tunnelStateProblems(cj.tunnel);
      ok('隧道状态不自相矛盾（说「公网可达」就不能同时带着失败原因）',
        problems.length === 0, problems.join(' / '));
      note(`running=${cj.tunnel.running} reachable=${cj.tunnel.reachable} probeError=${cj.tunnel.probeError} provider=${cj.tunnel.provider}`);

      const url = cj.tunnel.url;
      if (!url) {
        skip('D1 独立复核「公网到底通不通」', '没有隧道地址');
      } else {
        const mine = await tunnel.probeUrl(url, 15000);
        if (cj.tunnel.reachable === true) {
          ok('接口说「公网可达」时，我独立去探也必须真的通（不能报喜不报忧）',
            mine.ok, `我探到：${mine.ok ? 'HTTP ' + mine.status : (mine.error || 'HTTP ' + mine.status)}`);
        } else if (cj.tunnel.reachable === false) {
          ok('接口说「公网不通」时确实不通（不能报忧不报喜）',
            !mine.ok, `我探到 HTTP ${mine.status}`);
        } else {
          note('接口这轮没探测（reachable=null）—— 界面上会写「本轮未探测」，不算报成功');
        }
        const consoleSrc = fs.readFileSync(path.join(BASE, 'pwa', 'console.html'), 'utf8');
        ok('控制台真的有「公网不通 / 没有外网入口 / 本轮未探测」这三种说法（不是只有一句「正常」）',
          /公网不通/.test(consoleSrc) && /没有外网入口/.test(consoleSrc) && /本轮未探测/.test(consoleSrc));
      }
    }

    // 已经知道不通的东西，不能再被当成「能用」发出去
    const probeState = readJson(path.join(LOG_DIR, 'tunnel-probe.json')) || {};
    if (Number(probeState.fails) > 0 && STATUS.tunnel && STATUS.tunnel.url) {
      const mine = await tunnel.probeUrl(STATUS.tunnel.url, 15000);
      ok('连续探测失败期间，公网条目仍然不能被当成「能用」',
        !mine.ok || Number(probeState.fails) === 0,
        `probe 失败计数 ${probeState.fails}，但我探到 ${mine.ok ? 'HTTP ' + mine.status : '不通'}`);
    } else {
      note(`隧道探测失败计数 ${probeState.fails || 0}（没有失败记录，跳过「失败期间」那一条）`);
    }
  }

  section('D2 公网地址必须正常形式 —— 绝不能是 Cloudflare 的服务端点');
  {
    // 内存构造：这条断言必须能认出缺陷 #3 里那个假地址
    ok('公网地址形式判定本身有效（api.trycloudflare.com 会被认出来）',
      !!publicHostProblem('https://api.trycloudflare.com/tunnel'));

    const candidates = [
      ['status.json 的隧道地址', STATUS.tunnel && STATUS.tunnel.url],
      ['status.json 的 wan 条目', STATUS.entries && STATUS.entries.wan],
      ['logs/last-tunnel-url.txt', readText(path.join(LOG_DIR, 'last-tunnel-url.txt'))]
    ];
    for (const [label, u] of candidates) {
      if (!u) { skip(`D2 ${label}`, '这份文件/字段现在没有内容'); continue; }
      const problem = publicHostProblem(u);
      ok(`D2 ${label} 是正常的隧道地址`, !problem, problem || '');
    }

    // 真实回归数据：cloudflared 自己的错误日志里就有那个服务端点
    const errLog = readText(path.join(LOG_DIR, 'cloudflared.err.log')) || '';
    const apiHits = errLog.split(/\r?\n/).filter((l) => /api\.trycloudflare\.com/.test(l));
    if (!apiHits.length) {
      note('cloudflared 的错误日志里现在没有 api.trycloudflare.com 那种行（没法拿真实样本回归）');
    } else {
      const extracted = tunnel.extractPublicUrl(apiHits.join('\n'));
      ok('从真实的 cloudflared 报错正文里解析隧道地址时，不会把 api.trycloudflare.com 当成地址',
        extracted === null || publicHostProblem(extracted) === null,
        `解析出 ${JSON.stringify(extracted)} ← ${apiHits[0].slice(0, 90)}`);
    }
    for (const txt of [
      'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded',
      'https://www.trycloudflare.com', 'https://dash.trycloudflare.com'
    ]) {
      const got = tunnel.extractPublicUrl(txt);
      ok(`解析器不吃服务端点：${txt.slice(0, 46)}…`, got === null || publicHostProblem(got) === null,
        `返回了 ${JSON.stringify(got)}`);
    }
  }

  section('D3 隧道进程数与「正在跑的隧道」要一致（不能有孤儿）');
  {
    let pids = null;
    try {
      const { execFileSync } = require('child_process');
      const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'cloudflared.exe\'" | ' +
        'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress';
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
      let list = [];
      if (out) list = JSON.parse(out);
      pids = tunnel.ownTunnelPids(list, BASE);
    } catch (err) { pids = null; }

    if (pids === null) {
      skip('D3 隧道进程数', '这台机器上枚举不了进程');
    } else {
      note(`属于本项目的 cloudflared 进程：${pids.length} 个 ${pids.length ? '(' + pids.join(', ') + ')' : ''}`);
      ok('至多一条自己的隧道在跑（多出来的那条没人追踪，是一个谁都不知道的公网入口）',
        pids.length <= 1, `发现 ${pids.length} 条`);
      const running = STATUS.tunnel ? STATUS.tunnel.running : null;
      if (pids.length === 1) {
        ok('隧道进程在跑时，status 必须说 running=true（不能反过来漏报）',
          running === true, `running=${running}`);
      } else if (running === true) {
        skip('D3 进程数与 running 一致',
          'status 说 running=true 但没有属于本项目的 cloudflared 进程 —— running 的判据里含「|| 有地址」（源码里注明是有意偏保守），不做断言');
      } else {
        note('现在没有隧道在跑，status 也没说在跑 —— 一致');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  E. 边界
  // ══════════════════════════════════════════════════════════════════════
  section('E1 空数据 / 超长 / 特殊字符');
  {
    const cases = [
      ['空 to', '/__switch?to=', 404],
      ['路径穿越 + NUL', '/__switch?to=' + encodeURIComponent('../../etc/passwd\u0000'), 404],
      ['纯特殊字符', '/__switch?to=' + encodeURIComponent('!@#$%^&*()_+{}|:"<>?~`'), 404],
      ['超长 to（30k）', '/__switch?to=' + 'a'.repeat(30000), 431]
    ];
    for (const [name, p, want] of cases) {
      const r = await request({ path: p, hostHeader: `127.0.0.1:${PORT}`, headers: AUTH });
      ok(`/__switch ${name} → ${want}，不是 5xx 也不是挂起`,
        r.status === want || (r.status >= 400 && r.status < 500 && r.body !== 'TIMEOUT'),
        `status=${r.status} body=${r.body.slice(0, 60)}`);
    }
    const emptyTo = await request({ path: '/__switch?to=', hostHeader: `127.0.0.1:${PORT}`, headers: AUTH });
    ok('空 to 的响应是能解析的 JSON（界面能照着说人话）',
      (() => { try { const j = JSON.parse(emptyTo.body); return j.ok === false && !!j.error; } catch (err) { return false; } })(),
      emptyTo.body.slice(0, 80));

    const badBody = await request({
      method: 'POST', path: '/codex/queue',
      headers: relayHeaders(Object.assign({ 'x-dsh-queue': '1', 'content-type': 'application/json' }, AUTH)),
      body: '{"threadId":'
    });
    ok('坏 JSON 的队列请求 → 4xx 且不把异常栈吐出来',
      badBody.status >= 400 && badBody.status < 500 && !/at Object|at Module|Error:/.test(badBody.body),
      `status=${badBody.status} body=${badBody.body.slice(0, 70)}`);
    const hugeBody = await request({
      method: 'POST', path: '/codex/queue',
      headers: relayHeaders(Object.assign({ 'x-dsh-queue': '1', 'content-type': 'application/json' }, AUTH)),
      body: '{"threadId":"t","action":"enqueue","input":[{"type":"text","text":"' + 'x'.repeat(200000) + '"}]}'
    });
    ok('超大请求体 → 4xx（不会把内存吃光，也不会真的入队）',
      hugeBody.status >= 400 && hugeBody.status < 500, `status=${hugeBody.status}`);

    const weirdPath = await request({ path: '/%00%01%02', hostHeader: `127.0.0.1:${PORT}`, headers: AUTH });
    ok('畸形路径不会 5xx', weirdPath.status < 500 && weirdPath.status !== 0, `status=${weirdPath.status}`);
  }

  section('E2 两种「门」各管什么 —— 未认证访问必须被挡，而且挡对了地方');
  {
    // ── 这里有两道**完全不同**的门，不能混为一谈 ──────────────────────────
    //
    //   ① 回环门（isLoopback）—— 管 /console、/__console/status、/__console/action、
    //      /__health 这些「管理面」。它判的是**这条连接是不是本机来的**，
    //      和有没有 cookie 无关：本机打开控制台本来就不需要登录。
    //      ⚠ 这个判定最容易被自己骗到：隧道流量**也是从 127.0.0.1 进来的**
    //      （cloudflared 就跑在这台机器上），只看 socket 地址等于把管理面
    //      连同 access-key 和 e2ee-secret 一起交给公网。所以它必须同时排除
    //      「经中继」这一种形状。下面第 3 组就是钉这一点的。
    //
    //   ② 认证门（hasAuthCookie + ensureDevice）—— 管 /__routes、/go、
    //      /codex/threads、/codex/file、/__targets 这些**内容面**。
    //      /__routes **不是**回环门：它要求的是会话 cookie。从回环不带 cookie
    //      去访问它照样 403（下面第 2 组能看到），别把两件事当成一回事。
    //
    // 三组：① 回环（合法用途仍然可用）② 非回环 ③ 经中继（真实的公网形状）

    // ① 回环：管理面本来就应该能用 —— 修「别漏给公网」不能把它一起锁死
    for (const p of ['/console', '/__console/status']) {
      const r = await request({ path: p, hostHeader: `127.0.0.1:${PORT}` });
      ok(`本机回环访问 ${p} 仍然可用（合法用途不能被安全修复一起锁死）`,
        r.status === 200, `status=${r.status} body=${r.body.slice(0, 60)}`);
    }
    const localHealth = await request({ path: '/__health', hostHeader: `127.0.0.1:${PORT}` });
    ok('本机回环 /__health 仍然可用', localHealth.status === 200, `status=${localHealth.status}`);
    const loopStatus = await request({ path: '/__console/status', hostHeader: `127.0.0.1:${PORT}` });
    ok('回环拿到的控制台状态里确实带着要复制的地址（本地控制台靠这个工作）',
      (() => { try { const j = JSON.parse(loopStatus.body); return !!(j.entries && (j.entries.wan || (j.entries.lan || []).length)); } catch (err) { return false; } })(),
      loopStatus.body.slice(0, 80));

    // ② 非回环来源（内网 IP 连自己）：管理面一律不许进
    if (!LAN_IP) {
      skip('E2 非回环来源的控制台访问', '这台机器没有内网 IPv4 地址');
    } else {
      const lanConsole = await request({ path: '/console', connectHost: LAN_IP, hostHeader: `${LAN_IP}:${PORT}` });
      ok('从内网 IP 连过来：/console 被挡（只认回环）',
        lanConsole.status === 403, `status=${lanConsole.status}`);
      const lanStatus = await request({ path: '/__console/status', connectHost: LAN_IP, hostHeader: `${LAN_IP}:${PORT}` });
      ok('从内网 IP 连过来：/__console/status 被挡',
        lanStatus.status === 403, `status=${lanStatus.status}`);
      const lanAction = await request({
        method: 'POST', path: '/__console/action', connectHost: LAN_IP, hostHeader: `${LAN_IP}:${PORT}`,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: '__scenario_noop__' })
      });
      ok('从内网 IP 连过来：/__console/action 被挡（不然谁都能换你的密钥）',
        lanAction.status === 403, `status=${lanAction.status} body=${lanAction.body.slice(0, 60)}`);
      const lanBalance = await request({ path: '/__deepseek/balance', connectHost: LAN_IP, hostHeader: `${LAN_IP}:${PORT}` });
      ok('从内网 IP 连过来：/__deepseek/balance 也要过认证门', lanBalance.status === 403, `status=${lanBalance.status}`);
    }

    // ③ ★ 真实的公网形状：socket 是回环（cloudflared 转进来的），Host 是隧道域名。
    //    2026-09-22 实测过：这一组在修复前是 200，而且 /__console/status 的正文里
    //    带着 access-key.txt 与 e2ee-secret.txt 的原文 —— 公网任何人都能登进来。
    //    现在 isLoopback 末尾是 `return !viaRelay(req);`，所以下面这些必须是 403。
    for (const p of ['/console', '/__console/status', '/__console/action']) {
      const r = p.endsWith('action')
        ? await request({
          method: 'POST', path: p, headers: relayHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ action: '__scenario_noop__' })
        })
        : await request({ path: p, headers: relayHeaders() });
      const leaked = r.body.includes(ACCESS_KEY) || (E2EE_SECRET && r.body.includes(E2EE_SECRET));
      ok(`经中继（公网）未认证访问 ${p} 必须被挡，且不得带出密钥`,
        r.status === 403 && !leaked,
        `status=${r.status} 泄漏=${leaked}${leaked ? ' ← 这一条等于把访问密钥和加密密钥交给公网' : ''}`);
    }
    // 只伪造一个 CF 头也要挡住（守卫不能只认 Host 是不是隧道域名）
    const forgedRay = await request({ path: '/__console/status', headers: { host: `127.0.0.1:${PORT}`, 'cf-ray': 'fake-SJC' } });
    ok('只伪造 cf-ray（Host 还是回环）也挡住 —— 不能只靠「域名像不像隧道」',
      forgedRay.status === 403, `status=${forgedRay.status}`);
    const relayHealth = await request({ path: '/__health', headers: relayHeaders() });
    ok('经中继（公网）未认证访问 /__health 必须被挡',
      relayHealth.status === 403, `status=${relayHealth.status} body=${relayHealth.body.slice(0, 60)}`);

    // ④ 认证门那一侧：这些端点要的是会话 cookie，不是回环
    for (const p of ['/__routes', '/go', '/codex/threads', '/codex/file?path=x', '/__targets']) {
      const r = await request({ path: p, hostHeader: `127.0.0.1:${PORT}` });
      const leaked = r.body.includes(ACCESS_KEY) || (E2EE_SECRET && r.body.includes(E2EE_SECRET));
      ok(`未认证 ${p} 被认证门挡住且不泄漏任何密钥`,
        r.status === 403 && !leaked, `status=${r.status} 泄漏=${leaked}`);
    }
    const routesRelay = await request({ path: '/__routes', headers: relayHeaders() });
    ok('经中继未认证访问 /__routes 也被挡（认证门对两条来路一视同仁）',
      routesRelay.status === 403, `status=${routesRelay.status}`);
  }

  section('D4 经中继不许明文：闸门与产出方必须认同同一个「我要加密」');
  {
    // 背景：`E2EE_CONTENT_PATHS` 那张表是「经中继 + 没说要加密 → 拒绝」的闸门，
    // 表里四条通道都携带使用者正文（会话列表的标题就是内容）。
    //
    // 但「说要加密」有两种记号：
    //     · 查询参数 `?e2ee=1`   —— 闸门认
    //     · 请求头 `x-dsh-e2ee: 1` —— 闸门也认，可**只有它**能让 e2eeWrap 真的加密
    // 于是只带查询参数的那一半成了绕过闸门的口令：闸门放行，内容明文出门。
    // 实测（2026-09-22 复测仍是这样）：`/codex/threads?e2ee=1` 经中继
    // 返回 200 + `application/json` + 24KB 真实会话标题，响应里没有 x-dsh-e2ee。
    //
    // 这一条就是「一个功能产出的东西被另一个功能误解」的教科书样本：
    // 闸门以为「他要求加密了」，产出方以为「他没要求加密」，中间没有人报错。
    if (!E2EE_SECRET) {
      skip('D4 经中继不许明文（两种记号是否一致）', '本机没配加密密钥，闸门本来就不生效（明文是设计如此）');
    } else {
      const paths = ['/codex/threads', '/codex/queue'];
      for (const p of paths) {
        // 只带查询参数：闸门放行了，那内容就必须**真的加密**，不能明文出门
        const viaQuery = await request({ path: p + '?e2ee=1', headers: relayHeaders(Object.assign({}, AUTH)) });
        const problem = relayPlaintextProblem(viaQuery);
        ok(`经中继 ${p}?e2ee=1：闸门放行之后内容必须真的加密（不能明文过中继）`,
          !problem, problem
            ? `${problem}（content-type=${viaQuery.headers['content-type']}）`
            : `status=${viaQuery.status} x-dsh-e2ee=${viaQuery.headers['x-dsh-e2ee']}`);

        // 对照组：同一个端点带头去要，必须加密 —— 证明上面那条不是「这个端点本来就不加密」
        const viaHeader = await request({ path: p, headers: relayHeaders(Object.assign({ 'x-dsh-e2ee': '1' }, AUTH)) });
        ok(`对照组：${p} 带 x-dsh-e2ee: 1 时确实返回密文（上面那条不是误判）`,
          viaHeader.status !== 200 || viaHeader.headers['x-dsh-e2ee'] === '1',
          `status=${viaHeader.status} x-dsh-e2ee=${viaHeader.headers['x-dsh-e2ee']} ct=${viaHeader.headers['content-type']}`);
      }

      // 静态护栏：两边认的「我要加密」记号必须是**同一套**。
      // 现在不是 —— 闸门认两种（查询参数、请求头），产出方只认请求头，
      // 于是查询参数那一半成了绕过闸门的口令。这条断言把根因钉住：
      // 以后谁再加第三种记号，两边不同步就会红。
      const src = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
      const gateFn = (src.match(/function clientWantsE2ee\([\s\S]*?\n\}/) || [''])[0];
      const wrapFn = (src.match(/function e2eeWrap\(handler\) \{[\s\S]*?\n\}/) || [''])[0];
      const marksOf = (body) => {
        const out = [];
        if (/searchParams\.get\('e2ee'\)/.test(body)) out.push('?e2ee=1');
        if (/headers\['x-dsh-e2ee'\]/.test(body)) out.push('x-dsh-e2ee:1');
        return out;
      };
      const gateMarks = marksOf(gateFn);
      const wrapMarks = marksOf(wrapFn);
      // 「同一套判据」有两种合格写法，缺一不可：
      //   ① 直接**委托**给闸门用的那个函数（最强 —— 不可能再错开）
      //   ② 各自认同一组记号
      // 只认 ② 会误伤 ①：委托之后产出方内部一个记号字面量都没有，
      // 断言就会喊「产出方认 []」，而实际它比原来更可靠。
      const delegates = /clientWantsE2ee\s*\(/.test(wrapFn);
      ok('闸门认的记号与真正加密时认的记号是同一套（委托或同组记号都算）',
        delegates || (gateMarks.length > 0 && gateMarks.join('|') === wrapMarks.join('|')),
        delegates ? '委托给 clientWantsE2ee（最强写法）'
          : `闸门认 [${gateMarks.join(', ')}]，产出方认 [${wrapMarks.join(', ')}]`
        + (gateMarks.join('|') !== wrapMarks.join('|') ? ' —— 差值就是绕过闸门的那一半' : ''));
    }
  }

  section('E3 这一趟测试自己没有弄脏现场');
  {
    const devicesAfter = sessions.list().length;
    ok('设备数前后一致（测试没有往使用者的设备表里塞东西）',
      devicesAfter === devicesBefore, `${devicesBefore} → ${devicesAfter}`);
  }
}

// ── 跑 ──────────────────────────────────────────────────────────────────────
if (process.argv.includes('--red-check')) {
  redCheck().catch((err) => {
    console.log(`\n✗ 自检自己抛了异常: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
} else {
  main().then(() => {
    console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
    if (skipped) console.log(`（另有 ${skipped} 条跳过 —— 需要现场条件或副作用太大，见上面每条的说明）`);
    if (gatewayDown) {
      console.log('\n结论: 网关没在跑，这一次什么都没验 —— 既不算通过，也不代表「漏洞还在」。');
      console.log('      把网关照常跑起来（logs/status.json 里 gateway.running 为 true）再跑一次。\n');
    } else if (fail) {
      // 把「已知还开着的问题」和「这次新冒出来的」分开写。
      // 不分开的话，跑全套的人看到一片红只会当成环境抖动 —— 那正是这个项目
      // 反复吃过的亏（假红把真红淹掉）。
      const KNOWN_OPEN = [
        { re: /双份 #k=|解析不出唯一一把密钥/,
          why: 'pwa/e2ee.js 的 secretFromUrl 把「两份 #k=」整段当成密钥：链接照常打开、加密照常装上，但一帧都解不开（消费方缺输入校验）' },
        { re: /经中继 .*\?e2ee=1|闸门认的记号与真正加密/,
          why: '「我要加密」的两种记号不一致：闸门认 ?e2ee=1，e2eeWrap 只认 x-dsh-e2ee:1 → 加了查询参数就能让明文过中继' }
      ];
      const known = [];
      const fresh = [];
      for (const f of failures) {
        const hit = KNOWN_OPEN.find((k) => k.re.test(f));
        if (hit) known.push(hit.why); else fresh.push(f);
      }
      console.log('\n失败明细：');
      for (const f of failures) console.log(`  ✗ ${f}`);
      if (known.length) {
        console.log('\n⚠ 上面这些对应的**已知仍然存在**的问题（不是环境抖动，也不是这个测试自己坏了）：');
        for (const w of [...new Set(known)]) console.log(`    · ${w}`);
      }
      if (fresh.length) {
        console.log('\n! 这次新冒出来的失败（以前没记录过，需要人看一眼）：');
        for (const f of fresh) console.log(`    · ${f}`);
      }
      console.log('\n结论: 上面这些就是「一个功能产出的东西被另一个功能拒绝或误解」的地方 ——');
      console.log('      使用者看到的是「页面能开、就是什么都没有」，或者更糟：管理面/密钥直接漏出去。\n');
    } else {
      console.log('\n结论: 这条链上暂时没找到自相矛盾 / 静默失败 / 换不来的地方。\n');
    }
    process.exitCode = fail ? 1 : 0;
  }).catch((err) => {
    console.log(`\n✗ 测试自己抛了异常: ${err && err.stack ? err.stack : err}`);
    console.log(`\n=== ${pass} 通过 / ${fail + 1} 失败 ===\n`);
    process.exitCode = 1;
  });
}
