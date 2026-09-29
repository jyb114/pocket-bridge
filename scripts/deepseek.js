// DeepSeek 账户余额 —— 让使用者知道还剩多少钱，好及时充值。
//
// 为什么放在网关里而不是手机端直接调：API key 只在这台电脑上。
// 手机端永远拿不到它（跟 Codex 的凭据一样），网关代查、只回余额数字。
'use strict';
const fs = require('fs');

// 凭据放在哪**不能写死**：DSH 已经搬过一次家 ——
//   旧版：%APPDATA%\DeepSeek Harness Desktop\harness-home\.credentials.yaml
//   新版（0.1.7+）：~/.dsh/.credentials.yaml
// 写死的后果就在这里：电脑控制台余额显示「查不到」，手机端的余额提示也一起消失，
// 而报错只有一行 ENOENT —— 看着像网络问题或账号问题，实际是路径。
// 复用 first-run.js 那份**版本无关**的候选清单（已知位置全落空时它还会做一次有界扫描）。
const { credentialCandidates } = require('./first-run.js');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (err) { return false; } };

let credFileCache = null;
/** 当前实际存在的那份凭据文件；找不到返回 null。 */
function credentialFile() {
  if (credFileCache && isFile(credFileCache)) return credFileCache;
  credFileCache = credentialCandidates().find(isFile) || null;
  return credFileCache;
}

/**
 * 从 DSH 的凭据文件里读出「怎么查余额」。
 *
 * ★ 新旧版是**两套完全不同的模型**，所以两条路都得认：
 *
 *   旧版：refs/records 里一个 `sk-` 开头的 API key
 *         → GET https://api.deepseek.com/user/balance + Authorization: Bearer
 *   新版（0.1.7+）：`deepseek-account-platform/default` 记录里的**账号 token**
 *         → GET <issuer>/api/v0/users/get_user_summary + 头 x-dsh-auth-token
 *         实测新版凭据里**根本没有 API key 了**，只有 token 和 issuer
 *         （格式与接口取自 DSH 自己：app.asar 里 getBalance 就是这么发的）
 *
 * 文件很小，不值得为它引一个 YAML 库 —— 手写一个只认两级的解析就够：
 * 新版那层嵌套（records → deepseek-account-platform/default → payload → token）
 * 落到这里正好是平铺的键值，token 和 issuer 都取得到。
 */
function readCredential() {
  const file = credentialFile();
  if (!file) {
    return {
      error: '没找到 DSH 的凭据文件（新版在 ~/.dsh/.credentials.yaml，' +
        '旧版在 AppData\\DeepSeek Harness Desktop\\harness-home）'
    };
  }

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { return { error: `读不到凭据文件（${file}）：${err.message}` }; }

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

  // ① 旧版：API key
  let key = refs.DEEPSEEK_API_KEY || '';
  if (key && !/^sk-/.test(key) && records[key]) key = records[key];
  if (!key && records.DEEPSEEK_API_KEY) key = records.DEEPSEEK_API_KEY;
  if (key && /^sk-/.test(key)) return { kind: 'apiKey', key };

  // ② 新版：账号 token，以及它的签发来源
  const token = records.token || '';
  const issuer = records.issuer || '';
  if (token && issuer) {
    let origin = null;
    try { origin = new URL(issuer); } catch (err) { origin = null; }
    // ★ 只认 https，而且必须是一个**纯来源**（没有路径、查询、片段）。
    //   token 只会被发回它自己的签发方 —— 配置写错也送不到别处去，
    //   这一条是硬边界：账号 token 泄露比余额查不到严重得多。
    if (origin && origin.protocol === 'https:' && origin.pathname === '/' &&
      !origin.search && !origin.hash) {
      return { kind: 'accountToken', token, origin: origin.origin };
    }
    return { error: `凭据里的 issuer 不是可用的 https 来源：${issuer}` };
  }

  return { error: '凭据文件里既没有 API key，也没有可用的账号 token' };
}

