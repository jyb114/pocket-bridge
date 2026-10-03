'use strict';
// Injected fake children + real encrypted fixture journals only. No native UI,
// subprocess, production key, browser, clipboard, or public Send activation.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createDotTextSender } = require('./dot-desktop-send-driver.js');
const { createDotDesktopService } = require('./dot-desktop-service.js');
const { createDotDesktopJournal, _testOnly } = require('./dot-desktop-journal.js');
const { createDesktopActionScheduler } = require('./desktop-ui-action.js');
const P = require('./dot-desktop-protocol.js');
const VERSION = '1.2.3.4', DOMAIN = 'PocketBridge.IndependentDot.RequestJournal.v1';
const isolatedDirectory = process.env.DOT_JOURNAL_TEST_DIRECTORY || path.join(__dirname, '..', 'logs', 'isolated-tests');
fs.mkdirSync(isolatedDirectory, { recursive: true });
const base = fs.mkdtempSync(path.join(isolatedDirectory, 'dot-desktop-send-'));
const results = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Object.assign(new Error('fixture-timeout'), { code: 'fixture-timeout' });
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
const rejects = (operation, code) => assert.rejects(operation, cause => cause && cause.code === code);
async function check(label, run) {
  try { await run(); results.push({ label, passed: true }); console.log('PASS ' + label); }
  catch (cause) {
    const code = typeof cause?.code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(cause.code) ? cause.code : 'fixture-failed';
    results.push({ label, passed: false, code }); console.log('FAIL ' + label + ' (' + code + ')'); process.exitCode = 1;
  }
}
function journalFixture() {
  const directory = path.join(base, crypto.randomUUID()); fs.mkdirSync(directory);
  const file = path.join(directory, 'journal.json'), material = crypto.randomBytes(32);
  let marker = { version: 1, journalIdentity: crypto.randomBytes(32).toString('hex'),
    keyIdentity: crypto.randomBytes(32).toString('hex'), provisioned: false }, failRename = false;
  const provider = { readContinuityMarker: () => ({ ...marker }), readJournalKey: () => material,
    commitProvisionedMarker(value) { marker = { ...value }; } };
  const options = { file, keyProvider: provider,
    parentIdentityProvider: () => ({ pid: process.pid, creationTicks: '100000000000000001' }) };
  const create = _testOnly.withFileSystem({ ...fs, renameSync(source, target) {
    if (failRename && target === file) throw new Error('fixture-persistence-failure'); return fs.renameSync(source, target);
  } });
  const journal = create({ ...options, provision: true });
  function body() {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = Buffer.from(crypto.hkdfSync('sha256', material, Buffer.from(marker.journalIdentity, 'hex'), Buffer.from(DOMAIN + '.AES256GCM'), 32));
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.nonce, 'base64'));
      decipher.setAAD(Buffer.from(JSON.stringify([DOMAIN, marker.journalIdentity, marker.keyIdentity]))); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]);
      try { return JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
    } finally { key.fill(0); }
  }
  return { file, journal, options, body, failPersistence() { failRename = true; },
    loseContinuity() { marker = { ...marker, provisioned: false }; } };
}
function observedBaseline(request, operationId, rowCount = 1) {
  const value = { schemaVersion: 1, requestId: request.requestId, operationId, requestFingerprint: P.fingerprint(request),
    threadId: request.threadId, hostId: 'durable', packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: VERSION,
    windowHandle: '1', processId: 1, creationTicks: '1', viewportRuntimeId: '1,2', messageListRuntimeId: '1,3',
    observationSequence: 1, observedAt: 100, materializedRowCount: rowCount, completeMaterializedScope: true,
    settled: true, viewportBounds: [0, 0, 800, 600],
    rows: Array.from({ length: rowCount }, (_, index) =>
      ({ observationId: P.sha(crypto.randomUUID()), role: 'assistant', textSha256: P.sha('prior fixture ' + index) })) };
  value.contextGeneration = P.contextGeneration(value); return P.normalizeObservation(value, request, operationId);
}
function harness(fixture, settings = {}) {
  const scheduler = createDesktopActionScheduler(), powershell = path.join(base, 'fixture-powershell.exe');
  const harness = { spawns: [], acknowledgements: [], phaseRecords: [], observations: [], scheduler, eof: 0, kills: 0,
    child: null, input: null, inputs: [], frameSizes: [], mode: settings.mode || 'success', closeOnEOF: settings.closeOnEOF !== false };
  function spawn(executable, args, options) {
    const child = new EventEmitter(); child.pid = harness.mode === 'spawn-error-no-pid' ? undefined : 2001;
    child.stdout = new EventEmitter(); child.stderr = { resume() {} };
    child.stdin = new EventEmitter(); child.closed = false; child.helper = { pid: child.pid, creationTicks: '100001' };
    child.finish = () => { if (!child.closed) { child.closed = true; child.emit('close', 0); } };
    child.emitFrame = value => { const bytes = Buffer.from(JSON.stringify(value) + '\n');
      harness.frameSizes.push(bytes.length); child.stdout.emit('data', bytes); };
    child.kill = () => { harness.kills++; return true; };
    child.stdin.end = () => { harness.eof++; if (harness.closeOnEOF) setImmediate(child.finish); };
    child.stdin.write = text => {
      const value = JSON.parse(text); if (harness.mode === 'initial-write-error' && value.action === 'send') throw new Error('fixture-initial-write-error');
      if (value.action === 'observe') {
        harness.inputs.push(value); harness.input = value;
        const record = fixture.body().records.find(record => record.request.requestId === value.requestId);
        assert.equal(record.state, 'unknown'); assert.equal(record.invokeAuthorized, true);
        assert.equal(Object.hasOwn(value, 'text'), false); assert.equal(Object.hasOwn(value, 'testOnlyPermitSend'), false);
        assert.equal(value.permitReadOnlyReceipt, true); assert.equal(value.operationId, record.operationId);
        assert.deepEqual(value.receiptBaseline, record.baseline); assert.equal(value.baselineDigest, record.baselineDigest);
        harness.request = record.request; harness.before = value.receiptBaseline;
        harness.frame = (stage, sequence, fields = {}) => ({ protocol: 1, operationId: value.operationId,
          requestId: value.requestId, requestFingerprint: value.requestFingerprint, sequence, stage, ...fields });
        harness.after = { ...JSON.parse(JSON.stringify(harness.before)), observationSequence: harness.before.observationSequence + 1,
          observedAt: 200, materializedRowCount: harness.before.rows.length + 1, rows: [...harness.before.rows,
            { observationId: P.sha(crypto.randomUUID()), role: 'user', textSha256: value.textSha256 }] };
        setImmediate(() => child.emitFrame(harness.frame('locked', 1, { helper: child.helper }))); return true;
      }
      if (value.action === 'send') {
        harness.inputs.push(value);
        harness.input = value; harness.request = { requestId: value.requestId, threadId: value.expectedThreadId, text: value.text };
        harness.before = observedBaseline(harness.request, value.operationId, settings.baselineRows || 1);
        const frame = (stage, sequence, fields = {}) => ({ protocol: 1, operationId: value.operationId,
          requestId: value.requestId, requestFingerprint: value.requestFingerprint, sequence, stage, ...fields });
        harness.frame = frame;
        harness.after = { ...JSON.parse(JSON.stringify(harness.before)), observationSequence: 2, observedAt: 101,
          materializedRowCount: harness.before.rows.length + 1, rows: [...harness.before.rows,
            { observationId: P.sha(crypto.randomUUID()), role: 'user', textSha256: P.sha(value.text) }] };
        if (harness.mode === 'spawn-error-no-pid') setImmediate(() => child.emit('error', new Error('fixture-no-pid-spawn-error')));
        else if (harness.mode !== 'hold-locked') setImmediate(() => child.emitFrame(frame('locked', 1,
          { helper: harness.mode === 'reported-pid-mismatch' ? { ...child.helper, pid: 2002 } : child.helper })));
        return true;
      }
      harness.acknowledgements.push(value);
      if (value.stage === 'observe') {
        const manifest = JSON.parse(fs.readFileSync(path.join(fixture.file + '.owner-lock', 'owner.json'), 'utf8'));
        assert.deepEqual(manifest.children, [child.helper]);
        assert.equal(value.baselineDigest, P.baselineDigest(harness.before));
        if (harness.mode === 'observe-hold') return true;
        if (harness.mode === 'observe-error') {
          setImmediate(() => child.emitFrame(harness.frame('error', 2, { baselineDigest: value.baselineDigest,
            code: 'clipboard-unavailable', submitted: false, draftRemaining: false }))); setImmediate(child.finish); return true;
        }
        const observed = JSON.parse(JSON.stringify(harness.after));
        if (settings.changeObservation) settings.changeObservation(observed, harness);
        setImmediate(() => child.emitFrame(harness.frame(harness.mode === 'observe-send-stage' ? 'prepared' : 'observed', 2,
          { baselineDigest: value.baselineDigest, observation: observed })));
        return true;
      }
      if (value.stage === 'observe-complete') { if (harness.mode !== 'observe-before-close') setImmediate(child.finish); return true; }
      if (value.stage === 'continue-preflight') {
        const manifest = JSON.parse(fs.readFileSync(path.join(fixture.file + '.owner-lock', 'owner.json'), 'utf8'));
        assert.deepEqual(manifest.children, [child.helper]);
        if (harness.mode === 'source-unverified') {
          setImmediate(() => child.emitFrame(harness.frame('error', 2, { baselineDigest: null,
            code: 'source-unverified', submitted: false, draftRemaining: false }))); setImmediate(child.finish); return true;
        }
        if (harness.mode === 'eof-before-prepared') { setImmediate(child.finish); return true; }
        if (harness.mode === 'prepare-write-failure') fixture.failPersistence();
        setImmediate(() => child.emitFrame(harness.frame('prepared', 2,
          { baseline: harness.before, baselineDigest: P.baselineDigest(harness.before) })));
      } else if (value.stage === 'paste') {
        const record = fixture.body().records.find(record => record.request.requestId === value.requestId);
        assert.equal(record.state, 'prepared'); assert.equal(record.baselineDigest, value.baselineDigest);
        harness.phaseRecords.push('prepared');
        if (harness.mode === 'hold-prepared') return true;
        if (harness.mode === 'eof-prepared') { setImmediate(child.finish); return true; }
        if (harness.mode === 'prepared-failure') {
          setImmediate(() => child.emitFrame(harness.frame('error', 3, { baselineDigest: value.baselineDigest,
            code: 'draft-present', submitted: false, draftRemaining: true }))); setImmediate(child.finish); return true;
        }
        if (harness.mode === 'sending-write-failure') fixture.failPersistence();
        setImmediate(() => child.emitFrame(harness.frame('ready-to-send', 3,
          { baselineDigest: value.baselineDigest, composerTextHash: P.sha(harness.request.text) })));
      } else if (value.stage === 'invoke') {
        const record = fixture.body().records.find(record => record.request.requestId === value.requestId);
        assert.equal(record.state, 'sending'); assert.equal(record.invokeAuthorized, true);
        assert.equal(record.baselineDigest, value.baselineDigest); harness.phaseRecords.push('sending');
        if (['hold-invoke', 'timeout-invoke'].includes(harness.mode)) return true;
        if (harness.mode === 'eof-sending') { setImmediate(child.finish); return true; }
        if (harness.mode === 'stdin-error') { setImmediate(() => child.stdin.emit('error', new Error('fixture-stdin-error'))); return true; }
        if (harness.mode === 'child-error') { setImmediate(() => child.emit('error', new Error('fixture-child-error'))); return true; }
        if (harness.mode === 'malformed-output') { setImmediate(() => child.stdout.emit('data', Buffer.from('{broken}\n'))); return true; }
        if (harness.mode === 'oversized-output') { setImmediate(() => child.stdout.emit('data', Buffer.alloc(128 * 1024 + 1))); return true; }
        if (harness.mode === 'sending-failure') {
          setImmediate(() => child.emitFrame(harness.frame('error', 4,
            { baselineDigest: value.baselineDigest, code: 'unknown', submitted: null, draftRemaining: true })));
          setImmediate(child.finish); return true;
        }
        let observed = JSON.parse(JSON.stringify(harness.after));
        if (harness.mode === 'invalid-proof') observed.rows[1].textSha256 = P.sha('different fixture');
        if (harness.mode === 'old-row-proof') observed = harness.before;
        if (harness.mode === 'duplicate-proof') { observed.rows.push({ ...observed.rows[1], observationId: P.sha(crypto.randomUUID()) }); observed.materializedRowCount++; }
        setImmediate(() => child.emitFrame(harness.frame('result', 4, { baselineDigest: value.baselineDigest,
          observation: observed, submitted: harness.mode === 'result-false' ? false : harness.mode === 'result-null' ? null : true,
          code: null, draftCleared: true, draftRemaining: false })));
        if (harness.mode !== 'result-before-close') setImmediate(child.finish);
      }
      return true;
    };
    harness.child = child; harness.spawns.push({ executable, args, options }); return child;
  }
  const sender = createDotTextSender({ ...(settings.senderSendOptions === undefined ? { testOnlyEnableSend: settings.enable !== false } : settings.senderSendOptions), platform: 'win32', allowedSendVersions: [VERSION],
    powershellPath: powershell, timeoutMs: settings.timeoutMs || 5000, spawn, runDesktopAction: scheduler.runDesktopAction,
    async observeHelper(pid) {
      harness.observations.push(pid); const child = harness.child;
      if (settings.loseContinuityAt === harness.observations.length) fixture.loseContinuity();
      const observed = { pid: child.pid, parentPid: process.pid, creationTicks: child.helper.creationTicks, path: powershell };
      if (settings.badAttestationAt === harness.observations.length) {
        if (settings.attestationField === 'pid') observed.pid++;
        else if (settings.attestationField === 'parentPid') observed.parentPid++;
        else if (settings.attestationField === 'path') observed.path = path.join(base, 'foreign-fixture.exe');
        else observed.creationTicks = '100002';
      }
      return observed;
    } });
  harness.sender = sender; return harness;
}
async function serviceFixture(settings = {}, previous) {
  const f = previous || journalFixture(), h = harness(f, settings), target = settings.target || crypto.randomUUID();
  const driver = { inspect: async () => ({ available: true, desktopRunning: true, version: settings.inspectionVersion || VERSION }),
    snapshot: async () => ({ hostId: 'durable', threadId: target, observedAt: 1,
      historyScope: 'materialized-recent', materializedRowCount: 0, messages: [] }) };
  const service = createDotDesktopService({ driver, journal: settings.serviceJournal || f.journal, textSender: h.sender,
    ...(settings.serviceSendOptions === undefined ? { testOnlyEnableSend: settings.serviceEnable !== false } : settings.serviceSendOptions) });
  if (settings.connect !== false) await service.snapshot({ action: 'connect', threadId: target });
  const request = () => ({ action: 'send', requestId: crypto.randomUUID(), threadId: target, text: 'fixture text  \n' });
  return { f, h, service, target, request };
}
async function assertBusy(h) { await rejects(h.scheduler.runDesktopAction('codex-inspect', async () => true), 'desktop-busy'); }
async function httpCall(service, value, decrypted) {
  const req = Readable.from([Buffer.from(JSON.stringify(value))]);
  Object.assign(req, { method: 'POST', url: '/dot/desktop', headers: { host: '127.0.0.1:12345',
    origin: 'http://127.0.0.1:12345', 'x-dsh-dot': '1', 'x-dsh-e2ee': '1', 'x-dsh-e2ee-decrypted': '1' }, __dshE2eeDecrypted: decrypted });
  return new Promise(resolve => service.handle(req, { destroyed: false,
    writeHead(status) { this.status = status; }, end(body) { this.destroyed = true; resolve({ status: this.status, body: JSON.parse(body) }); } }));
}

