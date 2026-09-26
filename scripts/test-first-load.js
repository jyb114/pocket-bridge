// 「第一次打开会比较慢，别刷新」横幅的测试。
//
// 这一条横幅的难点**不在显示**，在「什么时候不许显示」：
//   · 已经成功打开过一次的人，不该每次都被念一遍；
//   · 页面已经出来了，它还挂在那儿就是挡路；
//   · 设备语言是西语的人，不该看到中文。
// 所以测试里大部分用例是**不该显示**与**该消失**。
//
// 跑法：把 pwa/first-load.js 丢进一个假 DOM 的 vm 里（真文件，不是复制品），
// 用 __dshFirstLoadConfig 把三个时间调小，然后按时间线推进。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(BASE, 'pwa', 'first-load.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { bad++; console.log(`  ✗ ${m}`); };

/** 只会做这个脚本用到的那几件事的假 DOM */
function fakeWindow(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.store || {});

  function makeEl(tag) {
    return {
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      textContent: '',
      children: [],
      parentNode: null,
      attrs: {},
      style: { cssText: '', opacity: '' },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        this.children.push(c); c.parentNode = this; return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null; return c;
      },
      get firstElementChild() { return this.children[0] || null; },
      get firstChild() { return this.children[0] || null; }
    };
  }

  const root = makeEl('div'); root.id = 'root';
  const documentElement = makeEl('html');
  const doc = {
    readyState: o.readyState || 'loading',
    documentElement,
    body: o.noBody ? null : makeEl('body'),
    createElement: makeEl,
    getElementById: (id) => (id === 'root' ? root : null)
  };

  const win = {
    document: doc,
    navigator: { languages: o.languages || ['zh-CN'], language: (o.languages || ['zh-CN'])[0] },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { if (o.storageThrows) throw Error('quota'); store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    setTimeout, clearTimeout, setInterval, clearInterval, Date,
    __dshFirstLoadConfig: { slowMs: 40, stuckMs: 90, pollMs: 8 }
  };
  win.window = win;
  win.globalThis = win;
  // 假 DOM 里「界面出来了」＝ #root 有了子节点
  win.renderApp = () => { root.appendChild(makeEl('main')); };
  win.__store = store;
  win.__doc = doc;
  win.__root = root;
  return win;
}

function load(win) {
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'first-load.js' });
  return win.__dshFirstLoad;
}

const bannerOf = (win) => {
  const all = win.__doc.documentElement.children.concat(win.__doc.body ? win.__doc.body.children : []);
  return all.find((e) => e.id === 'dsh-gw-firstload') || null;
};
/**
 * 「看得见的横幅」。
 *
 * 和 bannerOf 的区别很重要：横幅是**先淡出、350ms 后才从 DOM 里摘掉**的，
 * 所以「界面出来了」那一刻它还在 DOM 里，只是 opacity 已经归零 —— 那叫收掉了。
 * 第一版测试拿 bannerOf 判「还在不在」，于是把正确的行为判成了失败。
 */
const visibleBanner = (win) => {
  const b = bannerOf(win);
  return b && b.style.opacity !== '0' ? b : null;
};
const textOf = (win) => {
  const b = visibleBanner(win);
  return b && b.children.length ? b.children.map((c) => c.textContent).join(' | ') : null;
};

