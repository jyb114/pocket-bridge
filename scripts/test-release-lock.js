// 「释放电脑端的锁」的测试。
//
// 这个功能按下去的后果是**真的会关掉使用者电脑上的 Codex**，所以这一条测试
// 的重点不是「成功路径通不通」，而是**它在什么情况下不许动手** ——
// 宁可不释放，也不能误伤：
//
//   1. 没有 confirm:true         → 什么都不做（连探锁都不探）
//   2. 我们自己能松开            → 绝不去关桌面版
//   3. 一开始就没人占着          → 绝不因为「探针看起来占着」就关
//   4. 桌面版根本没开            → 如实报「不是它占的」，不硬来
//   5. /codex/lock 少了那道自定义头、或者来源不同 → 403
//
// 真正「关掉桌面版」的那一步（targets.stopDesktop / taskkill ChatGPT.exe）
// 在这里用的是**假的目标对象**，永远不会碰到使用者的程序。真机上验它要显式
// 打开开关，走的是 test-guard 的 desktopKillAllowed 那套规矩。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const { createLockService, probeLock, lockPath, threadIdOk } = require('./codex-lock.js');
const { extractRegisterArg, extractFunction } = require('./page-source.js');

const TID = '019fe0dd-83db-7881-affb-77f675c36bb9';
let bad = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { bad++; console.log(`  ✗ ${msg}`); };

/** 假的目标对象：记下谁调过 stopDesktop，但一个进程都不碰 */
function fakeTargets(opts) {
  const o = opts || {};
  const calls = { stopped: 0 };
  return {
    calls,
    t: {
      desktopStatus: () => ({ running: !!o.desktopRunning, count: o.desktopRunning ? 3 : 0 }),
      stopDesktop: async () => { calls.stopped++; return { ok: o.stopOk !== false, message: '（假的目标：没有真的关）' }; }
    }
  };
}

/**
 * 假的 app-server。
 *
 * script(method, params, calls) 返回：
 *   {result: …} 正常返回；{error: '文本'} 抛错（就像真的 app-server 拒绝时那样）。
 * 用它可以精确复现「拿得到 / 被另一个进程占着 / 报别的错」这三种世界。
 */
function fakeRpc(script) {
  const calls = [];
  const fn = async (method, params) => {
    calls.push({ method, params });
    const h = (script && script(method, params, calls)) || {};
    if (h.error) throw Error(h.error);
    return h.result === undefined ? {} : h.result;
  };
  return { calls, fn };
}

/** 一个「被另一个进程占着」的 app-server：resume 一律报 active writer */
const WRITER_ERR = 'thread 019fe0dd-83db-7881-affb-77f675c36bb9 already has an active writer';

const svc = (deps) => createLockService(BASE, Object.assign({ waitMs: 1, waitTries: 2 }, deps));

