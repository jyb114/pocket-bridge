// 「释放电脑端的锁」的测试。
//
// 当前协议不能验证另一个 writer 的 PID，因此紧急接管必须 fail closed。
// 独立回归执行真实编排和 HTTP 入口；不终止任何本机进程。
//
//   1. 没有 confirm:true         → 什么都不做（连探锁都不探）
//   2. 我们自己能松开            → 绝不去关桌面版
//   3. 一开始就没人占着          → 绝不因为「探针看起来占着」就关
//   4. 其他 writer 占用         → 桌面是否开着都不能授权全局终止
//   5. /codex/lock 少了那道自定义头、或者来源不同 → 403
//
// 假目标记录任何桌面扫描/终止尝试；这些尝试本身就应使回归失败。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const { createLockService, probeLock, lockPath, threadIdOk, desktopTakeoverDenied } = require('./codex-lock.js');
const { extractRegisterArg, extractFunction } = require('./page-source.js');

const TID = '019fe0dd-83db-7881-affb-77f675c36bb9';
let bad = 0;
const ok = (msg, condition = true, details) => {
  if (condition) console.log(`  ✓ ${msg}`);
  else { bad++; console.log(`  ✗ ${msg}${details ? ': ' + details : ''}`); }
};
const fail = (msg) => { bad++; console.log(`  ✗ ${msg}`); };

