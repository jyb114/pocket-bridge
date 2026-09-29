// DSH 移动端网关 — Service Worker
//
// 两件事：
//   1. 接收电脑端发来的 Web Push 并弹通知（原有职责）
//   2. **校验代码指纹** —— 这是端到端加密方案的第二层
//
// 第 2 件为什么必要：内容加密挡住的是「隧道偷看」，但挡不住
// 「隧道把发给手机的 JS 换掉」—— 换掉的代码可以在明文还没加密时抄一份，
// 或者直接把密钥传出去。而做加密的那段代码，本身也是通过隧道送来的。
//
// 做法：把每个 JS 的指纹 pin 住；以后每次取都核对，**对不上就用缓存里的旧版**。
// 隧道即使改了代码，改完的那份也执行不了。
//
// 局限要说清楚：第一次 pin 的时候如果已经被掉包，就防不住了（信任首次）。
// 所以指纹也会通过推送通道发一份，使用者可以拿来核对。
'use strict';

const PIN_CACHE = 'dsh-code-pin-v1';
const BODY_CACHE = 'dsh-code-body-v1';
const PIN_KEY = '/__dsh-code-pin';
const KEY_EPOCH_CACHE = 'dsh-code-key-epoch-v1';
const KEY_EPOCH_KEY = '/__dsh-access-key-epoch';
// DSH 自己的静态模块（构建产物 + 插件）单独一个缓存桶。
// 它们不属于「我们的代码」，不该和指纹缓存混在一起。
const DSH_STATIC_CACHE = 'dsh-static-modules-v1';
const LITE_PIN_REQUIRED = ['/e2ee.js', '/i18n.js', '/dsh-lite-lang.js',
  '/dsh-lite-pin.js', '/dsh-lite-adapter.js', '/dsh-lite-legacy.js',
  '/dsh-lite-router.js', '/dsh-lite-ui.js', '/dsh-lite-switch.js'];
const PIN_HASH = /^[a-f0-9]{64}$/i;

function isCacheableDshStaticModule(url) {
  const pathname = url.pathname;
  if (pathname.indexOf('/assets/') === 0) {
    // Keep the same content-hash boundary as the gateway's cache headers.
    const match = pathname.match(/-([A-Za-z0-9_-]{8,})\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico|map)$/i);
    return !!(match && /[A-Z0-9]/.test(match[1]));
  }
  if (pathname.indexOf('/plugins/') === 0) {
    // HMR events are a stream, never a static module. Unversioned plugin URLs
    // must go to the network so an upgraded DSH cannot reuse old code.
    if (pathname === '/plugins/events' || pathname.indexOf('/plugins/events/') === 0) return false;
    return /[?&]rev=[0-9a-f]{8,}(?:&|$)/i.test(url.search);
  }
  return false;
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ── 指纹的读写 ──────────────────────────────────────────────────────────────

async function readPin() {
  try {
    const c = await caches.open(PIN_CACHE);
    const r = await c.match(PIN_KEY);
    if (!r) return null;
    return await r.json();
  } catch (err) { return null; }
}

async function writePin(manifest) {
  const c = await caches.open(PIN_CACHE);
  await c.put(PIN_KEY, new Response(JSON.stringify(manifest), {
    headers: { 'content-type': 'application/json' }
  }));
}

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bodyCacheKey(url, hash) {
  // The old worker stored bodies by pathname alone. A request from that worker
  // may finish after an update, so a path-only cache can mix two releases.
  return url + '?__dsh_code_sha256=' + hash;
}

async function readCachedBody(url, hash) {
  if (!PIN_HASH.test(hash || '')) return null;
  try {
    const c = await caches.open(BODY_CACHE);
    const key = bodyCacheKey(url, hash);
    const pinned = await c.match(key);
    if (pinned) {
      if (await sha256Hex(await pinned.clone().arrayBuffer()) === hash) return pinned;
      await c.delete(key);
    }
    // One-time migration for verified bodies left by the previous worker.
    // Never trust the path-only entry without hashing it against this pin.
    const legacy = await c.match(url);
    if (!legacy || await sha256Hex(await legacy.clone().arrayBuffer()) !== hash) return null;
    await c.put(key, legacy.clone());
    return legacy;
  } catch (err) { return null; }
}

async function writeCachedBody(url, hash, body) {
  try {
    const c = await caches.open(BODY_CACHE);
    await c.put(bodyCacheKey(url, hash), new Response(body, {
      headers: { 'content-type': 'application/javascript; charset=utf-8' }
    }));
  } catch (err) { /* 存不下不影响本次 */ }
}

