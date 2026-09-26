// 进门证明：给「自己不会证明」的页面用（codex.html / go.html）。
//
// 为什么需要单独一份：发送成功却无法查看输出时，曾定位到设备证明缺失。
// 挑战应答开成真拦之后，没证明过的设备只拿得到页面和脚本。而证明这件事原来只有
// 两个地方会做，正好漏了两页：
//
//   · **DSH 应用页** —— 我们注入的 route.js 会证 ✓
//   · **codex.html** —— 靠 e2ee.js 的 prove()，但那是**新版**才有的；
//     手机上缓存着旧 e2ee.js 的时候，这一页永远证不了 → 整页 403 ✗
//   · **go.html** —— 它只引了 i18n.js，**从来没有人证过**（连新版也一样）→
//     它的 /__targets 必被 403 ✗
//
// 这一份补这两个洞，而且**必须对旧客户端也管用**：只用 e2ee.js 里一直就有的
// `authResponse`（HKDF + HMAC），不去调新版才有的 prove()。
//
// 三件事：
//   1. 页面一加载就证一次（趁着页面自己的请求还没被拦/正在被等待）；
//   2. 被拦了（403 + x-dsh-need-proof）自动补证并**重发那条请求** —— 网关重启、
//      12 小时过期之后，开着的页面能自己缓过来，不用人手动刷新；
//   3. 每 4 小时续一次（证明在网关内存里，会过期）。
//
// 三条自我约束（和 e2ee.js 里那套一致）：证不了绝不影响页面其它功能；
// 同一时刻只证一次；不跟自己的包装打架。
'use strict';

(function (global) {
  var REFRESH_MS = 4 * 60 * 60 * 1000;     // 4 小时续一次（网关那边 12 小时过期）
  var RECHECK_MS = 20 * 60 * 1000;
  var state = { ok: false, at: 0, inflight: null, lastForced: 0 };

  function b64url(bytes) {
    try {
      if (global.DshE2EE && global.DshE2EE.bytesToB64url) return global.DshE2EE.bytesToB64url(bytes);
    } catch (e) { }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function secret() {
    try { return global.__dshE2eeSecret || null; } catch (e) { return null; }
  }

  function ready() {
    return !!(global.DshE2EE && global.DshE2EE.authResponse && global.crypto &&
      global.crypto.getRandomValues);
  }

  function nonce() {
    var b = new Uint8Array(24);
    try { global.crypto.getRandomValues(b); } catch (e) {
      for (var i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    }
    return b64url(b);
  }

  /** 一个来回：手机自己出随机数 + 时间戳 */
  function oneShot(sec) {
    var n = nonce();
    var ts = Date.now();
    return global.DshE2EE.authResponse(sec, ts + '|' + n).then(function (response) {
      return global.fetch('/__auth/verify', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ts: ts, nonce: n, response: response })
      });
    }).then(function (r) { return r.json(); })
      .then(function (v) { return v || { ok: false }; })
      .catch(function () { return { ok: false, code: 'network' }; });
  }

  /** 老路：先取挑战再交应答（网关是旧版、或者手机时间不对时靠它） */
  function legacy(sec) {
    return global.fetch('/__auth/challenge', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.nonce) throw new Error('no-nonce');
        return global.DshE2EE.authResponse(sec, j.nonce).then(function (response) {
          return global.fetch('/__auth/verify', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ nonce: j.nonce, response: response })
          });
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (v) { return !!(v && v.ok); })
      .catch(function () { return false; });
  }

  function prove(force) {
    var now = Date.now();
    if (state.inflight) return state.inflight;
    if (!force && state.ok && (now - state.at) < REFRESH_MS) return Promise.resolve(true);
    if (force && state.ok && (now - state.lastForced) < 3000) return Promise.resolve(true);
    var sec = secret();
    if (!sec || !ready()) return Promise.resolve(false);
    if (force) state.lastForced = now;

    state.inflight = oneShot(sec).then(function (v) {
      if (v && v.ok) return true;
      return legacy(sec);
    }).then(function (ok) {
      if (ok) { state.ok = true; state.at = Date.now(); }
      return ok;
    }).catch(function () { return false; })
      .then(function (ok) { state.inflight = null; return ok; });
    return state.inflight;
  }

  /** 被拦了：补证 + 把原来那条请求重发一次（只重发 body 还能再发的） */
  function isNeedProof(res) {
    try {
      return !!(res && res.status === 403 && res.headers && res.headers.get &&
        res.headers.get('x-dsh-need-proof') === '1');
    } catch (e) { return false; }
  }
  function canReplay(init) {
    if (!init || init.body == null) return true;
    var b = init.body;
    return typeof b === 'string' ||
      (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) ||
      (typeof FormData !== 'undefined' && b instanceof FormData) ||
      (typeof Blob !== 'undefined' && b instanceof Blob) ||
      (typeof ArrayBuffer !== 'undefined' && (b instanceof ArrayBuffer || ArrayBuffer.isView(b)));
  }
  function installRetry() {
    var orig = global.fetch;
    if (!orig || orig.__dshProveRetry) return;
    var wrapped = function (input, init) {
      var self = this;
      var reqObj = (typeof Request !== 'undefined' && input instanceof Request);
      return orig.apply(self, arguments).then(function (res) {
        if (!isNeedProof(res)) return res;
        // ★ 服务端说「你没证明」—— 那我们本地那份「我证过了」就是错的，
        //   必须先作废再补证。否则 prove(true) 会被「三秒内不重复强证」挡掉，
        //   重发出去的还是那条 403，页面就一直坏到手动刷新为止。
        //   （网关重启、12 小时过期都会走到这里。）
        state.ok = false;
        return prove(true).then(function (ok) {
          if (!ok || reqObj || !canReplay(init)) return res;
          return orig.call(self, input, init);
        });
      });
    };
    wrapped.__dshProveRetry = true;
    global.fetch = wrapped;
  }

  function boot() {
    installRetry();
    var tries = 0;
    (function wait() {
      if (secret() && ready()) { prove(true); return; }
      if (++tries > 60) return;          // 最多等 15 秒（页面脚本可能晚一点才到）
      setTimeout(wait, 250);
    })();
    try {
      setInterval(function () {
        if (global.document && global.document.visibilityState === 'visible') prove(false);
      }, RECHECK_MS);
    } catch (e) { }
  }

  global.DshProve = { prove: prove, state: function () { return { ok: state.ok, at: state.at }; } };
  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
