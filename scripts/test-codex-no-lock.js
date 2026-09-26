// 手机上「只翻看」会不会占住电脑的写锁？
//
// 手机仅查看会话时，不应占用电脑端的写入锁。
// 之前的实现会在打开会话时后台 resume —— 那就会占锁，
// 于是**只是翻翻看看就把电脑挡住了**，而且手机上完全看不出来。
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');
const { releaseAllLocks } = require('./test-guard.js');

const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:8080';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  console.log('\n=== 手机上翻看会话，会不会占住电脑 ===\n');

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });

  try {
    await p.goto(`${base}/k/${key}`, 3000);
    await p.goto(`${base}/codex`, 3000);

    const r = await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelectorAll('.item').length) break;
        await new Promise(r => setTimeout(r, 400));
      }
      const it = document.querySelectorAll('.item')[0];
      const title = (it.querySelector('.t') || {}).textContent || '';
      const t0 = Date.now();
      it.click();
      for (let i = 0; i < 250; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (document.querySelectorAll('.bub,.tool,.think').length) break;
      }
      const openMs = Date.now() - t0;

      // 翻两页历史
      const main = document.getElementById('main');
      for (let k = 0; k < 2; k++) {
        main.scrollTop = 0;
        await new Promise(r => setTimeout(r, 2000));
      }

      // 停留一会儿 —— 如果会占锁，这时候就占了
      await new Promise(r => setTimeout(r, 5000));

      return {
        title: title.slice(0, 24),
        openMs,
        blocks: document.querySelectorAll('.bub,.tool,.think').length,
        lockHint: document.getElementById('lockhint').style.display,
        resumed: !!document.getElementById('lockhint').style.display.match(/flex/)
      };
    })()`);

    console.log(`      会话: 「${r.title}」`);
    console.log(`      打开 ${r.openMs} ms，翻出 ${r.blocks} 个块`);
    console.log(`      标题栏「占用中」提示: ${r.lockHint === 'flex' ? '显示了（占了锁）' : '没有（没占锁）'}`);

    ok('翻看会话够快', r.openMs < 3000, r.openMs + ' ms');
    ok('翻看得出内容', r.blocks > 0, String(r.blocks));
    ok('只是翻看时**不占**电脑的写锁', r.lockHint !== 'flex', 'lockhint=' + r.lockHint);

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
    // 无头浏览器是强杀的，pagehide 不触发 —— 必须自己收尾，
    // 否则测试每跑一次就给使用者的电脑留一个写锁
    try {
      const freed = await releaseAllLocks(18790);
      console.log(`\n  收尾：放开了 ${freed} 条会话的占用`);
    } catch (e) { /* 收尾失败不影响结论 */ }
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
