'use strict';
// VM browser-shaped fixtures only: no browser launch, real keys, gateway or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { extractFunction, extractRegisterArg } = require('./page-source.js');
const source = fs.readFileSync(path.join(__dirname, '../pwa/dsh-backup-prepare.js'), 'utf8');
const primary = 'https://fixture-main.trycloudflare.com', backup = 'https://fixture-backup.trycloudflare.com';
const now = 1800000000000, generation = 'a'.repeat(32), bootId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const preparationId = 'bprep1_' + 'p'.repeat(43), ticket = 'bp1_' + 't'.repeat(43), key = 'SYNTHETIC_TRANSFER_KEY_NO_REAL_CREDENTIALS';
const issued = { ok: true, origin: backup, generation, bootId, preparationId, ticket, expiresAt: now + 60000 };
const receipt = 'bpr1_' + 'r'.repeat(43);
function channelFactory(posts) {
  const ports = [{}, {}];
  ports.forEach((port, i) => { port.closed = false; port.start = () => {}; port.close = () => { port.closed = true; };
    port.postMessage = data => { posts.push({ data, port: i }); const other = ports[1 - i];
      if (!port.closed) Promise.resolve().then(() => { if (!other.closed && other.onmessage) other.onmessage({ data }); }); }; });
  return { port1: ports[0], port2: ports[1] };
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function base(origin) {
  const listeners = new Map(), timers = new Map(), elements = new Map(); let n = 0, bytes = 0, clockTime = now;
  const win = { URL, Uint8Array, Array, Object, JSON, Number, Promise, Error, AbortController,
    Date: class extends Date { static now() { return clockTime; } },
    location: { origin }, history: { replaceState(_a, _b, value) { win.historyValue = value; } },
    document: { getElementById: id => elements.get(id) || null },
    crypto: { getRandomValues(value) { value.fill(++bytes); return value; } },
    setTimeout(fn) { timers.set(++n, fn); return n; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)); }
  };
  win.window = win; vm.createContext(win); vm.runInContext(source, win);
  return { win, elements, timers, advance(ms) { clockTime += ms; }, runTimers() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); }, fire(type, value) { for (const fn of listeners.get(type) || []) fn(value); } };
}
function response(value, extra = {}) { return { ok: true, redirected: false,
  headers: { get: name => name === 'x-dsh-e2ee-decrypted' ? '1' : null }, json: async () => value, ...extra }; }
