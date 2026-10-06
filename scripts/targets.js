// DeepSeek Harness detection, scoped startup and status for the DSH-only gateway.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const cfg = require('./config.js');

const BASE = cfg.BASE;
const LOG_DIR = cfg.LOG_DIR;

/** 目标自己的日志，和隧道、中间层分开，排查时不用在几千行里翻 */
const LOG_FILE = path.join(LOG_DIR, 'targets.log');

// ── 这些文案要发给手机，所以必须分语言 ───────────────────────────────────────
//
// `status().note` 显示在控制台的目标列表和启动页上；操作的 `message` 是点完
// 「启动 / 停止」之后弹出来的提示。它们都是**服务端拼好**发过去的，
// 页面的 `t()` 管不到 —— 英文手机上会出现整段中文（计划 H 的「各语言不混排」）。
//
// 整句成表、变量后填：句子里夹着端口号，而语序各语言不同，拼接必然错一种。
const { pick, fill } = require('./server-lang.js');

const TEXT = {
  zh: {
    dshRunning: '正在运行（端口 {port}）',
    dshRunningVersion: '{edition} {version}，正在运行（端口 {port}）',
    dshIpc: '此 DSH 桌面版本仅提供内部连接；请运行 DSH Web 版后连接桥。Web 版不共享桌面中正在执行的任务。',
    dshWebNotOurs: '此 DSH Web 版不是桥启动的，请在启动它的终端中停止',
    dshUnknownVersion: '版本未知',
    dshDesktopEdition: '桌面版',
    dshWebEdition: 'Web 版',
    dshInstalled: '已安装，当前没在运行',
    dshMissing: '没找到 DSH',
    dshNoExe: '没找到 DSH 装在哪，请在 config.json 里填 dshExecutable',
    dshAlready: 'DSH 已经在运行了',
    dshStarted: 'DSH 已启动（端口 {port}）',
    dshNotListening: 'DSH 起来了但一直没开始监听，看看它自己的窗口有没有报错',
    dshStopped: '已关闭 DSH',
    dshNoRunning: '没找到正在运行的 DSH',


    empty: '（空）',
    startFail: '启动失败: {msg}',
    stopFail: '停止失败: {msg}',
    killFail: '关闭失败: {msg}',
    blurbDsh: '在手机浏览器中连接电脑上的 DeepSeek Harness',
  },
  en: {
    dshRunning: 'Running (port {port})',
    dshRunningVersion: '{edition} {version}, running (port {port})',
    dshIpc: 'This DSH desktop build only exposes an internal connection. Run DSH Web to connect the bridge; it does not share tasks currently running in the desktop app.',
    dshWebNotOurs: 'This DSH Web process was not started by the bridge. Stop it in its original terminal.',
    dshUnknownVersion: 'unknown version',
    dshDesktopEdition: 'Desktop',
    dshWebEdition: 'Web',
    dshInstalled: 'Installed, not running right now',
    dshMissing: 'DSH not found',
    dshNoExe: 'Could not find where DSH is installed — set dshExecutable in config.json',
    dshAlready: 'DSH is already running',
    dshStarted: 'DSH started (port {port})',
    dshNotListening: 'DSH came up but never started listening — check its own window for an error',
    dshStopped: 'DSH closed',
    dshNoRunning: 'No running DSH found',


    empty: '(empty)',
    startFail: 'Could not start: {msg}',
    stopFail: 'Could not stop: {msg}',
    killFail: 'Could not close: {msg}',
    blurbDsh: 'Connect to DeepSeek Harness on your computer from a phone browser',
  },
  es: {
    dshRunning: 'En marcha (puerto {port})',
    dshRunningVersion: '{edition} {version}, en marcha (puerto {port})',
    dshIpc: 'Esta versión de escritorio de DSH solo ofrece una conexión interna. Ejecuta DSH Web para conectar el puente; no comparte las tareas activas de la aplicación de escritorio.',
    dshWebNotOurs: 'El puente no inició este proceso DSH Web. Deténlo en su terminal original.',
    dshUnknownVersion: 'versión desconocida',
    dshDesktopEdition: 'Escritorio',
    dshWebEdition: 'Web',
    dshInstalled: 'Instalado, ahora mismo no está en marcha',
    dshMissing: 'No se encontró DSH',
    dshNoExe: 'No se encontró dónde está instalado DSH: rellena dshExecutable en config.json',
    dshAlready: 'DSH ya está en marcha',
    dshStarted: 'DSH iniciado (puerto {port})',
    dshNotListening: 'DSH arrancó pero nunca empezó a escuchar: mira si su propia ventana muestra algún error',
    dshStopped: 'DSH cerrado',
    dshNoRunning: 'No se encontró ningún DSH en marcha',


    empty: '(vacío)',
    startFail: 'No se pudo iniciar: {msg}',
    stopFail: 'No se pudo detener: {msg}',
    killFail: 'No se pudo cerrar: {msg}',
    blurbDsh: 'La interfaz completa de DSH de tu ordenador, tal cual, en el teléfono',
  }
};

