// 端到端加密 —— 浏览器这一侧。
//
// 和 scripts/e2ee.js（电脑侧）配对。**两边必须算出完全相同的结果**，
// 否则一条消息都解不开。所以两边都严格按标准来：
//   · HKDF  —— RFC 5869
//   · AES-GCM —— NIST SP 800-38D
// 一个字节都不自定义。
//
// 为什么密钥可以放在网址的 # 后面：
//   浏览器有个硬规矩 —— **地址里 # 之后的内容永远不发给服务器**。
//   所以密钥是你自己在书签里带着的，隧道从头到尾没见过它。
//
// 注意：crypto.subtle 只在**安全上下文**可用（HTTPS / localhost）。
// 内网明文 http://192.168.1.3:8080 上拿不到它 —— 那条路只能不加密。
(function (global) {
  'use strict';

  var SLOT_MS = 30 * 60 * 1000;

  function slotAt(now) {
    return Math.floor((now || Date.now()) / SLOT_MS);
  }

  function b64urlToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    var s = '';
    var b = new Uint8Array(bytes);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function subtle() {
    if (!global.crypto || !global.crypto.subtle) {
      throw new Error('这个地址不是安全上下文（需要 HTTPS），浏览器不给用加密接口');
    }
    return global.crypto.subtle;
  }

  /** 这个页面能不能做加密 */
  function available() {
    return !!(global.crypto && global.crypto.subtle && global.crypto.getRandomValues);
  }

  /**
   * 算一次「挑战应答」—— 证明我知道 # 里那串，但不把它发出去。
   *
   * 为什么需要它：访问密钥写在网址**路径**里，而路径是 HTTP 请求行的一部分，
   * 隧道（TLS 终点）看得见。它把那条请求自己发一遍就能冒充登录。
   * 而 # 后面这串隧道**从来没见过**（浏览器根本不发 fragment，实测过）。
   * 所以用它来做「进门凭证」，隧道就进不来了。
   *
   * 参数必须和电脑端**一个字都不差**（scripts/mobile-proxy.js 的 authKeyOf、
   * 以及 scripts/test-challenge-response.js 里验证过的那套）：
   *   salt = 'dsh-gw-auth'   info = 'dsh-gw|auth|v1'
   * 用不同的 salt/info 派生，是为了**密钥分离** ——
   * 认证钥匙和加密钥匙是两把，一边泄露不连累另一边。
   */
  async function authResponse(longTermSecret, nonce) {
    var s = subtle();
    var keyBytes = await hkdf(enc.encode(longTermSecret), enc.encode('dsh-gw-auth'),
      'dsh-gw|auth|v1', 32);
    var hmacKey = await s.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign']);
    var sig = await s.sign({ name: 'HMAC' }, hmacKey, enc.encode(String(nonce)));
    return bytesToB64url(new Uint8Array(sig));
  }

  /** HKDF-SHA256，和 Node 的 crypto.hkdfSync 结果一致 */
  async function hkdf(ikmBytes, saltBytes, info, len) {
    var s = subtle();
    var base = await s.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits']);
    var bits = await s.deriveBits({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: enc.encode(info)
    }, base, (len || 32) * 8);
    return new Uint8Array(bits);
  }

  /** 派生某个时间段的两把会话密钥（a: 手机→电脑，b: 电脑→手机） */
  async function deriveKeys(longTermSecret, slot) {
    var ikm = typeof longTermSecret === 'string' ? enc.encode(longTermSecret) : longTermSecret;
    var salt = enc.encode(String(slot));
    return {
      a: await hkdf(ikm, salt, 'dsh-gw|phone->pc|v1', 32),
      b: await hkdf(ikm, salt, 'dsh-gw|pc->phone|v1', 32)
    };
  }

  /** 解密时同时试当前和上一个时间段 —— 两边时钟不可能完全同步 */
  async function candidateKeys(longTermSecret, now) {
    var cur = slotAt(now);
    return [
      await deriveKeys(longTermSecret, cur),
      await deriveKeys(longTermSecret, cur - 1)
    ];
  }

  var keyCache = new Map();

  async function importAes(rawKey, forEncrypt) {
    var id = bytesToB64url(rawKey) + (forEncrypt ? '|e' : '|d');
    var hit = keyCache.get(id);
    if (hit) return hit;
    var k = await subtle().importKey('raw', rawKey, { name: 'AES-GCM' }, false,
      forEncrypt ? ['encrypt'] : ['decrypt']);
    keyCache.set(id, k);
    return k;
  }

  /**
   * 加密。返回 base64url 字符串，内容是 iv(12) + tag(16) + 密文
   * —— 和 Node 那边的 Buffer 布局一模一样。
   */
  async function encryptToB64(rawKey, plaintext) {
    var s = subtle();
    var iv = global.crypto.getRandomValues(new Uint8Array(12));
    var key = await importAes(rawKey, true);
    var ct = await s.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
    var ctB = new Uint8Array(ct);
    // WebCrypto 把 tag 追加在密文末尾；Node 那边是 iv|tag|body。
    // 这里转成 Node 的布局，两边才能互通。
    var tag = ctB.slice(ctB.length - 16);
    var body = ctB.slice(0, ctB.length - 16);
    var out = new Uint8Array(12 + 16 + body.length);
    out.set(iv, 0);
    out.set(tag, 12);
    out.set(body, 28);
    return bytesToB64url(out);
  }

  /**
   * 加密成**二进制**（同样是 iv(12) + tag(16) + 密文），给请求体用。
   *
   * 为什么不复用上面的 base64 版本：上传要发原始文件字节，base64 会把体积
   * 撑大三分之一 —— 20MB 的上传上限当场就爆了，而且报的是「文件太大」，
   * 看不出是编码撑出来的。
   */
  async function encryptBinaryWith(rawKey, u8) {
    var s = subtle();
    var iv = global.crypto.getRandomValues(new Uint8Array(12));
    var key = await importAes(rawKey, true);
    var ct = await s.encrypt({ name: 'AES-GCM', iv: iv }, key, u8);
    var ctB = new Uint8Array(ct);
    var tag = ctB.slice(ctB.length - 16);
    var body = ctB.slice(0, ctB.length - 16);
    var out = new Uint8Array(12 + 16 + body.length);
    out.set(iv, 0);
    out.set(tag, 12);
    out.set(body, 28);
    return out;
  }

  /**
   * 发一个**请求体也加密**的请求（响应方向不用管，见下）。
   *
   * 响应为什么不用管：installFetchDecrypt 已经接管了 fetch，凡是带
   * `x-dsh-e2ee: 1` 的响应都会自动解开、并把 content-type 还原回去
   * （含跨时间段的密钥重试）。所以调用方照旧 `res.json()` 就行。
   */
  async function encryptedFetch(secret, url, init) {
    init = init || {};
    if (!secret || init.body == null) return global.fetch(url, init);

    var bytes;
    if (typeof Blob !== 'undefined' && init.body instanceof Blob) {
      bytes = new Uint8Array(await init.body.arrayBuffer());
    } else if (init.body instanceof Uint8Array) {
      bytes = init.body;
    } else if (init.body instanceof ArrayBuffer) {
      bytes = new Uint8Array(init.body);
    } else {
      bytes = enc.encode(String(init.body));
    }

    var keys = await deriveKeys(secret, slotAt());
    var ct = await encryptBinaryWith(keys.a, bytes);

    var headers = Object.assign({}, init.headers || {});
    var origType = headers['content-type'] || headers['Content-Type'] || 'application/json; charset=utf-8';
    headers['content-type'] = 'application/octet-stream';
    headers['x-dsh-e2ee'] = '1';
    // 原始类型要带上：服务端解开之后要靠它把 content-type 还给 DSH
    headers['x-dsh-e2ee-type'] = origType;
    return global.fetch(url, Object.assign({}, init, { body: ct, headers: headers }));
  }

  /** 解密。失败返回 null，不抛异常。 */
  async function decryptFromB64(rawKey, b64) {
    var buf;
    try { buf = b64urlToBytes(b64); } catch (e) { return null; }
    if (buf.length < 28) return null;
    var iv = buf.slice(0, 12);
    var tag = buf.slice(12, 28);
    var body = buf.slice(28);
    // 还原成 WebCrypto 期望的「密文末尾跟 tag」
    var joined = new Uint8Array(body.length + 16);
    joined.set(body, 0);
    joined.set(tag, body.length);
    try {
      var key = await importAes(rawKey, false);
      var pt = await subtle().decrypt({ name: 'AES-GCM', iv: iv }, key, joined);
      return dec.decode(pt);
    } catch (e) {
      return null;
    }
  }

  // ── 从网址的 # 里取长期密钥 ─────────────────────────────────────────
  //
  // 为什么放在 # 后面：浏览器有个硬规矩 —— **地址里 # 之后的内容永远不发给服务器**。
  // 所以密钥是你书签里自己带着的，隧道从头到尾没见过它。
  //
  // 取完**不**把 # 从地址栏抹掉。理由见 secretFromUrl 里那段注释：
  // 抹掉会让「添加到主屏幕」和「加书签」存下一份没有密钥的地址，
  // 点开永远是空的 —— 图标删了重加多少次都没用。
  //
  // 还有一个容易被忽略的场景：手机浏览器刷新页面时，内存会清空，
  // 但 # 已经被我们抹掉。为此只把它存到 sessionStorage —— 它不会发给
  // 服务器、不会跨浏览器会话同步，也不会写进书签；仅用于同一台手机这次
  // 打开的页面刷新/切换回来后继续加密。
  var SESSION_SECRET_KEY = 'dsh-e2ee-secret-v1';
  // ★ 同一把钥匙在**持久**存储里也留一份（2026-09-24 加的）。
  //
  //   为什么必须持久：使用者的主屏图标打开后是「未加密」、而且**看不到任何任务**
  //   （日志：`WS 被拒：经中继但没要求加密`）—— 因为 iOS 把「添加到主屏幕」存成
  //   书签时**丢掉了 `#` 后面的片段**。地址里没有钥匙，页面就永远是明文的，
  //   经隧道时实时通道还会被直接拒掉。也就是说：**只要钥匙只存在于地址里，
  //   图标这条路就永远好不了**（地址栏留不留钥匙已经修过一轮，问题不在这儿）。
  //
  //   规则很克制：**只有你亲手打开过带 `#k=` 的链接，这台设备才会记住它** ——
  //   拿到钥匙的人本来就等于拿到了这台电脑。存进 localStorage（按来源隔离、
  //   不跨设备同步、不发给服务器），之后从图标/书签进来不再依赖地址里有没有钥匙。
  //
  //   代价如实说：以前关掉页面这把钥匙就没了（sessionStorage）；现在它会留在这台
  //   设备的浏览器存储里，直到你换钥匙或者清掉网站数据。换钥匙时不会有问题 ——
  //   新链接里的 `#k=` 永远优先，一旦打开就把旧的覆盖掉（见下面的取值顺序）。
  var PERSIST_SECRET_KEY = 'dsh-e2ee-secret-persist-v1';

  // 这把钥匙是**从哪来的**：'url'（地址里带进来的）还是 'stored'（这台设备存下的）。
  // 区别很重要：只有「本地存的那把可能过期」（电脑那边换过钥匙），
  // 地址里带进来的永远以它为准。见 maybeForgetStaleKey()。
  var secretSource = null;

  /**
   * 本地存的那把钥匙解不开东西时，把它丢掉并重载一次。
   *
   * 什么情况会走到这儿：电脑上「更换加密钥匙」之后，手机上存的那把就过期了 ——
   * 页面会显示成「已加密」却什么都解不开（登录状态还在，所以看起来只是空列表）。
   * 丢掉之后重载：地址里带新钥匙就用新的；没带就如实报「缺密钥」并给出修法。
   *
   * 三条自我约束：
   *   · **地址里带来的钥匙绝不动**（它是使用者亲手给的，比本地那份权威）；
   *   · 一次会话只自救一次（sessionStorage 里那个标记），免得来回重载；
   *   · 解成功之后把标记清掉 —— 否则下次真过期时就不救了。
   */
  var RELOAD_FLAG = 'dsh-e2ee-stale-reload-v1';

  function clearReloadFlag() {
    try { if (global.sessionStorage) global.sessionStorage.removeItem(RELOAD_FLAG); } catch (e) { }
  }

  function maybeForgetStaleKey() {
    if (secretSource !== 'stored') return false;
    try {
      if (global.sessionStorage && global.sessionStorage.getItem(RELOAD_FLAG)) return false;
      if (global.sessionStorage) global.sessionStorage.setItem(RELOAD_FLAG, '1');
    } catch (e) { return false; }
    try { if (global.localStorage) global.localStorage.removeItem(PERSIST_SECRET_KEY); } catch (e) { }
    try { if (global.sessionStorage) global.sessionStorage.removeItem(SESSION_SECRET_KEY); } catch (e) { }
    try {
      if (global.console && global.console.warn) {
        global.console.warn('[dsh-gw] 存在本地的加密钥匙解不开（电脑那边换过钥匙？）—— 已丢掉，正在重载');
      }
    } catch (e) { }
    try { global.location.reload(); } catch (e) { }
    return true;
  }

  function readStoredSecret() {
    // 顺序：先用「你亲手带进来的那把」（持久），再用这次会话里学到的（session）。
    // 都不行才返回 null —— 界面据此如实报「缺密钥」。
    try {
      var p = global.localStorage && global.localStorage.getItem(PERSIST_SECRET_KEY);
      if (p && p.length >= 16) { secretSource = 'stored'; return p; }
    } catch (e) { /* 私密浏览等：读不到就当没有 */ }
    var s = readSessionSecret();
    if (s) secretSource = 'stored';
    return s;
  }

  function readSessionSecret() {
    try {
      var s = global.sessionStorage && global.sessionStorage.getItem(SESSION_SECRET_KEY);
      return s && s.length >= 16 ? s : null;
    } catch (e) { return null; }
  }

  function saveSessionSecret(secret) {
    try { if (global.sessionStorage) global.sessionStorage.setItem(SESSION_SECRET_KEY, secret); }
    catch (e) { /* 私密浏览或浏览器禁用存储时，退化为仅当前页面内存 */ }
    // 持久那份：只有从地址里学到钥匙时才会写（见 secretFromUrl 的说明）
    try { if (global.localStorage) global.localStorage.setItem(PERSIST_SECRET_KEY, secret); }
    catch (e) { /* 写不进去就还是只靠 sessionStorage */ }
  }

  function secretFromUrl() {
    var h = String(global.location.hash || '');
    // ★ 必须**唯一**，解析不出唯一一把就当成「没有密钥」。
    //
    //   `#k=A#k=A` 这种双份（历史上真的产出过）如果说「取第一个就行」，
    //   遇到两份**不一样**的就会猜错 —— 而猜错的后果特别隐蔽：加密「装上了」
    //   （__dshE2eeOn=true、角标显示一切正常）、WS 也拿到 101，但一帧都解不开
    //   → 静默空列表，界面上没有任何错误。宁可当成没有密钥，让界面如实报
    //   「缺密钥」并给出修法，也不要拿着一段坏字符串假装正常。
    var all = h.match(/[#&]k=([^#&]+)/g) || [];
    if (all.length > 1) return null;
    var m = h.match(/[#&]k=([^#&]+)/);
    if (!m) return readStoredSecret();
    var s = null;
    try { s = decodeURIComponent(m[1]); } catch (e) { s = m[1]; }
    if (!s || s.length < 16) return null;
    // ★ 刻意**不**把 #k= 从地址栏抹掉（这里原来会 replaceState 抹掉它）。
    //
    //   原注释写「取完顺手把 # 从地址栏抹掉，免得别人看屏幕时瞄到。
    //   抹掉不影响功能：已经在内存里了」—— 前半句成立，**后半句是错的**：
    //
    //   「添加到主屏幕」和「加书签」保存的都是**当时的地址**。地址里没有
    //   密钥，存下来的就没有密钥 —— 点开永远是空的/未加密，图标怎么删了
    //   重加都没用：主屏图标与书签可能丢失 # 后面的密钥。
    //
    //   被旁边的人瞄一眼是小概率、可以自担；书签永久失效是必然发生的。
    //   两害相权，密钥留在地址里。内存里那份（saveSessionSecret）照旧存。
    secretSource = 'url';
    saveSessionSecret(s);
    return s;
  }

  /** Uint8Array → ArrayBuffer（WebSocket.send 收 ArrayBuffer 最稳） */
  function toArrayBuffer(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  /**
   * 把 WebSocket 换成「自动加解密」的版本。
   *
   * 只在两个条件都满足时才动手：
   *   1. 网址 # 里带着长期密钥
   *   2. 浏览器支持 crypto.subtle（要安全上下文）
   *
   * 否则原样返回 —— **绝不能因为加密没配好就把人挡在外面**。
   *
   * 做法是换掉 window.WebSocket 这个构造器：新建连接时自动在地址上带
   * `e2ee=1`（网关看到它才启用加密），并接管 send / message。
   */
  function installWsEncryption(secret) {
    var Native = global.WebSocket;
    if (!Native || Native.__dshE2ee) return false;
    if (!available()) return false;

    var cache = {};       // 当前时间段的密钥

    function keysNow() {
      var slot = slotAt();
      if (cache.slot !== slot) {
        cache.slot = slot;
        cache.p = deriveKeys(secret, slot);
      }
      return cache.p;
    }

    function Patched(url, protocols) {
      var full;
      try {
        var u = new URL(url, global.location.href);
        u.searchParams.set('e2ee', '1');
        full = u.toString();
      } catch (e) { full = url; }

      var ws = protocols === undefined ? new Native(full) : new Native(full, protocols);
      var nativeSend = ws.send.bind(ws);
      var nativeAdd = ws.addEventListener.bind(ws);
      var nativeRemove = ws.removeEventListener.bind(ws);
      var wrapped = [];     // [fn, wrapper] 以便 removeEventListener 能对上
      var encryptionFailed = false;

      // ★ 「没打开就关了」= 网关拒了这次升级。
      //
      //   现在最可能的原因是**这台设备还没证明自己**（网关回 403 + 一个头，
      //   但浏览器不把握手响应交给 JS 看，所以只能靠这个信号反推）。
      //   不补证明的话，DSH 自己的重连会一直重连一直被拒 —— 表现是
      //   「消息能发出去、但什么都没有回来」，而控制台一点线索都没有。
      //   这里补一次，下一次重连就能过。
      var opened = false;
      try {
        nativeAdd('open', function () { opened = true; });
        nativeAdd('close', function () {
          if (opened) return;
          // 没打开就关了，多半是网关拒了（证明过期/网关重启）—— 同样先作废本地判断
          try { proofState.ok = false; prove(true); } catch (e) { }
        });
      } catch (e) { }
      function failEncryptedTransport() {
        if (encryptionFailed) return;
        encryptionFailed = true;
        try { ws.close(1011, 'Encrypted transport validation failed'); } catch (e) { }
      }

      // 收到的东西：如果是二进制，说明是密文，解开再交给上层
      function deliver(ev, fn) {
        var d = ev.data;
        if (encryptionFailed) return;
        if (typeof d === 'string') { failEncryptedTransport(); return; }
        // Blob 要异步读出来
        var go = function (buf) {
          keysNow().then(function (k) {
            return decryptFromB64(k.b, bytesToB64url(new Uint8Array(buf)));
          }).then(function (plain) {
            if (plain !== null) return plain;
            return deriveKeys(secret, slotAt() - 1).then(function(k) {
              return decryptFromB64(k.b, bytesToB64url(new Uint8Array(buf)));
            });
          }).then(function (plain) {
            if (plain === null) {
              failEncryptedTransport();
            } else if (!encryptionFailed) {
              fn.call(ws, { data: plain, type: 'message', target: ws });
            }
          }).catch(failEncryptedTransport);
        };
        if (d instanceof ArrayBuffer) go(d);
        else if (typeof Blob !== 'undefined' && d instanceof Blob) {
          d.arrayBuffer().then(go).catch(failEncryptedTransport);
        } else go(d);
      }

      ws.addEventListener = function (type, fn, opts) {
        if (type !== 'message' || typeof fn !== 'function') {
          return nativeAdd(type, fn, opts);
        }
        var wrapper = function (ev) { deliver(ev, fn); };
        wrapped.push([fn, wrapper]);
        return nativeAdd('message', wrapper, opts);
      };

      ws.removeEventListener = function (type, fn, opts) {
        if (type === 'message') {
          for (var i = 0; i < wrapped.length; i++) {
            if (wrapped[i][0] === fn) {
              nativeRemove('message', wrapped[i][1], opts);
              wrapped.splice(i, 1);
              return;
            }
          }
        }
        return nativeRemove(type, fn, opts);
      };

      // 上层更常用 `ws.onmessage = fn` 这种写法，也要接管
      var onmsg = null;
      Object.defineProperty(ws, 'onmessage', {
        configurable: true,
        get: function () { return onmsg; },
        set: function (fn) {
          if (onmsg) {
            for (var i = 0; i < wrapped.length; i++) {
              if (wrapped[i][0] === onmsg) {
                nativeRemove('message', wrapped[i][1]);
                wrapped.splice(i, 1);
                break;
              }
            }
          }
          onmsg = fn;
          if (typeof fn === 'function') {
            var wrapper = function (ev) { deliver(ev, fn); };
            wrapped.push([fn, wrapper]);
            nativeAdd('message', wrapper);
          }
        }
      });

      // 发出去的东西：文本一律加密，变成二进制发走
      ws.send = function (data) {
        if (encryptionFailed) throw new Error('Encrypted transport is closed');
        if (typeof data !== 'string') {
          throw new TypeError('Encrypted WebSocket accepts text messages only; binary data requires an authenticated envelope');
        }
        keysNow().then(function (k) {
          return encryptToB64(k.a, data);
        }).then(function (ct) {
          if (!encryptionFailed) nativeSend(toArrayBuffer(b64urlToBytes(ct)));
        }).catch(function () {
          // Never leak a draft when key derivation/encryption or transport fails.
          // Closing rejects pending RPCs so callers can keep their unsent draft.
          failEncryptedTransport();
        });
      };

      return ws;
    }

    // 让 instanceof 之类的判断仍然成立
    Patched.prototype = Native.prototype;
    Patched.CONNECTING = Native.CONNECTING;
    Patched.OPEN = Native.OPEN;
    Patched.CLOSING = Native.CLOSING;
    Patched.CLOSED = Native.CLOSED;
    Patched.__dshE2ee = true;

    global.WebSocket = Patched;
    return true;
  }

  // ── 进门证明（挑战应答）────────────────────────────────────────────────────
  //
  // 背景：让你登进来的凭证是**路径里的访问密钥**（/k/<密钥>），而路径是 HTTP
  // 请求行的一部分 —— 隧道（TLS 终点）看得见。它把那条请求自己发一遍就能冒充你。
  // # 后面那串它从来没见过（浏览器不发 fragment），所以拿它当进门凭证：
  // 网关发一个随机数，这里用它算个 HMAC 发回去，通过之前**内容一律不给**。
  //
  // 2026-09-27 起网关那边真的开始拦人了。于是这里必须承担两件事，
  // 少一件都会表现成「界面莫名其妙空掉」：
  //
  //   1. **主动续证** —— 证明在网关内存里，12 小时过期、网关一重启就没了。
  //      手机页面开着不动的时候没人会去点刷新，所以按 4 小时一次的节奏自己续。
  //   2. **被拦了要能自愈** —— 任何请求收到 403 + `x-dsh-need-proof: 1`，
  //      立刻补一次证明，然后**把原来那条请求重发一遍**。
  //      没有这一步，一次过期的后果就是「列表空了、发消息没反应」，
  //      而使用者完全不知道发生了什么。
  //
  // 三条自我约束（和这个文件里其它补丁一样）：
  //   · 证不了绝不挡路 —— 失败就是失败，不影响任何别的功能；
  //   · 同一时刻只证一次（inflight 去重），免得一屏请求各证一遍；
  //   · 不跟自己的包装打架（证明本身走 installProofRetry **之前**那层 fetch）。
  var PROOF_REFRESH_MS = 4 * 60 * 60 * 1000;    // 证一次管 4 小时（网关那边 12 小时过期）
  var PROOF_RECHECK_MS = 20 * 60 * 1000;        // 每 20 分钟看一次「该不该续」
  var proofState = { ok: false, at: 0, inflight: null, lastForced: 0, fails: 0 };
  var fetchForProof = null;    // 证明专用：绕过重试包装，避免自己触发自己

  /** 现在手上有哪把钥匙（地址里的优先，其次本地存的） */
  function currentSecret() {
    try {
      var s = secretFromUrl();
      if (s) return s;
    } catch (e) { }
    try {
      if (global.__dshE2eeSecret) return global.__dshE2eeSecret;
    } catch (e) { }
    return null;
  }

  /** 这个响应是不是「你还没证明自己」 */
  function isNeedProof(res) {
    try {
      return !!(res && res.status === 403 && res.headers &&
        res.headers.get && res.headers.get('x-dsh-need-proof') === '1');
    } catch (e) { return false; }
  }

  /**
   * 做一次进门证明。force=false 时，证明还新鲜就直接返回。
   * 永远 resolve（不 reject）—— 调用方不需要写 catch，也不会被它拖住。
   *
   * ── 2026-09-27：改成**先走一个来回**（慢链路优化）────────────────────────
   *
   * 原来要两个来回：先 GET 挑战，再把应答 POST 回去。在内网那是 0 毫秒的事，
   * 但在隧道上（实测一个来回 2.8–5 秒）光证明就 8 秒以上 —— 使用者感觉到的是
   * 「开个页面要等」。
   *
   * 现在手机自己出随机数和时间戳，一次把 {ts, nonce, response} 发过去：
   *
   *     response = HMAC-SHA256( authKey , ts + '|' + nonce )
   *
   * ★ 加密一个字都没动：还是那把**认证专用**的钥匙（HKDF 的 salt='dsh-gw-auth'、
   *   info='dsh-gw|auth|v1'）—— 和内容加密的时段密钥是两把，当初刻意分开的。
   *   内容密钥、WS 端到端加密、正文加密都不经过这里。
   *
   * ★ 唯一的失败面是时钟（老路子不看时间）。所以：
   *   · 服务端窗口给到 ±5 分钟；
   *   · 被拒（stale-ts / 形式不认识 / 老网关）就**自动退回两个来回** ——
   *     最坏情况是「不快」，不是「进不去」。
   */
  function prove(force) {
    var now = Date.now();
    if (proofState.inflight) return proofState.inflight;          // 去重
    if (!force && proofState.ok && (now - proofState.at) < PROOF_REFRESH_MS) {
      return Promise.resolve(true);
    }
    if (force && (now - proofState.lastForced) < 3000 && proofState.ok) {
      return Promise.resolve(true);    // 三秒内不重复强证（一屏请求同时被拦很常见）
    }
    var secret = currentSecret();
    if (!secret || !available()) { proofState.lastWhy = secret ? 'no-webcrypto' : 'no-secret'; return Promise.resolve(false); }
    if (force) proofState.lastForced = now;

    var doFetch = fetchForProof || global.fetch;
    proofState.lastWhy = 'running';
    proofState.inflight = oneShotProof(secret, doFetch)
      .then(function (r) {
        if (r && r.ok) return true;
        // 退回老路（两个来回）。什么时候会走到这儿：
        //   · 手机上时间不对（stale-ts）—— 服务端明说差了多少秒
        //   · 网关是旧版，不认带 ts 的形式（nonce 不认识）
        //   · 中间任何一步出岔子
        proofState.lastWhy = 'fallback:' + String((r && (r.code || r.reason)) || 'unknown');
        return legacyProve(secret, doFetch);
      })
      .then(function (ok) {
        if (ok) { proofState.ok = true; proofState.at = Date.now(); proofState.fails = 0; }
        else { proofState.fails++; }
        return ok;
      })
      .catch(function (err) {
        proofState.fails++;
        proofState.lastWhy = 'error:' + String((err && err.message) || err);
        return false;
      })
      .then(function (ok) { proofState.inflight = null; return ok; });
    return proofState.inflight;
  }

  /** 一个来回：手机自己出 nonce + 时间戳，连 HMAC 一次发过去 */
  function oneShotProof(secret, doFetch) {
    var bytes = new Uint8Array(24);
    try { global.crypto.getRandomValues(bytes); }
    catch (e) { for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
    var nonce = bytesToB64url(bytes);
    var ts = Date.now();
    return authResponse(secret, ts + '|' + nonce).then(function (response) {
      return doFetch('/__auth/verify', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ts: ts, nonce: nonce, response: response })
      });
    }).then(function (r) { return r.json(); })
      .then(function (v) {
        if (v && v.ok) proofState.lastWhy = 'ok(1rtt)';
        return v || { ok: false, code: 'bad-response' };
      })
      .catch(function () { return { ok: false, code: 'network' }; });
  }

  /** 老路：先取挑战、再交应答（两个来回）—— 旧网关、手机时钟不对时靠它 */
  function legacyProve(secret, doFetch) {
    return doFetch('/__auth/challenge', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.nonce) throw new Error('no-nonce');
        return authResponse(secret, j.nonce).then(function (response) {
          return doFetch('/__auth/verify', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ nonce: j.nonce, response: response })
          });
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        var ok = !!(v && v.ok);
        if (ok) proofState.lastWhy = 'ok(2rtt)';
        else proofState.lastWhy = 'rejected:' + String((v && (v.code || v.reason)) || 'unknown');
        return ok;
      })
      .catch(function (err) {
        proofState.lastWhy = 'error:' + String((err && err.message) || err);
        return false;
      });
  }

  /**
   * fetch 那一层：被拦 → 补证 → **重发原请求**。
   *
   * 只重发「body 还能再发一次」的请求（字符串 / 表单 / 二进制 / Blob）。
   * 流（ReadableStream）被读过就没了，重发只会更糟 —— 那种交给主动续证兜。
   */
  function canReplayBody(init) {
    if (!init || init.body == null) return true;
    var b = init.body;
    if (typeof b === 'string') return true;
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return true;
    if (typeof FormData !== 'undefined' && b instanceof FormData) return true;
    if (typeof Blob !== 'undefined' && b instanceof Blob) return true;
    if (typeof ArrayBuffer !== 'undefined' && (b instanceof ArrayBuffer || ArrayBuffer.isView(b))) return true;
    return false;   // ReadableStream 之类 → 不重发
  }

  function installProofRetry() {
    var orig = global.fetch;
    if (!orig || orig.__dshProofRetry) return false;
    var wrapped = function (input, init) {
      var self = this;
      var isRequestObj = (typeof Request !== 'undefined' && input instanceof Request);
      return orig.apply(self, arguments).then(function (res) {
        if (!isNeedProof(res)) return res;
        // ★ 服务端说「你没证明」→ 本地那份「我证过了」作废，否则 prove(true)
        //   会被「三秒内不重复强证」挡掉，重发还是 403，页面坏到手动刷新为止。
        proofState.ok = false;
        return prove(true).then(function (ok) {
          // Request 对象那种没法安全重放（body 已被消费）—— 交给主动续证兜
          if (!ok || isRequestObj || !canReplayBody(init)) return res;
          return orig.call(self, input, init);
        });
      });
    };
    wrapped.__dshProofRetry = true;
    global.fetch = wrapped;
    return true;
  }

  /**
   * XHR 那一层，同理 —— 只是 XHR 能**重用同一个对象**：
   * open() 再来一次、监听器还挂在上面，所以重放不会丢掉调用方的回调。
   */
  function installXhrProofRetry() {
    if (typeof XMLHttpRequest === 'undefined') return false;
    var proto = XMLHttpRequest.prototype;
    if (proto.__dshProofRetry) return false;
    var send = proto.send, open = proto.open, setHdr = proto.setRequestHeader;

    proto.send = function (body) {
      var self = this;
      try {
        var info = this.__dshReq;
        if (info && !info.__dshProofHooked) {
          info.__dshProofHooked = true;
          info.body = body;
          var onDone = function () {
            try {
              if (info.__dshProofRetried) return;
              if (self.status !== 403) return;
              if (!self.getResponseHeader || self.getResponseHeader('x-dsh-need-proof') !== '1') return;
              info.__dshProofRetried = true;
              proofState.ok = false;      // 同上：本地判断先作废，否则补证会被节流挡掉
              prove(true).then(function (ok) {
                if (!ok) return;
                // 重放：open() 会清掉请求头，所以要按原样再设一遍。
                // 走的是下层那个「加密」send —— 明文进去、密文出来，和第一次一样。
                open.call(self, info.method, info.url, true);
                var hs = info.headers || {};
                Object.keys(hs).forEach(function (k) {
                  try { setHdr.call(self, k, hs[k]); } catch (e) { }
                });
                send.call(self, info.body);
              }).catch(function () { });
            } catch (e) { }
          };
          if (this.addEventListener) this.addEventListener('loadend', onDone);
        }
      } catch (e) { }
      return send.apply(this, arguments);
    };
    proto.__dshProofRetry = true;
    return true;
  }

  /**
   * 接管 fetch：凡是带 `x-dsh-e2ee: 1` 的响应，先解密再交给上层。
   *
   * 为什么连文件也要管：对话内容加密了、图片还是明文过去，那等于没做。
   * 网关那边对 `/codex/file` 的返回会加密，并在头上标明原来是什么类型
   * （`x-dsh-e2ee-type`），这里解开之后把类型还原回去。
   *
   * 只处理明确标了这个头的响应，其它一律原样放行 ——
   * 这样即使加密没配好，功能也不会坏。
   */
  function installFetchDecrypt(secret) {
    var orig = global.fetch;
    if (!orig || orig.__dshE2ee) return false;

    var wrapped = function (input, init) {
      return orig(input, init).then(function (res) {
        if (!res.headers || res.headers.get('x-dsh-e2ee') !== '1') return res;

        var origType = res.headers.get('x-dsh-e2ee-type') || 'application/octet-stream';
        return res.arrayBuffer().then(function (buf) {
          var u8 = new Uint8Array(buf);
          return deriveKeys(secret, slotAt()).then(function (k) {
            return decryptBinaryWith(k.b, u8);
          }).then(function (plain) {
            if (plain) return plain;
            // 跨时间段时上面会解不开，退一个时间段再试
            return deriveKeys(secret, slotAt() - 1)
              .then(function (k2) { return decryptBinaryWith(k2.b, u8); });
          }).then(function (plain) {
            if (!plain) {
              // 解不开就把原始响应交回去，**但必须保留加密标记**。
              //
              // 原来这里只给了 content-type，标记被抹掉 —— 于是下游
              // （比如 fetchToBlobUrl）看到「没有 x-dsh-e2ee」就以为这是明文，
              // 直接把密文当图片用，表现是「图裂了，但不知道为什么」。
              // 留着标记，下游才知道这段仍是密文、该报错而不是硬用。
              // 钥匙若是**本地存的那把**，顺手自救一次（多半是电脑那边换过钥匙）。
              maybeForgetStaleKey();
              return new Response(u8, {
                status: res.status,
                headers: {
                  'content-type': 'application/octet-stream',
                  'x-dsh-e2ee': '1',
                  'x-dsh-e2ee-type': origType
                }
              });
            }
            clearReloadFlag();   // 解开了 → 那把钥匙是好的，允许将来再自救
            return new Response(plain, {
              status: res.status,
              statusText: res.statusText,
              headers: { 'content-type': origType }
            });
          });
        });
      });
    };

    global.fetch = wrapped;
    global.fetch.__dshE2ee = true;
    return true;
  }

  /** 二进制解密：拿到 Uint8Array，返回 Uint8Array。解不开返回 null。 */
  async function decryptBinaryWith(rawKey, u8) {
    if (u8.length < 28) return null;
    var iv = u8.slice(0, 12);
    var tag = u8.slice(12, 28);
    var body = u8.slice(28);
    // WebCrypto 期望「密文末尾跟 tag」，网关发来的是 iv|tag|body，要重排
    var joined = new Uint8Array(body.length + 16);
    joined.set(body, 0);
    joined.set(tag, body.length);
    try {
      var k = await importAes(rawKey, false);
      var pt = await subtle().decrypt({ name: 'AES-GCM', iv: iv }, k, joined);
      return new Uint8Array(pt);
    } catch (e) {
      return null;
    }
  }

  /**
   * 取一个受加密保护的资源，返回可以直接给 <img>/<a> 用的 blob URL。
   *
   * 图片没法靠 fetch 拦截解决 —— `<img src="...">` 是浏览器自己发的请求，
   * 拦不到。所以调用方要显式用这个函数取，拿回一个 blob: 地址。
   */
  async function fetchToBlobUrl(secret, url, mime) {
    var res = await global.fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var u8 = new Uint8Array(await res.arrayBuffer());
    var type = res.headers.get('x-dsh-e2ee-type') || mime || 'application/octet-stream';

    if (res.headers.get('x-dsh-e2ee') !== '1') {
      return URL.createObjectURL(new Blob([u8], { type: type }));   // 没加密，直接用
    }

    var keys = await deriveKeys(secret, slotAt());
    var plain = await decryptBinaryWith(keys.b, u8);
    if (!plain) {
      keys = await deriveKeys(secret, slotAt() - 1);
      plain = await decryptBinaryWith(keys.b, u8);
    }
    if (!plain) throw new Error('解不开（密钥不匹配？）');
    return URL.createObjectURL(new Blob([plain], { type: type }));
  }

  /**
   * 「带使用者正文」的 DSH 端点 —— 只给这几条加密请求体。
   *
   * ★ 为什么需要它（2026-09-24 查出来的缺口）：DSH 自己那套 HTTP API 是**明文**的
   *   （它的 56 个客户端插件里一行加密代码都没有），而 `session/prompt` 的请求体
   *   就是 `{content:[{type:'text',text:…}]}` —— **使用者打出去的字和粘贴的图片
   *   全在里面**。不加密的话，「隧道看不到用户发出去的消息」这条底线根本不成立：
   *   它不用主动做任何事，正常转发就看得一清二楚。
   *
   * ★ 为什么只挑这两条（不是整个 /api/**）：/api 下面还有 SSE 长连接
   *   （EventSource）和大文件流，动它们风险大、收益小。先把「发出去的正文」
   *   这条堵上 —— 那是使用者明确提的底线。
   *
   * 服务端那一半在 scripts/mobile-proxy.js 的 proxyRequest 里（解开再转发）。
   * 两边是**机会式**的：带了标记就解，没带就照旧 —— 老客户端不会被挡在外面。
   */
  var CONTENT_API_PATHS = [
    '/api/session/prompt',            // 你打出去的字 + 粘贴的图片（base64 在里面）
    '/api/session/uploadFileBinary'   // 上传的附件字节
  ];

  function isContentApi(pathname) {
    return CONTENT_API_PATHS.indexOf(String(pathname || '')) >= 0;
  }

  /**
   * 装「请求体加密」的补丁：server 那半边会自动解开，所以 DSH 完全不知道有这回事。
   *
   * 两条自我约束：
   *   · 判断不出来就**按明文走** —— 补丁本身绝不能把请求弄坏；
   *   · 已经带 `x-dsh-e2ee: 1` 的不再包第二层（encryptedFetch 内部还会再调
   *     global.fetch，不挡就会**加密两次**，DSH 解出来是垃圾）。
   */
  function installRequestEncrypt(secret) {
    if (!secret || !global.fetch) return false;
    var orig = global.fetch;
    if (orig.__dshE2eeReq) return false;

    var wrapped = function (input, init) {
      try {
        var headers = (init && init.headers) || {};
        var marked = headers['x-dsh-e2ee'] || headers['X-Dsh-E2ee'] ||
          (input && input.headers && input.headers.get && input.headers.get('x-dsh-e2ee'));
        if (!marked && init && init.body != null) {
          var raw = typeof input === 'string' ? input : (input && input.url) || '';
          var u = new URL(raw, (global.location && global.location.href) || 'http://localhost');
          var sameOrigin = !global.location || u.origin === global.location.origin;
          if (sameOrigin && isContentApi(u.pathname)) {
            return encryptedFetch(secret, input, init);
          }
        }
      } catch (e) { /* 判断不了就按明文走 */ }
      return orig.apply(this, arguments);
    };
    wrapped.__dshE2eeReq = true;
    global.fetch = wrapped;
    return true;
  }

  /**
   * 有些客户端用的是 XHR 而不是 fetch（DSH 那套 RPC 走哪条我没查到实锤）——
   * 所以两条都补上。XHR 的 body 是在 send() 里给的，而加密是异步的，
   * 于是这里**推迟**真正的 send：先加密，再带着密文发出去。
   * 任何一步出错都退回原样发送 —— 绝不能让「加密」把界面弄坏。
   */
  function installXhrRequestEncrypt(secret) {
    if (!secret || typeof XMLHttpRequest === 'undefined') return false;
    var proto = XMLHttpRequest.prototype;
    if (proto.__dshE2eeReq) return false;
    var open = proto.open, send = proto.send, setHdr = proto.setRequestHeader;

    proto.open = function (method, url) {
      this.__dshReq = { method: method, url: url, headers: {} };
      return open.apply(this, arguments);
    };
    proto.setRequestHeader = function (k, v) {
      try { if (this.__dshReq) this.__dshReq.headers[String(k).toLowerCase()] = String(v); } catch (e) { }
      return setHdr.apply(this, arguments);
    };
    proto.send = function (body) {
      var self = this;
      try {
        var info = this.__dshReq;
        if (info && body != null && !info.headers['x-dsh-e2ee']) {
          var u = new URL(info.url, (global.location && global.location.href) || 'http://localhost');
          var sameOrigin = !global.location || u.origin === global.location.origin;
          if (sameOrigin && isContentApi(u.pathname)) {
            var origType = info.headers['content-type'] || 'application/json; charset=utf-8';
            var bytes = (typeof body === 'string') ? enc.encode(body)
              : (body instanceof Uint8Array) ? body
                : (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) ? new Uint8Array(body)
                  : null;
            if (bytes) {
              deriveKeys(secret, slotAt()).then(function (keys) {
                return encryptBinaryWith(keys.a, bytes);
              }).then(function (ct) {
                try {
                  setHdr.call(self, 'content-type', 'application/octet-stream');
                  setHdr.call(self, 'x-dsh-e2ee', '1');
                  setHdr.call(self, 'x-dsh-e2ee-type', origType);
                } catch (e) { }
                send.call(self, ct);
              }).catch(function () { try { send.call(self, body); } catch (e) { } });
              return;
            }
          }
        }
      } catch (e) { /* 退回原样 */ }
      return send.apply(this, arguments);
    };
    proto.__dshE2eeReq = true;
    return true;
  }

  /** 启动：有密钥就装上。返回是否启用了加密。 */
  function start() {
    var secret = secretFromUrl();
    if (!secret) return false;
    global.__dshE2eeSecret = secret;      // 给上层（比如 codex.html）取用
    var okWs = installWsEncryption(secret);
    try { installFetchDecrypt(secret); } catch (e) { }
    try { installRequestEncrypt(secret); } catch (e) { }
    try { installXhrRequestEncrypt(secret); } catch (e) { }
    // ★ 证明专用的 fetch 必须在**重试包装之前**抓住，
    //   否则证明自己撞上 403 时会递归再证明一遍。
    try { fetchForProof = global.fetch; } catch (e) { }
    try { installProofRetry(); } catch (e) { }
    try { installXhrProofRetry(); } catch (e) { }
    installProofUpkeep();
    return okWs;
  }

  /**
   * 主动续证：开页面就证一次，之后每 20 分钟检查一次该不该续（4 小时一次），
   * 页面重新可见时也检查一次（手机放兜里几小时、回来接着用，是最常见的场景）。
   *
   * 为什么必须做：证明在网关内存里，网关一重启就没了；12 小时也会过期。
   * 页面开着不动的时候没人会去点刷新，没有这一步就会出现「隔夜回来界面空了」。
   */
  function installProofUpkeep() {
    try { prove(true); } catch (e) { }        // 开页面立刻证（不阻塞任何东西）
    try {
      setInterval(function () {
        try {
          if (global.document && global.document.visibilityState &&
            global.document.visibilityState !== 'visible') return;
          prove(false);
        } catch (e) { }
      }, PROOF_RECHECK_MS);
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('visibilitychange', function () {
          try {
            if (global.document.visibilityState === 'visible') {
              // ★ 回到前台**强制**证一次（原来这里是 prove(false)）。
              //
              //   为什么必须换：prove(false) 在「本地认为已经证过、且还新鲜」时
              //   直接返回，一个请求都不发 —— 而「切出去再切回来」这个动作
              //   恰恰发生在**服务端已经不认了**的时候（网关重启、12 小时过期）。
              //   实测：切回来之后 40 秒里一次证明尝试都没有，
              //   页面全是 403，只能手动刷新。
              //   代价是切回前台时多一个来回（很小），换来的是不用刷新。
              if (global.__dshE2eeSecret) prove(true);
            }
          } catch (e) { }
        });
      }
    } catch (e) { }
  }

  global.DshE2EE = {
    SLOT_MS: SLOT_MS,
    slotAt: slotAt,
    available: available,
    deriveKeys: deriveKeys,
    candidateKeys: candidateKeys,
    encryptToB64: encryptToB64,
    encryptBinaryWith: encryptBinaryWith,
    encryptedFetch: encryptedFetch,
    decryptFromB64: decryptFromB64,
    b64urlToBytes: b64urlToBytes,
    bytesToB64url: bytesToB64url,
    secretFromUrl: secretFromUrl,
    authResponse: authResponse,
    installWsEncryption: installWsEncryption,
    installFetchDecrypt: installFetchDecrypt,
    fetchToBlobUrl: fetchToBlobUrl,
    decryptBinaryWith: decryptBinaryWith,
    // 排查用：这把钥匙是**从地址带来的**还是**这台设备存下的**。
    // 真机上「未加密 / 看不到任务」时，第一件要分清的就是这个 ——
    // 从图标进来（iOS 会丢掉地址里的 #片段）和用完整链接打开，观感一样、修法完全不同。
    secretSource: function () { return secretSource; },
    // 进门证明：网关 2026-09-27 起真的拦人了，所以这几个要能被外面看见 ——
    // 手机端「看不到任务 / 什么都没反应」时，第一个要问的就是「证明过了吗」。
    prove: prove,
    proofState: function () {
      return { ok: proofState.ok, at: proofState.at, fails: proofState.fails,
        inflight: !!proofState.inflight, why: proofState.lastWhy };
    },
    start: start
  };

  // 尽早装上 —— 必须赶在 DSH 自己的脚本建立 WebSocket 之前。
  // 这个文件是注入在 <head> 最前面的，所以直接同步执行就好。
  try { global.__dshE2eeOn = start(); } catch (e) { global.__dshE2eeOn = false; }
})(window);
