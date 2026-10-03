'use strict';
// Pure lazy-runtime/lifecycle fixtures. No subprocess, native/PS, browser,
// clipboard, production provider, or public capability activation.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createDotDesktopRuntime, SUPPORTED_VERSIONS } = require('./dot-desktop-runtime.js');
const { createDotDesktopJournal } = require('./dot-desktop-journal.js');
const P = require('./dot-desktop-protocol.js');
const VERSION = '26.928.3736.0';
const base = fs.mkdtempSync(path.join(process.env.DOT_JOURNAL_TEST_DIRECTORY || os.tmpdir(), 'dot-desktop-runtime-'));
const results = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
const rejects = (operation, code) => assert.rejects(operation, cause => cause?.code === code);
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Object.assign(new Error('fixture-timeout'), { code: 'fixture-timeout' });
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
async function check(label, run) {
  try { await run(); results.push({ label, passed: true }); console.log('PASS ' + label); }
  catch (cause) {
    const code = typeof cause?.code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(cause.code) ? cause.code : 'fixture-failed';
    results.push({ label, passed: false, code }); console.log('FAIL ' + label + ' (' + code + ')'); process.exitCode = 1;
  }
}
function baseline(request, operationId) {
  const value = { schemaVersion: 1, requestId: request.requestId, operationId, requestFingerprint: P.fingerprint(request),
    threadId: request.threadId, hostId: 'durable', packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: VERSION,
    windowHandle: '1', processId: 1, creationTicks: '1', viewportRuntimeId: '1,2', messageListRuntimeId: '1,3',
    observationSequence: 1, observedAt: 100, materializedRowCount: 0, completeMaterializedScope: true,
    settled: true, viewportBounds: [0, 0, 800, 600], rows: [] };
  value.contextGeneration = P.contextGeneration(value); return P.normalizeObservation(value, request, operationId);
}
function fixture(settings = {}) {
  const directory = path.join(base, crypto.randomUUID()); fs.mkdirSync(directory);
  const target = crypto.randomUUID(), activeChildren = new Set(), records = new Map();
  const count = { snapshot: 0, inspect: 0, store: 0, createJournal: 0, provider: 0, journalStatus: 0,
    journalClose: 0, shutdown: 0, sender: 0, observe: 0, senderSupports: 0, registered: 0, discardSecrets: 0 };
  const f = { directory, target, count, settings, activeChildren, readChildren: [], inspectChildren: [], sendChild: null,
    evidence: path.join(directory, 'incomplete-owner-evidence'), events: [], throwLookup: false,
    cachedSecret: null, originalSecret: null, providerUnavailable: false };
  const snapshot = () => ({ hostId: 'durable', threadId: target, observedAt: 1,
    historyScope: 'materialized-recent', materializedRowCount: 0, messages: [], ...settings.snapshot });
  const inspection = () => ({ available: true, desktopRunning: true, version: VERSION, ...settings.inspection });
  function childPromise(kind, value) {
    const child = new EventEmitter(); child.closed = false; child.kills = 0; activeChildren.add(child);
    child.kill = () => { child.kills++; };
    child.finish = () => { if (!child.closed) { child.closed = true; child.emit('close'); } };
    f[kind].push(child);
    return new Promise(resolve => child.once('close', () => { activeChildren.delete(child); resolve(value()); }));
  }
  const native = {
    snapshot() { count.snapshot++; f.events.push('snapshot'); return settings.deferSnapshot ? childPromise('readChildren', snapshot) : Promise.resolve(snapshot()); },
    inspect() { count.inspect++; f.events.push('inspect'); return settings.deferInspect ? childPromise('inspectChildren', inspection) : Promise.resolve(inspection()); }
  };
  const get = id => { if (!records.has(id)) throw Object.assign(new Error('not-found'), { code: 'not-found' }); return records.get(id); };
  const receipt = record => ({ requestId: record.requestId, threadId: record.threadId, state: record.state,
    submitted: record.state === 'accepted' ? true : record.state === 'failed' || record.state === 'prepared' ? false : null,
    shownInDesktopConversation: record.state === 'accepted', serverAcknowledged: false, executionConfirmed: false });
  const fakeJournal = {
    status() { count.provider++; count.journalStatus++; return { available: settings.unavailableJournal !== true, pending: false, capacityRemaining: 256 }; },
    lookup(request) { if (f.throwLookup) throw Object.assign(new Error('journal-unavailable'), { code: 'journal-unavailable' }); return records.has(request.requestId) ? receipt(get(request.requestId)) : null; },
    pending(threadId) { return [...records.values()].some(record => record.threadId === threadId && ['prepared', 'sending', 'unknown'].includes(record.state)); },
    prepare(request, operationId, before) { records.set(request.requestId, { ...request, operationId, baseline: before, invokeAuthorized: false, state: 'prepared' }); return { created: true, receipt: receipt(get(request.requestId)) }; },
    markSending(id) { get(id).state = 'sending'; get(id).invokeAuthorized = true; return receipt(get(id)); },
    assertReadyForAck(stage, id) { assert.equal(get(id).state, stage === 'paste' ? 'prepared' : 'sending'); assert.equal(count.registered, 1); return true; },
    markFailedBeforeSend(id) { get(id).state = 'failed'; return receipt(get(id)); },
    markUnknown(id) { get(id).state = 'unknown'; return receipt(get(id)); },
    accept(id) { get(id).state = 'accepted'; return receipt(get(id)); },
    receipt(id, threadId) { const record = get(id); assert.equal(record.threadId, threadId); return receipt(record); },
    reconciliationContext(id, threadId) { const record = get(id); assert.equal(record.threadId, threadId);
      if (record.state !== 'unknown' || !record.invokeAuthorized) return null;
      return { request: { requestId: id, threadId, text: record.text }, operationId: record.operationId,
        baseline: record.baseline, baselineDigest: P.baselineDigest(record.baseline) }; },
    assertReadyForReconcile(id, digest) { assert.equal(get(id).state, 'unknown'); assert.equal(count.registered, 1);
      assert.equal(digest, P.baselineDigest(get(id).baseline)); return true; },
    registerChild() { count.registered++; }, unregisterChild(_helper, closed) { assert.equal(closed, true); count.registered--; },
    close(detail) { assert.equal(detail.allChildrenClosed, true); assert.equal(count.registered, 0); assert.equal(activeChildren.size, 0);
      count.journalClose++; f.events.push('journal-close'); }
  };
  f.fakeJournal = fakeJournal;
  const sender = {
    supports(version) { count.senderSupports++; return settings.senderSupported !== false && version === VERSION; },
    observe(context, callbacks) {
      count.observe++; const child = new EventEmitter(); child.pid = 3002; child.creationTicks = '100002'; child.closed = false;
      f.observeChild = child; activeChildren.add(child);
      const { request, operationId, baseline: before, baselineDigest } = context;
      const helper = { pid: child.pid, creationTicks: child.creationTicks };
      const start = Promise.resolve().then(async () => {
        await callbacks.onLocked(helper); await callbacks.beforeAck('observe', request, operationId, baselineDigest); f.observeReady = true;
      });
      child.finish = () => { if (!child.closed) { child.closed = true; child.emit('close'); } };
      return new Promise((resolve, reject) => child.once('close', async () => {
        activeChildren.delete(child); f.events.push('observe-close');
        try { await start;
          await callbacks.beforeAck('observe-complete', request, operationId, baselineDigest);
          const observed = { ...JSON.parse(JSON.stringify(before)), observationSequence: before.observationSequence + 1,
            observedAt: 200, materializedRowCount: before.rows.length + 1, rows: [...before.rows,
              { observationId: P.sha(crypto.randomUUID()), role: 'user', textSha256: P.sha(request.text) }] };
          if (settings.changeObserved) settings.changeObserved(observed);
          const result = await callbacks.onObserved({ baselineDigest, observation: observed });
          await callbacks.onClose(helper); resolve(result);
        } catch (cause) { try { await callbacks.onClose(helper); } catch (_) {} reject(cause); }
      }));
    },
    send(request, callbacks) {
      count.sender++; const child = new EventEmitter(); child.pid = 3001; child.creationTicks = '100001'; child.closed = false;
      child.kill = () => {}; child.finish = () => { if (!child.closed) { child.closed = true; child.emit('close'); } };
      f.sendChild = child; activeChildren.add(child);
      const operationId = crypto.randomUUID(), before = baseline(request, operationId), helper = { pid: child.pid, creationTicks: child.creationTicks };
      let prepared = false;
      const start = Promise.resolve().then(async () => {
        await callbacks.onLocked(helper); await callbacks.beforeAck('continue-preflight', request, operationId, null);
        await callbacks.onPrepared(request, operationId, before); prepared = true;
        await callbacks.beforeAck('paste', request, operationId, P.baselineDigest(before));
        await callbacks.onReady(request, operationId, before); await callbacks.beforeAck('invoke', request, operationId, P.baselineDigest(before));
        f.sendReady = true;
      });
      return new Promise((resolve, reject) => {
        child.once('close', async () => {
          activeChildren.delete(child); f.events.push('send-close');
          try { await start; await callbacks.onClose(helper, request, operationId, { terminal: false, forced: false }); }
          catch (_) { reject(Object.assign(new Error('unknown'), { code: 'unknown', submitted: prepared ? null : false })); return; }
          reject(Object.assign(new Error('unknown'), { code: 'unknown', submitted: prepared ? null : false }));
        });
        start.catch(() => child.finish());
      });
    }
  };
  const storeFactory = () => {
    count.store++; f.events.push('store');
    if (settings.failStore) { fs.writeFileSync(f.evidence, 'partial fixture'); throw new Error('fixture-store-failure'); }
    if (settings.trackSecrets) {
      f.cachedSecret = Buffer.alloc(32, 7); f.originalSecret = f.cachedSecret;
      fs.writeFileSync(f.evidence, 'partial fixture');
    }
    return {
      ...(settings.trackSecrets ? { discardSecrets() {
        count.discardSecrets++; f.events.push('discard-secrets');
        assert.equal(count.shutdown, 0); assert.equal(count.journalClose, 0);
        if (settings.discardThrowsOnce && count.discardSecrets === 1) throw new Error('fixture-discard-failure');
        if (f.cachedSecret) f.cachedSecret.fill(0); f.cachedSecret = null; f.providerUnavailable = true;
        // This secret-only hook deliberately does not touch journal/owner files.
      } } : {}),
      createJournal() {
        count.createJournal++;
        if (settings.failCreateJournal) { fs.writeFileSync(f.evidence, 'partial fixture'); throw new Error('fixture-journal-failure'); }
        if (settings.realJournal) {
          const material = crypto.randomBytes(32); let marker = { version: 1, journalIdentity: crypto.randomBytes(32).toString('hex'),
            keyIdentity: crypto.randomBytes(32).toString('hex'), provisioned: false };
          const provider = { readContinuityMarker() { count.provider++; return { ...marker }; },
            readJournalKey() { count.provider++; return material; }, commitProvisionedMarker(value) { count.provider++; marker = { ...value }; } };
          f.realJournal = createDotDesktopJournal({ file: path.join(directory, 'requests.json'), keyProvider: provider,
            parentIdentityProvider: () => ({ pid: process.pid, creationTicks: '100000000000000001' }), provision: true });
          return f.realJournal;
        }
        return fakeJournal;
      },
      async shutdown(options) {
        count.shutdown++; f.events.push('shutdown');
        assert.equal((await options.stopNewSends()).stopped, true);
        let timer;
        try {
          const drained = await Promise.race([options.drainOwnedActions(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('private-store-shutdown-timeout'), { code: 'private-store-shutdown-timeout' })), options.timeoutMs);
          })]);
          assert.equal(drained.allOwnedChildrenClosed, true); assert.equal(activeChildren.size, 0);
          f.events.push('drained'); await options.service.close();
        } finally { clearTimeout(timer); }
      }
    };
  };
  const options = { base: directory, driver: native, textSender: sender, storeFactory,
    ...(settings.sendOptions === undefined ? { testOnlyEnableSend: settings.enabled !== false } : settings.sendOptions) };
  f.options = options; f.runtime = createDotDesktopRuntime(options);
  f.connect = () => f.runtime.service.snapshot({ action: 'connect', threadId: target });
  f.refresh = () => f.runtime.service.snapshot({ action: 'snapshot', threadId: target });
  f.request = () => ({ action: 'send', requestId: crypto.randomUUID(), threadId: target, text: 'isolated runtime fixture' });
  return f;
}

