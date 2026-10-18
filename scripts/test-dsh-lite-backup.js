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
const primaryOrigin = 'https://fixture-primary.trycloudflare.com';
const primarySlot = { phase: 'ready', generation: 'c'.repeat(32), origin: primaryOrigin, url: primaryOrigin + '/dsh-lite', reachable: true, checkedAt: now };
const healthy = (patch = {}, tunnelPatch = {}) => ({ ok: true, tunnels: {
  enabled: true, supported: true, primary: { ...primarySlot }, ...tunnelPatch,
  backup: { phase: 'ready', generation, origin, url: origin + '/dsh-lite', reachable: true, checkedAt: now, ...patch }
} });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(options = {}) {
  const ids = new Map(), events = new Map(), documentEvents = new Map(), copies = [], opened = [], storage = new Map();
  const reads = [], timers = new Map(), plannedReads = []; let tick = now, clockId = 0, connection = 1, ready = options.ready !== false, overlays = 0, externalOverlay = false;
  let preparations = 0, invalidations = 0, preparedResult = null, preparationOptions;
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
  const context = { document, URL, Number, Promise, Date: DateMock, AbortController, location: { origin: options.origin || primaryOrigin },
    performance: options.legacy ? { navigation: { type: options.navigation === 'reload' ? 1 : 0 } } : { getEntriesByType: () => options.unknown ? [] : [{ type: options.navigation || 'reload' }] },
    localStorage: { getItem: key => { if (options.blockStorage) throw Error('blocked'); return storage.get(key); }, setItem: (key, value) => { if (options.blockStorage) throw Error('blocked'); storage.set(key, value); } },
    __dshE2eeSecret: 'SYNTHETIC_PRIMARY_SECRET_NOT_FOR_CLIPBOARD',
    navigator: options.noClipboard ? {} : { clipboard: { writeText: async value => { if (options.denyClipboard) throw Error('denied'); copies.push(value); } } },
    open: (...args) => opened.push(args),
    setTimeout: fn => { timers.set(++clockId, fn); return clockId; }, clearTimeout: id => timers.delete(id),
    addEventListener: (type, fn) => listen(events, type, fn), removeEventListener: (type, fn) => events.get(type)?.delete(fn),
    PocketBridgeBackupPrepare: { createSource: opts => { preparationOptions = opts; return { begin() { preparations++; }, busy: () => false, result: () => preparedResult, invalidateTarget() { invalidations++; preparedResult = null; opts.onState(null); }, update() {}, cancel() {}, dispose() {} }; } },
    DshE2EE: { encryptedFetch: async (secret, url, init) => {
      assert.equal(secret, context.__dshE2eeSecret); assert.equal(url, '/__dsh/lite-addresses');
      assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.body, '{}');
      reads.push({ url, init });
      const planned = plannedReads.shift();
      if (planned) await planned.promise;
      else if (pending) await pending.promise;
      const data = planned ? planned.data : next;
      if (data instanceof Error) throw data;
      return { ok: true, headers: { get: name => name === 'x-dsh-e2ee-decrypted' ? '1' : null }, json: async () => data, ...responsePatch };
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
    get now() { return tick; },
    deferRead(data) { let resolve; const planned = { data: data instanceof Error ? data : structuredClone(data), promise: new Promise(done => { resolve = done; }) }; plannedReads.push(planned); return resolve; },
    get preparations() { return preparations; }, get invalidations() { return invalidations; },
    setPrepared(value) { preparedResult = value; preparationOptions.onState(value); },
    preparationRead() { return preparationOptions.read(); }, get overlays() { return overlays; }, get pending() { return pending; },
    setReady(value) { ready = value; }, nextConnection() { connection++; }, setData(value) { next = value; }, patchResponse(value) { responsePatch = value; },
    hold() { let resolve; pending = { promise: new Promise(r => { resolve = r; }), resolve: () => { resolve(); pending = null; } }; return pending; },
    tick(ms) { tick += ms; }, external(value) { externalOverlay = value; },
    fire(type, event = {}) { for (const fn of events.get(type) || []) fn(event); },
    visibility(hidden) { document.hidden = hidden; for (const fn of documentEvents.get('visibilitychange') || []) fn(); }
  };
}

(async () => {
  for (const navigation of ['back_forward', 'prerender']) {
    const f = fixture({ navigation }); f.control.update(); await flush();
    f.fire('popstate'); f.fire('hashchange'); f.visibility(true); f.visibility(false); f.control.update(); await flush();
    assert.equal(f.overlays, 0); assert.equal(f.reads.length, 2, 'restored pages quietly establish/recheck a baseline');
    f.control.show(); await flush(); assert.equal(f.overlays, 1, 'optional entry works on initial navigation');
  }
  for (const opts of [{}, { navigation: 'navigate' }, { legacy: true, navigation: 'navigate' }, { legacy: true, navigation: 'reload' }, { blockStorage: true }]) {
    const f = fixture({ ...opts, ready: false }); f.control.update(); await flush(); assert.equal(f.reads.length, 0);
    f.setReady(true); f.control.update(); await flush(); assert.equal(f.overlays, 1); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, false);
    f.ids.get('dsh-lite-backup-dialog').__liteClose();
    for (let i = 0; i < 3; i++) { f.setReady(false); f.control.update(); f.setReady(true); f.control.update(); f.fire('popstate'); f.fire('hashchange'); await flush(); }
    assert.equal(f.overlays, 1, 'reconnect / routes never repeat the entry modal');
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
    const f = fixture(); f.external(true); const held = f.hold(); f.control.update(); await flush();
    assert.equal(f.reads.length, 1, 'read-only monitoring may run behind another dialog');
    held.resolve(); await flush(); assert.equal(f.overlays, 0);
    f.external(false); f.control.update(); await flush(); assert.equal(f.overlays, 1, 'wait for the existing dialog to close');
  }
  for (const interruption of ['connection', 'hidden']) {
    const f = fixture(); const held = f.hold(); f.control.update(); await flush(); f.external(true); held.resolve(); await flush();
    if (interruption === 'connection') f.nextConnection();
    else { f.visibility(true); f.visibility(false); }
    f.external(false); f.control.update(); await flush();
    assert.equal(f.overlays, 1, 'an unseen initial prompt requires a fresh verified read after ' + interruption);
    assert.equal(f.reads.length, 2);
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
    assert.equal(f.ids.get('dsh-lite-backup-using').hidden, false);
    assert.equal(f.ids.get('dsh-lite-backup-address').value, primaryOrigin + '/dsh-lite', 'on backup, primary is the OTHER entry');
    assert.match(f.ids.get('dsh-lite-backup-current').textContent, /fixture-backup/);
    f.ids.get('dsh-lite-backup-copy').click(); await flush();
    assert.deepEqual(f.copies, [primaryOrigin + '/dsh-lite']);
    f.ids.get('dsh-lite-backup-prepare').click(); assert.equal(f.preparations, 1);
  }
  {
    const f = fixture({ data: healthy({ phase: 'blocked', url: null }, { code: 'tunnel-migration-unconfirmed' }) });
    f.control.update(); await flush(); assert.match(f.ids.get('dsh-lite-backup-status').textContent, /停止桥接/);
    assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true);
  }
  // Exact current origin and both slot identities are required; no fallback
  // to history, backup role, location query or another browser's state.
  for (const currentOrigin of ['https://old-primary.trycloudflare.com', 'https://unknown.example', 'http://127.0.0.1:8765']) {
    const f = fixture({ origin: currentOrigin }); f.control.update(); await flush();
    assert.equal(f.overlays, 1); assert.equal(f.ids.get('dsh-lite-backup-address').value, '');
    for (const id of ['copy', 'open', 'prepare']) assert.equal(f.ids.get('dsh-lite-backup-' + id).disabled, true);
    assert.match(f.ids.get('dsh-lite-backup-status').textContent, /当前地址不属于/);
    assert.equal(f.preparations, 0); assert.equal(f.opened.length, 0);
  }
  for (const patch of [{ origin: undefined }, { origin: primaryOrigin + '/' }, { checkedAt: now - 180001 },
    { generation: ['cccccccccccccccccccccccccccccccc'] }, { generation: 'UPPERCASE' },
    { url: primaryOrigin + '/dsh-lite?k=SECRET' }, { url: primaryOrigin + '/dsh-lite#k=SECRET' },
    { url: 'https://user@fixture-primary.trycloudflare.com/dsh-lite' }, { url: primaryOrigin + '/other' }]) {
    const f = fixture({ data: healthy({}, { primary: { ...primarySlot, ...patch } }) });
    f.control.update(); await flush(); assert.equal(f.ids.get('dsh-lite-backup-address').value, '', JSON.stringify(patch));
    assert.equal(f.ids.get('dsh-lite-backup-prepare').disabled, true);
  }
  {
    const f = fixture({ data: healthy({ origin: primaryOrigin, url: primaryOrigin + '/dsh-lite' }) });
    f.control.update(); await flush(); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true, 'duplicate current origin is ambiguous');
  }
  {
    const f = fixture({ origin, data: healthy({}, { primary: { ...primarySlot, phase: 'unreachable', origin: null, url: null, reachable: false } }) });
    f.control.update(); await flush();
    assert.equal(f.ids.get('dsh-lite-backup-using').hidden, false);
    assert.equal(f.ids.get('dsh-lite-backup-address').value, '', 'main dead / backup alive cannot offer backup as itself');
    assert.match(f.ids.get('dsh-lite-backup-status').textContent, /没有另一条/);
    const recovered = { ...primarySlot, generation: otherGeneration, origin: 'https://recovered-main.trycloudflare.com', url: 'https://recovered-main.trycloudflare.com/dsh-lite' };
    f.setData(healthy({}, { primary: recovered })); f.ids.get('dsh-lite-backup-check').click(); await flush();
    assert.equal(f.ids.get('dsh-lite-backup-address').value, recovered.url);
    assert.match(f.ids.get('dsh-lite-backup-status').textContent, /尚未验证/);
    assert.equal(f.preparations, 0, 'health recovery never automatically prepares credentials');
    f.ids.get('dsh-lite-backup-dialog').__liteClose(); f.control.update(); await flush();
    assert.equal(f.overlays, 1, 'recovery does not force a dismissed panel open');
    f.control.show(); await flush(); assert.equal(f.ids.get('dsh-lite-backup-address').value, recovered.url);
  }
  {
    const f = fixture({ navigation: 'navigate' }); f.control.show(); f.control.show(); await flush();
    assert.equal(f.overlays, 1, 'repeated manual opens share the same live panel');
    f.ids.get('dsh-lite-backup-dialog').__liteClose(); f.ids.get('dsh-lite-backup-dialog').__liteClose();
    f.control.update(); await flush(); assert.equal(f.overlays, 1, 'manual entry consumes this document reminder');
  }
  {
    const f = fixture(); f.control.update(); await flush();
    f.setData(healthy({ generation: otherGeneration }));
    await assert.rejects(f.preparationRead(), /preparation-target-changed/, 'a new identity after consent requires a fresh click');
    assert.match(f.ids.get('dsh-lite-backup-status').textContent, /尚未验证/);
    const latest = await f.preparationRead(); assert.equal(latest.generation, otherGeneration);
    f.setPrepared({ phase: 'prepared', origin, generation: latest.generation, message: '已验证新入口' });
    assert.equal(f.ids.get('dsh-lite-backup-status').textContent, '已验证新入口');
    f.ids.get('dsh-lite-backup-check').click(); await flush();
    assert.equal(f.ids.get('dsh-lite-backup-status').textContent, '已验证新入口', 'same accepted fresh identity retains successful preparation');
  }
  {
    const f = fixture(); f.control.update(); await flush(); const held = f.hold();
    const reading = f.preparationRead(); f.ids.get('dsh-lite-backup-dialog').__liteClose();
    held.resolve(); await assert.rejects(reading, /preparation-changed|address-cancelled/, 'closing the consent panel cancels or fences delayed preparation metadata');
  }
  for (const replacement of ['generation', 'origin', 'source-generation', 'unavailable', 'unknown']) {
    const f = fixture(); f.control.update(); await flush();
    f.setPrepared({ phase: 'prepared', origin, generation, message: '已验证测试入口' });
    assert.equal(f.ids.get('dsh-lite-backup-status').textContent, '已验证测试入口');
    let next = healthy();
    if (replacement === 'generation') next.tunnels.backup.generation = otherGeneration;
    if (replacement === 'origin') { next.tunnels.backup.origin = 'https://replacement.trycloudflare.com'; next.tunnels.backup.url = next.tunnels.backup.origin + '/dsh-lite'; }
    if (replacement === 'source-generation') next.tunnels.primary.generation = otherGeneration;
    if (replacement === 'unavailable') next.tunnels.backup.reachable = false;
    if (replacement === 'unknown') next.tunnels.primary.origin = 'https://different-main.trycloudflare.com';
    f.setData(next); f.ids.get('dsh-lite-backup-check').click(); await flush();
    assert.notEqual(f.ids.get('dsh-lite-backup-status').textContent, '已验证测试入口', replacement);
    f.setData(healthy()); f.ids.get('dsh-lite-backup-check').click(); await flush();
    assert.match(f.ids.get('dsh-lite-backup-status').textContent, /尚未验证/, 'old prepared badge never revives after ' + replacement);
    assert.ok(f.invalidations >= 2);
  }
  {
    const f = fixture(); f.control.update(); await flush();
    assert.match(f.ids.get('dsh-lite-backup-current').textContent, /fixture-primary/);
    assert.match(f.ids.get('dsh-lite-backup-status').textContent, /尚未验证/);
    assert.equal(f.preparations, 0); assert.equal(f.opened.length, 0, 'entry reminder only reads same-origin encrypted metadata');
  }
  for (const lang of ['zh', 'en', 'es']) {
    const f = fixture({ lang }); f.control.update(); await flush();
    const text = f.ids.get('dsh-lite-backup-dialog').title + f.ids.get('dsh-lite-backup-preparation').textContent + f.ids.get('dsh-lite-backup-status').textContent;
    if (lang !== 'zh') assert.doesNotMatch(text, /[\u4e00-\u9fff]/);
  }
  assert.match(ui, /backupRecovery\.update\(\)/); assert.match(ui, /backupRecovery\.dispose\(\)/);
  console.log('Backup entry reminder: first-entry/reload gating, exact relative origin selection, both directions, recovery, preparation invalidation, copy fallback, cancellation, timing and ZH/EN/ES checks passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
