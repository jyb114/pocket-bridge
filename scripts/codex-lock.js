// 「释放电脑端的锁」—— 手机被 Codex 的独占写锁挡在门外时的那条出路。
//
// 背景（PLAN.md 十三/十四）：Codex 的**同一个会话同时只能有一个写入者**。
// 电脑桌面版开着某条会话时，它占着独占写锁，手机发消息就是
// `thread … already has an active writer`，界面上是一句「会话由另一个执行服务占用」。
//
// 锁的形态：`~/.codex/thread-writer-locks/<会话id>.lock`，0 字节的空文件 ——
// 真正的锁是**操作系统级的文件锁**，文件只是加锁的标的物。持锁的是**另一个
// app-server 进程**：电脑桌面版自己那个。它跟着界面进程 ChatGPT.exe 一起活，
// **没有监听任何端口**（实测：桌面版那个 codex.exe 只有出网连接，没有 LISTEN），
// 也就是说我们没法连上去跟它商量「你松开一下」。
//
// 所以「释放」只有两条路，而且必须按这个顺序试：
//   1. 锁是**我们自己**的 app-server 占的 → 一条 `thread/unsubscribe` 就还回去了，
//      不碰使用者电脑上的任何东西。
//   2. 锁是**电脑桌面版**占的 → 唯一能让它松开的办法是让那个进程结束。
//      这就是确认框里那句「电脑上正在跑的任务可能会被终止」的由来，
//      也是这一条**必须**由使用者点确认才做、服务端再收一道 `confirm` 的原因。
//
// 有一条**明确不做**的事：删锁文件。在 Windows 上，另一个进程持着锁的时候
// 删掉文件并不能让它的句柄失效 —— 只会让后来者在一个「新文件」上拿到锁，
// 于是**两个进程同时以为自己是唯一写入者**。那是在拿使用者的会话完整性赌，
// 比「解不开锁」严重得多。宁可如实报「放不开」，也不做这种偷锁的事。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCK_DIR = path.join(os.homedir(), '.codex', 'thread-writer-locks');

// 同一进程里反复探锁时，临时文件名不能撞（探锁一次写一个）
let probeSeq = 0;

// 会话 id 是形如 019fe0dd-83db-7881-affb-77f675c36bb9 的东西。
// 严格挡住路径分隔符和 `..`：这个值直接拼进文件名和 PowerShell 命令里。
const THREAD_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,79}$/;

function threadIdOk(id) {
  return typeof id === 'string' && THREAD_ID_RE.test(id) && !id.includes('..');
}

function lockPath(threadId) {
  return path.join(LOCK_DIR, `${threadId}.lock`);
}

/**
 * 这条会话的锁文件「有人在开」吗？
 *
 * ★★ 2026-09-24 实测推翻了它的用途，**不要再拿它当判据** ★★
 *
 *   释放写入锁的按钮曾无效果。查下来是这里：长命的 app-server
 *   进程会**一直开着**它用过的每个锁文件（哪怕早就 unsubscribe 了）——
 *   于是「独占打开失败」这件事只说明**某个 app-server 进程还活着**，
 *   不说明此刻有人在写。实测：目录里 16 个锁文件，包括两天前的，
 *   探针全报 held。
 *
 *   所以它现在只用来**记日志**（这个文件在不在、有没有被谁开着），
 *   判断「谁能拿到这条会话」一律走 `thread/resume` —— 那才是手机发消息时
 *   真正走的那条路，也才是权威判据。
 *
 * 判据本身（怎么探）仍然有效：试着自己独占打开它。
 * 返回 {state, detail}：free / absent / held / unknown。
 *
 * ★ 它是**同步**的（execFileSync）：一次探锁会占住事件循环几百毫秒。
 *   只在「使用者主动按了释放」这条路上跑，**不要**挂到每请求/定时的路径上。
 */
