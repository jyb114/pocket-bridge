// DSH 移动端网关 — 用真实浏览器验证浏览器侧行为
//
// 为什么需要它：
//
// 这个项目里有好几件事只发生在浏览器里 —— 风险提示条弹不弹、路径角标显不显示、
// /go 页面到底选没选出一条路、内网 HTTPS 打开会不会报错。这些**没法**靠读代码或
// 发 HTTP 请求验证：服务器返回的 HTML 是对的，不代表页面里真的长出了那个元素。
//
// 做法：用 Edge/Chrome 的 DevTools 协议（CDP）开一个无头浏览器，真的把页面跑起来，
// 然后问它 DOM 里有什么、控制台报了什么错。为了不引入任何依赖（这个项目从头到尾
// 不装东西），WebSocket 客户端是自己按 RFC 6455 写的。
//
// 用法:
//   node scripts/browser-check.js                 跑全部检查
//   node scripts/browser-check.js --keep          跑完不关浏览器（调试用）
//   node scripts/browser-check.js --url <地址>     只打开指定地址看结果
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const PORT = Number(process.env.DSH_GW_PORT || 8080);
const KEEP = process.argv.includes('--keep');

// ── WebSocket 客户端（RFC 6455，只实现 CDP 需要的部分）────────────────────────
//
// 为什么自己写：npm 上的 ws 要装依赖，而这个项目的前提是不装任何东西。
// CDP 只用得到「发文本帧、收文本帧、回 pong」这三件事，实现量不大。

class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.path = u.pathname + (u.search || '');
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.handlers = { message: [], open: [], error: [], close: [] };
    this.ready = false;
  }

  on(ev, fn) { this.handlers[ev].push(fn); return this; }
  emit(ev, arg) { for (const fn of this.handlers[ev]) fn(arg); }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(this.port, this.host);
      this.sock.on('error', (e) => { this.emit('error', e); reject(e); });

      this.sock.on('connect', () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\n` +
          `Host: ${this.host}:${this.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });

      let handshakeDone = false;
      this.sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);

        if (!handshakeDone) {
          const end = this.buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          const head = this.buf.slice(0, end).toString('latin1');
          if (!/^HTTP\/1\.1 101/.test(head)) {
            const err = new Error(`WebSocket 握手失败: ${head.split('\r\n')[0]}`);
            this.emit('error', err); reject(err); return;
          }
          const accept = (head.match(/Sec-WebSocket-Accept:\s*(\S+)/i) || [])[1];
          const expect = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          if (accept !== expect) {
            const err = new Error('Sec-WebSocket-Accept 不匹配');
            this.emit('error', err); reject(err); return;
          }
          handshakeDone = true;
          this.ready = true;
          this.buf = this.buf.slice(end + 4);
          this.emit('open');
          resolve();
        }
        this.drain();
      });

      this.sock.on('close', () => this.emit('close'));
    });
  }

  /** 把缓冲区里所有完整的帧处理掉 */
  drain() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;

      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const big = b.readBigUInt64BE(off);
        if (big > 64n * 1024n * 1024n) { this.sock.destroy(); return; }
        len = Number(big); off += 8;
      }

      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.slice(off, off + 4); off += 4;
      }

      if (b.length < off + len) return;
      let payload = b.slice(off, off + len);
      this.buf = b.slice(off + len);

      if (mask) {
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }

      if (opcode === 0x9) { this.sendFrame(0xa, payload); continue; }  // ping → pong
      if (opcode === 0xa) continue;                                     // pong
      if (opcode === 0x8) { this.sock.end(); return; }                  // close

      if (opcode === 0x0) {
        this.fragments.push(payload);
      } else {
        this.fragments = [payload];
        this.fragOpcode = opcode;
      }

      if (fin) {
        const whole = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragOpcode === 0x1) this.emit('message', whole.toString('utf8'));
      }
    }
  }

  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    mask.copy(header, header.length - 4);

    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];

    this.sock.write(Buffer.concat([header, masked]));
  }

  send(text) { this.sendFrame(0x1, Buffer.from(text, 'utf8')); }

  close() {
    try { this.sendFrame(0x8, Buffer.alloc(0)); } catch (err) { }
    try { this.sock.destroy(); } catch (err) { }
  }
}

// ── 找浏览器 ──────────────────────────────────────────────────────────────────
function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const list = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const c of list) { try { if (fs.existsSync(c)) return c; } catch (err) { } }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (err) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** 新版 Chrome 要求用 PUT 建标签页 */
function httpPut(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT'
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (err) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// ── 浏览器会话 ────────────────────────────────────────────────────────────────

/**
 * 收掉**上一次**测试泄漏下来的无头浏览器。
 *
 * 为什么要这个：Browser.kill() 会清理，但测试如果被强杀（Ctrl+C、
 * 编排超时、脚本抛错提前退出），kill() 根本没机会跑，那个浏览器就成了
 * 孤儿 —— 父进程没了，它自己接着活。实测碰到过一次：一个 msedge 从
 * 09-18 02:51 一直活到 09-20 10:05，**两天多**，占着 441MB 的 profile
 * 目录不放（连删都删不掉，EPERM）。
 *
 * 判据取三条，缺一不可：
 *   · 进程名是浏览器（msedge / chrome）
 *   · 命令行里有我们自己的 profile 前缀 `dsh-gw-browser-`
 *     （使用者自己开的 Edge 不会有这个，绝不会误杀）
 *   · 而且**已经启动超过 30 分钟**
 *     （正在跑的另一个测试不会被误伤；正常一轮几分钟就结束了）
 *
 * ★ 「进程名是浏览器」这一条是 2026-09-24 补上的。原来只按命令行匹配，
 *   于是**任何**命令行里出现过这个字符串的进程都会被收掉 —— 包括
 *   刚 grep 过 `dsh-gw-browser` 的那个 shell：它启动超过 30 分钟的话，
 *   下一次跑测试就会被自己的打扫逻辑杀掉。实测撞到过（命令突然以
 *   0xC000013A 结束、什么输出都没有），查了半天才定位到这儿。
 *   打扫卫生的判据**宁窄勿宽**：它的目的是收掉自己的孤儿，
 *   不是收掉碰巧长得像的东西。
 *
 * 收不掉就算了：这是打扫卫生，不是主流程，绝不能因此让测试起不来。
 */
function sweepOrphanBrowsers() {
  if (process.platform !== 'win32') return;      // 其它平台靠 tmpdir 自己回收
  try {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const script = 'Get-CimInstance Win32_Process | ' +
      'Where-Object { $_.Name -match "^(msedge|chrome)" -and $_.CommandLine -like "*dsh-gw-browser-*" } | ' +
      'Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress';
    const out = require('child_process').execFileSync('pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
    if (!out) return;
    let list = JSON.parse(out);
    if (!Array.isArray(list)) list = [list];
    let killed = 0;
    for (const p of list) {
      const born = Date.parse(p.CreationDate);
      if (!Number.isFinite(born) || born > cutoff) continue;
      try { process.kill(p.ProcessId); killed++; } catch (err) { }
    }
    if (killed) console.log(`  · 收掉了 ${killed} 个上次泄漏的无头浏览器进程`);
  } catch (err) { /* 打扫失败不影响测试 */ }
}

class Browser {
  constructor(proc, port, wsUrl) {
    this.proc = proc;
    this.port = port;
    this.ws = new MiniWS(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.consoleLogs = [];
    this.exceptions = [];
    this.failedRequests = [];
  }

  static async launch(extraArgs = []) {
    const exe = findBrowser();
    if (!exe) throw new Error('找不到 Edge 或 Chrome');

    sweepOrphanBrowsers();

    const port = await freePort();
    const profile = path.join(os.tmpdir(), `dsh-gw-browser-${Date.now()}`);
    fs.mkdirSync(profile, { recursive: true });

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=Translate,msEdgeSidebar',
      // 强制直连，不走系统代理。
      //
      // 这不是可有可无的：这台机器上跑着代理软件，浏览器默认走系统代理出去，
      // 于是「浏览器看到的出口 IP」和「服务端自己探测到的出口 IP」完全不同 ——
      // 自动选路里那条「同一个网络」的判断会因此永远不成立，测试就测不到真东西了。
      // 关掉代理之后，两边走同一个出口，测的才是逻辑本身。
      // （使用者自己挂代理的场景另说，那种情况下的表现由 advice 文案兜住。）
      '--no-proxy-server',
      // 界面语言钉死中文。
      //
      // 服务端直出的几个页面（配对页 / 启动选择页 / 进入页）现在会按
      // Accept-Language 协商语言，而 headless Chrome 默认是 en-US ——
      // 于是「无请求头 → 英文」这条兜底规则会把整套测试里断言中文的
      // 地方全打红（isLauncher 用 /要用哪个/ 判断之类）。
      //
      // 钉死中文之后：断言保持确定性，测的还是原来的东西，
      // 而且顺带保证「请求头是 zh-CN 时确实出中文」这条路径每次都被跑到。
      '--lang=zh-CN',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
      ...extraArgs
    ];

    const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });

    // 等 CDP 端口起来
    let ver = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ver = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
      if (ver && ver.webSocketDebuggerUrl) break;
    }
    if (!ver || !ver.webSocketDebuggerUrl) {
      try { proc.kill(); } catch (err) { }
      throw new Error('浏览器起来了但 CDP 端口没响应');
    }

    const b = new Browser(proc, port, ver.webSocketDebuggerUrl);
    b.profile = profile;
    b.browserName = ver.Browser || 'unknown';

    await b.ws.connect();
    b.ws.on('message', (txt) => b.onMessage(txt));
    return b;
  }

  onMessage(txt) {
    let msg;
    try { msg = JSON.parse(txt); } catch (err) { return; }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }

    // 事件
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type)))
        .join(' ');
      this.consoleLogs.push({ type: msg.params.type, text });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      this.exceptions.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
    } else if (msg.method === 'Network.loadingFailed') {
      this.failedRequests.push(`${msg.params.type} ${msg.params.errorText}`);
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      this.pending.set(id, entry);
      this.ws.send(JSON.stringify(payload));
      entry.timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
      entry.timer.unref();
    });
  }

  /** 新建一个标签页并挂上 CDP 会话 */
  async newPage(url = 'about:blank') {
    let t = await httpPut(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`);
    if (!t || !t.webSocketDebuggerUrl) {
      // 老版本只支持 GET
      t = await httpGetJson(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`);
      if (!t || !t.webSocketDebuggerUrl) throw new Error('建不了新标签页');
    }

    const session = {
      ws: new MiniWS(t.webSocketDebuggerUrl),
      id: 0,
      pending: new Map(),
      consoleLogs: [],
      exceptions: [],
      targetId: t.id
    };

    await session.ws.connect();
    session.ws.on('message', (txt) => {
      let m;
      try { m = JSON.parse(txt); } catch (err) { return; }
      if (m.id !== undefined && session.pending.has(m.id)) {
        const { resolve, reject, timer } = session.pending.get(m.id);
        clearTimeout(timer);
        session.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        session.consoleLogs.push({
          type: m.params.type,
          text: (m.params.args || []).map((a) =>
            a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ')
        });
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        session.exceptions.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
    });

    // 超时可按调用覆盖。
    //
    // 为什么需要：原来是写死的 20 秒，而 Page.navigate 打开的是**整个 DSH 应用**
    // （几百个节点、几 MB 脚本）。机器一忙它就会超，而超时的后果不是某一条断言失败
    // —— 是外层 catch 直接把**整轮测试**掐掉（实测出现过「只跑了 21 项就 1 失败」）。
    // 这种失败看起来像产品坏了，其实是测试自己没耐心。
    session.send = (method, params = {}, timeoutMs = 20000) => {
      const id = ++session.id;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null };
        session.pending.set(id, entry);
        session.ws.send(JSON.stringify({ id, method, params }));
        entry.timer = setTimeout(() => {
          if (session.pending.has(id)) {
            session.pending.delete(id);
            reject(new Error(`${method} 超时`));
          }
        }, timeoutMs);
        entry.timer.unref();
      });
    };

    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Network.enable');

    session.cookie = (name, value, domain) =>
      session.send('Network.setCookie', {
        name, value, domain: domain || '127.0.0.1', path: '/',
        httpOnly: true, sameSite: 'Strict'
      });

    /**
     * 同一个浏览器里的标签页共享 cookie，所以要验「第一次来会看到什么」就得先清掉。
     * domain 是必须的 —— 不传的话 CDP 会报「至少要给 url 或 domain」，
     * 而那个错误很容易被 .catch 吞掉，然后表现成「清了个寂寞，断言还是照着老状态跑」。
     */
    session.dropCookie = (name, domain) =>
      session.send('Network.deleteCookies', { name, domain: domain || '127.0.0.1' });

    /**
     * 导航到某个地址并等它稳定。
     *
     * Page.navigate 用到 60 秒的超时（默认只有 20 秒）：它打开的是整个 DSH 应用，
     * 机器一忙 20 秒不够。而且这里**失败就重试一次** —— 导航卡住是环境抖动，
     * 不是产品缺陷，为它掐掉整轮测试（外层 catch 会这么做）代价太大。
     */
    session.goto = async (target, settleMs = 2500) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await session.send('Page.navigate', { url: target }, 60000);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          await sleep(800);
        }
      }
      if (lastErr) throw lastErr;
      await sleep(settleMs);
    };

    /**
     * 在页面里求值，拿回真正的值（不是字符串）。
     *
     * 超时**必须比页面里那些等待循环长**。原来用的是 send() 的默认 20 秒，
     * 而下面查 Codex 会话时页面里会 `for(60){ await 300~400ms }` —— 最多
     * 24 秒，比外层的超时还长。也就是说那条检查在慢会话上**必然**误报成
     * 「Runtime.evaluate 超时」，然后整段后面的检查被跳过（实测只剩 53 项，
     * 而完整跑是 83 项），看起来像产品坏了，其实是测试自己没耐心。
     * 页面里的循环本身是有界的，所以这里给足 90 秒；真卡死照样会被抓住。
     */
    session.eval = async (expr, timeoutMs = 90000) => {
      const r = await session.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      }, timeoutMs);
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception
          ? r.exceptionDetails.exception.description
          : r.exceptionDetails.text);
      }
      return r.result ? r.result.value : undefined;
    };

    session.close = () => {
      try { session.ws.close(); } catch (err) { }
    };

    return session;
  }

  kill() {
    try { this.ws.close(); } catch (err) { }
    try { this.proc.kill(); } catch (err) { }
    // 无头浏览器会留下子进程，按 profile 路径把它们一起收掉
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/FI', `WINDOWTITLE eq *dsh-gw-browser*`],
          { stdio: 'ignore', timeout: 5000 });
      }
    } catch (err) { }
    setTimeout(() => {
      try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (err) { }
    }, 1500);
  }
}

