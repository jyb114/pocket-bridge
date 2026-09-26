// 测试再也不许碰使用者的账号，也不许碰他的隧道。
//
// 起因一（账号）：真实 Codex 上的 turn/start 会建会话、跑回合并消耗额度。
// 自动测试必须保护使用者账号状态，不应把真实账号当作测试环境。
//
// 所以：
//   - 默认**不跑**任何会 turn/start 或 thread/start 的测试；
//   - 要跑必须显式设 CODEX_LIVE_TESTS=1，而且命令行里会写明风险；
//   - 跑完必须把自己建的会话删掉、把自己占的写锁放开。
//
// 起因二（隧道）：test-domain-mode.js 里用真 cloudflared 起了一条隧道来验「降级」，
// 注释还写着「原来那条隧道不受影响」。**那句话是错的** —— tunnel.startTunnel()
// 会先把现有隧道停掉；而 Cloudflare 快速隧道的地址和进程同生共死，进程没了
// 地址就永远找不回来。结果：跑一次测试套件，手机书签里的地址可能失效。
//
// 所以「会起真隧道」的测试也走同一套规矩：默认不跑，要跑显式开启。
'use strict';

const LIVE = process.env.CODEX_LIVE_TESTS === '1';
const TUNNEL_LIVE = process.env.DSH_GW_TUNNEL_TESTS === '1';
const DESKTOP_LIVE = process.env.DSH_GW_DESKTOP_TESTS === '1';

/**
 * 这个测试要不要跑真实回合？
 * 不要的话就打印一句跳过，然后返回 false —— 调用处直接收尾。
 */
function liveAllowed(what) {
  if (LIVE) {
    console.log(`  ⚠ 正在跑真实回合测试（${what}）—— 会用到你的 Codex 账号`);
    return true;
  }
  console.log(`  ⏭ 跳过「${what}」：这会真的用你的 Codex 账号跑一轮。`);
  console.log('     确实要跑的话：CODEX_LIVE_TESTS=1 node <脚本>');
  return false;
}

/**
 * 这个测试要不要真的起一条隧道？
 *
 * 返回 false 时**不要**改用别的办法偷偷起 —— 那正是这个函数要防的事。
 * 想验「降级顺序」这类逻辑，用 candidatesForMode() 之类的纯函数就够了。
 */
function tunnelAllowed(what) {
  if (TUNNEL_LIVE) {
    console.log(`  ⚠ 正在跑真实隧道测试（${what}）—— 会顶掉你现在的隧道，`);
    console.log('     手机书签里的地址会失效，而且换不回来（快速隧道的地址跟进程同生共死）。');
    return true;
  }
  console.log(`  ⏭ 跳过「${what}」：这会真的建一条隧道，顶掉你正在用的那条。`);
  console.log('     确实要跑的话：DSH_GW_TUNNEL_TESTS=1 node <脚本>');
  return false;
}

/**
 * 这个测试要不要强行关掉使用者桌面上的 ChatGPT / Codex？
 *
 * 起因三：test-codex-resilience.js 为了验「关掉桌面版之后手机还能不能用」，
 * 直接 `taskkill /IM ChatGPT.exe /F` —— 而它**不会把程序重新打开**。
 * 也就是说每跑一次回归，使用者桌面上正开着的 ChatGPT 就凭空消失一次，
 * 而且没有任何提示。这跟「测试不许碰使用者的东西」是同一条规矩。
 *
 * 注意：「桌面版本来就没开」的那种情况不需要这个开关 —— 那正好就是要测的状态，
 * 调用处照常往下走即可。
 */
function desktopKillAllowed(what) {
  if (DESKTOP_LIVE) {
    console.log(`  ⚠ 正在跑「${what}」—— 会强行关掉你桌面上的 ChatGPT，且不会自动重开。`);
    return true;
  }
  console.log(`  ⏭ 跳过「${what}」：那会强行关掉你桌面上的 ChatGPT，而且不帮你重开。`);
  console.log('     确实要跑的话：DSH_GW_DESKTOP_TESTS=1 node <脚本>');
  return false;
}

/**
 * 把自己占的写锁全部放开。
 *
 * 为什么必须做：无头浏览器测试结束时是强杀进程的，pagehide 不触发，
 * 于是 releaseThread 不会被调用 —— **测试每跑一次就留下一个写锁**，
 * 把使用者电脑上的 Codex 挡在门外。这个坑已经害过他一次了。
 */
async function releaseAllLocks(port) {
  const { MiniWS } = require('./browser-check.js');
  const ws = new MiniWS(`ws://127.0.0.1:${port || 18790}`);
  const pending = new Map();
  let nextId = 1;
  ws.on('message', (t) => {
    let m; try { m = JSON.parse(t); } catch (e) { return; }
    if (m.method) return;
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  try {
    await ws.connect();
  } catch (err) {
    return 0;   // 服务没在跑就算了
  }
  const call = (method, params, ms) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ timeout: true }) } }, ms || 8000);
  });

  await call('initialize', { clientInfo: { name: 'cleanup', version: '1' } });
  const list = await call('thread/list', { limit: 40 }, 15000);
  let freed = 0;

  // 会话状态是 idle 但服务端仍持有写锁的，unsubscribe 一下
  for (const t of (list.result && list.result.data) || []) {
    const r = await call('thread/resume', { threadId: t.id, excludeTurns: true }, 10000);
    if (r.result) { await call('thread/unsubscribe', { threadId: t.id }, 8000); freed++; }
  }

  try { ws.close(); } catch (e) { /* 无所谓 */ }
  await new Promise((r) => setTimeout(r, 300));
  return freed;
}

module.exports = {
  liveAllowed, tunnelAllowed, desktopKillAllowed, releaseAllLocks,
  LIVE, TUNNEL_LIVE, DESKTOP_LIVE
};
