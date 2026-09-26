'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'e2ee.js'), 'utf8');
const secret = 'test-session-key-1234567890';

function load(hash, storage, persist) {
  const location = { hash, pathname: '/', search: '', reload: () => { location.reloaded = (location.reloaded || 0) + 1 } };
  const window = {
    location,
    history: { replaceState: (_a, _b, url) => { location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : ''; } },
    sessionStorage: storage,
    // 持久那份：2026-09-24 加的 —— 主屏图标打开时 iOS 会把 #片段丢掉，
    // 所以「你亲手打开过带钥匙的链接」这件事要在这台设备上记住。
    localStorage: persist || memory(),
    TextEncoder,
    TextDecoder,
    URL,
    console
  };
  const context = { window, TextEncoder, TextDecoder, URL, console, atob, btoa };
  vm.runInNewContext(source, context, { filename: 'e2ee.js' });
  return window;
}

function memory() {
  const data = new Map();
  return { getItem: (k) => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

const storage = memory();
const first = load('#k=' + encodeURIComponent(secret), storage);
assert.equal(first.__dshE2eeSecret, secret, 'first entry must consume the fragment key');

// ★ 这条断言是**反过来的**（2026-09-23 反的，这里当时没跟上，CI 一直红着）。
//
//   原来写的是 `assert.equal(first.location.hash, '')` —— 「取完把 # 抹掉」。
//   那个行为被**故意取消**了：iOS 的「添加到主屏幕」和书签保存的都是**当时的
//   地址**，抹掉之后存下来的就没有密钥，点开永远是空的 / 未加密，图标删了重加
//   多少次都没用。
//   所以现在要求的是：密钥**必须留在地址里**。
assert.ok(/#k=/.test(first.location.hash),
  'the #k= key must stay in the address bar (removing it breaks bookmarks and home-screen icons for good)');
assert.equal(decodeURIComponent(first.location.hash.match(/[#&]k=([^#&]+)/)[1]), secret);

const refreshed = load('', storage);
assert.equal(refreshed.__dshE2eeSecret, secret, 'refresh in the same browser session must retain E2EE');

// ── 2026-09-24：主屏图标打开时必须还能加密 ────────────────────────────────────
//
// 主屏图标曾能打开页面，却未保留加密密钥，导致内容无法加载。
// 原因：iOS 把「添加到主屏幕」存成书签时会**丢掉 `#` 后面的片段** ——
// 地址里没有钥匙，页面就永远是明文的，经隧道时实时通道还会被拒。
// 所以：你亲手打开过带 `#k=` 的链接，这台设备就把它记下来（localStorage）。
{
  const persist = memory();
  const withKey = load('#k=' + encodeURIComponent(secret), memory(), persist);
  assert.equal(withKey.__dshE2eeSecret, secret);
  assert.equal(withKey.DshE2EE.secretSource(), 'url', '从地址带来的钥匙，来源要标成 url');
  assert.ok(persist.getItem('dsh-e2ee-secret-persist-v1'), '没有把钥匙存进持久存储');

  // 换个「新会话」（sessionStorage 空）再从图标进来：地址里没有钥匙，但设备记得
  const icon = load('', memory(), persist);
  assert.equal(icon.__dshE2eeSecret, secret, '主屏图标（地址里没有 #k=）必须仍然能加密');
  assert.equal(icon.DshE2EE.secretSource(), 'stored', '这种钥匙的来源要标成 stored');

  // 地址里带了**新的**钥匙 → 以地址为准，并把持久那份覆盖掉
  const newer = secret.split('').reverse().join('');
  const rotated = load('#k=' + encodeURIComponent(newer), memory(), persist);
  assert.equal(rotated.__dshE2eeSecret, newer, '地址里的钥匙必须优先于本地存的那把');
  assert.equal(persist.getItem('dsh-e2ee-secret-persist-v1'), newer, '换钥匙之后本地那份要跟着更新');

  // 存进去的值太短（被写坏 / 老版本残留）→ 当没有，不许假装有钥匙
  const broken = memory();
  broken.setItem('dsh-e2ee-secret-persist-v1', 'short');
  assert.equal(load('', memory(), broken).__dshE2eeSecret, undefined,
    '持久存储里的短值不许被当成钥匙');
}

// 地址里没有、这个浏览器会话里也没有 → **不许假装有密钥**。
// 假装有的后果特别隐蔽：角标显示加密正常、WS 也拿到 101，但一帧都解不开，
// 界面上只是一片空白，没有任何错误。
const empty = memory();
assert.equal(load('', empty, memory()).__dshE2eeSecret, undefined, 'no key anywhere must not pretend there is one');

// 地址里出现**两把不同的**密钥（历史上真的产出过 `#k=A#k=A`）→ 当成没有密钥。
// 「取第一把就行」看着合理，但两份不一样时就是猜 —— 猜错的代价同上。
assert.equal(load('#k=' + encodeURIComponent(secret) + '#k=' + encodeURIComponent(secret + 'x'), empty, memory()).__dshE2eeSecret,
  undefined, 'two different keys in the URL must be treated as no key at all');

console.log('PASS: E2EE key survives a same-session refresh, stays in the address bar for bookmarks,');
console.log('      and is remembered on the device so the home-screen icon (which loses the #fragment) still encrypts.');
