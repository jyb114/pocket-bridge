// 手机端到底卡在哪 —— DSH 和 Codex 两个界面都量。
//
// 「太卡了」是个笼统的反馈，不改成一串数字就没法对症下药。
// 这个脚本量四件事：
//   1. 首屏多久能看见内容
//   2. DOM 多重（节点数、深度）
//   3. 滚动一帧要多久
//   4. 触控目标够不够大（小于 44px 的按钮有多少 —— iOS 人机指南的下限）
//
// 用 4G 限速 + 手机尺寸，尽量接近真实体感。
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:8080';

async function measure(p, label, url, waitFor) {
  console.log(`\n── ${label} ──`);
  const t0 = Date.now();
  await p.goto(url, 0);
  const navMs = Date.now() - t0;

  const r = await p.eval(`(async () => {
    const sel = ${JSON.stringify(waitFor)};
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      if (document.querySelectorAll(sel).length) break;
      await new Promise(x => setTimeout(x, 100));
    }
    const firstMs = Date.now() - t0;

    // 等它真正画完再量。
    // 只等选择器出现是不够的：DSH 的输入框很早就有了，消息列表还在后面，
    // 那样量出来的是「半渲染」状态（35 个节点），数字没意义。
    await new Promise(r => setTimeout(r, 4000));

    // DOM 规模
    const all = document.getElementsByTagName('*');
    let maxDepth = 0;
    for (let i = 0; i < Math.min(all.length, 4000); i++) {
      let d = 0, n = all[i];
      while (n && n.parentElement) { d++; n = n.parentElement; }
      if (d > maxDepth) maxDepth = d;
    }

    // 滚一帧
    const sc = document.scrollingElement;
    const s0 = performance.now();
    for (let i = 0; i < 20; i++) sc.scrollTop = i * 120;
    sc.getBoundingClientRect();
    const scrollMs = +(performance.now() - s0).toFixed(2);

    // 触控目标：iOS 人机指南要求 >= 44px
    const clickable = Array.from(document.querySelectorAll('button, a, [role=button], input[type=submit]'));
    const small = clickable.filter(el => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && (b.width < 44 || b.height < 44);
    }).length;

    return {
      firstMs, nodes: all.length, maxDepth, scrollMs,
      clickable: clickable.length, smallClickable: small,
      height: sc.scrollHeight, width: document.documentElement.clientWidth
    };
  })()`);

  console.log(`  导航 ${navMs} ms ｜ 首屏内容 ${r.firstMs} ms`);
  console.log(`  DOM ${r.nodes} 节点，最深 ${r.maxDepth} 层 ｜ 内容高 ${r.height} px`);
  console.log(`  滚 20 次 ${r.scrollMs} ms（每帧约 ${(r.scrollMs / 20).toFixed(2)} ms）`);
  console.log(`  可点元素 ${r.clickable} 个，其中**小于 44px** 的 ${r.smallClickable} 个`);
  return r;
}

(async () => {
  console.log('\n=== 手机端流畅度实测（4G 限速 + 手机尺寸）===');

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });
  await p.send('Network.enable', {});
  await p.send('Network.emulateNetworkConditions', {
    offline: false, latency: 60, downloadThroughput: 400 * 1024, uploadThroughput: 200 * 1024
  });

  try {
    await p.goto(`${base}/k/${key}`, 100);

    // 先把「用 DSH」这个选择定下来。
    //
    // 上一版直接 goto('/?target=dsh') 就开测 —— 那是**选择页**，不是工作台，
    // 所以测出来只有 24 个节点、0 个可点元素，一组毫无意义的数字。
    // 正确做法是先像使用者那样选定目标，再等真正的工作台渲染出来。
    await p.goto(`${base}/?target=dsh`, 2500);
    await p.eval(`fetch('/?target=dsh').catch(()=>{})`);   // 确认选择被记住
    await p.goto(`${base}/`, 4000);

    const dsh = await measure(p, 'DSH 工作台', `${base}/`, 'textarea, [contenteditable=true], button');

    await p.goto(`${base}/codex`, 300);
    const codex = await measure(p, 'Codex 界面', `${base}/codex`, '.item');

    console.log('\n── 结论 ──');
    const verdict = (name, r) => {
      const notes = [];
      if (r.firstMs > 2000) notes.push(`首屏偏慢（${r.firstMs}ms）`);
      if (r.scrollMs / 20 > 8) notes.push(`滚动掉帧（每帧 ${(r.scrollMs / 20).toFixed(1)}ms）`);
      if (r.nodes > 3000) notes.push(`DOM 偏重（${r.nodes} 节点）`);
      if (r.smallClickable > 5) notes.push(`${r.smallClickable} 个按钮小于 44px`);
      console.log(`  ${name}: ${notes.length ? notes.join('；') : '没有明显问题 ✓'}`);
    };
    verdict('DSH ', dsh);
    verdict('Codex', codex);

    const s = await p.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'logs', 'perf-dsh.png'), Buffer.from(s.data, 'base64'));
    console.log('\n  截图: logs/perf-dsh.png');
  } catch (err) {
    console.error('出错了:', err.message);
    process.exitCode = 1;
  } finally {
    b.kill();
  }
})();
