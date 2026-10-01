// 「发一句话，显示两句话」—— 本地先画的那条占位，和服务端回推的那条没有对上。
//
// 根因：addLocalUser() 画了一条 local-<时间戳>，
// 服务端随后回推真正的 item（另一个 id），而**没有任何代码把两者对上**
// （注释里写着「马上会被回推顶掉」，那段代码从来没存在过）。
//
// 这一条测试把 upsertItem / addLocalUser / takePendingLocal 抠出来，在假 DOM 里
// 真跑一遍：先本地画一条，再回推一条同样的 —— 必须只剩**一条**。
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const { extractFunction } = require('./page-source.js');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { bad++; console.log(`  ✗ ${m}`); };

const html = fs.readFileSync(path.join(BASE, 'pwa', 'codex.html'), 'utf8');

function fakeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', _html: '', open: false,
    children: [], parentNode: null, attrs: {}, style: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    replaceWith(n) { if (!this.parentNode) return; const i = this.parentNode.children.indexOf(this); this.parentNode.children[i] = n; n.parentNode = this.parentNode; this.parentNode = null; },
    querySelectorAll: () => [],
    get isConnected() { return !!this.parentNode; },
    get nextElementSibling() { if (!this.parentNode) return null; const i = this.parentNode.children.indexOf(this); return this.parentNode.children[i + 1] || null; }
  };
}

/** 把渲染这几个函数的那套搬进假 DOM */
function loadPage() {
  const body = fakeEl('body');
  const sandbox = {
    state: { items: {}, order: [], pendingLocal: [] },
    document: { createElement: fakeEl, getElementById: () => null },
    $: (id) => (id === 'body' ? body : fakeEl('div')),
    t: (s) => s,
    tr: (s) => s,
    el: (cls, inner) => { const e = fakeEl('div'); e.className = cls; e._html = inner; return e; },
    fmt: (s) => String(s == null ? '' : s),
    buildImageView: (p) => { const e = fakeEl('div'); e.className = 'img'; e.attrs.src = p; return e; },
    tidySoon: () => { },
    scrollDown: () => { },
    tidyItems: () => { },
    buildItem: null,
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const n of ['upsertItem', 'buildItem', 'buildUser', 'addLocalUser',
    'rememberPendingLocal', 'takePendingLocal', 'normalizeSaid', 'userTextOf',
    'clip', 'esc', 'reasoningText', 'buildAgent',
    // buildUser/buildAgent 现在用 asText 读「本该是字符串、实际可能是对象」的字段
    // （修「一整条消息显示成 [object Object]」时加的）—— 这里得一起抠出来。
    'asText', 'bridgeUploadedFiles', 'uploadedFileButtonHtml', 'baseName']) {
    const src = extractFunction(html, n);
    assert.ok(src, `codex.html 里找不到 ${n}() —— 它被改名或删了吗？`);
    vm.runInContext(src, sandbox, { filename: n });
  }
  // buildItem 里会用到的一堆常量/helper：只补这几个就够了
  vm.runInContext(`
    var MAX_TEXT = 20000, MAX_OUT = 4000;
    function shortPath(p){ return String(p||''); }
    function relTime(){ return ''; }
    var t = function(s){ return s; };
  `, sandbox);
  // 配对名单的两个常量从页面源码里现读（写死的话，页面上改了这里还是绿）
  const consts = html.match(/^\s*var PENDING_LOCAL_(?:MAX|TTL)\s*=\s*\d+;/gm) || [];
  assert.equal(consts.length, 2, '页面上找不到 PENDING_LOCAL_MAX / PENDING_LOCAL_TTL');
  vm.runInContext(consts.join('\n'), sandbox);
  return { body, state: sandbox.state, api: sandbox, count: () => body.children.length };
}

const USER_ITEM = (id, text) => ({
  id: id, type: 'userMessage', content: [{ type: 'text', text: text }]
});

console.log('\n本地占位 + 服务端回推 = 只能有一条\n');
{
  const p = loadPage();
  const SAY = '继续你的任务，任务完成后停止';

  p.api.addLocalUser(SAY);
  if (p.count() !== 1) fail(`本地画完之后应该 1 条，实际 ${p.count()}`);
  else ok('发出去的瞬间：本地先画一条（手感）');

  // 服务端回推真正的那条（另一个 id）
  p.api.upsertItem(USER_ITEM('srv-1', SAY), true);
  if (p.count() !== 1) fail(`回推之后应该**还是 1 条**，实际 ${p.count()} —— 这就是「发一句显示两句」`);
  else ok('服务端回推同一条：还是 1 条（占位被对上，不是又画一条）');

  const ids = p.state.order;
  if (ids.length !== 1 || ids[0] !== 'srv-1') fail(`记录里的 id 没换成服务端那条：${JSON.stringify(ids)}`);
  else ok('记录里的 id 换成了服务端那条（后续增量才找得到它）');
  if (p.state.pendingLocal.length !== 0) fail('配对名单里还留着这条，后面会认错人');
  else ok('配对名单已清空');
}

