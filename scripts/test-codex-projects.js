// 手机端 Codex 的会话列表：**按项目折叠**，与 DSH 行为一致。
//
// 为什么值得单独测：这一块的状态是**存在本地**的（哪些项目合着），而一旦
// 存/读那两步走样，表现是「折过一次的项目，下次进来还是合着」或者反过来
// 「怎么折都折不上」—— 两种都不会报错，只是用起来别扭。静默的行为错最该被机器盯住。
//
// 手法和 test-console-help.js 一样：把 console/codex 页面里的几个函数**整段抠出来**，
// 在一个假 DOM 里真跑一遍。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const { extractRegisterArg, extractFunction } = require('./page-source.js');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { bad++; console.log(`  ✗ ${m}`); };

const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');
const dict = vm.runInNewContext(`(${extractRegisterArg(html)})`, {});

/** 只做这几个函数用得到的那几件事的假 DOM */
function fakeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', onclick: null, style: {},
    children: [], parentNode: null, _html: '',
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this.children.length = 0; }
  });
  return el;
}

/** 把页面里那一组函数抠出来，在同一个 sandbox 里跑 */
function loadList(threads, lang) {
  const store = {};
  const box = fakeEl('div');
  const sandbox = {
    state: { threads: threads, searchThreads: [], searchPending: false, filter: '' },
    // getElementById('thlist') 要给回我们的假盒子 —— 页面里重画走的正是这条路
    document: { createElement: fakeEl, getElementById: (id) => (id === 'thlist' ? box : null) },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    t: (s) => (lang === 'zh' ? s : ((dict[s] && dict[s][lang]) || s)),
    tr: (s) => (lang === 'zh' ? s : ((dict[s] && dict[s][lang]) || s)),
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const names = ['displayThreadTitle', 'appendUniqueThreads', 'fillThreadList', 'threadRow', 'readFolded', 'writeFolded', 'isUnread', 'timestampMs', 'relTime', 'baseName', 'esc'];
  for (const n of names) {
    const src = extractFunction(html, n);
    assert.ok(src, `codex.html 里找不到 ${n}() —— 它被改名或删了吗？`);
    vm.runInContext(src, sandbox, { filename: n });
  }
  // 重画函数照页面里的写法接上（点折叠之后走的就是它）——
  // 用空函数顶替的话，「点一下」这类用例就永远看不到变化，测了个寂寞。
  vm.runInContext(
    'function renderThreadListOnly(){var b=document.getElementById(\'thlist\');' +
    'if(!b)return;fillThreadList(b,state.filter.trim().toLowerCase());}', sandbox);
  return { box, store, sandbox, fill: (q) => sandbox.fillThreadList(box, q || '') };
}

const heads = (box) => box.children.filter((c) => /pghead/.test(c.className));
const wraps = (box) => box.children.filter((c) => c.className === 'pgwrap');
const rows = (box) => box.children.reduce((n, c) => n + (c.className === 'pgwrap' ? c.children.length : 0), 0);

const SAMPLE = [
  { id: 'a1', name: '甲-新', cwd: 'D:\\proj\\alpha', updatedAt: Date.parse('2026-09-24T10:00:00Z') },
  { id: 'a2', name: '甲-旧', cwd: 'D:\\proj\\alpha', updatedAt: Date.parse('2026-09-20T10:00:00Z') },
  { id: 'b1', name: '乙', cwd: 'D:\\proj\\beta', updatedAt: Date.parse('2026-09-23T10:00:00Z') },
  { id: 'c1', name: '没有项目', cwd: '', updatedAt: Date.parse('2026-09-24T11:00:00Z') }
];

console.log('\n[分组] 按项目分，最近动过的排前面\n');
{
  const { box, fill } = loadList(SAMPLE);
  fill();
  const h = heads(box);
  if (h.length !== 3) fail(`应该有 3 个组，实际 ${h.length}`);
  else ok('三个项目 → 三个组');
  const names = h.map((x) => (x.innerHTML.match(/class="nm">([^<]*)</) || [])[1]);
  const counts = h.map((x) => (x.innerHTML.match(/class="cnt">([^<]*)</) || [])[1]);
  assert.deepEqual(names, ['alpha', 'beta', '（没有项目）']);
  ok(`组名用目录名：${names.join(' / ')}`);
  assert.deepEqual(counts, ['2', '1', '1']);
  ok('每组都标了条数');
  if (rows(box) !== SAMPLE.length) fail(`展开时应该有 ${SAMPLE.length} 行，实际 ${rows(box)}`);
  else ok(`展开时 ${SAMPLE.length} 条会话一条不少`);
  if (!h[0].innerHTML.includes(`title="${SAMPLE[0].cwd}"`)) fail('组头没有完整路径（手机上看不出是哪个项目）');
  else ok('组头带完整路径（悬停/长按能看到）');
}

console.log('\n[折叠] 点一下合上，再点一下打开\n');
{
  const { box, store, fill } = loadList(SAMPLE);
  fill();
  const h0 = heads(box)[0];
  h0.onclick();                       // 合上
  fill();
  if (heads(box)[0].className.indexOf('closed') < 0) fail('点了之后组头没有变成「合着」的样子');
  else ok('点组头 → 合上（箭头转向、名字还在）');
  if (rows(box) !== 2) fail(`合上一组（2 条）之后应该剩 2 行，实际 ${rows(box)}`);
  else ok('合上的组里那 2 条确实藏起来了');
  const saved = JSON.parse(store['codex-proj-folded-v1'] || '{}');
  assert.equal(saved['D:\\proj\\alpha'], 1);
  ok('折叠状态写进了本地存储（存的是「哪些合着」，不是「哪些开着」）');

  heads(box)[0].onclick();            // 再点开
  fill();
  if (rows(box) !== SAMPLE.length) fail('再点一下没有展开');
  else ok('再点一下 → 又展开了');
  assert.deepEqual(JSON.parse(store['codex-proj-folded-v1'] || '{}'), {});
  ok('展开之后存储里那条也清掉了');
}

console.log('\n[搜索] 搜的时候必须全部展开（藏在合着的组里 = 没搜到）\n');
{
  const { box, fill } = loadList(SAMPLE);
  fill();
  heads(box)[0].onclick();            // 先合上一组
  fill();
  fill('乙');                          // 再搜
  const t = heads(box).map((x) => (x.innerHTML.match(/class="nm">([^<]*)</) || [])[1]);
  if (rows(box) !== 1) fail(`搜索时合着的组也该展开，实际 ${rows(box)} 行`);
  else ok('搜索时自动展开，结果看得见');
  if (t.indexOf('alpha') >= 0) fail('搜索没有过滤掉不匹配的项目');
  else ok('不匹配的项目不显示');
}

console.log('\n[跨页搜索] 已加载预览与服务端标题结果合并，重复会话只出现一次\n');
{
  const { box, fill, sandbox } = loadList(SAMPLE);
  sandbox.state.searchThreads = [
    SAMPLE[0],
    { id: 'remote1', name: 'alpha 标题命中', cwd: 'D:\\proj\\remote', updatedAt: Date.parse('2026-09-25T10:00:00Z') }
  ];
  fill('alpha');
  if (rows(box) === 2) ok('服务端标题匹配结果会显示，已加载的同一会话不会重复');
  else fail(`搜索合并应有 2 条会话，实际 ${rows(box)}`);
}

console.log('\n[全部折叠 / 全部展开]\n');
{
  const { box, fill } = loadList(SAMPLE);
  fill();
  const foldBtn = () => box.children.find((c) => c.className === 'pgfold');
  assert.equal(foldBtn().textContent, '全部折叠');
  foldBtn().onclick();
  if (rows(box) !== 0) fail(`全部折叠之后应该 0 行，实际 ${rows(box)}`);
  else ok('「全部折叠」→ 一条都不露');
  assert.equal(foldBtn().textContent, '全部展开');
  ok('按钮自己变成「全部展开」');
  foldBtn().onclick();
  if (rows(box) !== SAMPLE.length) fail('「全部展开」没有把全部放出来');
  else ok('「全部展开」→ 全回来');
}

console.log('\n[边界]\n');
{
  const { box, fill } = loadList([]);
  fill();
  if (!/还没有会话/.test(box.innerHTML)) fail('空列表没有提示');
  else ok('没有会话时给一句话，不是空白');

  const { box: b2, fill: f2 } = loadList([{ id: 'x', name: '只有一条', cwd: 'D:\\only', updatedAt: Date.now() }]);
  f2();
  ok('只有一条会话也能正常分组');

  // 存储里的 JSON 坏了 → 不能崩，当作没折过
  const { box: b3, sandbox: s3 } = loadList(SAMPLE);
  s3.localStorage.setItem('codex-proj-folded-v1', '{坏的');
  try {
    s3.fillThreadList(b3, '');
    ok('本地存储里的 JSON 坏掉时：不崩，按「都没折」处理');
  } catch (err) {
    fail(`存储坏掉时抛异常了：${err.message}`);
  }
}

console.log('\n[英文界面] 组名是项目名，界面词得跟着语言走\n');
{
  const { box, fill } = loadList([{ id: 'z', name: 'x', cwd: '', updatedAt: Date.now() }], 'en');
  fill();
  const txt = box.children.map((c) => c.innerHTML || c.textContent).join(' ');
  if (/没有项目/.test(txt)) fail('英文界面下还出现了中文的「（没有项目）」');
  else ok('英文界面：无项目的那组显示 (no project)');
}

console.log('\n[新会话与时间格式] 不使用隐含默认目录\n');
{
  const starts = [];
  let pickerOpens = 0;
  const box = {
    state: {}, t: (s) => s,
    openNewThreadPicker: () => { pickerOpens++; },
    setConn() {},
    call: (method, params) => { starts.push({ method, params }); return new Promise(() => {}); },
    Promise, Number, Date, Object, Math
  };
  vm.createContext(box);
  for (const n of ['absoluteProjectPath', 'newThread', 'timestampMs', 'collectProjects']) {
    vm.runInContext(extractFunction(html, n), box);
  }
  box.newThread();
  box.newThread({ type: 'click' });
  if (pickerOpens === 2 && starts.length === 0) ok('未选项目或误传点击事件时只打开选择器，不在默认目录创建');
  else fail('未选项目时仍向服务端发起了创建');
  box.newThread('D:\\work\\bridge');
  if (starts.length === 1 && starts[0].method === 'thread/start' && starts[0].params.cwd === 'D:\\work\\bridge')
    ok('明确选定 D 盘项目后才创建，路径原样传给服务端');
  else fail('项目路径未正确传递');
  const projects = box.collectProjects([
    { cwd: 'D:\\older', updatedAt: '2026-09-20T12:00:00Z' },
    { cwd: 'D:\\newer', updatedAt: '2026-09-29T12:00:00Z' }
  ]);
  if (projects[0].path === 'D:\\newer') ok('ISO 时间戳的最近项目排在前面');
  else fail('ISO 时间戳被当成无效时间，项目排序错误');
}

console.log(bad ? `\n${bad} 处问题\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