(async () => {
  await check('canonical sender and service opt-in deliver once through the existing committed ACK protocol', async () => {
    for (const permission of [{ enableSend: true }, { testOnlyEnableSend: true }, { enableSend: true, testOnlyEnableSend: true }]) {
      const x = await serviceFixture({ senderSendOptions: permission, serviceSendOptions: permission });
      const request = x.request(), first = await x.service.send(request), repeated = await x.service.send(request);
      assert.equal(first.receipt.state, 'accepted'); assert.equal(repeated.receipt.state, 'accepted'); assert.equal(x.h.spawns.length, 1);
      assert.deepEqual(x.h.acknowledgements.map(value => value.stage), ['continue-preflight', 'paste', 'invoke']); x.service.close();
    }
  });
  await check('missing permission and canonical false in either sender or service refuse dispatch', async () => {
    for (const permission of [{}, { enableSend: false }, { enableSend: false, testOnlyEnableSend: false }]) {
      for (const location of ['senderSendOptions', 'serviceSendOptions']) {
        const x = await serviceFixture({ [location]: permission }); await rejects(x.service.send(x.request()), 'send-unavailable');
        assert.equal(x.h.spawns.length, 0); x.service.close();
      }
    }
  });
  await check('sender and service reject nonboolean or conflicting capability declarations before any helper call', async () => {
    let calls = 0;
    const driver = { inspect: async () => { calls++; return {}; }, snapshot: async () => { calls++; return {}; } };
    for (const permission of [{ enableSend: 'true' }, { enableSend: 1 }, { enableSend: null }, { enableSend: [] },
      { testOnlyEnableSend: 'true' }, { testOnlyEnableSend: 0 }, { testOnlyEnableSend: null },
      { enableSend: true, testOnlyEnableSend: false }, { enableSend: false, testOnlyEnableSend: true }]) {
      assert.throws(() => createDotTextSender({ ...permission, spawn() { calls++; } }), cause => cause.code === 'invalid-request' && cause.submitted === false);
      assert.throws(() => createDotDesktopService({ ...permission, driver }), cause => cause.code === 'invalid-request');
    }
    assert.equal(calls, 0);
  });
  await check('canonical permission still requires the supported version connected target ready journal and open admission', async () => {
    const enabled = { senderSendOptions: { enableSend: true }, serviceSendOptions: { enableSend: true } };
    const wrongVersion = await serviceFixture({ ...enabled, inspectionVersion: '9.9.9.9' });
    await rejects(wrongVersion.service.send(wrongVersion.request()), 'send-unavailable'); assert.equal(wrongVersion.h.spawns.length, 0); wrongVersion.service.close();
    const unbound = await serviceFixture({ ...enabled, connect: false });
    await rejects(unbound.service.send(unbound.request()), 'not-connected'); assert.equal(unbound.h.spawns.length, 0); unbound.service.close();
    let unavailableClosed = false;
    const unavailable = await serviceFixture({ ...enabled, serviceJournal: { status() { return { available: false }; }, close() { unavailableClosed = true; } } });
    await rejects(unavailable.service.send(unavailable.request()), 'journal-unavailable'); assert.equal(unavailable.h.spawns.length, 0); unavailable.service.close(); assert.equal(unavailableClosed, true); unavailable.f.journal.close({ allChildrenClosed: true });
    const stopped = await serviceFixture(enabled); stopped.service.stopAcceptingSends();
    await rejects(stopped.service.send(stopped.request()), 'send-unavailable'); assert.equal(stopped.h.spawns.length, 0); stopped.service.close();
  });
  await check('default sender and service gates refuse Send without spawning a helper', async () => {
    const x = await serviceFixture({ serviceEnable: false }); await rejects(x.service.send(x.request()), 'send-unavailable');
    assert.equal(x.h.spawns.length, 0); assert.equal(x.h.sender.supports('9.9.9.9'), false); x.service.close();
    const y = await serviceFixture({ enable: false }); await rejects(y.service.send(y.request()), 'send-unavailable'); assert.equal(y.h.spawns.length, 0); y.service.close();
  });
  await check('unverified source refusal before prepare keeps its actionable code and grants no paste or Invoke ACK', async () => {
    const x = await serviceFixture({ mode: 'source-unverified' });
    await assert.rejects(x.service.send(x.request()), cause => cause.code === 'source-unverified' && cause.submitted === false &&
      cause.message.includes('open Your dot and its profile') && cause.message.includes('keep any existing draft'));
    assert.deepEqual(x.h.acknowledgements.map(value => value.stage), ['continue-preflight']);
    assert.equal(x.f.body().records.length, 0); assert.equal(x.h.child.closed, true); x.service.close();
  });
  await check('prepared and sending are encrypted committed records before their ACK writes', async () => {
    const x = await serviceFixture(), request = x.request(), result = await x.service.send(request);
    assert.equal(result.receipt.state, 'accepted'); assert.deepEqual(x.h.phaseRecords, ['prepared', 'sending']);
    assert.deepEqual(x.h.acknowledgements.map(value => value.stage), ['continue-preflight', 'paste', 'invoke']);
    assert(x.h.observations.length >= 4); assert.equal(result.receipt.serverAcknowledged, false); assert.equal(result.receipt.executionConfirmed, false);
    assert(!x.h.spawns[0].args.some(arg => [request.text, request.threadId, request.requestId].some(value => arg.includes(value))));
    assert.equal(x.h.spawns[0].options.windowsHide, true); x.service.close();
  });
  await check('a 128-row complete baseline traverses the unchanged framed sender within its output caps', async () => {
    const x = await serviceFixture({ baselineRows: P.MAX_BASELINE_ROWS }), request = x.request();
    const result = await x.service.send(request);
    assert.equal(result.receipt.state, 'accepted'); assert.equal(x.h.spawns.length, 1);
    const saved = x.f.body().records[0]; assert.equal(saved.baseline.rows.length, 128);
    assert.deepEqual(saved.afterObservation.rows.slice(0, 128), saved.baseline.rows);
    assert.equal(saved.afterObservation.rows.length, 129);
    assert(x.h.frameSizes.every(bytes => bytes < 64 * 1024));
    assert(x.h.frameSizes.reduce((sum, bytes) => sum + bytes, 0) < 128 * 1024);
    assert.deepEqual(x.h.acknowledgements.map(value => value.stage), ['continue-preflight','paste','invoke']); x.service.close();
  });
  await check('actual spawned PID parent birth and executable independently gate all ACKs', async () => {
    for (const attestationField of ['pid', 'parentPid', 'creationTicks', 'path']) {
      const x = await serviceFixture({ badAttestationAt: 1, attestationField }); await rejects(x.service.send(x.request()), 'unknown');
      assert.equal(x.h.acknowledgements.length, 0); assert.equal(x.f.body().records.length, 0); x.service.close();
    }
    const mismatch = await serviceFixture({ mode: 'reported-pid-mismatch' }); await rejects(mismatch.service.send(mismatch.request()), 'unknown');
    assert.equal(mismatch.h.observations.length, 0); assert.equal(mismatch.h.acknowledgements.length, 0); mismatch.service.close();
  });
  await check('changed helper birth before paste leaves unknown and grants no paste ACK', async () => {
    const x = await serviceFixture({ badAttestationAt: 3 }), request = x.request(), result = await x.service.send(request);
    assert.equal(result.receipt.state, 'unknown'); assert.deepEqual(x.h.acknowledgements.map(value => value.stage), ['continue-preflight']); x.service.close();
  });
  await check('changed helper birth before Invoke leaves unknown and grants no Invoke ACK', async () => {
    const x = await serviceFixture({ badAttestationAt: 4 }), result = await x.service.send(x.request());
    assert.equal(result.receipt.state, 'unknown'); assert.deepEqual(x.h.acknowledgements.map(value => value.stage), ['continue-preflight', 'paste']); x.service.close();
  });
  await check('concurrent duplicates and changed-content conflicts dispatch only one helper', async () => {
    const x = await serviceFixture({ mode: 'hold-locked' }), request = x.request(); const first = x.service.send(request), second = x.service.send(request);
    await until(() => x.h.child); await rejects(x.service.send({ ...request, text: request.text + 'changed' }), 'request-id-conflict');
    x.h.child.emitFrame(x.h.frame('locked', 1, { helper: x.h.child.helper }));
    const values = await Promise.all([first, second]); assert.equal(x.h.spawns.length, 1);
    assert(values.every(value => value.receipt.state === 'accepted')); x.service.close();
  });
  await check('same target has a pending fence before native prepared and before record persistence', async () => {
    const x = await serviceFixture({ mode: 'hold-locked' }), first = x.service.send(x.request()); await until(() => x.h.child);
    await rejects(x.service.send(x.request()), 'pending-request-exists'); assert.equal(x.h.spawns.length, 1);
    x.h.child.emitFrame(x.h.frame('locked', 1, { helper: x.h.child.helper })); await first; x.service.close();
  });
  await check('receipt checks while preflight is active never dispatch another helper', async () => {
    const x = await serviceFixture({ mode: 'hold-locked' }), request = x.request(), operation = x.service.send(request); await until(() => x.h.child);
    const value = await x.service.receipt({ action: 'receipt', requestId: request.requestId, threadId: request.threadId });
    assert.equal(value.receipt.state, 'checking'); assert.equal(x.h.spawns.length, 1);
    x.h.child.emitFrame(x.h.frame('locked', 1, { helper: x.h.child.helper })); await operation; x.service.close();
  });
  await check('wrong paired target and forged plaintext decrypt markers cannot dispatch', async () => {
    const x = await serviceFixture(); await rejects(x.service.send({ ...x.request(), threadId: crypto.randomUUID() }), 'target-mismatch');
    const response = await httpCall(x.service, x.request(), false); assert.equal(response.status, 403); assert.equal(response.body.code, 'encryption-required');
    assert.equal(x.h.spawns.length, 0); x.service.close();
  });
  await check('pre-send failure preserves a false-submitted failed fence and explicit new action is allowed', async () => {
    const x = await serviceFixture({ mode: 'prepared-failure' }), request = x.request(), failed = await x.service.send(request);
    assert.equal(failed.receipt.state, 'failed'); assert.equal(failed.receipt.submitted, false);
    assert.equal((await x.service.send(request)).receipt.state, 'failed'); assert.equal(x.h.spawns.length, 1);
    x.h.mode = 'success'; assert.equal((await x.service.send(x.request())).receipt.state, 'accepted'); assert.equal(x.h.spawns.length, 2); x.service.close();
  });
  await check('sending failure is unknown and never automatically replays or admits a new target action', async () => {
    const x = await serviceFixture({ mode: 'sending-failure' }), request = x.request(), result = await x.service.send(request);
    assert.equal(result.receipt.state, 'unknown'); assert.equal(result.receipt.submitted, null);
    assert.equal((await x.service.send(request)).receipt.state, 'unknown'); await rejects(x.service.send(x.request()), 'pending-request-exists');
    assert.equal(x.h.spawns.length, 1); x.service.close();
  });
  await check('false or unknown invocation report cannot acquire accepted receipt from a matching row', async () => {
    for (const mode of ['result-false', 'result-null']) {
      const x = await serviceFixture({ mode }), result = await x.service.send(x.request());
      assert.equal(result.receipt.state, 'unknown'); assert.equal(result.receipt.shownInDesktopConversation, false); x.service.close();
    }
  });
  await check('wrong text pre-existing rows and multiple matching fresh rows remain unknown', async () => {
    for (const mode of ['invalid-proof', 'old-row-proof', 'duplicate-proof']) {
      const x = await serviceFixture({ mode }), result = await x.service.send(x.request()); assert.equal(result.receipt.state, 'unknown'); x.service.close();
    }
  });
  await check('unknown receipt survives service restart and a transport retry never spawns', async () => {
    const x = await serviceFixture({ mode: 'invalid-proof' }), request = x.request(); await x.service.send(request); x.service.close();
    const restarted = { ...x.f, journal: createDotDesktopJournal(x.f.options) };
    const next = await serviceFixture({ target: x.target }, restarted), value = await next.service.send(request);
    assert.equal(value.receipt.state, 'unknown'); assert.equal(next.h.spawns.length, 0); next.service.close();
  });
  await check('EOF after prepared or sending saves unknown only after actual CLOSE', async () => {
    for (const mode of ['eof-prepared', 'eof-sending']) {
      const x = await serviceFixture({ mode }), result = await x.service.send(x.request()); assert.equal(result.receipt.state, 'unknown');
      assert.equal(x.h.child.closed, true); assert.equal(JSON.parse(fs.readFileSync(path.join(x.f.file + '.owner-lock', 'owner.json'), 'utf8')).children.length, 0); x.service.close();
    }
  });
  await check('EOF before prepared records no false success or dispatchable pending request', async () => {
    const x = await serviceFixture({ mode: 'eof-before-prepared' }); await rejects(x.service.send(x.request()), 'unknown');
    assert.equal(x.f.body().records.length, 0); assert.equal(x.h.child.closed, true); x.service.close();
  });
  await check('accepted proof does not release the shared lease or service until child CLOSE', async () => {
    const x = await serviceFixture({ mode: 'result-before-close' }), request = x.request(); let settled = false;
    const operation = x.service.send(request).then(value => { settled = true; return value; });
    await until(() => x.f.journal.lookup({ requestId: request.requestId, threadId: request.threadId, text: request.text })?.state === 'accepted');
    await assertBusy(x.h); assert.equal(settled, false);
    assert.equal((await x.service.send(request)).receipt.state, 'accepted'); assert.equal(x.h.spawns.length, 1);
    assert.throws(() => x.service.close(), value => value.code === 'desktop-busy');
    x.h.child.finish(); assert.equal((await operation).receipt.state, 'accepted'); x.service.close();
  });
  await check('synchronous initial pipe failure retains lease until CLOSE', async () => {
    const x = await serviceFixture({ mode: 'initial-write-error', closeOnEOF: false }); let settled = false;
    const operation = x.service.send(x.request()).then(value => { settled = true; return value; }, cause => { settled = true; return cause; });
    await until(() => x.h.child); await tick(); await assertBusy(x.h); assert.equal(settled, false);
    assert.equal(x.h.acknowledgements.length, 0); x.h.child.finish(); const cause = await operation; assert.equal(cause.code, 'unknown'); x.service.close();
  });
  await check('spawn error without PID still retains the child stream lifetime through CLOSE', async () => {
    const x = await serviceFixture({ mode: 'spawn-error-no-pid', closeOnEOF: false }); let settled = false;
    const operation = x.service.send(x.request()).then(value => { settled = true; return value; }, cause => { settled = true; return cause; });
    await until(() => x.h.eof > 0);
    try { await assertBusy(x.h); assert.equal(settled, false); }
    finally { x.h.child.finish(); await operation; x.service.close(); }
  });
  await check('shutdown stops new sends and drain waits for actual active helper CLOSE', async () => {
    const x = await serviceFixture({ mode: 'hold-invoke' }), request = x.request(); let drained = false;
    const operation = x.service.send(request); await until(() => x.h.acknowledgements.some(value => value.stage === 'invoke'));
    x.service.stopAcceptingSends(); await rejects(x.service.send(x.request()), 'send-unavailable');
    const receipt = await x.service.receipt({ action: 'receipt', requestId: request.requestId, threadId: request.threadId });
    assert.equal(receipt.receipt.state, 'sending'); const drain = x.service.drainSends().then(() => { drained = true; });
    await tick(); assert.equal(drained, false); await assertBusy(x.h); x.h.child.finish();
    await drain; assert.equal((await operation).receipt.state, 'unknown'); assert.equal(drained, true); x.service.close();
  });
  await check('pipe process malformed and oversized output errors retain lease through CLOSE', async () => {
    for (const mode of ['stdin-error', 'child-error', 'malformed-output', 'oversized-output']) {
      const x = await serviceFixture({ mode, closeOnEOF: false }); let settled = false;
      const operation = x.service.send(x.request()).then(value => { settled = true; return value; });
      await until(() => x.h.eof > 0); await assertBusy(x.h); assert.equal(settled, false); x.h.child.finish();
      assert.equal((await operation).receipt.state, 'unknown'); x.service.close();
    }
  });
  await check('timeout withdraws permission and hard-kill request still retains lease until CLOSE', async () => {
    const x = await serviceFixture({ mode: 'timeout-invoke', closeOnEOF: false, timeoutMs: 1000 }); let settled = false;
    const operation = x.service.send(x.request()).then(value => { settled = true; return value; });
    await until(() => x.h.kills > 0, 5000); await assertBusy(x.h); assert.equal(settled, false);
    x.h.child.finish(); assert.equal((await operation).receipt.state, 'unknown'); x.service.close();
  });
  await check('prepared commit failure sends no paste ACK and sending commit failure sends no Invoke ACK', async () => {
    for (const mode of ['prepare-write-failure', 'sending-write-failure']) {
      const x = await serviceFixture({ mode }); const cause = await x.service.send(x.request()).catch(value => value);
      assert.equal(cause.ok, undefined); assert.equal(x.h.acknowledgements.some(value => value.stage === 'invoke'), false);
      if (mode === 'prepare-write-failure') assert.equal(x.h.acknowledgements.some(value => value.stage === 'paste'), false);
      assert.equal(x.h.child.closed, true); x.service.close();
    }
  });
  await check('continuity loss after committed prepare still blocks paste ACK', async () => {
    const x = await serviceFixture({ loseContinuityAt: 3 }), cause = await x.service.send(x.request()).catch(value => value);
    assert.equal(cause.ok, undefined); assert.equal(cause.submitted, null);
    assert.deepEqual(x.h.acknowledgements.map(value => value.stage), ['continue-preflight']); x.service.close();
  });
  await check('receipt reconciliation observes the original unknown operation once without Send or public proof input', async () => {
    const x = await serviceFixture({ mode: 'invalid-proof' }), request = x.request();
    assert.equal((await x.service.send(request)).receipt.state, 'unknown');
    const original = x.f.body().records[0]; x.h.mode = 'success';
    const checked = await httpCall(x.service, { action: 'receipt', requestId: request.requestId, threadId: request.threadId }, true);
    assert.equal(checked.status, 200); assert.equal(checked.body.receipt.state, 'accepted');
    assert.equal(checked.body.receipt.serverAcknowledged, false); assert.equal(checked.body.receipt.executionConfirmed, false);
    assert.deepEqual(x.h.inputs.map(input => input.action), ['send', 'observe']);
    assert.deepEqual(x.h.acknowledgements.slice(3).map(ack => ack.stage), ['observe', 'observe-complete']);
    const accepted = x.f.body().records[0]; assert.equal(accepted.operationId, original.operationId);
    assert.deepEqual(accepted.baseline, original.baseline); assert.deepEqual(accepted.request, original.request);
    assert.equal(JSON.stringify(checked.body).includes(request.text), false); assert.equal(Object.hasOwn(checked.body.receipt, 'baseline'), false);
    await x.service.receipt({ action: 'receipt', requestId: request.requestId, threadId: request.threadId });
    await x.service.send(request); assert.equal(x.h.spawns.length, 2);
    assert.equal((await x.service.send(x.request())).receipt.state, 'accepted'); x.service.close();
  });
  await check('simultaneous receipt checks deduplicate and keep UI lease and drain through physical CLOSE', async () => {
    const x = await serviceFixture({ mode: 'invalid-proof' }), request = x.request(); await x.service.send(request);
    x.h.mode = 'observe-before-close'; const query = { action: 'receipt', requestId: request.requestId, threadId: request.threadId };
    let settled = false, drained = false;
    const first = x.service.receipt(query).then(value => { settled = true; return value; }), second = x.service.receipt(query);
    await until(() => x.h.acknowledgements.some(ack => ack.stage === 'observe-complete'));
    assert.equal(x.h.spawns.length, 2); assert.equal(settled, false); await assertBusy(x.h);
    const drain = x.service.drainSends().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    assert.throws(() => x.service.close(), cause => cause.code === 'desktop-busy');
    x.h.child.finish(); assert.equal((await first).receipt.state, 'accepted'); assert.equal((await second).receipt.state, 'accepted');
    await drain; assert.equal(drained, true); x.service.close();
  });
  await check('reconciliation refuses changed scope old-row proof extra user or changed previous assistant without replay', async () => {
    for (const mutate of [after => { after.processId++; after.contextGeneration = P.contextGeneration(after); },
      after => { after.creationTicks = '2'; after.contextGeneration = P.contextGeneration(after); },
      after => { after.windowHandle = '2'; after.contextGeneration = P.contextGeneration(after); },
      after => { after.version = '9.9.9.9'; }, after => { after.viewportBounds[0]++; },
      after => { after.rows[0].textSha256 = P.sha('changed prior streaming assistant'); },
      after => { after.rows.pop(); after.materializedRowCount--; },
      after => { after.rows.push({ observationId: P.sha(crypto.randomUUID()), role: 'user', textSha256: P.sha('another user') }); after.materializedRowCount++; },
      after => { after.rows[1].observationId = after.rows[0].observationId; },
      after => { after.operationId = crypto.randomUUID(); }]) {
      const x = await serviceFixture({ mode: 'invalid-proof', changeObservation: mutate }), request = x.request(); await x.service.send(request);
      x.h.mode = 'success'; const checked = await x.service.receipt({ action: 'receipt', requestId: request.requestId, threadId: request.threadId });
      assert.equal(checked.receipt.state, 'unknown'); assert.deepEqual(x.h.inputs.map(input => input.action), ['send', 'observe']);
      await rejects(x.service.send(x.request()), 'pending-request-exists'); x.service.close();
    }
  });
  await check('receipt reads before-send unknown failed accepted and unsupported contexts never spawn an observer', async () => {
    for (const mode of ['prepared-failure', 'eof-prepared', 'success']) {
      const x = await serviceFixture({ mode }), request = x.request(); await x.service.send(request);
      await x.service.receipt({ action: 'receipt', requestId: request.requestId, threadId: request.threadId });
      assert.equal(x.h.spawns.length, 1); x.service.close();
    }
    const x = await serviceFixture({ mode: 'invalid-proof' }), request = x.request(); await x.service.send(request);
    x.service.stopAcceptingSends(); await x.service.receipt({ action: 'receipt', requestId: request.requestId, threadId: request.threadId });
    assert.equal(x.h.spawns.length, 1); x.service.close();
  });
  await check('receipt foreign target public baseline or operation injection is refused without observation', async () => {
    const x = await serviceFixture({ mode: 'invalid-proof' }), request = x.request(); await x.service.send(request);
    const query = { action: 'receipt', requestId: request.requestId, threadId: request.threadId };
    await rejects(x.service.receipt({ ...query, threadId: crypto.randomUUID() }), 'target-mismatch');
    for (const fields of [{ baseline: x.h.before }, { operationId: crypto.randomUUID() }, { text: request.text }])
      await rejects(x.service.receipt({ ...query, ...fields }), 'invalid-request');
    assert.equal(x.h.spawns.length, 1); x.service.close();
  });
  await check('observe error or send-stage frame retains original unknown and never grants paste or invoke permission', async () => {
    for (const mode of ['observe-error', 'observe-send-stage']) {
      const x = await serviceFixture({ mode: 'invalid-proof' }), request = x.request(); await x.service.send(request);
      x.h.mode = mode; const query = { action: 'receipt', requestId: request.requestId, threadId: request.threadId };
      const checked = await x.service.receipt(query);
      assert.equal(checked.receipt.state, 'unknown');
      assert.equal(checked.checkCode, mode === 'observe-error' ? 'clipboard-unavailable' : 'unknown');
      assert.match(checked.checkMessage, /original send remains unconfirmed; do not resend/);
      assert.equal(x.f.body().records[0].code, 'delivery-unconfirmed');
      assert.deepEqual(x.h.acknowledgements.slice(3).map(ack => ack.stage), ['observe']);
      assert.equal(x.h.child.closed, true); assert.equal(x.f.body().records.length, 1); x.service.close();
    }
  });
  await check('full 128-row original context reconciles through after-limit without exposing original text to helper', async () => {
    const x = await serviceFixture({ mode: 'result-null', baselineRows: 128 }), request = x.request();
    assert.equal((await x.service.send(request)).receipt.state, 'unknown'); x.h.mode = 'success';
    assert.equal((await x.service.receipt({ action: 'receipt', requestId: request.requestId, threadId: request.threadId })).receipt.state, 'accepted');
    assert.equal(x.f.body().records[0].afterObservation.rows.length, 129);
    assert.equal(JSON.stringify(x.h.inputs[1]).includes(request.text), false);
    assert(x.h.frameSizes.every(bytes => bytes < 64 * 1024)); x.service.close();
  });
  await check('receipt helper birth is independently reattested before both read ACKs and never turns unknown into accepted', async () => {
    for (const attempt of [5, 6, 7]) {
      const x = await serviceFixture({ mode: 'invalid-proof', badAttestationAt: attempt }), request = x.request();
      assert.equal((await x.service.send(request)).receipt.state, 'unknown'); x.h.mode = 'success';
      assert.equal((await x.service.receipt({ action: 'receipt', requestId: request.requestId, threadId: request.threadId })).receipt.state, 'unknown');
      assert.deepEqual(x.h.acknowledgements.slice(3).map(ack => ack.stage), attempt === 7 ? ['observe'] : []);
      assert.equal(x.h.child.closed, true); assert.equal(x.f.body().records[0].proof, null); x.service.close();
    }
  });
  const passed = results.filter(value => value.passed).length;
  fs.writeFileSync(path.join(base, 'RESULT.json'), JSON.stringify({ nativeActions: false, productionKeys: false, passed,
    failed: results.length - passed, results }, null, 2));
  console.log(JSON.stringify({ nativeActions: false, productionKeys: false, passed, failed: results.length - passed }));
})().catch(() => { console.error('Send fixture runner failed.'); process.exitCode = 1; });
