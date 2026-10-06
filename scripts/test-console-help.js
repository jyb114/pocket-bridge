// 控制台「复制地址」旁边那句说明 —— 它到底能不能用手机操控电脑。
//
// 地址旁需要解释目标程序运行时，手机可以查看和操作电脑上的 DSH。
//
// 也就是：这按钮复制出来的东西，**是什么、能干什么、前提是什么**，得说清楚。
// 这一条测试盯的就是那几句话：在不在、翻没翻、什么时候出现。
//
// 2026-09-26 又加了一条：**配对码必须显示在控制台第一页上**。
// 「配对的 6 位数字」原来跟着二维码那一块一起被删了，而接口（entries.pairCode）
// 一直都在给 —— 手机上要求输配对码时，使用者在电脑上翻遍控制台也找不到。
// 这条断言就是那次事故的回归：接口有、界面上没有，必须判失败。
//
// 怎么测的：把 console.html 里的 renderEntries() **整段抠出来**，在一个假 DOM 里
// 真跑一遍 —— 只看源码里有没有那几句话是不够的：
//   · 那句话可能挂在永远不会执行的 else 分支里；
//   · 「都没在跑」那句少一道判断，就会在 DSH 好好跑着的时候也乱喊。
// 这两种错，静态扫字符串都发现不了。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const { extractRegisterArg, extractFunction } = require('./page-source.js');

const HOWTO = '把上面的地址发到手机打开，就能用手机操控电脑上的 DSH：发消息、看进度、批准操作。电脑上要先启动 DSH。';
const NO_TARGET = '先在下面「本机服务」里启动 DSH，手机连上才有东西可用。';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { bad++; console.log(`  ✗ ${m}`); };

const html = fs.readFileSync(path.join(BASE, 'pwa', 'console.html'), 'utf8');
const dict = vm.runInNewContext(`(${extractRegisterArg(html)})`, {});

// ── 抠出 renderEntries() 整段（按大括号配对，不能拿正则切）──────────────────
// 实现搬到了 page-source.js —— test-release-lock.js 也要用同一份。

/** 只做 renderEntries 用得到的那几件事的假 DOM */
function fakeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', innerHTML: '',
    children: [], parentNode: null, attrs: {}, onclick: null,
    style: { cssText: '', opacity: '' },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    get firstElementChild() { return this.children[0] || null; }
  };
}

/**
 * 真跑一遍 renderEntries()。
 * lang='en' 时会用字典里的英文 —— 用来证明那几句话是**走 t() 的**，
 * 而不是把中文硬写在代码里（硬写的话切语言就不动了）。
 */
/** 假 DOM 里按 id 递归找（卡片是嵌套的，box.children 只看得到第一层） */
function deepFind(el, id) {
  if (!el) return null;
  if (el.id === id) return el;
  for (const c of el.children || []) {
    const hit = deepFind(c, id);
    if (hit) return hit;
  }
  return null;
}
/** 卡片里所有按钮（递归） */
function deepButtons(el) {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) { if (c.tagName === 'BUTTON') out.push(c); walk(c); }
  })(el);
  return out;
}

