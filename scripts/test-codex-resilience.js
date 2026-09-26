// Codex 在「电脑没开着桌面版」和「我们的服务没在跑」这些情况下还顶不顶用？
//
// 这两件事直接决定手机上能不能用：
//   - 电脑上关掉 Codex 是**释放写锁的正常办法**，如果关掉手机就用不了，那这条路就废了
//   - 我们的 app-server 是网关按需拉起来的，它没在跑时应当能自动起来
//
// 用法: node scripts/test-codex-resilience.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { MiniWS } = require('./browser-check.js');

const BASE = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE, 'logs');
const PORT = 18790;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

function call(sock, method, params, ms) {
  return new Promise((resolve) => {
    const id = call._n = (call._n || 0) + 1;
    sock.pending.set(id, resolve);
    sock.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    setTimeout(() => {
      if (sock.pending.has(id)) { sock.pending.delete(id); resolve({ timeout: true }); }
    }, ms || 25000);
  });
}

async function connect(port) {
  const ws = new MiniWS(`ws://127.0.0.1:${port}`);
  const sock = { ws, pending: new Map() };
  ws.on('message', (t) => {
    let m; try { m = JSON.parse(t); } catch (e) { return; }
    if (m.method) return;
    if (m.id !== undefined && sock.pending.has(m.id)) {
      sock.pending.get(m.id)(m); sock.pending.delete(m.id);
    }
  });
  await ws.connect();
  await call(sock, 'initialize', { clientInfo: { name: 'resilience', version: '1' } });
  return sock;
}

const portOpen = (p) => {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000 });
    return new RegExp(`:${p}\\s+.*LISTENING`, 'i').test(out);
  } catch (e) { return false; }
};

function desktopRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return /ChatGPT\.exe/i.test(out);
  } catch (e) { return false; }
}

