// 手机端图片加载失败的回归测试。
//
// 网关日志实锤：
//   2026-09-26T08:34:01Z 拒绝明文（/codex/file）：经中继但没要求加密
//
// 原来那一块**一开始就把明文地址写进 <img src>**：
//   · 经中继的明文请求必被网关拒（内容通道要端到端加密）；
//   · onerror 立刻把整块换成「打不开这张图」；
//   · 等加密那份取回来时，img 已经被摘出文档（isConnected=false）被丢掉。
//   结果是**永远显示打不开** —— 加密那条路其实是好的，被明文那一次抢跑毁了。
//
// 现在：有钥匙时不留明文 src，只用 privateFetch（带 x-dsh-e2ee + 证明重试）
// 取回来再塞成 blob 地址；没钥匙（内网明文模式）才直接用地址。
//
// 服务端那一半也实测过（脚本见 CHANGELOG）：
//   明文请求 → 403；带 x-dsh-e2ee → 200 image/jpeg，正文就是原始 JPEG 字节。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
const { extractFunction } = require('./page-source.js');

let pass = 0; let fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + e : ''}`); } };

console.log('\n[0] 主屏幕名称');
ok('Codex 页面添加到主屏幕后显示 Pocket Bridge',
  /<meta name="apple-mobile-web-app-title" content="Pocket Bridge">/.test(SRC));

console.log('\n[1] 静态：图片必须走加密那条路');
{
  const fn = extractFunction(SRC, 'buildImageView');
  assert.ok(fn && fn.length > 200, '抠不出 buildImageView');
  ok('用文件请求取图（不是裸 <img src>）', /fileRequest\(p, 900\)/.test(fn));
  // ★ 钥匙必须是「**调用时现取**」，不能在渲染这条消息时存成一个快照。
  //
  //   2026-09-29 改（原来这条断言要求源码里出现 `var secret = window.__dshE2eeSecret`，
  //   那是在锁定实现细节，而不是锁住意图）：
  //
  //   存快照的写法在页面早期（密钥还没解析出来 / 这一页渲染得早）会存到空值，
  //   于是这张图**永远**走明文那条路；而网关对内容通道是「拒绝明文、不降级」的 ——
  //   稳定 403，界面上就是「这张图没取回来」。使用者报的正是这个。
  //   所以这里反过来断言：**不许**再出现那种快照写法。
  ok('不把密钥存成渲染期的快照（那是 403 的来源）',
    !/var secret = window\.__dshE2eeSecret/.test(fn));
  ok('钥匙有「现取」的入口', /function e2eeSecret|secretFromUrl\(|secretSource\(\)/.test(fn));
  ok('失败给「重试」而不是一句死话', /imgretry/.test(fn));
  ok('点开原图也走文件请求', /function openFull[\s\S]{0,400}fileRequest\(p\)/.test(fn));
}

/** 只做 buildImageView 用到的那几件事的假 DOM */
function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), className: '', isConnected: true,
    src: '', listeners: {}, attrs: {}, _html: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    querySelector(sel) {
      if (sel === '.imgwrap') return this._wrap || null;
      if (sel === 'img') return this._img || null;
      if (sel === 'a') return this._a || null;
      if (sel === '.imgretry') return this._retry || null;
      return null;
    }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      if (/class="imgwrap"/.test(this._html)) { this._wrap = mkEl('div'); }
      const scope = this._wrap || this;
      scope._img = /<img/.test(this._html) ? mkEl('img') : null;
      scope._a = /<a /.test(this._html) ? mkEl('a') : null;
      scope._retry = /imgretry/.test(this._html) ? mkEl('a') : null;
    }
  });
  return el;
}

function run(opts) {
  const requested = [];
  const created = [];
  const revoked = [];
  const opened = [];
  const timers = [];
  const observers = [];
  let resolveFetch;
  const box = {
    esc: (x) => String(x == null ? '' : x),
    t: (x) => x,
    document: { createElement: mkEl, body: mkEl('body') },
    window: {
      __dshE2eeSecret: opts.secret ? 'S'.repeat(24) : null,
      location: { hostname: opts.remote ? 'relay.example.test' : '192.168.1.3' },
      open: (...args) => { opened.push(args); return {}; }
    },
    fileUrl: (p, w) => '/codex/file?path=' + encodeURIComponent(p) + (w ? '&w=' + w : ''),
    fileIcon: () => '🖼',
    shortPath: (p) => String(p).split(/[\\/]/).pop(),
    toast: () => { },
    URL: {
      createObjectURL: () => { const url = 'blob:fake-' + (created.length + 1); created.push(url); return url; },
      revokeObjectURL: (url) => { revoked.push(url); }
    },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    MutationObserver: function (callback) {
      this.callback = callback;
      this.observe = () => { };
      this.disconnect = () => { };
      observers.push(this);
    },
    imageBlobRecords: [],
    imageBlobObserver: null,
    privateFetch: (url, init) => {
      requested.push({ url, init });
      if (opts.defer) return new Promise((resolve) => { resolveFetch = resolve; });
      if (opts.fail) return Promise.resolve({ ok: false, status: 403 });
      return Promise.resolve({ ok: true,
        headers: { get: (name) => name === 'x-dsh-e2ee-decrypted' && opts.secret && !opts.unmarked ? '1' : null },
        blob: () => Promise.resolve({ size: 10 }) });
    },
    Promise, Object, String, RegExp, Number, Array, JSON, Error
  };
  box.window.DshE2EE = { secretSource: () => (opts.secret ? 'stored' : null) };
  vm.createContext(box);
  vm.runInContext(extractFunction(SRC, 'plainLocalOrigin'), box);
  vm.runInContext(extractFunction(SRC, 'fileRequest'), box);
  vm.runInContext(extractFunction(SRC, 'releaseImageBlob'), box);
  vm.runInContext(extractFunction(SRC, 'watchImageBlob'), box);
  vm.runInContext(extractFunction(SRC, 'buildImageView'), box);
  const el = box.buildImageView('C:/x/y.png', '');
  return { el, requested, created, revoked, opened, timers, observers,
    resolveFetch: (response) => resolveFetch(response) };
}
const tick = () => new Promise((r) => setTimeout(r, 40));

console.log('\n[2] 行为：谁在什么时候被请求');
(async () => {
  // 有钥匙：第一次请求就得是 privateFetch 那条，而且 HTML 里不能有明文 src
  const enc = run({ secret: true });
  ok('有钥匙时：HTML 里没有明文 src（否则那次请求必被网关拒）',
    !/src="/.test(enc.el.innerHTML), enc.el.innerHTML.slice(0, 80));
  await tick();
  ok('有钥匙时：文件路径只在加密 POST 请求体内，不在 URL 中',
    enc.requested.length === 1 && enc.requested[0].url === '/codex/file' &&
    enc.requested[0].init.method === 'POST' &&
    JSON.parse(enc.requested[0].init.body).path === 'C:/x/y.png' &&
    JSON.parse(enc.requested[0].init.body).w === 900,
    JSON.stringify(enc.requested));
  {
    const wrap = enc.el.querySelector('.imgwrap');
    const img = wrap && wrap.querySelector('img');
    ok('取回来之后 img.src 是 blob 地址（不经过网络，隧道看不到）',
      !!(img && String(img.src).startsWith('blob:')), img ? img.src : '(没有 img)');
    ok('图片加载前不回收仍在使用的 blob 地址', enc.revoked.length === 0);
    if (img && img.onload) img.onload();
    ok('图片仍显示时保留 blob 地址，供长按保存', !enc.revoked.includes(img && img.src),
      JSON.stringify({ created: enc.created, revoked: enc.revoked }));
    if (img) img.isConnected = false;
    enc.observers.forEach((observer) => observer.callback([]));
    ok('图片节点移除后回收预览 blob 地址', enc.revoked.includes(img && img.src),
      JSON.stringify({ created: enc.created, revoked: enc.revoked }));
    const link = wrap && wrap.querySelector('a');
    if (link && link.listeners.click) link.listeners.click({ preventDefault() {} });
    await tick();
    ok('打开原图使用第二个 blob 地址', enc.opened.length === 1 && enc.opened[0][0] === enc.created[1],
      JSON.stringify(enc.opened));
    enc.timers.forEach((timer) => timer.fn());
    ok('原图打开后定时回收第二个 blob 地址', enc.revoked.includes(enc.created[1]),
      JSON.stringify({ created: enc.created, revoked: enc.revoked }));
  }

  const failedImage = run({ secret: true });
  await tick();
  {
    const img = failedImage.el.querySelector('.imgwrap').querySelector('img');
    if (img && img.onerror) img.onerror();
    ok('图片解码失败后也回收预览 blob 地址', failedImage.revoked.includes(img && img.src),
      JSON.stringify({ created: failedImage.created, revoked: failedImage.revoked }));
  }

  const neverLoaded = run({ secret: true });
  await tick();
  const pending = neverLoaded.el.querySelector('.imgwrap').querySelector('img');
  if (pending) pending.isConnected = false;
  neverLoaded.observers.forEach((observer) => observer.callback([]));
  ok('图片始终不触发加载事件，但节点移除时仍回收 blob 地址',
    neverLoaded.revoked.includes(neverLoaded.created[0]),
    JSON.stringify({ created: neverLoaded.created, revoked: neverLoaded.revoked }));

  const removedBeforeFetch = run({ secret: true, defer: true });
  removedBeforeFetch.el.isConnected = false;
  removedBeforeFetch.resolveFetch({ ok: true, blob: () => Promise.resolve({ size: 10 }) });
  await tick();
  ok('请求回来前图片卡片已移除时，不创建 blob 地址',
    removedBeforeFetch.created.length === 0, JSON.stringify(removedBeforeFetch.created));

  // 没钥匙（内网明文模式）：通过 fetch/blob 使用旧 GET，绝不直接导航到路径 URL。
  const plain = run({ secret: false });
  await tick();
  {
    const wrap = plain.el.querySelector('.imgwrap');
    const img = wrap && wrap.querySelector('img');
    ok('没钥匙的内网模式照旧能显示图片，但用本地 blob 而非直接 URL',
      img && /^blob:/.test(img.src) && !/src="\/codex\/file/.test(wrap.innerHTML));
    ok('没钥匙的内网模式只请求本地旧 GET',
      plain.requested.length === 1 && /^\/codex\/file\?path=/.test(plain.requested[0].url));
  }

  const remoteWithoutKey = run({ secret: false, remote: true });
  const remoteHtml = remoteWithoutKey.el.querySelector('.imgwrap').innerHTML;
  ok('隧道地址缺密钥时不发出含电脑路径的图片请求',
    !/<img|href="\/codex\/file/.test(remoteHtml) && remoteWithoutKey.requested.length === 0,
    remoteHtml.slice(0, 120));
  ok('隧道地址缺密钥时明确提示重新打开完整地址', /#k=/.test(remoteHtml));

  const unmarked = run({ secret: true, unmarked: true });
  await tick();
  const unmarkedHtml = unmarked.el.querySelector('.imgwrap').innerHTML;
  ok('密钥存在但文件响应未获解密证明时拒绝渲染',
    unmarked.created.length === 0 && !/<img/.test(unmarkedHtml) && /加密校验/.test(unmarkedHtml),
    unmarkedHtml.slice(0, 140));

  const cardBox = { document: { createElement: mkEl }, fileUrl: () => '/codex/file',
    fileIcon: () => '📄', shortPath: (p) => p.split('/').pop(),
    esc: (x) => String(x), t: (x) => x };
  vm.createContext(cardBox);
  vm.runInContext(extractFunction(SRC, 'buildFileCard'), cardBox);
  const card = cardBox.buildFileCard('D:/Project/private report.md');
  ok('文件变更卡走加密下载按钮，不再直接打开明文链接',
    card.tagName === 'BUTTON' && card.attrs['data-filecite'] === 'D:/Project/private report.md' && !card.href);

  const sent = [];
  const guarded = {
    window: { location: { hostname: 'relay.example.test' }, __dshE2eeSecret: null },
    fetch: (...args) => { sent.push(args); return Promise.resolve({ ok: true }); },
    t: (x) => x, Promise, Number, String, RegExp, Error, Object
  };
  vm.createContext(guarded);
  vm.runInContext(extractFunction(SRC, 'plainLocalOrigin'), guarded);
  vm.runInContext(extractFunction(SRC, 'privateFetch'), guarded);
  await guarded.privateFetch('/codex/queue', { method: 'POST', body: 'secret message' }).then(
    () => ok('缺密钥的隧道消息绝不降级为明文', false),
    () => ok('缺密钥的隧道消息绝不降级为明文', sent.length === 0));
  guarded.window.__dshE2eeSecret = 'S'.repeat(24);
  await guarded.privateFetch('/codex/queue', { method: 'POST', body: 'secret message' }).then(
    () => ok('加密模块缺失时绝不明文发送', false),
    () => ok('加密模块缺失时绝不明文发送', sent.length === 0));
  let sockets = 0;
  const socketGuard = {
    window: { __dshE2eeSecret: null }, plainLocalOrigin: () => false,
    setConn() {}, toast() {}, t: (x) => x,
    WebSocket: function () { sockets++; }, location: { protocol: 'https:', host: 'relay.example.test' }
  };
  vm.createContext(socketGuard);
  vm.runInContext(extractFunction(SRC, 'connect'), socketGuard);
  socketGuard.connect();
  ok('缺密钥的隧道页不建立明文 Codex WebSocket', sockets === 0);

  // 取不回来：给「重试」，并且不许把「还没验证完」说成「图坏了」
  const bad = run({ secret: true, fail: true });
  await tick();
  const badWrap = bad.el.querySelector('.imgwrap');
  const badHtml = badWrap ? badWrap.innerHTML : '';
  ok('取不回来时：显示「重试」而不是死路', /imgretry/.test(badHtml), badHtml.slice(0, 140));
  ok('取不回来时：措辞是「没取回来」而不是「打不开」', /没取回来/.test(badHtml));
  ok('取不回来时：不留一个破图（wrap 里没有 <img>）', !/<img/.test(badHtml));

  console.log(`\n${fail ? `${fail} 处问题` : '全部通过'}（${pass} 项）\n`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('跑挂了：' + (e && e.stack)); process.exit(1); });
