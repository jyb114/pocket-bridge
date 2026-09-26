// DSH 移动端网关 — 一键联通
//
// 与 show-entry.js 的分工：
//   show-entry  只报告「现在是什么状态」
//   这个脚本    会主动把服务拉起来，并且对每个候选入口做**真实连通性测试**，
//               最后只把确实能用的那些给你，并按优先级排序
//
// 一条命令走完：确保服务在跑 → 探测网络环境 → 枚举候选入口 → 逐个实测 → 给推荐
//
// 用法：
//   node connect.js              完整流程（含隧道，较慢）
//   node connect.js --lan-only   只要局域网（最快，不碰隧道）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { spawn } = require('child_process');

const cfg = require('./config.js');

const BASE = cfg.BASE;
const LOG_DIR = cfg.LOG_DIR;
const LAN_ONLY = process.argv.includes('--lan-only');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(msg = '') { process.stdout.write(`${msg}\n`); }

function readLog(name) {
  try { return fs.readFileSync(path.join(LOG_DIR, name), 'utf8').trim(); }
  catch (err) { return null; }
}

function probeHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__health', timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve(j && j.service === 'pocket-bridge-gateway' ? j : null);
        } catch (err) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function findGateway() {
  for (let p = 8080; p <= 8099; p++) {
    const info = await probeHealth(p);
    if (info) return { port: p, info };
  }
  return null;
}

/** 对一个 URL 做真实请求，只要不是「连不上」就算通。 */
function tryUrl(url, timeoutMs = 12000, headers = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers }, (res) => {
      res.resume();
      resolve({ reachable: true, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, reason: '超时' }); });
    req.on('error', (err) => resolve({ reachable: false, reason: err.code || err.message }));
  });
}