/** 取某个语言的文案表（不认识的语种退回中文） */
function T(lang) { return pick(TEXT, lang); }

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) { /* 日志失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(timeoutMs);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

function httpJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** 记录我们起的进程，方便「停止」时只收自己起的那个 */
function pidFile(id) { return path.join(LOG_DIR, `target-${id}.pid`); }

function readPid(id) {
  try {
    const n = Number(fs.readFileSync(pidFile(id), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) { return null; }
}

function writePid(id, pid) {
  try { fs.writeFileSync(pidFile(id), String(pid), 'utf8'); } catch (err) { /* 忽略 */ }
}

function clearPid(id) {
  try { fs.unlinkSync(pidFile(id)); } catch (err) { /* 忽略 */ }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return false; }
}

// ── DSH ───────────────────────────────────────────────────────────────────────

const dsh = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  short: 'DSH',
  // blurb 要分语言，所以这里只放一个 key，由 list() 按语言取。
  // （它是静态属性不是函数 —— 直接写死中文的话，英文手机上就是中文。）
  blurbKey: 'blurbDsh',
  ui: '/',                       // 界面就在根路径（反代过去）

  detect() {
    const detected = require('./dsh-runtime.js').detectInstallation(cfg.loadConfig());
    return { ...detected, exe: detected.launch ? detected.launch.exe : null,
      canStart: Boolean(detected.launch) };
  },

  async detectAsync(config = cfg.loadConfig()) {
    const detected = await require('./dsh-runtime.js').detectInstallationAsync(config);
    return { ...detected, exe: detected.launch ? detected.launch.exe : null,
      canStart: Boolean(detected.launch) };
  },

  async status(lang) {
    const runtimeApi = require('./dsh-runtime.js');
    const config = cfg.loadConfig();
    const [runtime, d] = await Promise.all([
      runtimeApi.resolveRuntime(config), dsh.detectAsync(config)
    ]);
    const running = Boolean(runtime.running && runtime.port);
    const ipcOnly = !running && d.profile === 'desktop-ipc';
    const key = running ? 'dshRunningVersion' : ipcOnly ? 'dshIpc'
      : d.installed ? 'dshInstalled' : 'dshMissing';
    const noteArgs = running ? { port: runtime.port,
      version: runtime.version || T(lang).dshUnknownVersion,
      edition: runtime.kind === 'cli' ? T(lang).dshWebEdition : T(lang).dshDesktopEdition } : {};
    return {
      installed: Boolean(runtime.installed || d.installed), running,
      port: running ? runtime.port : null, exe: d.exe,
      source: runtime.source || d.source, canStart: d.canStart,
      version: runtime.version || d.version || null, kind: runtime.kind || d.kind,
      profile: runtime.profile || d.profile, runtime: runtimeApi.serializeRuntime(runtime),
      note: fill(T(lang)[key], noteArgs), noteKey: key, noteArgs
    };
  },

  async start(lang) {
    const runtimeApi = require('./dsh-runtime.js');
    const st = await dsh.status(lang);
    if (st.running) return { ok: true, message: T(lang).dshAlready, already: true };
    const d = dsh.detect();
    if (!d.launch) return { ok: false, message: d.profile === 'desktop-ipc' ? T(lang).dshIpc : T(lang).dshNoExe };
    const launch = d.launch;
    try {
      if (launch.kind === 'cli') {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const fd = fs.openSync(path.join(LOG_DIR, 'dsh-web.log'), 'a');
        let child;
        try { child = spawn(launch.exe, launch.args || [], {
          cwd: launch.cwd || BASE, detached: true, stdio: ['ignore', fd, fd], windowsHide: true
        }); } finally { fs.closeSync(fd); }
        child.on('error', (err) => log(`DSH Web start failed: ${err.message}`));
        if (child.pid) writePid('dsh-web', child.pid);
        child.unref();
      } else if (process.platform === 'win32') {
        spawn('explorer.exe', [launch.exe], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [launch.exe], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn(launch.exe, launch.args || [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    } catch (err) {
      return { ok: false, message: fill(T(lang).startFail, { msg: err.message }) };
    }
    runtimeApi.invalidateRuntime();
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      runtimeApi.invalidateRuntime();
      const s = await dsh.status(lang);
      if (s.running) return { ok: true, message: fill(T(lang).dshStarted, { port: s.port }), port: s.port };
    }
    return { ok: false, message: T(lang).dshNotListening };
  },

  async stop(lang) {
    const runtimeApi = require('./dsh-runtime.js');
    const st = await runtimeApi.resolveRuntime(cfg.loadConfig());
    if ((st.kind || dsh.detect().kind) === 'cli') {
      if (!st.running) return { ok: false, message: T(lang).dshNoRunning };
      const pid = readPid('dsh-web');
      const ours = pid && (!st.pid || st.pid === pid) && runtimeApi.scanProcesses().some(p => Number(p.pid) === pid && p.kind === 'cli');
      if (!ours) return { ok: false, message: T(lang).dshWebNotOurs };
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true });
        else process.kill(pid, 'SIGTERM');
        clearPid('dsh-web'); runtimeApi.invalidateRuntime();
        return { ok: true, message: T(lang).dshStopped };
      } catch (_) { return { ok: false, message: T(lang).dshNoRunning }; }
    }
    if (st.running && st.kind !== 'desktop') return { ok: false, message: T(lang).dshWebNotOurs };
    // 只关我们自己启动的那些 DSH 进程时最容易出错（可能把用户手动开的也关掉），
    // 所以这里按进程名找，并且明确告诉使用者「这会关掉 DSH 本体」。
    let n = 0;
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'],
          { encoding: 'utf8', timeout: 8000, windowsHide: true });
        if (/DeepSeek Harness/i.test(out)) {
          execFileSync('taskkill', ['/IM', 'DeepSeek Harness.exe', '/F'],
            { timeout: 8000, windowsHide: true });
          n = 1;
        }
      } else {
        execFileSync('pkill', ['-f', 'DeepSeek Harness'], { timeout: 8000 });
        n = 1;
      }
    } catch (err) { /* 没在跑 */ }
    return n
      ? { ok: true, message: T(lang).dshStopped }
      : { ok: false, message: T(lang).dshNoRunning };
  }
};

