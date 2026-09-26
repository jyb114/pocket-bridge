// 真的发一条消息出去 —— 端到端。
//
// 发送功能曾失效，而之前的检查只验证了输入框是否存在。
// 这个脚本真的往输入框里打字、点发送、看有没有进到 turn/start。
//
// 为了不污染使用者的会话，它自己新建一个会话，发一句最无害的话，然后删掉。
'use strict';
const { liveAllowed, releaseAllLocks } = require('./test-guard.js');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Browser } = require('./browser-check.js');

const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:8080';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  // LIVE-GATE：这个脚本会真的用使用者的 Codex 账号跑一轮。
  // 默认不跑 —— 要用你的账号测试，必须自己显式打开。
  if (!liveAllowed('发消息')) { await releaseAllLocks(18790); process.exit(0); }
  console.log('\n=== Codex 发消息 · 端到端 ===\n');

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });

  try {
    await p.goto(`${base}/k/${key}`, 3000);
    await p.goto(`${base}/codex`, 3000);

    // 等列表
    await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelectorAll('.item').length) break;
        await new Promise(r => setTimeout(r, 400));
      }
    })()`);

    // ── 1. 新建一个会话（不碰使用者的）──────────────────────────────────────
    console.log('[1] 新建会话');
    const made = await p.eval(`(async () => {
      const b = Array.from(document.querySelectorAll('.btn'))
        .find(x => /开一个新会话/.test(x.textContent));
      if (!b) return { found: false };
      b.click();
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 300));
        if (document.getElementById('footer').style.display !== 'none') break;
      }
      const err = document.querySelector('.msg.err .bub');
      return { found: true, error: err ? err.textContent.slice(0, 100) : null,
               title: document.getElementById('title').textContent };
    })()`);
    ok('能新建会话', made.found && !made.error, made.error || JSON.stringify(made));

    // ── 2. 打字并发送 ───────────────────────────────────────────────────────
    console.log('\n[2] 打字并点发送');
    const sent = await p.eval(`(async () => {
      const box = document.getElementById('input');
      box.value = 'Reply with exactly: send-probe-ok';
      box.dispatchEvent(new Event('input'));

      // 记下发送前界面上有几条消息
      const before = document.querySelectorAll('.msg.user').length;
      document.getElementById('send').click();

      // 等「自己发的那条」出现（本地会立刻画出来，所以这个很快）
      let localShown = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (document.querySelectorAll('.msg.user').length > before) { localShown = true; break; }
      }

      // 再等一会儿，看有没有报错
      await new Promise(r => setTimeout(r, 12000));
      const errs = Array.from(document.querySelectorAll('.msg.err .bub')).map(x => x.textContent);
      return {
        localShown,
        stillLoading: !!document.getElementById('resume-note'),
        errors: errs.slice(0, 3),
        userMsgs: document.querySelectorAll('.msg.user').length,
        agentMsgs: document.querySelectorAll('.msg.agent').length,
        running: !!document.querySelector('footer .stop')
      };
    })()`);
    console.log(`      自己那条显示了: ${sent.localShown}　用户消息 ${sent.userMsgs} 条　回复 ${sent.agentMsgs} 条`);
    if (sent.errors.length) console.log(`      界面上的错误: ${sent.errors.join(' | ')}`);
    ok('自己发的消息立刻显示出来', sent.localShown === true);
    ok('发送没有报错', sent.errors.length === 0, sent.errors.join(' | '));
    ok('没有卡在「正在加载会话」', sent.stillLoading === false);

    // ── 3. 服务端那边真的收到并开始跑了吗 ──────────────────────────────────
    console.log('\n[3] 服务端是否真的开始跑了');
    await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (document.querySelector('footer .stop')) break;
        if (document.querySelectorAll('.msg.agent').length) break;
      }
    })()`);
    const progressed = await p.eval(`({
      running: !!document.querySelector('footer .stop'),
      agent: document.querySelectorAll('.msg.agent').length,
      tools: document.querySelectorAll('.tool').length
    })`);
    console.log(`      运行中=${progressed.running}　回复 ${progressed.agent} 条　工具块 ${progressed.tools} 个`);
    ok('服务端接住了这一轮（有进展）',
      progressed.running || progressed.agent > 0 || progressed.tools > 0,
      JSON.stringify(progressed));

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
  }

  // 收尾：把测试建的会话删掉
  try {
    const out = execFileSync(process.execPath,
      [path.join(__dirname, 'cleanup-test-threads.js'), '18790'],
      { encoding: 'utf8', timeout: 60000 });
    const line = out.trim().split('\n').filter((l) => /会话共|已删|已归/.test(l));
    if (line.length) console.log('\n  ' + line.join('\n  '));
  } catch (e) { /* 清理失败不影响结论 */ }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  try { await releaseAllLocks(18790); } catch (e) { /* 收尾失败不影响结论 */ }
  process.exitCode = fail ? 1 : 0;
})();
