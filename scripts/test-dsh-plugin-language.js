'use strict';
// Real panel/controller events in an isolated React hook/element fixture.
// No browser storage, host settings, private installation, or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../dsh-plugin/client.js'), 'utf8');
const TOKEN = 'A'.repeat(43);
const reply = value => ({ ok: true, status: 200, json: async () => value });
const stopped = () => ({ ok: true, state: 'stopped', controlToken: TOKEN, version: 'fixture', connection: { available: false, encrypted: false }, operation: { phase: 'idle' } });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  let registration, Panel, cursor = 0, root, dirty = false;
  const hooks = [], effects = [], requests = [], queue = [reply(stopped())], listeners = new Map(), timers = new Map();
  let observer;
  const document = { hidden: false, documentElement: { lang: 'zh-CN' }, addEventListener() {}, removeEventListener() {} };
  const window = { document, location: { protocol: 'http:', hostname: '127.0.0.1' }, navigator: { language: 'en-US', languages: ['en-US'] },
    AbortController, __ModuleLoader__: { load(value) { registration = value; } },
    addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    MutationObserver: class { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() { this.disconnected = true; } },
    async fetch(url, options) { requests.push({ url, options }); const value = queue.shift(); assert(value, 'Unexpected panel request'); return typeof value === 'function' ? value() : value; }
  };
  const React = {
    createElement(tag, props, ...children) { return typeof tag === 'function' ? tag(props || {}) : { tag, props: props || {}, children }; },
    useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; dirty = true; }]; },
    useRef(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: value }; return hooks[index]; },
    useEffect(run, deps) { const index = cursor++; const old = hooks[index]; if (!old || deps.some((value, at) => value !== old.deps[at])) {
      effects.push(() => { if (old && old.cleanup) old.cleanup(); hooks[index] = { deps, cleanup: run() }; });
    } }
  };
  vm.runInNewContext(source, { window, document, navigator: window.navigator, URL, TextEncoder, Date });
  const client = registration.factory(() => React);
  client.apply({ slots: { inject(_name, fn) { fn(); }, register(_meta, component) { Panel = component; } } });
  function render() { for (let i = 0; i < 8; i++) { dirty = false; cursor = 0; root = Panel(); while (effects.length) effects.shift()(); if (!dirty) return root; } throw Error('Unstable panel render'); }
  function all(node) { if (arguments.length === 0) node = root; if (Array.isArray(node)) return node.flatMap(all); if (!node || typeof node !== 'object') return []; return [node, ...node.children.flatMap(all)]; }
  function content(node) { if (arguments.length === 0) node = root; if (typeof node === 'string') return node; if (Array.isArray(node)) return node.map(content).join(''); if (!node || typeof node !== 'object' || node.tag === 'style') return ''; return node.children.map(content).join(''); }
  const choose = value => { all().find(node => node.tag === 'select').props.onChange({ target: { value } }); render(); };
  return { client, window, document, queue, requests, render, all, content, choose,
    documentLanguage(value) { document.documentElement.lang = value; observer.callback(); render(); },
    dispose() { for (const value of hooks) if (value && value.cleanup) value.cleanup(); assert(observer.disconnected); },
    button(label) { return all().find(node => node.tag === 'button' && content(node) === label); }
  };
}
(async () => {
  const f = fixture(); f.render(); await tick(); f.render();
  const zhStart = f.client.translate('Start bridge', 'zh'), esStart = f.client.translate('Start bridge', 'es');
  assert.notEqual(zhStart, 'Start bridge'); assert.notEqual(esStart, 'Start bridge');
  assert(f.button(zhStart)); assert(f.content().includes('Node.js 24+'));
  assert.equal(f.requests.length, 1);
  const original = f.requests.length;
  f.choose('es'); assert.equal(f.all()[0].props.lang, 'es'); assert.equal(f.document.documentElement.lang, 'zh-CN'); assert(f.button(esStart)); assert.equal(f.requests.length, original);
  f.documentLanguage('en-US'); assert(f.button(esStart), 'explicit panel override survives host language change');
  f.choose('auto'); assert(f.button('Start bridge'));
  f.documentLanguage('zh-CN'); assert(f.button(zhStart));
  f.choose('en');
  let finish;
  f.queue.push(() => new Promise(resolve => { finish = resolve; }), reply({ ...stopped(), operation: { phase: 'failed', code: 'node-unavailable' } }));
  const starting = f.button('Start bridge').props.onClick(); await tick(); f.render();
  const during = f.requests.length;
  f.choose('zh'); assert.equal(f.requests.length, during); assert.equal(f.button(f.client.translate('Starting…', 'zh')).props.disabled, true);
  finish(reply({ ok: false, code: 'node-unavailable' })); await starting; await tick(); f.render();
  assert(f.content().includes('Node.js 24')); assert(!f.content().includes('The last start attempt could not find'));
  f.choose('en');
  const gateway = { bootId: 'owned-boot', instanceId: 'owned-instance', consoleUrl: 'http://127.0.0.1:8081/console' };
  f.queue.push(reply({ ...stopped(), state: 'running', gateway, runtime: { available: true }, connection: { available: true, encrypted: true, mode: 'tunnel', host: 'fixture.invalid' } }));
  await f.button('Refresh status').props.onClick(); f.render();
  const privateUrl = 'https://fixture.invalid/k/fixtureaccessvalue12345#k=fixtureencryptionvalue12345';
  f.queue.push(reply({ ok: true, url: privateUrl, mode: 'tunnel', gateway }));
  await f.button('Show connection').props.onClick(); f.render();
  const beforeTranslation = f.requests.length;
  f.choose('es');
  assert.equal(f.all().find(node => node.tag === 'input').props.value, privateUrl);
  assert.equal(f.requests.length, beforeTranslation);
  assert(f.all().some(node => node.tag === 'svg' && node.props['aria-label'] === f.client.translate('Private phone connection QR code', 'es')));
  f.choose('en'); f.button('Hide connection').props.onClick(); f.render();
  assert(!f.all().some(node => node.tag === 'input'));
  const beforeConfirm = f.requests.length;
  await f.button('Stop bridge').props.onClick(); f.render(); f.choose('es');
  assert(f.all().some(node => node.props.role === 'group' && node.props['aria-label'] === f.client.translate('Confirm stop bridge', 'es')));
  assert.equal(f.requests.length, beforeConfirm);
  f.button(f.client.translate('Cancel', 'es')).props.onClick(); f.render();
  assert(!f.all().some(node => node.props.role === 'group'));
  assert.equal(f.requests.length, beforeConfirm);
  const h = f.client.localizedElement((tag, props, ...children) => ({ tag, props, children }), 'zh');
  const element = h('input', { value: 'Start bridge', 'data-code': 'node-unavailable', 'aria-label': 'Start bridge' }, 'Start bridge');
  assert.equal(element.props.value, 'Start bridge'); assert.equal(element.props['data-code'], 'node-unavailable');
  assert.equal(element.props['aria-label'], zhStart); assert.equal(element.children[0], zhStart);
  const notes = f.all().find(node => node.tag === 'details'); assert(notes && !notes.props.open);
  assert(f.content(notes).includes('cloudflared'));
  assert.match(source, /max-width:min\(840px,100%\)/); assert.match(source, /\.pb-row\{flex-wrap:wrap\}/);
  assert.match(source, /\.pb-qr\{max-width:100%;height:auto/);
  f.dispose();
  console.log('PASS real panel locale events preserve controller state/actions; responsive and access-note contracts hold.');
})().catch(error => { console.error(error); process.exitCode = 1; });
