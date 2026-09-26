// 余额显示在哪、会不会挡视野。
//
// 要求（使用者提的）：
//   1. 显示在 DSH 这边，不在 Codex 那边（Codex 走 ChatGPT 订阅，与余额无关）
//   2. **不要单独占一块位置挡视野** —— 并进右下角那个连接方式角标里
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:8080';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  console.log('\n=== 余额显示位置 ===\n');

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });

  try {
    await p.goto(`${base}/k/${key}`, 100);
    await p.goto(`${base}/?target=dsh`, 2500);

    const dsh = await p.eval(`(async () => {
      for (let i = 0; i < 50; i++) {
        await new Promise(x => setTimeout(x, 300));
        const hit = Array.from(document.querySelectorAll('body > div'))
          .some(d => /¥/.test(d.textContent || ''));
        if (hit) break;
      }
      // 屏幕上所有「飘着的」元素 —— 它们才可能挡视野
      const floating = Array.from(document.querySelectorAll('body > div, body > span'))
        .filter(el => {
          const s = getComputedStyle(el);
          return s.position === 'fixed' || s.position === 'sticky';
        })
        .map(el => ({
          id: el.id || el.className || el.tagName,
          text: (el.textContent || '').trim().slice(0, 40),
          hasYuan: /¥/.test(el.textContent || ''),
          rect: (r => ({ top: Math.round(r.top), left: Math.round(r.left),
                         w: Math.round(r.width), h: Math.round(r.height) }))(el.getBoundingClientRect())
        }));
      return {
        floating,
        separateChip: !!document.getElementById('dsh-gw-balance'),
        withYuan: floating.filter(f => f.hasYuan)
      };
    })()`);

    console.log('  页面上的浮动元素:');
    dsh.floating.forEach((f) => {
      console.log(`    ${f.hasYuan ? '💰' : '  '} ${String(f.id).slice(0, 22).padEnd(22)} ` +
        `${f.rect.w}×${f.rect.h} @右下(${f.rect.left},${f.rect.top})  「${f.text}」`);
    });

    ok('DSH 页面上能看到余额', dsh.withYuan.length > 0,
      JSON.stringify(dsh.floating.map((f) => f.text)));
    ok('余额已经并进角标（只有一个浮动元素带余额）',
      dsh.withYuan.length === 1, `${dsh.withYuan.length} 个`);
    ok('没有单独的余额悬浮块', dsh.separateChip === false);

    // 并进去之后不该变宽太多 —— 否则还是挡视野
    const badge = dsh.withYuan[0];
    if (badge) {
      console.log(`      角标尺寸: ${badge.rect.w}×${badge.rect.h}`);
      ok('角标没有占掉半屏宽', badge.rect.w < 260, badge.rect.w + 'px');
      ok('角标贴着右下角', badge.rect.left > 100, 'left=' + badge.rect.left);
    }

    // Codex 那边不该有
    await p.goto(`${base}/codex`, 300);
    const cx = await p.eval(`(async () => {
      for (let i = 0; i < 40; i++) {
        if (document.querySelectorAll('.item').length) break;
        await new Promise(x => setTimeout(x, 300));
      }
      const menu = document.getElementById('menu');
      if (menu) menu.click();
      await new Promise(x => setTimeout(x, 600));
      return { panel: (document.getElementById('sheet') || {}).innerText || '' };
    })()`);
    ok('Codex 面板里没有「DeepSeek 余额」', !/DeepSeek\s*余额/.test(cx.panel),
      cx.panel.slice(0, 60).replace(/\n/g, ' '));

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    const s = await p.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'logs', 'badge.png'), Buffer.from(s.data, 'base64'));
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
