// 控制台上的余额卡片渲染出来了吗、数字对不对。
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  console.log('\n=== 控制台余额卡片 ===\n');

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });

  try {
    await p.goto(`http://127.0.0.1:8080/k/${key}`, 3000);
    await p.goto('http://127.0.0.1:8080/console', 3000);

    const r = await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise(x => setTimeout(x, 300));
        const t = (document.getElementById('v-balance') || {}).textContent;
        if (t && t !== '—') break;
      }
      const v = document.getElementById('v-balance');
      return {
        text: v ? v.textContent : null,
        color: v ? v.style.color : null,
        hint: (document.getElementById('balance-hint') || {}).textContent,
        buttons: Array.from(document.querySelectorAll('#balance-acts button')).map(x => x.textContent)
      };
    })()`);

    console.log(`      余额显示: ${r.text}`);
    console.log(`      说明文字: ${r.hint}`);
    console.log(`      按钮: ${r.buttons.join(' / ')}`);

    ok('余额卡片显示出了金额', /^[¥$]?\s*\d/.test(String(r.text)), String(r.text));
    ok('有「去充值」按钮', r.buttons.some((x) => /充值/.test(x)), r.buttons.join(','));
    ok('有「刷新余额」按钮', r.buttons.some((x) => /刷新/.test(x)), r.buttons.join(','));
    ok('说明文字不是空/错误', !!r.hint && !/查不到|取不到/.test(r.hint), String(r.hint));

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    // ── 第二遍：**不登录**直接开控制台 ──────────────────────────────────────
    //
    // ★ 这一遍才是使用者真正走的那条路，而它原来根本没被验过。
    //
    //   上面那一遍先访问了 /k/<key>，浏览器里已经种下会话 cookie，
    //   于是余额请求带着 cookie 过了认证门，一切正常。
    //   但真实场景是：人从托盘图标点开一个**干净的控制台窗口**，那里没有 cookie。
    //   实测这一遍原来显示的是
    //     「取不到余额：Unexpected token 'a', "access key "… is not valid JSON」
    //   —— 那其实是 403 的正文被当成 JSON 解析，跟余额一点关系都没有。
    //   被第一遍掩盖了整整一轮，直到我在截图里看见才查出来。
    //
    //   教训：测「界面能不能用」时，会话状态必须和真实场景一致；
    //   测试里顺手做的登录，会把一整类 bug 挡在视野之外。
    await p.send('Network.clearBrowserCookies');
    await p.goto('http://127.0.0.1:8080/console', 3000);

    const r2 = await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        await new Promise(x => setTimeout(x, 300));
        const t = (document.getElementById('v-balance') || {}).textContent;
        if (t && t !== '—') break;
      }
      const v = document.getElementById('v-balance');
      return { text: v ? v.textContent : null,
               hint: (document.getElementById('balance-hint') || {}).textContent };
    })()`);

    console.log(`      未登录时余额: ${r2.text}   （${r2.hint}）`);
    ok('没登录时打开控制台，余额照样读得出来',
      /^[¥$]?\s*\d/.test(String(r2.text)), String(r2.text));
    ok('没登录时说明文字也不是错误',
      !!r2.hint && !/查不到|取不到|HTTP|JSON/.test(r2.hint), String(r2.hint));

    const s = await p.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'logs', 'balance.png'), Buffer.from(s.data, 'base64'));
    console.log('      截图: logs/balance.png');
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