function runRenderEntries(targets, opts) {
  const o = opts || {};
  const box = fakeEl('div');
  const copied = [];
  const opened = [];
  let httpsRequests = 0;
  const nodes = new Map([['entries', box]]);
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, fakeEl('div'));
    return nodes.get(id);
  };
  node('btn-lanhttps-on').click = () => { httpsRequests++; };
  const lang = o.lang || 'zh';
  const T = (s) => {
    if (lang === 'zh') return s;
    const e = dict[s];
    return (e && e[lang]) || s;
  };
  const entries = {
    lan: ['http://192.168.1.5:8080/k/fixture-access#k=fixture-encryption-key-123456'],
    lanHttps: [],
    wan: 'https://fixture.example/k/fixture-access#k=fixture-encryption-key-123456',
    // 默认给一个配对码 —— 服务端（/__console/status）一直都会给这个字段。
    pairCode: o.pairCode === undefined ? '419203' : o.pairCode,
    ...o.entries
  };
  const sandbox = {
    state: { data: { targets } },
    document: { createElement: fakeEl },
    $: node,
    t: T, tr: T,
    esc: (s) => String(s == null ? '' : s),
    mkBtn: (label, cls, fn) => { const b = fakeEl('button'); b.textContent = label; b.className = cls || ''; b.onclick = fn; return b; },
    copy: (v, label) => { copied.push([v, label]); }, homeOperation: () => { }, homeMutate: () => { },
    open: (...args) => { opened.push(args); }, addressChanging: !!o.addressChanging,
    load: () => {}, renderDevices: () => {}, renderNotify: () => {}, loadBalance: () => {},
    renderAdvanced: () => {}, applyI18n: () => {}, renderDesktopSummary: () => {}, renderRestartWait: () => {},
    renderTargets: () => {},
    console
  };
  sandbox.window = sandbox;
  sandbox.URL = URL;
  vm.createContext(sandbox);
  for (const fn of ['dshLiteAddress', 'entryList', 'bestEntry', 'maskedEntry', 'render']) {
    vm.runInContext(extractFunction(html, fn), sandbox, { filename: fn });
  }
  vm.runInContext(extractFunction(html, 'renderEntries'), sandbox, { filename: 'renderEntries' });
  if (o.hero) sandbox.render({ gateway: { running: true }, targets, entries, devices: [] });
  else sandbox.renderEntries(entries);
  const find = (id) => box.children.find((c) => c.id === id) || null;
  return { box, find, copied, opened, entries, sandbox, node, get httpsRequests() { return httpsRequests; } };
}

console.log('\n[静态] 那几句说明在不在、翻没翻\n');
{
  for (const [key, what] of [[HOWTO, '「这条地址能干什么」'], [NO_TARGET, '「目标没在跑」的提示']]) {
    if (!html.includes(key)) { fail(`${what}：console.html 里根本没有这句话`); continue; }
    const e = dict[key];
    if (!e) { fail(`${what}：字典里没有它（切到英/西文就是中文原文）`); continue; }
    const miss = ['en', 'es'].filter((lg) => !e[lg] || !String(e[lg]).trim());
    if (miss.length) { fail(`${what}：缺 ${miss.join('/')}`); continue; }
    ok(`${what}：中/英/西都有`);
  }
  if (!NO_TARGET.includes('本机服务')) fail('提示里没有指向「本机服务」');
  else ok('提示指向的名字（本机服务）和界面上那块板块一致');

  for (const [key, what] of [
    ['手机上要输配对码时', '配对码卡的标题'],
    ['手机提示输入配对码时：在手机上打开 /pair，填这 6 位数字。重启不会换；签发满 90 天后，或你点「换一个配对码」时才会换。已连上的手机不受影响。', '配对码卡的说明']
  ]) {
    if (!html.includes(key)) { fail(`${what}：console.html 里根本没有这句话`); continue; }
    const e = dict[key];
    if (!e) { fail(`${what}：字典里没有它（切到英/西文就是中文原文）`); continue; }
    const miss = ['en', 'es'].filter((lg) => !e[lg] || !String(e[lg]).trim());
    if (miss.length) fail(`${what}：缺 ${miss.join('/')}`);
    else ok(`${what}：中/英/西都有`);
  }
}