console.log('\n连发两条一样的话：一条回推只能消掉一条占位\n');
{
  const p = loadPage();
  const SAY = '好的';
  p.api.addLocalUser(SAY);
  p.api.addLocalUser(SAY);
  p.api.upsertItem(USER_ITEM('srv-a', SAY), true);
  if (p.count() !== 2) fail(`两条只回推了一条，应该还剩 2 条（1 条已配对 + 1 条在等），实际 ${p.count()}`);
  else ok('只回推一条时：剩 2 条（另一条还在等自己的回推），没有丢');
  p.api.upsertItem(USER_ITEM('srv-b', SAY), true);
  if (p.count() !== 2) fail(`两条都回推之后应该 2 条，实际 ${p.count()}`);
  else ok('两条都回推之后：2 条（先到先配，没有并成一条也没有变四条）');
}

console.log('\n带附件那条：本地是「正文 + 附件：…」，服务端正文只有正文\n');
{
  const p = loadPage();
  const SAY = '看这张图';
  p.api.addLocalUser(SAY + '\n\n附件：IMG_1.png');
  p.api.upsertItem(USER_ITEM('srv-img', SAY), true);
  if (p.count() !== 1) fail(`带附件时没对上，实际 ${p.count()} 条`);
  else ok('前缀相同就认得出（带附件的本地占位也能被对上）');
}

console.log('\n别认错人：不是同一句话的回推不能吃掉占位\n');
{
  const p = loadPage();
  const prompt = 'Read only the attached phone-upload.txt file and tell me its exact text.';
  const file = { name: 'phone-upload.txt', path: 'D:\\bridge\\uploads\\codex\\a79abc70-3623-46a2-b421-ca401ac11111\\phone-upload.txt' };
  const wire = prompt + '\n\n用户上传的文件（已保存在电脑上，请按需读取）：\n' + JSON.stringify(file);
  const clientId = 'pocket-bridge-upload-echo-regression';
  p.api.addLocalUser(prompt + '\n\n附件：phone-upload.txt', wire, clientId);
  const server = USER_ITEM('srv-file', wire); server.clientId = clientId;
  p.api.upsertItem(server, true);
  if (p.count() !== 1) fail('真实文件元数据回推产生两个气泡'); else ok('真实文件上传元数据只替换一条本地占位');
  const shown = p.api.bridgeUploadedFiles(server);
  if (!shown || shown.text !== prompt || shown.files[0].name !== file.name) fail('桥上传文件没有折叠成文件名'); else ok('桥上传JSON折叠为正文和文件名');
  const chip = p.api.uploadedFileButtonHtml(file);
  if (!/data-filecite=/.test(chip) || chip.includes('title=') || !chip.includes('phone-upload.txt')) fail('文件chip不可点或悬浮标题泄露内部路径'); else ok('附件chip使用既有加密下载入口，不显示内部路径标题');
  const pasted = USER_ITEM('ordinary-json', prompt + '\n\n' + JSON.stringify(file));
  if (p.api.bridgeUploadedFiles(pasted)) fail('用户自行粘贴JSON被折叠'); else ok('无桥提交标记的用户JSON原样保留');
  const historical = USER_ITEM('real-old-history', prompt+'\n\n用户上传的文件（已保存在电脑上，请按需读取）：\n'+JSON.stringify({...file,path:file.path.replace(/\\/g,'\\\\')}));
  const legacy = p.api.bridgeUploadedFiles(historical);
  if (!legacy || !legacy.legacy || !legacy.original.includes('用户上传的文件')) fail('真实旧历史重复反斜杠未识别或丢失原文'); else ok('真实旧历史重复反斜杠折叠chip并保留原始说明');
  const escaped = USER_ITEM('outside-upload', prompt + '\n\n用户上传的文件（已保存在电脑上，请按需读取）：\n' + JSON.stringify({name:'auth.json',path:'C:/private/auth.json'})); escaped.clientId = clientId;
  if (p.api.bridgeUploadedFiles(escaped)) fail('上传目录外路径被当成附件'); else ok('上传目录外的元数据不会伪装成桥附件');
  p.api.addLocalUser(prompt + '\n\n附件：phone-upload.txt', wire, clientId);
  if (p.count() !== 1) fail('回推先到、回执后到产生重复'); else ok('回推先到时回执不再补画重复占位');
}
{
  const p = loadPage();
  p.api.addLocalUser('我发的是这一句');
  p.api.upsertItem(USER_ITEM('srv-other', '这是会话里早就有的另一句'), true);
  if (p.count() !== 2) fail(`不该配对，应该 2 条，实际 ${p.count()}`);
  else ok('内容对不上就不配对（历史消息不会被当成回推）');
  if (p.state.pendingLocal.length !== 1) fail('占位不该被消费掉');
  else ok('占位仍然留着等它自己的回推');
}

console.log('\n等太久的占位不再参与配对（免得几分钟后张冠李戴）\n');
{
  const p = loadPage();
  p.api.addLocalUser('很久以前发的');
  p.state.pendingLocal[0].at = Date.now() - 5 * 60 * 1000;
  const hit = p.api.takePendingLocal('很久以前发的');
  if (hit) fail('过期占位仍然被配对上了');
  else ok('超过两分钟的占位不再配对');
}

console.log('\n服务端先回推、本地后画（不该出现，但也不能崩）\n');
{
  const p = loadPage();
  p.api.upsertItem(USER_ITEM('srv-x', '先到的'), true);
  p.api.addLocalUser('后画的');
  if (p.count() !== 2) fail(`应该是 2 条，实际 ${p.count()}`);
  else ok('两条都在（没有被错误地合并）');
}

console.log(bad ? `\n${bad} 处问题\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