function probeLock(threadId, opts) {
  const file = lockPath(threadId);
  const spawn = (opts && opts.execFileSync) || execFileSync;

  if (process.platform !== 'win32') {
    // 不装：POSIX 上要 flock(2)，Node 没有暴露。与其半吊子，不如说不知道。
    return { state: 'unknown', detail: 'non-win32' };
  }

  // ★ 结果走**临时文件**，不走 stdout。
  //
  //   两个原因，第二个是实测撞出来的：
  //     1. PowerShell 的 stdout 编码跟着控制台代码页走，读到乱码就没法判断；
  //     2. **管道拿不到**的地方（受限的沙箱/服务环境）spawn 直接 EPERM ——
  //        而那正好是最需要它可靠的地方。stdio 全 ignore + 读文件没有这个问题。
  //   判据本身不变：独占打开（FileShare.None）打得开=没人持有。
  probeSeq += 1;
  const outFile = path.join(os.tmpdir(), `dsh-lock-probe-${process.pid}-${probeSeq}.txt`);
  const esc = (s) => String(s).replace(/'/g, "''");
  const ps = `$p='${esc(file)}';$o='${esc(outFile)}';`
    + `if(-not (Test-Path -LiteralPath $p)){[IO.File]::WriteAllText($o,'absent');exit};`
    + `try{$f=[System.IO.File]::Open($p,'Open','ReadWrite','None');$f.Close();`
    + `[IO.File]::WriteAllText($o,'free')}catch{[IO.File]::WriteAllText($o,'held')}`;

  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', timeout: 8000, windowsHide: true });
    const out = String(fs.readFileSync(outFile, 'utf8') || '').trim();
    if (out === 'free') return { state: 'free', detail: 'exclusive-open-ok' };
    if (out === 'absent') return { state: 'absent', detail: 'no-lock-file' };
    if (out === 'held') return { state: 'held', detail: 'sharing-violation' };
    return { state: 'unknown', detail: `探针输出看不懂: ${out.slice(0, 60)}` };
  } catch (err) {
    return { state: 'unknown', detail: err.message };
  } finally {
    try { fs.unlinkSync(outFile); } catch (err) { /* 没写成就算了 */ }
  }
}

/**
 * 我们自己那个 app-server 是不是还攥着这条会话。
 *
 * 只发 `thread/unsubscribe` —— 不 resume。resume 是「我要写」的意思，
 * 那会**反过来**占上锁，跟这个按钮要干的事正好相反。
 */
