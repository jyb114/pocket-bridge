// DSH 移动端网关 — 隧道管理
//
// 为什么要单独一层：原来所有赌注都压在 Cloudflare 一家上 ——
// 它不可达（网络限制、服务故障、被墙）时整个外网入口就没了，
// 而使用者只会看到「手机连不上」，完全不知道原因。
//
// 这一层做的事：按优先级依次尝试各个隧道方案，前一个起不来就自动降级到
// 下一个，把每一次尝试和失败原因都写进日志。全都不可用时明确报告，
// 此时仍然保留内网入口 —— 不是「全挂」，而是「只剩一种方式」。
//
// 只依赖 Node 内置模块。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const cfg = require('./config.js');

const LOG_DIR = cfg.LOG_DIR;
const LOG_FILE = path.join(LOG_DIR, 'tunnel.log');

/**
 * 从**外面**探测一个公网地址到底通不通。
 *
 * 为什么必须有这一步：判断隧道好不好，常见的做法是查「cloudflared 进程在不在」。
 * 那远远不够 —— 免费快速隧道的域名会被 Cloudflare **回收**：进程还活着、
 * 日志里地址还在，那个域名却已经指向空气，手机怎么都打不开。
 * 实测栽过两次：守护进程连着二十多分钟报「隧道已在运行」，地址是死的，
 * 只有人工重建才恢复。这就是计划 E 里「区分进程存活 / 公网可达」要的东西。
 *
 * 探测走完整一圈：域名 → Cloudflare → cloudflared → 本机网关。
 * 打的是 /__probe（免认证、只回 204、不返回任何内容）。
 *
 * 判定：4xx 也算「通」—— 请求确实走到网关并被处理了。只有 5xx
 * （Cloudflare 的 502/530 表示它找不到这条隧道）和连不上才算不通。
 */
