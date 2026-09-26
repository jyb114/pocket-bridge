// DSH 移动端网关 — 可连接的目标（DSH / Codex）
//
// 为什么要有这一层：
//
// 原来这个网关只服务一个东西 —— DSH。但电脑上跑的不止一个 AI 工具，
// 使用者的心智是「我要用手机上那个东西」，而不是「我要连 8080 端口的那个进程」。
// 所以把「能连什么」抽成一个概念：每个目标知道自己装没装、在不在跑、怎么起、怎么停。
//
// 两个目标的形态完全不同，这里如实体现，不硬凑成一样：
//
//   DSH   —— Electron 应用，自带一个网页界面，我们把它反代出去就行
//   Codex —— 命令行程序，能开一个 WebSocket 服务（app-server --listen ws://），
//            但没有网页界面，界面得我们自己写（pwa/codex.html）
//
// 所以这个模块只负责「发现 / 起停 / 探活」，界面各写各的。
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
    dshInstalled: '已安装，当前没在运行',
    dshMissing: '没找到 DSH',
    dshNoExe: '没找到 DSH 装在哪，请在 config.json 里填 dshExecutable',
    dshAlready: 'DSH 已经在运行了',
    dshStarted: 'DSH 已启动（端口 {port}）',
    dshNotListening: 'DSH 起来了但一直没开始监听，看看它自己的窗口有没有报错',
    dshStopped: '已关闭 DSH',
    dshNoRunning: '没找到正在运行的 DSH',

    cxReady: '服务已就绪（端口 {port}）',
    cxMissing: '没找到 Codex',
    cxInstalled: '已安装，远程服务没在运行',
    cxNoInstall: '没找到 Codex。装好 Codex 桌面版或 CLI 之后重试',
    cxAlready: 'Codex 远程服务已经在运行了',
    cxPortTaken: '端口 {port} 被别的程序占着，改一下 config.json 里 codex.port',
    cxStarted: 'Codex 远程服务已启动（端口 {port}）',
    cxExited: 'Codex 进程退出了。日志尾部：{tail}',
    cxNotReady: '等了 24 秒还没就绪，看 logs/codex-app-server.log',
    cxNotOurs: '这个端口上的 Codex 不是本网关启动的，没有去动它',
    cxNotRunning: 'Codex 远程服务没在运行',
    cxStopped: '已停止 Codex 远程服务（桌面版不受影响）',
    cxSignalSent: '已发出停止信号，端口还没释放',
    cxDesktopNotOpen: '电脑上的 Codex 没开着',
    cxDesktopClosed: '电脑上的 Codex 已关闭，会话占用也释放了',

    empty: '（空）',
    startFail: '启动失败: {msg}',
    stopFail: '停止失败: {msg}',
    killFail: '关闭失败: {msg}',
    blurbDsh: '电脑上那个完整的 DSH 界面，原样搬到手机上',
    blurbCodex: 'OpenAI Codex 的会话，手机上有专门的界面'
  },
  en: {
    dshRunning: 'Running (port {port})',
    dshInstalled: 'Installed, not running right now',
    dshMissing: 'DSH not found',
    dshNoExe: 'Could not find where DSH is installed — set dshExecutable in config.json',
    dshAlready: 'DSH is already running',
    dshStarted: 'DSH started (port {port})',
    dshNotListening: 'DSH came up but never started listening — check its own window for an error',
    dshStopped: 'DSH closed',
    dshNoRunning: 'No running DSH found',

    cxReady: 'Ready (port {port})',
    cxMissing: 'Codex not found',
    cxInstalled: 'Installed, remote service is not running',
    cxNoInstall: 'Codex not found. Install the Codex desktop app or CLI, then try again',
    cxAlready: 'The Codex remote service is already running',
    cxPortTaken: 'Port {port} is taken by something else — change codex.port in config.json',
    cxStarted: 'Codex remote service started (port {port})',
    cxExited: 'The Codex process exited. End of its log: {tail}',
    cxNotReady: 'Still not ready after 24 seconds — see logs/codex-app-server.log',
    cxNotOurs: 'The Codex on this port was not started by this gateway, so it was left alone',
    cxNotRunning: 'The Codex remote service is not running',
    cxStopped: 'Codex remote service stopped (the desktop app is unaffected)',
    cxSignalSent: 'Stop signal sent, but the port is not released yet',
    cxDesktopNotOpen: 'Codex is not open on the computer',
    cxDesktopClosed: 'Codex on the computer is closed and the session hold was released',

    empty: '(empty)',
    startFail: 'Could not start: {msg}',
    stopFail: 'Could not stop: {msg}',
    killFail: 'Could not close: {msg}',
    blurbDsh: 'The full DSH interface from your computer, moved to your phone as it is',
    blurbCodex: 'Your OpenAI Codex sessions, with a purpose-built phone interface'
  },
  es: {
    dshRunning: 'En marcha (puerto {port})',
    dshInstalled: 'Instalado, ahora mismo no está en marcha',
    dshMissing: 'No se encontró DSH',
    dshNoExe: 'No se encontró dónde está instalado DSH: rellena dshExecutable en config.json',
    dshAlready: 'DSH ya está en marcha',
    dshStarted: 'DSH iniciado (puerto {port})',
    dshNotListening: 'DSH arrancó pero nunca empezó a escuchar: mira si su propia ventana muestra algún error',
    dshStopped: 'DSH cerrado',
    dshNoRunning: 'No se encontró ningún DSH en marcha',

    cxReady: 'Listo (puerto {port})',
    cxMissing: 'No se encontró Codex',
    cxInstalled: 'Instalado, el servicio remoto no está en marcha',
    cxNoInstall: 'No se encontró Codex. Instala la app de escritorio o la CLI de Codex y vuelve a intentarlo',
    cxAlready: 'El servicio remoto de Codex ya está en marcha',
    cxPortTaken: 'El puerto {port} lo ocupa otro programa: cambia codex.port en config.json',
    cxStarted: 'Servicio remoto de Codex iniciado (puerto {port})',
    cxExited: 'El proceso de Codex terminó. Final de su registro: {tail}',
    cxNotReady: 'Sigue sin estar listo tras 24 segundos: mira logs/codex-app-server.log',
    cxNotOurs: 'El Codex de este puerto no lo arrancó esta pasarela, así que no se ha tocado',
    cxNotRunning: 'El servicio remoto de Codex no está en marcha',
    cxStopped: 'Servicio remoto de Codex detenido (la app de escritorio no se ve afectada)',
    cxSignalSent: 'Señal de parada enviada, pero el puerto aún no se ha liberado',
    cxDesktopNotOpen: 'Codex no está abierto en el ordenador',
    cxDesktopClosed: 'Codex en el ordenador está cerrado y se liberó la sesión retenida',

    empty: '(vacío)',
    startFail: 'No se pudo iniciar: {msg}',
    stopFail: 'No se pudo detener: {msg}',
    killFail: 'No se pudo cerrar: {msg}',
    blurbDsh: 'La interfaz completa de DSH de tu ordenador, tal cual, en el teléfono',
    blurbCodex: 'Tus sesiones de OpenAI Codex, con una interfaz pensada para el teléfono'
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
    const found = cfg.findDshExecutable();
    return { installed: !!found.path, exe: found.path, source: found.source };
  },

  async status(lang) {
    const d = dsh.detect();
    // DSH 每次启动换端口，所以要问启动器/日志
    const { discoverDshPort } = require('./discover.js');
    const port = await discoverDshPort();
    const running = port ? await portOpen(port) : false;
    return {
      installed: d.installed,
      running,
      port: running ? port : null,
      exe: d.exe,
      source: d.source,
      note: running ? fill(T(lang).dshRunning, { port })
        : (d.installed ? T(lang).dshInstalled : T(lang).dshMissing),
      // key + 实参也一并给出来：后台缓存那份拿不到语言，要靠这两个在响应时重组
      noteKey: running ? 'dshRunning' : (d.installed ? 'dshInstalled' : 'dshMissing'),
      noteArgs: running ? { port } : {}
    };
  },

  /**
   * 启动 DSH。用 explorer.exe 转一道手是为了让它脱离本进程树 ——
   * 否则网关一退出，DSH 也跟着没了。
   */
  async start(lang) {
    const d = dsh.detect();
    if (!d.installed) return { ok: false, message: T(lang).dshNoExe };

    const st = await dsh.status(lang);
    if (st.running) return { ok: true, message: T(lang).dshAlready, already: true };

    try {
      if (process.platform === 'win32') {
        spawn('explorer.exe', [d.exe], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [d.exe], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn(d.exe, [], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (err) {
      return { ok: false, message: fill(T(lang).startFail, { msg: err.message }) };
    }

    // 等它就绪（首次启动可能要十几秒）
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const s = await dsh.status(lang);
      if (s.running) return { ok: true, message: fill(T(lang).dshStarted, { port: s.port }), port: s.port };
    }
    return { ok: false, message: T(lang).dshNotListening };
  },

  async stop(lang) {
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

/**
 * 读出系统代理，转成环境变量。
 *
 * 为什么必须做这件事：这台机器上开着代理（v2rayN 之类），它设的是 **Windows 系统代理**。
 * Electron 应用（DSH、Codex 桌面版）会自动用它，所以桌面版一切正常；
 * 而 `codex.exe app-server` 是 Rust 程序，**不读系统代理，只认 HTTP(S)_PROXY 环境变量** ——
 * 由网关拉起来的那个实例因此连不上 OpenAI，所有回合都卡在
 * 「Reconnecting… request timed out」，界面上表现为「发出去了但一直没反应」。
 *
 * 更阴的是：这种情况下**审批请求永远不会出现**（因为压根没跑到要审批的那一步），
 * 看起来就像「审批功能没做」。
 */
function systemProxyEnv() {
  const env = {};
  if (process.platform !== 'win32') {
    // 类 Unix 上一般本来就用环境变量，不用额外做
    return env;
  }

  try {
    const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const q = (name) => {
      try {
        const out = execFileSync('reg', ['query', KEY, '/v', name],
          { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const m = out.match(new RegExp(name + '\\s+REG_\\w+\\s+(.+)'));
        return m ? m[1].trim() : null;
      } catch (err) { return null; }
    };

    const enabled = q('ProxyEnable');
    if (enabled !== '0x1' && enabled !== '1') return env;

    const server = q('ProxyServer');
    if (!server) return env;

    // ProxyServer 可能是 "host:port"，也可能是
    // "http=host:port;https=host:port" 这种按协议分的写法
    let http = null, https = null;
    if (server.includes('=')) {
      for (const seg of server.split(';')) {
        const [k, v] = seg.split('=');
        if (!v) continue;
        if (/^https$/i.test(k.trim())) https = v.trim();
        else if (/^http$/i.test(k.trim())) http = v.trim();
      }
    } else {
      http = https = server;
    }

    const url = (v) => (v ? (/^https?:\/\//.test(v) ? v : 'http://' + v) : null);
    if (http) { env.HTTP_PROXY = url(http); env.http_proxy = url(http); }
    if (https) { env.HTTPS_PROXY = url(https); env.https_proxy = url(https); }

    // 本机地址不走代理 —— 中间层和 app-server 之间全是回环流量，
    // 绕进代理里只会平白多一跳，还可能因为代理不转发而连不上。
    const bypass = q('ProxyOverride') || '';
    const local = ['localhost', '127.0.0.1', '::1', '192.168.*', '10.*'];
    for (const b of bypass.split(';')) {
      const t = b.trim();
      if (t && t !== '<local>' && local.indexOf(t) < 0) local.push(t);
    }
    env.NO_PROXY = local.join(',');
    env.no_proxy = env.NO_PROXY;
  } catch (err) {
    // 读不到就不设 —— 直连本来也能用的情况很多，不该因为读注册表失败就不启动
  }
  return env;
}

// ── Codex ─────────────────────────────────────────────────────────────────────

const codex = {
  id: 'codex',
  name: 'Codex',
  short: 'Codex',
  blurbKey: 'blurbCodex',
  ui: '/codex',

  /** Codex 的 CLI 装在 LocalAppData 下一个带哈希的目录里，版本升级会换目录 */
  detect() {
    const conf = cfg.loadConfig();
    if (conf.codex && conf.codex.executable && fs.existsSync(conf.codex.executable)) {
      return { installed: true, exe: conf.codex.executable, source: 'config.json' };
    }

    const roots = process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin')]
      : [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];

    const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex';

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;

      // 关键：**按修改时间从新到旧**排，不能按目录顺序取。
      //
      // 实测这台机器上 bin 下同时躺着 3 个版本目录（升级不会删旧的）。
      // 按目录顺序取是听天由命 —— 很可能挑到一个旧版本，而且是静默的：
      // 一切看起来正常，只是用的是过期的 CLI。
      const subs = (() => {
        try {
          return fs.readdirSync(root)
            .map((name) => {
              const p = path.join(root, name, exeName);
              let st = null;
              try { st = fs.statSync(p); } catch (err) { return null; }
              return st.isFile() ? { path: p, mtime: st.mtimeMs } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);
        } catch (err) { return []; }
      })();

      if (subs.length) {
        return {
          installed: true,
          exe: subs[0].path,
          source: `自动发现（${subs.length} 个版本里取最新的）`
        };
      }

      const direct = path.join(root, exeName);
      if (fs.existsSync(direct)) return { installed: true, exe: direct, source: '自动发现' };
    }

    // 有些桌面版会把 CLI 放在应用目录里
    const appCli = process.platform === 'win32'
      ? path.join(process.env.ProgramFiles || '', 'WindowsApps')
      : '';
    if (appCli && fs.existsSync(appCli)) {
      try {
        for (const d of fs.readdirSync(appCli)) {
          if (!/^OpenAI\.Codex/i.test(d)) continue;
          const p = path.join(appCli, d, 'app', 'resources', 'codex.exe');
          if (fs.existsSync(p)) return { installed: true, exe: p, source: '应用目录' };
        }
      } catch (err) { /* 权限不够就算了 */ }
    }

    return { installed: false, exe: null, source: '未找到' };
  },

  port() {
    const conf = cfg.loadConfig();
    return Number(conf.codex && conf.codex.port) || 18790;
  },

  /** 这个 app-server 是不是我们起的（区别于 Codex 桌面版自己那个） */
  managedPid() {
    const pid = readPid('codex');
    return alive(pid) ? pid : null;
  },

  async status(lang) {
    const d = codex.detect();
    const port = codex.port();
    const listening = await portOpen(port);
    let healthy = false;
    let threads = null;

    if (listening) {
      const h = await httpJson(`http://127.0.0.1:${port}/healthz`);
      healthy = !!h && h.status === 200;
    }

    return {
      installed: d.installed,
      running: listening && healthy,
      port: listening ? port : null,
      exe: d.exe,
      source: d.source,
      managed: !!codex.managedPid(),
      note: listening && healthy
        ? fill(T(lang).cxReady, { port })
        : (!d.installed ? T(lang).cxMissing : T(lang).cxInstalled),
      noteKey: (listening && healthy)
        ? 'cxReady'
        : (!d.installed ? 'cxMissing' : 'cxInstalled'),
      noteArgs: (listening && healthy) ? { port } : {}
    };
  },

  /**
   * 启动一个带 WebSocket 的 app-server。
   *
   * 注意它和 Codex 桌面版自己那个 app-server 是两个实例，但共用 ~/.codex 里的数据 ——
   * 所以手机上看到的就是电脑上那些会话（实测过：thread/list 返回的是真实会话）。
   * 桌面版不需要关掉，也不受影响。
   */
  async start(lang) {
    const d = codex.detect();
    if (!d.installed) {
      return { ok: false, message: T(lang).cxNoInstall };
    }

    const st = await codex.status(lang);
    if (st.running) return { ok: true, message: T(lang).cxAlready, already: true };

    const port = codex.port();
    if (await portOpen(port)) {
      return { ok: false, message: fill(T(lang).cxPortTaken, { port }) };
    }

    const logFile = path.join(LOG_DIR, 'codex-app-server.log');
    let out;
    try { out = fs.openSync(logFile, 'a'); } catch (err) { out = 'ignore'; }

    let child;
    try {
      const proxy = systemProxyEnv();
      if (proxy.HTTPS_PROXY) {
        log(`Codex 将经由系统代理 ${proxy.HTTPS_PROXY} 出网（Rust 程序不读系统代理，得显式告诉它）`);
      }
      child = spawn(d.exe, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
        detached: true,
        stdio: ['ignore', out, out],
        cwd: os.homedir(),
        env: Object.assign({}, process.env, proxy)
      });
      child.unref();
    } catch (err) {
      return { ok: false, message: fill(T(lang).startFail, { msg: err.message }) };
    }

    writePid('codex', child.pid);

    for (let i = 0; i < 30; i++) {
      await sleep(800);
      if (await portOpen(port)) {
        const h = await httpJson(`http://127.0.0.1:${port}/healthz`);
        if (h && h.status === 200) {
          return { ok: true, message: fill(T(lang).cxStarted, { port }), port };
        }
      }
      if (!alive(child.pid)) {
        let tail = '';
        try { tail = fs.readFileSync(logFile, 'utf8').slice(-400); } catch (err) { }
        return { ok: false, message: fill(T(lang).cxExited, { tail: tail || T(lang).empty }) };
      }
    }
    return { ok: false, message: T(lang).cxNotReady };
  },

  /** 只停我们起的那个实例，不动 Codex 桌面版自己那个 */
  async stop(lang) {
    const pid = readPid('codex');
    if (!pid || !alive(pid)) {
      clearPid('codex');
      // 端口还占着的话，说明是别的实例（比如桌面版），不该由我们关
      if (await portOpen(codex.port())) {
        return { ok: false, message: T(lang).cxNotOurs };
      }
      return { ok: false, message: T(lang).cxNotRunning };
    }

    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'],
          { timeout: 8000, windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (err) {
      return { ok: false, message: fill(T(lang).stopFail, { msg: err.message }) };
    }
    clearPid('codex');

    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (!(await portOpen(codex.port()))) {
        return { ok: true, message: T(lang).cxStopped };
      }
    }
    return { ok: true, message: T(lang).cxSignalSent };
  },

  /**
   * 桌面版是不是开着（它一开着，就可能占着某些会话的独占写锁）。
   */
  desktopStatus() {
    if (process.platform !== 'win32') return { running: false, count: 0 };
    try {
      const out = execFileSync('tasklist',
        ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH'],
        { encoding: 'utf8', timeout: 6000, windowsHide: true });
      const n = (out.match(/ChatGPT\.exe/gi) || []).length;
      return { running: n > 0, count: n };
    } catch (err) {
      return { running: false, count: 0, error: err.message };
    }
  },

  /**
   * 关掉电脑上的 Codex 桌面版，把会话的写锁释放出来。
   *
   * 这里有个必须小心的地方：**桌面版和我们自己起的 app-server 是同一个二进制**
   * （都在 LocalAppData\OpenAI\Codex\bin 下，都叫 codex.exe）。
   * 按进程名 taskkill 会把我们自己也一起杀掉 —— 这个坑我刚踩过：
   * 命令行里写 taskkill /IM Codex.exe /F，结果两个都没了。
   *
   * 所以分开处理：
   *   - 桌面版的界面进程叫 ChatGPT.exe（MSIX 包里的 Electron 壳），按名字杀没问题
   *   - codex.exe 要看命令行：带 `--listen` 的是我们的，**不能碰**
   */
  async stopDesktop(lang) {
    const st = codex.desktopStatus();
    const mine = readPid('codex');
    let killed = 0;

    try {
      if (process.platform === 'win32') {
        // 1) 界面进程
        if (st.running) {
          execFileSync('taskkill', ['/IM', 'ChatGPT.exe', '/F'],
            { timeout: 10000, windowsHide: true });
          killed++;
        }
        // 2) 桌面版自己的 codex.exe（没有 --listen 的那些），跳过我们的
        const all = require('child_process').execSync(
          'wmic process where "name=\'codex.exe\'" get ProcessId,CommandLine /format:csv',
          { encoding: 'utf8', timeout: 10000, windowsHide: true }
        );
        for (const line of all.split('\n')) {
          if (!/codex\.exe/i.test(line)) continue;
          if (/--listen/i.test(line)) continue;        // 我们的，别动
          const m = line.trim().match(/,(\d+)\s*$/);
          if (!m) continue;
          const pid = Number(m[1]);
          if (mine && pid === mine) continue;
          try {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'],
              { timeout: 8000, windowsHide: true });
            killed++;
          } catch (err) { /* 可能已经退了 */ }
        }
        // 3) 桌面版拉起来的运行时进程（cua_node 下的 node / node_repl）
        try {
          const out = execFileSync('tasklist',
            ['/FI', 'IMAGENAME eq node_repl.exe', '/NH'],
            { encoding: 'utf8', timeout: 6000, windowsHide: true });
          if (/node_repl/i.test(out)) {
            execFileSync('taskkill', ['/IM', 'node_repl.exe', '/F'],
              { timeout: 8000, windowsHide: true });
          }
        } catch (err) { /* 没有就算了 */ }
      } else {
        execFileSync('pkill', ['-f', 'ChatGPT'], { timeout: 8000 });
        killed++;
      }
    } catch (err) {
      if (!killed) return { ok: false, message: fill(T(lang).killFail, { msg: err.message }) };
    }

    if (!killed) return { ok: false, message: T(lang).cxDesktopNotOpen };

    // 等锁真的释放 —— 进程没了不等于锁立刻没了
    await sleep(3000);

    // 顺手清掉那个会话残留的锁文件（如果没人持有了）
    // 不清的话，某些情况下会留下一个谁也进不去的「僵尸会话」
    return { ok: true, message: T(lang).cxDesktopClosed };
  }
};

// ── 对外 ──────────────────────────────────────────────────────────────────────

const ALL = [dsh, codex];

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
    if (t.noteKey && M[t.noteKey]) out.note = fill(M[t.noteKey], t.noteArgs || {});
    return out;
  });
}

/** 有哪些目标存在（装没装）。界面据此决定要不要显示选择按钮。 */
async function list(opts = {}) {
  const out = [];
  for (const t of ALL) {
    const d = t.detect();
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
  return l.filter((t) => t.installed && t.running);
}

module.exports = { list, localize, get, available, ALL, dsh, codex };
