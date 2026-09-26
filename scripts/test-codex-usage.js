// Codex 额度 —— 文案口径与本地用量统计的测试。
//
// 只测**纯函数**部分（describe / localDay），不连 app-server：
//   1. 不依赖 Codex 是否在跑，任何人都能跑
//   2. 不碰使用者的账号 —— 这个项目已经有一条铁规矩：
//      不许拿他的账号做实验（见 test-guard.js）
//
// 要守住的两件事：
//   · 百分比文案不能自相矛盾（大数字是 100% 时，说明里不该再写一遍）
//   · 本地用量按**本地日期**算，不是 UTC —— 上游的日桶是 UTC，
//     混用会得出「今天用了 0」这种假结论
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const cu = require('./codex-usage.js');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); }
};

(async () => {
  console.log('\n=== Codex 额度 · 文案与本地统计 ===\n');

  // ── 1. describe()：额度百分比怎么说人话 ──────────────────────────────────
  console.log('[1] 额度文案');

  const none = cu.describe(null);
  ok('没有额度数据时返回 null（而不是编一个 0%）', none === null, JSON.stringify(none));

  const mid = cu.describe({ usedPercent: 42, windowMins: 10080, resetsAt: null });
  ok('普通情况给出百分比', mid.pct === 42, String(mid.pct));
  ok('10080 分钟被说成 7 天', /7 天/.test(mid.windowLabel), mid.windowLabel);
  ok('语气是 ok', mid.tone === 'ok', mid.tone);

  const full = cu.describe({ usedPercent: 100, windowMins: 10080, reached: 'rate_limit_reached' });
  ok('用满时 pct 是 100', full.pct === 100, String(full.pct));
  ok('用满时标记 reached', full.reached === true);
  ok('用满时语气是 bad（界面标红）', full.tone === 'bad', full.tone);

  // ★ 这条是防「同一句话里说两遍 100%」——
  //   大数字已经显示 100% 了，说明里再写一次就是重复。
  ok('windowLabel 里不含百分比（大数字已经显示过了）',
    !/%/.test(full.windowLabel), full.windowLabel);
  ok('label 里含百分比（给只能放一行的地方用）', /100%/.test(full.label), full.label);

  const warn = cu.describe({ usedPercent: 85, windowMins: 300 });
  // 5 小时窗口是真实存在的（codex_bengalfox 就是），不能被算成「0 天」然后整段丢掉
  ok('不足一天的窗口按小时说，不说成「0 天」',
    /5 小时/.test(warn.windowLabel) && !/0 天/.test(warn.windowLabel), warn.windowLabel);
  ok('不足一天的窗口也说得出周期（不是空字符串）', warn.windowLabel !== '', warn.windowLabel);
  ok('label 里带上周期', /5 小时/.test(warn.label) && /85%/.test(warn.label), warn.label);

  const reset = cu.describe({ usedPercent: 10, windowMins: 10080, resetsAt: Math.floor(Date.now() / 1000) - 60 });
  ok('重置时间已过时说「马上重置」', reset.reset === '马上重置', reset.reset);

  const future = cu.describe({
    usedPercent: 10, windowMins: 10080,
    resetsAt: Math.floor(Date.now() / 1000) + 3600 * 5
  });
  ok('5 小时后重置时说「5 小时后重置」', /5 小时后重置/.test(future.reset), future.reset);

  // ── 2. localDay()：按本地日期统计 ────────────────────────────────────────
  console.log('\n[2] 本地每日用量');

  // 造一个假的 ~/.codex 目录，绝不碰使用者真实的那个
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-codex-'));
  const pad = (n) => String(n).padStart(2, '0');
  // 用一个「本地日期」和「UTC 日期」必然不同的时刻来验口径：
  // 取本地时间的 23:30，如果实现按 UTC 切分，它会被算到第二天去。
  const localNoon = new Date();
  const day = `${localNoon.getFullYear()}-${pad(localNoon.getMonth() + 1)}-${pad(localNoon.getDate())}`;
  const dir = path.join(fakeHome, '.codex', 'sessions', day.slice(0, 4), day.slice(5, 7), day.slice(8, 10));
  fs.mkdirSync(dir, { recursive: true });

  const ev = (isoLocalish, tokens) => JSON.stringify({
    timestamp: isoSelf(isoLocalish),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: tokens } },
      rate_limits: { primary: { used_percent: 55, resets_at: 1790000000 } }
    }
  });
  // 造一个「本地时间 = 当天 23:30」的 UTC 时间戳
  function isoSelf(_ignored) {
    const d = new Date();
    d.setHours(23, 30, 0, 0);
    return d.toISOString();
  }

  fs.writeFileSync(path.join(dir, 'rollout-fake.jsonl'),
    [ev(null, 1000), 'not json at all', JSON.stringify({ type: 'other' }), ev(null, 2500)].join('\n'),
    'utf8');

  const r = await cu.localDay(day, fakeHome);
  ok('找到了这一天的会话目录', r.exists === true);
  ok('统计了 1 个会话文件', r.files === 1, String(r.files));
  ok('两条 token_count 都算进去了', r.turns === 2, String(r.turns));
  ok('token 数是 1000 + 2500 = 3500', r.tokens === 3500, String(r.tokens));
  ok('坏行被跳过而不是让整天统计失败', r.tokens === 3500);
  ok('顺带拿到了最后的额度快照（离线也有「上次已知」）',
    !!(r.lastRateLimits && r.lastRateLimits.primary), JSON.stringify(r.lastRateLimits));

  // ★ 本地 23:30 的记录必须算在**本地今天**。
  //   如果实现按 UTC 日期过滤，这条会掉到明天去，结果是 0 —— 这正是
  //   上游日桶和本地目录对不上时会出现的那种假结论。
  ok('本地 23:30 的记录算在本地当天（不是按 UTC 切）', r.tokens === 3500,
    `本地时间 ${new Date().toString().slice(0, 24)}，时区偏移 ${-new Date().getTimezoneOffset() / 60} 小时`);

  const missing = await cu.localDay('1999-01-01', fakeHome);
  ok('不存在的日期返回 0 而不是抛异常',
    missing.tokens === 0 && missing.exists === false, JSON.stringify(missing));

  // 收尾：删掉假目录
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch (err) { }

  const real = await cu.localDay(day);
  ok('真实目录也能读（今天没用过就是 0，不该报错）',
    typeof real.tokens === 'number', JSON.stringify(real).slice(0, 120));

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
