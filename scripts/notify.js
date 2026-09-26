// 推送通知 —— 抽出来单独一个模块，因为**启动器也要用**。
//
// 场景：Cloudflare 免费隧道的地址每次重启都会变。电脑一重启，使用者书签里的
// 地址就失效了 —— 而他连不上，自然也看不到控制台，没有办法知道新地址。
//
// 这时候唯一还能把消息送到他手机上的，就是 ntfy / Bark 它们自己的推送通道：
// 那条路不经过我们的网关，所以「连不上的时候」正是它还能工作的时候。
//
// 只做 ntfy 和 Bark，不做 Web Push —— 后者的订阅信息存在本机，
// 而我们要解决的恰恰是「本机这条链路不可达」。原生 App 推送才靠得住。
'use strict';
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const TARGETS_FILE = path.join(LOG_DIR, 'notify-targets.json');

/** 读通道配置。每次推送都重新读 —— 改完不用重启。 */
function loadTargets() {
  try { return JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8')); }
  catch (err) { return {}; }
}

/**
 * 推送目标记着的语言。
 *
 * 为什么必须**存**在配置里：发完成通知的是空闲检测那条定时器，
 * 它没有请求上下文，拿不到 Accept-Language / cookie。
 * 而通知的标题正文是服务端拼的 —— 不存的话，英文使用者收到的永远是中文
 * （计划 H 的「各语言不混排」）。
 *
 * 语言在**配置推送通道那一步**写进去（那一步是有请求上下文的），
 * 之后每次推送读出来用。
 */
function targetLang() {
  const t = loadTargets();
  return require('./server-lang.js').norm(t.lang);
}

/**
 * 推一条通知。返回每个通道的结果，方便调用方判断有没有送达。
 * @returns {Promise<Array<{channel:string, ok?:boolean, status?:number, error?:string}>>}
 */
async function send(title, body) {
  const t = loadTargets();
  const out = [];
  const timeout = () => AbortSignal.timeout(10000);

  // Bark（iOS）：路径式 API，标题和正文都在 URL 里
  if (t.bark) {
    try {
      const base = String(t.bark).replace(/\/+$/, '');
      const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}` +
        '?group=dsh&level=timeSensitive';
      const res = await fetch(url, { signal: timeout() });
      out.push({ channel: 'bark', status: res.status, ok: res.ok });
    } catch (err) {
      out.push({ channel: 'bark', error: err.message });
    }
  }

  // ntfy（安卓 / iPhone 都行）
  if (t.ntfy) {
    try {
      // 注意：HTTP 头只能是 ASCII。中文标题放进 Title 头会让 fetch 抛
      // 「Cannot convert argument to a ByteString」—— 中文用户的通知就永远发不出去。
      // 所以标题走查询参数，它允许 URL 编码。
      const base = String(t.ntfy).split('?')[0];
      const url = `${base}?title=${encodeURIComponent(title)}&tags=robot`;
      const res = await fetch(url, {
        method: 'POST',
        body,
        signal: timeout()
      });
      out.push({ channel: 'ntfy', status: res.status, ok: res.ok });
    } catch (err) {
      out.push({ channel: 'ntfy', error: err.message });
    }
  }

  return out;
}

/** 有没有配任何通道 */
function configured() {
  const t = loadTargets();
  return !!(t.bark || t.ntfy);
}

module.exports = { send, configured, loadTargets, targetLang, TARGETS_FILE };
