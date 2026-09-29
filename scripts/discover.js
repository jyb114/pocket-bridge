// 找 DSH 当前在哪个端口上。
//
// 最早这里只有一件事：读 DSH 的日志，用正则取最后一条
//   `dsh web: http://127.0.0.1:<port>/?token=...`
// 那时这条路可靠 —— DSH 每次启动都会把它写进自己的日志文件。
//
// 2026-09 实测 DSH 0.1.7-rc.2，这条路整条断了：
//   · 数据目录从 %APPDATA%\DeepSeek Harness Desktop 换成了 %APPDATA%\@deepseek-ai\dsh-desktop
//   · 换过去之后那个 logs 目录里**一个文件都没有**
//   · `dsh web:` 那行改成打印到进程 stdout，磁盘上再也拿不到
//   表现就是使用者看到的那一幕：DSH 明明开着，桥却说它没在运行；
//   点「启动」又一直等不到监听 —— 因为它一直在旧路径上找一份不存在的日志。
//
// 所以现在把顺序反过来，从**最不依赖 DSH 内部实现**的手段开始：
//
//   1. 问操作系统：DSH 的进程此刻在监听哪个端口。
//        端口怎么随机、日志写不写、数据目录叫什么，都不影响这一条。
//   2. 日志兜底（老版本）：多路径 + 宽松正则，哪天它又写回日志也还能用。
//
// 单独抽成一个模块，是因为有两处要用：中间层（要跟住端口变化）和目标管理
// （要判断 DSH 在不在跑）。各写一份的话，DSH 哪天改了就会只修好一处。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 旧版日志的候选路径。
 *
 * 为什么是一个列表而不是一个常量：这个路径已经改过一次（harness-home →
 * @deepseek-ai\dsh-desktop），下次还会再改。多列几个的成本是一次 statSync，
 * 而漏掉一个的代价是「端口彻底找不到」—— 就是这次踩的坑。
 */
function logCandidates() {
  const home = os.homedir();
  const names = [
    ['DeepSeek Harness Desktop', 'logs', 'deepseek-harness-desktop.log'],
    ['@deepseek-ai', 'dsh-desktop', 'logs', 'deepseek-harness-desktop.log'],
    ['@deepseek-ai', 'dsh-desktop', 'logs', 'main.log']
  ];
  const roots = [
    process.env.APPDATA,
    path.join(home, 'AppData', 'Roaming'),
    path.join(home, 'Library', 'Application Support'),
    process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  ].filter(Boolean);

  const out = [];
  for (const r of roots) for (const n of names) out.push(path.join(r, ...n));
  return [...new Set(out)];
}

/** 保留这个导出：一直有调用方读它，改了没必要。 */
const LOG_FILE = logCandidates()[0];

/**
 * 从日志正文里取端口。取**最后**一条 —— 那是当前实例。
 *
 * 两种写法都认：
 *   `dsh web: http://127.0.0.1:19387/?token=...`（它自己的那行）
 *   裸的 `http://127.0.0.1:19387/?token=`（万一前面那截文案改了）
 * 第一条更可信，命中就直接返回，不再看第二条。
 */
function parsePortFromLog(text) {
  const patterns = [
    /dsh\s+web:\s*https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/gi,
    /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?\?token=/gi
  ];
  for (const re of patterns) {
    const found = [...String(text).matchAll(re)];
    if (found.length) return Number(found[found.length - 1][1]);
  }
  return null;
}

/** 逐个候选日志文件找端口。都没有就 null。 */
function discoverDshPortFromLogs() {
  for (const file of logCandidates()) {
    try {
      const port = parsePortFromLog(fs.readFileSync(file, 'utf8'));
      if (port) return port;
    } catch (err) {
      // 文件不存在是常态，继续看下一个
    }
  }
  return null;
}

/** DSH 进程的 PID 列表。拿不到就返回空数组（不是错误）。 */
function dshPids() {
  // CLI web servers run under node/bun, so process names alone are insufficient.
  try { return require('./dsh-runtime.js').scanProcesses().map(p => Number(p.pid)).filter(p => p > 0); }
  catch (_) { return []; }
}