function sourceFixture(options = {}) {
  const f = base(primary), states = [], posts = [], navigations = [], requests = []; let context = 1, active = true, ready = true, hold = null;
  const child = { opener: f.win, closed: false, close() { this.closed = true; },
    location: { replace(url) { assert.equal(child.opener, null, 'opener severed before any external navigation'); navigations.push(url); } },
    postMessage(data, target, ports) { assert.equal(target, backup); posts.push({ data, target, ports }); } };
  let channel; f.win.MessageChannel = function () { channel = channelFactory(posts); return channel; };
  f.win.open = (url, target) => { assert.equal(url, 'about:blank'); assert.equal(target, '_blank'); return options.blocked ? null : child; };
  f.win.confirm = () => options.confirm !== false;
  f.win.__dshE2eeSecret = key;
  f.win.DshE2EE = { encryptedFetch: async (secret, url, init) => {
    assert.equal(secret, key); assert.equal(url, '/__dsh/backup-prepare'); assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.referrerPolicy, 'no-referrer');
    const body = JSON.parse(init.body); requests.push(body); if (hold) await hold.promise;
    if (options.fail) throw Error('synthetic');
    return response(body.action === 'issue' ? { ...issued, nonce: body.nonce, challenge: body.challenge, ...options.issued } :
      body.action === 'confirm-receiver' ? { ...issued, nonce: body.nonce, challenge: body.challenge, receiverVerified: body.receipt === receipt, ...options.confirmReceiver } :
      { ...issued, phase: 'completed', ...options.status }, options.response);
  } };
  let reads = 0;
  const control = f.win.PocketBridgeBackupPrepare.createSource({ t: x => x, ready: () => ready,
    active: () => active, context: () => context, onState: value => states.push({ ...value }),
    read: async () => { reads++; return { url: backup + '/dsh-lite', generation, current: () => true }; } });
  function ack(extra = {}, event = {}) {
    const hello = [...posts].reverse().find(p => p.data.type.endsWith('hello'))?.data;
    if (!hello) return;
    f.fire('message', { origin: backup, source: child, data: { type: 'pocket-bridge-backup-ready',
      ...hello, type: 'pocket-bridge-backup-ready', bootId, ...extra }, ...event });
  }
  function sendPort(data) { channel.port2.postMessage({ nonce: posts.find(p => p.data.type.endsWith('admit')).data.nonce, ...data }); }
  function proveReceipt(extra = {}) { sendPort({ ...issued, type: 'pocket-bridge-backup-receipt', receipt, ...extra }); }
  function portAck(extra = {}) { const hello = [...posts].reverse().find(p => p.port === 0 && p.data.type.endsWith('hello')).data;
    sendPort({ ...hello, type: 'pocket-bridge-backup-ready', bootId, preparationId, ...extra }); }
  return { ...f, control, states, posts, proveReceipt, portAck, sendPort, get channel() { return channel; }, navigations, requests, child, ack, get reads() { return reads; },
    change() { context++; }, hidePanel() { active = false; }, disconnect() { ready = false; },
    hold() { let resolve; hold = { promise: new Promise(r => resolve = r), resolve() { resolve(); hold = null; } }; return hold; } };
}
function receiverFixture(options = {}) {
  const f = base(backup), posts = [], requests = [], stored = []; let hold = null;
  const parent = { postMessage(data, target) { assert.equal(target, primary); posts.push(data); } };
  const config = { source: primary, origin: backup, nonce: '1'.repeat(48), bootId };
  const status = { textContent: '' }, open = { hidden: true }; f.elements.set('backup-prepare-status', status); f.elements.set('backup-prepare-open', open);
  f.win.fetch = async (url, init) => {
    assert.equal(url, '/__backup/redeem'); assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer');
    assert.deepEqual(JSON.parse(init.body), { ticket, nonce: config.nonce, challenge: '3'.repeat(48) }); requests.push({ url, init });
    return response({ ...issued, nonce: config.nonce, challenge: '3'.repeat(48), receipt, ...options.redeem }, options.response);
  };
  const crypto = { startPrepared(value) { assert.equal(value, key); f.win.__dshE2eeSecret = value; return true; },
    prove: async () => options.proof !== false, savePreparedSecret(value) { stored.push(value); return options.persist !== false; },
    forgetPreparedSecret(value) { assert.equal(value, key); stored.length = 0; f.win.__dshE2eeSecret = null; },
    encryptedFetch: async (secret, url, init) => {
      assert.equal(secret, key); assert.equal(url, '/__dsh/backup-prepare'); assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body); assert.equal(body.action, 'complete'); assert.equal(body.origin, backup);
      requests.push({ url, init }); if (hold) await hold.promise;
      return response({ ...issued, checkedAt: now, ...options.complete }, options.completeResponse);
    } };
  f.win.DshE2EE = options.oldComponent ? { prove: crypto.prove } : crypto;
  const channel = channelFactory([]); channel.port1.onmessage = event => posts.push(event.data);
  const control = f.win.PocketBridgeBackupPrepare.startReceiver(config);
  function send(data, event = {}) { f.fire('message', { origin: primary, source: parent, data: { nonce: config.nonce, ...data }, ...event }); }
  function hello(event = {}) { send({ type: 'pocket-bridge-backup-hello', challenge: '2'.repeat(48), generation }, event); }
  function transfer(extra = {}, event = {}) { send({ type: 'pocket-bridge-backup-admit', challenge: '2'.repeat(48), proofChallenge: '3'.repeat(48),
    ticket, preparationId, origin: backup, generation, bootId, ...extra }, { ports: [channel.port2], ...event }); }
  function sendKey() { channel.port1.postMessage({ type: 'pocket-bridge-backup-key', nonce: config.nonce, challenge: '2'.repeat(48),
    key, preparationId, origin: backup, generation, bootId }); }
  return { ...f, control, parent, posts, requests, stored, status, open, hello, transfer, sendKey, channel,
    hold() { let resolve; hold = { promise: new Promise(r => resolve = r), resolve() { resolve(); hold = null; } }; return hold; } };
}
(async () => {
  for (const options of [{ blocked: true }, { confirm: false }]) {
    const f = sourceFixture(options); await f.control.begin(); assert.equal(f.reads, 0); assert.equal(f.requests.length, 0); assert.equal(f.posts.length, 0);
  }
  {
    const f = sourceFixture(); await f.control.begin(); assert.equal(f.navigations.length, 1);
    assert.doesNotMatch(f.navigations[0], /SYNTHETIC|bp1_|#|bprep1_/);
    f.ack({}, { origin: 'https://evil.example' }); f.ack({}, { source: {} }); f.ack({ nonce: 'x' }); await flush(); assert.equal(f.requests.length, 0);
    const old = f.posts.at(-1).data; f.ack(); await flush(); assert.equal(f.requests.length, 1); assert.notEqual(f.posts.at(-1).data.challenge, old.challenge);
    f.ack({ challenge: old.challenge }); await flush(); assert.equal(f.posts.filter(p => p.data.key).length, 0);
    f.ack(); await flush(); assert.equal(f.posts.some(p => p.data.key), false, 'first transfer contains only the ticket');
    f.proveReceipt(); await flush(); assert.equal(f.posts.some(p => p.data.key), false, 'receipt alone still needs same-document port acknowledgement');
    f.portAck(); await flush(); const transfer = f.posts.find(p => p.data.key).data; assert.equal(transfer.key, key);
    assert.equal(f.posts.find(p => p.data.key).port, 0, 'key only enters the document-owned port');
    assert.equal(f.control.result().phase, 'verifying');
    f.sendPort({ ...transfer, type: 'pocket-bridge-backup-complete' }); await flush();
    assert.equal(f.requests.at(-1).action, 'status'); assert.equal(f.control.result().phase, 'prepared');
    f.change(); f.control.update(); assert.equal(f.control.result().phase, 'failed');
  }
  {
    const f = sourceFixture(); await f.control.begin(); f.ack(); await flush(); f.ack(); await flush();
    f.proveReceipt(); await flush(); f.portAck(); await flush();
    const transfer = f.posts.find(p => p.data.key).data;
    f.sendPort({ ...transfer, type: 'pocket-bridge-backup-complete' }); await flush();
    assert.equal(f.control.result().phase, 'prepared');
    f.control.invalidateTarget(); assert.equal(f.control.result(), null);
    f.control.update(); assert.equal(f.control.result(), null, 'a restored target does not revive an old prepared claim');
  }
  for (const phase of ['issue', 'receipt', 'status']) {
    const f = sourceFixture(); await f.control.begin(); let held;
    if (phase === 'issue') { held = f.hold(); f.ack(); }
    else {
      f.ack(); await flush(); f.ack(); await flush();
      if (phase === 'receipt') { held = f.hold(); f.proveReceipt(); }
      else {
        f.proveReceipt(); await flush(); f.portAck(); await flush();
        held = f.hold(); f.sendPort({ ...f.posts.find(p => p.data.key).data, type: 'pocket-bridge-backup-complete' });
      }
    }
    await flush(); f.control.invalidateTarget(); held.resolve(); await flush();
    assert.equal(f.control.busy(), false); assert.equal(f.child.closed, true);
    assert.equal(f.states.some(s => s.phase === 'prepared'), false, 'late ' + phase + ' cannot prepare a changed target');
    if (phase !== 'status') assert.equal(f.posts.some(p => p.data.key), false, 'target changes before key release: ' + phase);
    if (phase !== 'issue') assert.equal(f.channel.port1.closed, true);
  }
  for (const options of [{ issued: { origin: 'https://evil.example' } }, { issued: { generation: 'b'.repeat(32) } },
    { issued: { bootId: 'different-boot' } }, { issued: { expiresAt: now + 60001 } }, { issued: { expiresAt: now } },
    { fail: true }, { response: { redirected: true } }, { response: { url: 'https://evil.example' } },
    { response: { headers: { get: () => null } } }]) {
    const f = sourceFixture(options); await f.control.begin(); f.ack(); await flush();
    assert.equal(f.posts.some(p => p.data.key), false); assert.equal(f.control.result().phase, 'failed');
  }
  for (const change of ['context', 'key', 'component', 'closed', 'panel', 'cancel']) {
    const f = sourceFixture(); await f.control.begin(); const held = f.hold(); f.ack(); await flush();
    if (change === 'context') f.change(); if (change === 'key') f.win.__dshE2eeSecret = 'SYNTHETIC_REPLACEMENT';
    if (change === 'component') f.win.DshE2EE = {}; if (change === 'closed') f.child.closed = true;
    if (change === 'panel') f.hidePanel(); if (change === 'cancel') f.control.cancel();
    held.resolve(); await flush(); f.ack(); await flush(); assert.equal(f.posts.some(p => p.data.key), false, change);
  }
  {
    const f = sourceFixture({ status: { phase: 'redeemed' } }); await f.control.begin(); f.ack(); await flush(); f.ack(); await flush(); f.proveReceipt(); await flush(); f.portAck(); await flush();
    const transfer = f.posts.find(p => p.data.key).data;
    f.sendPort({ ...transfer, type: 'pocket-bridge-backup-complete' }); await flush();
    assert.equal(f.control.result().phase, 'failed', 'child success never substitutes for server status');
  }
  for (const change of ['key', 'component', 'context', 'panel']) {
    const f = sourceFixture(); await f.control.begin(); f.ack(); await flush(); f.ack(); await flush();
    const held = f.hold(); f.proveReceipt(); await flush();
    if (change === 'key') f.win.__dshE2eeSecret = 'SYNTHETIC_REPLACEMENT'; if (change === 'component') f.win.DshE2EE = {};
    if (change === 'context') f.change(); if (change === 'panel') f.hidePanel();
    held.resolve(); await flush(); assert.equal(f.posts.some(p => p.data.key), false, 'receipt context invalidated by ' + change);
  }
  for (const proof of [false, 'fake-receipt', 'replaced-document']) {
    const f = sourceFixture(proof === false ? { confirmReceiver: { receiverVerified: false } } : {});
    await f.control.begin(); f.ack(); await flush(); f.ack(); await flush();
    f.proveReceipt(proof === 'fake-receipt' ? { receipt: 'bpr1_' + 'x'.repeat(43) } : {}); await flush();
    if (proof === 'replaced-document') {
      f.channel.port2.close(); // Old receiver document loses its port on navigation.
      const hello = f.posts.findLast(p => p.port === 0 && p.data.type.endsWith('hello')).data;
      f.ack({ ...hello, preparationId }); await flush(); // New same-origin document only has WindowProxy.
    }
    assert.equal(f.posts.some(p => p.data.key), false, 'no key for ' + proof);
  }
  {
    const f = sourceFixture(); await f.control.begin(); f.ack(); await flush(); f.ack(); await flush();
    f.proveReceipt(); await flush(); f.portAck(); await flush();
    assert.equal(f.control.result().phase, 'verifying');
    // Browser teardown may discard pagehide's failure notice. WindowProxy
    // survives reload and the replacement document does not inherit its port.
    const admission = f.posts.find(p => p.data.type.endsWith('admit')).data;
    f.channel.port2.close(); assert.equal(f.child.closed, false);
    f.fire('message', { origin: backup, source: f.child, data: { ...admission, type: 'pocket-bridge-backup-complete' } });
    f.advance(12001); f.runTimers(); await flush();
    assert.equal(f.control.busy(), true, '12-second fixture wait is shorter than the existing capability deadline');
    assert.equal(f.control.result().phase, 'verifying');
    assert.equal(f.requests.some(r => r.action === 'status'), false, 'a replacement window cannot report completion');
    f.advance(47999); f.runTimers(); await flush();
    assert.equal(f.control.busy(), false); assert.equal(f.control.result().phase, 'failed', 'lost unload notice fails at original 60-second deadline');
    assert.equal(f.states.some(s => s.phase === 'prepared'), false);
    assert.equal(f.child.closed, true); assert.equal(f.channel.port1.closed, true);
    assert.equal(f.requests.at(-1).action, 'revoke');
  }
  {
    const f = receiverFixture(); assert.equal(f.win.historyValue, '/__backup/prepare');
    f.hello({ source: {}, origin: 'https://evil.example' }); f.transfer(); await flush(); assert.equal(f.requests.length, 0);
    f.hello(); f.transfer({}, { source: {} }); await flush(); assert.equal(f.requests.length, 0);
    f.transfer(); await flush(); assert.equal(f.open.hidden, true); f.sendKey(); await flush(); assert.equal(f.open.hidden, false); assert.equal(f.open.href, backup + '/dsh-lite');
    assert.deepEqual(f.stored, [key]); assert.equal(f.posts.at(-1).type, 'pocket-bridge-backup-complete');
    assert.doesNotMatch(JSON.stringify(f.posts), /SYNTHETIC|bp1_/);
    f.transfer(); await flush(); assert.equal(f.requests.length, 2, 'duplicate transfer cannot reissue or repeat completion');
    f.fire('pageshow', { persisted: true }); assert.equal(f.open.hidden, true); assert.match(f.status.textContent, /之前完成/); assert.deepEqual(f.stored, [key]);
  }
  {
    const f = receiverFixture({ oldComponent: true }); f.hello(); f.transfer(); await flush();
    assert.equal(f.requests.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.stored.length, 0);
    assert.match(f.status.textContent, /旧版加密组件/);
  }
  for (const options of [{ proof: false }, { persist: false }, { redeem: { generation: 'b'.repeat(32) } },
    { complete: { bootId: 'changed' } }, { response: { redirected: true } },
    { completeResponse: { headers: { get: () => null } } }, { completeResponse: { redirected: true } }]) {
    const f = receiverFixture(options); f.hello(); f.transfer(); await flush(); f.sendKey(); await flush();
    assert.equal(f.open.hidden, true); assert.equal(f.stored.length, 0); assert.equal(f.posts.some(p => p.type.endsWith('complete')), false);
  }
  for (const change of ['key', 'component', 'pagehide', 'bfcache', 'cancel']) {
    const f = receiverFixture(); const held = f.hold(); f.hello(); f.transfer(); await flush(); f.sendKey(); await flush();
    if (change === 'key') f.win.__dshE2eeSecret = 'SYNTHETIC_REPLACEMENT'; if (change === 'component') f.win.DshE2EE = {};
    if (change === 'pagehide') f.fire('pagehide', {}); if (change === 'bfcache') f.fire('pageshow', { persisted: true }); if (change === 'cancel') f.control.cancel();
    held.resolve(); await flush(); assert.equal(f.open.hidden, true); assert.equal(f.posts.some(p => p.type.endsWith('complete')), false, change);
  }
  // Execute actual storage/start helpers with stub cryptography, including old
  // stored material and both thrown and silently discarded persistent writes.
  const e2ee = fs.readFileSync(path.join(__dirname, '../pwa/e2ee.js'), 'utf8');
  assert.match(e2ee, /currentScript\.hasAttribute\('data-defer-start'\)/);
  for (const previous of [null, 'SYNTHETIC_OLD_KEY', key]) for (const mode of ['ok', 'throw-set', 'throw-get', 'discard', 'partial-session', 'write-unreadable']) {
    const storage = new Map(previous ? [['persist', previous], ['session', previous]] : []); let starts = 0, oldReads = 0, unreadable = false;
    function store(session) { return {
      setItem(k, v) {
        if (v === key && mode === 'throw-set') throw Error('denied');
        if (v === key && session && mode === 'partial-session') { storage.set(k, v); throw Error('partial'); }
        if (mode !== 'discard' || v !== key) storage.set(k, v);
        if (mode === 'write-unreadable' && v === key) unreadable = true;
      },
      getItem(k) { if (mode === 'throw-get' || unreadable) throw Error('denied'); return storage.get(k) || null; }, removeItem: k => storage.delete(k)
    }; }
    const c = { preparedStarted: false, preparedKey: null, preparedWrites: [], secretSource: null,
      global: { localStorage: store(false), sessionStorage: store(true) }, proofState: { ok: false },
      PERSIST_SECRET_KEY: 'persist', SESSION_SECRET_KEY: 'session', secretFromUrl() { oldReads++; return 'SYNTHETIC_OLD_KEY'; },
      startWithSecret(value) { starts++; c.global.__dshE2eeSecret = value; return true; } };
    vm.createContext(c);
    for (const name of ['currentSecret', 'startPrepared', 'savePreparedSecret', 'rollbackPreparedSecret', 'forgetPreparedSecret']) vm.runInContext(extractFunction(e2ee, name), c);
    assert.equal(c.startPrepared(key), true); assert.equal(starts, 1);
    assert.equal(c.currentSecret(), key); assert.equal(oldReads, 0, 'prepared proof never reads an older stored key');
    assert.equal(c.savePreparedSecret(key), false, 'proof is mandatory before persistence'); c.proofState.ok = true;
    const expected = previous === key ? mode !== 'throw-get' : mode === 'ok';
    assert.equal(c.savePreparedSecret(key), expected, mode + ' / ' + previous);
    assert.equal(c.startPrepared(key), false, 'one startup per receiver');
    c.forgetPreparedSecret(key);
    assert.equal(storage.get('persist') || null, mode === 'write-unreadable' && previous !== key ? key : previous,
      'unreadable storage cannot guarantee restoration, but never reports saved');
    assert.equal(storage.get('session') || null, previous, 'rollback preserves preexisting session value');
  }
  {
    const storage = new Map([['persist', key]]);
    const c = { preparedStarted: true, preparedKey: key, preparedWrites: [], secretSource: 'prepared',
      global: { __dshE2eeSecret: key, localStorage: { getItem: k => storage.get(k), removeItem: k => storage.delete(k) } }, proofState: { ok: false } };
    vm.createContext(c); for (const name of ['rollbackPreparedSecret', 'forgetPreparedSecret']) vm.runInContext(extractFunction(e2ee, name), c);
    c.forgetPreparedSecret(key); assert.equal(storage.get('persist'), key, 'failed proof before any write cannot erase a working key');
  }
  // Whole actual E2EE module and real WebCrypto, with synthetic-only fetch.
  {
    const crypto = require('node:crypto'), oldKey = 'SYNTHETIC_OLDER_STORED_KEY_ONLY', newKey = 'SYNTHETIC_NEW_PREPARATION_KEY_ONLY';
    const local = new Map([['dsh-e2ee-secret-persist-v1', oldKey]]), session = new Map([['dsh-e2ee-secret-v1', oldKey]]);
    const store = map => ({ getItem: name => map.get(name) || null, setItem: (name, value) => map.set(name, value), removeItem: name => map.delete(name) });
    let fetches = 0;
    const c = { crypto: crypto.webcrypto, TextEncoder, TextDecoder, URL, Headers, Response, Request, Uint8Array, ArrayBuffer, Blob, atob, btoa,
      location: { origin: backup, href: backup + '/__backup/prepare', pathname: '/__backup/prepare', search: '', hash: '' },
      localStorage: store(local), sessionStorage: store(session), WebSocket: class {},
      document: { currentScript: { hasAttribute: name => name === 'data-defer-start' }, addEventListener() {} },
      addEventListener() {}, setInterval() { throw Error('Unexpected proof upkeep'); },
      fetch: async (url, init) => {
        assert.equal(url, '/__auth/verify'); assert.equal(init.redirect, 'error'); fetches++;
        const body = JSON.parse(init.body);
        const derived = crypto.hkdfSync('sha256', Buffer.from(newKey), Buffer.from('dsh-gw-auth'), Buffer.from('dsh-gw|auth|v1'), 32);
        assert.equal(body.response, crypto.createHmac('sha256', derived).update(body.ts + '|' + body.nonce).digest('base64url'));
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      } };
    c.window = c; vm.createContext(c); vm.runInContext(e2ee, c);
    assert.equal(c.__dshE2eeSecret, undefined); assert.equal(fetches, 0);
    assert.equal(c.DshE2EE.startPrepared(newKey), true); assert.equal(local.get('dsh-e2ee-secret-persist-v1'), oldKey);
    assert.equal(await c.DshE2EE.prove(true), true); assert.equal(fetches, 1); assert.equal(local.get('dsh-e2ee-secret-persist-v1'), oldKey);
    assert.equal(c.DshE2EE.savePreparedSecret(newKey), true); assert.equal(local.get('dsh-e2ee-secret-persist-v1'), newKey);
    c.DshE2EE.forgetPreparedSecret(newKey); assert.equal(local.get('dsh-e2ee-secret-persist-v1'), oldKey);
    assert.equal(session.get('dsh-e2ee-secret-v1'), oldKey);
  }
  const dictionary = vm.runInNewContext('(' + extractRegisterArg(fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite-lang.js'), 'utf8')) + ')');
  for (const item of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) {
    assert.ok(dictionary[item[1]]?.en && dictionary[item[1]]?.es, 'Missing preparation translation: ' + item[1]);
  }
  console.log('Backup preparation UI: explicit click, popup fencing, origin/window/nonces, redirects, context races, protected completion, storage and history checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
