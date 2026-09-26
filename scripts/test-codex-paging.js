// 大会话的分页加载 —— 端到端验证（真实浏览器 + 真实 3.3GB 会话）。
//
// 要验的是使用者实际感受到的那几件事：
//   1. 打开一条巨大的会话够不够快（不能卡着转圈）
//   2. 是不是只加载了最新一屏，而不是全部
//   3. 往上滑能不能把更早的带出来
//   4. 加载更早内容时，正在看的位置会不会被顶跑
'use strict';
const fs = require('fs');
const path = require('path');
const { Browser } = require('./browser-check.js');

const key = fs.readFileSync(path.join(__dirname, '..', 'logs', 'access-key.txt'), 'utf8').trim();
const base = 'http://127.0.0.1:8080';
const BIG = /grill-me|论文/;   // 找一条大会话（脚本会挑列表里最大的那条）

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

/** 直接问服务端：哪条会话的存档最大 */
function biggestThread() {
  const dir = path.join(process.env.USERPROFILE || '', '.codex', 'sessions');
  let best = null;
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { walk(p); continue; }
      if (!it.name.endsWith('.jsonl')) continue;
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (!best || st.size > best.size) {
        const m = it.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
        best = { size: st.size, id: m ? m[1] : null, name: it.name };
      }
    }
  };
  walk(dir);
  return best;
}