console.log('\n[行为] 真的把 renderEntries() 跑一遍\n');
{
  // ① 有目标在跑：说明要有，「都没在跑」不能出现
  {
    const r = runRenderEntries([
      { id: 'dsh', installed: true, running: true },
      { id: 'codex', installed: true, running: false }
    ]);
    const howto = r.find('entries-howto');
    if (!howto) fail('有目标在跑：那句「这条地址能干什么」没显示');
    else if (!/DSH/.test(howto.textContent) || !/手机/.test(howto.textContent)) fail(`说明内容不对：${howto.textContent}`);
    else ok('有目标在跑：显示「手机能操控电脑上的 DSH」');
    if (r.find('entries-no-target')) fail('有目标在跑，却还在提示「都没在跑」');
    else ok('有目标在跑：不会乱喊「都没在跑」');
  }

  // ② 装了但都没跑：两句都要有
  {
    const r = runRenderEntries([
      { id: 'dsh', installed: true, running: false },
      { id: 'codex', installed: true, running: false }
    ]);
    const warn = r.find('entries-no-target');
    if (!warn) fail('一个都没在跑，却没有提示去「本机服务」启动');
    else if (!warn.textContent.includes('本机服务')) fail(`提示没指向「本机服务」：${warn.textContent}`);
    else ok('都没在跑：提示「先去『本机服务』里把它们启动起来」');
    if (!r.find('entries-howto')) fail('都没在跑时反而看不到那句说明');
    else ok('两句同时在：先说能干什么，再说现在还不能用');
  }

  // ③ 一个都没装：也算「没在跑」
  {
    const r = runRenderEntries([{ id: 'dsh', installed: false, running: false }]);
    if (!r.find('entries-no-target')) fail('什么都没装的时候没有提示');
    else ok('什么都没装：一样提示去「本机服务」');
  }

  // ④ 切英文：那几句话必须跟着走（证明走了 t()，不是硬编码中文）
  {
    const r = runRenderEntries([{ id: 'dsh', installed: true, running: false }], { lang: 'en' });
    const howto = r.find('entries-howto'), warn = r.find('entries-no-target');
    if (!howto || /[\u4e00-\u9fff]/.test(howto.textContent)) fail(`英文界面下说明还是中文：${howto && howto.textContent}`);
    else ok('切英文：说明跟着变成英文');
    if (!warn || !/Local services/.test(warn.textContent)) fail(`英文界面下提示不对：${warn && warn.textContent}`);
    else ok('切英文：提示指向的是 “Local services”（和界面上的板块名一致）');
  }

  // ⑤ 配对码：接口给了，界面上就**必须**看得见
  //
  //   这条是 2026-09-26 那次事故的回归断言。当时 /__console/status 一直返回
  //   entries.pairCode，而显示它的那张卡跟着二维码一起被删了 —— 手机上要求
  //   输配对码，电脑上找不到那 6 位数字。
  //   只验接口不算验界面，所以这里查的是**渲染出来的 DOM**。
  {
    const r = runRenderEntries([{ id: 'dsh', installed: true, running: true }]);
    const card = r.find('pair-card');
    const code = card ? deepFind(card, 'v-paircode') : null;
    if (!card) fail('控制台第一页上没有配对码那张卡（接口里有，界面上看不见）');
    else if (!code) fail('配对码卡上没有 #v-paircode 元素');
    // 失败也不打印码值：这是凭据，而这个输出会被贴进聊天或日志。
    else if (code.textContent !== '419203') fail('卡上显示的不是接口给的那个码（只比对，不打印码值）');
    else ok('配对码显示在控制台第一页上，和接口给的一致');

    const btn = card ? deepButtons(card).find((b) => /复制配对码|Copy pairing code/.test(b.textContent)) : null;
    if (!btn) fail('配对码旁边没有「复制配对码」按钮');
    else if (typeof btn.onclick !== 'function') fail('「复制配对码」按钮点了没反应');
    else {
      btn.onclick();
      const got = r.copied.filter((c) => c[0] === '419203').length;
      if (!got) fail(`点「复制配对码」复制出来的不是配对码：${JSON.stringify(r.copied)}`);
      else ok('点「复制配对码」复制到的就是那 6 位数字');
    }
  }

  // ⑤b 老版本服务端不给 pairCode：卡片照旧在，但不能凭空编一个码出来
  {
    const r = runRenderEntries([{ id: 'dsh', installed: true, running: true }], { pairCode: null });
    const card = r.find('pair-card');
    const code = card ? deepFind(card, 'v-paircode') : null;
    if (!card) fail('没拿到配对码时整张卡都不见了（用户会以为功能没了）');
    else if (!code || /[0-9]{6}/.test(code.textContent)) fail(`没拿到配对码却显示了一个码：${code && code.textContent}`);
    else if (deepButtons(card).length) fail('没拿到配对码却还有复制按钮');
    else ok('没拿到配对码时不编数字、也不给假的复制按钮');
  }

  // ⑤c 英文界面下，配对码卡上的字必须跟着走（证明走了 t()）
  {
    const r = runRenderEntries([{ id: 'dsh', installed: true, running: true }], { lang: 'en' });
    const card = r.find('pair-card');
    const hint = card ? deepFind(card, 'pair-hint') : null;
    const btn = card ? deepButtons(card)[0] : null;
    if (!hint || /[\u4e00-\u9fff]/.test(hint.textContent)) fail(`英文界面下配对码说明还是中文：${hint && hint.textContent}`);
    else if (!btn || /[\u4e00-\u9fff]/.test(btn.textContent)) fail(`英文界面下复制按钮还是中文：${btn && btn.textContent}`);
    else ok('切英文：配对码卡的说明和按钮都跟着变英文');
  }

  // ⑥ 目标列表整个缺字段（老版本服务端）也不能崩
  {
    try {
      const r = runRenderEntries([]);
      if (!r.find('entries-no-target')) fail('目标列表为空时没有提示');
      else ok('目标列表为空：不崩，照常提示');
    } catch (err) {
      fail(`目标列表为空时抛异常：${err.message}`);
    }
  }
}

