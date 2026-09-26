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

async function readCachedBody(url) {
  try {
    const c = await caches.open(BODY_CACHE);
    const r = await c.match(url);
    return r || null;
  } catch (err) { return null; }
}

async function writeCachedBody(url, body) {
  try {
    const c = await caches.open(BODY_CACHE);
    await c.put(url, new Response(body, {
      headers: { 'content-type': 'application/javascript; charset=utf-8' }
    }));
  } catch (err) { /* 存不下不影响本次 */ }
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
      const cached = await readCachedBody(url.pathname);
      if (cached) return cached;
      throw err;
    }
    await acceptAccessKeyEpoch(res);
    if (!res.ok) return res;

    const body = await res.clone().arrayBuffer();
    const got = await sha256Hex(body);

    if (got === want) {
      await writeCachedBody(url.pathname, body);     // 指纹对，更新缓存
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

    const cached = await readCachedBody(url.pathname);
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
  if (data.type === 'dsh-repin-code' && data.manifest && data.manifest.files) {
    event.waitUntil((async () => {
      const before = await readPin();
      await writePin(data.manifest);
      const after = await readPin();
      // 换了指纹，旧缓存里的代码就跟不上了 —— 清掉，让它按新的重新取一遍
      try { await clearCachedBodies(); } catch (e) { }
      event.source && event.source.postMessage({
        type: 'dsh-repin-result', ok: !!after,
        wasPinned: !!before,
        before: before ? Object.keys(before.files || {}).length : 0,
        files: after ? Object.keys(after.files || {}).length : 0
      });
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
        files: pin ? Object.keys(pin.files || {}).length : 0
      });
    })());
  }
});