/** 兼容旧名字：只返回 API key 那一种（新版凭据拿不到，会带上说明）。 */
function readApiKey() {
  const c = readCredential();
  if (c.kind === 'apiKey') return { key: c.key };
  return { key: null, error: c.error || '这份凭据是账号 token，不是 API key' };
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

// 查得太频繁没意义（余额不会秒变），而且平白多打一次接口
const CACHE_MS = 60 * 1000;
let cache = null;

/**
 * 查余额。60 秒内重复调用直接给缓存 —— 使用者连点几下不该打好几次接口。
 *
 * 新旧两版走不同的接口，但对外返回的形状是同一个，界面不用改。
 */
async function balance(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const cred = readCredential();
  if (cred.error) return { ok: false, error: cred.error };

  // 注意：Node 的 fetch 不读系统代理（Windows 上那个是给 WinHTTP/浏览器用的），
  // 所以这里要显式告诉它走哪。Codex 那边踩过一模一样的坑。
  const opts = {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  };
  let url;
  if (cred.kind === 'apiKey') {
    url = 'https://api.deepseek.com/user/balance';
    opts.headers.authorization = `Bearer ${cred.key}`;
  } else {
    // 新版：token 只发回它自己的签发来源（readCredential 已经校验过是纯 https 来源）
    url = `${cred.origin}/api/v0/users/get_user_summary`;
    opts.headers['x-dsh-auth-token'] = cred.token;
  }

  const px = proxyAgent();

  let res, text;
  try {
    res = await fetch(url, opts);
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      error: `连不上 ${new URL(url).host}（${err.message}）` +
        (px ? `。这台机器配了代理 ${px.host}:${px.port}，但查询没走代理` : '')
    };
  }

  // 401 单说 —— 那说明账号凭据过期了，要在 DSH 里重新登录，不是余额查不到
  if (res.status === 401) {
    return { ok: false, error: '账号凭据已失效，请在电脑上的 DSH 里重新登录' };
  }
  if (!res.ok) return { ok: false, error: `${new URL(url).host} 返回 HTTP ${res.status}` };

  let j;
  try { j = JSON.parse(text); }
  catch (err) { return { ok: false, error: '余额返回读不出来' }; }

  let value;
  if (cred.kind === 'apiKey') {
    const info = (j.balance_infos || [])[0] || {};
    value = {
      available: !!j.is_available,
      currency: info.currency || 'CNY',
      total: Number(info.total_balance || 0),
      granted: Number(info.granted_balance || 0),
      toppedUp: Number(info.topped_up_balance || 0)
    };
  } else {
    // 新版 DSH 自己的口径：normal_wallets 是充值余额，bonus_wallets 是赠金。
    //
    // ★ 响应是**包了三层**的：
    //     { code, msg, data: { biz_code, biz_msg, biz_data: { normal_wallets: [...] } } }
    //   DSH 自己那个 requestAccount 会先剥到 biz_data，所以它的 schema 是平的；
    //   我们是直接打接口，得自己剥 —— 漏了这一步的表现是「余额永远显示 0」，
    //   而且**看起来还挺正常**（实测就是这么踩到的：真实余额 12.39 被读成 0，
    //   界面既不报错也不提示，只是数字不对）。
    if (j.code !== 0 || (j.data && j.data.biz_code !== 0)) {
      const msg = (j.data && j.data.biz_msg) || j.msg || `code=${j.code}`;
      return { ok: false, error: `账号接口返回错误：${msg}` };
    }
    const payload = (j.data && j.data.biz_data) || j;
    const first = (list) => (Array.isArray(list) && list[0]) || {};
    const normal = first(payload.normal_wallets);
    const bonus = first(payload.bonus_wallets);
    const toppedUp = Number(normal.balance || 0);
    const granted = Number(bonus.balance || 0);
    value = {
      available: true,
      currency: normal.currency || bonus.currency || 'CNY',
      total: toppedUp + granted,
      granted,
      toppedUp
    };
  }
  value.ok = true;
  value.at = Date.now();
  // 低余额要显眼 —— 这个功能的意义就是「别等到用不了了才发现」
  value.low = value.total < 10;
  value.empty = value.total <= 0;

  cache = { at: Date.now(), value };
  return value;
}

module.exports = { balance, readApiKey, readCredential, credentialFile };