/**
 * 这些进程正在 TCP 监听哪些端口。
 *
 * 这是整个发现逻辑的支点：它问的是操作系统，不是 DSH 自己怎么说，
 * 所以 DSH 换数据目录、改日志格式、改端口策略都不会让这里失效。
 */
function listeningPortsOf(pids, options = {}) {
  const want = new Set(pids.map(Number));
  const ports = new Set();
  const owners = new Map();
  const addPort = (pid, port) => { ports.add(port); owners.set(`${pid}:${port}`, { pid, port }); };
  const result = () => options.withOwners ? [...owners.values()] : [...ports];
  if (!want.size) return [];

  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'],
        { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of String(out).split('\n')) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        if (!want.has(Number(parts[parts.length - 1]))) continue;
        const m = String(parts[1]).match(/:(\d+)$/);
        if (m) addPort(Number(parts[parts.length - 1]), Number(m[1]));
      }
      return result();
    }

    // macOS：lsof 一进程一次；Linux 上更常见的是 lsof 或 ss
    for (const pid of pids) {
      try {
        const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)],
          { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of String(out).split('\n')) {
          const m = line.match(/TCP\s+\S*:(\d+)\s+\(LISTEN\)/);
          if (m) addPort(pid, Number(m[1]));
        }
        continue;
      } catch (err) { /* 试 ss */ }

      try {
        const out = execFileSync('ss', ['-ltnpH'],
          { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const line of String(out).split('\n')) {
          if (!line.includes(`pid=${pid}`)) continue;
          const m = line.match(/:(\d+)\s/);
          if (m) addPort(pid, Number(m[1]));
        }
      } catch (err) { /* 两条路都不行就算了 */ }
    }
  } catch (err) {
    // 命令不可用
  }
  return result();
}

/** DSH 进程正在监听的所有端口 —— 同步，不联网。 */
function candidatePorts() {
  return listeningPortsOf(dshPids());
}

/**
 * 上一次确认过的端口。
 *
 * 用途只有一个：候选多于一个时，优先沿用上次那个。
 * 这个模块和中间层、目标管理在**同一个进程**里，所以这份记忆是共享的，
 * 异步那条路（resolveDshPort）探明之后会把它纠正过来。
 */
let lastGoodPort = null;

/** Only a DSH authentication response or a genuine DSH frontend identifies HTTP. */
async function probeDshHttp(port, timeoutMs = 1500) {
  const runtime = await require('./dsh-adapter.js').probeDshRuntime({ port }, { timeoutMs });
  return runtime.httpEvidence ? 2 : 0;
}

/**
 * 权威版的发现：进程 → 监听端口 → HTTP 特征。
 *
 * 什么时候用异步这一版：调用方本来就处在 async 里、而且**结论会被展示给使用者**
 * 的地方（控制台的目标状态、启动前的就绪判断）。多花一次回环请求，
 * 换来的是「不会把别的程序的端口当成 DSH」。
 *
 * @returns {Promise<number|null>} 端口；找不到返回 null（调用方应沿用上一次的值）
 */
async function resolveDshPort() {
  const runtime = await require('./dsh-runtime.js').resolveRuntime();
  if (runtime.running && runtime.port) { lastGoodPort = runtime.port; return runtime.port; }
  lastGoodPort = null;
  return null;
}

/** Synchronous callers can reuse the last HTTP-verified runtime only. */
function discoverDshPort() {
  // A synchronous caller may only reuse an HTTP-verified runtime. Discovery of
  // a new port happens asynchronously; a random listener is never an upstream.
  try {
    const runtime = require('./dsh-runtime.js').peekRuntime();
    if (runtime && runtime.running && runtime.port) return runtime.port;
  } catch (_) { /* Runtime probing has not finished yet. */ }
  return null;
}

module.exports = {
  discoverDshPort,
  resolveDshPort,
  discoverDshPortFromLogs,
  probeDshHttp,
  candidatePorts,
  listeningPortsOf,
  dshPids,
  logCandidates,
  parsePortFromLog,
  LOG_FILE
};