(async () => {
  console.log('\n释放锁：先看它什么时候**不**许动手\n');

  // ① 没有确认
  {
    const t = fakeTargets({ desktopRunning: true });
    const rpc = fakeRpc(() => ({ result: {} }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, {});
    assert.equal(r.code, 'no-confirm');
    assert.equal(t.calls.stopped, 0);
    assert.deepEqual(rpc.calls, [], '没确认就一个请求都不该发');
    ok('没有 confirm:true：什么都不做（连 app-server 都不问）');
  }

  // ② 会话 id 不对
  {
    const t = fakeTargets({ desktopRunning: true });
    const rpc = fakeRpc(() => ({ result: {} }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release('../../evil', { confirm: true });
    assert.equal(r.code, 'bad-thread');
    assert.equal(t.calls.stopped, 0);
    assert.deepEqual(rpc.calls, []);
    assert.equal(threadIdOk('../../evil'), false);
    assert.equal(threadIdOk(TID), true);
    ok('会话 id 不合法：拒绝（这个值会拼进文件名和 PowerShell 命令）');
  }

  // ③ 拿得到（多半是我们自己之前占着）→ 还回去，绝不碰桌面版
  {
    const t = fakeTargets({ desktopRunning: true });
    const rpc = fakeRpc(() => ({ result: {} }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, true);
    assert.equal(r.method, 'app-server');
    // 拿了就必须还 —— 这个按钮的目的是「松开」，不是「我来占着」
    assert.deepEqual(rpc.calls.map((c) => c.method), ['thread/resume', 'thread/unsubscribe']);
    assert.equal(t.calls.stopped, 0, '拿得到的时候绝不许动桌面版');
    assert.equal(r.gaveBack, true);
    ok('拿得到这条会话：立刻还回去，桌面版一个进程都没碰');
  }

  // ④ 被另一个进程占着 + 桌面版在跑 → 这是唯一允许关它的情况，而且要**验证**
  {
    const t = fakeTargets({ desktopRunning: true, stopOk: true });
    let closed = false;
    const rpc = fakeRpc((method) => {
      if (method === 'thread/resume') return closed ? { result: {} } : { error: WRITER_ERR };
      return { result: {} };
    });
    // stopDesktop 之后世界变了（假的）
    const targetsFor = () => ({
      desktopStatus: t.t.desktopStatus,
      stopDesktop: async (lang) => { const r = await t.t.stopDesktop(lang); closed = true; return r; }
    });
    const s = svc({ targetsFor, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, true);
    assert.equal(r.method, 'desktop-closed');
    assert.equal(t.calls.stopped, 1);
    assert.equal(r.gaveBack, true, '拿到之后必须还回去');
    assert.ok(rpc.calls.filter((c) => c.method === 'thread/resume').length >= 2,
      '关掉桌面版之后要用**同一个判据**再问一次，不能关完就宣布成功');
    ok('被另一个进程占着：关掉桌面版 → 再问一次拿得到 → 还回去（不谎报）');
  }

  // ⑤ 被占着，但桌面版没开 → 如实报，不硬来也不假装成功
  {
    const t = fakeTargets({ desktopRunning: false });
    const rpc = fakeRpc(() => ({ error: WRITER_ERR }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-desktop');
    assert.equal(t.calls.stopped, 0);
    ok('被占着但桌面版没开：报「不是它占的」，不假装成功也不硬来');
  }

  // ⑥ ★ 报的是**别的**错（超时、连接断了…）→ 绝不能去关桌面版
  //
  //   这一条是最要紧的安全性质：判据认不出来的时候，「不动使用者的电脑」
  //   永远优先于「让按钮看起来有用」。
  {
    const t = fakeTargets({ desktopRunning: true });
    const rpc = fakeRpc(() => ({ error: 'request timeout' }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unclear');
    assert.equal(t.calls.stopped, 0, '认不出是谁占着的时候，不许关使用者的程序');
    assert.ok(r.error === 'request timeout');
    ok('问不出结果（超时等）：如实说不知道，**绝不**顺手关掉使用者的程序');
  }

  // ⑦ 关了桌面版还是拿不到 → still-locked（不许把「关了」当成「解开了」）
  {
    const t = fakeTargets({ desktopRunning: true, stopOk: true });
    const rpc = fakeRpc(() => ({ error: WRITER_ERR }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'still-locked');
    ok('关掉桌面版之后仍然拿不到：报 still-locked（不谎报成功）');
  }

  // ⑧ 关桌面版本身失败
  {
    const t = fakeTargets({ desktopRunning: true, stopOk: false });
    const rpc = fakeRpc(() => ({ error: WRITER_ERR }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'stop-failed');
    ok('关闭失败：报 stop-failed');
  }

  // ⑨ app-server 整个连不上 → 也是「认不出」，不许动使用者的程序
  {
    const t = fakeTargets({ desktopRunning: true });
    const s = svc({
      targetsFor: () => t.t,
      rpcFor: () => async () => { throw Error('connection unavailable'); }
    });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unclear');
    assert.equal(t.calls.stopped, 0, 'app-server 都没起的时候更不该去关桌面版');
    ok('app-server 连不上：如实报「问不出来」，一个进程都不碰');
  }

  console.log('\n探锁本身（真跑一次，不用假的）\n');
  {
    // 一个几乎不可能存在的会话 id → 文件不存在。这条同时验证「探针能在这台
    // 机器上真的跑起来」，而不是永远返回 unknown 还假装检查过了。
    const id = 'ffffffff-ffff-ffff-ffff-fffffffffffe';
    const r = probeLock(id);
    if (process.platform === 'win32') {
      if (r.state === 'absent') ok('Windows 上探锁可用：不存在的锁文件 → absent');
      else fail(`Windows 上探锁返回了 ${r.state}（${r.detail}）—— 探针没在真干活`);
    } else {
      assert.equal(r.state, 'unknown');
      ok('非 Windows：如实返回 unknown（不猜）');
    }
    assert.equal(lockPath(id), path.join(require('os').homedir(), '.codex', 'thread-writer-locks', `${id}.lock`));
  }

  console.log('\n真接一次 app-server（假的那个，但它真的收 WebSocket 帧）\n');
  {
    // ★ 这一条是**真机日志换来的**：codex-queue.js 的 createRpc(port) 收的是
    //   「取端口的函数」而不是端口号（它惰性连接，连的时候才调 port()）。
    //   这里原来传了 Number(port()) —— 一个数字 —— 于是那句 port() 抛
    //   「port is not a function」，被 catch 吞掉，表现是**这一步永远静默失败**。
    //   假 rpc 的单元测试看不出来（它不关心参数），所以必须真接一次 socket。
    const httpMod = require('http');
    const cryptoMod = require('crypto');
    const { parseFrames, buildFrame, OP_TEXT, OP_CLOSE } = require('./ws-frame.js');
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const seen = [];
    const sockets = [];
    const server = httpMod.createServer();
    server.on('upgrade', (req, socket) => {
      sockets.push(socket);
      const accept = cryptoMod.createHash('sha1')
        .update(String(req.headers['sec-websocket-key']) + GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
        + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const { frames, rest } = parseFrames(buf);
        buf = rest;
        for (const f of frames) {
          if (f.opcode === OP_CLOSE) { try { socket.end(); } catch (e) { } continue; }
          if (f.opcode !== OP_TEXT) continue;
          let msg = null;
          try { msg = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
          seen.push(msg);
          if (msg.id !== undefined) {
            socket.write(buildFrame(OP_TEXT,
              Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })), false));
          }
        }
      });
      socket.on('error', () => { });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const srvPort = server.address().port;

    const t = fakeTargets({ desktopRunning: true });
    const s = svc({
      port: () => srvPort,
      // 真的用生产代码那条 rpc 工厂 —— 契约错了就会在这儿现形
      rpcFor: (prt) => {
        assert.equal(typeof prt, 'function', 'rpcFor 收到的是端口号，不是取端口的函数');
        return require('./codex-queue.js').createRpc(prt);
      },
      targetsFor: () => t.t
    });
    const r = await s.release(TID, { confirm: true });

    assert.equal(r.ok, true);
    assert.equal(r.method, 'app-server', `没走通 app-server 那条路：${JSON.stringify(r)}`);
    assert.ok(seen.some((m) => m.method === 'initialize'), '没有先 initialize 就发请求');
    const resume = seen.find((m) => m.method === 'thread/resume');
    assert.ok(resume, 'app-server 没收到 thread/resume —— 那才是「谁占着」的权威判据');
    assert.equal(resume.params.threadId, TID);
    const unsub = seen.find((m) => m.method === 'thread/unsubscribe');
    assert.ok(unsub, 'app-server 没收到 thread/unsubscribe —— 拿了不还回去 = 把电脑挡住');
    assert.equal(unsub.params.threadId, TID);
    assert.equal(t.calls.stopped, 0, '自己能松开时绝不许动桌面版');
    ok('真的连上 app-server：先 resume 问一句、拿到之后 unsubscribe 还回去');
    for (const sk of sockets) { try { sk.destroy(); } catch (e) { } }
    server.close();
  }

  console.log('\n锁文件探针：只做日志，不参与判断（这条是实测换来的）\n');
  {
    // ★ 2026-09-24 实测：长命的 app-server 会一直开着它用过的每个锁文件，
    //   于是「独占打开失败」只等于「某个 app-server 还活着」—— 目录里两天前的
    //   锁文件也照样报 held。当时拿它当判据，结果按钮永远回答「锁本来就是空的」，
    //   使用者看到的就是「按了没反应」。
    //   所以现在：判断一律走 resume；探针只写日志。这条测试钉住这个分工。
    const dir = path.join(require('os').homedir(), '.codex', 'thread-writer-locks');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.lock')); } catch (e) { }
    if (process.platform === 'win32' && files.length) {
      const held = files.filter((f) => probeLock(f.replace(/\.lock$/, '')).state === 'held').length;
      console.log(`      （这台机器上 ${files.length} 个锁文件，探针报「被占着」的有 ${held} 个）`);
      if (held === files.length && files.length > 3) {
        ok('证实了那个坑：探针对**所有**锁文件都报 held —— 它分不出「谁在用」');
      } else {
        ok('探针输出已记录（这台机器上不是全 held，但判据仍然只用于日志）');
      }
    } else {
      ok('非 Windows 或没有锁文件：跳过现场统计（判据仍然只用于日志）');
    }
    const src = fs.readFileSync(path.join(BASE, 'scripts', 'codex-lock.js'), 'utf8');
    const releaseSrc = src.slice(src.indexOf('async function release('), src.indexOf('async function tryTake('));
    assert.ok(!/\bprobe\(threadId\)\s*\.state/.test(releaseSrc) && !/beforeFree/.test(releaseSrc),
      'release() 又在拿探针结果做判断了 —— 那个判据是坏的（见 probeLock 的注释）');
    ok('release() 里没有任何「拿探针结果做判断」的代码');
  }

  console.log('\nHTTP 那一层（自带服务，不碰网关）\n');
  {
    const t = fakeTargets({ desktopRunning: true });
    const s = svc({ targetsFor: () => t.t, rpcFor: () => fakeRpc(() => ({ result: {} })).fn });
    const server = http.createServer((req, res) => s.handle(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/codex/lock`;
    const post = (body, headers) => fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: JSON.stringify(body)
    });

    // 少了自定义头 → 403（跨站表单发不出自定义头）
    let r = await post({ threadId: TID, confirm: true });
    assert.equal(r.status, 403);
    ok('少了 x-dsh-lock 头 → 403');

    // 来源不同 → 403
    r = await post({ threadId: TID, confirm: true }, { 'x-dsh-lock': '1', origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    ok('Origin 不同源 → 403');

    // 没确认 → 400，而且**没有**任何释放动作
    r = await post({ threadId: TID }, { 'x-dsh-lock': '1' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'no-confirm');
    assert.equal(t.calls.stopped, 0);
    ok('没有 confirm:true → 400，且不动手');

    // 会话 id 不合法 → 400
    r = await post({ threadId: 'x/../y', confirm: true }, { 'x-dsh-lock': '1' });
    assert.equal(r.status, 400);
    ok('会话 id 不合法 → 400');

    // GET → 405
    r = await fetch(url, { headers: { 'x-dsh-lock': '1' } });
    assert.equal(r.status, 405);
    ok('GET → 405');

    // 正常一次（假的探针说「本来就没锁」，所以什么都不会被关）
    r = await post({ threadId: TID, confirm: true }, { 'x-dsh-lock': '1' });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(t.calls.stopped, 0);
    ok('合法请求 → 200 + {ok, method}，且没有关掉任何程序');

    server.close();
  }

  console.log('\n界面上那几处必须对得上\n');
  {
    const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');

    // 1. 按钮在、文案在
    assert.ok(html.includes('releaseDesktopLock('), 'codex.html 里没有 releaseDesktopLock');
    assert.ok(/tr\('释放电脑端的锁'\)/.test(html), '按钮文字没了');
    ok('界面上有「释放电脑端的锁」按钮');

    // 2. 每个释放入口的确认框都要讲清后果；不绑定「交出会话」之类的旧措辞。
    const confirmSrcs = [...html.matchAll(/confirm\(tr\('释放电脑端的锁\？[\s\S]*?'\)\)/g)];
    assert.ok(confirmSrcs.length, '找不到确认框那段');
    for (const confirmSrc of confirmSrcs) {
      for (const must of ['电脑上的 Codex 会关掉', '任务可能被中断', '会话内容不会丢', '手机就能接着下指令']) {
        assert.ok(confirmSrc[0].includes(must), `确认框里没写「${must}」`);
      }
    }
    ok('所有确认框写清了：关闭桌面端 / 任务可能中断 / 会话不丢 / 手机继续发送');

    // 3. 请求必须带上确认与服务端要的那道头
    assert.ok(/'x-dsh-lock': '1'/.test(html), '请求没带 x-dsh-lock 头');
    assert.ok(/confirm: true/.test(html), '请求没带 confirm:true');
    ok('请求带 x-dsh-lock:1 与 confirm:true（服务端两道门都要过）');

    // 4. 旧那句「本页面不会关闭电脑 Codex 或强行解锁」必须消失 ——
    //    现在这句话是**假的**了，留着就是骗人。
    //
    //    只在**代码行**里查，注释里引用旧文案不算（那是在解释来龙去脉，
    //    删掉它才是损失）。判据按整行是不是注释 —— 和 test-i18n.js 同一套办法。
    const codeOnly = html.split('\n')
      .filter((line) => { const s = line.trim(); return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')); })
      .join('\n');
    assert.ok(!codeOnly.includes('本页面不会关闭电脑 Codex'), '旧文案还在：它现在与事实相反');
    ok('旧的「本页面不会关闭电脑 Codex」已从界面上删掉（那句话现在与事实相反）');

    // 5. 服务端会回的每个 code，界面上都得有三种语言的对应说法 ——
    //    漏一个，使用者看到的就是服务端那句中文（甚至一串英文错误）。
    const dictSrc = extractRegisterArg(html);
    assert.ok(dictSrc, 'codex.html 里找不到 DshI18n.register({…})');
    const dict = vm.runInNewContext(`(${dictSrc})`, {});
    const codes = ['app-server', 'none', 'desktop-closed', 'not-desktop', 'still-locked',
      'stop-failed', 'bad-thread', 'no-confirm'];
    const block = html.slice(html.indexOf('var LOCK_RESULT_TEXT'), html.indexOf('function releaseDesktopLock'));
    const missing = [];
    for (const c of codes) {
      const m = block.match(new RegExp(`'${c}':\\s*'([^']+)'`));
      if (!m) { missing.push(`${c}: 界面没有对应文案`); continue; }
      const entry = dict[m[1]];
      if (!entry) { missing.push(`${c}: 字典里没有「${m[1].slice(0, 18)}…」`); continue; }
      for (const lg of ['en', 'es']) if (!entry[lg]) missing.push(`${c}: 缺 ${lg}`);
    }
    assert.deepEqual(missing, []);
    ok('服务端每个 code 在界面上都有中/英/西三种说法');

    // 6. 界面自己硬编码的 tr('…') 也得在字典里。
    //
    //    ★ 字面量必须**按 JS 规则解释**再比：源码里写的是 \n（反斜杠 + n），
    //      而字典里已经是真换行。拿源码原样去比，带换行的长句会全部误报
    //      「字典里没有」—— test-i18n.js 第一版就是栽在这上面，误报了 29 条。
    const trs = [...html.matchAll(/tr\('([^']{4,})'\)/g)].map((m) => m[1])
      .filter((s) => /[\u4e00-\u9fff]/.test(s));
    const notInDict = [...new Set(trs)].filter((raw) => {
      let key = raw;
      try { key = vm.runInNewContext(`('${raw}')`, {}); } catch (e) { /* 解不开就拿原样比 */ }
      return !dict[key];
    });
    assert.deepEqual(notInDict, []);
    ok(`界面上 ${new Set(trs).size} 条 tr('…') 文案都在字典里`);
  }

  console.log('\n把那张「被占用」卡片真的渲染一遍（假 DOM）\n');
  {
    // ★ 这一段测的是使用者最在意的那条：**不能一键误触**。
    //   「按钮在不在」扫一眼源码就知道；「点了取消会不会照样动手」只有真跑才知道。
    const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
    const dict = vm.runInNewContext(`(${extractRegisterArg(html)})`, {});

    const card = renderConflictCard(html, dict, 'zh', { confirm: false });
    assert.deepEqual(card.buttons.map((b) => b.text),
      ['在同一个项目里开新的', '重试', '释放电脑端的锁']);
    ok('卡片上三个按钮都在（新开 / 重试 / 释放电脑端的锁）');
    assert.equal(card.buttons[2].className, 'd', '释放键没有用「危险」样式');
    ok('释放键用的是危险样式（和审批里的拒绝同一类）');

    // 确认框里点「取消」→ 一个请求都不许发出去
    card.click(2);
    assert.deepEqual(card.calls, [], `取消之后还发了请求：${JSON.stringify(card.calls)}`);
    ok('确认框点「取消」：一个请求都不发（不会误触）');

    // 确认之后 → 必须带上服务端要的那道头与 confirm:true
    const yes = renderConflictCard(html, dict, 'zh', { confirm: true });
    yes.click(2);
    assert.equal(yes.calls.length, 1, '确认之后应该正好发一个请求');
    const c = yes.calls[0];
    assert.equal(c.url, '/codex/lock');
    assert.equal(c.headers['x-dsh-lock'], '1');
    assert.equal(JSON.parse(c.body).confirm, true);
    assert.equal(JSON.parse(c.body).threadId, TID);
    ok('确认之后：POST /codex/lock，带 x-dsh-lock 与 confirm:true');

    // 三种语言下确认框都得把后果说全（漏一种，那个语种的使用者就是在盲按）
    const confirmCall = html.match(/confirm\(tr\(('释放电脑端的锁\？(?:\\.|[^'\\])*')\)\)/);
    assert.ok(confirmCall, '找不到释放锁确认框文案');
    const CONFIRM = vm.runInNewContext(confirmCall[1], {});
    assert.ok(dict[CONFIRM], '释放锁确认框文案不在翻译字典里');
    for (const lg of ['en', 'es']) {
      const r2 = renderConflictCard(html, dict, lg, { confirm: false });
      r2.click(2);                       // 点一下才会弹确认框（也就才会有文案可查）
      const want = dict[CONFIRM][lg];
      if ((r2.asked[0] || '') === want) ok(`${lg}：确认框用的是这个语种的完整后果说明`);
      else fail(`${lg}：确认框文案不对 → ${String(r2.asked[0]).slice(0, 50)}`);
    }
  }

  console.log('\n「释放电脑端的锁」得是一个**找得到**的入口（使用者说找不到）\n');
  {
    const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
    const dict = vm.runInNewContext(`(${extractRegisterArg(html)})`, {});

    // ① 设置面板里有固定的入口 —— 不能只长在「撞上冲突」那张卡片上
    assert.ok(/function openLockPanel\(/.test(html), 'codex.html 里没有 openLockPanel');
    const sheetSrc = extractFunction(html, 'openSheet');
    assert.ok(sheetSrc, '找不到 openSheet()');
    assert.ok(/会话写入锁/.test(sheetSrc) && /openLockPanel\(\)/.test(sheetSrc),
      '设置面板里没有「会话写入锁」这一项');
    ok('设置面板（⋯）里有固定的「会话写入锁」入口');

    // ② 标题栏那个 🔒 也得能点（手机正占着锁时才有，点它就是同一个面板）
    const hintSrc = extractFunction(html, 'updateLockHint');
    assert.ok(hintSrc && /openLockPanel\(\)/.test(hintSrc), '标题栏的 🔒 标没有接上面板');
    ok('标题栏的「🔒 占用中」点开也是这个面板');

    // ②b 固定入口位于**语音旁边**（输入区那排图标里）
    //
    //   这条断言同时钉住两件事：按钮在，而且**紧跟在 btn-voice 后面** ——
    //   以后谁把顺序挪了，这里会红。
    const iconRow = html.slice(html.indexOf('<div class="iconrow">'), html.indexOf('</div>', html.indexOf('<div class="iconrow">')));
    const atVoice = iconRow.indexOf('id="btn-voice"');
    const atLock = iconRow.indexOf('id="btn-lock"');
    assert.ok(atLock > 0, '输入区那排图标里没有 btn-lock —— 使用者要的是「语音旁边」');
    assert.ok(atVoice > 0 && atLock > atVoice, 'btn-lock 没有排在 btn-voice 后面');
    assert.ok(iconRow.slice(atVoice + 'id="btn-voice"'.length, atLock).indexOf('id="btn-') < 0,
      'btn-lock 和 btn-voice 之间还夹着别的按钮');
    ok('输入区里 🔓 紧挨着 🎤（使用者点名要的位置）');
    assert.ok(/btn-lock'\)\.onclick[\s\S]{0,200}releaseDesktopLock\(/.test(html),
      "btn-lock 的 onclick 没有接到 releaseDesktopLock —— 点了等于没点");
    ok('点 🔓 直接走释放流程（不是「再点一次才动」）');

    // ③ 面板本身：开着会话时给按钮，没开会话时说清为什么现在不能按
    const withThread = renderLockPanel(html, dict, { id: TID, name: '测试会话' });
    assert.equal(withThread.sheetOn, true, '面板没被打开');
    assert.ok(withThread.releaseBtn, '面板里没有释放按钮');
    assert.equal(withThread.releaseBtn.textContent, '释放电脑端的锁');
    assert.ok(/btn d/.test(withThread.releaseBtn.className), '释放按钮没有用危险样式');
    assert.ok(withThread.texts.some((x) => /关掉电脑上的 Codex/.test(x) && /任务可能被中断/.test(x)),
      '面板里没写关闭桌面端和中断任务的风险');
    ok('面板里有「释放电脑端的锁」按钮（危险样式）+ 代价说明');

    const noThread = renderLockPanel(html, dict, null);
    assert.ok(!noThread.releaseBtn, '没有会话时不该给一个按不动的按钮');
    assert.ok(noThread.texts.some((x) => /先打开一条会话/.test(x)), '没有会话时没说清下一步');
    ok('还没打开会话时：说清「先打开一条会话」，而不是给一个按不动的按钮');
  }

  console.log(bad ? `\n${bad} 处问题\n` : '\n全部通过\n');
  // 明确退出：上面那条真接 socket 的用例会把连接留在那儿，
  // 而 codex-queue 的 rpc 客户端也保持长连接 —— 不等事件循环自己空掉
  // （否则这个测试**永远不会结束**，CI 上会一直挂到超时）。
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});

// ── 在假 DOM 里真跑一遍 codex.html 的「被占用」卡片 ───────────────────────────
//
// 为什么值得这么麻烦：这一段要守的是「**不能一键误触**」——
// 按钮在不在，扫一眼源码就知道；但「点了取消之后会不会照样发请求」
// 只有把 showWriterConflict() 和 releaseDesktopLock() 真跑一遍才看得见。
//
// 用函数声明（不是 const）是有意的：测试主体是文件靠前那个立即执行的
// async 函数，const 在它后面声明会落进 TDZ；函数声明会被提升。

/** 只做这两个函数用得到的那几件事的假 DOM */
function conflictFakeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', _html: '',
    children: [], parentNode: null, attrs: {}, onclick: null,
    style: { cssText: '', opacity: '' },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); }
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    querySelector(sel) {
      const want = String(sel || '').replace(/^\./, '');
      return this.children.find((c) => c.className === want) || null;
    },
    get firstChild() { return this.children[0] || null; },
    get firstElementChild() { return this.children[0] || null; }
  };
  // 真 DOM 里 innerHTML 会建出子元素（card.querySelector('.btns') 靠的就是它）。
  // 这里把 `class="x"` 挨个变成子元素 —— 够这两个函数用，且不假装支持 HTML。
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      this.children.length = 0;
      for (const m of this._html.matchAll(/class="([^"]+)"/g)) {
        const child = conflictFakeEl('div');
        child.className = m[1];
        this.appendChild(child);
      }
    }
  });
  return el;
}

/** `var LOCK_RESULT_TEXT = {…}` 里那段字面量（这一段没有嵌套大括号，可以直切） */
function extractLockResultText(html) {
  const at = html.indexOf('var LOCK_RESULT_TEXT');
  if (at < 0) return {};
  const open = html.indexOf('{', at);
  const close = html.indexOf('\n};', open);
  if (open < 0 || close < 0) return {};
  return vm.runInNewContext(`(${html.slice(open, close + 2)})`, {});
}

/**
 * 在假 DOM 里跑一遍 openLockPanel()（设置面板里那个「会话写入锁」面板）。
 * @param thread null = 还没打开任何会话
 */
function renderLockPanel(html, dict, thread) {
  const inner = conflictFakeEl('div');
  const sheet = conflictFakeEl('div');
  const texts = [];
  const sandbox = {
    state: { thread: thread, resumed: false, view: thread ? 'thread' : 'list' },
    document: { createElement: conflictFakeEl, getElementById: () => null },
    $: (id) => (id === 'sheetInner' ? inner : sheet),
    tr: (s) => s,
    esc: (s) => String(s == null ? '' : s),
    toast: () => { }, closeSheet: () => { }, openThread: () => { }, openSheet: () => { },
    askReleaseLock: () => { },
    confirm: () => false,
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(html, 'openLockPanel'), sandbox, { filename: 'openLockPanel' });
  sandbox.openLockPanel();

  // 面板上的文字：.info 的 textContent + 按钮上的字
  for (const c of inner.children) {
    if (c.className === 'info' || c.className === 'shead') texts.push(c.textContent);
    if (c.className === 'btn d') texts.push(c.textContent);
  }
  const releaseBtn = inner.children.find((c) => c.className === 'btn d') || null;
  return { inner, texts, releaseBtn, sheetOn: sheet.classList.contains('on') };
}

function renderConflictCard(html, dict, lang, opts) {
  const o = opts || {};
  const calls = [];
  const asked = [];
  const body = conflictFakeEl('body');

  const sandbox = {
    document: { createElement: conflictFakeEl, getElementById: () => null },
    $: (id) => (id === 'body' ? body : conflictFakeEl('div')),
    tr: (s) => (lang === 'zh' ? s : ((dict[s] && dict[s][lang]) || s)),
    LOCK_RESULT_TEXT: extractLockResultText(html),
    confirm: (text) => { asked.push(text); return !!o.confirm; },
    privateFetch: (url, init) => {
      calls.push({ url, headers: (init && init.headers) || {}, body: (init && init.body) || '' });
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, method: 'app-server' }) });
    },
    toast: () => { }, scrollDown: () => { }, newThread: () => { }, openThread: () => { },
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // 三个函数一起放进沙箱：releaseDesktopLock() 现在把「发那一枪」委托给
  // askReleaseLock()（设置面板里那个入口也用同一个），漏一个就会「点了没反应」。
  vm.runInContext([
    extractFunction(html, 'showWriterConflict'),
    extractFunction(html, 'releaseDesktopLock'),
    extractFunction(html, 'askReleaseLock')
  ].join('\n'), sandbox, { filename: 'writer-conflict' });

  sandbox.showWriterConflict({ id: '019fe0dd-83db-7881-affb-77f675c36bb9', cwd: 'C:\\x' });
  const card = body.children[0];
  const btns = card.querySelector('.btns');
  return {
    calls,
    asked,
    buttons: btns.children.map((b) => ({ text: b.textContent, className: b.className })),
    click: (i) => { if (btns.children[i] && btns.children[i].onclick) btns.children[i].onclick(); }
  };
}
