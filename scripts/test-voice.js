// 语音输入按钮 —— DSH 和 Codex 两个界面都要有，而且不可用时要说实话。
//
// 这里能自动验的：
//   · 按钮在不在、位置对不对
//   · 浏览器不支持时，点了会不会给出一句人话（而不是静默无反应）
//   · 语音模块本身加载了没
//
// 验不了的（要如实说明）：
//   · **真实语音识别效果** —— 无头浏览器没有麦克风，也不会有真的识别结果。
//     所以这里只验「接线对不对」，识别质量只能真机上试。
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
  console.log('\n=== 语音输入按钮（DSH + Codex）===\n');

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });

  try {
    // ── 模块本身 ──────────────────────────────────────────────────
    await p.goto(`${base}/k/${key}`, 100);
    await p.goto(`${base}/?target=dsh`, 3000);

    const mod = await p.eval(`({
      loaded: typeof window.DshVoice !== 'undefined',
      canAsk: !!(window.DshVoice && typeof window.DshVoice.available === 'function'),
      canWrite: !!(window.DshVoice && typeof window.DshVoice.setInputValue === 'function')
    })`);
    ok('语音模块加载了', mod.loaded === true, JSON.stringify(mod));
    ok('能查询浏览器是否支持', mod.canAsk === true);
    ok('能往输入框写值（框架兼容的那套）', mod.canWrite === true);

    // ── setInputValue 必须让框架「看得见」 ────────────────────────
    // 这是最容易出错的地方：直接改 .value 框架察觉不到，
    // 表现是「字看着在里面、发出去是空的」。
    const wrote = await p.eval(`(() => {
      const el = document.createElement('input');
      el.type = 'text';
      document.body.appendChild(el);
      let sawInput = 0, sawChange = 0;
      el.addEventListener('input', () => sawInput++);
      el.addEventListener('change', () => sawChange++);
      window.DshVoice.setInputValue(el, '测试文字');
      const v = el.value;
      el.remove();
      return { value: v, sawInput, sawChange };
    })()`);
    ok('写值后内容正确', wrote.value === '测试文字', wrote.value);
    ok('写值会派发 input 事件（框架才看得到）', wrote.sawInput === 1, String(wrote.sawInput));
    ok('写值会派发 change 事件', wrote.sawChange === 1, String(wrote.sawChange));

    // ── 浏览器不支持时的表现 ──────────────────────────────────────
    // 无头 Chromium 默认没有语音识别，这里正好能验「不支持」那条路
    const support = await p.eval(`window.DshVoice.available()`);
    console.log(`      这个无头浏览器支持语音识别吗: ${support}`);
    const why = await p.eval(`window.DshVoice.whyNot()`);
    ok('不支持时能给出一句人话（不是 null/空白）',
      support ? true : (typeof why === 'string' && why.length > 8), String(why));
    if (!support) console.log(`      提示语: ${why}`);

    // ── DSH 上的按钮 ──────────────────────────────────────────────
    const dshBtn = await p.eval(`(() => {
      const b = document.getElementById('dsh-gw-voice');
      if (!b) return { found: false };
      const r = b.getBoundingClientRect();
      return { found: true, w: Math.round(r.width), h: Math.round(r.height),
               bottom: Math.round(window.innerHeight - r.bottom),
               text: b.textContent };
    })()`);
    // 不支持识别的浏览器里，按钮本来就不该出现 —— 这是设计如此
    ok('不支持识别时 DSH 上不显示麦克风（不摆一个点了没用的按钮）',
      support ? dshBtn.found === true : dshBtn.found === false,
      JSON.stringify(dshBtn));
    if (dshBtn.found) {
      ok('DSH 的麦克风够大（>= 40px）', dshBtn.w >= 40 && dshBtn.h >= 40,
        `${dshBtn.w}×${dshBtn.h}`);
    }

    // ── Codex 上的按钮 ────────────────────────────────────────────
    await p.goto(`${base}/codex`, 300);
    const cx = await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelectorAll('.item').length) break;
        await new Promise(x => setTimeout(x, 300));
      }
      document.querySelectorAll('.item')[0].click();
      await new Promise(x => setTimeout(x, 3000));
      const b = document.getElementById('btn-voice');
      return {
        found: !!b,
        text: b ? b.textContent.trim() : null,
        dimmed: b ? b.style.opacity : null,
        title: b ? b.title : null
      };
    })()`);
    console.log(`      Codex 麦克风: 文字=${cx.text} 变灰=${cx.dimmed || '否'}`);
    console.log(`      提示: ${cx.title}`);
    ok('Codex 输入区有麦克风按钮', cx.found === true, JSON.stringify(cx));

    // Codex 这一页原来**一个外部脚本都没有** —— 意味着它的通信一直是明文的，
    // 端到端加密模块根本没被加载过。写语音功能时才发现。
    const cxMod = await p.eval(`({
      voice: typeof window.DshVoice !== 'undefined',
      e2ee: typeof window.DshE2EE !== 'undefined',
      e2eeAvailable: !!(window.DshE2EE && window.DshE2EE.available())
    })`);
    ok('Codex 页面也加载了加密模块', cxMod.e2ee === true, JSON.stringify(cxMod));

    if (!support) {
      ok('不支持时按钮变灰并给出说明（不是静默无反应）',
        cx.dimmed === '0.45' && typeof cx.title === 'string' && cx.title.length > 8,
        `dimmed=${cx.dimmed} title=${cx.title}`);
    } else {
      ok('支持时按钮是可点的（没被误判成不支持）',
        cx.dimmed !== '0.45', `dimmed=${cx.dimmed} title=${cx.title}`);
    }

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}`);
  } finally {
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  console.log('注：真实语音识别效果无法在无头浏览器里验证，需要真机试。\n');
  process.exitCode = fail ? 1 : 0;
})();
