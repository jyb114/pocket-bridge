// 查 Codex 的账户与额度 —— **只读**，不发任何消息。
//
// 为 Codex 单独展示账户额度用量，与 DeepSeek 余额区分。
//
// 先说清一个语义问题，否则界面一定会骗人：**Codex 走 ChatGPT 订阅，没有「余额」**。
// 能拿到的是「本周期额度用了几成 + 什么时候重置 + 今天用了多少 token」。
// 所以这里返回的字段叫 quota 而不是 balance，界面上也照实说「额度」。
//
// 怎么拿到的（实测，Codex CLI 0.154.0-alpha.6.2）：
//   account/read            → 邮箱、套餐
//   account/rateLimits/read → 本周期已用百分比、重置时间、credits
//   account/usage/read      → 累计 token、每日 token 桶
// 没有 account/balance 这一类方法 —— 把不存在的方法名发过去，报错会把全部
// 162 个合法方法名吐出来，表里确实没有金额相关的。
//
// 两个坑，都是实测踩到的：
//   1. account/usage/read 要实时去上游拉，**会超时**（第一次调常常失败，
//      成功一次之后走缓存就好了）。所以它必须重试，而且失败不该让整页报错。
//   2. 上游的「每日桶」按 **UTC** 切分，而本机时区不一定是 UTC。
//      这台机器是 UTC+12，服务端的最新桶比本地日期晚一天 ——
//      两个口径混着用会得出「今天用了 0」这种假结论。
//      所以「今天」一律用**本地会话文件**算，并且把这个口径写在返回值里。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
// 复用 codex-threads.js 里已经调通的 WebSocket 客户端。
// 自己再写一份的代价不是多几十行，而是把「握手没完成就发帧会被丢掉」
// 那个坑重踩一遍 —— 表现是 initialize 永远超时，看起来像对方不理你。
const { connect } = require('./codex-threads.js');

const TIMEOUT_MS = 20000;
const CACHE_MS = 3 * 60 * 1000;   // 额度不会秒变；别把上游打爆

let cache = { at: 0, value: null };

const pad = (n) => String(n).padStart(2, '0');
const localDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 走一遍 app-server，把账户/额度/用量都问回来。任何一项失败都不影响其余。 */
async function askAppServer(port) {
  let ws = null;
  const out = { account: null, quota: null, usage: null, errors: [] };
  try {
    ws = await connect(port);
    const pending = new Map();
    let nextId = 1;

    const callOnce = (method, params, ms) => new Promise((res) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); res(null); }, ms || TIMEOUT_MS);
      pending.set(id, (msg) => { clearTimeout(timer); res(msg); });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
    });

    ws.onMessage((text) => {
      let m; try { m = JSON.parse(text); } catch (e) { return; }
      if (m.method) return;                 // 通知，不关心
      const h = pending.get(m.id);
      if (h) { pending.delete(m.id); h(m); }
    });

    await callOnce('initialize', { clientInfo: { name: 'pocket-bridge-usage', version: '1.0.0' } }, 15000);

    // 上游慢就重试。第一次调失败是常态，不是账号有问题 ——
    // 报错原文是 "token usage profile fetch timed out"。
    const call = async (method, params, tries = 3) => {
      for (let i = 0; i < tries; i++) {
        const r = await callOnce(method, params);
        if (r && r.result) return r;
        if (i < tries - 1) await new Promise((x) => setTimeout(x, 1200));
      }
      return null;
    };

    const acct = await call('account/read');
    if (acct) out.account = acct.result.account || null;
    else out.errors.push({ key: 'errAccount' });

    const rl = await call('account/rateLimits/read');
    const R = rl && rl.result && rl.result.rateLimits;
    if (R) {
      const p = R.primary || {};
      out.quota = {
        usedPercent: typeof p.usedPercent === 'number' ? p.usedPercent : null,
        windowMins: p.windowDurationMins || null,
        resetsAt: p.resetsAt || null,
        credits: R.credits ? R.credits.balance : null,
        reached: R.rateLimitReachedType || null,
        planType: R.planType || null,
        // 按模型分组的次级额度（有些模型是 5 小时 + 7 天双窗口）
        byModel: Object.keys(rl.result.rateLimitsByLimitId || {}).map((k) => {
          const g = rl.result.rateLimitsByLimitId[k];
          return { id: k, name: g.limitName || null,
                   usedPercent: (g.primary || {}).usedPercent ?? null };
        })
      };
    } else {
      out.errors.push({ key: 'errQuota' });
    }

    const usage = await call('account/usage/read');
    const U = usage && usage.result;
    if (U) {
      const buckets = U.dailyUsageBuckets || [];
      out.usage = {
        lifetimeTokens: (U.summary || {}).lifetimeTokens ?? null,
        peakDailyTokens: (U.summary || {}).peakDailyTokens ?? null,
        // 服务端的桶按 UTC 切日期，跟本地日期不一定对得上 —— 原样给出，
        // 由调用方决定要不要用（界面上用的是本地口径）。
        newestBucket: buckets.length ? buckets[buckets.length - 1] : null,
        bucketTz: 'UTC'
      };
    } else {
      out.errors.push({ key: 'errUsage' });
    }
  } catch (err) {
    // 上游原样的报错：没法翻译，原样带出去（比吞掉强）
    out.errors.push({ raw: err.message });
  } finally {
    if (ws) ws.close();
  }
  return out;
}