async function stageVerifiedPin(manifest) {
  const files = manifest && manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
      LITE_PIN_REQUIRED.some((path) => !PIN_HASH.test(files[path] || ''))) {
    throw new Error('code manifest is incomplete');
  }
  const paths = Object.keys(files);
  if (!paths.length || paths.length > 64) throw new Error('code manifest has too many entries');
  const staged = [];
  for (const path of paths) {
    const hash = files[path];
    if (!/^\/[a-z0-9][a-z0-9-]*\.js$/i.test(path) || !PIN_HASH.test(hash || ''))
      throw new Error('code manifest contains an invalid script');
    // A worker's own fetch bypasses its fetch event. Avoid the browser HTTP
    // cache so the bytes we hash are the same release the gateway now serves.
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('updated script unavailable');
    const body = await response.arrayBuffer();
    if (await sha256Hex(body) !== hash) throw new Error('updated script hash mismatch');
    staged.push({ path, hash, body });
  }
  // Write every new body under its hash before changing the active pin. If a
  // write fails, the old pin and its old-hash cache entries remain untouched.
  const cache = await caches.open(BODY_CACHE);
  for (const item of staged) {
    await cache.put(bodyCacheKey(item.path, item.hash), new Response(item.body, {
      headers: { 'content-type': 'application/javascript; charset=utf-8' }
    }));
  }
}

/**
 * 清掉验过指纹的旧代码缓存。
 *
 * 只在**人确认「我刚更新过」之后**调用 —— 那时候缓存里那些旧文件
 * 已经和新的指纹对不上了，留着只会让下一次请求又走到「对不上」那条路，
 * 然后拿旧的顶回去，新代码永远上不来。
 */
async function clearCachedBodies() {
  try {
    const keys = await caches.keys();
    for (const k of keys) if (k === BODY_CACHE) await caches.delete(k);
  } catch (err) { /* 清不掉也不影响主流程 */ }
}

// 访问密钥被轮换时，旧手机会带着“之前可信”的 e2ee.js 回来。
// 那份旧脚本不会给实时连接加 e2ee=1；网关为了不泄露内容会拒绝它，
// 表面现象就是项目、会话和文件一直转圈。/k/ 的 302 只能由正确的新密钥
// 换来，网关还会附上不可反推密钥的版本指纹。版本变了才清旧 pin；同一把
// 密钥反复打开不会削弱代码校验。
async function acceptAccessKeyEpoch(response) {
  const epoch = response && response.headers && response.headers.get('x-dsh-access-key-epoch');
  if (!epoch) return;
  const oldPin = await readPin();
  const oldEpoch = oldPin && oldPin.accessKeyEpoch;
  if (oldPin && oldEpoch !== epoch) {
    await caches.delete(PIN_CACHE);
    await clearCachedBodies();
  }
  const c = await caches.open(KEY_EPOCH_CACHE);
  await c.put(KEY_EPOCH_KEY, new Response(epoch, { headers: { 'content-type': 'text/plain' } }));
}