console.log('\n[行为] 安全的手机入口排序、复制、打开与不可用说明\n');
{
  const targets = [{ id: 'dsh', installed: true, running: true }];
  const KEY = 'fixture-encryption-key-123456';
  const lan = `https://192.168.1.5:8443/k/fixture-access?view=classic&extra=keep#k=${KEY}`;
  const wan = `https://fixture.example/k/fixture-access#k=${KEY}`;
  const check = (label, fn) => {
    try { fn();ok(label); } catch (error) { fail(`${label}: ${error.message}`); }
  };
  const card = (r, kind) => r.box.children.find((c) => c.className === `access-card ${kind}-card`);
  const buttons = (r, kind) => deepButtons(card(r, kind));
  const entryButtons = (r, kind) => buttons(r, kind).slice(0, 2);

  check('未开启内网 HTTPS 时，真正的推荐函数选择 HTTPS 隧道而非普通内网', () => {
    const r = runRenderEntries(targets);
    assert.equal(r.sandbox.bestEntry(r.entries).kind, 'wan');
    assert.equal(new URL(r.sandbox.bestEntry(r.entries).phoneUrl).protocol, 'https:');
  });
  check('普通 HTTP 的复制和打开都禁用，残留回调也不能复制或打开', () => {
    const r = runRenderEntries(targets);
    const unusable = entryButtons(r, 'lan');
    assert.equal(unusable.length, 2);
    for (const b of unusable) { assert.equal(b.disabled, true);b.onclick(); }
    assert.equal(r.copied.length, 0);assert.equal(r.opened.length, 0);
    assert.match(card(r, 'lan').innerHTML, /普通 HTTP 不能用于手机加密连接/);
    assert.match(card(r, 'lan').innerHTML, /开启内网 HTTPS/);
    assert.match(card(r, 'lan').innerHTML, /外网 HTTPS 隧道/);
  });
  check('渲染不会开启 HTTPS；只有用户明确点击开启按钮才发起该动作', () => {
    const r = runRenderEntries(targets);
    assert.equal(r.httpsRequests, 0);
    const enable = buttons(r, 'lan').find((b) => b.textContent === '开启 HTTPS');
    assert.ok(enable);enable.onclick();assert.equal(r.httpsRequests, 1);
  });
  check('HTTPS 隧道复制与打开保留完整访问路径和密钥，并进入 Lite', () => {
    const r = runRenderEntries(targets);
    const available = entryButtons(r, 'wan');
    for (const b of available) { assert.equal(b.disabled, false);b.onclick(); }
    const copied = new URL(r.copied[0][0]), opened = new URL(r.opened[0][0]);
    assert.equal(copied.pathname, '/k/fixture-access');assert.equal(copied.hash, '#k=' + KEY);
    assert.equal(copied.searchParams.get('target'), 'lite');assert.equal(opened.href, copied.href);
    assert.equal(r.opened[0][2], 'noopener,noreferrer');
  });
  check('渲染的地址和鼠标提示都隐藏访问凭据与加密密钥', () => {
    const r = runRenderEntries(targets, { entries: { lanHttps: [lan], wan } });
    for (const kind of ['lan', 'wan']) {
      assert.equal(card(r, kind).innerHTML.includes(KEY), false);
      assert.equal(card(r, kind).innerHTML.includes('fixture-access'), false);
    }
  });
  check('地址更换过程中复制/打开禁用；旧回调也不能发送尚未就绪的链接', () => {
    const waiting = runRenderEntries(targets, { addressChanging: true });
    for (const b of entryButtons(waiting, 'wan')) { assert.equal(b.disabled, true);b.onclick(); }
    assert.equal(waiting.copied.length + waiting.opened.length, 0);
    const r = runRenderEntries(targets);
    r.sandbox.addressChanging = true;
    for (const b of entryButtons(r, 'wan')) b.onclick();
    assert.equal(r.copied.length + r.opened.length, 0);
  });
  check('所有旧的顶部与轻量复制回调也拒绝地址更换空窗期', () => {
    const r = runRenderEntries(targets, { hero: true, entries: { lanHttps: [lan], wan } });
    const oldCallbacks = deepButtons(r.node('heroActs')).concat(buttons(r, 'lan'), buttons(r, 'wan'))
      .filter((b) => /复制/.test(b.textContent));
    assert.equal(oldCallbacks.length, 6);
    r.sandbox.addressChanging = true;
    for (const b of oldCallbacks) b.onclick();
    assert.equal(r.copied.length, 0);
  });
  check('可用的 HTTPS 内网优先，跳过第一条坏链接且去除已退役 classic 参数', () => {
    const r = runRenderEntries(targets, { entries: { lanHttps: ['https://invalid.example/#k=short', lan], wan } });
    const best = r.sandbox.bestEntry(r.entries), u = new URL(best.phoneUrl);
    assert.equal(best.kind, 'lanHttps');assert.equal(u.hostname, '192.168.1.5');
    assert.equal(u.hash, '#k=' + KEY);assert.equal(u.searchParams.get('extra'), 'keep');
    assert.equal(u.searchParams.has('view'), false);assert.equal(u.searchParams.get('target'), 'lite');
    entryButtons(r, 'lan')[0].onclick();assert.equal(r.copied[0][0], best.phoneUrl);
  });
  check('无有效内网 HTTPS 时回退 HTTPS 隧道；只有普通 HTTP 时不推荐任何入口', () => {
    const fallback = runRenderEntries(targets, { entries: { lanHttps: ['https://invalid.example/#k=short'], wan } });
    assert.equal(fallback.sandbox.bestEntry(fallback.entries).kind, 'wan');
    const unavailable = runRenderEntries(targets, { entries: { wan: null } });
    assert.equal(unavailable.sandbox.bestEntry(unavailable.entries), null);
    assert.equal(entryButtons(unavailable, 'wan').every((b) => b.disabled), true);
  });
  const badKeys = [
    '', '#k=', '#k=short', '#marker=k=' + KEY, '#k=' + KEY + '&k=',
    '#k=' + KEY + '&k=' + KEY, '#k=' + KEY + '#k=' + KEY,
    '#k=' + KEY + '%ZZ', '#k=' + KEY + '%00', '#k=' + 'a'.repeat(1025),
    '#k=' + '%20'.repeat(16), '#k=%20' + KEY
  ];
  for (let i = 0; i < badKeys.length; i++) {
    check(`缺少、重复或损坏的密钥片段拒绝推荐/复制/打开（${i + 1}）`, () => {
      const r = runRenderEntries(targets, { entries: { lan: [], wan: 'https://fixture.example/k/fixture-access' + badKeys[i] } });
      assert.equal(r.sandbox.bestEntry(r.entries), null);
      for (const b of entryButtons(r, 'wan')) { assert.equal(b.disabled, true);b.onclick(); }
      assert.equal(r.copied.length + r.opened.length, 0);
      assert.match(card(r, 'wan').innerHTML, /换新地址和密钥/);
    });
  }
  check('伪 HTTPS 栏位中的 HTTP、带用户名地址和无效 URL 不能冒充可用入口', () => {
    const r = runRenderEntries(targets);
    for (const u of [`http://fixture.example/#k=${KEY}`, `https://user@fixture.example/#k=${KEY}`, 'invalid']) {
      assert.equal(r.sandbox.dshLiteAddress(u), '');
    }
  });
  check('密钥按加密客户端规则解码，保留合法 URL 编码字符与额外片段', () => {
    const r = runRenderEntries(targets);
    const url = `https://fixture.example/k/fixture-access#other=keep&k=${encodeURIComponent('fixture+key with Unicode 桥123456')}`;
    const parsed = new URL(r.sandbox.dshLiteAddress(url));
    assert.equal(parsed.hash, new URL(url).hash);assert.equal(parsed.searchParams.get('target'), 'lite');
  });
  for (const lang of ['en', 'es']) {
    check(`HTTP 不可用状态与修复指引在 ${lang} 下全部翻译，按钮保持禁用`, () => {
      const r = runRenderEntries(targets, { lang });
      assert.doesNotMatch(card(r, 'lan').innerHTML, /[\u4e00-\u9fff]/);
      assert.equal(entryButtons(r, 'lan').every((b) => b.disabled), true);
      assert.match(card(r, 'lan').innerHTML, /HTTPS/);
      assert.equal(r.httpsRequests, 0);
    });
    check(`缺密钥的隧道修复说明在 ${lang} 下全部翻译`, () => {
      const r = runRenderEntries(targets, { lang, entries: { wan: 'https://fixture.example/#k=short' } });
      assert.doesNotMatch(card(r, 'wan').innerHTML, /[\u4e00-\u9fff]/);
      assert.equal(entryButtons(r, 'wan').every((b) => b.disabled), true);
    });
  }
  check('真正的顶部快捷复制使用推荐的加密 Lite 入口', () => {
    const r = runRenderEntries(targets, { hero: true });
    const copy = deepButtons(r.node('heroActs')).find((b) => b.textContent === '复制手机地址');
    assert.ok(copy);copy.onclick();
    assert.equal(new URL(r.copied[0][0]).hostname, 'fixture.example');
    assert.equal(new URL(r.copied[0][0]).searchParams.get('target'), 'lite');
  });
  check('只有 HTTP 时顶部不误报手机可连接，也不提供快捷复制', () => {
    const r = runRenderEntries(targets, { hero: true, entries: { wan: null } });
    assert.equal(r.node('heroTitle').textContent, '手机入口尚未就绪');
    assert.match(r.node('heroText').textContent, /HTTPS/);
    assert.equal(deepButtons(r.node('heroActs')).some((b) => /复制/.test(b.textContent)), false);
  });
  check('旧 Codex 运行记录不能冒充当前 DSH 服务', () => {
    const r = runRenderEntries([{ id: 'codex', installed: true, running: true }], { hero: true });
    assert.ok(r.find('entries-no-target'));
    assert.equal(r.node('heroTitle').textContent, '服务在运行，但没有可以连的东西');
  });
}