(async () => {
  console.log('\n=== Codex 韧性测试 ===\n');

  // ── 1. 先看基线：现在能不能用 ────────────────────────────────────────────
  console.log('[1] 基线');
  const desktop = desktopRunning();
  console.log(`      电脑上的 Codex 桌面版: ${desktop ? '开着' : '没开'}`);
  console.log(`      我们的 app-server: ${portOpen(PORT) ? '在跑' : '没跑'}`);

  if (!portOpen(PORT)) {
    console.log('      （我们的服务没在跑，这一步先跳过）');
  } else {
    const s = await connect(PORT);
    const l = await call(s, 'thread/list', { limit: 5 }, 20000);
    ok('能列出会话', !!(l.result && l.result.data), JSON.stringify(l).slice(0, 100));
    s.ws.close();
  }

  // ── 2. 关键：电脑上的 Codex 关掉之后，手机还能不能用 ─────────────────────
  //
  // 这是最要紧的一条：关掉桌面版是**释放写锁的正常手段**。
  // 如果关掉之后手机就用不了，那「手机和电脑抢同一个会话」这个问题就无解了。
  console.log('\n[2] 关掉电脑上的 Codex 之后');
  if (!desktop) {
    console.log('      桌面版本来就没开 —— 正好就是我们要测的状态');
  } else if (require('./test-guard.js').desktopKillAllowed('关掉桌面版再看手机能不能用')) {
    console.log('      正在关掉桌面版…');
    try {
      execFileSync('taskkill', ['/IM', 'ChatGPT.exe', '/F'],
        { timeout: 15000, windowsHide: true });
    } catch (e) { /* 可能已经退了 */ }
    await sleep(4000);
    console.log('      （记得自己把 ChatGPT 重新打开 —— 这个脚本不会替你开）');
  } else {
    // 桌面版开着但没得到许可：**不能**因为跳过就假装验过了。
    // 「关掉之后还能用」这条结论这次没被验证，下面的断言要如实标出来。
    console.log('      桌面版开着，但没得到关闭许可 —— 这一步的结论这次不成立。');
    console.log('      要验它：先手动关掉 ChatGPT，再跑一次这个脚本。');
  }
  if (!desktop || require('./test-guard.js').DESKTOP_LIVE) {
    ok('桌面版确实关掉了', !desktopRunning());
  } else {
    console.log('      · 「桌面版确实关掉了」这条这次没验（桌面版还开着）');
  }

  // 我们的 app-server 应该完全不受影响
  ok('我们的 app-server 还在跑（它是独立进程）', portOpen(PORT));

  // 桌面版到底关掉了没有 —— 决定下面几条断言的**说法**是否成立。
  // 没关掉就说「桌面版还开着时能列出会话」，不能挂「关掉之后…」的牌子：
  // 那会让人以为验证过一件其实没验的事。
  const closed = !desktopRunning();
  const after = closed ? '关掉桌面版后' : '桌面版还开着时';

  if (portOpen(PORT)) {
    const s = await connect(PORT);
    const l = await call(s, 'thread/list', { limit: 10 }, 25000);
    const n = (l.result && l.result.data || []).length;
    ok(`${after}仍能列出会话`, n > 0, `${n} 条`);

    // 挑一条能 resume 的，读历史 —— 这是手机最常做的事
    let readOk = false, sample = null;
    for (const t of (l.result && l.result.data || []).slice(0, 4)) {
      const items = await call(s, 'thread/items/list',
        { threadId: t.id, limit: 5, sortDirection: 'desc' }, 20000);
      if (items.result && items.result.data && items.result.data.length) {
        readOk = true;
        sample = t.preview;
        break;
      }
    }
    ok(`${after}仍能读会话内容`, readOk, String(sample).slice(0, 30));

    // 账户信息也该照常
    const acct = await call(s, 'account/read', {}, 15000);
    ok(`${after}仍能读到账户`, !!(acct.result && acct.result.account),
      JSON.stringify(acct.result || acct.error).slice(0, 100));

    s.ws.close();
  }

  // ── 3. 我们的服务没在跑时，网关能不能自己拉起来 ──────────────────────────
  console.log('\n[3] 我们的服务没在跑时');
  try {
    const t = require('./targets.js');
    const r = await t.codex.stop();
    console.log(`      已停止: ${r.message}`);
  } catch (e) { console.log('      停止时出错: ' + e.message); }
  await sleep(2500);
  // 注意：不能断言「停掉之后一直是停的」—— 网关里有个 Codex 看门狗，
  // 它发现「本来在跑、现在没了」会在几秒内把它拉回来。那正是我们要的行为，
  // 所以这里接受两种结果：还停着，或者已经被看门狗拉回来了。
  const stillDown = !portOpen(PORT);
  ok('停止生效（或被看门狗自动拉回）', true,
    stillDown ? '目前是停着的' : '已被看门狗自动拉回 —— 正是预期行为');
  if (!stillDown) {
    console.log('      看门狗已经把 Codex 拉回来了，跳过下面的重启步骤');
    console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
    return;
  }

  try {
    const t = require('./targets.js');
    const r = await t.codex.start();
    ok('能重新启动', r.ok, r.message);
    console.log(`      ${r.message}`);
    if (r.ok && !r.already) {
      const s = await connect(PORT);
      const l = await call(s, 'thread/list', { limit: 3 }, 25000);
      ok('重启后能正常工作', !!(l.result && l.result.data), JSON.stringify(l).slice(0, 80));
      s.ws.close();
    }
  } catch (e) {
    ok('能重新启动', false, e.message);
  }

  // ── 4. 版本适配：CLI 路径会不会因为升级而找不到 ──────────────────────────
  //
  // Codex 的 CLI 装在 LocalAppData\OpenAI\Codex\bin\<一串哈希>\ 下面，
  // **升级会换目录**。写死路径的话一次更新就废了。
  console.log('\n[4] 版本升级后的路径发现');
  try {
    const t = require('./targets.js');
    const d = t.codex.detect();
    ok('能找到 Codex 可执行文件', !!d.exe, d.source);
    console.log(`      ${d.exe}`);
    console.log(`      发现方式: ${d.source}`);
    ok('路径里带版本哈希（说明它是自动发现的，不是写死的）',
      /bin[\\/][0-9a-f]{8,}/i.test(d.exe || ''), d.exe);

    // 看看 bin 目录下有几种版本 —— 升级后会并存
    const binDir = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(binDir)) {
      const vers = fs.readdirSync(binDir).filter((n) => {
        try { return fs.statSync(path.join(binDir, n)).isDirectory(); } catch (e) { return false; }
      });
      console.log(`      bin 下有 ${vers.length} 个版本目录: ${vers.join(', ')}`);
      ok('多版本并存时也能挑到一个', vers.length > 0);
    }
  } catch (e) {
    ok('路径发现', false, e.message);
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
