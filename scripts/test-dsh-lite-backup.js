'use strict';

// Synthetic DOM and decrypted transport only. No credentials, gateway, tunnel,
// process launch or external network are used by this regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction, extractRegisterArg } = require('./page-source.js');
const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'pwa/dsh-lite-ui.js'), 'utf8');
const helper = extractFunction(ui, 'createBackupRecovery');
const dictionary = vm.runInNewContext('(' + extractRegisterArg(fs.readFileSync(path.join(root, 'pwa/dsh-lite-lang.js'), 'utf8')) + ')');
const now = 1800000000000;
const generation = 'a'.repeat(32), otherGeneration = 'b'.repeat(32);
const origin = 'https://fixture-backup.trycloudflare.com';
const healthy = (patch = {}, tunnelPatch = {}) => ({ ok: true, tunnels: {
  enabled: true, supported: true, ...tunnelPatch,
  backup: { phase: 'ready', generation, origin, url: origin + '/dsh-lite', reachable: true, checkedAt: now, ...patch }
} });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(options = {}) {
  const ids = new Map(), events = new Map(), documentEvents = new Map(), copies = [], opened = [], storage = new Map();
  const reads = [], timers = new Map(); let tick = now, clockId = 0, connection = 1, ready = options.ready !== false, overlays = 0, externalOverlay = false;
  let preparations = 0;
  let next = options.data || healthy(), responsePatch = {}, pending = null;
  if (options.previous) storage.set('dsh-lite-backup-generation', options.previous);
  function node(tag) {
    return { tagName: tag.toUpperCase(), children: [], attributes: {}, handlers: {}, hidden: false, disabled: false, isConnected: true,
      textContent: '', value: '',
      set id(value) { this._id = value; ids.set(value, this); }, get id() { return this._id; },
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      click() { if (!this.disabled && this.handlers.click) return this.handlers.click(); },
      focus() { document.activeElement = this; }, select() { this.selected = true; },
      querySelector() { return null; }
    };
  }
  function listen(map, type, fn) { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); }
  const document = { hidden: false, activeElement: null, createElement: node,
    querySelector() { return externalOverlay || (ids.get('dsh-lite-backup-dialog')?.isConnected) ? {} : null; },
    addEventListener(type, fn) { listen(documentEvents, type, fn); }, removeEventListener(type, fn) { documentEvents.get(type)?.delete(fn); } };
  const DateMock = class extends Date { static now() { return tick; } };
  const context = { document, URL, Number, Promise, Date: DateMock, AbortController, location: { origin: options.origin || 'https://fixture-primary.trycloudflare.com' },
    performance: options.legacy ? { navigation: { type: options.navigation === 'reload' ? 1 : 0 } } : { getEntriesByType: () => options.unknown ? [] : [{ type: options.navigation || 'reload' }] },
    localStorage: { getItem: key => { if (options.blockStorage) throw Error('blocked'); return storage.get(key); }, setItem: (key, value) => { if (options.blockStorage) throw Error('blocked'); storage.set(key, value); } },
    __dshE2eeSecret: 'SYNTHETIC_PRIMARY_SECRET_NOT_FOR_CLIPBOARD',
    navigator: options.noClipboard ? {} : { clipboard: { writeText: async value => { if (options.denyClipboard) throw Error('denied'); copies.push(value); } } },
    open: (...args) => opened.push(args),
    setTimeout: fn => { timers.set(++clockId, fn); return clockId; }, clearTimeout: id => timers.delete(id),
    addEventListener: (type, fn) => listen(events, type, fn), removeEventListener: (type, fn) => events.get(type)?.delete(fn),
    PocketBridgeBackupPrepare: { createSource: () => ({ begin() { preparations++; }, busy: () => false, result: () => null, update() {}, cancel() {}, dispose() {} }) },
    DshE2EE: { encryptedFetch: async (secret, url, init) => {
      assert.equal(secret, context.__dshE2eeSecret); assert.equal(url, '/__dsh/lite-addresses');
      assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.body, '{}');
      reads.push({ url, init });
      if (pending) await pending.promise;
      if (next instanceof Error) throw next;
      return { ok: true, headers: { get: name => name === 'x-dsh-e2ee-decrypted' ? '1' : null }, json: async () => next, ...responsePatch };
    } }
  };
  context.window = context;
  vm.createContext(context); vm.runInContext('var backupDocumentState = null;\n' + helper, context);
  const T = key => options.lang && options.lang !== 'zh' ? dictionary[key]?.[options.lang] || key : key;
  function mount() {
    return context.createBackupRecovery({ t: T, ready: () => ready, context: () => connection, overlay(title, build) {
      overlays++; const box = node('div'); box.title = title; box.__liteClose = () => { box.isConnected = false; };
      const body = node('div'); box.append(body); build(body, box); return box;
    } });
  }
  const control = mount();
  return { context, control, mount, ids, reads, copies, opened, storage, timers, document,
    get preparations() { return preparations; }, get overlays() { return overlays; }, get pending() { return pending; },
    setReady(value) { ready = value; }, nextConnection() { connection++; }, setData(value) { next = value; }, patchResponse(value) { responsePatch = value; },
    hold() { let resolve; pending = { promise: new Promise(r => { resolve = r; }), resolve: () => { resolve(); pending = null; } }; return pending; },
    tick(ms) { tick += ms; }, external(value) { externalOverlay = value; },
    fire(type, event = {}) { for (const fn of events.get(type) || []) fn(event); },
    visibility(hidden) { document.hidden = hidden; for (const fn of documentEvents.get('visibilitychange') || []) fn(); }
  };
}