// ── 拦截：pin 过的文件要核对指纹 ────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  // ── DSH 自己的静态模块：缓存优先 ──────────────────────────────────────────
  //
  // 实测首屏需要 65 个插件模块和 4 个构建资源，gzip 合计 5,973,985 B。
  // 首次访问或隧道域名变化时仍须下载；同源的后续访问可复用成功的响应。
  // 模块请求失败可能阻止页面完成加载，但不是所有转圈的唯一原因。
  //
  // Cache Storage 让同源后续访问能复用这些资源；浏览器存储清理、容量压力
  // 或域名变化仍可能使缓存失效，不能把它视作永久副本。
  //
  // 只缓存可识别的内容哈希 URL：
  //     /assets/index-Q6zc2uHV.js
  //     /plugins/??@deepseek-ai/xxx/client.js&rev=dc9411e52426
  // 正常构建升级会换 URL；未带版本的资源仍走网络。DSH 模块不在桥自身
  // 的代码指纹名单里，故静态缓存与桥脚本的指纹缓存分桶。
  if (isCacheableDshStaticModule(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(DSH_STATIC_CACHE);
      const hit = await cache.match(event.request);
      if (hit) return hit;

      // 缓存未命中时，对临时网络失败进行有限重试。
      //
      //   ES 模块链中的一次 5xx 或连接中断就可能令这次加载失败；Service Worker
      //   在这些 GET 上重试。403 等 4xx 属于明确拒绝，不能靠重试解决。
      //
      //   退避 300ms → 900ms → 2000ms，加上首次一共试 4 次。隧道单次抖动
      //   可能恢复；只对带版本的静态 GET 使用这个退避序列。
      let res = null;
      let lastErr = null;
      for (const waitMs of [0, 300, 900, 2000]) {
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        try {
          res = await fetch(event.request);
          // 5xx 是上游/隧道侧的临时故障，值得重试；4xx 是确定的答复，不要重试
          if (res && res.ok) break;
          if (res && res.status < 500) break;
        } catch (err) {
          lastErr = err;      // 网络层失败（隧道被掐断）—— 继续重试
          res = null;
        }
      }
      if (!res) throw lastErr || new Error('module fetch failed');

      if (res.ok) {
        try { await cache.put(event.request, res.clone()); } catch (err) { /* 存不下不影响本次 */ }
      }
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const pin = await readPin();
    const want = pin && pin.files && pin.files[url.pathname];

    // 没 pin 过的文件，原样走网络 —— 不能因为没 pin 就把人挡在外面。
    // /k/<new-key> 也在这一支：即便它不是被 pin 的脚本，也必须先看到
    // 网关给的“密钥版本已变”信号，才能在随后的 / 跳转前清掉旧脚本。
    if (!want) {
      const response = await fetch(event.request);
      await acceptAccessKeyEpoch(response);
      return response;
    }

    let res;
    try {
      res = await fetch(event.request);
    } catch (err) {
      // 网络不通就用缓存 —— 顺带让「在外面断网」也能用
      const cached = await readCachedBody(url.pathname, want);
      if (cached) return cached;
      throw err;
    }
    await acceptAccessKeyEpoch(res);
    if (!res.ok) {
      const cached = await readCachedBody(url.pathname, want);
      return cached || res;
    }

    const body = await res.clone().arrayBuffer();
    const got = await sha256Hex(body);

    if (got === want) {
      await writeCachedBody(url.pathname, want, body);     // 指纹对，更新缓存
      return res;
    }

    // ── 指纹对不上 ──
    // 这说明送来的代码**和 pin 住的那份不一样**。两种可能：
    //   a) 电脑那边真的更新了代码（正常升级）
    //   b) 中间有人掉包了（要防的就是这个）
    // 从浏览器这边分不出是哪一种，所以采取保守做法：不用这份，
    // 并且**一定要让使用者看见**。
    //
    // ★ 这里原来有个 bug（实测抓出来的）：
    //   通知页面那句写在 `if (cached)` 分支**里面** —— 也就是只有"手里有
    //   旧版可退"时才告诉使用者。而最常见的情况恰恰是**还没有缓存**
    //   （刚 pin 完、或者清过缓存），那条路直接掉到下面的兜底分支，
    //   只往 SW 自己的 console 里打一行 —— 页面永远不知道。
    //   表现就是：篡改被拦住了，使用者看到的却是一个完全正常的页面。
    //   现在两个分支都通知。
    const notify = async () => {
      try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const c of clients) {
          c.postMessage({ type: 'dsh-code-mismatch', path: url.pathname, want, got });
        }
      } catch (e) { }
    };

    const cached = await readCachedBody(url.pathname, want);
    if (cached) {
      console.warn('[DSH] 代码指纹对不上，改用缓存版本：' + url.pathname);
      await notify();
      return cached;
    }

    // 连缓存都没有 —— 只能拒绝，不能执行一份来历不明的代码。
    // 返回的这段会**代替**那个文件被执行，所以它自己也得把警报拉起来：
    // 万一 postMessage 那条路也断了（旧浏览器、页面还没绑监听），
    // 至少这里还能插一条横幅出来。两道保险，因为这一层是唯一能发现
    // 「有人在改发给你的代码」的手段。
    console.error('[DSH] 代码指纹对不上且没有缓存，拒绝执行：' + url.pathname);
    await notify();
    const P = JSON.stringify(url.pathname);
    return new Response(
      '(function(){try{' +
      'var id="dsh-tamper-bar";if(document.getElementById(id))return;' +
      'if(!document.body){document.addEventListener("DOMContentLoaded",arguments.callee);return;}' +
      'var d=document.createElement("div");d.id=id;' +
      'd.style.cssText="position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
      'background:#4a1614;color:#ffd9d5;border-bottom:2px solid #a33;padding:14px 16px;' +
      'font:13.5px/1.75 -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px #000a";' +
      'd.innerHTML="<b style=\'font-size:15px\'>⚠️ 程序被改过，已拦下</b><br>' +
      '送来的 <code>"+ ' + P + ' + "</code> 和你手机上存的对不上，<b>已经拒绝执行</b>。<br>' +
      '如果你没在电脑上更新过程序，说明链路上有人正在改发给你的代码 —— ' +
      '<b>别输入敏感内容</b>，并考虑改用同一个 WiFi 下的加密地址。' +
      '<br><button onclick=\'this.parentNode.remove()\' style=\'margin-top:10px;padding:8px 16px;' +
      'border-radius:8px;cursor:pointer;background:#ffd9d5;color:#4a1614;border:0;' +
      'font-weight:600;font-size:13px\'>知道了</button>";' +
      'document.body.appendChild(d);' +
      '}catch(e){console.error("[DSH] 篡改提示渲染失败",e);}})();',
      { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
  })());
});