(async () => {
  await check('canonical opt-in and the compatible same-value alias remain lazy until a verified Connect', async () => {
    for (const sendOptions of [{ enableSend: true }, { testOnlyEnableSend: true }, { enableSend: true, testOnlyEnableSend: true }]) {
      const f = fixture({ sendOptions }); await f.runtime.service.status();
      assert.equal(f.count.snapshot, 0); assert.equal(f.count.inspect, 0); assert.equal(f.count.store, 0); assert.equal(f.count.sender, 0);
      const connected = await f.connect(); assert.equal(connected.sendAvailable, true); assert.equal(f.count.store, 1);
      await f.runtime.close(); assert.equal(f.count.sender, 0);
    }
  });
  await check('omitted permission and either explicit false keep the runtime read-only without provisioning', async () => {
    for (const sendOptions of [{}, { enableSend: false }, { testOnlyEnableSend: false }, { enableSend: false, testOnlyEnableSend: false }]) {
      const f = fixture({ sendOptions }), connected = await f.connect(); assert.equal(connected.sendAvailable, false);
      await rejects(f.runtime.service.send(f.request()), 'send-unavailable');
      assert.equal(f.count.snapshot, 1); assert.equal(f.count.inspect, 0); assert.equal(f.count.store, 0); assert.equal(f.count.sender, 0);
      await f.runtime.close();
    }
  });
  await check('nonboolean and conflicting permission options are rejected before native or provider work', async () => {
    const f = fixture({ sendOptions: {} }); await f.runtime.close();
    for (const sendOptions of [{ enableSend: 'true' }, { enableSend: 1 }, { enableSend: null }, { enableSend: {} },
      { testOnlyEnableSend: 'false' }, { testOnlyEnableSend: 0 }, { testOnlyEnableSend: null },
      { enableSend: true, testOnlyEnableSend: false }, { enableSend: false, testOnlyEnableSend: true }])
      assert.throws(() => createDotDesktopRuntime({ ...f.options, ...sendOptions }), cause => cause.code === 'invalid-request' && cause.submitted === false);
    assert.equal(f.count.snapshot, 0); assert.equal(f.count.inspect, 0); assert.equal(f.count.store, 0); assert.equal(f.count.sender, 0);
  });
  await check('canonical opt-in cannot bypass missing connection exact version journal readiness or stopped admission', async () => {
    const unbound = fixture({ sendOptions: { enableSend: true } });
    await rejects(unbound.runtime.service.send(unbound.request()), 'not-connected'); assert.equal(unbound.count.sender, 0); await unbound.runtime.close();
    for (const settings of [{ inspection: { version: '26.928.3736.1' } }, { senderSupported: false }, { unavailableJournal: true }]) {
      const f = fixture({ ...settings, sendOptions: { enableSend: true } });
      const connected = await f.connect(); assert.equal(connected.sendAvailable, false);
      await rejects(f.runtime.service.send(f.request()), 'journal-unavailable'); assert.equal(f.count.sender, 0); await f.runtime.close();
    }
    const stopped = fixture({ sendOptions: { enableSend: true } }); await stopped.connect(); stopped.runtime.stop();
    await rejects(stopped.runtime.service.send(stopped.request()), 'send-unavailable'); assert.equal(stopped.count.sender, 0); await stopped.runtime.close();
  });
  await check('constructor and both status surfaces never call provider native inspect or snapshot', async () => {
    for (const enabled of [false, true]) {
      const f = fixture({ enabled }); for (let i = 0; i < 4; i++) { f.runtime.status(); await f.runtime.service.status(); }
      assert.equal(f.count.store, 0); assert.equal(f.count.provider, 0); assert.equal(f.count.snapshot, 0); assert.equal(f.count.inspect, 0);
      assert.equal(f.runtime.status().initialization, 'empty'); await f.runtime.close();
    }
  });
  await check('disabled Connect can read a valid durable scope without inspection or provisioning', async () => {
    const f = fixture({ enabled: false }), snapshot = await f.connect(); assert.equal(snapshot.sendAvailable, false);
    assert.equal(f.count.snapshot, 1); assert.equal(f.count.inspect, 0); assert.equal(f.count.store, 0); await f.runtime.close();
  });
  await check('only the exact accepted desktop version may initialize the provider', async () => {
    assert.deepEqual(SUPPORTED_VERSIONS, [VERSION]);
    for (const version of ['26.928.3736.1', '26.928.3736', VERSION + ' ', null]) {
      const f = fixture({ inspection: { version } }); await f.connect(); assert.equal(f.count.inspect, 1); assert.equal(f.count.store, 0);
      assert.equal(f.runtime.status().initialization, 'empty'); await f.runtime.close();
    }
  });
  await check('unavailable backend absent desktop and unsupported trusted sender never provision', async () => {
    for (const settings of [{ inspection: { available: false } }, { inspection: { desktopRunning: false } }, { senderSupported: false }]) {
      const f = fixture(settings); await f.connect(); assert.equal(f.count.store, 0); assert.equal(f.count.provider, 0); await f.runtime.close();
    }
    const f = fixture(); await f.runtime.close();
    for (const overrides of [{ driver: {} }, { textSender: {} }, { storeFactory: {} }])
      assert.throws(() => createDotDesktopRuntime({ ...f.options, ...overrides }), cause => cause.code === 'invalid-request');
    assert.equal(f.count.store, 0); assert.equal(f.count.snapshot, 0); assert.equal(f.count.inspect, 0);
  });
  await check('wrong host target scope and malformed snapshots fail before inspect or provider', async () => {
    for (const snapshot of [{ hostId: 'local' }, { threadId: crypto.randomUUID() }, { historyScope: 'complete' },
      { messages: null }, { materializedRowCount: -1 }, { observedAt: -1 }, { ok: false },
      { messages: [{ observationId: 'invalid', role: 'tool', text: 'fixture', hasText: true }], materializedRowCount: 1 }]) {
      const f = fixture({ snapshot }); await assert.rejects(f.connect());
      assert.equal(f.count.inspect, 0); assert.equal(f.count.store, 0); assert.equal(f.count.provider, 0); await f.runtime.close();
    }
  });
  await check('valid snapshot then exact inspection initializes once in that order', async () => {
    const f = fixture(), result = await f.connect(); assert.equal(result.sendAvailable, true);
    assert.deepEqual(f.events.slice(0, 3), ['snapshot', 'inspect', 'store']); assert.equal(f.runtime.status().initialization, 'ready');
    await f.refresh(); assert.equal(f.count.store, 1); assert.equal(f.count.createJournal, 1); await f.runtime.close();
  });
  await check('concurrent valid Connect observations create only one private store', async () => {
    const f = fixture(); await Promise.all([f.connect(), f.connect()]); assert.equal(f.count.store, 1);
    assert.equal(f.count.createJournal, 1); await f.runtime.close();
  });
  await check('cached status stays provider-free even with a real ready encrypted journal', async () => {
    const f = fixture({ realJournal: true }); assert.equal(f.count.provider, 0); await f.connect();
    const providerCalls = f.count.provider, inspections = f.count.inspect, snapshots = f.count.snapshot;
    assert(providerCalls > 0);
    for (let i = 0; i < 8; i++) { assert.equal((await f.runtime.service.status()).sendAvailable, true); f.runtime.status(); }
    assert.equal(f.count.provider, providerCalls); assert.equal(f.count.inspect, inspections); assert.equal(f.count.snapshot, snapshots);
    await f.runtime.close(); assert.equal(f.runtime.status().closed, true);
  });
  await check('status declares native-unchecked then preserves the last verified observation time', async () => {
    const f = fixture(), before = await f.runtime.service.status();
    assert.equal(before.statusScope, 'native-unchecked'); assert.equal(before.observedAt, null);
    assert.equal(f.count.inspect, 0); assert.equal(f.count.snapshot, 0); assert.equal(f.count.store, 0);
    await f.connect(); const first = await f.runtime.service.status(), providers = f.count.provider;
    assert.equal(first.statusScope, 'last-verified-connect'); assert(Number.isSafeInteger(first.observedAt) && first.observedAt > 0);
    await tick(); const second = await f.runtime.service.status(); assert.equal(second.observedAt, first.observedAt);
    assert.equal(second.statusScope, first.statusScope); assert.equal(f.count.provider, providers); assert.equal(f.count.inspect, 1);
    await f.runtime.close();
  });
  await check('failed store or journal initialization latches and preserves incomplete evidence on close', async () => {
    for (const settings of [{ failStore: true }, { failCreateJournal: true }]) {
      const f = fixture(settings); await f.connect(); assert.equal(f.runtime.status().initialization, 'failed');
      const evidence = fs.readFileSync(f.evidence); await f.connect(); await f.runtime.service.status();
      assert.equal(f.count.store, 1); assert.equal(f.count.shutdown, 0); await f.runtime.close();
      assert.equal(f.count.journalClose, 0); assert.deepEqual(fs.readFileSync(f.evidence), evidence);
    }
  });
  await check('unavailable initialized journal remains failed without replacement or imagined shutdown', async () => {
    const f = fixture({ unavailableJournal: true }); await f.connect(); await f.connect();
    assert.equal(f.runtime.status().initialization, 'failed'); assert.equal(f.count.store, 1); assert.equal(f.count.createJournal, 1);
    await f.runtime.close(); assert.equal(f.count.shutdown, 0); assert.equal(f.count.journalClose, 0);
  });
  await check('failed provider discards cached secrets immediately once while preserving owner evidence', async () => {
    for (const settings of [{ unavailableJournal: true, trackSecrets: true }, { failCreateJournal: true, trackSecrets: true }]) {
      const f = fixture(settings); await f.connect(); const evidence = fs.readFileSync(f.evidence);
      assert.equal(f.runtime.status().initialization, 'failed'); assert.equal(f.count.discardSecrets, 1);
      assert.equal(f.cachedSecret, null); assert(f.originalSecret.every(byte => byte === 0)); assert.equal(f.providerUnavailable, true);
      assert.equal(f.count.journalClose, 0); assert.equal(f.count.shutdown, 0);
      await f.connect(); await f.runtime.service.status(); assert.equal(f.count.store, 1); assert.equal(f.count.discardSecrets, 1);
      assert.equal(f.runtime.status().initialization, 'failed'); await f.runtime.close(); await f.runtime.close();
      assert.equal(f.count.discardSecrets, 1); assert.equal(f.count.journalClose, 0); assert.equal(f.count.shutdown, 0);
      assert.deepEqual(fs.readFileSync(f.evidence), evidence);
    }
  });
  await check('failed secret disposal retries on close without reopening resetting or deleting evidence', async () => {
    const f = fixture({ unavailableJournal: true, trackSecrets: true, discardThrowsOnce: true }); await f.connect();
    const evidence = fs.readFileSync(f.evidence); assert.equal(f.count.discardSecrets, 1); assert(f.cachedSecret);
    assert.equal(f.runtime.status().initialization, 'failed'); await f.connect(); await f.runtime.service.status();
    assert.equal(f.count.discardSecrets, 1); assert.equal(f.count.store, 1); assert.equal(f.count.createJournal, 1);
    await f.runtime.close(); assert.equal(f.count.discardSecrets, 2); assert.equal(f.cachedSecret, null);
    assert(f.originalSecret.every(byte => byte === 0)); assert.equal(f.providerUnavailable, true);
    assert.equal(f.count.journalClose, 0); assert.equal(f.count.shutdown, 0); assert.equal(f.runtime.status().initialization, 'failed');
    assert.deepEqual(fs.readFileSync(f.evidence), evidence); await f.runtime.close(); assert.equal(f.count.discardSecrets, 2);
  });
  await check('paired target mismatch cannot start a new native read or provider initialization', async () => {
    const f = fixture({ senderSupported: false }); await f.connect(); const snapshots = f.count.snapshot;
    await rejects(f.runtime.service.snapshot({ action: 'snapshot', threadId: crypto.randomUUID() }), 'target-mismatch');
    assert.equal(f.count.snapshot, snapshots); assert.equal(f.count.store, 0); await f.runtime.close();
  });
  await check('close during snapshot waits physical CLOSE and prevents later inspection or provisioning', async () => {
    const f = fixture({ deferSnapshot: true }), read = f.connect().catch(cause => cause); await until(() => f.readChildren.length === 1);
    let settled = false; const closing = f.runtime.close().then(value => { settled = true; return value; }); await tick();
    const child = f.readChildren[0]; child.emit('exit'); child.kill(); await tick(); assert.equal(settled, false);
    assert.equal(f.runtime.status().ownedReads, 1); await rejects(f.connect(), 'desktop-busy');
    child.finish(); assert.equal((await read).code, 'desktop-busy'); await closing;
    assert.equal(f.count.inspect, 0); assert.equal(f.count.store, 0); assert.equal(f.runtime.status().closed, true);
  });
  await check('close during supported inspection prevents provisioning after inspection CLOSE', async () => {
    const f = fixture({ deferInspect: true }), read = f.connect().catch(cause => cause); await until(() => f.inspectChildren.length === 1);
    let settled = false; const closing = f.runtime.close().then(value => { settled = true; return value; }); await tick();
    f.inspectChildren[0].emit('exit'); await tick(); assert.equal(settled, false); assert.equal(f.count.store, 0);
    f.inspectChildren[0].finish(); assert.equal((await read).code, 'desktop-busy'); await closing; assert.equal(f.count.store, 0);
  });
  await check('public service.close facade drains an owned read before closing a ready journal', async () => {
    const f = fixture(); await f.connect(); f.settings.deferSnapshot = true;
    const read = f.refresh().catch(cause => cause); await until(() => f.readChildren.length === 1);
    let settled = false; const closing = f.runtime.service.close().then(value => { settled = true; return value; }); await tick();
    assert.equal(f.count.journalClose, 0); assert.equal(settled, false); f.readChildren[0].emit('exit'); await tick(); assert.equal(settled, false);
    f.readChildren[0].finish(); assert.equal((await read).code, 'desktop-busy'); await closing;
    assert.equal(f.count.journalClose, 1); assert.equal(f.count.shutdown, 1); assert.equal(f.runtime.status().closed, true);
  });
  await check('runtime shutdown stops admission then drains an owned send through physical CLOSE', async () => {
    const f = fixture(); await f.connect(); const operation = f.runtime.service.send(f.request()); await until(() => f.sendReady);
    let settled = false; const closing = f.runtime.close().then(value => { settled = true; return value; }); await tick();
    await rejects(f.runtime.service.send(f.request()), 'send-unavailable'); assert.equal(f.count.journalClose, 0);
    f.sendChild.emit('exit'); f.sendChild.kill(); await tick(); assert.equal(settled, false); assert.equal(f.count.registered, 1);
    f.sendChild.finish(); assert.equal((await operation).receipt.state, 'unknown'); await closing;
    assert.equal(f.count.registered, 0); assert.equal(f.count.journalClose, 1);
    assert(f.events.indexOf('send-close') < f.events.indexOf('journal-close'));
  });
  await check('shutdown waits all owned reads and sends before returning all-children-closed', async () => {
    const f = fixture(); await f.connect(); const send = f.runtime.service.send(f.request()); await until(() => f.sendReady);
    f.settings.deferSnapshot = true; const read = f.refresh().catch(cause => cause); await until(() => f.readChildren.length === 1);
    let settled = false; const closing = f.runtime.close().then(value => { settled = true; return value; }); await tick();
    f.sendChild.finish(); await send; await tick(); assert.equal(f.count.journalClose, 0); assert.equal(settled, false);
    f.readChildren[0].finish(); await read; await closing; assert.equal(f.count.journalClose, 1); assert.equal(f.activeChildren.size, 0);
  });
  await check('shutdown timeout preserves journal ownership and allows close retry after physical CLOSE', async () => {
    const f = fixture(); await f.connect(); f.settings.deferSnapshot = true;
    const read = f.refresh().catch(cause => cause); await until(() => f.readChildren.length === 1);
    await rejects(f.runtime.close({ timeoutMs: 5 }), 'private-store-shutdown-timeout');
    assert.equal(f.count.journalClose, 0); assert.equal(f.runtime.status().closed, false); assert.equal(f.runtime.status().stopping, true);
    f.readChildren[0].finish(); await read; await f.runtime.close(); assert.equal(f.count.journalClose, 1);
  });
  await check('continuity mutation failure disables cached Send without provider work during status', async () => {
    const f = fixture(); await f.connect(); f.throwLookup = true; await rejects(f.runtime.service.send(f.request()), 'journal-unavailable');
    const providers = f.count.provider, inspections = f.count.inspect; assert.equal((await f.runtime.service.status()).sendAvailable, false);
    assert.equal(f.count.provider, providers); assert.equal(f.count.inspect, inspections); await f.runtime.close();
  });
  await check('concurrent and repeated close calls use one shutdown and reject later reads', async () => {
    const f = fixture(); await f.connect(); const first = f.runtime.close(), second = f.runtime.service.close();
    assert.equal(first, second); await Promise.all([first, second]); await f.runtime.close();
    assert.equal(f.count.shutdown, 1); assert.equal(f.count.journalClose, 1); await rejects(f.connect(), 'desktop-busy');
  });
  await check('runtime receipt reconciliation uses original private context and shutdown drains observer CLOSE', async () => {
    for (const realJournal of [false, true]) {
      const f = fixture({ realJournal }); await f.connect(); const request = f.request();
      const send = f.runtime.service.send(request); await until(() => f.sendReady); f.sendChild.finish();
      assert.equal((await send).receipt.state, 'unknown');
      const query = { action: 'receipt', requestId: request.requestId, threadId: request.threadId };
      const first = f.runtime.service.receipt(query), second = f.runtime.service.receipt(query);
      await until(() => f.observeReady); assert.equal(f.count.observe, 1); let closed = false;
      const closing = f.runtime.close().then(() => { closed = true; }); await tick();
      assert.equal(closed, false); assert.equal(f.count.journalClose, 0);
      if (!realJournal) assert.equal(f.count.registered, 1);
      f.observeChild.finish(); assert.equal((await first).receipt.state, 'accepted'); assert.equal((await second).receipt.state, 'accepted');
      await closing; assert.equal(closed, true); assert.equal(f.count.sender, 1); assert.equal(f.count.registered, 0);
    }
  });
  await check('a rejected read proof retains the unknown fence without disabling a later exact reconciliation', async () => {
    const f = fixture({ realJournal: true, changeObserved(value) { value.rows[0].textSha256 = P.sha('unrelated fixture text'); } });
    await f.connect(); const request = f.request();
    const send = f.runtime.service.send(request); await until(() => f.sendReady); f.sendChild.finish();
    assert.equal((await send).receipt.state, 'unknown');
    const query = { action: 'receipt', requestId: request.requestId, threadId: request.threadId };
    const refused = f.runtime.service.receipt(query); await until(() => f.observeReady); f.observeChild.finish();
    assert.equal((await refused).receipt.state, 'unknown');
    assert.equal((await f.runtime.service.status()).sendAvailable, true);
    await rejects(f.runtime.service.send(f.request()), 'pending-request-exists');
    f.settings.changeObserved = null; f.observeReady = false;
    const checked = f.runtime.service.receipt(query); await until(() => f.observeReady); f.observeChild.finish();
    assert.equal((await checked).receipt.state, 'accepted');
    assert.equal((await f.runtime.service.status()).sendAvailable, true);
    assert.equal(f.count.sender, 1); assert.equal(f.count.observe, 2);
    await f.runtime.close();
  });
  const passed = results.filter(value => value.passed).length;
  fs.writeFileSync(path.join(base, 'RESULT.json'), JSON.stringify({ nativeActions: false, productionProvider: false,
    passed, failed: results.length - passed, results }, null, 2));
  console.log(JSON.stringify({ nativeActions: false, productionProvider: false, passed, failed: results.length - passed }));
})().catch(() => { console.error('Runtime fixture runner failed.'); process.exitCode = 1; });