(async () => {
  for (const navigation of ['navigate', 'back_forward', 'prerender']) {
    const f = fixture({ navigation }); f.control.update(); await flush();
    f.fire('popstate'); f.fire('hashchange'); f.visibility(true); f.visibility(false); f.control.update(); await flush();
    assert.equal(f.overlays, 0); assert.equal(f.reads.length, 0);
    f.control.show(); await flush(); assert.equal(f.overlays, 1, 'optional entry works on initial navigation');
  }
  for (const opts of [{}, { legacy: true, navigation: 'reload' }, { blockStorage: true }]) {
    const f = fixture({ ...opts, ready: false }); f.control.update(); await flush(); assert.equal(f.reads.length, 0);
    f.setReady(true); f.control.update(); await flush(); assert.equal(f.overlays, 1); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, false);
    f.ids.get('dsh-lite-backup-dialog').__liteClose();
    for (let i = 0; i < 3; i++) { f.setReady(false); f.control.update(); f.setReady(true); f.control.update(); f.fire('popstate'); f.fire('hashchange'); await flush(); }
    assert.equal(f.overlays, 1, 'reconnect / routes never repeat the refresh modal');
    f.control.dispose(); const remount = f.mount(); remount.update(); await flush(); assert.equal(f.overlays, 1, 'remount is same document');
    remount.dispose(); vm.runInContext('backupDocumentState = null;', f.context); const retriedScript = f.mount(); retriedScript.update(); await flush();
    assert.equal(f.overlays, 1, 'retried script still shares the document latch');
  }
  {
    const f = fixture({ unknown: true }); f.control.update(); await flush(); assert.equal(f.overlays, 0);
  }
  {
    const f = fixture(); f.fire('pageshow', { persisted: true }); f.control.update(); await flush(); assert.equal(f.overlays, 0, 'bfcache restoration does not prompt');
  }
  {
    const f = fixture(); const held = f.hold(); f.control.update(); await flush(); f.fire('pageshow', { persisted: true }); held.resolve(); await flush(); assert.equal(f.overlays, 0);
  }
  {
    const f = fixture(); f.external(true); f.control.update(); await flush(); assert.equal(f.reads.length, 0);
    f.external(false); const held = f.hold(); f.control.update(); await flush(); f.external(true); held.resolve(); await flush(); assert.equal(f.overlays, 0);
    f.external(false); f.control.update(); await flush(); assert.equal(f.overlays, 1, 'wait for the existing dialog to close');
  }
  for (const interruption of ['connection', 'hidden']) {
    const f = fixture(); const held = f.hold(); f.control.update(); await flush(); f.external(true); held.resolve(); await flush();
    if (interruption === 'connection') f.nextConnection();
    else { f.visibility(true); f.visibility(false); }
    f.external(false); f.control.update(); await flush();
    assert.equal(f.overlays, 0, 'a deferred initial prompt cannot reopen after ' + interruption + ' changed');
  }
  {
    const f = fixture({ data: healthy({}, { enabled: false }) }); f.control.update(); await flush(); assert.equal(f.overlays, 0);
    f.control.show(); await flush(); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true);
  }
  for (const patch of [{ url: null }, { phase: 'starting' }, { phase: 'unreachable' }, { phase: 'rebuilding' }, { reachable: false }, { checkedAt: now - 180001 }, { checkedAt: now + 6000 }, { generation: '' },
    { url: origin + '/k/SECRET#k=SECRET' }, { url: origin + '/dsh-lite?k=SECRET' }, { url: origin + '/dsh-lite#k=SECRET' },
    { url: 'https://user:password@fixture-backup.trycloudflare.com/dsh-lite' }, { url: 'javascript:alert(1)' }, { url: 'http://fixture-backup.trycloudflare.com/dsh-lite' },
    { url: 'https://evil.example/dsh-lite' }, { origin: 'https://different.trycloudflare.com' }, { url: origin + '/pair' }]) {
    const f = fixture({ data: healthy(patch) }); f.control.update(); await flush();
    assert.equal(f.overlays, 1); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true, JSON.stringify(patch));
    assert.equal(f.ids.get('dsh-lite-backup-address').value, ''); assert.equal(f.copies.length, 0);
  }
  {
    const f = fixture(); f.control.update(); await flush();
    f.ids.get('dsh-lite-backup-prepare').click(); assert.equal(f.preparations, 1, 'actual Prepare button calls controller, not the explanatory paragraph');
    f.ids.get('dsh-lite-backup-copy').click(); await flush();
    assert.deepEqual(f.copies, [origin + '/dsh-lite']); assert.equal(f.reads.length, 2, 'copy rechecks the current address');
    f.ids.get('dsh-lite-backup-open').click(); assert.deepEqual(f.opened, [[origin + '/dsh-lite', '_blank', 'noopener,noreferrer']]);
    assert.doesNotMatch(JSON.stringify([...f.storage.values()]), /SECRET|#|\/k\//);
    f.setData(healthy({ generation: otherGeneration, origin: 'https://new-backup.trycloudflare.com', url: 'https://new-backup.trycloudflare.com/dsh-lite' }));
    f.ids.get('dsh-lite-backup-copy').click(); await flush(); assert.equal(f.copies[1], 'https://new-backup.trycloudflare.com/dsh-lite');
    assert.equal(f.ids.get('dsh-lite-backup-changed').hidden, false);
  }
  for (const option of [{ noClipboard: true }, { denyClipboard: true }]) {
    const f = fixture(option); f.control.update(); await flush(); f.ids.get('dsh-lite-backup-copy').click(); await flush();
    assert.equal(f.ids.get('dsh-lite-backup-address').selected, true); assert.equal(f.copies.length, 0);
    assert.match(f.ids.get('dsh-lite-backup-status').textContent, /浏览器未允许自动复制/);
  }
  {
    const f = fixture({ previous: otherGeneration + '|' + origin }); f.control.update(); await flush(); assert.equal(f.ids.get('dsh-lite-backup-changed').hidden, false);
    f.tick(180001); f.control.update(); await flush(); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true); assert.equal(f.ids.get('dsh-lite-backup-address').value, '');
  }
  for (const marker of ['0', null]) {
    const f = fixture(); f.patchResponse({ headers: { get: () => marker } }); f.control.show(); await flush();
    assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true); assert.match(f.ids.get('dsh-lite-backup-status').textContent, /无法验证/);
  }
  {
    const f = fixture(); f.control.show(); await flush(); const held = f.hold(); f.ids.get('dsh-lite-backup-copy').click(); await flush();
    f.ids.get('dsh-lite-backup-dialog').__liteClose(); held.resolve(); await flush(); assert.equal(f.copies.length, 0, 'closing cancels pending copy intent');
  }
  {
    const f = fixture(); const held = f.hold(); f.control.show(); await flush();
    for (const callback of [...f.timers.values()]) callback(); await flush();
    assert.equal(f.ids.get('dsh-lite-backup-check').disabled, false); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true);
    held.resolve(); await flush(); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true, 'timed-out result cannot restore readiness');
  }
  {
    const f = fixture(); f.control.update(); await flush(); f.visibility(true); assert.equal(f.ids.get('dsh-lite-backup-address').value, '');
    f.visibility(false); f.control.update(); await flush(); assert.equal(f.overlays, 1, 'tab focus does not create another modal');
  }
  for (const change of ['secret', 'connection', 'component']) {
    const f = fixture(); f.control.show(); await flush();
    const held = f.hold(); f.ids.get('dsh-lite-backup-copy').click(); await flush();
    if (change === 'secret') f.context.__dshE2eeSecret = 'SYNTHETIC_REPLACEMENT_KEY';
    else if (change === 'component') f.context.DshE2EE = { ...f.context.DshE2EE };
    else f.nextConnection();
    held.resolve(); await flush();
    assert.equal(f.copies.length, 0, change + ' replacement rejects old decrypted copy response even while ready remains true');
    assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true);
    assert.equal(f.ids.get('dsh-lite-backup-address').value, '');
  }
  {
    const f = fixture({ origin }); f.control.update(); await flush();
    assert.equal(f.ids.get('dsh-lite-backup-using').hidden, false, 'same backup origin is explicitly identified rather than called another alternate');
  }
  {
    const f = fixture({ data: healthy({ phase: 'blocked', url: null }, { code: 'tunnel-migration-unconfirmed' }) });
    f.control.update(); await flush(); assert.match(f.ids.get('dsh-lite-backup-status').textContent, /停止桥接/);
    assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true);
  }
  for (const lang of ['zh', 'en', 'es']) {
    const f = fixture({ lang }); f.control.update(); await flush();
    const text = f.ids.get('dsh-lite-backup-dialog').title + f.ids.get('dsh-lite-backup-preparation').textContent + f.ids.get('dsh-lite-backup-status').textContent;
    if (lang !== 'zh') assert.doesNotMatch(text, /[\u4e00-\u9fff]/);
  }
  assert.match(ui, /backupRecovery\.update\(\)/); assert.match(ui, /backupRecovery\.dispose\(\)/);
  console.log('Backup refresh prompt: reload-only gating, safe current URL, encryption, generations, unavailable states, copy fallback, cancellation, timing and ZH/EN/ES checks passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
