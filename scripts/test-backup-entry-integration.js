'use strict';

// Actual recovery UI and preparation source controller together. The DOM,
// encrypted transport, popup and MessageChannel are synthetic; this test never
// launches a browser, opens a listener or accesses real credentials/tunnels.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./page-source.js');
const root = path.resolve(__dirname, '..');
const recoverySource = extractFunction(fs.readFileSync(path.join(root, 'pwa/dsh-lite-ui.js'), 'utf8'), 'createBackupRecovery');
const preparationSource = fs.readFileSync(path.join(root, 'pwa/dsh-backup-prepare.js'), 'utf8');
const START = 1800000000000;
const PRIMARY = 'https://fixture-primary.trycloudflare.com';
const BACKUP = 'https://fixture-backup.trycloudflare.com';
const KEY = 'SYNTHETIC_INTEGRATION_KEY_NO_REAL_CREDENTIALS';
const BOOT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PREPARATION = 'bprep1_' + 'p'.repeat(43);
const TICKET = 'bp1_' + 't'.repeat(43);
const RECEIPT = 'bpr1_' + 'r'.repeat(43);
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function fixture(sourceRole, source = recoverySource) {
  const targetRole = sourceRole === 'primary' ? 'backup' : 'primary';
  const slots = Object.fromEntries([['primary', PRIMARY], ['backup', BACKUP]].map(([role, origin]) =>
    [role, { phase: 'ready', reachable: true, generation: (role === 'primary' ? 'a' : 'b').repeat(32),
      origin, url: origin + '/dsh-lite', checkedAt: START }]));
  const ids = new Map(), listeners = new Map(), timers = new Map(), posts = [], children = [], requests = [];
  let time = START, timerId = 0, addressReads = 0, heldRead = null, channel, tuple, controller;
  function node(tag) {
    return { tagName: tag.toUpperCase(), isConnected: true, hidden: false, disabled: false, value: '', textContent: '', handlers: {}, children: [],
      set id(value) { this._id = value; ids.set(value, this); }, get id() { return this._id; },
      setAttribute() {}, append(...children) { this.children.push(...children); }, querySelector() { return null; },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      click() { if (!this.disabled) return this.handlers.click?.(); }, focus() {}, select() {} };
  }
  const document = { hidden: false, createElement: node, getElementById: id => ids.get(id) || null,
    querySelector: () => ids.get('dsh-lite-backup-dialog')?.isConnected ? {} : null,
    addEventListener() {}, removeEventListener() {} };
  function response(data) { return { ok: true, redirected: false,
    headers: { get: name => name === 'x-dsh-e2ee-decrypted' ? '1' : null }, json: async () => data }; }
  const win = { document, URL, AbortController, crypto: crypto.webcrypto,
    Date: class extends Date { static now() { return time; } }, location: { origin: slots[sourceRole].origin },
    performance: { getEntriesByType: () => [{ type: 'navigate' }] },
    localStorage: { getItem: () => null, setItem() {} }, navigator: {}, __dshE2eeSecret: KEY,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }, confirm: () => true,
    open(url, target) {
      assert.equal(url, 'about:blank'); assert.equal(target, '_blank');
      const child = { opener: win, closed: false, navigations: [], close() { this.closed = true; },
        location: { replace(url) { assert.equal(child.opener, null); child.navigations.push(url); } },
        postMessage(data, target, ports) { assert.equal(target, slots[targetRole].origin); posts.push({ data, target, ports, child }); } };
      children.push(child); return child;
    },
    MessageChannel: function () {
      const ports = [{}, {}];
      ports.forEach((port, index) => {
        port.closed = false; port.close = () => { port.closed = true; }; port.start = () => {};
        port.postMessage = data => {
          posts.push({ data, port: index });
          Promise.resolve().then(() => { const other = ports[1 - index];
            if (!port.closed && !other.closed) other.onmessage?.({ data }); });
        };
      });
      channel = { port1: ports[0], port2: ports[1] }; return channel;
    },
    DshE2EE: { encryptedFetch: async (secret, url, init) => {
      assert.equal(secret, KEY); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin');
      if (url === '/__dsh/lite-addresses') {
        addressReads++; if (heldRead) await heldRead.promise;
        return response({ ok: true, tunnels: { enabled: true, supported: true, ...structuredClone(slots) } });
      }
      assert.equal(url, '/__dsh/backup-prepare'); assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer');
      const body = JSON.parse(init.body); requests.push(body);
      if (body.action === 'issue') {
        assert.equal(body.origin, slots[targetRole].origin); assert.equal(body.generation, slots[targetRole].generation);
        tuple = { ok: true, origin: body.origin, generation: body.generation, nonce: body.nonce, challenge: body.challenge,
          bootId: BOOT, preparationId: PREPARATION, ticket: TICKET, expiresAt: time + 60000 };
      }
      assert(['issue', 'confirm-receiver', 'status', 'revoke'].includes(body.action));
      const value = { ...tuple };
      if (body.action === 'confirm-receiver') value.receiverVerified = body.receipt === RECEIPT;
      if (body.action === 'status') value.phase = 'completed';
      return response(value);
    } }
  };
  win.window = win; vm.createContext(win); vm.runInContext(preparationSource, win);
  const createSource = win.PocketBridgeBackupPrepare.createSource;
  win.PocketBridgeBackupPrepare.createSource = options => { controller = createSource(options); return controller; };
  vm.runInContext('var backupDocumentState = null;\n' + source, win);
  const recovery = win.createBackupRecovery({ t: text => text, ready: () => true, context: () => 1,
    overlay(_title, build) { const box = node('div'); box.__liteClose = () => { box.isConnected = false; };
      build(node('div'), box); return box; } });
  function click(name) { const button = ids.get('dsh-lite-backup-' + name); assert(button && !button.disabled, name + ' is enabled'); button.click(); }
  function ack() {
    const hello = posts.findLast(post => post.child && post.data.type.endsWith('hello')); assert(hello);
    for (const listener of listeners.get('message') || []) listener({ origin: hello.target, source: hello.child,
      data: { ...hello.data, type: 'pocket-bridge-backup-ready', bootId: BOOT } });
  }
  async function complete() {
    ack(); await flush(); ack(); await flush(); assert(channel);
    assert.equal(posts.some(post => post.data.key), false, 'ticket admission cannot release the encryption key');
    channel.port2.postMessage({ ...tuple, type: 'pocket-bridge-backup-receipt', receipt: RECEIPT }); await flush();
    assert.equal(posts.some(post => post.data.key), false, 'receiver receipt still needs the document-owned acknowledgement');
    const hello = posts.findLast(post => post.port === 0 && post.data.type.endsWith('hello')).data;
    channel.port2.postMessage({ ...hello, type: 'pocket-bridge-backup-ready', bootId: BOOT, preparationId: PREPARATION }); await flush();
    const transfer = posts.findLast(post => post.data.key); assert.equal(transfer?.data.key, KEY); assert.equal(transfer.port, 0);
    channel.port2.postMessage({ ...transfer.data, type: 'pocket-bridge-backup-complete' }); await flush();
    assert.equal(requests.at(-1).action, 'status'); assert.equal(controller.result().phase, 'prepared');
  }
  return { recovery, controller, slots, ids, posts, children, requests, targetRole, click, complete,
    get addressReads() { return addressReads; }, tick(ms) { time += ms; },
    holdRead() { let resolve; heldRead = { promise: new Promise(done => { resolve = done; }) };
      return () => { const release = resolve; heldRead = null; release(); }; },
    status: () => ids.get('dsh-lite-backup-status').textContent };
}