/**
 * 从本地会话文件算某一天用了多少 token。
 *
 * 为什么不用服务端的每日桶：那是 UTC 日期，和「本地今天」差一截
 * （某些时区能差出整整一天）。界面上的“今天”按设备本地日期算。
 *
 * 顺带还能拿到最后一轮的 rate_limits 快照 —— app-server 连不上时，
 * 它就是「上次已知的额度」，比界面空白强。
 */
async function localDay(day, home = os.homedir()) {
  const [y, m, d] = day.split('-');
  const dir = path.join(home, '.codex', 'sessions', y, m, d);
  const out = { day, tokens: 0, turns: 0, files: 0, exists: false, lastRateLimits: null };

  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
  catch (err) { return out; }

  out.exists = true;
  out.files = names.length;

  for (const f of names) {
    let rl;
    try {
      rl = readline.createInterface({
        input: fs.createReadStream(path.join(dir, f), { encoding: 'utf8' }),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        // 先做一次廉价的字符串过滤，再 JSON.parse —— 会话文件动辄几 MB，
        // 每行都 parse 会明显拖慢网关。
        if (line.indexOf('"token_count"') < 0) continue;
        let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
        const p = ev.payload || {};
        if (p.type !== 'token_count') continue;
        // 目录按本地日期分，但 timestamp 是 UTC —— 统一按本地日期过滤
        if (ev.timestamp && localDateStr(new Date(ev.timestamp)) !== day) continue;
        const last = p.info && p.info.last_token_usage;
        if (last) { out.tokens += Number(last.total_tokens) || 0; out.turns += 1; }
        // 注意这里是 snake_case（used_percent / resets_at），
        // app-server 那边是 camelCase —— 两个源别混。
        if (p.rate_limits) out.lastRateLimits = p.rate_limits;
      }
    } catch (err) { /* 单个文件读坏了不该毁掉整天的统计 */ }
    finally { if (rl) rl.close(); }
  }
  return out;
}

// ── 这些文案要发给界面，所以分语言 ─────────────────────────────────────────
//
// `describe()` 产出的 label / reset、以及「读不到额度」这类错误，
// 都会经 /__codex/quota 显示在控制台上。服务端拼的字符串，页面的 t() 管不到 ——
// 英文手机上会看到整段中文（计划 H 的「各语言不混排」）。
const { pick, fill } = require('./server-lang.js');

const TEXT = {
  zh: {
    windowDays: '本周期（{n} 天）',
    windowHours: '本周期（{n} 小时）',
    windowMins: '本周期（{n} 分钟）',
    resetNow: '马上重置',
    resetHours: '{n} 小时后重置',
    resetDays: '{n} 天后重置（{m} 月 {d} 日）',
    used: '已用 {pct}%',
    reached: '已限流',
    errAccount: '读不到账户',
    errQuota: '读不到额度',
    errUsage: '读不到用量'
  },
  en: {
    windowDays: 'This window ({n} days)',
    windowHours: 'This window ({n} h)',
    windowMins: 'This window ({n} min)',
    resetNow: 'Resets now',
    resetHours: 'Resets in {n} h',
    resetDays: 'Resets in {n} days ({m}/{d})',
    used: '{pct}% used',
    reached: 'Rate limited',
    errAccount: 'Could not read the account',
    errQuota: 'Could not read the quota',
    errUsage: 'Could not read the usage'
  },
  es: {
    windowDays: 'Este periodo ({n} días)',
    windowHours: 'Este periodo ({n} h)',
    windowMins: 'Este periodo ({n} min)',
    resetNow: 'Se restablece ahora',
    resetHours: 'Se restablece en {n} h',
    resetDays: 'Se restablece en {n} días ({d}/{m})',
    used: '{pct} % usado',
    reached: 'Límite alcanzado',
    errAccount: 'No se pudo leer la cuenta',
    errQuota: 'No se pudo leer la cuota',
    errUsage: 'No se pudo leer el uso'
  }
};

function T(lang) { return pick(TEXT, lang); }

/**
 * 把 read() 攒下来的错误翻成人话。
 *
 * 为什么错误要存成 key 而不是拼好的字符串：`read()` 的结果**是带缓存的**
 * （三分钟），而语言在响应时才定。存拼好的中文，换个语言就会拿到
 * 上一个语言的缓存 —— 同一个坑在 targets.js 那边也踩过。
 *
 * 上游原样的报错（`{ raw }`）没法翻译，照原样带出去。
 */
function localizeErrors(errors, lang) {
  const M = T(lang);
  return (Array.isArray(errors) ? errors : []).map((e) => {
    if (typeof e === 'string') return e;               // 兼容旧形状
    if (e && e.raw) return String(e.raw);
    if (e && e.key && M[e.key]) return M[e.key];
    return e && e.key ? String(e.key) : '';
  }).filter(Boolean);
}

/** 把额度百分比说成人话 —— 界面直接用，免得两处各写一套口径 */
function describe(quota, lang) {
  const M = T(lang);
  if (!quota || quota.usedPercent === null || quota.usedPercent === undefined) return null;
  const pct = Math.round(quota.usedPercent);

  // 窗口长度的说法。
  // 用 Math.round(mins/1440) 会把 5 小时（300 分钟）算成 0 天，
  // 而 0 是假值 —— 于是周期长度被整段丢掉，界面上只剩一个光秃秃的百分比。
  // 有些模型的额度就是 5 小时窗口（实测 codex_bengalfox 就是），不是罕见情况。
  let windowLabel = '';
  if (quota.windowMins >= 1440) windowLabel = fill(M.windowDays, { n: Math.round(quota.windowMins / 1440) });
  else if (quota.windowMins >= 60) windowLabel = fill(M.windowHours, { n: Math.round(quota.windowMins / 60) });
  else if (quota.windowMins > 0) windowLabel = fill(M.windowMins, { n: quota.windowMins });

  let reset = '';
  if (quota.resetsAt) {
    const t = new Date(quota.resetsAt * 1000);
    const h = Math.round((t.getTime() - Date.now()) / 3600000);
    reset = h <= 0 ? M.resetNow
      : h < 48 ? fill(M.resetHours, { n: h })
        : fill(M.resetDays, { n: Math.round(h / 24), m: t.getMonth() + 1, d: t.getDate() });
  }

  return {
    pct,
    // label 是完整的一句话，给「只能放一行字」的地方用；
    // windowLabel 只有周期本身，给「百分比已经单独显示」的地方用 ——
    // 否则界面上会出现「100%　本周期已用 100%」这种重复。
    //
    // 注意语序：中文是「本周期（7 天）已用 100%」，英文是「100% used」——
    // 拼不出来的，所以 used 也整句成表，中文那句用 windowLabel + used 拼，
    // 英文那句自己带完整说法。
    label: windowLabel ? (lang === 'zh'
      ? windowLabel + fill(M.used, { pct })
      : fill(M.used, { pct }) + ' · ' + windowLabel)
      : fill(M.used, { pct }),
    windowLabel,
    reset,
    reached: !!quota.reached,
    reachedLabel: M.reached,
    tone: pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok'
  };
}

/** 带缓存地问一次。三分钟内重复调用直接给上次的结果。 */
async function read(port, force) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

  const value = await askAppServer(port);

  // 「今天」的 token 数。这一步纯本地读盘，不依赖上游。
  try { value.today = await localDay(localDateStr(new Date())); }
  catch (err) { value.today = null; }

  value.at = Date.now();
  cache = { at: value.at, value };
  return value;
}

