// 「任务进行中能不能插队」这件事的回归测试（2026-09-26 使用者提的）。
//
// 他看到的：Codex 手机页在任务进行中**只能排队发送**，不像 DSH 能选插队。
// 代码里的实情：任务状态没确认下来时，renderFooter 把「立即补充」这颗选项禁用了，
// 还把显示值强制回「排队发送」—— 他既插不了队，也看不出为什么。
//
// 现在的规则（这条测试守它）：
//   · 「立即补充 / 排队发送」由**使用者自己选**，状态没确认时也不禁用、不改回去；
//   · 真按「立即补充」发的时候先确认一次当前这一轮：
//       确认到 → turn/steer 真插队；
//       确认不到 → 按排队保存，并且**明说**「没能确认当前任务，已按排队保存」。
//   不许出现「显示排队但他说的是插队」或者「说插队了其实在排队」。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');

let pass = 0; let fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); } };

console.log('\n[1] 选项不再被「状态没确认」禁用');
{
  ok('不再有 disabled=saveOnly 那一行', !/option\[value="immediate"\]'\)\.disabled\s*=\s*saveOnly/.test(SRC));
  ok('不再把显示值强制回排队', !/\$\('send-mode'\)\.value\s*=\s*saveOnly\s*\?\s*'queue'/.test(SRC));
  ok('显示值来自使用者自己的选择', /\$\('send-mode'\)\.value\s*=\s*sendModePref\(\)/.test(SRC));
  ok('选项上有一句解释（状态未确认时会先确认一次）',
    /状态未确认：发送时会先确认一次当前任务/.test(SRC));
}

console.log('\n[2] 任务中按使用者选择排队，空闲时发送新消息');
{
  const footer = SRC.match(/function renderFooter\(\)\s*\{[\s\S]*?\n\}/);
  const expression = footer && footer[0].match(/var queuing=([^;]+);/);
  ok('排队标签由任务状态和使用者选择共同决定', !!expression);
  if (expression) {
    const queuing = (running, saveOnly, mode, readOnlySave = false) => vm.runInNewContext(expression[1], {
      state: { running }, saveOnly, readOnlySave, $: () => ({ value: mode })
    });
    ok('正在执行且选择排队时显示排队', queuing(true, false, 'queue') === true);
    ok('正在执行且选择立即补充时不显示排队', queuing(true, false, 'immediate') === false);
    ok('状态未确认且选择排队时显示排队', queuing(false, true, 'queue') === true);
    ok('状态未确认且选择立即补充时不显示排队', queuing(false, true, 'immediate') === false);
    ok('已完成或空闲时，即使保留了排队偏好也显示发送', queuing(false, false, 'queue') === false);
    ok('只读状态显示保存，不把它伪装成立即发送', queuing(false, true, 'immediate', true) === true);
  }
}

console.log('\n[3] 状态没确认但选了「立即补充」：先确认，再决定');
{
  ok('有 sendWhenUncertain()', /function sendWhenUncertain\(/.test(SRC));
  ok('发送入口会走它', /queueOnly\(\) && \$\('send-mode'\)\.value === 'immediate'[\s\S]{0,120}sendWhenUncertain\(/.test(SRC));
  ok('确认用的是 thread/turns/list + status===inProgress',
    /function confirmRunningTurn\([\s\S]{0,600}thread\/turns\/list[\s\S]{0,300}status==='inProgress'/.test(SRC));
  ok('确认到就真插队（turn/steer）',
    /confirmRunningTurn\(\)\.then\(function\(turnId\)\{[\s\S]{0,500}steerTurn\(/.test(SRC));
  ok('确认不到就排队保存', /confirmRunningTurn\(\)\.then\(function\(turnId\)\{[\s\S]{0,400}enqueueDraft\(/.test(SRC));
  ok('并且如实告诉使用者「没能确认当前任务，已按排队保存」',
    /没能确认当前任务，已按排队保存/.test(SRC));
}

console.log('\n[4] 原来的插队路径没被改坏');
{
  ok('steerTurn 仍然用 expectedTurnId 调 turn/steer',
    /call\('turn\/steer',\{threadId:tid,expectedTurnId:turnId/.test(SRC));
  ok('没有已知的那一轮时：先确认再决定（不再只回一句「稍后发送」）',
    /if\(!state\.turnId\)\{[\s\S]{0,400}sendWhenUncertain\(/.test(SRC));
}

console.log(`\n${fail ? `${fail} 处问题` : '全部通过'}（${pass} 项）\n`);
process.exitCode = fail ? 1 : 0;