console.log('\n[真机] 控制台上真的显示出来了吗\n');
(async () => {
  if (process.argv.includes('--isolated-only')) {
    console.log('  · Live gateway/browser acceptance is explicitly separate; isolated cases only.\n');
    return finish();
  }
  const up = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8080, path: '/__probe', timeout: 1500 }, (r) => {
      r.resume(); resolve(r.statusCode === 204 || r.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  if (!up) {
    console.log('  · 网关没在 127.0.0.1:8080 上跑 —— 这一段跳过（CI 上就是这样）\n');
    return finish();
  }

  let b = null;
  let pageReady = false;
  try {
    const { Browser } = require('./browser-check.js');
    const key = fs.readFileSync(path.join(BASE, 'logs', 'access-key.txt'), 'utf8').trim();
    let p;
    try {
      // 「起浏览器、开页面」这一段全是**环境相关**的（这台机器上有没有
      // Edge/Chrome、能不能开调试通道）。它失败说明环境不行，不是功能不行。
      b = await Browser.launch();
      p = await b.newPage();
      await p.goto(`http://127.0.0.1:8080/k/${key}`, 3000);
      await p.goto('http://127.0.0.1:8080/console', 3000);
      pageReady = true;
    } catch (err) {
      console.log(`  · 这台机器上的浏览器起不来/连不上（${err.message}）—— 这一段跳过\n`);
      return finish();
    }

    const r = await p.eval(`(async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise(x => setTimeout(x, 250));
        if (document.getElementById('entries-howto')) break;
      }
      const g = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
      // ★ 「有几个在跑」必须问 state，**不能去卡片文字里找「运行中」**。
      //   无头浏览器是 en-US，界面上写的是 “Running” —— 中文正则匹配不到，
      //   于是「有目标在跑」被判成「一个都没在跑」，测试自己制造出一个假失败。
      //   第一版就是这么红的。
      const targets = (window.state && state.data && state.data.targets) || [];
      return {
        howto: g('entries-howto'),
        noTarget: g('entries-no-target'),
        // 配对码是数字，不随语言变 —— 这一条不存在上面那个「中文正则匹配英文界面」
        // 的坑。要盯的就是「DOM 里到底有没有这 6 位数」。
        pairCode: g('v-paircode'),
        pairCard: !!document.getElementById('pair-card'),
        running: targets.filter(x => x.installed && x.running).length,
        installed: targets.filter(x => x.installed).length
      };
    })()`);

    console.log(`      说明: ${String(r.howto).slice(0, 36)}…`);
    // 这里原来把码值打出来了 —— 每次跑测试都会往终端里写一个当前有效的凭据。
    // 改成只报结论：有没有、什么形状、和网关文件一不一致。
    let codeOnDisk = '';
    try { codeOnDisk = fs.readFileSync(path.join(BASE, 'logs', 'pair-code.txt'), 'utf8').trim(); } catch (e) { }
    console.log(`      配对码: ${/^[0-9]{6}$/.test(String(r.pairCode || '').trim()) ? '已显示（6 位）' : '没看到'}` +
      `${codeOnDisk ? '，与本次启动' + (String(r.pairCode).trim() === codeOnDisk ? '一致' : '不一致') : ''}` +
      `   装了 ${r.installed} 个目标，其中在跑 ${r.running} 个`);

    if (r.howto && /DSH/.test(r.howto) && /手机/.test(r.howto)) ok('控制台上真的显示了那句说明');
    else fail(`控制台上看不到那句说明（拿到的是 ${JSON.stringify(r.howto)}）`);

    if (!r.pairCard) fail('控制台第一页上没有配对码那张卡');
    else if (!/^[0-9]{6}$/.test(String(r.pairCode || '').trim())) fail('控制台上看不到 6 位配对码（只报形状，不打印码值）');
    else if (codeOnDisk && String(r.pairCode).trim() !== codeOnDisk) fail('界面上的配对码和本次启动的不一致（只报结论，不打印码值）');
    else ok('控制台上真的显示了本次启动的配对码');

    if (r.running > 0 && r.noTarget) fail('有目标在跑，却还在提示「都没在跑」');
    else if (r.running === 0 && !r.noTarget) fail('一个目标都没在跑，却没有提示去「本机服务」启动');
    else ok(r.running > 0 ? '有目标在跑时不会乱喊「都没在跑」' : '都没在跑时提示了去「本机服务」启动');

    const errs = p.exceptions.filter(Boolean);
    if (errs.length) fail(`页面有未捕获异常：${errs.slice(0, 2).join(' | ')}`);
    else ok('页面没有未捕获异常');
  } catch (err) {
    // 到这里说明页面**已经打开过**了，出问题就是真问题
    if (pageReady) fail(`真机那一段出错：${err.message}`);
    else console.log(`  · 环境问题（${err.message}）—— 跳过\n`);
  } finally {
    if (b) b.kill();
  }
  finish();
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});

function finish() {
  console.log(bad ? `\n${bad} 处问题\n` : '\n全部通过\n');
  process.exit(bad ? 1 : 0);
}
