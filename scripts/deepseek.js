// DeepSeek 账户余额 —— 让使用者知道还剩多少钱，好及时充值。
//
// 为什么放在网关里而不是手机端直接调：API key 只在这台电脑上。
// 手机端永远拿不到它（跟 Codex 的凭据一样），网关代查、只回余额数字。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CRED_FILE = path.join(os.homedir(), 'AppData', 'Roaming',
  'DeepSeek Harness Desktop', 'harness-home', '.credentials.yaml');

// 查得太频繁没意义（余额不会秒变），而且平白多打一次接口
const CACHE_MS = 60 * 1000;
let cache = null;

/**
 * 从 DSH 的凭据文件里取 API key。
 *
 * 文件很小，不值得为它引一个 YAML 库 —— 手写一个只认「refs:」和「records:」
 * 两段的解析就够了。key 可能直接写在 refs 里，也可能是个指向 records 的引用，
 * 两种情况都兜住。
 */
function readApiKey() {
  let raw;
  try { raw = fs.readFileSync(CRED_FILE, 'utf8'); }
  catch (err) { return { key: null, error: `读不到凭据文件：${err.message}` }; }

  const refs = {}, records = {};
  let section = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { section = 'refs'; continue; }
    if (/^records:\s*$/.test(line)) { section = 'records'; continue; }
    if (/^[a-zA-Z]/.test(line)) { section = null; continue; }
    const m = line.match(/^\s+([A-Za-z0-9_.\-/]+):\s*(.*)$/);
    if (!m || !section) continue;
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    (section === 'refs' ? refs : records)[m[1]] = val;
  }

  let key = refs.DEEPSEEK_API_KEY || '';
  if (key && !/^sk-/.test(key) && records[key]) key = records[key];
  if (!key && records.DEEPSEEK_API_KEY) key = records.DEEPSEEK_API_KEY;

  if (!key || !/^sk-/.test(key)) {
    return { key: null, error: '凭据文件里没找到可用的 DeepSeek API key' };
  }
  return { key };
}

/** 系统代理 —— 这台机器上 DeepSeek 的接口要走它 */
function proxyAgent() {
  const raw = (process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: Number(u.port) || 8080 };
  } catch (err) { return null; }
}

/**
 * 查余额。60 秒内重复调用直接给缓存 —— 使用者连点几下不该打好几次接口。
 */
async function balance(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const { key, error } = readApiKey();
  if (!key) return { ok: false, error };

  // 注意：Node 的 fetch 不读系统代理（Windows 上那个是给 WinHTTP/浏览器用的），
  // 所以这里要显式告诉它走哪。Codex 那边踩过一模一样的坑。
  const opts = {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  };
  const px = proxyAgent();
  if (px && typeof require('undici') === 'object') {
    // Node 内置 fetch 就是 undici，但它没暴露 ProxyAgent 给我们引 ——
    // 手上没有依赖可用，所以退一步：直接连，失败时把话说清楚
  }

  let res, text;
  try {
    res = await fetch('https://api.deepseek.com/user/balance', opts);
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      error: `连不上 DeepSeek（${err.message}）` +
        (px ? `。这台机器配了代理 ${px.host}:${px.port}，但查询没走代理` : '')
    };
  }

  if (!res.ok) return { ok: false, error: `DeepSeek 返回 HTTP ${res.status}` };

  let j;
  try { j = JSON.parse(text); }
  catch (err) { return { ok: false, error: '余额返回读不出来' }; }

  const info = (j.balance_infos || [])[0] || {};
  const value = {
    ok: true,
    available: !!j.is_available,
    currency: info.currency || 'CNY',
    total: Number(info.total_balance || 0),
    granted: Number(info.granted_balance || 0),
    toppedUp: Number(info.topped_up_balance || 0),
    at: Date.now()
  };
  // 低余额要显眼 —— 这个功能的意义就是「别等到用不了了才发现」
  value.low = value.total < 10;
  value.empty = value.total <= 0;

  cache = { at: Date.now(), value };
  return value;
}

module.exports = { balance, readApiKey, CRED_FILE };