(async () => {
  console.log('\n第一次打开：该显示的必须显示\n');
  {
    const w = fakeWindow({ languages: ['zh-CN'] });
    load(w);
    const b = bannerOf(w);
    if (!b) { fail('第一次打开没出现横幅'); }
    else {
      ok('第一次打开立刻出现横幅');
      assert.ok(b.children[0].textContent.includes('第一次打开会比较慢'), '文案不对：' + b.children[0].textContent);
      assert.ok(/position:fixed/.test(b.style.cssText), '必须是 fixed —— 不能把页面顶下去');
      assert.ok(/pointer-events:none/.test(b.style.cssText), '必须 pointer-events:none —— 不能挡住页面');
      ok('文案与样式都对：fixed 定位 + 不拦点击');
    }
  }

  console.log('\n界面出来了：横幅必须自己消失，并记住「加载成功过」\n');
  {
    const w = fakeWindow({ languages: ['zh-CN'] });
    const api = load(w);
    assert.ok(bannerOf(w), '一开始就该有横幅');
    w.renderApp();
    await sleep(60);
    if (visibleBanner(w)) fail('界面已经出来了，横幅还看得见');
    else ok('界面一出来横幅就收掉（先淡出，再摘掉）');
    await sleep(420);
    if (bannerOf(w)) fail('横幅淡出之后没被摘掉');
    else ok('淡出之后元素真的从 DOM 里摘掉了');
    assert.equal(w.__store['dsh-gw-loaded-once-v1'], '1');
    ok('localStorage 记下「成功加载过」（下次不再念第一次那句）');
    assert.equal(api.state().done, true);
  }

  console.log('\n已经成功打开过的人：不该被打扰\n');
  {
    const w = fakeWindow({ store: { 'dsh-gw-loaded-once-v1': '1' }, languages: ['zh-CN'] });
    load(w);
    await sleep(20);              // slowMs=40，还没到
    if (bannerOf(w)) fail('以前加载成功过，这次很快，却又弹横幅');
    else ok('加载快的时候：什么都不显示');
    w.renderApp();
    await sleep(40);
    if (bannerOf(w)) fail('界面都出来了还有横幅');
    else ok('界面出来之后也不会有横幅');
  }

  console.log('\n已经成功打开过、但这次确实慢：提示「这次偏慢」而不是「第一次」\n');
  {
    const w = fakeWindow({ store: { 'dsh-gw-loaded-once-v1': '1' }, languages: ['zh-CN'] });
    load(w);
    await sleep(60);              // 超过 slowMs=40
    const txt = textOf(w);
    if (!txt) fail('慢的时候没有提示');
    else if (!txt.includes('这次加载比平时慢')) fail('慢的时候用错了文案：' + txt);
    else if (txt.includes('第一次打开')) fail('已经打开过的人不该看到「第一次打开」');
    else ok('慢的时候给的是「这次加载比平时慢」');
  }

  console.log('\n等太久：补一句「去电脑上看看服务还在不在」\n');
  {
    const w = fakeWindow({ languages: ['zh-CN'] });
    load(w);
    await sleep(120);             // 超过 stuckMs=90
    const txt = textOf(w);
    if (!txt || !txt.includes('控制台')) fail('等太久没有补充提示：' + txt);
    else ok('超过 45 秒补一句「到电脑上打开控制台看一眼」（只有一次）');
    const b = bannerOf(w);
    const lines = b.children.length;
    await sleep(40);
    assert.equal(bannerOf(w).children.length, lines, '补充提示只该加一次，不该越堆越多');
    ok('那句补充提示只加一次，不会每轮堆一行');
  }

  console.log('\n语种：跟着设备语言和手动选择走\n');
  {
    for (const [languages, flag, want, name] of [
      [['zh-CN'], null, '第一次打开会比较慢', '中文'],
      [['en-US'], null, 'The first load takes a while', '英语'],
      [['es-ES'], null, 'La primera vez tarda un poco', '西语'],
      // 设备是西语、但使用者在页面上手动选过英文 —— 手动优先
      [['es-ES'], 'en', 'The first load takes a while', '手动选过英文'],
      // 设备语言是我们不支持的小语种：退回英语（和 i18n.js 的兜底一致）
      [['de-DE'], null, 'The first load takes a while', '不支持的语种 → 英语']
    ]) {
      const w = fakeWindow({ languages, store: flag ? { 'dsh-lang': flag } : {} });
      load(w);
      const txt = textOf(w);
      if (!txt || !txt.includes(want)) fail(`${name}：文案不对（${txt}）`);
      else ok(`${name}：${want.slice(0, 22)}…`);
    }
  }

  console.log('\n三种语言都得写全（漏一条就是空白）\n');
  {
    // 从源码里把 TEXT 表抠出来：这里不查翻译质量，只查「一条都不缺」
    const at = SRC.indexOf('var TEXT = {');
    const end = SRC.indexOf('\n  };', at);
    const TEXT = vm.runInNewContext(`(${SRC.slice(SRC.indexOf('{', at), end + 4)})`, {});
    const miss = [];
    for (const lg of ['zh', 'en', 'es']) {
      for (const k of ['first', 'slow', 'stuck']) {
        if (!TEXT[lg] || typeof TEXT[lg][k] !== 'string' || !TEXT[lg][k].trim()) miss.push(`${lg}.${k}`);
      }
    }
    assert.deepEqual(miss, []);
    ok('中/英/西 × 三条文案，一条都不缺');
  }

  console.log('\n没 body 的时候也不能崩（这段脚本在 <head> 里就跑）\n');
  {
    const w = fakeWindow({ languages: ['zh-CN'], noBody: true });
    load(w);
    const b = bannerOf(w);
    if (!b) fail('还没有 body 的时候横幅没挂上');
    else if (b.parentNode !== w.__doc.documentElement) fail('没有 body 时应该先挂在 documentElement 上');
    else ok('没有 body：先挂在 documentElement 上');
    // body 出现之后要挪进去，不留一个「html 的野孩子」
    w.__doc.body = { children: [], appendChild: null };
    const body = (function () {
      const el = { id: '', children: [], parentNode: null, style: {}, textContent: '' };
      el.appendChild = function (c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; };
      el.removeChild = function (c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; };
      return el;
    })();
    w.__doc.body = body;
    await sleep(30);
    if (bannerOf(w) && bannerOf(w).parentNode === body) ok('body 出现后横幅挪进 body');
    else fail('body 出现后没有挪进去（' + (bannerOf(w) ? bannerOf(w).parentNode === w.__doc.documentElement ? '还在 documentElement 上' : '不见了' : '横幅没了') + '）');
  }

  console.log('\n存不了 localStorage 的设备（隐私模式）：不崩，照常提示\n');
  {
    const w = fakeWindow({ languages: ['zh-CN'], storageThrows: true });
    load(w);
    assert.ok(visibleBanner(w), '存不了 localStorage 时也应该提示');
    w.renderApp();
    await sleep(30);
    assert.ok(!visibleBanner(w), '界面出来之后照样要收掉');
    ok('localStorage 写不进去：不抛异常，横幅行为不变');
  }

  console.log('\n接进网关的那几条线（静态核对 mobile-proxy.js）\n');
  {
    const proxy = fs.readFileSync(path.join(BASE, 'scripts', 'mobile-proxy.js'), 'utf8');
    const must = [
      ["'/first-load.js': { file: 'first-load.js'", 'PWA_ROUTES 里没有它 → 取不到文件'],
      ["'/first-load.js',", 'BOOTSTRAP_PATHS 里没有它 → 认证之前取不到（横幅时有时无）'],
      ["'<script src=\"/first-load.js\"></script>'", '没有注入到页面里']
    ];
    const miss = must.filter(([needle]) => !proxy.includes(needle)).map(([, why]) => why);
    // 清单里之后还可能增加其它脚本；核对成员身份，不依赖它恰好是最后一项。
    const manifest = proxy.match(/if \(u\.pathname === '\/code-manifest\.json'\) \{[\s\S]*?const files = \[([\s\S]*?)\];/);
    const manifestFiles = manifest ? [...manifest[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
    if (!manifestFiles.includes('/first-load.js')) miss.push('code-manifest 里没有它 → 被改过也发现不了');
    assert.deepEqual(miss, []);
    ok('四条线都接上了：能取到 / 认证前能取到 / 注入页面 / 进代码指纹');

    // 顺序：必须排在 polyfill.js 之前（那是「最早的时刻」这句话的全部意义）
    const injectAt = proxy.indexOf('<script src="/first-load.js"></script>');
    const polyAt = proxy.indexOf('<script src="/polyfill.js"></script>', injectAt);
    assert.ok(injectAt > 0 && polyAt > injectAt, 'first-load.js 没有排在 polyfill.js 前面');
    ok('注入顺序在 polyfill.js 之前');
  }

  console.log(bad ? `\n${bad} 处问题\n` : '\n全部通过\n');
  // 直接退：有几条用例故意让横幅一直挂着（「界面一直没出来」那种），
  // 它内部的轮询定时器会一直占着事件循环 —— 不等它，否则这个测试永远不结束。
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