async function unsubscribeOwn(threadId, rpc) {
  return rpc('thread/unsubscribe', { threadId });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 释放编排。deps 全部可注入 —— 测试里除了「关桌面版」这一步，
 * 其余都能用假的跑（那一步会真的关掉使用者桌面上的程序，见 test-guard）。
 *
 * `base` 目前没用到（锁在 ~/.codex 下，不在工作区里），保留是为了和
 * createQueueService(base, …) 同一个签名 —— 网关那边两条通道的构造写法一致，
 * 读代码的人不用在两处之间切脑子。
 */
function createLockService(base, deps) {
  const {
    port = () => 18790,
    rpcFor = (p) => require('./codex-queue.js').createRpc(p),
    probe = probeLock,
    targetsFor = () => require('./targets.js').get('codex'),
    logger = () => { },
    waitMs = 1000,
    waitTries = 15
  } = deps || {};

  /**
   * 干这件事本身。返回的对象是**如实**的：
   *   ok + method  成功了，走的是哪条路
   *   !ok + code   没成功，卡在哪一步（客户端按 code 出人话）
   *
   * ★ 没有 `confirm:true` 就**什么都不做** —— 连探锁都不探。这一条不放在
   *   HTTP 那一层，而是放在这里：将来无论谁调用它（界面、控制台、脚本），
   *   都绕不过「关掉电脑上正在跑的任务」这件事必须有人明确点过头。
   */
  async function release(threadId, opts) {
    const lang = (opts && opts.lang) || 'zh';
    const log = (opts && opts.log) || (() => { });
    const out = { ok: false, threadId, method: null, code: null, lockFile: null };

    if (opts && opts.confirm !== true) {
      out.code = 'no-confirm';
      return out;
    }
    if (!threadIdOk(threadId)) {
      out.code = 'bad-thread';
      return out;
    }

    // 锁文件状态只进日志：它回答的是「有没有 app-server 碰过这条会话」，
    // **不是**「此刻谁在写」（见 probeLock 上面那段实测说明）。
    try {
      const p = probe(threadId);
      out.lockFile = p.state;
      log(`释放锁：${threadId} 锁文件=${p.state}（${p.detail}）`);
    } catch (err) { /* 探不了不影响判断 */ }

    const rpc = rpcFor(port);
    const seen = opts && opts.seenError ? ` 手机看到的错误="${String(opts.seenError).slice(0, 120)}"` : '';
    log(`释放锁：开始问 app-server 能不能拿到 ${threadId}${seen}`);

    // ── ① 权威判据：**试着把这条会话拿过来** ──────────────────────────────────
    //
    //   和手机发消息时走的是同一条路，所以它的答案就是使用者真正遇到的那件事：
    //     拿到了   → 现在没人挡着（要挡也是我们自己挡的）→ 立刻还回去
    //     active writer → 另一个进程占着（就是电脑上那个 Codex）→ 才轮到关它
    //     超时/别的错 → **如实说不知道**，绝不去关使用者的程序
    //
    //   原来用的判据是「锁文件能不能独占打开」，实测发现它恒等于「有个 app-server
    //   还活着」——于是永远得出「锁本来就是空的」，按钮看起来毫无效果。
    const first = await tryTake(threadId, rpc);
    if (first.ok) {
      const gave = await giveBack(threadId, rpc);
      out.ok = true;
      out.method = 'app-server';
      out.gaveBack = gave;
      log(`释放锁：${threadId} 现在拿得到（占着它的不是别人）→ 立刻还回去，结果=${gave}`);
      return out;
    }
    if (!/active writer/i.test(first.error || '')) {
      out.code = 'unclear';
      out.error = first.error || '';
      log(`释放锁：${threadId} 拿不到，但也不是「被另一个进程占着」：${out.error}`);
      return out;
    }
    log(`释放锁：${threadId} 确实被**另一个进程**占着（active writer）`);

    // ── ② 那就只剩「让电脑桌面版松手」这一条 ─────────────────────────────────
    const t = targetsFor();
    let st = { running: false, count: 0 };
    try { st = (t && t.desktopStatus && t.desktopStatus()) || st; } catch (err) { /* 查不到就当没开 */ }

    if (!st.running) {
      out.code = 'not-desktop';
      return out;
    }

    let stopped = null;
    try {
      stopped = await t.stopDesktop(lang);
    } catch (err) {
      out.code = 'stop-failed';
      out.stopError = err.message;
      return out;
    }
    out.desktopStopped = !!(stopped && stopped.ok);
    out.desktopMessage = (stopped && stopped.message) || '';

    // ── ③ 验证：再用**同一个判据**问一次 —— 进程没了不等于锁立刻没了 ──────────
    for (let i = 0; i < waitTries; i++) {
      await sleep(waitMs);
      const again = await tryTake(threadId, rpc);
      if (again.ok) {
        const gave = await giveBack(threadId, rpc);
        out.ok = true;
        out.method = 'desktop-closed';
        out.gaveBack = gave;
        log(`释放锁：关掉桌面版之后拿到 ${threadId} 了 → 还回去，结果=${gave}`);
        return out;
      }
    }

    out.code = out.desktopStopped ? 'still-locked' : 'stop-failed';
    return out;
  }

  /**
   * 试着把这条会话拿过来（= 手机发消息时做的第一件事）。
   *
   * 成功之后**必须**还回去：拿过来就等于占了写锁，而我们的目的只是问一句
   * 「现在能不能拿到」。不还回去的话，这个按钮会把电脑挡住 —— 正好是它的反面。
   */
  async function tryTake(threadId, rpc) {
    try {
      await rpc('thread/resume', { threadId, excludeTurns: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  /** 还回去（尽力而为：失败也不影响结论，但要记下来） */
  async function giveBack(threadId, rpc) {
    try {
      await unsubscribeOwn(threadId, rpc);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * HTTP 处理器：`POST /codex/lock`，body `{threadId, confirm:true}`。
   *
   * 两道保险，和队列那条同一套写法：
   *   · `x-dsh-lock: 1` —— 跨站表单发不出自定义头，挡掉「别的网页替你点一下」
   *   · Origin 必须同源
   * 再加上 `confirm` 必须是 true：**没有确认就不动手**。这不是形式 ——
   * 少了它，一个手滑的 GET/POST 就能把使用者在电脑上跑着的任务打断。
   */
  function handle(req, res) {
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST') { json(405, { error: '只接受 POST' }); return; }
    if (req.headers['x-dsh-lock'] !== '1') { json(403, { error: '无效请求' }); return; }
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) throw Error(); }
      catch (err) { json(403, { error: '来源不匹配' }); return; }
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(c);
    });
    req.on('end', async () => {
      if (tooLarge) { json(413, { error: '请求过大' }); return; }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch (err) { json(400, { error: '请求不是 JSON' }); return; }

      if (!threadIdOk(body.threadId)) { json(400, { error: '无效会话' }); return; }
      if (body.confirm !== true) { json(400, { error: '需要确认', code: 'no-confirm' }); return; }

      let out;
      try {
        // confirm 在这里再显式传一次：release() 自己也把关（见它的注释），
        // 两道门都过才动手。seenError 是手机那边看到的原始错误 —— 只进日志，
        // 用来回答「下次再出现时到底是谁占着」（这次就是靠这类线索才查出
        // 原来那个判据是坏的）。
        out = await release(body.threadId, {
          confirm: true, lang: body.lang, log: logger, seenError: body.seenError
        });
      } catch (err) {
        json(500, { error: `释放失败：${err.message}` });
        return;
      }
      json(out.ok ? 200 : 409, out);
    });
  }

  return { release, handle, probe: (id) => probe(id) };
}

module.exports = {
  createLockService, probeLock, lockPath, threadIdOk, unsubscribeOwn,
  LOCK_DIR
};
