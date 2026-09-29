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
  if (process.argv.includes('--phone-scope-only')) {
    await phoneScopeRegression();
    process.exitCode = bad ? 1 : 0;
    return;
  }
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

    assert.equal(r.ok, true, `app-server RPC failed: ${JSON.stringify(r)}`);
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
    assert.ok(/btn\.textContent = tr\('关闭电脑 Codex 并接管原会话'\)/.test(html), '紧急接管按钮文字没了');
    ok('界面上有明确写出关闭整个电脑 Codex 的紧急按钮');

    // 2. 每个释放入口的确认框都要讲清后果；不绑定「交出会话」之类的旧措辞。
    const confirmSrcs = [...html.matchAll(/confirm\(tr\('释放电脑端的锁\？[\s\S]*?'\)\)/g)];
    assert.ok(confirmSrcs.length, '找不到确认框那段');
    for (const confirmSrc of confirmSrcs) {
      for (const must of ['如果这条会话由电脑端占用，将关闭电脑上的 Codex', '电脑端任务会被终止', '已保存的会话记录会保留', '手机可以发送新指令']) {
        assert.ok(confirmSrc[0].includes(must), `确认框里没写「${must}」`);
      }
    }
    ok('所有确认框写清了：关闭桌面端 / 任务终止 / 保存记录保留 / 成功后手机发送');

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
      ['复制上下文，在手机独立续聊', '同项目新会话（不复制对话）', '继续查看', '接管原会话…（会关闭整个电脑 Codex）']);
    ok('冲突卡片先提供独立续聊、新会话和继续查看，紧急接管排最后');
    assert.ok(card.buttons.every((b) => b.className !== 'd'), '卡片上不该直接放一键关闭桌面端的按钮');
    card.click(2);
    assert.deepEqual(card.calls, [], '继续查看不能发出锁释放请求');
    ok('继续查看不会向锁释放接口发请求');

    // The dangerous action lives in the collapsed advanced section. Its
    // confirmation still gates the same server request path.
    const no = renderLockPanel(html, dict, { id: TID, name: '测试会话' }, { confirm: false });
    assert.ok(no.advanced && no.releaseBtn, '紧急操作必须位于折叠的高级区域');
    no.releaseBtn.onclick();
    assert.deepEqual(no.calls, [], '取消确认后不许发释放请求');
    ok('紧急接管确认框点取消，不发出释放请求');

    const yes = renderLockPanel(html, dict, { id: TID, name: '测试会话' }, { confirm: true });
    yes.releaseBtn.onclick();
    assert.deepEqual(yes.calls, [TID]);
    ok('确认后仅针对当前会话调用释放动作');

    // 三种语言下确认框都得把后果说全（漏一种，那个语种的使用者就是在盲按）
    const confirmCall = html.match(/confirm\(tr\(('释放电脑端的锁\？(?:\\.|[^'\\])*')\)\)/);
    assert.ok(confirmCall, '找不到释放锁确认框文案');
    const CONFIRM = vm.runInNewContext(confirmCall[1], {});
    assert.ok(dict[CONFIRM], '释放锁确认框文案不在翻译字典里');
    for (const lg of ['en', 'es']) {
      const r2 = renderLockPanel(html, dict, { id: TID }, { lang: lg, confirm: false });
      r2.releaseBtn.onclick();
      const want = dict[CONFIRM][lg];
      if ((r2.asked[0] || '') === want) ok(`${lg}：确认框用的是这个语种的完整后果说明`);
      else fail(`${lg}：确认框文案不对 → ${String(r2.asked[0]).slice(0, 50)}`);
    }
  }

  console.log('\n手机断开后要**自动交还**给电脑（使用者：「手机端关闭后要让电脑彻底登录上」）\n');
{
  const proxy = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
  ok('有一条 Codex 手机连接计数器', /let codexPhoneClients = 0/.test(proxy));
  ok('连上来会取消交还倒计时', /function codexPhoneAttached\(\)[\s\S]{0,300}clearTimeout\(codexReleaseTimer\)/.test(proxy));
  ok('全断开才开始倒计时（还有别人连着就不动）',
    /function codexPhoneDetached\(\)[\s\S]{0,160}if \(codexPhoneClients > 0 \|\| codexReleaseTimer\) return;/.test(proxy));
  ok('到点走 releasePhone（只松开手机已加载的会话，桌面版不碰）',
    /setTimeout\(async \(\) => \{[\s\S]{0,400}codexLock\.releasePhone\(null/.test(proxy));
  ok('倒计时是「宽限」不是「立刻」（够一次切前后台）',
    /CODEX_RELEASE_GRACE_MS = 60 \* 1000/.test(proxy));
  ok('WS 接通时挂上 attached', /codexPhoneAttached\(\);/.test(proxy));
  ok('WS 关闭时挂上 detached', /codexPhoneDetached\(\);/.test(proxy));

  const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
  ok('不在 pagehide 中把明文会话编号伪标成加密请求',
    !/addEventListener\('pagehide'[\s\S]{0,500}fetch\('\/codex\/lock'/.test(html));
  ok('自动交还由服务端断线宽限处理，不依赖页面结束时的网络请求',
    /codexPhoneDetached\(\)/.test(proxy) && /CODEX_RELEASE_GRACE_MS = 60 \* 1000/.test(proxy));
}

console.log('\n危险按钮必须标红（原来 .btn.d 根本没有样式）\n');
{
  const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
  ok('.btn.d 现在真的有危险样式（红底红边）',
    /\.btn\.d\{[^}]*background:#3a1d1d[^}]*border:1px solid #a33/.test(html));
  ok('危险按钮上方有红色警告条（.warn-red）', /\.warn-red\{/.test(html) && /className = 'warn-red'/.test(html));
  ok('警告条写明「会关掉电脑上的 Codex，正在执行的电脑端任务会被终止」',
    /会关掉电脑上的 Codex，正在执行的电脑端任务会被终止/.test(html));
  // 使用者 2026-09-27：「释放锁的功能也要解释清楚 —— 因为电脑端占用、手机无法使用，
  // 可以释放锁，但可能造成电脑端 Codex 关闭、任务终止」
  ok('面板开头解释了同一条会话只能有一个发送端',
    /同一条会话同时只能有一个地方发送/.test(html));
  ok('安全那颗说清手机断开后会自动松开',
    /手机关掉或断开一会儿之后会自动松开/.test(html));
  ok('危险那颗说清代价（关掉 Codex、那一轮任务会停）',
    /代价是关掉电脑上的 Codex/.test(html));
  ok('警告条摆在按钮**之前**',
    html.indexOf("className = 'warn-red'") < html.indexOf("btn.id = 'lock-release'"));
  ok('「释放手机端的锁」不带危险样式（它没有代价）',
    /safe\.className = 'btn';/.test(html));
}

console.log('\nCodex 代理：托管服务进程级设置；桌面版只在确认后改用户变量\n');
{
  const proxy = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
  ok('状态里带 codexProxy', /codexProxy: codexProxyInfo\(\)/.test(proxy));
  ok('读系统代理（ProxyEnable/ProxyServer，多协议写法也认）',
    /function systemProxyUrl\(\)[\s\S]{0,600}ProxyServer/.test(proxy));
  ok('读用户环境变量 HTTPS_PROXY（桌面版继承的就是它）',
    /regQuery\('HKCU\\\\Environment', 'HTTPS_PROXY'\)/.test(proxy));
  ok('显式手动动作需要服务器端确认',
    /body\.action === 'fix-codex-proxy'[\s\S]{0,450}body\.confirm !== true/.test(proxy));
  ok('网关启动和定期检查不再改用户级代理变量',
    !/autoFixCodexProxy/.test(proxy) && !/自动设好 Codex 桌面版的代理/.test(proxy));
  ok('关掉系统代理但用户变量仍有旧值时会提醒', /staleUserProxy: !system && !!userEnv/.test(proxy));

  const html = fs.readFileSync(path.join(BASE, 'pwa', 'console.html'), 'utf8');
  ok('控制台有体检那一行', /id="codex-proxy-state"/.test(html));
  ok('手动按钮先警告影响其他程序，再向服务端发确认',
    /if \(!confirm\(t\('要覆盖 Windows 当前用户的代理环境变量/.test(html) &&
    /action\('fix-codex-proxy',[^\n]*\{ confirm: true \}/.test(html));
  ok('界面不声称已自动修好桌面版',
    !/已自动设好：Codex 桌面版会走代理/.test(html) && /不会自动改 Windows 用户变量/.test(html));

  const targets = fs.readFileSync(path.join(BASE, 'scripts', 'targets.js'), 'utf8');
  ok('自家 Codex app-server 仍用进程级代理',
    /env: Object\.assign\(\{\}, process\.env, proxy\)/.test(targets));
}

console.log('\n「释放手机端的锁」：只收手机自己的摊子，一个电脑程序都不碰\n');
{
  const { createLockService } = require('./codex-lock.js');
  const calls = [];
  const svc = createLockService('/tmp/x', {
    port: () => 18790,
    // 假的 app-server：只记下我们发了什么
    rpcFor: () => async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return { data: ['thread-a', 'thread-b'] };
      return {};
    },
    probe: () => ({ state: 'absent', detail: 'no-lock-file' }),
    targetsFor: () => ({
      // 我们那个 app-server 在跑（managedPid 只认我们记下 pid 的那个）
      managedPid: () => 4242,
      stop: async () => { calls.push({ method: 'targets.stop' }); return { ok: true, message: '已停止（我们的那个）' }; },
      // 桌面版相关的接口：**一个都不许被调用**
      stopDesktop: async () => { calls.push({ method: 'targets.stopDesktop！！' }); return { ok: true }; },
      desktopStatus: () => { calls.push({ method: 'targets.desktopStatus！！' }); return { running: true, count: 3 }; }
    }),
    logger: () => { }
  });

  const r = await svc.releasePhone('01a098d4-f36d-75e2-ab16-0cd6ffbdd72f', {});
  ok('松开了我们 app-server 对这条会话的占用',
    calls.some((c) => c.method === 'thread/unsubscribe'), JSON.stringify(calls.map((c) => c.method)));
  ok('**没有** resume（resume 是「我要写」，正好相反）',
    !calls.some((c) => c.method === 'thread/resume'));
  const unsubs = calls.filter((c) => c.method === 'thread/unsubscribe').map((c) => c.params.threadId);
  // ★ 使用者 2026-09-27：「手机端关闭后电脑端能登录，**同时不影响手机端的使用**」
  //   所以默认路径**不停服务** —— 停了手机切回来要等冷启动，那就不叫流畅切换了。
  //   指定会话的按钮不能碰另一个手机正在使用的会话。
  ok('只松开当前会话，不碰其他手机会话',
    unsubs.length === 1 && unsubs[0] === '01a098d4-f36d-75e2-ab16-0cd6ffbdd72f', JSON.stringify(unsubs));
  ok('默认**不停**我们自己那个服务（手机回来就是热的）',
    !calls.some((c) => c.method === 'targets.stop'), JSON.stringify(calls.map((c) => c.method)));
  ok('返回值说明服务留着、只松开指定会话',
    r.serviceKept === true && r.unsubscribed === true && r.released.length === 0, JSON.stringify(r));

  // 只有明确要求时才停服务
  {
    const callsStop = [];
    const svcStop = createLockService('/tmp/x', {
      port: () => 18790,
      rpcFor: () => async (m) => {
        callsStop.push(m);
        if (m === 'thread/loaded/list') return { data: [] };
        return {};
      },
      probe: () => ({ state: 'absent' }),
      targetsFor: () => ({
        managedPid: () => 4242,
        stop: async () => { callsStop.push('targets.stop'); return { ok: true, message: '停了' }; }
      }),
      logger: () => { }
    });
    const rs = await svcStop.releasePhone('01a098d4-f36d-75e2-ab16-0cd6ffbdd72f', { stopService: true });
    ok('显式要求 stopService 时才停服务',
      callsStop.includes('targets.stop') && rs.serverStopped === true, JSON.stringify(rs));
  }
  ok('**绝不**去关电脑上的 Codex（stopDesktop 一次都没调）',
    !calls.some((c) => c.method === 'targets.stopDesktop！！'), JSON.stringify(calls.map((c) => c.method)));
  ok('也没去探桌面版状态（这个按钮跟它无关）',
    !calls.some((c) => c.method === 'targets.desktopStatus！！'));
  ok('返回 ok=true（手机这边确实松开了）', r.ok === true, JSON.stringify(r));
  ok('返回值里标了 phone:true，客户端能分清是哪一个按钮的结果', r.phone === true);

  // 没有会话编号时只供「所有手机都离线」的自动清理使用；空列表不能冒充成功。
  const calls2 = [];
  const svc2 = createLockService('/tmp/x', {
    port: () => 18790,
    rpcFor: () => async (m) => { calls2.push(m); return {}; },
    probe: () => ({ state: 'absent' }),
    targetsFor: () => ({
      managedPid: () => 4242,
      stop: async () => { calls2.push('targets.stop'); return { ok: true, message: 'ok' }; }
    }),
    logger: () => { }
  });
  const r2 = await svc2.releasePhone(null, {});
  ok('没有会话编号且没有已加载会话：没有实际释放就不报成功',
    r2.ok === false && !calls2.includes('thread/unsubscribe') && calls2.includes('thread/loaded/list'),
    JSON.stringify(calls2));

  // 「那个服务本来就不是我们的」（桌面版占着端口）也算成功 —— 手机这边没什么可放的
  const svc3 = createLockService('/tmp/x', {
    port: () => 18790,
    rpcFor: () => async () => { throw Error('connection unavailable'); },
    probe: () => ({ state: 'held' }),
    targetsFor: () => ({
      managedPid: () => null,   // 我们那个服务不在（端口就算被占，也是桌面版占的）
      stop: async () => ({ ok: false, message: '端口还占着，说明是别的实例（比如桌面版），不该由我们关' })
    }),
    logger: () => { }
  });
  const r3 = await svc3.releasePhone('01a098d4-f36d-75e2-ab16-0cd6ffbdd72f', {});
  ok('我们那个服务根本没在跑时，如实报「手机这边没占着」= ok',
    r3.ok === true && r3.serverNotRunning === true, JSON.stringify(r3));

  // ★ 这条是实测踩出来的：服务没在跑时若直接调 stop()，它会回
  //   「Codex 远程服务没在运行」，按「停止成功」判据就变成 ok:false ——
  //   而那恰恰就是我们要的结果（手机这边本来就没占着）。
  {
    const c4 = [];
    const svc4 = createLockService('/tmp/x', {
      port: () => 18790,
      rpcFor: () => async (m) => { c4.push(m); return {}; },
      probe: () => ({ state: 'absent' }),
      targetsFor: () => ({
        managedPid: () => null,
        stop: async () => { c4.push('targets.stop'); return { ok: false, message: 'Codex 远程服务没在运行' }; }
      }),
      logger: () => { }
    });
    const r4 = await svc4.releasePhone('01a098d4-f36d-75e2-ab16-0cd6ffbdd72f', {});
    ok('默认路径根本不碰 stop()（服务留着，手机是热的）',
      r4.ok === true && !c4.includes('targets.stop'), JSON.stringify({ ok: r4.ok, calls: c4 }));
  }

  // HTTP 那一层：action=phone **不需要** confirm（它没有代价）
  const g = fs.readFileSync(path.join(BASE, 'scripts', 'codex-lock.js'), 'utf8');
  ok('action=phone 的分支排在 confirm 检查之前',
    g.indexOf("body.action === 'phone'") < g.indexOf("body.confirm !== true"));
  ok('导出里有 releasePhone', /return \{ release, releasePhone/.test(g));

  // 界面：第二个按钮真的在，而且文案说清「不碰电脑上的 Codex」
  const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
  ok('面板里有「释放手机端的锁」按钮', /id = 'lock-release-phone'|id: 'lock-release-phone'|'lock-release-phone'/.test(html));
  ok('调用的是 action=phone', /action: 'phone'/.test(html));
  ok('文案说清不会动电脑上的 Codex', /不会动电脑上的 Codex/.test(html));
}

console.log('\n紧急接管保留入口，但默认先显示安全的独立续聊\n');
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

    // 入口仍固定可见，但危险按钮不该挨着日常发送和语音。
    const iconRow = html.slice(html.indexOf('<div class="iconrow">'), html.indexOf('</div>', html.indexOf('<div class="iconrow">')));
    assert.ok(!iconRow.includes('id="btn-lock"'), '日常输入区不该有会关掉整个桌面端的快捷键');
    assert.ok(/btn-lock-help'\)\.onclick = openLockPanel/.test(html), '会话权限说明入口丢失');
    ok('危险按钮不在输入区；会话权限说明可直接打开面板');

    // ③ 面板本身：开着会话时给按钮，没开会话时说清为什么现在不能按
    const withThread = renderLockPanel(html, dict, { id: TID, name: '测试会话' });
    assert.equal(withThread.sheetOn, true, '面板没被打开');
    assert.ok(withThread.releaseBtn, '面板里没有释放按钮');
    assert.equal(withThread.releaseBtn.textContent, '关闭电脑 Codex 并接管原会话');
    assert.ok(withThread.advanced, '紧急按钮没有放进折叠区域');
    assert.ok(/btn d/.test(withThread.releaseBtn.className), '释放按钮没有用危险样式');
    assert.ok(withThread.advanced.children.some((x) => /关掉电脑上的 Codex/.test(x.textContent || x._html) && /电脑端任务会被终止/.test(x.textContent || x._html)),
      '面板里没写关闭桌面端和中断任务的风险');
    ok('面板里有折叠的紧急按钮（危险样式）和明确后果');

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

/** Tight isolated regression for the mobile-only release branch. */
async function phoneScopeRegression() {
  const other = '02a098d4-f36d-75e2-ab16-0cd6ffbdd72f';
  const make = (unsubFails, loaded) => {
    const calls = [];
    const s = createLockService(BASE, {
      port: () => 18790,
      rpcFor: () => async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/loaded/list') return { data: loaded };
        if (method === 'thread/unsubscribe' &&
          (typeof unsubFails === 'function' ? unsubFails(params.threadId) : unsubFails))
          throw Error('unsubscribe failed');
        return {};
      },
      targetsFor: () => ({
        managedPid: () => 4242,
        stop: async () => { calls.push({ method: 'targets.stop' }); return { ok: true }; },
        stopDesktop: async () => { calls.push({ method: 'targets.stopDesktop' }); return { ok: true }; }
      })
    });
    return { s, calls };
  };
  console.log('\n[phone scope] Targeted release must not touch other mobile sessions');
  {
    const h = make(false, [TID, other]);
    const r = await h.s.releasePhone(TID, {});
    const ids = h.calls.filter((c) => c.method === 'thread/unsubscribe').map((c) => c.params.threadId);
    if (r.ok && ids.length === 1 && ids[0] === TID && !h.calls.some((c) => c.method === 'targets.stop' || c.method === 'targets.stopDesktop'))
      ok('only requested thread is unsubscribed; no process is stopped');
    else fail('release touched other threads or process: ' + JSON.stringify({ ok: r.ok, ids, calls: h.calls.map((c) => c.method) }));
  }
  {
    const h = make(true, [TID, other]);
    const r = await h.s.releasePhone(TID, {});
    const ids = h.calls.filter((c) => c.method === 'thread/unsubscribe').map((c) => c.params.threadId);
    if (!r.ok && ids.length === 1 && ids[0] === TID) ok('failed unsubscribe is reported as failure without touching another thread');
    else fail('failed unsubscribe was reported as success or touched others: ' + JSON.stringify({ ok: r.ok, ids }));
  }
  console.log('\n[phone scope] No-thread automatic cleanup remains explicit and truthful');
  {
    const h = make(false, [TID, other]);
    const r = await h.s.releasePhone(null, {});
    const ids = h.calls.filter((c) => c.method === 'thread/unsubscribe').map((c) => c.params.threadId);
    if (r.ok && ids.length === 2 && ids.includes(TID) && ids.includes(other)) ok('no-thread cleanup releases all loaded phone threads');
    else fail('no-thread cleanup lost its all-loaded behavior: ' + JSON.stringify({ ok: r.ok, ids }));
  }
  {
    const h = make(false, []);
    const r = await h.s.releasePhone(null, {});
    if (!r.ok && !h.calls.some((c) => c.method === 'thread/unsubscribe')) ok('empty loaded list alone does not claim a release');
    else fail('empty loaded list falsely claims a release: ' + JSON.stringify({ ok: r.ok, calls: h.calls.map((c) => c.method) }));
  }
  {
    const h = make((id) => id === other, [TID, other]);
    const r = await h.s.releasePhone(null, {});
    if (!r.ok && r.released.length === 1 && r.releaseErrors.length === 1)
      ok('partial all-thread cleanup reports failure instead of claiming everything released');
    else fail('partial cleanup falsely claims success: ' + JSON.stringify({ ok: r.ok, released: r.released, errors: r.releaseErrors }));
  }
  {
    const h = make(false, [TID, other]);
    const r = await h.s.releasePhone('../../bad', {});
    if (!r.ok && r.code === 'bad-thread' && h.calls.length === 0) ok('invalid supplied ID cannot trigger all-thread cleanup');
    else fail('invalid supplied ID touched the server: ' + JSON.stringify({ code: r.code, calls: h.calls }));
  }
}

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
function renderLockPanel(html, dict, thread, opts) {
  const o = opts || {};
  const inner = conflictFakeEl('div');
  const sheet = conflictFakeEl('div');
  const texts = [];
  const calls = [], asked = [];
  const sandbox = {
    state: { thread: thread, resumed: false, view: thread ? 'thread' : 'list' },
    document: { createElement: conflictFakeEl, getElementById: () => null },
    $: (id) => (id === 'sheetInner' ? inner : sheet),
    tr: (s) => o.lang && o.lang !== 'zh' ? ((dict[s] && dict[s][o.lang]) || s) : s,
    esc: (s) => String(s == null ? '' : s),
    toast: () => { }, closeSheet: () => { }, openThread: () => { }, openSheet: () => { },
    askReleaseLock: (tid) => { calls.push(tid); },
    confirm: (s) => { asked.push(s); return !!o.confirm; },
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
  const advanced = inner.children.find((c) => c.className === 'lock-advanced') || null;
  const releaseBtn = advanced && advanced.children.find((c) => c.className === 'btn d') || null;
  return { inner, texts, advanced, releaseBtn, calls, asked, sheetOn: sheet.classList.contains('on') };
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
    openLockPanel: () => { }, forkCurrentThread: () => Promise.resolve(false),
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
