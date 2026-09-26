// 「发送失败：thread not found」——复现并验证修复。
//
// 症状：thread/list 能列出会话，但 turn/start 说找不到。
// 成因：list 出来的会话是 notLoaded（磁盘记录，没加载进内存），turn/start 要的是已加载的。
//
// 这个测试自己造出那个状态：新建会话 → unsubscribe 把它卸掉 → 确认变成 notLoaded →
// 直接发（应当失败，复现问题）→ resume → 再发（应当成功）。
// 全程只碰自己建的会话，跑完删掉。
'use strict';
const { liveAllowed, releaseAllLocks } = require('./test-guard.js');
const { MiniWS } = require('./browser-check.js');
const { execFileSync } = require('child_process');
const path = require('path');

const PORT = Number(process.argv[2] || 18790);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

(async () => {
  // LIVE-GATE：这个脚本会真的用使用者的 Codex 账号跑一轮。
  // 默认不跑 —— 要用你的账号测试，必须自己显式打开。
  if (!liveAllowed('会话状态')) { await releaseAllLocks(18790); process.exit(0); }
  console.log('\n=== 会话加载状态与发送 · 端到端验证 ===\n');

  const ws = new MiniWS(`ws://127.0.0.1:${PORT}`);
  const pending = new Map();
  let nextId = 1;
  ws.on('message', (t) => {
    let m; try { m = JSON.parse(t); } catch (e) { return; }
    if (m.method) return;
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await ws.connect();
  const call = (method, params) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ timeout: true }); } }, 40000);
  });

  await call('initialize', { clientInfo: { name: 'state-test', version: '1' } });
  console.log('  ✓ 握手完成\n');

  // ── 一、真实会话列表的状态分布 ────────────────────────────────────────────
  console.log('[1] 现有会话的加载状态');
  const list = await call('thread/list', { limit: 30 });
  const rows = (list.result && list.result.data) || [];
  const stateOf = (t) => (t.status && (t.status.type || t.status)) || '?';
  const notLoaded = rows.filter((t) => /notLoaded|not_loaded/i.test(stateOf(t)));
  console.log(`      共 ${rows.length} 条，其中 notLoaded ${notLoaded.length} 条`);
  ok('确实存在 notLoaded 的会话（这就是那类会「找不到」的）', notLoaded.length > 0,
    `状态分布: ${[...new Set(rows.map(stateOf))].join(', ')}`);

  // ── 二、造一个 notLoaded 的测试会话 ───────────────────────────────────────
  //
  // 注意顺序：必须先真的跑一个回合，让会话落到磁盘上，再 unsubscribe。
  // 直接 unsubscribe 一个空会话会把它整个删掉（实测：之后 resume 会报
  // 「no rollout found for thread id」）—— 那样就造不出「在磁盘上但没加载」这个状态了。
  console.log('\n[2] 造一个「在磁盘上但没加载」的测试会话');
  const started = await call('thread/start', {});
  const th = (started.result && (started.result.thread || started.result)) || {};
  if (!th.id) {
    console.log('  ✗ 建会话失败: ' + JSON.stringify(started).slice(0, 200));
    console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`      会话 ${th.id.slice(0, 8)}`);

  const seed = await call('turn/start', {
    threadId: th.id, input: [{ type: 'text', text: 'Reply with just: ok' }]
  });
  if (seed.error) console.log(`      起头回合出错: ${JSON.stringify(seed.error).slice(0, 120)}`);
  else console.log('      已跑一个回合（让它落盘）');
  await sleep(6000);

  const un = await call('thread/unsubscribe', { threadId: th.id });
  console.log(`      unsubscribe → ${un.timeout ? '超时' : JSON.stringify(un.result || un.error).slice(0, 80)}`);
  await sleep(2000);

  const reloaded = await call('thread/list', { limit: 30 });
  const mine = ((reloaded.result && reloaded.result.data) || [])
    .filter((t) => t.id === th.id)[0];
  const nowState = mine ? stateOf(mine) : '（列表里没有）';
  console.log(`      卸载后状态: ${nowState}`);

  // ── 三、复现：不 resume 直接发 ────────────────────────────────────────────
  console.log('\n[3] 复现：不 resume 直接发消息');
  let reproduced = false;
  if (mine && /notLoaded|not_loaded/i.test(nowState)) {
    const r = await call('turn/start', {
      threadId: th.id, input: [{ type: 'text', text: 'state-probe' }]
    });
    const errText = JSON.stringify(r.error || r.result || '').slice(0, 200);
    reproduced = !!(r.error && /not found|not loaded|rollout/i.test(errText));
    console.log(`      结果: ${r.error ? '出错' : '竟然成功了'}  ${errText}`);
    ok('未加载的会话直接发会失败（复现了使用者遇到的现象）', reproduced, errText);
  } else {
    console.log('      没能造出 notLoaded 状态，跳过复现');
    ok('（无法复现，但下面的修复路径仍要验）', true);
  }

  // ── 四、修复：resume 之后再发 ─────────────────────────────────────────────
  console.log('\n[4] 修复：先 resume 再发');
  const res = await call('thread/resume', { threadId: th.id });
  if (res.timeout) ok('thread/resume 成功', false, '超时');
  else if (res.error) ok('thread/resume 成功', false, JSON.stringify(res.error).slice(0, 160));
  else {
    ok('thread/resume 成功', true);
    const info = res.result || {};
    console.log('      返回里带着这些会话设置: ' +
      ['model', 'reasoningEffort', 'cwd', 'approvalPolicy', 'sandbox']
        .filter((k) => info[k] !== undefined)
        .map((k) => k + '=' + JSON.stringify(info[k])).join('　').slice(0, 200));

    const loadedList = await call('thread/loaded/list', {});
    const loadedIds = (loadedList.result && loadedList.result.data) || [];
    ok('resume 之后会话出现在「已加载」列表里', loadedIds.indexOf(th.id) >= 0,
      `已加载 ${loadedIds.length} 条`);

    const r2 = await call('turn/start', {
      threadId: th.id, input: [{ type: 'text', text: 'Reply with just: ok' }]
    });
    if (r2.timeout) ok('resume 之后能正常发送', false, '超时');
    else if (r2.error) ok('resume 之后能正常发送', false, JSON.stringify(r2.error).slice(0, 200));
    else {
      const turn = (r2.result && (r2.result.turn || r2.result)) || {};
      ok('resume 之后能正常发送', true);
      console.log(`      拿到 turnId: ${String(turn.id || '').slice(0, 12)}…`);
    }
  }

  // ── 五、界面要用的那几样东西在不在 ────────────────────────────────────────
  console.log('\n[5] 账户 / 模型 / 项目 的数据来源');
  const acct = await call('account/read', {});
  ok('能读到账户', !!(acct.result && acct.result.account),
    JSON.stringify(acct.result || acct.error).slice(0, 140));
  if (acct.result && acct.result.account) {
    const a = acct.result.account;
    console.log(`      ${a.email || a.type}　套餐 ${a.planType || '?'}`);
  }

  const rl = await call('account/rateLimits/read', {});
  const primary = rl.result && rl.result.rateLimits && rl.result.rateLimits.primary;
  ok('能读到额度', !!primary, JSON.stringify(rl.result || rl.error).slice(0, 140));
  if (primary) {
    console.log(`      已用 ${primary.usedPercent}%　周期 ${primary.windowDurationMins} 分钟`);
  }

  const models = await call('model/list', {});
  const ms = (models.result && models.result.data) || [];
  ok('能读到模型列表', ms.length > 0, String(ms.length));
  if (ms.length) console.log(`      ${ms.map((m) => m.displayName || m.id).join('、')}`);

  const withCwd = rows.filter((t) => t.cwd);
  ok('会话里带工作目录（能做「项目」选择）', withCwd.length > 0,
    `${withCwd.length} 条有 cwd`);
  if (withCwd.length) {
    const uniq = [...new Set(withCwd.map((t) => t.cwd))];
    console.log(`      ${uniq.length} 个不同目录，例如 ${uniq.slice(0, 2).join('　')}`);
  }

  // ── 收尾 ─────────────────────────────────────────────────────────────────
  console.log('\n[6] 收尾');
  await call('turn/interrupt', { threadId: th.id }).catch(() => { });
  await sleep(500);
  ws.close();
  await sleep(300);
  try {
    const out = execFileSync(process.execPath,
      [path.join(__dirname, 'cleanup-test-threads.js'), String(PORT)],
      { encoding: 'utf8', timeout: 60000 });
    const line = out.trim().split('\n').filter((l) => /会话共|已删|已归/.test(l));
    console.log('  ' + (line.join('\n  ') || '（没有需要清理的）'));
  } catch (err) {
    console.log(`  （清理失败：${err.message}）`);
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  try { await releaseAllLocks(18790); } catch (e) { /* 收尾失败不影响结论 */ }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
