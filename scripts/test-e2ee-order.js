'use strict';
// Isolated WebSocket/WebCrypto regression; no gateway, credentials or network.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const e2ee = require('./e2ee');
const root = path.resolve(__dirname, '..');
const source = process.argv.includes('--baseline')
  ? require('child_process').execFileSync('git', ['-c', 'safe.directory=' + root.replace(/\\/g, '/'), 'show', 'HEAD:pwa/e2ee.js'], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, 'pwa', 'e2ee.js'), 'utf8');
const secret = 'fixture-e2ee-order-secret-0123456789';
const keys = e2ee.deriveKeys(secret, e2ee.slotAt());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; }
async function until(test) {
  for (let i = 0; i < 200; i++) { if (test()) return; await sleep(5); }
  assert.fail('fixture did not finish within one second');
}
const decoder = new TextDecoder();
function ciphertext(text) {
  const bytes = e2ee.encrypt(keys.b, text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function plainSent(ws) { return ws.sent.map(buf => e2ee.decrypt(keys.a, Buffer.from(buf)).toString('utf8')); }
function fixture(hooks = {}) {
  const encrypted = [], decrypted = [], errors = [];
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.sent = []; this.closes = []; this.readyState = Socket.OPEN; }
    // Node EventTarget ignores boolean capture during removal; normalize the
    // fixture options to match browser EventTarget capture semantics.
    addEventListener(type, fn, opts) { return super.addEventListener(type, fn, typeof opts === 'boolean' ? { capture: opts } : opts); }
    removeEventListener(type, fn, opts) { return super.removeEventListener(type, fn, typeof opts === 'boolean' ? { capture: opts } : opts); }
    send(data) { this.sent.push(data); }
    close(...args) { this.closes.push(args); this.readyState = Socket.CLOSED; }
    receive(data, init = {}) { this.dispatchEvent(new MessageEvent('message', Object.assign({ data }, init))); }
  }
  Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const crypto = { getRandomValues: v => webcrypto.getRandomValues(v), subtle: {
    importKey: (...args) => webcrypto.subtle.importKey(...args),
    deriveBits: (...args) => webcrypto.subtle.deriveBits(...args),
    encrypt: async (...args) => {
      const text = decoder.decode(args[2]); encrypted.push(text);
      if (hooks.encrypt) await hooks.encrypt(text);
      return webcrypto.subtle.encrypt(...args);
    },
    decrypt: async (...args) => {
      const bytes = await webcrypto.subtle.decrypt(...args);
      const text = decoder.decode(bytes); decrypted.push(text);
      if (hooks.decrypt) await hooks.decrypt(text);
      return bytes;
    }
  } };
  const context = { WebSocket: Socket, crypto: hooks.unavailable ? undefined : crypto,
    TextEncoder, TextDecoder, URL, Uint8Array, ArrayBuffer, Blob, MessageEvent,
    WeakMap, Map, Promise, atob, btoa, console, reportError: err => errors.push(err),
    location: { href: 'https://fixture.invalid/', hash: '' } };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'pwa/e2ee.js' });
  assert.equal(context.DshE2EE.installWsEncryption(secret), !hooks.unavailable);
  const socket = () => new context.WebSocket('wss://fixture.invalid/ws');
  return { socket, Socket, encrypted, decrypted, errors, context };
}
let failed = 0;
async function check(name, run) {
  try { await run(); console.log('PASS ' + name); }
  catch (err) { failed++; console.error('FAIL ' + name + ': ' + err.message); }
}
(async () => {
  await check('outgoing initialize, initialized and turn/start retain send order', async () => {
    const first = gate(), secondStarted = gate();
    const f = fixture({ encrypt: text => {
      if (text === 'initialize') return first.promise;
      if (text === 'initialized') secondStarted.open();
    } });
    const ws = f.socket();
    ws.send('initialize'); ws.send('initialized'); ws.send('turn/start');
    await until(() => f.encrypted.includes('initialize'));
    await Promise.race([secondStarted.promise, sleep(30)]);
    first.open();
    await until(() => ws.sent.length === 3);
    assert.deepEqual(plainSent(ws), ['initialize', 'initialized', 'turn/start']);
    assert.equal(ws.closes.length, 0);
  });
  await check('incoming approval precedes resolved even when decrypt finishes slowly', async () => {
    const first = gate(), secondStarted = gate();
    const f = fixture({ decrypt: text => {
      if (text === 'requestApproval') return first.promise;
      if (text === 'serverRequest/resolved') secondStarted.open();
    } });
    const ws = f.socket(), property = [], listener = [];
    ws.onmessage = ev => property.push(ev.data);
    ws.addEventListener('message', ev => listener.push(ev.data));
    ws.receive(ciphertext('requestApproval')); ws.receive(ciphertext('serverRequest/resolved'));
    await until(() => f.decrypted.includes('requestApproval'));
    await Promise.race([secondStarted.promise, sleep(30)]);
    first.open();
    await until(() => property.length === 2 && listener.length === 2);
    assert.deepEqual(property, ['requestApproval', 'serverRequest/resolved']);
    assert.deepEqual(listener, property);
    assert.deepEqual(f.decrypted, property, 'each wire frame must be decrypted only once');
  });
  await check('Blob reads also retain order and deliver real MessageEvent metadata', async () => {
    const reading = gate(); let reads = 0;
    class SlowBlob extends Blob { async arrayBuffer() { reads++; await reading.promise; return super.arrayBuffer(); } }
    const f = fixture(), ws = f.socket(), property = [], listener = [];
    ws.addEventListener('message', function (ev) { assert.equal(this, ws); listener.push(ev); });
    ws.onmessage = function (ev) { assert.equal(this, ws); property.push(ev); };
    const origin = 'https://fixture.invalid';
    ws.receive(new SlowBlob([ciphertext('question')]), { origin, lastEventId: 'request-42' });
    ws.receive(ciphertext('resolved'));
    await until(() => reads > 0); await sleep(20); reading.open();
    await until(() => property.length === 2 && listener.length === 2);
    assert.deepEqual(property.map(ev => ev.data), ['question', 'resolved']);
    assert.equal(reads, 1);
    assert.equal(property[0], listener[0]);
    assert.ok(property[0] instanceof MessageEvent);
    assert.equal(property[0].origin, origin);
    assert.equal(property[0].lastEventId, 'request-42');
    assert.equal(property[0].target, ws); assert.equal(property[0].currentTarget, ws);
  });
  await check('message listener registration preserves duplicate, capture, once and object behavior', async () => {
    const f = fixture(), ws = f.socket(), got = [];
    const fn = ev => got.push('function:' + ev.data);
    ws.addEventListener('message', fn); ws.addEventListener('message', fn);
    ws.addEventListener('message', fn, true); ws.removeEventListener('message', fn, true);
    const listener = {}; ws.addEventListener('message', listener);
    listener.handleEvent = ev => got.push('object:' + ev.data);
    const once = ev => got.push('once:' + ev.data);
    ws.addEventListener('message', once, { once: true });
    ws.receive(ciphertext('first')); await until(() => got.length >= 3);
    ws.addEventListener('message', once, { once: true });
    ws.receive(ciphertext('second')); await until(() => got.length >= 6);
    assert.deepEqual(got, ['function:first', 'object:first', 'once:first', 'function:second', 'object:second', 'once:second']);
  });
  await check('onmessage replacement does not unregister the same function listener', async () => {
    const f = fixture(), ws = f.socket(), got = [];
    const fn = ev => got.push('shared:' + ev.data);
    ws.addEventListener('message', fn, { once: true }); ws.onmessage = fn;
    ws.onmessage = ev => got.push('property:' + ev.data);
    ws.receive(ciphertext('first')); await until(() => got.length === 2);
    ws.receive(ciphertext('second')); await until(() => got.length >= 3);
    assert.deepEqual(got, ['shared:first', 'property:first', 'property:second']);
    ws.onmessage = null;
  });
  await check('aborted listener may be registered again with a fresh signal', async () => {
    const f = fixture(), ws = f.socket(), got = [];
    const fn = ev => got.push(ev.data), first = new AbortController(), second = new AbortController();
    ws.addEventListener('message', fn, { signal: first.signal }); first.abort();
    ws.addEventListener('message', fn, { signal: second.signal });
    ws.receive(ciphertext('answer')); await until(() => got.length > 0);
    assert.deepEqual(got, ['answer']);
  });
  await check('listener exceptions do not close the socket or poison later frames', async () => {
    const f = fixture(), ws = f.socket(), got = [];
    ws.addEventListener('message', () => { throw new Error('fixture listener failed'); });
    ws.onmessage = ev => got.push(ev.data);
    ws.receive(ciphertext('first')); ws.receive(ciphertext('second'));
    await until(() => got.length === 2);
    assert.deepEqual(got, ['first', 'second']);
    assert.equal(f.errors.length, 2); assert.equal(ws.closes.length, 0);
  });
  await check('stopImmediatePropagation prevents later decrypted listeners', async () => {
    const f = fixture(), ws = f.socket(), got = [];
    ws.addEventListener('message', ev => { got.push(ev.data); ev.stopImmediatePropagation(); });
    ws.onmessage = () => got.push('should not run');
    ws.receive(ciphertext('first')); await until(() => got.length > 0); await sleep(10);
    assert.deepEqual(got, ['first']);
  });
  await check('a slow socket does not block another socket in either direction', async () => {
    const waiting = gate();
    const f = fixture({ encrypt: text => text === 'slow-out' ? waiting.promise : undefined,
      decrypt: text => text === 'slow-in' ? waiting.promise : undefined });
    const slow = f.socket(), fast = f.socket(), gotSlow = [], gotFast = [];
    slow.onmessage = ev => gotSlow.push(ev.data); fast.onmessage = ev => gotFast.push(ev.data);
    slow.send('slow-out'); fast.send('fast-out');
    slow.receive(ciphertext('slow-in')); fast.receive(ciphertext('fast-in'));
    await until(() => fast.sent.length === 1 && gotFast.length === 1);
    assert.deepEqual(plainSent(fast), ['fast-out']); assert.deepEqual(gotFast, ['fast-in']);
    assert.equal(slow.sent.length, 0); assert.equal(gotSlow.length, 0);
    waiting.open(); await until(() => slow.sent.length === 1 && gotSlow.length === 1);
  });
  await check('outgoing crypto rejection closes once and drops queued drafts without leaking', async () => {
    const failure = gate();
    const f = fixture({ encrypt: async text => { if (text === 'bad') { await failure.promise; throw Error('fixture encryption failed'); } } });
    const ws = f.socket(), other = f.socket(); ws.send('bad'); ws.send('queued-private-draft');
    await until(() => f.encrypted.includes('bad')); failure.open();
    await until(() => ws.closes.length === 1); await sleep(10);
    assert.equal(ws.sent.length, 0); assert.deepEqual(f.encrypted, ['bad']);
    assert.throws(() => ws.send('later'), /transport is closed/);
    other.send('other-socket'); await until(() => other.sent.length === 1);
    assert.deepEqual(plainSent(other), ['other-socket']); assert.equal(ws.closes.length, 1);
  });
  await check('failed Blob read closes once and discards later incoming frames', async () => {
    const f = fixture(), ws = f.socket(), other = f.socket(), got = [], otherGot = [];
    class BrokenBlob extends Blob { arrayBuffer() { return Promise.reject(Error('fixture Blob failed')); } }
    ws.onmessage = ev => got.push(ev.data); other.onmessage = ev => otherGot.push(ev.data);
    ws.receive(new BrokenBlob([ciphertext('bad')])); ws.receive(ciphertext('must-drop'));
    await until(() => ws.closes.length === 1); await sleep(10);
    assert.deepEqual(got, []); assert.equal(ws.closes.length, 1);
    other.receive(ciphertext('still-works')); await until(() => otherGot.length === 1);
    assert.deepEqual(otherGot, ['still-works']);
  });
  await check('invalid ciphertext closes once and cannot block or deliver queued frames', async () => {
    const f = fixture(), ws = f.socket(), other = f.socket(), got = [], otherGot = [];
    ws.onmessage = ev => got.push(ev.data); other.onmessage = ev => otherGot.push(ev.data);
    ws.receive(new Uint8Array(48).buffer); ws.receive(ciphertext('must-drop'));
    await until(() => ws.closes.length === 1); await sleep(10);
    assert.deepEqual(got, []); assert.equal(ws.closes.length, 1);
    other.receive(ciphertext('still-works')); await until(() => otherGot.length === 1);
    assert.deepEqual(otherGot, ['still-works']);
  });
  await check('plaintext cannot bypass authenticated transport', () => {
    const f = fixture(), ws = f.socket(), got = [];
    ws.onmessage = ev => got.push(ev.data);
    assert.throws(() => ws.send(new Uint8Array([1, 2])), /text messages only/);
    ws.receive('unauthenticated requestApproval');
    assert.deepEqual(got, []); assert.equal(ws.sent.length, 0); assert.equal(ws.closes.length, 1);
  });
  await check('unavailable encryption leaves native plaintext sockets unchanged', () => {
    const f = fixture({ unavailable: true }), ws = f.socket(), got = [];
    ws.addEventListener('message', ev => got.push(ev.data));
    ws.send('first'); ws.send('second'); ws.receive('question'); ws.receive('resolved');
    assert.deepEqual(ws.sent, ['first', 'second']); assert.deepEqual(got, ['question', 'resolved']);
    assert.equal(ws.closes.length, 0);
  });
  console.log(failed ? 'FAILED: ' + failed + ' regression(s)' : 'PASS: all encrypted WebSocket ordering regressions');
  process.exitCode = failed ? 1 : 0;
})();
