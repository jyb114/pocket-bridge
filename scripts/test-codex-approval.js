// 审批请求到底会不会发给客户端？—— 端到端验证。
//
// 为什么要专门写这个：审批是「不该答就卡死」的东西，光看代码没法确认它真的会来。
// 这里主动造一个必然需要审批的场景（把 approvalPolicy 设成 untrusted，
// 让它连只读命令都要问一句），然后等审批请求、**拒绝**掉、看回合是否正常继续。
//
// 拒绝是关键：整个测试不会真的执行任何命令。
//
// 用法: node scripts/test-codex-approval.js
'use strict';
const { liveAllowed, releaseAllLocks } = require('./test-guard.js');

const fs = require('fs');
const path = require('path');
const { MiniWS } = require('./browser-check.js');

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
  if (!liveAllowed('审批请求')) { await releaseAllLocks(18790); process.exit(0); }
  console.log('\n=== Codex 审批请求 · 端到端验证 ===\n');

  const ws = new MiniWS(`ws://127.0.0.1:${PORT}`);
  const pending = new Map();
  const sawApproval = [];
  const notices = [];
  let nextId = 1;

  ws.on('message', (t) => {
    let m; try { m = JSON.parse(t); } catch (e) { return; }

    if (m.method) {
      if (m.id !== undefined) {
        // 服务端反过来请求我们 —— 这就是审批
        sawApproval.push(m);
        console.log(`  ← 服务端请求: ${m.method}`);
        console.log(`     参数: ${JSON.stringify(m.params).slice(0, 260)}`);
      } else {
        notices.push(m.method);
        // error 通知要打出来 —— 「等不到审批」的答案往往就写在里面
        if (m.method === 'error') {
          console.log(`  ← 出错通知: ${JSON.stringify(m.params).slice(0, 400)}`);
        }
      }
      return;
    }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });

  await ws.connect();
  const call = (method, params) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ timeout: true }); } }, 60000);
  });
  /** 应答服务端的请求 —— 客户端必须会这一手，否则对面会一直等 */
  const reply = (id, result) =>
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));

  await call('initialize', { clientInfo: { name: 'approval-test', version: '1.0.0' } });
  console.log('  ✓ 已连接并完成握手\n');

  // ── 关键验证点：id 撞号会不会让审批被误当成回执 ──────────────────────────
  //
  // 客户端的请求 id 从 1 开始递增；服务端的请求 id 是另一套编号。
  // 如果客户端的消息路由先判「这个 id 是不是我在等的回执」，
  // 撞号时审批就会被静默吞掉 —— 这正是「看不到审批」的成因。
  console.log('[1] 造一个和客户端请求 id 撞号的场景');
  const collide = await call('thread/list', { limit: 1 });
  ok('先发一个 id 很小的请求（制造撞号条件）', !collide.timeout, JSON.stringify(collide).slice(0, 80));
  console.log(`      我们用的 id 到了 ${nextId - 1}，服务端发请求时若也用这几个数字就会撞\n`);

  // ── 建一个新会话并发一条必然需要审批的消息 ────────────────────────────────
  console.log('[2] 新建会话并要求执行一条命令（approvalPolicy=untrusted）');
  const started = await call('thread/start', {});
  const th = (started.result && (started.result.thread || started.result)) || {};
  if (!th.id) {
    console.log('  ✗ 建会话失败: ' + JSON.stringify(started).slice(0, 200));
    console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`      会话 ${th.id.slice(0, 8)}`);

  await call('turn/start', {
    threadId: th.id,
    // untrusted = 连只读命令都要问一句；这样才一定能造出审批
    approvalPolicy: 'untrusted',
    input: [{
      type: 'text',
      text: 'Run exactly this shell command with the shell tool and nothing else: ' +
        'echo approval-probe-ok\n' +
        'You must actually run it. Do not answer without running it.'
    }]
  });

  // ── 等审批 ───────────────────────────────────────────────────────────────
  //
  // 这里要允许重试：模型有时会「直接回答」而不去执行命令 —— 那样自然没有审批，
  // 但这不是功能坏了。实测遇到过：同一段话，一次触发了审批，一次没有。
  // 单次就判失败会把模型的随机性当成 bug 报出来。
  console.log('\n[3] 等审批请求（最多 3 轮，每轮 60 秒）');
  let approval = null;
  for (let round = 1; round <= 3 && !approval; round++) {
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      approval = sawApproval.find((m) => /requestApproval|Approval/.test(m.method));
      if (approval) break;
      if (i % 20 === 19) {
        console.log(`      第 ${round} 轮…等了 ${i + 1} 秒，共 ${notices.length} 条通知`);
      }
    }
    if (approval) break;

    if (round < 3) {
      const done = notices.filter((n) => n === 'turn/completed').length;
      console.log(`      第 ${round} 轮没触发（回合已完成 ${done} 次，说明模型直接回答了）。再试一次…`);
      await call('turn/start', {
        threadId: th.id, approvalPolicy: 'untrusted',
        input: [{
          type: 'text',
          text: 'Now actually run it with the shell tool: echo approval-probe-ok'
        }]
      });
      await sleep(4000);
    }
  }

  ok('收到了审批请求', !!approval,
    approval ? '' : `3 轮都没等到。收到的通知类型：${[...new Set(notices)].slice(0, 14).join(', ')}`);

  if (approval) {
    console.log(`      方法: ${approval.method}`);
    const p = approval.params || {};
    console.log(`      命令: ${JSON.stringify(p.command || p.fileChanges || '').slice(0, 140)}`);
    ok('审批请求有 id（能被应答）', approval.id !== undefined);
    ok('带了 threadId（能对上会话）', !!p.threadId || !!p.conversationId);

    // 拒绝它 —— 测试不执行任何真实命令
    console.log('\n[4] 拒绝这次审批（测试不执行任何命令）');
    const decision = approval.method.indexOf('requestApproval') >= 0
      ? { decision: 'decline' }
      : { decision: { denied: { rejection: '自动化测试拒绝' } } };
    reply(approval.id, decision);
    console.log(`      已应答: ${JSON.stringify(decision)}`);

    // 回合应该继续（被拒绝不等于卡死）
    await sleep(8000);
    const after = notices.filter((n) => n === 'turn/completed').length;
    ok('拒绝之后回合没有卡死（收到了 turn/completed）', after > 0,
      `收到的通知: ${[...new Set(notices)].slice(-8).join(', ')}`);
  }

  // ── 客户端 id 路由的正确性 ────────────────────────────────────────────────
  console.log('\n[5] 消息路由：有 method 的不能被当成回执');
  const shapes = sawApproval.map((m) => ({
    id: m.id, hasMethod: !!m.method, hasResult: 'result' in m, hasError: 'error' in m
  }));
  if (shapes.length) {
    ok('服务端请求同时带 id 和 method（回执则只有 id + result）',
      shapes.every((s) => s.hasMethod && !s.hasResult && !s.hasError),
      JSON.stringify(shapes.slice(0, 3)));
    const overlap = shapes.filter((s) => s.id !== undefined && Number.isInteger(s.id) && s.id < nextId);
    console.log(`      服务端请求 id: ${shapes.map((s) => JSON.stringify(s.id)).join(', ')}`);
    console.log(`      我们自己用到的 id 到 ${nextId - 1} 为止` +
      (overlap.length ? `　—— 有 ${overlap.length} 个落在同一区间，确实会撞号` : '　—— 本次没撞上'));
  } else {
    ok('（没收到审批，无法验证路由形状）', false);
  }

  ws.close();
  await sleep(300);

  // 收尾：测试建的会话不能留在使用者的列表里 ——
  // 每跑一次就多一条「echo approval-probe-ok」，看着像垃圾。
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath,
      [path.join(__dirname, 'cleanup-test-threads.js'), String(PORT)],
      { encoding: 'utf8', timeout: 60000 });
    console.log(out.trim().split('\n').map((l) => '  ' + l).join('\n'));
  } catch (err) {
    console.log(`  （清理测试会话失败：${err.message}）`);
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  try { await releaseAllLocks(18790); } catch (e) { /* 收尾失败不影响结论 */ }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