/** 假的目标对象：记下谁调过 stopDesktop，但一个进程都不碰 */
function fakeTargets(opts) {
  const o = opts || {};
  const calls = { stopped: 0, scanned: 0 };
  return {
    calls,
    t: {
      desktopStatus: () => { calls.scanned++; return { running: !!o.desktopRunning, count: o.desktopRunning ? 3 : 0 }; },
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
    const absentOpts = await s.release(TID);
    assert.equal(absentOpts.code, 'no-confirm');
    assert.deepEqual(rpc.calls, [], '省略 opts 也不得绕过确认');
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

  // ④ 其他执行端占用 + 电脑桌面在跑，不能推断桌面就是 writer。
  {
    const t = fakeTargets({ desktopRunning: true, stopOk: true });
    const rpc = fakeRpc(() => ({ error: WRITER_ERR }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'owner-unverified');
    assert.equal(r.desktopStopped, false);
    assert.deepEqual(r.suggestions, ['fork', 'wait']);
    assert.deepEqual(t.calls, { stopped: 0, scanned: 0 });
    assert.deepEqual(rpc.calls.map(c => c.method), ['thread/resume']);
    ok('独立 writer 与桌面同时存在：拒绝全局关闭，不扫描无关桌面');
  }

  // ⑤ 被占着，但桌面版没开 → 如实报，不硬来也不假装成功
  {
    const t = fakeTargets({ desktopRunning: false });
    const rpc = fakeRpc(() => ({ error: WRITER_ERR }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'owner-unverified');
    assert.equal(t.calls.stopped, 0);
    ok('未验证 writer owner：桌面状态不能成为终止进程的判据');
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

  // ⑦ Even a target advertising successful closure cannot authorize a stop.
  {
    const t = fakeTargets({ desktopRunning: true, stopOk: true });
    const rpc = fakeRpc(() => ({ error: WRITER_ERR }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'owner-unverified');
    assert.equal(t.calls.stopped, 0);
    ok('目标宣称可关闭成功也不能绕过未验证 owner 的拒绝');
  }

  // ⑧ Failure-capable targets are likewise never invoked.
  {
    const t = fakeTargets({ desktopRunning: true, stopOk: false });
    const rpc = fakeRpc(() => ({ error: WRITER_ERR }));
    const s = svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn });
    const r = await s.release(TID, { confirm: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'owner-unverified');
    assert.equal(t.calls.stopped, 0);
    ok('未知 owner 不调用任何关闭实现');
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

  console.log('\n旧目标控制入口也不能全局关闭桌面\n');
  {
    const child = require('child_process');
    const saved = { execFileSync: child.execFileSync, execSync: child.execSync, spawn: child.spawn, kill: process.kill };
    const actions = [];
    const trap = (...args) => { actions.push(args); throw Error('process action is forbidden in this regression'); };
    const targetFile = require.resolve('./targets.js');
    const priorModule = require.cache[targetFile];
    try {
      child.execFileSync = child.execSync = child.spawn = trap;
      process.kill = trap;
      delete require.cache[targetFile];
      const target = require('./targets.js').codex;
      assert.equal((await target.stopDesktop('en')).code, 'no-confirm');
      assert.equal((await target.stopDesktop('en', { confirm: true })).code, 'bad-thread');
      const denied = await target.stopDesktop('en', { confirm: true, threadId: TID, pid: 16156, ownerVerified: true });
      assert.equal(denied.code, 'owner-unverified', '客户端提供的 PID/ownerVerified 不能成为可信 owner 证据');
      assert.equal(denied.desktopStopped, false);
      assert.equal(target.desktopStatus().canStop, false);
      assert.deepEqual(actions, []);
      ok('真实 target.stopDesktop：无确认、缺会话、伪造 PID 均不执行进程操作');
    } finally {
      Object.assign(child, { execFileSync: saved.execFileSync, execSync: saved.execSync, spawn: saved.spawn });
      process.kill = saved.kill;
      delete require.cache[targetFile];
      if (priorModule) require.cache[targetFile] = priorModule;
    }
    for (const lang of ['zh', 'en', 'es']) {
      const denial = desktopTakeoverDenied(TID, { confirm: true, lang });
      assert.equal(denial.code, 'owner-unverified');
      assert.ok(denial.message.length > 30);
      assert.ok(denial.error === denial.message);
      assert.deepEqual(denial.suggestions, ['fork', 'wait']);
    }
    const proxySource = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
    const proxyAction = extractFunction(proxySource, 'requestCodexDesktopTakeover');
    assert.ok(proxyAction);
    const rpc = fakeRpc(() => ({ error: WRITER_ERR }));
    const t = fakeTargets({ desktopRunning: true });
    const box = { codexLock: svc({ targetsFor: () => t.t, rpcFor: () => rpc.fn }), log() {} };
    vm.createContext(box);
    vm.runInContext(proxyAction, box);
    assert.equal((await box.requestCodexDesktopTakeover({ threadId: TID }, 'en')).code, 'no-confirm');
    assert.deepEqual(rpc.calls, []);
    const denied = await box.requestCodexDesktopTakeover({ threadId: TID, confirm: true, pid: 16156 }, 'en');
    assert.equal(denied.code, 'owner-unverified');
    assert.deepEqual(t.calls, { stopped: 0, scanned: 0 });
    assert.ok(proxySource.includes("body.action === 'stop-desktop' && t.id === 'codex') result = await requestCodexDesktopTakeover(body, tLang)"));
    assert.ok(!proxySource.includes('result = await t.stopDesktop(tLang)'));
    ok('stop-desktop实际入口：无confirm不发RPC，其他writer拒绝终止并提供多语言建议');
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
    assert.equal(lockPath(id), path.join(process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex'), 'thread-writer-locks', `${id}.lock`));
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

  console.log('\nMobile session control must never offer an unverifiable desktop shutdown\n');
  {
    const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
    assert.ok(!extractFunction(html, 'releaseDesktopLock'), 'Remove the obsolete desktop-close handler');
    assert.ok(!extractFunction(html, 'askReleaseLock'), 'Remove the obsolete desktop-close request');
    assert.ok(!html.includes('var LOCK_RESULT_TEXT'), 'Remove obsolete desktop-closed result claims');
    assert.ok(!/action:\s*['"]stop-desktop['"]/.test(html), 'Mobile UI must not invoke global shutdown');
    const dictSrc = extractRegisterArg(html);
    assert.ok(dictSrc);
    const dict = vm.runInNewContext('(' + dictSrc + ')', {});
    const trs = [...html.matchAll(/tr\('([^']{4,})'\)/g)].map(m => m[1]).filter(s => /[\u4e00-\u9fff]/.test(s));
    const missing = [...new Set(trs)].filter(raw => {
      let key = raw;
      try { key = vm.runInNewContext("('" + raw + "')", {}); } catch (_) { }
      return !dict[key];
    });
    assert.deepEqual(missing, [], 'New mobile control instructions require translations');
    ok('Obsolete desktop-close handlers and unsupported result claims are absent');

    for (const lang of ['zh', 'en', 'es']) {
      const card = renderConflictCard(html, dict, lang);
      const labels = ['复制上下文，在手机独立续聊', '同项目新会话（不复制对话）', '继续查看', '查看会话控制'].map(key => lang === 'zh' ? key : dict[key][lang]);
      assert.deepEqual(card.buttons.map(b => b.text), labels);
      card.click(2);
      card.click(3);
      assert.deepEqual(card.calls, [], 'Viewing or opening control cannot release locks or close processes');
      assert.deepEqual(card.asked, [], 'No native dialogs in session control');
    }
    ok('Writer conflicts offer an independent copy, a new thread, and read-only viewing in all languages');
    await verifyPhoneReleasePanel(html, dict);
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
  ok('WS 关闭时挂上 detached', /socket\.once\('close', codexPhoneDetached\)/.test(proxy));

  const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
  ok('不在 pagehide 中把明文会话编号伪标成加密请求',
    !/addEventListener\('pagehide'[\s\S]{0,500}fetch\('\/codex\/lock'/.test(html));
  ok('自动交还由服务端断线宽限处理，不依赖页面结束时的网络请求',
    /codexPhoneDetached\(\)/.test(proxy) && /CODEX_RELEASE_GRACE_MS = 60 \* 1000/.test(proxy));
}

console.log('\nPhone control explains the limits of unsubscribe truthfully\n');
{
  const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
  const panel = extractFunction(html, 'openLockPanel');
  const releasePanel = extractFunction(html, 'openPhoneReleasePanel');
  ok('Control panel explains one writer per thread', /同一条会话同时只能有一个地方发送/.test(panel));
  ok('Phone handoff does not claim immediate computer access', /电脑能否接手需要实际确认/.test(releasePanel));
  ok('Running tasks cannot be handed back from the inline control', /confirmButton\.disabled=state\.running/.test(releasePanel));
  ok('Unknown desktop owner is explained without a shutdown action', /当前无法验证占用者/.test(panel));
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
  ok('请求完成不冒充writer已释放', r.ok === true && r.writerReleaseVerified === false && r.writerReleased === null, JSON.stringify(r));
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

  // No managed PID is not evidence that an independently started backend is idle.
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
  ok('外部backend连不上时如实报失败，不从缺PID推断手机未占锁',
    r3.ok === false && r3.serverNotRunning === true && r3.handoffStatus === 'failed', JSON.stringify(r3));

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
  ok('手机确认在实际手机连接上取消订阅', /call\('thread\/unsubscribe',\{threadId:tid\}/.test(extractFunction(html, 'askReleasePhone')));
  ok('文案说清不关闭电脑 Codex', /不关闭电脑 Codex/.test(html));
}

console.log('\nSession control remains discoverable without destructive desktop actions\n');
  {
    const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
    const dict = vm.runInNewContext('(' + extractRegisterArg(html) + ')', {});
    const sheetSrc = extractFunction(html, 'openSheet');
    assert.ok(sheetSrc && /openLockPanel\(\)/.test(sheetSrc));
    const hintSrc = extractFunction(html, 'updateLockHint');
    assert.ok(hintSrc && /openLockPanel\(\)/.test(hintSrc));
    assert.ok(/btn-lock-help'\)\.onclick = openLockPanel/.test(html));
    for (const resumed of [false, true]) {
      const rendered = renderLockPanel(html, dict, { id: TID, name: 'Test session' }, { resumed });
      assert.equal(rendered.sheetOn, true);
      assert.equal(rendered.releaseBtn, null, 'No desktop-stop button may be rendered');
      assert.ok(rendered.phoneReleaseBtn);
      assert.equal(rendered.phoneReleaseBtn.style.display, resumed ? '' : 'none');
      assert.ok(rendered.texts.some(text => /当前无法验证占用者/.test(text)));
    }
    for (const lang of ['zh', 'en', 'es']) {
      const translated = key => lang === 'zh' ? key : dict[key][lang];
      const mode = renderLockPanel(html, dict, { id: TID, name: 'Test session' }, { desktopRelayEnabled: true, resumed: false, lang });
      assert.equal(mode.sheetOn, true);
      assert.equal(mode.releaseBtn, null);
      assert.equal(mode.phoneReleaseBtn.style.display, 'none');
      assert.ok(!mode.inner.children.some(child => child.id === 'lock-connect-current' || child.className === 'btn p'),
        'Desktop relay must not offer inactive independent-writer controls');
      assert.ok(mode.texts.includes(translated('通过电脑代发文字，不接管会话锁。桥的历史同步不能确认电脑任务是否正在执行。')));
      assert.ok(mode.texts.includes(translated('当前使用电脑代发文字，手机不接管会话锁。电脑端的授权、选择和提问仍需在电脑处理；此模式暂不支持附件。')));
      assert.ok(!mode.texts.includes(translated('当前无法验证占用者，不能从手机关闭桌面 Codex。请在电脑结束原任务，或复制上下文独立续聊。')));
      assert.deepEqual(mode.calls, [], 'Opening a relay control panel cannot mutate subscriptions or send text');
      const subscribed = renderLockPanel(html, dict, { id: TID, name: 'Test session' }, { desktopRelayEnabled: true, resumed: true, lang });
      assert.equal(subscribed.phoneReleaseBtn.style.display, '', 'An existing phone subscription still needs an explicit handback action');
      const normal = renderLockPanel(html, dict, { id: TID, name: 'Test session' }, { desktopRelayEnabled: false, resumed: false, lang });
      assert.ok(normal.inner.children.some(child => child.id === 'lock-connect-current'));
      assert.ok(normal.inner.children.some(child => child.className === 'btn p'));
      assert.deepEqual(normal.calls, []);
    }
    ok('Desktop relay controls disclose uncertain execution, hide inactive writer actions, and restore normal controls in all languages');
    const noThread = renderLockPanel(html, dict, null);
    assert.equal(noThread.phoneReleaseBtn, null);
    assert.ok(noThread.texts.some(text => /先打开一条会话/.test(text)));
    ok('Settings, title status, and input help reach the safe control panel');
  }
  await phoneScopeRegression();

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
    assert.equal(r.writerReleaseVerified, false);
    assert.equal(r.writerReleased, null);
    assert.equal(r.handoffStatus, 'requested');
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
  {
    const calls = [];
    const s = createLockService(BASE, {
      rpcFor: () => async method => { calls.push(method); throw Error('connection unavailable'); },
      targetsFor: () => ({ managedPid: () => null })
    });
    const r = await s.releasePhone(TID, {});
    assert.equal(r.ok, false, '未记录托管PID不能把外部backend的RPC失败变成释放成功');
    assert.equal(r.handoffStatus, 'failed');
    assert.equal(r.writerReleaseVerified, false);
    assert.deepEqual(calls, ['thread/unsubscribe']);
    ok('unmanaged backend RPC failure remains a failure');
  }
  {
    for (const status of ['unsubscribed', 'notSubscribed', 'notLoaded']) {
      const s = createLockService(BASE, {
        rpcFor: () => async () => ({ status }),
        targetsFor: () => ({ managedPid: () => null })
      });
      const r = await s.releasePhone(TID, {});
      assert.equal(r.ok, true, '请求正常处理可报告，但不能称writer已释放');
      assert.equal(r.subscriptionStatus, status);
      assert.equal(r.unsubscribed, status === 'unsubscribed');
      assert.equal(r.writerReleased, null);
      assert.equal(r.writerReleaseVerified, false);
      assert.equal(r.handoffStatus, 'requested');
    }
    ok('modern unsubscribe results preserve subscription status without claiming a writer handoff');
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
    const r = await h.s.releasePhone(null, {
      shouldCancel: () => h.calls.some(call => call.method === 'thread/unsubscribe')
    });
    assert.equal(r.ok, false, 'A new phone cancels the batch; one completed unsubscribe is not a full cleanup');
    assert.equal(r.cancelled, true);
    assert.deepEqual(h.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), [TID]);
    ok('cancelled automatic cleanup does not claim the full handback completed');
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
// 只有把实际冲突卡片和交还确认的处理函数跑一遍才看得见。
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
    state: { thread, ready: o.ready !== false, resumed: !!o.resumed, running: false, view: thread ? 'thread' : 'list' },
    desktopRelayEnabled: !!o.desktopRelayEnabled,
    document: { createElement: conflictFakeEl, getElementById: () => null },
    $: (id) => (id === 'sheetInner' ? inner : sheet),
    tr: (s) => o.lang && o.lang !== 'zh' ? ((dict[s] && dict[s][o.lang]) || s) : s,
    esc: (s) => String(s == null ? '' : s),
    toast: () => { }, closeSheet: () => { }, openThread: () => { }, openSheet: () => { },
    forkCurrentThread: () => { calls.push('fork'); return Promise.resolve(false); },
    connectCurrentThread: () => { calls.push('connect'); return Promise.resolve(false); },
    openPhoneReleasePanel: () => { calls.push('phone-release'); },
    confirm: (s) => { asked.push(s); throw Error('Native confirm is not permitted'); },
    console
  };
  sandbox.t = sandbox.tr;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(['displayThreadTitle', 'sessionControlHint', 'openLockPanel'].map(name => extractFunction(html, name)).join('\n'), sandbox, { filename: 'openLockPanel' });
  sandbox.openLockPanel();

  // 面板上的文字：.info 的 textContent + 按钮上的字
  for (const c of inner.children) {
    if (c.className === 'info' || c.className === 'shead') texts.push(c.textContent);
    if (c.className === 'btn d') texts.push(c.textContent);
  }
  const advanced = inner.children.find((c) => c.className === 'lock-advanced') || null;
  const releaseBtn = advanced && advanced.children.find((c) => c.className === 'btn d') || null;
  const phoneReleaseBtn = inner.children.find(c => c.id === 'lock-release-phone') || null;
  return { inner, texts, advanced, releaseBtn, phoneReleaseBtn, calls, asked, sheetOn: sheet.classList.contains('on') };
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
    confirm: (text) => { asked.push(text); throw Error('Native confirm is not permitted'); },
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
  vm.runInContext(extractFunction(html, 'showWriterConflict'), sandbox, { filename: 'writer-conflict' });

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

/** Exercise the actual inline confirmation and request handler, without native dialogs. */
async function verifyPhoneReleasePanel(html, dict) {
  const make = (lang, reply, running = false) => {
    const inner = conflictFakeEl('div'), sheet = conflictFakeEl('div'), requests = [], taskUpdates = [], closes = [];
    const thread = { id: TID, cwd: 'D:\\mobile-test', name: 'Test session' };
    const ws = { readyState: 1, close: (...args) => closes.push(args) };
    const sandbox = {
      state: { thread, ws, ready: true, resumed: true, running, awaitingFirstTurn: false, releaseTimer: null,
        pending: {}, approvals: {}, sending: false, resuming: false, forking: null },
      queueEntries: [], queueDraft: null, detachedHandbacks: {}, resumeSubscription: null,
      document: { createElement: conflictFakeEl },
      $: id => id === 'sheetInner' ? inner : sheet,
      tr: key => lang === 'zh' ? key : dict[key] && dict[key][lang] || key,
      confirm: () => { throw Error('Native confirm is forbidden'); },
      privateFetch: () => { throw Error('A separate HTTP connection cannot unsubscribe the phone writer'); },
      call: async (method, params) => {
        requests.push({ method, params });
        if (method === 'thread/loaded/list') return { data: [TID], nextCursor: null };
        if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'idle' } } };
        if (method === 'thread/unsubscribe') {
          if (!reply.ok) throw Error(reply.error || 'unsubscribe failed');
          return { status: reply.subscriptionStatus };
        }
        throw Error('Unexpected mutation: ' + method);
      },
      openLockPanel() {}, closeSheet() {}, newThread() {}, forkCurrentThread() {},
      clearTimeout() {}, renderFooter() {}, scheduleRelease() {},
      statusKind: status => status && status.type,
      setTask: (...args) => taskUpdates.push(args), console
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(['displayThreadTitle', 'phoneHandbackIssue', 'verifyPhoneHandbackIdle', 'openPhoneReleasePanel', 'askReleasePhone']
      .map(name => extractFunction(html, name)).join('\n'), sandbox);
    sandbox.openPhoneReleasePanel(thread);
    return { sandbox, inner, requests, taskUpdates, closes, confirmButton: inner.children.find(child => child.id === 'phone-release-confirm') };
  };
  for (const lang of ['zh', 'en', 'es']) {
    for (const subscriptionStatus of ['unsubscribed', 'notSubscribed', 'notLoaded']) {
      const h = make(lang, { ok: true, subscriptionStatus, writerReleaseVerified: false, writerReleased: null });
      assert.ok(h.confirmButton, 'Inline confirmation must be present');
      assert.deepEqual(h.requests, [], 'Opening the review does not send a request');
      h.inner.children.find(child => child.className === 'sclose').onclick();
      assert.deepEqual(h.requests, [], 'Cancel never unsubscribes');
      h.confirmButton.onclick();
      await new Promise(resolve => setImmediate(resolve));
      const unsubscriptions = h.requests.filter(request => request.method === 'thread/unsubscribe');
      assert.equal(unsubscriptions.length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(unsubscriptions[0].params)), { threadId: TID });
      assert.ok(h.requests.every(request => ['thread/unsubscribe', 'thread/read', 'thread/loaded/list'].includes(request.method)));
      assert.deepEqual(h.closes, [[1000, 'phone-handoff']], 'Only the captured phone socket is closed');
      assert.equal(h.sandbox.state.resumed, false);
      assert.equal(h.sandbox.state.handoffPaused, true, 'Explicit handoff must not reconnect automatically');
      assert.equal(h.sandbox.state.handedBackThreads[TID], true);
      assert.ok(h.taskUpdates.length >= 1);
      assert.ok(h.taskUpdates[0][1].length > 30, 'Writer handoff stays visibly unverified');
      const expectedKey = '已请求断开手机控制连接，实时更新已暂停；电脑能否接手仍待实际确认。Codex 可能还要约一分钟才释放空闲会话，请稍后在电脑重试。需要时请明确恢复手机连接。';
      const expected = lang === 'zh' ? expectedKey : dict[expectedKey][lang];
      assert.equal(h.inner.children.find(child => child.id === 'phone-release-result').textContent, expected);
    }
  }
  const busy = make('en', { ok: true, subscriptionStatus: 'unsubscribed' }, true);
  assert.equal(busy.confirmButton.disabled, true);
  busy.confirmButton.onclick();
  assert.deepEqual(busy.requests, [], 'A running task cannot be handed back by clicking the inline button');
  assert.deepEqual(busy.closes, []);
  const failed = make('en', { ok: false, error: 'unsubscribe failed' });
  failed.confirmButton.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.sandbox.state.resumed, true, 'A failed request cannot claim control was returned');
  assert.equal(failed.confirmButton.disabled, false, 'Failed request remains retryable');
  assert.equal(failed.taskUpdates.length, 0);
  assert.deepEqual(failed.closes, []);
  const unknown = make('en', { ok: true, subscriptionStatus: 'unsupported-status' });
  unknown.confirmButton.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unknown.sandbox.state.resumed, true, 'Unknown protocol response cannot claim cancellation');
  assert.equal(unknown.confirmButton.disabled, false);
  assert.equal(unknown.taskUpdates.length, 0);
  assert.deepEqual(unknown.closes, []);
  ok('Inline phone handoff: cancel and running tasks do nothing; results retain uncertain writer status in all languages');
}