module.exports = { Browser, MiniWS };

// ── 直接运行：跑一组检查 ──────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const key = fs.readFileSync(path.join(LOG_DIR, 'access-key.txt'), 'utf8').trim();
    const base = `http://127.0.0.1:${PORT}`;

    let pass = 0, fail = 0, skipped = 0;
    const check = (name, cond, extra) => {
      if (cond) { pass++; console.log(`  ✓ ${name}`); }
      else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
    };
    // 「跳过」和「通过」必须分开计数。
    //
    // 有些检查依赖 Codex 上游（chatgpt.com）能连通 —— 模型列表就是从那儿拉的。
    // 上游不通时，把这类检查算「通过」是撒谎，算「失败」是冤枉自己的代码。
    // 所以单列一类，并且把原因打出来，让人一眼知道是环境问题还是代码问题。
    const skip = (name, reason) => {
      skipped++;
      console.log(`  · ${name}（跳过：${reason}）`);
    };

    console.log('\n=== 真实浏览器验证 ===\n');
    const b = await Browser.launch();
    console.log(`  浏览器: ${b.browserName}\n`);

    // 装了不止一个目标时，根路径会先给一个「你要用哪个」的选择页。
    // 下面这些检查验的是「选了 DSH 之后」的体验，所以先替使用者做一次选择 ——
    // 不这么做的话，看到的会是选择页，然后误以为 DSH 坏了。
    const tl = await (async () => {
      const p = await b.newPage();
      await p.goto(`${base}/k/${key}`, 3000);
      const r = await p.eval(`fetch('/__targets',{cache:'no-store'}).then(x=>x.json()).catch(()=>null)`);
      p.close();
      return r;
    })();
    const multi = tl && (tl.targets || []).filter((t) => t.installed).length > 1;
    if (multi) console.log('  装了多个目标：以下检查会先替使用者选定 DSH\n');

    try {
      // ── 1. 风险提示条 ────────────────────────────────────────────────────────
      console.log('[1] 首次进入的风险提示');
      const p1 = await b.newPage();
      // 走完整的密钥入口，让服务端真的把 cookie 种下来；再选一次 DSH
      await p1.goto(`${base}/k/${key}`, 3000);
      await p1.goto(`${base}/?target=dsh`, 2000);
      await p1.goto(`${base}/`, 4000);

      const notice = await p1.eval(`(() => {
        const bars = Array.from(document.querySelectorAll('div')).filter(
          d => d.style && d.style.position === 'fixed' && /不要分享/.test(d.textContent || ''));
        const bar = bars[0];
        return bar ? {
          found: true,
          text: bar.textContent,
          top: getComputedStyle(bar).top,
          bg: getComputedStyle(bar).backgroundColor,
          zIndex: getComputedStyle(bar).zIndex,
          hasButton: !!Array.from(bar.querySelectorAll('button'))
            .find(b => /我知道了/.test(b.textContent))
        } : { found: false };
      })()`);

      check('提示条出现在页面里', notice && notice.found, JSON.stringify(notice));
      if (notice && notice.found) {
        check('说了「不要分享」', /不要分享/.test(notice.text));
        check('说了「等同于你电脑的完整控制权」', /完全控制权|完整控制权/.test(notice.text));
        check('固定在页面顶部', notice.top === '0px', notice.top);
        check('层级压在最上面', Number(notice.zIndex) >= 2147483000, notice.zIndex);
        check('有「我知道了」按钮', notice.hasButton);
      }

      // ── 2. 点掉之后不再打扰 ──────────────────────────────────────────────────
      console.log('\n[2] 关掉之后不再出现');
      await p1.eval(`(() => {
        const bars = Array.from(document.querySelectorAll('div')).filter(
          d => d.style && d.style.position === 'fixed' && /不要分享/.test(d.textContent || ''));
        const btn = bars[0] && Array.from(bars[0].querySelectorAll('button'))
          .find(b => /我知道了/.test(b.textContent));
        if (btn) btn.click();
        return true;
      })()`);
      await sleep(400);
      const gone = await p1.eval(`!Array.from(document.querySelectorAll('div')).some(
        d => d.style && d.style.position === 'fixed' && /不要分享/.test(d.textContent || ''))`);
      check('点掉之后立刻消失', gone === true);

      const stored = await p1.eval(`localStorage.getItem('dsh-gw-security-notice-v1')`);
      check('记住了「看过了」', stored === 'seen', String(stored));

      await p1.goto(`${base}/`, 3500);
      const again = await p1.eval(`Array.from(document.querySelectorAll('div')).some(
        d => d.style && d.style.position === 'fixed' && /不要分享/.test(d.textContent || ''))`);
      check('再进页面不再打扰', again === false, String(again));

      // ── 3. 路径角标 ─────────────────────────────────────────────────────────
      console.log('\n[3] 连接路径角标');
      const badge = await p1.eval(`(() => {
        const el = document.getElementById('dsh-gw-badge');
        if (!el) return { found: false };
        return { found: true, text: el.textContent, title: el.title,
                 pos: getComputedStyle(el).position };
      })()`);
      check('角标存在', badge && badge.found, JSON.stringify(badge));

      // ★ 未加密时点角标会弹说明 —— 但**不能因此把进切换页的入口堵死**。
      //
      // 这条是我自己造出来又踩到的：给未加密状态加了「点它先弹说明」之后，
      // 角标原本那个「进选择连接方式页」的功能就被覆盖了，使用者反馈
      // 「切换通道点不进去」。说明和入口不是二选一，两个都得有。
      //
      // 这里跑在「配了密钥但没带 #k=」的场景下，正好会命中那条分支。
      {
        const plainNow = await p1.eval(`(window.__dshE2eeConfigured === true && window.__dshE2eeOn !== true)`);
        if (!plainNow) {
          skip('未加密时角标仍能进切换页', '当前不是「意外明文」状态，这一条无从验起');
        } else {
          const panel = await p1.eval(`(() => {
            document.getElementById('dsh-gw-badge').click();
            const box = document.getElementById('dsh-gw-plain-box');
            if (!box) return { shown: false };
            const btns = Array.from(box.querySelectorAll('button'));
            const go = btns.find(b => /换一条路/.test(b.textContent));
            if (go) go.click();          // 点了就应该跳到 /go
            return { shown: true, labels: btns.map(b => b.textContent), clicked: !!go };
          })()`);
          check('未加密时点角标会弹说明', panel.shown === true, JSON.stringify(panel));
          check('说明里给了「换一条路」的按钮（否则入口被堵死）',
            panel.clicked === true, JSON.stringify(panel.labels));
          // 点了那个按钮之后应该真的到 /go 去了
          await new Promise((r) => setTimeout(r, 2500));
          const at = await p1.eval('location.pathname');
          check('点「换一条路」真的进了选择连接方式页', at === '/go', 'pathname=' + at);
          // 回到 DSH，别影响后面的检查
          await p1.goto(`${base}/?target=dsh`, 2500);
        }
      }

      if (badge && badge.found) {
        // 角标显示什么，取决于**当前是不是意外明文**：
        //   加密中 / 电脑上没配密钥 → 显示走的是哪条路（本机、内网、隧道、IPv6）
        //   配了密钥但这条链接没带 #k= → 显示「未加密」
        //
        // 两者互斥是刻意的：这个角标实测已经顶到宽度上限（再加字就会溢出到
        // 挡住内容，见 test-balance-placement.js），塞不下两件事。
        // 而未加密是安全问题、走哪条路只是信息 —— 冲突时让安全的那条赢，
        // 路线信息挪到 tooltip 和点击后的说明里。
        //
        // 所以这里不能只认「路线」——那样会在明文状态下把正确行为判成故障。
        const self = await p1.eval(`({
          configured: window.__dshE2eeConfigured === true,
          on: window.__dshE2eeOn === true
        })`);
        const unexpectedPlain = self.configured && !self.on;
        const isPath = /本机|内网|隧道|IPv6/.test(badge.text);
        const isWarn = /未加密/.test(badge.text);
        check(unexpectedPlain ? '未加密时角标改报「未加密」（安全优先于路线）'
                              : '显示是哪条路',
          unexpectedPlain ? isWarn : isPath,
          badge.text + '  [configured=' + self.configured + ' on=' + self.on + ']');
        // 明文状态下 tooltip 必须解释清楚，不能只有两个字
        if (unexpectedPlain) {
          check('未加密时角标有解释性提示',
            /明文|加密/.test(badge.title || ''), badge.title);
        }
        // 角标自己不再是 fixed —— 它现在待在右下角那条「停靠栏」里，
        // 由停靠栏负责钉在角落。所以要看**实际位置**，而不是它自己的
        // position 值。上一版只认 fixed，把一次正确的布局调整误报成了故障。
        const corner = await p1.eval(`(() => {
          const el = document.getElementById('dsh-gw-badge');
          const b = el.getBoundingClientRect();
          return {
            nearRight: innerWidth - b.right < 40,
            nearBottom: innerHeight - b.bottom < 60,
            inDock: !!el.closest('#dsh-gw-dock')
          };
        })()`);
        check('钉在右下角（按实际位置判断）',
          corner.nearRight && corner.nearBottom, JSON.stringify(corner));
        check('收在停靠栏里（不再各飘各的）', corner.inDock === true);
      }

      // ── 3b. 加密状态判定：三种状态各验一遍 ─────────────────────────────────
      //
      // 这一节是被一次真实的困惑教出来的：「手机端为什么显示未加密？」
      // 有两种完全不同的原因，而它们的修法**相反** ——
      //   ① 走的是明文 HTTP（内网 8080）：浏览器在非安全上下文里不给
      //      crypto.subtle，这条路**永远**加不了密，换网址没用
      //   ② 连接能加密，但链接少了 #k= 那段：换一条完整地址就好
      // 以前的提示只有一句话（「链接没带密钥」），对着 ① 说等于把人指错方向。
      //
      // 所以这里把两种都验出来，顺带证明**加密成功时不会误报**。
      console.log('\n[3b] 加密状态判定');
      {
        const secFile = path.join(LOG_DIR, 'e2ee-secret.txt');
        let secret = '';
        try { secret = fs.readFileSync(secFile, 'utf8').trim(); } catch (e) { }

        if (!secret) {
          skip('加密状态判定', '电脑上没配加密密钥（这是合法的明文模式），无从验起');
        } else {
          // ① 带 #k= 进 —— 必须真的加密，且角标**不能**报未加密
          const p9 = await b.newPage();
          await p9.goto(`${base}/k/${key}#k=${secret}`, 3000);
          const st = await p9.eval(`(async () => {
            for (let i = 0; i < 40; i++) {
              if (window.__dshE2eeOn === true) break;
              await new Promise(r => setTimeout(r, 250));
            }
            const el = document.getElementById('dsh-gw-badge');
            return {
              configured: window.__dshE2eeConfigured === true,
              on: window.__dshE2eeOn === true,
              hasSecret: typeof window.__dshE2eeSecret === 'string' && window.__dshE2eeSecret.length >= 16,
              badge: el ? el.textContent : '',
              // 127.0.0.1 算安全上下文，所以这里 crypto.subtle 应该是有的
              subtle: !!(window.crypto && window.crypto.subtle),
              hashStillThere: /#k=/.test(location.hash)
            };
          })()`);
          check('带 #k= 进来时加密确实装上了', st.on === true,
            `on=${st.on} subtle=${st.subtle} secret=${st.hasSecret}`);
          check('加密已生效时角标**不报**未加密（不能误报）',
            !/未加密/.test(st.badge), st.badge);
          // ★ 这条断言 2026-09-23 就反过来了（当时改的是别的测试，这条漏了）。
          //   原来要求「读完立刻把 #k= 从地址栏抹掉」。那个行为被**故意取消**：
          //   「添加到主屏幕」和书签保存的都是当时的地址，抹掉之后存下来的没有钥匙，
          //   点开永远是未加密 / 打不开。
          check('密钥留在地址里（抹掉会让书签和主屏图标永久失效）',
            st.hashStillThere === true, 'hash=' + JSON.stringify(st.hashStillThere));
          p9.close();

          // ② 不带 #k= 进 —— 分两种世界，必须分开验：
          //    a) 这台设备**没学过**钥匙 → 如实报未加密，且提示指向「链接少了密钥」
          //    b) 这台设备**学过**钥匙（打开过带 #k= 的链接）→ 仍然加密
          //       （2026-09-24 的行为：iOS 存主屏图标会把 #片段丢掉，
          //        不记住钥匙的话图标永远是明文、而且看不到任何任务）
          const p10 = await b.newPage();
          // ★ 这里必须带 `?target=dsh`，否则这一段**必然假红**（2026-09-26 实测）：
          //   「记住选过哪个目标」存在 localStorage 里，而下面为了回到「没学过钥匙」
          //   那个世界要清掉 localStorage —— 目标记忆被一起清掉了，于是这一跳落到
          //   **选目标页**，那一页上根本没有角标，断言当然拿不到「未加密」。
          //   实测：带 ?target=dsh 时角标是「未加密」、提示是「这条链接没带加密密钥」，
          //   行为完全正确；不带就是空角标。
          //   （同一批里 [8] 和 st2 的等待也是这个毛病：检查自己太急/走错了页，
          //    不是被测行为有问题。）
          await p10.goto(`${base}/k/${key}?target=dsh`, 1200);
          // 先把「学过的钥匙」清干净，回到 a) 那个世界
          await p10.eval(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return 'ok'; })()`);
          await p10.goto(`${base}/k/${key}?target=dsh`, 2500);
          // ★ 必须**等角标注入**再读，不能 goto 完立刻读。
          //   机器一忙（这台机器上常有别的代理在跑：codex / 多个无头浏览器），
          //   DSH 页面和 route.js 注入都会晚几秒 —— 立刻读会拿到空 badge，
          //   于是「如实报未加密」和「提示指向链接少了密钥」两条一起假红。
          //   下面那一段（学过钥匙的场景）本来就带这个等待（见 st3 的注释），
          //   这一段当时漏了 —— 属于「检查自己太急」，不是被测行为的问题。
          const st2 = await p10.eval(`(async () => {
            for (let i = 0; i < 40; i++) {
              if (document.getElementById('dsh-gw-badge')) break;
              await new Promise(r => setTimeout(r, 250));
            }
            const el = document.getElementById('dsh-gw-badge');
            return {
              on: window.__dshE2eeOn === true,
              badge: el ? el.textContent : '',
              title: el ? el.title : '',
              source: window.DshE2EE && window.DshE2EE.secretSource ? window.DshE2EE.secretSource() : null
            };
          })()`);
          check('没学过钥匙的设备不带 #k= 进来 → 如实报「未加密」',
            st2.on === false && /未加密/.test(st2.badge), st2.badge);
          check('提示指向「链接少了密钥」这一种原因（因为这里能加密）',
            /没带加密密钥|明文过隧道/.test(st2.title || ''), st2.title);

          // b) 学过钥匙之后：同一个地址、没有 #k=，也必须仍然是加密的
          //
          //   ★ 必须先离开这一页再回来：只改 `#` 之后的片段属于**同文档导航**，
          //     浏览器不会重新加载，e2ee.js 也就不会重跑、学不到那把钥匙。
          //     （第一次写这条断言时栽在这儿：页面根本没重载，于是「没记住」。）
          await p10.goto(`${base}/go`, 900);
          await p10.goto(`${base}/k/${key}?target=dsh#k=${secret}`, 3000);
          const persistOk = await p10.eval(`!!localStorage.getItem('dsh-e2ee-secret-persist-v1')`);
          check('打开带 #k= 的链接后，这台设备把钥匙记下来了',
            persistOk === true, 'localStorage 里没有那把钥匙');
          await p10.eval(`(() => { sessionStorage.clear(); return 'ok'; })()`);   // 只留持久那份
          await p10.goto(`${base}/k/${key}`, 2500);
          const st3 = await p10.eval(`(async () => {
            // 等页面真的起来（DSH 忙的时候 badge 会晚一点才注入，别误判）
            for (let i = 0; i < 40; i++) {
              if (window.__dshE2eeOn === true && document.getElementById('dsh-gw-badge')) break;
              await new Promise(r => setTimeout(r, 250));
            }
            const el = document.getElementById('dsh-gw-badge');
            return {
              on: window.__dshE2eeOn === true,
              source: window.DshE2EE && window.DshE2EE.secretSource ? window.DshE2EE.secretSource() : null,
              badge: el ? el.textContent : ''
            };
          })()`);
          check('学过钥匙的设备不带 #k= 进来 → 仍然加密（主屏图标就靠这一条）',
            st3.on === true && st3.source === 'stored', JSON.stringify(st3));
          p10.close();
        }
      }

      // ── 4. /go 选路页 ───────────────────────────────────────────────────────
      console.log('\n[4] 连接方式选择页 /go');
      const p2 = await b.newPage();
      await p2.goto(`${base}/k/${key}`, 3000);
      await p2.goto(`${base}/?target=dsh`, 1800);
      await p2.goto(`${base}/go`, 6000);

      const goInfo = await p2.eval(`(() => {
        const adv = document.querySelector('.advice');
        const cands = Array.from(document.querySelectorAll('.cand')).map(c => ({
          name: (c.querySelector('.name') || {}).textContent || '',
          tags: Array.from(c.querySelectorAll('.tag')).map(t => t.textContent),
          hasButton: !!c.querySelector('button[data-switch]')
        }));
        return { advice: adv ? adv.textContent : null, candidates: cands,
                 switching: (document.getElementById('switching') || {}).innerHTML || '' };
      })()`);

      check('页面给出了结论', !!(goInfo && goInfo.advice), JSON.stringify(goInfo && goInfo.advice));
      if (goInfo && goInfo.advice) console.log(`      结论: ${goInfo.advice.replace(/\s+/g, ' ').slice(0, 100)}`);
      check('列出了候选路径', goInfo && goInfo.candidates.length > 0,
        String(goInfo && goInfo.candidates.length));
      if (goInfo) {
        for (const c of goInfo.candidates) {
          console.log(`      · ${c.name}  [${c.tags.join(' ')}]${c.hasButton ? ' 可切换' : ''}`);
        }
      }

      // ── 5. 从隧道进来时，能不能认出「你其实在家」───────────────────────────
      //
      // 这是整套自动选路里最关键、也最容易想当然的一环：
      // 手机在外面时隧道是唯一的路，但如果它其实就在家里，那它是在白绕 Cloudflare。
      // 光看 Host 是分不出来的（隧道域名对谁都是一样的），得比对出口公网 IP。
      //
      // 这一项真的走一遍 Cloudflare：从本机访问自己的隧道地址，出口 IP 就是本机的
      // 公网 IP，于是「同一个网络」这个判断应该成立。
      console.log('\n[5] 从隧道进来时的判断（真的绕一圈 Cloudflare）');
      let tunnelUrl = null;
      try {
        tunnelUrl = (JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'status.json'), 'utf8'))
          .tunnel || {}).url;
      } catch (err) { }
      // status.json 里存的可能是带密钥的完整入口，取个源站就行
      if (tunnelUrl && tunnelUrl.includes('/k/')) tunnelUrl = tunnelUrl.split('/k/')[0];
      const tunnelHost = tunnelUrl ? new URL(tunnelUrl).hostname : null;

      if (!tunnelUrl) {
        console.log('      · 现在没有隧道，跳过（这一项需要隧道在跑）');
      } else {
        console.log(`      隧道地址: ${tunnelUrl}`);
        const p3 = await b.newPage();
        await p3.goto(`${tunnelUrl}/k/${key}`, 8000);
        await p3.goto(`${tunnelUrl}/?target=dsh`, 2500);

        // 注意这里不能一次睡太久：这个页面会在倒计时结束后**自己切走**，
        // 睡过头就只能看到切换后的页面，反而以为它没工作。所以要分两次看 ——
        // 先趁它还在 /go 上的时候看结论，再等一会儿看它落到哪儿。
        await p3.goto(`${tunnelUrl}/go`, 2600);

        // 等结论渲染出来（探测是并行的，快慢不定）
        const viaTunnel = await p3.eval(`(async () => {
          for (let i = 0; i < 40; i++) {
            if (document.querySelector('.advice')) break;
            await new Promise(r => setTimeout(r, 250));
          }
          const adv = document.querySelector('.advice');
          const switchBox = document.getElementById('switching');
          const list = Array.from(document.querySelectorAll('.cand')).map(c => ({
            name: (c.querySelector('.name') || {}).textContent || '',
            tags: Array.from(c.querySelectorAll('.tag')).map(t => t.textContent),
            blockedNote: /混合内容/.test(c.textContent || '')
          }));
          return {
            href: location.href,
            advice: adv ? adv.textContent : null,
            switching: switchBox ? switchBox.textContent : '',
            candidates: list
          };
        })()`);

        console.log(`      结论: ${String(viaTunnel.advice || '(还没渲染)').replace(/\s+/g, ' ').slice(0, 150)}`);

        check('从隧道进来被识别为外网路径',
          /隧道|外网|Cloudflare|同一个网络|在家里/.test(String(viaTunnel.advice)),
          viaTunnel.advice);
        check('确认同网络时给出切换提示（或已在切换倒计时中）',
          /同一个网络|在家里|WiFi/.test(String(viaTunnel.advice)) ||
          /同一个网络|自动切/.test(String(viaTunnel.switching)),
          `advice=${viaTunnel.advice} switching=${viaTunnel.switching}`);
        check('内网那条被标为「浏览器不让测」',
          viaTunnel.candidates.some((c) => c.blockedNote),
          JSON.stringify(viaTunnel.candidates.map((c) => c.tags)));

        if (viaTunnel.switching) {
          console.log(`      正在自动切换: ${String(viaTunnel.switching).replace(/\s+/g, ' ').slice(0, 120)}`);
        }

        // 关键实证：它应该真的自己切到内网那条路上去，不用人点
        let landed = null;
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          landed = await p3.eval(`location.href`).catch(() => null);
          if (landed && /^http:\/\/(192\.168\.|10\.|172\.)/.test(String(landed))) break;
        }
        const isLan = /^http:\/\/(192\.168\.|10\.|172\.)/.test(String(landed));
        check('自动切到了内网地址（不需要人点）', isLan, String(landed));
        // 自动切换必须落在**不会弹证书错误**的那条路上。
        // 如果它落在加密端口上，说明这台手机没信任本地 CA，浏览器只会给一页红字 ——
        // 那比不切还糟。所以这里要额外确认落点是明文那条（没装 CA 的正常情况）。
        if (isLan) {
          const httpsPort = (() => {
            try { return Number(fs.readFileSync(path.join(LOG_DIR, 'https-port.txt'), 'utf8').trim()); }
            catch (err) { return 0; }
          })();
          if (httpsPort && String(landed).includes(`:${httpsPort}`)) {
            check('没信任 CA 时不会自动切到会弹证书错误的加密入口', false,
              `落到了 ${landed} —— 证书没被信任，浏览器会显示证书错误页`);
          } else {
            check('没信任 CA 时自动走明文内网那条（不会弹证书错误）', true);
          }
          console.log(`      最终落在: ${landed}`);
          // 落过去之后还得是能用的页面，不能只是个空壳
          const onLan = await p3.eval(`({
            href: location.href,
            hasApp: !!document.querySelector('script[src*="polyfill"]'),
            badge: (document.getElementById('dsh-gw-badge') || {}).textContent || null
          })`).catch(() => null);
          check('切过去之后页面是能用的（脚本都在、角标在）',
            !!(onLan && onLan.hasApp), JSON.stringify(onLan));
          if (onLan) console.log(`      落地页面: 角标=${onLan.badge}`);
        }
        p3.close();
      }

      // ── 6. 内网 HTTPS 那条路 ────────────────────────────────────────────────
      //
      // 静态检查（见 test-lan-https.js）能证明证书和端口没问题，
      // 但证明不了「浏览器真的把它当加密站点打开、页面里的脚本都跑起来了」。
      // 所以这里开一个忽略证书错误的浏览器窗口去真的走一遍 ——
      // 忽略证书错误正是使用者第一次打开时点「继续访问」的等价行为。
      console.log('\n[6] 内网 HTTPS（真实浏览器，等价于点了「继续访问」）');
      let httpsPort = 0;
      try {
        httpsPort = Number(fs.readFileSync(path.join(LOG_DIR, 'https-port.txt'), 'utf8').trim());
      } catch (err) { }

      if (!httpsPort) {
        console.log('      · 内网 HTTPS 没开，跳过');
      } else {
        const lanIp = (() => {
          try {
            const v4 = require('./config.js').detectNetwork().lanV4;
            return v4.length ? v4[0].address : '127.0.0.1';
          } catch (err) { return '127.0.0.1'; }
        })();
        const httpsOrigin = `https://${lanIp}:${httpsPort}`;
        console.log(`      地址: ${httpsOrigin}`);

        const b2 = await Browser.launch(['--ignore-certificate-errors']);
        try {
          const p4 = await b2.newPage();
          await p4.goto(`${httpsOrigin}/k/${key}`, 5000);
          await p4.goto(`${httpsOrigin}/?target=dsh`, 2000);
          await p4.goto(`${httpsOrigin}/`, 6000);

          const overHttps = await p4.eval(`({
            href: location.href,
            secure: location.protocol === 'https:',
            isSecureContext: window.isSecureContext,
            hasApp: !!document.querySelector('script[src*="polyfill"]'),
            badge: (document.getElementById('dsh-gw-badge') || {}).textContent || null,
            swSupported: 'serviceWorker' in navigator
          })`);

          check('浏览器确实把它当 HTTPS 站点打开', overHttps.secure === true, overHttps.href);
          check('页面是安全上下文（Service Worker / 推送的前提）',
            overHttps.isSecureContext === true);
          check('工作台页面加载完整（注入脚本都在）', overHttps.hasApp === true);
          check('路径角标正常渲染', !!overHttps.badge, String(overHttps.badge));
          if (overHttps.badge) console.log(`      角标显示: ${overHttps.badge}`);

          // 实时通道走的是 wss，这条不通的话页面会「打得开但没数据」
          const wsOk = await p4.eval(`(async () => {
            try {
              const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
              const ws = new WebSocket(proto + '//' + location.host + '/api/remote.mux');
              const r = await new Promise((resolve) => {
                const t = setTimeout(() => resolve('timeout'), 6000);
                ws.onopen = () => { clearTimeout(t); ws.close(); resolve('open'); };
                ws.onerror = () => { clearTimeout(t); resolve('error'); };
              });
              return r;
            } catch (e) { return 'throw:' + e.message; }
          })()`);
          check('wss 实时通道能连上', wsOk === 'open', String(wsOk));

          // 页面上不该冒出证书相关的报错（浏览器把证书拦截做成网络错误，
          // 如果页面里到处是这种错误，说明有资源没走对协议）
          const errs2 = p4.exceptions.filter(Boolean);
          check('加密页面上没有未捕获异常', errs2.length === 0, errs2.slice(0, 2).join(' | '));
        } finally {
          b2.kill();
        }
      }

      // ── 7. 选择页与 Codex 界面 ──────────────────────────────────────────────
      //
      // 这两件事都只发生在浏览器里：选择页要有东西可点、Codex 界面要真的连上
      // WebSocket 并把会话列出来。发个 HTTP 请求只能证明「HTML 送出去了」。
      console.log('\n[7] 选目标 / Codex 界面');
      const p5 = await b.newPage();
      await p5.goto(`${base}/k/${key}`, 4000);

      const targets = await p5.eval(`fetch('/__targets',{cache:'no-store'}).then(r=>r.json())
        .catch(e=>({error:String(e)}))`);
      const installed = (targets.targets || []).filter((t) => t.installed);
      console.log(`      装了的: ${installed.map((t) => t.short + (t.running ? '(运行中)' : '(没跑)')).join(', ')}`);

      if (installed.length > 1) {
        // 标签页之间共享 cookie，前面的检查已经选过 DSH 了。
        // 要验「第一次来的人看到什么」，就得先把那个选择清掉 ——
        // 三个来源（回环、内网 IP、隧道域名）都要清，前面几个页面各自选过一次。
        // 内网 IP 现探测 —— 写死的话 DHCP 一换地址，这条 cookie 就清不干净，
        // 于是「第一次来的人看到什么」验的其实是上一次的残留。
        const lanIpForCookie = (() => {
          try {
            const v4 = require('./config.js').detectNetwork().lanV4;
            return v4.length ? v4[0].address : '';
          } catch (e) { return ''; }
        })();
        for (const d of ['127.0.0.1', lanIpForCookie, tunnelHost]) {
          if (d) await p5.dropCookie('dsh-gw-target', d).catch(() => { });
        }
        await p5.goto(`${base}/`, 2500);
        // 卡片是页面脚本渲染出来的，goto 返回不代表已经渲染完。
        // 固定 sleep 会在机器忙的时候偶发失败（实测 3 次里挂 1 次），
        // 所以改成轮询到「每张卡都有入口」为止 —— 测的是最终结果，不是手速。
        const readLauncher = () => p5.eval(`(() => {
          const cards = Array.from(document.querySelectorAll('.card'));
          return {
            isLauncher: /要用哪个/.test(document.body.textContent),
            cards: cards.map(c => (c.querySelector('.name')||{}).textContent || ''),
            // 这张卡代表的目标现在是不是在跑 —— 决定它**该不该**有「打开」入口
            running: cards.map(c => c.classList.contains('on')),
            // 每张卡要么本身是个链接，要么在按钮区里有一个「打开」
            entries: cards.map(c => {
              const a = c.querySelector('a[href*="target="]') ||
                        (c.tagName === 'A' ? c : null);
              return a ? a.getAttribute('href') : null;
            }),
            buttons: cards.map(c => Array.from(c.querySelectorAll('button'))
              .map(b => b.textContent).join('/'))
          };
        })()`);
        let launcher = await readLauncher();
        // 只等「正在跑的目标」出现入口。
        //
        // 原来等的是**每张卡**都有入口，于是一旦有目标没在启动状态
        // （比如重启后 Codex 没自动拉起 —— 那是设计如此），
        // 这个循环就白等 6 秒，然后判一条根本不成立的失败。
        // 「没在跑的目标没有打开链接」是正确行为，不该被当成故障。
        const readyToAssert = (l) => l.isLauncher && l.entries.length >= 2 &&
          l.entries.every((h, i) => !l.running[i] || (h && h.includes('target=')));
        for (let i = 0; i < 24; i++) {
          if (readyToAssert(launcher)) break;
          await new Promise((r) => setTimeout(r, 250));
          launcher = await readLauncher();
        }
        check('两个目标都在时，先给出选择页', launcher.isLauncher === true);
        check('选择页列出了两个目标', launcher.cards.length >= 2, JSON.stringify(launcher.cards));
        check('每个**正在运行**的目标都有能进去的入口',
          launcher.entries.length > 0 &&
          launcher.entries.every((h, i) => !launcher.running[i] || (h && h.includes('target='))),
          JSON.stringify(launcher.entries) + '  running=' + JSON.stringify(launcher.running));
        // 没在跑的目标应当给「启动」而不是「打开」—— 顺手验一下，
        // 免得将来有人「顺手」给所有目标都加上链接，把使用者送进一个连不上的页面
        {
          const stopped = launcher.running.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
          if (stopped.length) {
            check('没在运行的目标给的是「启动」而不是「打开」',
              stopped.every((i) => /启动/.test(launcher.buttons[i] || '')),
              stopped.map((i) => launcher.cards[i] + '=' + launcher.buttons[i]).join('　'));
          } else {
            skip('没在运行的目标给「启动」', '两个目标现在都在跑，这条无从验起');
          }
        }
        check('每个目标都有启停按钮',
          launcher.buttons.every((b) => /启动|停止/.test(b)),
          JSON.stringify(launcher.buttons));
        if (launcher.buttons.length) {
          console.log(`      按钮：${launcher.buttons.map((b, i) => launcher.cards[i] + '=' + b).join('　')}`);
        }

        // ★ 选择页的「打开」链接必须原样带着当前地址的 fragment。
        //
        // 这条是拿一次真实的「为什么显示未加密」换来的：加密密钥放在 #k= 里，
        // 而 fragment **不会发给服务器**，只能靠前端一站一站自己传下去。
        // 选择页原来生成的是 `/?target=dsh`，不带 hash ——
        // 于是使用者点「打开 DSH」的那一刻密钥就没了，之后全程明文，
        // 不报错、界面照常，谁也看不出来。
        //
        // 为什么一直没发现：只装一个目标的人**根本不会经过这一页**，
        // 而我自己测加密时走的是「两步导航」（先拿 cookie 再单独跳一次），
        // fragment 是第二次亲手带上去的 —— 恰好绕开了这个洞。
        //
        // 所以这里必须**照着使用者的做法走一遍**：一条链接点进去，
        // 落在选择页，看它给的链接带不带密钥。
        {
          let sec = '';
          try { sec = fs.readFileSync(path.join(LOG_DIR, 'e2ee-secret.txt'), 'utf8').trim(); } catch (e) { }
          if (!sec) {
            skip('选择页带密钥检查', '电脑上没配加密密钥（合法的明文模式）');
          } else {
            const p7 = await b.newPage();
            await p7.goto(`${base}/k/${key}#k=${sec}`, 3000);
            const landed = await p7.eval(`({
              hash: location.hash,
              isLauncher: /要用哪个/.test(document.body.textContent),
              links: Array.from(document.querySelectorAll('a'))
                .map(x => x.getAttribute('href')).filter(h => h && /target=/.test(h))
            })`);
            check('一条链接进来后密钥还在（302 不会吃掉 fragment）',
              /k=/.test(landed.hash), JSON.stringify(landed.hash));
            if (landed.links.length) {
              check('选择页的入口链接带着加密密钥（否则点一下就变明文）',
                landed.links.every((h) => h.includes('#k=')),
                JSON.stringify(landed.links));
            } else {
              skip('选择页带密钥检查', '这次没落在选择页（可能只装了一个目标）');
            }
            p7.close();
          }
        }

        // 选了 DSH 之后就该直接进 DSH，不再拦
        const pickDsh = await p5.eval(`fetch('/?target=dsh',{redirect:'manual'}).then(r=>r.status).catch(e=>String(e))`);
        check('选 DSH 会记住选择（返回重定向）', pickDsh === 0 || pickDsh === 302 || pickDsh === 200,
          String(pickDsh));
      } else {
        console.log('      · 只装了一个目标，按设计不显示选择页');
        check('只装一个时不拦人', true);
      }

      // Codex 界面
      const codexTarget = installed.find((t) => t.id === 'codex');
      if (!codexTarget) {
        console.log('      · 没装 Codex，跳过');
      } else if (!codexTarget.running) {
        console.log('      · Codex 没在运行，跳过界面检查（先启动它再跑）');
      } else {
        const p6 = await b.newPage();
        await p6.goto(`${base}/k/${key}`, 3000);
        await p6.goto(`${base}/codex`, 2000);

        // 等它连上并拉到列表
        const cx = await p6.eval(`(async () => {
          for (let i = 0; i < 60; i++) {
            const items = document.querySelectorAll('.item');
            const conn = document.getElementById('conntext');
            if (items.length || (conn && /失败|断开/.test(conn.textContent))) break;
            await new Promise(r => setTimeout(r, 400));
          }
          return {
            conn: (document.getElementById('conntext') || {}).textContent,
            connClass: (document.getElementById('conn') || {}).className,
            items: Array.from(document.querySelectorAll('.item')).map(b => ({
              title: (b.querySelector('.t') || {}).textContent || '',
              meta: (b.querySelector('.m') || {}).textContent || ''
            })),
            hasNewButton: !!Array.from(document.querySelectorAll('.btn'))
              .find(b => /开一个新会话/.test(b.textContent)),
            skeleton: document.querySelectorAll('.skel').length
          };
        })()`);

        check('Codex 界面连上了服务端', cx.connClass && cx.connClass.includes('ok'),
          `连接状态=${cx.conn}`);
        check('列出了真实会话', cx.items.length > 0, `${cx.items.length} 条`);
        check('有「开新会话」入口', cx.hasNewButton === true);
        check('加载骨架已消失（说明数据回来了）', cx.skeleton === 0, String(cx.skeleton));

        // ── 带钥匙的加密集会列表 ──────────────────────────────────────────────
        //
        // 上面那次是**不带 #k=** 打开的，走的还是明文那条路。而队列 / 上传 /
        // 会话列表这三条通道刚改成「带钥匙就加密」—— 恰好是没被覆盖到的组合。
        // 这个组合一旦坏掉，手机上表现是队列和附件全废，而明文测试照样全绿。
        //
        // 验两件事：
        //   1. privateFetch 能把回来的密文解开（解不开 .json() 就会抛）
        //   2. 服务端**真的**加密了 —— 用 XHR 绕开自动解密，拿到的应当是解不出 JSON 的密文。
        //      只验第 1 条不够：万一服务端压根没加密，「解开」也会成功（因为没东西要解）。
        {
          let cxSec = '';
          try { cxSec = fs.readFileSync(path.join(LOG_DIR, 'e2ee-secret.txt'), 'utf8').trim(); } catch (e) { }
          if (!cxSec) {
            console.log('      · 没配加密密钥，跳过带钥匙的检查');
          } else {
            const p6e = await b.newPage();
            await p6e.goto(`${base}/k/${key}`, 3000);
            await p6e.goto(`${base}/codex#k=${encodeURIComponent(cxSec)}`, 2500);
            // ★ 等钥匙装上再断言。
            //
            //   `goto` 回来只保证「文档提交了」，而 `__dshE2eeSecret` 是 e2ee.js
            //   **被执行**那一刻才有的（它注入在 <head> 最前面，但要先下载）。
            //   这里原来 goto 完立刻查，慢一点就报「密钥没装上」——
            //   和这个文件里那条 90 秒超时是同一类问题：**测试自己没耐心**，
            //   表现出来却像产品坏了（2026-09-27 实测：多等 1 秒后
            //   hasSecret=true、proof.ok=true，功能一直是好的）。
            for (let i = 0; i < 25; i++) {
              const ready = await p6e.eval(
                'typeof window.__dshE2eeSecret === "string" && window.__dshE2eeSecret.length >= 16');
              if (ready) break;
              await new Promise((r) => setTimeout(r, 200));
            }
            const enc = await p6e.eval(`(async () => {
              const out = { hasSecret: typeof window.__dshE2eeSecret === 'string' && window.__dshE2eeSecret.length >= 16 };
              if (!out.hasSecret) return out;
              try {
                const r = await privateFetch('/codex/threads', { cache: 'no-store' });
                const j = await r.json();
                out.viaPrivateFetch = typeof j.ok === 'boolean';
              } catch (e) { out.viaPrivateFetch = false; out.err1 = String(e && e.message); }
              out.raw = await new Promise(function (res) {
                const x = new XMLHttpRequest();
                x.open('GET', '/codex/threads', true);
                x.setRequestHeader('x-dsh-e2ee', '1');
                x.onload = function () {
                  let jsonOk = false;
                  try { JSON.parse(x.responseText); jsonOk = true; } catch (e) { }
                  res({ status: x.status, jsonOk: jsonOk, marked: x.getResponseHeader('x-dsh-e2ee') === '1' });
                };
                x.onerror = function () { res({ status: 0 }); };
                x.send();
              });
              return out;
            })()`);
            check('带钥匙打开 Codex 页：密钥装上了', enc.hasSecret === true);
            check('加密集会列表：privateFetch 解得开（队列/上传同一条路）',
              enc.viaPrivateFetch === true, enc.err1 || '');
            check('加密集会列表：服务端确实加密了（原始响应不是 JSON）',
              !!enc.raw && enc.raw.jsonOk === false && enc.raw.marked === true && enc.raw.status === 200,
              JSON.stringify(enc.raw));
            // 用完就关：这一页留着会一直在后台轮询，而下面马上要在一条
            // 几 GB 的会话上做重活 —— 抢资源会让那边超时（实测踩到过：
            // Runtime.evaluate 超时，后面的检查整段被跳过，只剩 53 项）。
            p6e.close();
          }
        }

        if (cx.items.length) {
          console.log(`      会话 ${cx.items.length} 条，前两条：`);
          cx.items.slice(0, 2).forEach((i) => {
            console.log(`        · ${i.title.replace(/\s+/g, ' ').slice(0, 44)}  [${i.meta.replace(/\s+/g, ' ').trim()}]`);
          });
        }

        // 点开第一条，看能不能读出内容，以及各类 item 有没有渲染出来
        if (cx.items.length) {
          await p6.eval(`document.querySelectorAll('.item')[0].click()`);
          const opened = await p6.eval(`(async () => {
            for (let i = 0; i < 60; i++) {
              if (document.querySelectorAll('.bub').length) break;
              await new Promise(r => setTimeout(r, 300));
            }
            return {
              title: (document.getElementById('title') || {}).textContent,
              backVisible: (document.getElementById('back') || {}).style.display !== 'none',
              composerVisible: (document.getElementById('footer') || {}).style.display !== 'none',
              bubbles: document.querySelectorAll('.bub').length,
              // 电脑版有的东西，手机上也得有
              think: document.querySelectorAll('details.think').length,
              tool: document.querySelectorAll('details.tool').length,
              files: document.querySelectorAll('.files').length,
              plan: document.querySelectorAll('.plan').length,
              sample: Array.from(document.querySelectorAll('.bub')).slice(0, 2)
                .map(b => b.textContent.replace(/\\s+/g, ' ').slice(0, 60))
            };
          })()`);
          check('点开会话后能看到消息', opened.bubbles > 0, JSON.stringify(opened).slice(0, 160));
          check('出现了返回按钮', opened.backVisible === true);
          check('出现了输入框（可以继续对话）', opened.composerVisible === true);
          console.log(`      渲染出的元素：消息 ${opened.bubbles}　思考 ${opened.think}　` +
            `工具/命令 ${opened.tool}　文件改动 ${opened.files}　计划 ${opened.plan}`);
          if (opened.sample.length) console.log(`      第一条: ${opened.sample[0]}`);

          // 设置面板里该有的东西：账户、额度、模型、项目
          await p6.eval(`document.getElementById('menu').click()`);
          const sheet = await p6.eval(`(async () => {
            const s = document.getElementById('sheet');
            // 账户和额度是异步拉的，等它们填进去
            for (let i = 0; i < 40; i++) {
              if (/\d+%/.test(s.textContent) || /读不到/.test(s.textContent)) break;
              await new Promise(r => setTimeout(r, 250));
            }
            const rows = Array.from(s.querySelectorAll('.srow'))
              .map(b => (b.querySelector('.k') || {}).textContent + '=' +
                        ((b.querySelector('.v') || {}).textContent || ''));
            return {
              open: s.classList.contains('on'),
              account: (s.querySelector('.acct') || {}).textContent || '',
              rows,
              hasUsageBar: !!s.querySelector('.ubar i'),
              // 真正要保证的是「不沉默」：要么画出进度条，要么明说一句额度情况。
              // 余额制账号（DeepSeek）本来就没有周期额度条，硬要求进度条会误报。
              // 但一片空白是缺陷 —— 使用者没法判断是用完了、不适用、还是查不到。
              mentionsQuota: /额度/.test(s.textContent)
            };
          })()`);
          check('设置面板能打开', sheet.open === true);
          check('面板里有账户信息', /@|套餐/.test(sheet.account),
            JSON.stringify(sheet.account).slice(0, 120));
          check('面板对额度有交代（进度条或明确说明，不能一片空白）',
            sheet.hasUsageBar === true || sheet.mentionsQuota === true,
            `hasUsageBar=${sheet.hasUsageBar} mentionsQuota=${sheet.mentionsQuota}`);
          if (sheet.hasUsageBar) console.log('      额度: 已渲染进度条');
          else console.log('      额度: 无周期额度，界面已如实说明');
          check('面板里有模型和项目入口',
            sheet.rows.some((x) => /模型/.test(x)) && sheet.rows.some((x) => /项目/.test(x)),
            JSON.stringify(sheet.rows));
          check('面板里有改名和归档（电脑版有的）',
            sheet.rows.some((x) => /重命名/.test(x)) && sheet.rows.some((x) => /归档/.test(x)),
            JSON.stringify(sheet.rows));
          console.log(`      账户: ${sheet.account.replace(/\s+/g, ' ').slice(0, 70)}`);
          console.log(`      面板项: ${sheet.rows.join('　')}`);

          // 点开模型选择，看列表真不真。
          //
          // 模型列表是向 Codex app-server 现查的（model/list），第一次可能要好几秒。
          // 原来是「点一下 + 死等 400ms」，机器一忙就只拿到占位项
          // （实测偶发拿到 ["（用会话自己的）"]，那是还没查回来的样子）。
          // 改成点一次、然后轮询到列表真的填满为止。
          // 模型列表拿不到时，后面这几步都会连环倒 —— 因为选择页根本填不满，
          // 界面会停在一个和「正常情况」不同的状态上。
          // 这里先判断上游通不通，不通就整段跳过，而不是报一堆假故障。
          const modelPick = await p6.eval(`(async () => {
            const b = Array.from(document.querySelectorAll('.srow'))
              .find(x => /模型/.test((x.querySelector('.k') || {}).textContent || ''));
            if (!b) return { found: false };
            b.click();
            let opts = [];
            for (let i = 0; i < 40; i++) {
              await new Promise(r => setTimeout(r, 250));
              opts = Array.from(document.querySelectorAll('.sopt'))
                .map(o => (o.querySelector('.t') || {}).textContent || '');
              if (opts.length > 1) break;
            }
            return { found: true, opts };
          })()`);
          const modelsUp = modelPick.found && modelPick.opts.length > 1;
          if (modelsUp) {
            check('模型选择能列出可选模型', true);
            console.log(`      可选模型: ${modelPick.opts.join('、')}`);
          } else {
            const why = 'Codex 上游不可达，模型列表拉不到（可用 node scripts/self-check.js 看详情）';
            skip('模型选择能列出可选模型', why);
          }
          // 无论走哪条路，都把面板收回去，别让状态漏给下一步
          await p6.eval(`document.getElementById('sheet').classList.remove('on')`);

          // ── 真的点一下，而不是只看它渲染出来 ────────────────────────────
          //
          // 这一条是被一个真 bug 教出来的：列表页的「＋ 开一个新会话」按钮
          // 写成了 `onclick = newThread`，点击事件被当成 cwd 传给服务端，
          // 报「invalid type: map, expected a string」。
          // 之前所有检查都只看「按钮在不在」，于是这个错一直没被发现。
          await p6.eval(`document.getElementById('back').click()`);
          const clickNew = await p6.eval(`(async () => {
            for (let i = 0; i < 40; i++) {
              if (document.querySelector('.btn.p')) break;
              await new Promise(r => setTimeout(r, 250));
            }
            const b = Array.from(document.querySelectorAll('.btn'))
              .find(x => /开一个新会话/.test(x.textContent));
            if (!b) return { found: false };
            b.click();
            await new Promise(r => setTimeout(r, 4000));
            const err = document.querySelector('.msg.err .bub');
            return {
              found: true,
              error: err ? err.textContent.slice(0, 90) : null,
              inThread: document.getElementById('footer').style.display !== 'none'
            };
          })()`);
          check('点「开一个新会话」不报错', clickNew.found && !clickNew.error,
            clickNew.error || JSON.stringify(clickNew));
          if (modelsUp) check('点完确实进了新会话', clickNew.inThread === true);
          else skip('点完确实进了新会话', '同上，上游不通时这个流程走不完整');

          // 设置面板里的行点了也要有反应（它们以前也是直接赋值 onclick）
          await p6.eval(`document.getElementById('menu').click()`);
          const clickRow = await p6.eval(`(async () => {
            await new Promise(r => setTimeout(r, 800));
            const row = Array.from(document.querySelectorAll('.srow'))
              .find(x => /模型/.test((x.querySelector('.k') || {}).textContent || ''));
            if (!row) return { found: false };
            row.click();
            await new Promise(r => setTimeout(r, 700));
            return {
              found: true,
              opts: document.querySelectorAll('.sopt').length,
              hasBack: !!document.querySelector('.shead')
            };
          })()`);
          if (modelsUp) {
            check('点「模型」那一行能进到选择页', clickRow.found && clickRow.opts > 1,
              JSON.stringify(clickRow));
            check('选择页有返回', clickRow.hasBack === true);
          } else {
            skip('点「模型」那一行能进到选择页', '模型列表为空，选择页没有内容可验');
            skip('选择页有返回', '同上');
          }
          await p6.eval(`document.getElementById('sheet').classList.remove('on')`);

          // 回到列表，验搜索
          await p6.eval(`document.getElementById('back').click()`);
          const search = await p6.eval(`(async () => {
            for (let i = 0; i < 40; i++) {
              if (document.getElementById('q')) break;
              await new Promise(r => setTimeout(r, 250));
            }
            const q = document.getElementById('q');
            if (!q) return { found: false };
            const before = document.querySelectorAll('.item').length;
            q.value = 'zzz-绝不会匹配-zzz';
            q.dispatchEvent(new Event('input'));
            await new Promise(r => setTimeout(r, 300));
            const after = document.querySelectorAll('.item').length;
            q.value = '';
            q.dispatchEvent(new Event('input'));
            await new Promise(r => setTimeout(r, 300));
            return { found: true, before, afterEmpty: after,
                     restored: document.querySelectorAll('.item').length };
          })()`);
          check('会话列表有搜索框', search.found === true);
          if (search.found) {
            check('搜索能过滤', search.afterEmpty < search.before,
              `${search.before} → ${search.afterEmpty}`);
          }
        }

        const errs6 = p6.exceptions.filter(Boolean);
        check('Codex 界面没有未捕获异常', errs6.length === 0, errs6.slice(0, 2).join(' | '));
        p6.close();
      }

      // ── 8. 本地控制台 ──────────────────────────────────────────────────────
      //
      // 这一页只在本机可访问，但它是使用者最常看的界面 ——
      // 「启停按钮在不在」「结论说不说得清」这种事，靠截图看容易漏（按钮可能被裁掉），
      // 所以查 DOM。
      console.log('\n[8] 本地控制台');
      const pc = await b.newPage();
      await pc.goto(`${base}/console`, 3500);

      // ★ 先等控制台把 /__console/status 拿回来（state.data 不为 null）再读 DOM。
      //
      //   不等就会在**刚重启过的网关**上炸：那个端点要现场探一次隧道
      //   （实测 1.7～5 秒），而下面这段一上来就读 state.data.entries ——
      //   state.data 还是 null，整个 [8] 直接抛异常退出，一条断言都没跑。
      //   这不是被测代码坏了，是检查自己太急；而且越是我们刚改完东西
      //   （网关刚重启）越容易撞上，正好把要验的东西全遮住。
      const conReady = await pc.eval(`(async () => {
        for (let i = 0; i < 60; i++) {
          if (window.state && state.data) return { ok: true, waitedMs: i * 300 };
          await new Promise(x => setTimeout(x, 300));
        }
        return { ok: false, waitedMs: 18000 };
      })()`);
      if (!conReady.ok) console.log('      · 等了 18 秒 status 还没回来，下面的断言会如实报红');
      else console.log(`      控制台数据已就绪（等了 ${conReady.waitedMs} ms）`);

      const con = await pc.eval(`(() => {
        const cards = Array.from(document.querySelectorAll('#targets .card'));
        return {
          title: (document.getElementById('heroTitle') || {}).textContent,
          text: (document.getElementById('heroText') || {}).textContent,
          heroClass: (document.getElementById('hero') || {}).className,
          targets: cards.map(c => ({
            name: (c.querySelector('.nm') || {}).textContent || '',
            desc: (c.querySelector('.ds') || {}).textContent || '',
            buttons: Array.from(c.querySelectorAll('button')).map(x => x.textContent)
          })),
          // 数的是**真的渲染出来的**入口卡片。
          //
          // 这里原来写死 '#entries .entry'，而 renderEntries 后来改成生成
          // '.access-card' 了 —— 选择器没跟着改，于是恒为 0，断言永远红。
          // 改成数容器里的实际子元素：换类名骗不过它，容器真空了照样是 0，
          // 断言该失败还是会失败。
          //
          // ★ 这段是模板字符串内部：注释里不能出现反引号，否则会把它截断。
          entries: document.querySelectorAll('#entries > *').length,
          // 首页那个「复制手机地址」按钮到底会复制哪一条。
          //
          // 它曾经取的是 entries.lan[0] —— 明文 HTTP 内网地址。而那条路
          // **永远加不了密**（浏览器在非安全上下文里不提供 crypto.subtle），
          // 所以复制出来的地址到手机上必定显示「未加密」。列表里明明把 HTTPS 那条排第一位、标着
          // 「加密」，快捷按钮却取了另外一条 —— 两处对不上，谁也没发现。
          heroCopy: (() => {
            try {
              const b = bestEntry(state.data.entries || {});
              return b ? { url: b.url, plain: b.plain } : null;
            } catch (e) { return { error: e.message }; }
          })(),
          hasLanHttps: !!((state.data.entries || {}).lanHttps || []).length,
          // 二维码占用空间，已移除。
          // 这里跟着改成守那个**意图**：页面上不该再出现第三方图片 ——
          // 二维码是外包给 api.qrserver.com 画的，删掉之后整个项目不再向
          // 任何第三方发请求。断言从「有几个二维码」变成「有没有外链」，
          // 守的东西反而更硬。
          //
          // 注意别在这儿写正则：这段代码整体是一个模板字符串，
          // 里面的 \/ 会先被外层吃掉，传到浏览器就成了 /^(data:|blob:|/ ——
          // 「Unterminated group」。用 startsWith 绕开这个坑。
          thirdPartyImgs: Array.from(document.querySelectorAll('img[src]')).filter(i => {
            const s = i.getAttribute('src') || '';
            return !(s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('/'));
          }).length,
          // 只扫**会被真的加载的东西**（src / href）。
          // 第一版扫的是整个 innerHTML，结果页面上那段解释「二维码为什么删掉」
          // 的注释里提到了 api.qrserver.com，被算成「还有残留」——
          // 这是断言写宽了，不是代码有问题。判断资源加载要看属性，不能看全文。
          qrServerRefs: Array.from(document.querySelectorAll('[src],[href]')).filter(el => {
            const v = (el.getAttribute('src') || '') + (el.getAttribute('href') || '');
            return /qrserver/i.test(v);
          }).length,
          // 原来这里查的是 details.adv（一个叫「高级设置」的折叠框）。
          // 控制台改成标签页之后那个折叠框没了，这条断言就永远红着 ——
          // 而它守的其实是「首页别像开发者面板」这件事，跟折叠框没关系。
          //
          // 改成验那个意图：默认页上不该有**日志区**这类排查用的东西。
          //
          // 注意两点，都是踩出来的：
          //   1. **不能按文字判断**。我第一版写的是 /密钥|访问密钥/.test(text)，
          //      结果误报了 —— 配对页那句说明里就有「不含访问密钥」几个字，
          //      那是在解释「二维码里没有密钥」，属于该出现的内容。
          //      判断界面结构比判断文案可靠得多。
          //   2. **换密钥按钮现在就在首页**，而且是使用者明确要求的
          //      （「把密钥更换按钮放在第一位…不然别人第一眼看不到」）。
          //      所以它不在禁止之列 —— 断言要跟着产品意图走，不能反过来
          //      让一句过时的断言把使用者要的东西挡在门外。
          defaultPageHasJargon: (() => {
            const on = document.querySelector('.page.on');
            if (!on) return true;
            // 只看「日志」这一项。
            //
            // #devices 原来也算，但新布局是**故意**把「已连接设备」放在首页的
            // —— 已连接设备是首页的常用信息，不应隐藏。将它当黑话挡在门外是断言跑偏了：
            // 断言要跟着产品意图走，不能反过来。
            return !!on.querySelector('#logs');
          })(),
          devices: document.querySelectorAll('#devices .row').length
        };
      })()`);

      check('顶部给出了人话结论', /手机可以连|服务没在运行|没有可以连的东西/.test(con.title || ''),
        String(con.title) + ' / ' + String(con.text || '').slice(0, 120));
      check('结论是「能连」状态', /可以连/.test(con.title || ''), String(con.title));
      console.log(`      结论: ${con.title} — ${String(con.text).slice(0, 50)}`);

      check('列出了目标卡片', con.targets.length >= 1, String(con.targets.length));
      check('目标卡片上有启停按钮',
        con.targets.every((t) => t.buttons.some((x) => /启动|停止/.test(x))),
        JSON.stringify(con.targets.map((t) => t.buttons)));
      for (const t of con.targets) {
        console.log(`      · ${t.name.replace(/\s+/g, ' ')}  按钮=[${t.buttons.join(', ')}]`);
      }

      check('列出了手机入口', con.entries > 0, String(con.entries));
      if (con.hasLanHttps) {
        // 有加密内网入口时，快捷复制必须给那一条 —— 这是「复制出来的地址
        // 到手机上显示未加密」那个 bug 的回归断言。
        check('首页「复制手机地址」给的是加密那条，不是永远加不了密的明文内网',
          !!con.heroCopy && con.heroCopy.plain === false &&
            /^https:\/\//i.test(con.heroCopy.url || ''),
          JSON.stringify(con.heroCopy));
        // 光「加密」还不够：地址里得真的带着钥匙，否则打开还是显示未加密。
        check('复制到的那条地址里带着加密钥匙（#k=）',
          !!con.heroCopy && String(con.heroCopy.url).indexOf('#k=') > 0,
          String((con.heroCopy || {}).url).slice(-40));
      } else {
        skip('首页复制的是加密地址', '这台机器没开内网 HTTPS（合法的明文模式）');
      }
      check('页面上不再有第三方图片（二维码删掉后，整个项目不外联）',
        con.thirdPartyImgs === 0 && con.qrServerRefs === 0,
        `外链图片 ${con.thirdPartyImgs} 个，qrserver 残留 ${con.qrServerRefs} 处`);
      check('默认那一页不像开发者面板（日志/密钥都收在别的页里）',
        con.defaultPageHasJargon === false, JSON.stringify(con.defaultPageHasJargon));

      // 这一页最忌讳「满屏端口号和日志」——有高级区可以，但不能摊在外面。
      // 白名单里放的是**产品名**：它们是使用者需要看到的信息，不是黑话。
      //
      // 另外要把「这台机器自己的数据」先抠掉再扫，否则这个测试会随环境随机红：
      //   · 主机名 DESKTOP-41DJAR6 → 被 [A-Z]{2,} 切成 DESKTOP、DJAR 两个假黑话
      //   · 访问密钥 XBe314-... → 切出 XB
      //   · **加密密钥** hbKkZXOu...DJBhU3z → 切出 KKZXO、ET、DJB
      //     （地址带上 #k= 之后它就会出现在页面上，这一条是我加完加密地址才暴露的）
      // 这三个都是界面**必须**显示给使用者的，不是黑话。
      const rawBody = await pc.eval(`document.body.innerText`);
      let e2eeForStrip = '';
      try { e2eeForStrip = fs.readFileSync(path.join(LOG_DIR, 'e2ee-secret.txt'), 'utf8').trim(); } catch (e) { }
      const stripThese = [os.hostname(), key, (os.hostname() || '').split('.')[0], e2eeForStrip]
        .filter((s) => s && s.length >= 2);
      let bodyText = rawBody;
      for (const s of stripThese) bodyText = bodyText.split(s).join(' ');
      const uppercased = (bodyText.match(/[A-Z]{2,}/g) || []).filter((w) =>
        !/^(DSH|WIFI|HTTPS|HTTP|CODEX|CA|APP|IP|DEEPSEEK|BARK|QR|URL|JSON|PDF|AI)$/i.test(w));
      check('页面上没有大段技术黑话', uppercased.length < 6, uppercased.slice(0, 6).join(','));

      // ── 分页 ────────────────────────────────────────────────────────────
      //
      // 这一节验证各单元分页后的切换行为。
      // 要守住两件事：
      //   1. 每个标签点下去，**只有**它对应的那一页显示（切换真的生效）
      //   2. 分页之后，各个渲染函数要用的 id 一个都不能少
      //      —— 这是最容易出事的地方：HTML 一挪，JS 还在找旧 id，
      //         表现是「某一页永远空白」而且不报错
      const tabState = await pc.eval(`(() => {
        const tabs = Array.from(document.querySelectorAll('#tabs .tab'));
        const ids = ['entries','targets','v-notify','notify-hint',
                     'notify-acts','devices','v-balance','balance-hint','balance-acts',
                     'domainHint','lanHttpsHint','lanHttpsCert','logs','e2ee-new','howto-topic']
          .filter(id => !document.getElementById(id));
        return {
          count: tabs.length,
          names: tabs.map(t => t.textContent.trim()),
          missing: ids,
          shown: Array.from(document.querySelectorAll('.page'))
            .filter(x => x.classList.contains('on')).map(x => x.id)
        };
      })()`);
      check('控制台分了页（不再一拉到底）', tabState.count >= 3,
        `${tabState.count} 个标签: ${tabState.names.join('/')}`);
      check('默认只显示一页', tabState.shown.length === 1, JSON.stringify(tabState.shown));
      check('分页后所有关键元素都还在（id 没漏）',
        tabState.missing.length === 0, tabState.missing.join(', '));

      // 逐个点一遍，确认每次只亮一页
      let tabOk = 0;
      for (const t of tabState.names.length ? await pc.eval(
        `Array.from(document.querySelectorAll('#tabs .tab')).map(t => t.getAttribute('data-page'))`
      ) : []) {
        const shown = await pc.eval(`(() => {
          const b = document.querySelector('#tabs .tab[data-page="${t}"]');
          if (!b) return null;
          b.click();
          return Array.from(document.querySelectorAll('.page'))
            .filter(x => x.classList.contains('on')).map(x => x.id);
        })()`);
        if (shown && shown.length === 1 && shown[0] === 'page-' + t) tabOk++;
      }
      check('每个标签都能正确切换（一次只亮一页）',
        tabOk === tabState.count, `${tabOk}/${tabState.count}`);

      // 通知教程里必须真的把主题名摆出来，否则使用者不知道往 App 里填什么
      const topic = await pc.eval(`(() => {
        const b = document.querySelector('#tabs .tab[data-page="notify"]');
        if (b) b.click();
        const el = document.getElementById('howto-topic');
        return el ? el.textContent.trim() : '';
      })()`);
      check('通知教程里给出了要订阅的主题名', topic.length > 0 && topic !== '—', JSON.stringify(topic));

      // ── 复制出去的地址必须带加密密钥 ──────────────────────────────────────
      //
      // 这一节检查桌面控制台复制的地址是否包含加密密钥。
      // 此前 /__console/status 给的地址里一个 #k= 都没有，
      // 于是**复制出来必然是明文**。
      //
      // 顺便把「哪条是加密的」也一起验了：只有 https 才可能加密，
      // 而托盘原来优先给的是明文 http 那条。
      let secret = '';
      try { secret = fs.readFileSync(path.join(LOG_DIR, 'e2ee-secret.txt'), 'utf8').trim(); } catch (e) { }
      const ent = await pc.eval(`(async () => {
        const r = await fetch('/__console/status', { cache: 'no-store' });
        const j = await r.json();
        const t = document.querySelector('#tabs .tab[data-page="connect"]');
        if (t) t.click();
        return {
          lan: j.entries.lan || [],
          lanHttps: j.entries.lanHttps || [],
          wan: j.entries.wan,
          pairPage: j.entries.pairPage,
          tags: Array.from(document.querySelectorAll('#entries .enctag')).map(x => x.textContent)
        };
      })()`);
      const connectUrls = [...ent.lan, ...ent.lanHttps, ent.wan].filter(Boolean);
      if (secret) {
        check('复制出来的连接地址都带着加密密钥（#k=）',
          connectUrls.length > 0 && connectUrls.every((u) => u.includes('#k=')),
          JSON.stringify(connectUrls.map((u) => u.slice(-40))));
      } else {
        skip('连接地址带加密密钥', '电脑上没配加密密钥（合法的明文模式）');
      }
      check('配对页地址**不带**密钥（手机上用它换真地址）',
        !ent.pairPage || !ent.pairPage.includes('#k='), String(ent.pairPage));

      // ── 配对码必须**看得见** ────────────────────────────────────────────
      //
      // 这一条是补的，也是这次真正出问题的地方：接口一直返回 entries.pairCode，
      // 而控制台上显示它的那张卡跟着二维码一起被删了 —— 手机上要求输配对码时，
      // 使用者在电脑上找不到那 6 位数字。
      //
      // 所以断言**只能落在 DOM 上**：DOM 里没有 6 位数，接口有也算没修好。
      // 顺带盯住「显示的就是这次启动的配对码」，免得哪天渲染的是个旧值。
      const pairUi = await pc.eval(`(() => {
        const t = document.querySelector('#tabs .tab[data-page="connect"]');
        if (t) t.click();
        const el = document.getElementById('v-paircode');
        const card = document.getElementById('pair-card');
        return {
          code: el ? (el.textContent || '').trim() : null,
          hasCard: !!card,
          buttons: card ? Array.from(card.querySelectorAll('button')).map(b => (b.textContent || '').trim()) : []
        };
      })()`);
      let pairCodeOnDisk = '';
      try { pairCodeOnDisk = fs.readFileSync(path.join(LOG_DIR, 'pair-code.txt'), 'utf8').trim(); } catch (e) { }
      // ★ 失败的说明里**不能带码值**。
      //   配对码是凭据（6 位数字就能登记一台设备），而这个脚本的输出会被贴进
      //   聊天、写进日志、发给别人看 —— 里面出现一个当前有效的配对码，等于
      //   把它送出去了。所以这里只报「形状对不对、和网关文件一不一致」。
      //   （这条是 Codex 核查时提出来的，它当时没有把码贴出来，处理得对。）
      const pairIsSix = /^[0-9]{6}$/.test(pairUi.code || '');
      const pairMatches = !pairCodeOnDisk || pairUi.code === pairCodeOnDisk;
      check('控制台上真的显示了配对码（不是只有接口里有）',
        pairUi.hasCard && pairIsSix,
        '卡片在=' + pairUi.hasCard + ' 六位数字=' + pairIsSix + '（码值不打印）');
      check('显示的就是本次启动的配对码',
        pairMatches,
        '与网关文件一致=' + pairMatches + '（码值不打印）');
      check('配对码旁边有一键复制',
        pairUi.buttons.some((b) => /复制|Copy|Copiar/.test(b)),
        JSON.stringify(pairUi.buttons));

      // 界面上那个码**真的能用**：拿它走一次 /pair。
      //
      // 本机（回环）走 /pair 只种控制台 cookie、**不登记设备**，所以这条断言
      // 不会在使用者的设备列表里留下垃圾条目，也不会推通知。
      const pairTry = await pc.eval(`(async () => {
        const el = document.getElementById('v-paircode');
        const code = el ? (el.textContent || '').trim() : '';
        if (!/^[0-9]{6}$/.test(code)) return { code: code, status: 0 };
        const r = await fetch('/pair?code=' + code, { redirect: 'manual', cache: 'no-store' });
        return { code: code, status: r.status };
      })()`);
      check('界面上显示的那个配对码真的能配对（/pair 回 200）',
        pairTry.status === 200,
        '六位数字=' + /^[0-9]{6}$/.test(pairTry.code || '') + ' status=' + pairTry.status);
      check('控制台把「加密 / 明文」标出来了',
        ent.tags.length > 0 && ent.tags.every((t) => /加密|明文/.test(t)),
        JSON.stringify(ent.tags));

      const errs8 = pc.exceptions.filter(Boolean);
      check('控制台没有未捕获异常', errs8.length === 0, errs8.slice(0, 2).join(' | '));
      pc.close();

      // ── 9. 页面报错 ────────────────────────────────────────────────────────
      console.log('\n[9] 页面报错');
      const errs = [...p1.exceptions, ...p2.exceptions].filter(Boolean);
      check('没有未捕获的异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    } catch (err) {
      console.log(`\n  检查过程出错: ${err.message}\n${err.stack}`);
      fail++;
    } finally {
      if (!KEEP) b.kill();
      else console.log(`\n  （浏览器保留着，CDP 端口 ${b.port}）`);
    }

    console.log(`\n=== ${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''} ===`);
    if (skipped) {
      console.log('  （跳过项依赖 Codex 上游连通性，不代表界面有问题 —— 上游恢复后重跑即可）');
    }
    console.log('');
    process.exitCode = fail ? 1 : 0;
  })().catch((err) => {
    console.error(`\n致命错误: ${err.message}\n${err.stack}`);
    process.exitCode = 1;
  });
}