function probeUrl(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    const target = String(url).replace(/\/+$/, '') + '/__probe';
    // ★ 必须按协议选模块。用 http 去连 https 会立刻抛
    //   `Protocol "https:" not supported`，于是**每一条健康隧道都被判成不可达** ——
    //   而这个误判的后果不是少报一次，是两轮之后真的去重建、把使用者的地址换掉。
    //   （这个 bug 是跑了一次 --status 才暴露的，光看代码看不出来。）
    let mod;
    try {
      const u = new URL(target);
      mod = u.protocol === 'https:' ? require('https') : http;
    } catch (err) {
      return done({ ok: false, status: 0, ms: 0, error: `地址不合法: ${err.message}` });
    }

    let req;
    try {
      req = mod.get(target, { timeout: timeoutMs }, (res) => {
        res.resume();
        done({
          ok: res.statusCode > 0 && res.statusCode < 500,
          status: res.statusCode,
          ms: Date.now() - started,
          error: null
        });
      });
    } catch (err) {
      return done({ ok: false, status: 0, ms: 0, error: err.message });
    }
    req.on('error', (err) => done({ ok: false, status: 0, ms: Date.now() - started, error: err.message }));
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) { }
      done({ ok: false, status: 0, ms: Date.now() - started, error: '超时' });
    });
  });
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) { /* 日志失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从一段文本里找出公网地址。不同提供方的输出格式不一样，所以按模式逐个试。
 */
function extractPublicUrl(text) {
  const patterns = [
    // ★ 必须排掉 api / www / dash 这些**服务主机**。
    //
    //   正常快速隧道的地址是随机多段名（hybrid-store-blink-locations.trycloudflare.com），
    //   而 cloudflared 申请隧道失败时，报错正文里带的是 API 端点：
    //       failed to request quick Tunnel:
    //       Post "https://api.trycloudflare.com/tunnel": context deadline exceeded
    //   `[a-z0-9-]+` 照样匹配 `api` —— 于是「申请失败」被当成了「拿到地址」：
    //   日志写「✓ 隧道就绪」，status.json 存下这个垃圾地址，「地址变更通知」
    //   还把它推送给了手机（2026-09-22 14:42 真的发生过）。
    //   使用者点开那个链接到的是 Cloudflare 的 API，不是自己的电脑。
    /https:\/\/(?!(?:api|www|dash|developers)\.)[a-z0-9-]+\.trycloudflare\.com/i,
    /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.app/i,
    /https:\/\/[a-z0-9-]+\.ngrok\.io/i,
    /https:\/\/[a-z0-9.-]+\.ts\.net/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

/** 等一个进程在日志里写出公网地址。 */
async function waitForUrl(logFile, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    if (!isAlive()) return { url: null, reason: '进程已退出' };
    try {
      const text = fs.readFileSync(logFile, 'utf8');
      const url = extractPublicUrl(text);
      if (url) return { url, reason: null };
    } catch (err) { /* 日志还没生成 */ }
  }
  return { url: null, reason: `等待 ${Math.round(timeoutMs / 1000)} 秒仍未拿到地址` };
}

// ── 各提供方 ──────────────────────────────────────────────────────────────────

/** Cloudflare 快速隧道：不需要账号，代价是地址每次重启都变。 */
async function startCloudflareQuick(exe, port) {
  const logFile = path.join(LOG_DIR, 'cloudflared.err.log');
  try { fs.unlinkSync(logFile); } catch (err) { }

  const child = spawn(exe, [
    'tunnel',
    '--url', `http://127.0.0.1:${port}`,
    '--no-autoupdate'
  ], {
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')]
  });
  child.unref();

  const alive = () => { try { return process.kill(child.pid, 0); } catch (err) { return false; } };
  const { url, reason } = await waitForUrl(logFile, 60000, alive);
  return { url, pid: child.pid, reason, logFile };
}

/** ngrok：需要账号和 authtoken，但地址可以是固定的。 */
async function startNgrok(exe, port) {
  const token = process.env.NGROK_AUTHTOKEN;
  if (!token) return { url: null, reason: '缺少环境变量 NGROK_AUTHTOKEN' };

  const logFile = path.join(LOG_DIR, 'ngrok.log');
  try { fs.unlinkSync(logFile); } catch (err) { }

  const child = spawn(exe, ['http', String(port), '--log', 'stdout', '--authtoken', token], {
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')]
  });
  child.unref();

  const alive = () => { try { return process.kill(child.pid, 0); } catch (err) { return false; } };
  const { url, reason } = await waitForUrl(logFile, 45000, alive);
  return { url, pid: child.pid, reason, logFile };
}

/**
 * Cloudflare 命名隧道：地址固定，但需要 Cloudflare 账号 + 自有域名。
 *
 * 它会生成一份临时配置（不进系统目录），把域名指到本地中间层，然后 run。
 * 与快速隧道的取舍：方便 vs 安全 —— 地址长期不变意味着一旦泄露就是长期暴露。
 */
async function startCloudflareNamed(exe, port, fixed) {
  if (!fixed || !fixed.name || !fixed.hostname) {
    return {
      url: null,
      reason: '未配置命名隧道（需要在 config.json 里填 fixedTunnel.name 与 hostname）'
    };
  }

  const cfgPath = path.join(LOG_DIR, 'cloudflared-named.yml');
  const logFile = path.join(LOG_DIR, 'cloudflared-named.log');
  try { fs.unlinkSync(logFile); } catch (err) { }

  const lines = [
    `tunnel: ${fixed.name}`
  ];
  if (fixed.credentialsFile) lines.push(`credentials-file: ${fixed.credentialsFile}`);
  lines.push(
    'ingress:',
    `  - hostname: ${fixed.hostname}`,
    `    service: http://127.0.0.1:${port}`,
    '  - service: http_status:404'
  );
  fs.writeFileSync(cfgPath, lines.join('\n') + '\n', 'utf8');

  const child = spawn(exe, [
    'tunnel', '--config', cfgPath, 'run', fixed.name, '--no-autoupdate'
  ], {
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')]
  });
  child.unref();

  // 固定地址是已知的，不需要从日志里猜；但要给它一点时间连上
  await sleep(6000);

  const alive = (() => { try { return process.kill(child.pid, 0); } catch (err) { return false; } })();
  if (!alive) {
    let tail = '';
    try { tail = fs.readFileSync(logFile, 'utf8').slice(-300); } catch (err) { }
    return { url: null, reason: `命名隧道进程已退出。日志尾部: ${tail}`, pid: child.pid, logFile };
  }

  return { url: `https://${fixed.hostname}`, pid: child.pid, reason: null, logFile };
}

/**
 * 提供方清单，按优先级排列。
 * 新增一种隧道只需要在这里加一条，上层不用改。
 */
const PROVIDERS = [
  {
    id: 'cloudflare-named',
    label: 'Cloudflare 命名隧道（地址固定）',
    available: () => cfg.detectTunnelProviders().cloudflared,
    start: (exe, port) => startCloudflareNamed(exe, port, cfg.loadConfig().fixedTunnel)
  },
  {
    id: 'cloudflare-quick',
    label: 'Cloudflare 快速隧道（免账号，地址每次变）',
    available: () => cfg.detectTunnelProviders().cloudflared,
    start: startCloudflareQuick
  },
  {
    id: 'ngrok',
    label: 'ngrok（需要 NGROK_AUTHTOKEN）',
    available: () => cfg.detectTunnelProviders().ngrok,
    start: startNgrok
  }
];

/** 目前有哪些提供方可选（不实际启动）。 */
function listProviders() {
  const conf = cfg.loadConfig();
  const mode = conf.tunnelDomainMode || 'dynamic';
  const fixedReady = !!(conf.fixedTunnel && conf.fixedTunnel.name && conf.fixedTunnel.hostname);

  return PROVIDERS.map((p) => {
    const exe = p.available() || null;
    // 「装了 cloudflared」不等于「命名隧道能用」—— 后者还需要自有域名与隧道凭据。
    // 不区分这两件事，自检就会把没配好的方案报成就绪。
    const ready = !!exe &&
      (p.id !== 'ngrok' || !!process.env.NGROK_AUTHTOKEN) &&
      (p.id !== 'cloudflare-named' || fixedReady);

    return {
      id: p.id,
      label: p.label,
      executable: exe,
      ready,
      configHint: p.id === 'cloudflare-named' && !fixedReady
        ? '需要自己的域名：在 config.json 填 fixedTunnel.name 与 fixedTunnel.hostname'
        : null,
      // 当前域名策略下这一项会不会被用到
      usedInCurrentMode: p.id === 'cloudflare-named' ? mode === 'fixed' : true
    };
  });
}

/**
 * 按当前域名策略挑出候选提供方。
 *
 * dynamic：只用每次会换地址的方案。地址一次性，被扫到也等于没扫到。
 * fixed：  只允许命名隧道。固定模式若悄悄退回一次性地址，使用者会以为书签
 *          仍然稳定，实际却被换走；这比明确报告「固定隧道未连上」更危险。
 */
function candidatesForMode(mode) {
  if (mode === 'fixed') return PROVIDERS.filter((p) => p.id === 'cloudflare-named');
  return PROVIDERS.filter((p) => p.id !== 'cloudflare-named');
}

/**
 * 启动隧道，失败自动降级。
 *
 * @param {number} port 本地中间层端口
 * @param {string} preference 'auto' 或某个提供方 id
 * @returns {Promise<{provider: string|null, url: string|null, attempts: Array}>}
 */
async function startTunnel(port, preference = 'auto') {
  const attempts = [];
  const mode = cfg.loadConfig().tunnelDomainMode || 'dynamic';
  log(`域名策略: ${mode === 'fixed' ? '固定地址（自有域名）' : '动态地址（每次更换）'}`);

  let candidates = candidatesForMode(mode);
  if (preference && preference !== 'auto') {
    const wanted = PROVIDERS.filter((p) => p.id === preference);
    if (wanted.length === 0) {
      log(`未知的隧道提供方 "${preference}"，回退到自动选择`);
    } else {
      candidates = wanted;
    }
  }

  for (const p of candidates) {
    const exe = p.available();
    if (!exe) {
      attempts.push({ provider: p.id, ok: false, reason: '未安装' });
      log(`跳过 ${p.label}：未安装`);
      continue;
    }

    log(`尝试 ${p.label} ...`);
    try {
      const res = await p.start(exe, port);
      if (res.url) {
        // 把 pid 一并带出去：调用方（测试、启动器）要能只收掉自己起的那个，
        // 而不是把使用者正在用的隧道一起杀了
        attempts.push({ provider: p.id, ok: true, url: res.url, pid: res.pid || null });
        log(`✓ ${p.label} 就绪: ${res.url}`);
        return { provider: p.id, url: res.url, pid: res.pid || null, attempts };
      }
      attempts.push({ provider: p.id, ok: false, reason: res.reason, pid: res.pid || null });
      log(`✗ ${p.label} 失败: ${res.reason}`);
    } catch (err) {
      attempts.push({ provider: p.id, ok: false, reason: err.message });
      log(`✗ ${p.label} 抛异常: ${err.message}`);
    }
  }

  log('所有隧道方案都不可用 —— 外网入口关闭，内网入口仍然有效');
  return { provider: null, url: null, attempts };
}

/**
 * 停掉**本项目自己的**隧道进程（用于重新选择提供方）。
 *
 * ★ 这里原来是 `taskkill /IM cloudflared.exe /F` —— 按**镜像名**杀，
 *   会杀掉这台机器上所有 cloudflared，包括使用者别的项目、别的隧道。
 *   使用者本来就同时跑着代理和一堆工具，我们没有任何理由去动不属于自己的进程。
 *
 *   我们这个 cloudflared 是**随项目分发的**（cloudflared/cloudflared.exe），
 *   路径独一无二，所以按路径认得出来 —— 那就该按路径认。
 *
 *   （改进计划 E 批次点名了「宽泛杀隧道进程」，核对源码确认是真问题。
 *     上面 refresh-tunnel.js 已先修，这里是第二处。）
 */
/**
 * 从进程列表里挑出**属于本项目**的 cloudflared。
 *
 * 抽成纯函数是为了能被真的执行到 —— 这条窄杀逻辑原来只被**静态**检查过
 * （扫源码里有没有 `taskkill /IM`），运行时从没跑过，于是 `BASE is not defined`
 * 一直躲着：`stopTunnels()` 一调用就抛，隧道**再也重建不了**。
 * 而那正是使用者最需要它的时候（隧道被回收、手机连不上）。
 *
 * 前缀匹配要求后面跟路径分隔符：`…\pocket-bridge-old` 不能被当成
 * `…\pocket-bridge` —— 否则会去杀另一个项目。
 */
function ownTunnelPids(list, base) {
  const root = String(base || cfg.BASE).replace(/[\\/]+$/, '').toLowerCase();
  const sep = '(?:[\\\\/]|$)';
  const re = new RegExp('^' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + sep);
  return (Array.isArray(list) ? list : [list])
    .filter((p) => p && p.ExecutablePath && re.test(String(p.ExecutablePath).toLowerCase()))
    .map((p) => p.ProcessId)
    .filter((id) => Number.isFinite(id));
}

function stopTunnels() {
  let stopped = 0;
  try {
    if (process.platform === 'win32') {
      // 先列出所有 cloudflared，**在 Node 里**按路径筛，再动手。
      // 这样「挑哪些」这件事是纯函数，测试能直接验。
      const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'cloudflared.exe\'" | ' +
        'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress';
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
      let list = [];
      if (out) { try { list = JSON.parse(out); } catch (err) { list = []; } }
      const ids = ownTunnelPids(list, cfg.BASE);
      if (ids.length) {
        execFileSync('powershell',
          ['-NoProfile', '-Command', `Stop-Process -Id ${ids.join(',')} -Force`],
          { timeout: 15000, windowsHide: true });
        stopped = ids.length;
      }
    } else {
      // unix 上按完整路径匹配 —— 同样是为了不误伤别人的 cloudflared
      const mine = String(cfg.BASE).replace(/[\\/]+$/, '');
      execFileSync('pkill', ['-f', `${mine}/cloudflared`], { timeout: 8000 });
      stopped = 1;
    }
  } catch (err) {
    // 一个都没匹配到也算正常（本来就没在跑）
  }
  log(`已停止 ${stopped} 个隧道进程`);
  return stopped;
}

module.exports = {
  listProviders, startTunnel, stopTunnels, extractPublicUrl, PROVIDERS, candidatesForMode, probeUrl,
  ownTunnelPids
};