/** 确认某个端口确实在监听（用于判断 IPv6 是否可达）。 */
function portListening(port, family) {
  return new Promise((resolve) => {
    const host = family === 6 ? '::1' : '127.0.0.1';
    const s = net.connect({ port, host });
    s.setTimeout(1200);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

/** 把服务拉起来（幂等）—— 直接复用启动器，不重复实现一遍。 */
async function ensureRunning() {
  let gw = await findGateway();
  if (gw) return gw;

  say('  服务没在跑，正在启动...');
  const daemon = path.join(BASE, 'scripts', 'gateway-daemon.js');
  const child = spawn(process.execPath, [daemon], { detached: true, stdio: 'ignore', cwd: BASE });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    gw = await findGateway();
    if (gw) return gw;
  }
  return null;
}

(async () => {
  const line = '='.repeat(66);
  say(`\n${line}\n  DSH 移动端网关 — 一键联通\n${line}\n`);

  // ── 1. 服务 ─────────────────────────────────────────────────────────────────
  say('[1/4] 确保服务在运行');
  const gw = await ensureRunning();
  if (!gw) {
    say('      ✗ 服务起不来，后面的检查没有意义。请看 logs/daemon.log');
    process.exitCode = 1;
    return;
  }
  say(`      ✓ 中间层端口 ${gw.port}，DSH 后端 ${gw.info.dshPort}`);

  const key = readLog('access-key.txt');
  // 地址必须带加密密钥（#k=…），否则手机打开后页面能出来、实时通道却被自家网关拒掉，
  // 表现就是「登录成功但对话列表空的」。原因详见 routes.js 里 frag 那段注释。
  const secret = readLog('e2ee-secret.txt');
  const frag = secret ? `#k=${secret}` : '';

  // DSH 是否在跑
  const dshAlive = await new Promise((resolve) => {
    const s = net.connect(gw.info.dshPort, '127.0.0.1');
    s.setTimeout(1200);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
  say(`      ${dshAlive ? '✓' : '·'} DSH 本体${dshAlive ? '正在运行' : '未运行（手机访问时会自动拉起）'}`);

  // ── 2. 网络环境 ─────────────────────────────────────────────────────────────
  say('\n[2/4] 探测网络环境');
  const netInfo = cfg.detectNetwork();
  say(`      局域网 IPv4 : ${netInfo.lanV4.length ? netInfo.lanV4.map((x) => x.address).join(', ') : '无'}`);
  say(`      公网 IPv6   : ${netInfo.publicV6.length ? netInfo.publicV6.map((x) => x.address).join(', ') : '无'}`);

  const v6Local = await portListening(gw.port, 6);
  say(`      中间层监听  : IPv4 ${await portListening(gw.port, 4) ? '是' : '否'}，IPv6 ${v6Local ? '是' : '否'}`);

  // ── 3. 枚举候选入口并逐个实测 ───────────────────────────────────────────────
  say('\n[3/4] 实测各候选入口');
  const candidates = [];

  for (const x of netInfo.lanV4) {
    candidates.push({
      kind: 'lan',
      label: '局域网直连',
      note: '同一 WiFi 下用，不需要 VPN，延迟最低',
      url: `http://${x.address}:${gw.port}/k/${key}${frag}`
    });
  }

  // 公网 IPv6 直连：中间层确实在 IPv6 上监听才有意义
  if (v6Local) {
    for (const x of netInfo.publicV6) {
      candidates.push({
        kind: 'ipv6',
        label: '公网 IPv6 直连',
        note: '不绕 Cloudflare；但需要运营商与光猫放行入站（多数家宽会被挡）',
        url: `http://[${x.address}]:${gw.port}/k/${key}${frag}`,
        // 从本机访问自己的公网地址走的是回环路径，测出来的「通」不代表
        // 外面真的能连进来。这条只能靠手机在 4G/5G 下验证。
        selfTestOnly: true
      });
    }
  }

  if (!LAN_ONLY) {
    let tunnelUrl = null;
    try {
      tunnelUrl = (JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'status.json'), 'utf8')).entries || {}).wan;
    } catch (err) { /* 没有状态文件 */ }

    if (tunnelUrl) {
      candidates.push({
        kind: 'tunnel',
        label: 'Cloudflare 隧道',
        note: '在外用 4G/5G；部分网络需要代理才能连上 Cloudflare',
        // status.json 里的 wan **可能已经带了 #k=**（控制台写的那份就带），
        // 直接往后拼会得到 `#k=旧#k=新`，浏览器把整段当 fragment，密钥就错了。
        url: `${String(tunnelUrl).replace(/#.*$/, '')}${frag}`
      });
    }
  }

  const results = [];
  for (const c of candidates) {
    let r = await tryUrl(c.url, c.kind === 'tunnel' ? 25000 : 10000);

    // 隧道刚重建时，Cloudflare 边缘要几十秒才同步完成，这期间会返回 530/1033。
    // 等一下重试，免得把「还没同步完」误报成「不可用」。
    const looksTransient = c.kind === 'tunnel' &&
      (!r.reachable || (typeof r.status === 'number' && r.status >= 500));
    if (looksTransient) {
      say('        （隧道可能需要时间同步，等 15 秒重试一次…）');
      await sleep(15000);
      r = await tryUrl(c.url, 25000);
    }

    // 5xx 说明链路通了但后端有问题（典型是隧道指向了没人监听的端口）。
    // 不能当成「可用」—— 否则使用者会拿着一个打不开的地址白折腾。
    const healthy = r.reachable && typeof r.status === 'number' && r.status < 500;
    results.push(Object.assign({}, c, {
      reachable: healthy,
      rawStatus: r.status,
      reason: r.reason || (healthy ? null : `HTTP ${r.status}（后端异常）`)
    }));
    const mark = healthy ? '✓' : '✗';
    say(`      ${mark} ${c.label.padEnd(14)} ${healthy ? `HTTP ${r.status}` : (r.reason || `HTTP ${r.status} 后端异常`)}`);
  }

  // ── 4. 推荐 ─────────────────────────────────────────────────────────────────
  say('\n[4/4] 推荐入口');
  const usable = results.filter((r) => r.reachable);

  if (usable.length === 0) {
    say('      ✗ 没有任何入口可用。检查 logs/ 下的日志。');
    process.exitCode = 1;
    return;
  }

  // 优先级：局域网 > IPv6 直连 > 隧道（延迟由低到高）
  const order = { lan: 1, ipv6: 2, tunnel: 3 };
  usable.sort((a, b) => (order[a.kind] || 9) - (order[b.kind] || 9));

  for (const u of usable) {
    say(`\n      【${u.label}】${u.note}`);
    say(`        ${u.url}`);
    if (u.selfTestOnly) {
      say('        ⚠ 这是本机自测结果 —— 从本机访问自己的公网地址走的是回环路径，');
      say('          外面是否真能连进来，得用手机在 4G/5G 下验证');
    }
  }

  const pairCode = readLog('pair-code.txt');
  const lanUsable = usable.find((u) => u.kind === 'lan');
  if (pairCode && lanUsable) {
    const pairBase = lanUsable.url.split('/k/')[0];
    say(`\n      【配对码方式】地址短，但要手输 6 位`);
    say(`        打开 ${pairBase}/pair`);
    say(`        配对码 ${pairCode}`);
  }

  say(`\n${line}`);
  say(`  结论: ${usable.length} 个入口实测可用`);
  say(`  建议: 在家用局域网那条，在外用隧道那条；进过一次就会记住登录态。`);
  say(`${line}\n`);

  try {
    fs.writeFileSync(path.join(LOG_DIR, 'connect-result.json'), JSON.stringify({
      ranAt: new Date().toISOString(),
      gatewayPort: gw.port,
      dshAlive,
      network: { lanV4: netInfo.lanV4, publicV6: netInfo.publicV6 },
      candidates: results,
      usable
    }, null, 2), 'utf8');
  } catch (err) { /* 忽略 */ }
})();