// DSH is the only runtime target in this release.
const ALL = [dsh];

/**
 * 按语言重新组装一批目标条目。
 *
 * 为什么需要：`refreshTargets()` 是**后台缓存**，没有请求上下文，拿不到语言
 * （和推送通知同一类问题）。所以缓存里存的是「key + 实参」，响应时再按
 * 请求者自己的语言拼出来 —— 而不是在缓存里存一份拼好的中文。
 */
function localize(list, lang) {
  const M = T(lang);
  return (list || []).map((t) => {
    const out = Object.assign({}, t);
    if (t.blurbKey && M[t.blurbKey]) out.blurb = M[t.blurbKey];
    if (t.noteKey && M[t.noteKey]) {
      const args = { ...(t.noteArgs || {}) };
      if (t.noteKey === 'dshRunningVersion') {
        args.version = t.version || M.dshUnknownVersion;
        args.edition = t.kind === 'cli' ? M.dshWebEdition : M.dshDesktopEdition;
      }
      out.note = fill(M[t.noteKey], args);
    }
    return out;
  });
}

/** 有哪些目标存在（装没装）。界面据此决定要不要显示选择按钮。 */
async function list(opts = {}) {
  const out = [];
  for (const t of ALL) {
    const d = await t.detectAsync();
    const base = {
      id: t.id, name: t.name, short: t.short,
      // blurb 按语言取（对象上只存 key）；取不到就退回 key 本身，
      // 至少不会变成空白 —— 界面显示一个 key 很丑，但比什么都没有强。
      blurb: T(opts.lang)[t.blurbKey] || t.blurbKey,
      // ★ blurbKey 必须一起带出去。
      //   第一版漏了它，于是 localize() 拿不到 key、重组时翻不动 blurb ——
      //   而 note 是好的，所以表现成「一半英文一半中文」。漏字段这种事
      //   在只有一条数据路径时看不出来，是 localize 那条测试抓出来的。
      blurbKey: t.blurbKey,
      ui: t.ui,
      installed: d.installed, exe: d.exe, source: d.source
    };
    if (opts.withStatus === false) {
      out.push(base);
    } else {
      let st = null;
      // 语言要带下去 —— note 也是服务端拼的
      try { st = await t.status(opts.lang); } catch (err) { st = { running: false, note: err.message }; }
      out.push(Object.assign(base, st));
    }
  }
  return out;
}

function get(id) { return ALL.find((t) => t.id === id) || null; }

/** 实际可用的目标（装了且能连）—— 只有一个时界面就不该再问「你要用哪个」 */
async function available() {
  const l = await list();
  return l.filter((t) => t.running);
}

module.exports = { list, localize, get, available, ALL, dsh };