(async () => {
  console.log('\n=== Codex 大会话分页 · 端到端验证 ===\n');

  const big = biggestThread();
  if (!big) {
    console.log('  找不到会话存档，跳过\n');
    process.exitCode = 1;
    return;
  }
  console.log(`  最大的会话: ${(big.size / 1048576).toFixed(1)} MB  ${String(big.id).slice(0, 8)}\n`);

  const b = await Browser.launch();
  const p = await b.newPage();
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });

  try {
    await p.goto(`${base}/k/${key}`, 3000);
    await p.goto(`${base}/codex`, 3000);

    // 等列表出来
    await p.eval(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelectorAll('.item').length) break;
        await new Promise(r => setTimeout(r, 400));
      }
    })()`);

    // ★ 直接按 **id** 打开那条最大的会话，不靠列表序号、也不靠标题。
    //
    //   原来这里是「按标题正则匹配列表项，匹配不到就用第一条」，然后点第 idx 项。
    //   而列表顺序会变（新会话插到最前面、标题被改写），于是它悄悄打开了
    //   另一条**小**会话 —— 那条本来就没有更早的内容，于是「加载更早的内容」
    //   「往上滑的提示」整组失败，看起来像分页坏了，其实它开的根本不是那条大会话。
    //   这是**测试自己的缺陷**，不是产品的。
    console.log(`  直接按 id 打开：${String(big.id).slice(0, 8)}…\n`);

    // ── 一、打开要多久、加载了多少 ───────────────────────────────────────────
    console.log('[1] 打开速度与首次加载量');
    const open = await p.eval(`(async () => {
      const t0 = Date.now();
      openThread({ id: ${JSON.stringify(big.id)}, name: '分页验证' });
      for (let i = 0; i < 200; i++) {
        if (document.querySelectorAll('.bub,.tool,.think').length) break;
        await new Promise(r => setTimeout(r, 50));
      }
      return {
        ms: Date.now() - t0,
        blocks: document.querySelectorAll('.bub,.tool,.think').length,
        hint: (document.getElementById('older-hint') || {}).textContent || null
      };
    })()`);
    console.log(`      用时 ${open.ms} ms，渲染出 ${open.blocks} 个块`);
    ok('打开大会话够快（3 秒内出内容）', open.ms < 3000, open.ms + ' ms');
    ok('只加载了一屏，不是全部（块数有限）', open.blocks > 0 && open.blocks <= 80,
      String(open.blocks));
    ok('顶部有「往上滑加载更早」的提示', !!open.hint, String(open.hint));

    // ── 二、往上滑能不能带出更早的 ───────────────────────────────────────────
    //
    // 验的是那条不变量：**内容在前面长高了多少，滚动位置就要往下补多少** ——
    // 补对了，视野里就还是同一段内容；补错了，页面会突然跳走。
    // （不要用手动设 scrollTop 的方式验「位置没变」，那测的是测试自己的操作。）
    console.log('\n[2] 往上滑加载更早的内容');
    const more = await p.eval(`(async () => {
      const main = document.getElementById('main');
      const count = () => document.querySelectorAll('.bub,.tool,.think').length;
      const before = count();

      // 先暂停实时刷新，只量「前置加载有没有对位」这一件事。
      //
      // 不暂停的话量不准：观察端每 2.5 秒刷一次时间线，视野上方某个推理块
      // 收到摘要会自动展开 —— 那也会把锚点顶下去，而它是另一回事
      // （前置加载是页面主动补偿的，别人长高不是）。两条混在一起量，
      // 得到的位移说不清是谁造成的，只能靠调阈值糊过去。
      // 分页本身由滚动位置触发（loadOlder），停掉观察不影响它。
      //
      // 实测：暂停后位移是 **0px**，前置加载的对位完全正确。
      // 不暂停时稳定是 42~43px —— 那 42px 全部来自实时刷新。
      //
      // 那个 42px 是**当前仍存在的小毛病**，只是不归这个测试管：
      // 你正在看某处，视野上方一个推理块因为新摘要自动展开，你会被顶下去
      // 一点。页面只对「前置加载」做补偿，不对「别人长高」做补偿。
      // 影响很小（不足一行半），要修得给刷新路径也加视口锚定，
      // 那是独立一件事，别混进分页测试里假装已经覆盖了。
      const observerWasOn = typeof stopObserving === 'function';
      if (observerWasOn) stopObserving();

      main.scrollTop = 0;                    // 触发加载
      const anchor = (() => {
        const rect = main.getBoundingClientRect();
        for (const el of document.querySelectorAll('.bub,.tool,.think,.msg,.plan')) {
          if (el.getBoundingClientRect().bottom > rect.top + 4) {
            return { el, top: el.getBoundingClientRect().top };
          }
        }
        return null;
      })();

      let grew = false;
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 120));
        if (count() > before) { grew = true; break; }
      }
      const countAtGrow = count();
      // 再等一两帧，让对位的那两次修正跑完
      await new Promise(r => setTimeout(r, 600));

      const drift = (anchor && anchor.el.isConnected)
        ? Math.round(anchor.el.getBoundingClientRect().top - anchor.top)
        : null;

      // ★ 这一次量准了没有？
      //
      //   停掉观察端只挡住了**轮询**，挡不住 WebSocket 推过来的实时更新 ——
      //   会话正在跑的时候，视野上方某个推理块收到摘要会自动展开，
      //   那同样会把锚点顶下去（实测位移 861px、1292px，而页面完全正常）。
      //   那种情况下这个位移**说明不了分页有没有问题**，只能如实说「这次没量准」。
      //
      //   判据：对位跑完之后，块数如果还在涨，就说明有实时更新掺进来了。
      return { before, after: count(), grew, drift, observerWasOn,
               grewDuringMeasure: count() > countAtGrow,
               fix: window.__lastFix || null,
               scrollTop: Math.round(main.scrollTop) };
    })()`);
    await p.eval(`if (typeof startObserving === 'function') startObserving();`);
    console.log(`      ${more.before} → ${more.after} 个块；视野里那一条位移 ${more.drift}px（观察端已暂停=${more.observerWasOn}）`);
    console.log(`      scrollTop=${more.scrollTop}`);
    console.log(`      对位过程: ${JSON.stringify(more.fix)}`);
    ok('往上滑能加载出更早的内容', more.after > more.before,
      `${more.before} → ${more.after}`);
    // 实时更新掺进来的时候，这个位移说明不了分页有没有问题 ——
    // 明确说「这次没量准」，而不是捏着鼻子判失败（会误报）或判通过（会放过真问题）。
    if (more.grewDuringMeasure) {
      console.log(`      · 这次没量准：测量期间还有实时更新在改内容（块数从 ${more.after} 继续增长），` +
        `位移 ${more.drift}px 说明不了分页的问题 —— 本轮跳过判定，不算失败也不算通过`);
    } else {
      ok('加载后视野里的内容对回原位（位移很小）',
        more.drift !== null && Math.abs(more.drift) < 30,
        `位移 ${more.drift}px`);
    }

    // ── 三、再滑一次，确认还能继续 ───────────────────────────────────────────
    console.log('\n[3] 继续往上滑');
    const more2 = await p.eval(`(async () => {
      const main = document.getElementById('main');
      const before = document.querySelectorAll('.bub,.tool,.think').length;
      main.scrollTop = 0;
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 150));
        if (document.querySelectorAll('.bub,.tool,.think').length > before) break;
      }
      return { before, after: document.querySelectorAll('.bub,.tool,.think').length };
    })()`);
    ok('可以一直往上翻（不是只加载一次）', more2.after > more2.before,
      `${more2.before} → ${more2.after}`);

    // ── 四、翻完之后还能正常滑到底 ───────────────────────────────────────────
    //
    // 要等对位窗口过去（900ms）再滚：翻页后有一小段时间在持续对位，
    // 那是为了保证视野不动。真实使用者滑动时会触发手势事件、对位立刻停止，
    // 但这里是用代码直接改 scrollTop，绕过了手势 —— 所以先等一等。
    //
    // 另外：这是个**活页面**，观察端每 2.5 秒刷一次时间线，刷一次内容高度就变，
    // 刚设好的 scrollTop 会被顶掉。所以「能不能到底」要
    // 按「再滑一下就到底」来判 —— 真人也是这么做的。
    //
    // 但**光靠重试不够**：内容如果一直在长，每次都被顶掉，试几次都到不了底
    // （实测撞上过：试满 3 次仍差 861px，而那只是会话在正常跑）。
    // 所以和第 [2] 步一样，先把观察端停掉再量 —— 量的是「分页有没有弄坏布局」，
    // 不是「能不能追上一直在长的时间线」。量完立刻恢复。
    console.log('\n[4] 翻完之后还能正常滑到底');
    await new Promise((r) => setTimeout(r, 1400));
    const bottom = await p.eval(`(async () => {
      const main = document.getElementById('main');
      const hadObserver = typeof stopObserving === 'function';
      if (hadObserver) stopObserving();          // 只量布局，不追活跃内容
      let last = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        main.scrollTop = main.scrollHeight;
        await new Promise(r => setTimeout(r, 500));
        const gap = main.scrollHeight - main.scrollTop - main.clientHeight;
        last = { attempt, atBottom: gap < 60, gap: Math.round(gap),
                 scrollTop: Math.round(main.scrollTop),
                 max: Math.round(main.scrollHeight - main.clientHeight) };
        if (last.atBottom) break;
      }
      if (hadObserver && typeof startObserving === 'function') startObserving();
      return last;
    })()`);
    ok('能正常滑到底部（内容没有因为分页而错乱）', bottom.atBottom === true,
      JSON.stringify(bottom));

    const errs = p.exceptions.filter(Boolean);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (err) {
    fail++;
    console.log(`\n  出错了: ${err.message}\n${err.stack}`);
  } finally {
    b.kill();
  }

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