module.exports = { read, askAppServer, localDay, describe, localizeErrors, CACHE_MS };

// ── 命令行 ───────────────────────────────────────────────────────────────────
//   node scripts/codex-usage.js            一行摘要
//   node scripts/codex-usage.js --json     给程序读的
//   node scripts/codex-usage.js --day 2026-09-15
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const di = args.indexOf('--day');
  const port = Number(process.env.CODEX_PORT || require('./targets.js').codex.port());

  let v;
  if (di >= 0) {
    // 只算某一天的本地用量，不连 app-server（离线可用）。
    // 这条分支要**先返回** —— 下面那个「没有 account/quota 就当成连不上」
    // 的守卫会让它永远打印「连不上 Codex」，哪怕数据已经算出来了。
    const day = args[di + 1] || localDateStr(new Date());
    const one = await localDay(day);
    if (args.includes('--json')) { console.log(JSON.stringify(one, null, 2)); return; }
    console.log(`本地 ${one.day}：${one.tokens} tokens / ${one.turns} 轮` +
      (one.exists ? `（${one.files} 个会话文件）` : '（这天没有会话目录）'));
    return;
  }
  v = await read(port, true);

  if (args.includes('--json')) { console.log(JSON.stringify(v, null, 2)); return; }

  if (!v.account && !v.quota) {
    console.log('连不上 Codex（app-server 没在跑？先在托盘里启动 Codex）');
    if (v.errors && v.errors.length) console.log('  ' + localizeErrors(v.errors, 'zh').join('；'));
    return;
  }
  if (v.account) console.log(`账号 ${v.account.email || '—'}　套餐 ${v.account.planType || '—'}`);
  const d = describe(v.quota);
  if (d) {
    console.log(`额度 ${d.label}　${d.reset}` + (d.reached ? '　【已限流】' : ''));
    if (v.quota.credits !== null && v.quota.credits !== undefined) {
      console.log(`credits 余额 ${v.quota.credits}`);
    }
  } else {
    console.log('额度 读不到' + (v.errors && v.errors.length ? `（${localizeErrors(v.errors, 'zh').join('；')}）` : ''));
  }
  if (v.usage) console.log(`累计 ${v.usage.lifetimeTokens} tokens　峰值日 ${v.usage.peakDailyTokens}`);
  if (v.today) {
    console.log(`今天（本地 ${v.today.day}）${v.today.tokens} tokens / ${v.today.turns} 轮` +
      (v.today.exists ? `　${v.today.files} 个会话文件` : '　今天还没用过'));
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
