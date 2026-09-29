'use strict';
// Actual browser component, mocked DOM and encrypted-fetch boundary. No account,
// local filesystem listing, native dialog, gateway, or user project is touched.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-directory-picker.js'), 'utf8');
const sleep = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) { for (let i = 0; i < 50; i++) { if (condition()) return; await sleep(); } assert.fail('fixture did not settle'); }
let passed = 0, failed = 0;
class Node {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.parentNode = null; }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; return node; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.doc.body || node === this.doc.head; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter(fn => fn !== listener); }
  fire(type, values = {}) { const event = { preventDefault() { this.prevented = true; }, ...values }; for (const fn of (this.listeners[type] || []).slice()) fn(event); return event; }
  click() { if (!this.disabled) this.fire('click'); }
  focus() { this.doc.activeElement = this; }
}
function fixture(options = {}) {
  const address = new URL(options.href || 'https://bridge.invalid/k/fixture-key?target=dsh');
  const doc = { documentElement: { lang: options.lang || 'en' }, baseURI: address.origin + '/', listeners: {}, activeElement: null,
    createElement(tag) { return new Node(tag, this); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); },
    fire(type, values) { const event = { preventDefault() { this.prevented = true; }, ...values }; (this.listeners[type] || []).slice().forEach(fn => fn(event)); return event; },
    getElementById(id) { const visit = node => { if (node.id === id) return node; for (const child of node.children) { const found = visit(child); if (found) return found; } return null; }; return visit(this.body) || visit(this.head); }
  };
  doc.head = new Node('head', doc); doc.body = new Node('body', doc);
  const originalFocus = new Node('button', doc); doc.body.appendChild(originalFocus); originalFocus.focus();
  const calls = [], events = {}, listings = [], timers = [];
  let listingsCount = 0;
  const fetch = async (input, init) => {
    calls.push({ input, init });
    if (input !== '/__dsh/directories') return new Response(JSON.stringify({ untouched: true }));
    // A stale implicit wrapper may advertise E2EE without encrypting this
    // route. In the relay fixture only a marked binary request reaches here.
    if (options.requireEncrypted) {
      assert.equal(init.headers['x-dsh-e2ee'], '1');
      assert.equal(ArrayBuffer.isView(init.body), true);
    }
    const body = options.requireEncrypted ? {} : JSON.parse(init.body); listings.push(body); listingsCount++;
    assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers['content-type'], options.requireEncrypted ? 'application/octet-stream' : 'application/json');
    if (options.listing) return options.listing(body, init, listingsCount);
    return new Response(JSON.stringify({ path: body.path || 'D:\\projects', parent: 'D:\\', roots: [{ path: 'D:\\', name: 'D:' }], directories: body.path ? [] : [{ path: 'D:\\projects\\<demo>&', name: '<demo>&' }] }));
  };
  Object.assign(fetch, { __dshE2ee: true, __dshE2eeReq: true, __dshProofRetry: true });
  const box = { document: doc, location: { href: address.href, origin: address.origin },
    fetch, URL, Request, Response, AbortController, AbortSignal, DOMException, console,
    setTimeout(fn, ms) { const timer = { fn, ms, active: true }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.active = false; },
    navigator: { language: 'en' }, localStorage: { getItem(key) { return key === 'dsh-lang' ? options.savedLang || null : null; } },
    addEventListener(type, listener) { (events[type] ||= []).push(listener); }
  };
  vm.createContext(box); vm.runInContext(source, box);
  return { box, doc, originalFocus, calls, listings, events, timers, id: id => doc.getElementById('pb-dir-' + id),
    event: type => (events[type] || []).forEach(fn => fn()) };
}
function rpc(rpcId = 'fixture-rpc') { return JSON.stringify({ type: 'client-request', rpcId, method: 'directoryPicker/pick', payload: { args: {} } }); }
async function loaded(f) { await until(() => f.id('choose') && !f.id('choose').disabled); }
async function check(title, run) { try { await run(); passed++; console.log('PASS: ' + title); } catch (error) { failed++; console.error('FAIL: ' + title + ': ' + error.message); } }
(async () => {
  await check('Official hook selects computer path through encrypted-fetch boundary without native RPC', async () => {
    const f = fixture(); const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f);
    assert.equal(f.id('dialog').getAttribute('role'), 'dialog'); assert.equal(f.id('dialog').getAttribute('aria-modal'), 'true');
    assert.equal(f.id('path').value, 'D:\\projects'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].input, '/__dsh/directories');
    assert.equal(f.calls[0].init.body, '{}'); // no-key local bridge keeps its existing request path
    f.id('choose').click(); assert.equal(await result, 'D:\\projects'); assert.equal(f.id('overlay'), null); assert.equal(f.doc.activeElement, f.originalFocus);
  });
  await check('Relay directory listing explicitly encrypts despite a stale implicit fetch wrapper', async () => {
    const f = fixture({ requireEncrypted: true });
    const encryptedCalls = [];
    f.box.__dshE2eeConfigured = true;
    f.box.__dshE2eeSecret = 'fixture-secret';
    f.box.DshE2EE = {
      available: () => true,
      encryptedFetch: (secret, url, init) => {
        encryptedCalls.push({ secret, url, init });
        return f.box.fetch(url, { ...init, body: new Uint8Array([7, 8, 9]),
          headers: { ...init.headers, 'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1' } });
      }
    };
    const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f);
    assert.equal(encryptedCalls.length, 1);
    assert.equal(encryptedCalls[0].secret, 'fixture-secret');
    assert.equal(encryptedCalls[0].url, '/__dsh/directories');
    assert.equal(encryptedCalls[0].init.body, '{}');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.signal, encryptedCalls[0].init.signal);
    assert.equal(f.calls[0].init.headers['x-dsh-e2ee'], '1');
    assert.notEqual(f.calls[0].init.body, encryptedCalls[0].init.body);
    f.id('choose').click(); assert.equal(await result, 'D:\\projects');
  });
  await check('Encrypted gateway without key or crypto fails closed before sending a computer path', async () => {
    for (const variant of ['no-key', 'no-api']) {
      const f = fixture({ savedLang: 'zh', href: 'https://fixture.trycloudflare.com/k/fixture-key?target=dsh' });
      f.box.__dshE2eeConfigured = true;
      if (variant === 'no-api') f.box.__dshE2eeSecret = 'fixture-secret';
      const result = f.box.__DSH_DIRECTORY_PICKER__.pick();
      await until(() => f.id('status') && f.id('status').getAttribute('role') === 'alert');
      assert(f.id('status').textContent.includes('加密密钥'));
      assert.equal(f.calls.length, 0);
      f.id('cancel').click(); assert.equal(await result, null);
    }
  });
  await check('Configured E2EE does not block plain direct LAN HTTP directory listing', async () => {
    for (const variant of ['no-key', 'crypto-unavailable']) {
      const f = fixture({ href: 'http://192.168.1.107:8080/k/fixture-key?target=dsh' });
      f.box.__dshE2eeConfigured = true;
      if (variant === 'crypto-unavailable') {
        f.box.__dshE2eeSecret = 'fixture-secret';
        f.box.DshE2EE = { available: () => false, encryptedFetch: () => assert.fail('WebCrypto is unavailable on LAN HTTP') };
      }
      const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].init.body, '{}');
      assert.equal(f.calls[0].init.headers['x-dsh-e2ee'], undefined);
      f.id('choose').click(); assert.equal(await result, 'D:\\projects');
    }
  });
  await check('Folder names and paths remain text; folder navigation returns backend canonical path', async () => {
    const f = fixture(); const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f);
    const folder = f.id('list').children[0]; assert.equal(folder.textContent, '<demo>&'); assert.equal(folder.children.length, 0);
    folder.click(); await until(() => f.id('path').value === 'D:\\projects\\<demo>&' && !f.id('choose').disabled);
    f.id('choose').click(); assert.equal(await result, 'D:\\projects\\<demo>&');
  });
  await check('Computer drive roots, parent folder and typed computer paths each use directory-only listing', async () => {
    const f = fixture(); const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f);
    f.id('roots').children[0].click(); await until(() => f.id('path').value === 'D:\\' && !f.id('choose').disabled);
    f.id('path').value = 'D:\\other folder'; f.id('go').click(); await until(() => f.id('path').value === 'D:\\other folder' && !f.id('choose').disabled);
    f.id('up').click(); await until(() => f.id('path').value === 'D:\\' && !f.id('choose').disabled);
    assert.deepEqual(f.listings, [{}, { path: 'D:\\' }, { path: 'D:\\other folder' }, { path: 'D:\\' }]);
    f.id('cancel').click(); assert.equal(await result, null);
  });
  await check('User cancel resolves exact null and aborts outstanding listing', async () => {
    let signal; const f = fixture({ listing: (body, init) => { signal = init.signal; return new Promise(() => {}); } });
    const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await until(() => signal); f.id('cancel').click();
    assert.equal(await result, null); assert.equal(signal.aborted, true); assert.equal(f.id('overlay'), null);
  });
  await check('Escape cancels and keyboard focus stays inside dialog', async () => {
    const f = fixture(); const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f);
    f.id('choose').focus(); const tab = f.doc.fire('keydown', { key: 'Tab' }); assert.equal(tab.prevented, true); assert.equal(f.doc.activeElement, f.id('path'));
    f.doc.fire('keydown', { key: 'Escape' }); assert.equal(await result, null); assert.equal(f.doc.activeElement, f.originalFocus);
  });
  await check('Exact RPC fallback preserves rpcId and string/null response contract, including document-relative input', async () => {
    const f = fixture(); const result = f.box.fetch('api/directoryPicker/pick', { method: 'POST', body: rpc('fixture-id-1') }); await loaded(f); f.id('choose').click();
    const response = await result; assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'fixture-id-1', result: { ok: true, value: 'D:\\projects' } });
    const cancelled = f.box.fetch('/api/directoryPicker/pick', { method: 'POST', body: rpc('fixture-id-2') }); await loaded(f); f.id('cancel').click();
    assert.deepEqual(await (await cancelled).json(), { type: 'server-response', rpcId: 'fixture-id-2', result: { ok: true, value: null } });
  });
  await check('Request-object fallback clones rather than consumes original request body', async () => {
    const f = fixture(); const request = new Request('https://bridge.invalid/api/directoryPicker/pick', { method: 'POST', body: rpc('request-object') });
    const result = f.box.fetch(request); await loaded(f); f.id('cancel').click();
    assert.equal((await (await result).json()).rpcId, 'request-object'); assert.equal(request.bodyUsed, false); assert.equal(await request.text(), rpc('request-object'));
  });
  await check('Nonmatching origin, method, endpoint and malformed RPC pass through unchanged', async () => {
    const f = fixture(); const samples = [
      ['https://other.invalid/api/directoryPicker/pick', { method: 'POST', body: rpc() }],
      ['/api/directoryPicker/pick', { method: 'GET' }], ['/api/session/turn', { method: 'POST', body: rpc() }],
      ['/api/directoryPicker/pick', { method: 'POST', body: 'not json' }],
      ['/api/directoryPicker/pick', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 42, method: 'directoryPicker/pick', payload: { args: {} } }) }],
      ['/api/directoryPicker/pick', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'bad', method: 'directoryPicker/pick', payload: { args: null } }) }]
    ];
    for (const [input, init] of samples) { assert.deepEqual(await (await f.box.fetch(input, init)).json(), { untouched: true }); assert.equal(f.calls.at(-1).input, input); assert.equal(f.calls.at(-1).init, init); }
    assert.equal(f.listings.length, 0); assert.equal(f.id('overlay'), null);
  });
  await check('Caller abort rejects RPC fetch and closes its dialog; cancellation does not become success', async () => {
    const f = fixture(); const controller = new AbortController();
    const result = f.box.fetch('/api/directoryPicker/pick', { method: 'POST', body: rpc(), signal: controller.signal }); const rejection = assert.rejects(result, error => error.name === 'AbortError');
    await loaded(f); controller.abort(); await rejection; assert.equal(f.id('overlay'), null);
  });
  await check('Already-aborted RPC never opens a picker or lists directories', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await assert.rejects(f.box.fetch('/api/directoryPicker/pick', { method: 'POST', body: rpc(), signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(f.listings.length, 0); assert.equal(f.id('overlay'), null);
  });
  await check('Concurrent pick requests serialize with their own IDs and separate results', async () => {
    const f = fixture(); const first = f.box.fetch('/api/directoryPicker/pick', { method: 'POST', body: rpc('first') }); const second = f.box.fetch('/api/directoryPicker/pick', { method: 'POST', body: rpc('second') });
    await loaded(f); assert.equal(f.listings.length, 1); f.id('choose').click(); assert.equal((await (await first).json()).rpcId, 'first');
    await until(() => f.listings.length === 2 && f.id('choose') && !f.id('choose').disabled); f.id('cancel').click();
    assert.deepEqual(await (await second).json(), { type: 'server-response', rpcId: 'second', result: { ok: true, value: null } });
  });
  await check('Queued caller abort rejects immediately and never opens another picker', async () => {
    const f = fixture(); const first = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f); const controller = new AbortController();
    const second = f.box.fetch('/api/directoryPicker/pick', { method: 'POST', body: rpc(), signal: controller.signal }); const rejection = assert.rejects(second, error => error.name === 'AbortError');
    controller.abort(); await rejection; f.id('cancel').click(); await first; await sleep(); assert.equal(f.listings.length, 1); assert.equal(f.id('overlay'), null);
  });
  await check('HTTP authorization error remains visible and retry can recover without native dialog', async () => {
    const f = fixture({ listing: (body, init, count) => count === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify({ path: 'D:\\retry', parent: null, roots: [], directories: [] })) });
    const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await until(() => f.id('status') && f.id('status').getAttribute('role') === 'alert');
    assert(f.id('status').textContent.includes('authorization expired')); assert.equal(f.id('choose').disabled, true); assert.equal(f.id('retry').hidden, false);
    f.id('retry').click(); await loaded(f); f.id('choose').click(); assert.equal(await result, 'D:\\retry');
  });
  await check('directory HTTP 403 does not falsely claim phone authorization expired', async () => {
    const f = fixture({ listing: () => new Response('', { status: 403 }) });
    const result = f.box.__DSH_DIRECTORY_PICKER__.pick();
    await until(() => f.id('status') && f.id('status').getAttribute('role') === 'alert');
    assert(f.id('status').textContent.includes('HTTP 403'));
    assert(!f.id('status').textContent.includes('authorization expired'));
    f.id('cancel').click(); assert.equal(await result, null);
  });
  await check('Malformed backend result gives visible error and user can cancel', async () => {
    const f = fixture({ listing: () => new Response(JSON.stringify({ directories: [] })) }); const result = f.box.__DSH_DIRECTORY_PICKER__.pick();
    await until(() => f.id('status') && f.id('status').getAttribute('role') === 'alert'); assert(f.id('status').textContent.includes('invalid')); assert.equal(f.id('choose').disabled, true);
    f.id('cancel').click(); assert.equal(await result, null);
  });
  await check('Current saved language controls Chinese, English and Spanish UI', async () => {
    for (const [language, expected] of [['zh', '选择电脑上的文件夹'], ['en', 'Choose a folder on your computer'], ['es', 'Elige una carpeta del ordenador']]) {
      const f = fixture({ lang: 'en', savedLang: language }); const result = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f);
      assert.equal(f.id('title').textContent, expected); f.id('cancel').click(); await result;
    }
  });
  await check('Repeated installation keeps one wrapper and preserves E2EE/proof retry markers', async () => {
    const f = fixture(); const wrapped = f.box.fetch, hook = f.box.__DSH_DIRECTORY_PICKER__; vm.runInContext(source, f.box);
    assert.equal(f.box.fetch, wrapped); assert.equal(f.box.__DSH_DIRECTORY_PICKER__, hook);
    assert.equal(wrapped.__dshE2ee, true); assert.equal(wrapped.__dshE2eeReq, true); assert.equal(wrapped.__dshProofRetry, true);
  });
  await check('Pagehide cancels active and queued pickers; pageshow permits a fresh picker', async () => {
    const f = fixture(); const first = f.box.__DSH_DIRECTORY_PICKER__.pick(); const second = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f);
    f.event('pagehide'); assert.equal(await first, null); assert.equal(await second, null); assert.equal(f.id('overlay'), null);
    f.event('pageshow'); const third = f.box.__DSH_DIRECTORY_PICKER__.pick(); await loaded(f); f.id('cancel').click(); assert.equal(await third, null);
  });
  await check('Directory listing has a bounded wait, retry and ignores an aborted late response', async () => {
    let reply; const f = fixture({ listing: () => new Promise(resolve => { reply = resolve; }) }); const result = f.box.__DSH_DIRECTORY_PICKER__.pick();
    await until(() => reply); const timer = f.timers.find(item => item.active); assert(timer && timer.ms <= 15000); timer.fn();
    assert.equal(f.id('status').getAttribute('role'), 'alert'); assert.equal(f.id('retry').hidden, false); assert.equal(f.id('choose').disabled, true);
    reply(new Response(JSON.stringify({ path: 'D:\\late', parent: null, roots: [], directories: [] }))); await sleep();
    assert.equal(f.id('choose').disabled, true); f.id('cancel').click(); assert.equal(await result, null);
  });
  await check('Generic browser network error is translated for the current Chinese language', async () => {
    const f = fixture({ savedLang: 'zh', listing: () => { throw new TypeError('Failed to fetch'); } }); const result = f.box.__DSH_DIRECTORY_PICKER__.pick();
    await until(() => f.id('status') && f.id('status').getAttribute('role') === 'alert');
    assert(f.id('status').textContent.includes('无法读取')); assert(!f.id('status').textContent.includes('Failed to fetch'));
    f.id('cancel').click(); assert.equal(await result, null);
  });
  console.log('DSH computer directory picker: ' + passed + ' passed, ' + failed + ' failed.'); process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