async function changedPreparationRead(sourceRole, source = recoverySource) {
  const f = fixture(sourceRole, source); f.recovery.update(); await flush();
  f.slots[f.targetRole].generation = 'c'.repeat(32); f.click('prepare'); await flush();
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].closed, true, 'a target change after consent closes the un-navigated popup');
  assert.equal(f.children[0].navigations.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(f.posts.some(post => post.data.key), false); assert.equal(f.controller.busy(), false);
  return f;
}

(async () => {
  for (const sourceRole of ['primary', 'backup']) {
    const f = await changedPreparationRead(sourceRole);
    f.click('prepare'); await flush(); assert.equal(f.children.length, 2); assert.equal(f.children[1].navigations.length, 1);
    const reads = f.addressReads; f.tick(20001); f.recovery.update(); await flush();
    assert.equal(f.addressReads, reads, 'periodic checks pause while explicit preparation is busy');
    assert.equal(f.controller.busy(), true);
    await f.complete(); assert.match(f.status(), /已完成登录与加密验证/);
    f.click('check'); await flush(); assert.equal(f.controller.result().phase, 'prepared');
    assert.match(f.status(), /已完成登录与加密验证/, 'same-current check retains genuine completion');
    f.slots[f.targetRole].generation = 'd'.repeat(32); f.click('check'); await flush();
    assert.equal(f.controller.result(), null); assert.match(f.status(), /尚未验证/);
    f.slots[f.targetRole].generation = 'c'.repeat(32); f.click('check'); await flush();
    assert.equal(f.controller.result(), null, 'restoring an old generation never revives preparation');
    f.recovery.dispose();

    const active = fixture(sourceRole); active.recovery.update(); await flush(); active.click('prepare'); await flush();
    active.slots[active.targetRole].generation = 'e'.repeat(32); active.click('check'); await flush();
    assert.equal(active.controller.busy(), false); assert.equal(active.children[0].closed, true);
    assert.equal(active.posts.some(post => post.data.key), false, 'an explicit changed-target check cancels the owned attempt');
    active.recovery.dispose();

    const delayed = fixture(sourceRole); delayed.recovery.update(); await flush(); const release = delayed.holdRead();
    delayed.click('prepare'); await flush(); delayed.ids.get('dsh-lite-backup-dialog').__liteClose(); release(); await flush();
    assert.equal(delayed.children[0].closed, true); assert.equal(delayed.children[0].navigations.length, 0);
    assert.equal(delayed.requests.length, 0, 'closed-panel preparation read cannot issue credentials'); delayed.recovery.dispose();
  }
  // Mutation negative control: restore the former direct read callback while
  // leaving the real UI/controller intact. The same integration must catch it.
  const binding = 'ready: ready, read: readForPreparation,';
  assert.equal(recoverySource.split(binding).length, 2);
  const oldRead = recoverySource.replace(binding, 'ready: ready, read: read,');
  for (const sourceRole of ['primary', 'backup'])
    await assert.rejects(changedPreparationRead(sourceRole, oldRead),
      error => error instanceof assert.AssertionError && /target change after consent/.test(error.message));
  console.log('Backup entry integration: both actual UI/controller directions, changed-consent retry, receipt-before-key completion, busy polling, invalidation, close races and direct-read negative controls passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