// ── Web Push ────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let payload = { title: 'DSH', body: '有新的进展' };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (err) {
    try { payload.body = event.data ? event.data.text() : payload.body; } catch (e) {}
  }

  const options = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.url || '/', forceOpen: payload.forceOpen === true },
    requireInteraction: false
  };
  if (payload.tag) {
    options.tag = payload.tag;
    options.renotify = true;
  }

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  const forceOpen = !!(event.notification.data && event.notification.data.forceOpen);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // An address-change notification must not merely focus an already-open
    // window at the old, dead tunnel origin.  Open the recovery URL instead.
    if (forceOpen && self.clients.openWindow) {
      await self.clients.openWindow(target);
      return;
    }
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});

// ── 页面发来的消息 ──────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const data = event.data || {};

  // A page may still be controlled by an older worker after the gateway has
  // shipped a new update UI. Prove this worker understands staged repins
  // before the page sends a manifest; never fall back to an unsafe old repin.
  if (data.type === 'dsh-verified-update-capability') {
    event.source && event.source.postMessage({
      type: 'dsh-verified-update-ready', requestId: data.requestId
    });
    return;
  }

  // 页面侧让 SW 自己弹一条本地通知，用于验证链路是否打通
  if (data.type === 'dsh-test-notification') {
    self.registration.showNotification(data.title || 'DSH 测试通知', {
      body: data.body || '如果你看到这条，说明通知链路是通的。',
      icon: '/icon-192.png',
      badge: '/icon-192.png'
    });
    return;
  }

  // pin 代码指纹。只在还没有 pin 的时候写 —— 一旦 pin 住就不许改，
  // 否则「掉包代码 + 顺便改掉 pin」就绕过去了，等于没做。
  if (data.type === 'dsh-pin-code' && data.manifest && data.manifest.files) {
    event.waitUntil((async () => {
      const existing = await readPin();
      if (existing) {
        event.source && event.source.postMessage({
          type: 'dsh-pin-result', ok: true, already: true,
          files: Object.keys(existing.files || {}).length
        });
        return;
      }
      await writePin(data.manifest);
      event.source && event.source.postMessage({
        type: 'dsh-pin-result', ok: true, already: false,
        files: Object.keys(data.manifest.files).length
      });
    })());
    return;
  }

  // 重新 pin —— **只在人明确点过之后**才会走到这里。
  //
  // 为什么必须有这个口子：上面那个「一旦 pin 住就不许改」是防「掉包代码顺便
  // 改掉 pin」，但它有个没想过的后果 —— **电脑那边正常更新一次代码，
  // 手机就永远卡在旧版上**，而且还会弹红字说"程序被改过"。
  // 防住了攻击，也防住了我自己发更新。
  //
  // 折中办法：把它变成**人来做决定**的事。
  //   · 自动更新？不做。脚本想改 pin？没有这条消息。
  //   · 只有页面在「使用者点了『我刚更新过，信任新版本』」之后发来的才认。
  // 攻击者要是能改页面代码，他本来就能干任何事 —— 但那种情况下
  // 这一层已经不是防线了（它防的是**局部**改动，不是整个页面被重写）。
  if ((data.type === 'dsh-repin-code' || data.type === 'dsh-repin-code-verified') &&
      data.manifest && data.manifest.files) {
    event.waitUntil((async () => {
      const before = await readPin();
      const resultType = data.type === 'dsh-repin-code-verified' ?
        'dsh-repin-verified-result' : 'dsh-repin-result';
      try {
        await stageVerifiedPin(data.manifest);
        await writePin(data.manifest);
        event.source && event.source.postMessage({
          type: resultType, requestId: data.requestId, ok: true,
          wasPinned: !!before,
          before: before ? Object.keys(before.files || {}).length : 0,
          files: Object.keys(data.manifest.files).length
        });
      } catch (err) {
        // Failed staging must not install a pin whose scripts are unavailable.
        event.source && event.source.postMessage({
          type: resultType, requestId: data.requestId, ok: false,
          reason: '新版本文件未能完整下载并验证；旧版本仍可用。'
        });
      }
    })());
    return;
  }


  if (data.type === 'dsh-pin-status') {
    event.waitUntil((async () => {
      const pin = await readPin();
      event.source && event.source.postMessage({
        type: 'dsh-pin-status-result',
        pinned: !!pin,
        at: pin ? pin.at : null,
        files: pin ? Object.keys(pin.files || {}).length : 0,
        // A page can warn about newly added scripts without silently
        // replacing a user's existing pin. These names are public assets;
        // the stored hashes and update decision stay in the Service Worker.
        paths: pin ? Object.keys(pin.files || {}) : []
      });
    })());
  }
});
