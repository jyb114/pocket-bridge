'use strict';
// Pure filesystem/protocol fixtures only. No native/UI action or production key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createDotDesktopJournal, _testOnly } = require('./dot-desktop-journal.js');
const { acquireJournalOwner } = require('./dot-desktop-owner.js');
const protocol = require('./dot-desktop-protocol.js');
const DOMAIN = 'PocketBridge.IndependentDot.RequestJournal.v1';
const isolatedDirectory = process.env.DOT_JOURNAL_TEST_DIRECTORY || path.join(__dirname, '..', 'logs', 'isolated-tests');
fs.mkdirSync(isolatedDirectory, { recursive: true });
const base = fs.mkdtempSync(path.join(isolatedDirectory, 'dot-desktop-journal-'));
const results = [];
const denied = (code, run) => assert.throws(run, value => value && value.code === code && value.message === code);
const close = journal => journal.close({ allChildrenClosed: true });
function captureEngineKey(open) {
  // Observe the real private key buffer supplied to the initial authenticated
  // decrypt. No production hook/key export is added and no bytes are printed.
  const original = crypto.createDecipheriv; let captured;
  crypto.createDecipheriv = function (...args) {
    const decipher = Reflect.apply(original, crypto, args);
    if (args[0] === 'aes-256-gcm' && Buffer.isBuffer(args[1]) && args[1].length === 32) captured = args[1];
    return decipher;
  };
  try {
    const journal = open(); assert(Buffer.isBuffer(captured)); assert(captured.some(value => value !== 0));
    return { journal, key: captured };
  } finally { crypto.createDecipheriv = original; }
}
function check(label, run) { run(); results.push(label); console.log('PASS ' + label); }
function fixture(maximumRecords) {
  const directory = path.join(base, crypto.randomUUID()); fs.mkdirSync(directory);
  const file = path.join(directory, 'journal.json');
  let material = crypto.randomBytes(32), marker = { version: 1, journalIdentity: crypto.randomBytes(32).toString('hex'),
    keyIdentity: crypto.randomBytes(32).toString('hex'), provisioned: false };
  const provider = { readContinuityMarker: () => marker && { ...marker }, readJournalKey: () => material,
    commitProvisionedMarker(value) { marker = { ...value }; } };
  const options = { file, keyProvider: provider,
    parentIdentityProvider: () => ({ pid: process.pid, creationTicks: '100000000000000001' }) };
  if (maximumRecords !== undefined) options.maximumRecords = maximumRecords;
  const make = extra => createDotDesktopJournal({ ...options, ...extra });
  const start = () => make({ provision: true });
  const request = (text = 'isolated fixture ' + crypto.randomUUID(), threadId = crypto.randomUUID()) =>
    ({ requestId: crypto.randomUUID(), threadId, text });
  function derived() { return Buffer.from(crypto.hkdfSync('sha256', material, Buffer.from(marker.journalIdentity, 'hex'),
    Buffer.from(DOMAIN + '.AES256GCM'), 32)); }
  function readBody() {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')), key = derived();
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(Buffer.from(JSON.stringify([DOMAIN, marker.journalIdentity, marker.keyIdentity])));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      try { return JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
    } finally { key.fill(0); }
  }
  function writeBody(body) {
    const key = derived(), nonce = crypto.randomBytes(12), bytes = Buffer.from(JSON.stringify(body));
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify([DOMAIN, marker.journalIdentity, marker.keyIdentity])));
      const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
      fs.writeFileSync(file, JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    } finally { key.fill(0); bytes.fill(0); }
  }
  return { file, options, provider, make, start, request, readBody, writeBody,
    marker: () => marker, setMarker: value => { marker = value; }, setMaterial: value => { material = value; } };
}
const row = (role, text, observationId = protocol.sha(crypto.randomUUID())) =>
  ({ observationId, role, textSha256: protocol.sha(text) });
function baseline(request, operationId, rows = [row('assistant', 'prior fixture')]) {
  const value = { schemaVersion: 1, requestId: request.requestId, operationId, requestFingerprint: protocol.fingerprint(request),
    threadId: request.threadId, hostId: 'durable', packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: '1.2.3.4',
    windowHandle: '1', processId: 1, creationTicks: '1', viewportRuntimeId: '1,2', messageListRuntimeId: '1,3',
    observationSequence: 1, observedAt: 100, materializedRowCount: rows.length,
    completeMaterializedScope: true, settled: true, viewportBounds: [0, 0, 800, 600], rows };
  value.contextGeneration = protocol.contextGeneration(value);
  return protocol.normalizeObservation(value, request, operationId);
}
function after(before, request, observationId) {
  const value = { ...JSON.parse(JSON.stringify(before)), observationSequence: before.observationSequence + 1, observedAt: 101 };
  value.rows.push(row('user', request.text, observationId)); value.materializedRowCount++;
  return value;
}
function prepared(f, journal, request = f.request()) {
  const operationId = crypto.randomUUID(), before = baseline(request, operationId);
  journal.prepare(request, operationId, before);
  return { request, operationId, before, digest: protocol.baselineDigest(before) };
}
function accepted(f, journal, request) {
  const value = prepared(f, journal, request); journal.markSending(value.request.requestId, value.digest);
  value.after = after(value.before, value.request); value.receipt = journal.accept(value.request.requestId, value.after); return value;
}

check('explicit trusted provisioning stores no key text or durable request identities', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal);
  const disk = fs.readFileSync(f.file, 'utf8');
  for (const secret of [value.request.text, value.request.requestId, value.request.threadId,
    f.marker().journalIdentity, f.marker().keyIdentity]) assert(!disk.includes(secret));
  assert.equal(JSON.parse(disk).algorithm, 'aes-256-gcm'); close(journal);
});
check('unprovisioned and absent markers never auto-create keys or journals', () => {
  const f = fixture(); denied('journal-provisioning-required', () => f.make()); assert(!fs.existsSync(f.file));
  const missing = fixture(); missing.setMarker(null);
  denied('continuity-unavailable', () => missing.make()); assert(!fs.existsSync(missing.file));
});
check('provisioned journal deletion blocks constructor and preserves provisioned marker', () => {
  const f = fixture(), journal = f.start(); close(journal); fs.unlinkSync(f.file);
  denied('journal-missing', () => f.make()); assert.equal(f.marker().provisioned, true); assert(!fs.existsSync(f.file));
});
check('existing ciphertext is never silently reprovisioned', () => {
  const f = fixture(), journal = f.start(); close(journal); const prior = fs.readFileSync(f.file);
  denied('journal-provisioning-conflict', () => f.make({ provision: true })); assert.deepEqual(fs.readFileSync(f.file), prior);
});
check('same-ID duplicate returns receipt and changed text or target conflicts', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal);
  assert.equal(journal.prepare(value.request, null, null).created, false);
  assert.equal(journal.lookup(value.request).requestId, value.request.requestId);
  denied('request-id-conflict', () => journal.lookup({ ...value.request, text: value.request.text + ' ' }));
  denied('request-id-conflict', () => journal.lookup({ ...value.request, threadId: crypto.randomUUID() })); close(journal);
});
check('unresolved receipt fences another action in the same durable conversation', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal);
  const other = f.request('another fixture', value.request.threadId), operationId = crypto.randomUUID();
  denied('pending-request-exists', () => journal.prepare(other, operationId, baseline(other, operationId)));
  assert.equal(journal.pending(value.request.threadId), true); close(journal);
});
check('prepared and sending restart as unknown with no replay authority', () => {
  for (const sending of [false, true]) {
    const f = fixture(), first = f.start(), value = prepared(f, first);
    if (sending) first.markSending(value.request.requestId, value.digest);
    close(first); const restarted = f.make();
    assert.equal(restarted.lookup(value.request).state, 'unknown'); assert.equal(restarted.lookup(value.request).submitted, null);
    assert.equal(restarted.prepare(value.request, value.operationId, value.before).created, false);
    denied('invalid-transition', () => restarted.markSending(value.request.requestId, value.digest)); close(restarted);
  }
});
check('immutable baseline and exact own whitespace survive caller mutation', () => {
  const f = fixture(), journal = f.start(), request = f.request(' fixture  \n'), value = prepared(f, journal, request);
  value.before.rows[0].textSha256 = protocol.sha('caller changed'); request.text = 'changed';
  const record = f.readBody().records[0]; assert.equal(record.request.text, ' fixture  \n');
  assert.equal(record.baselineDigest, value.digest); journal.markSending(record.request.requestId, value.digest); close(journal);
});
check('closed baseline schema refuses arbitrary proof fields', () => {
  const f = fixture(), journal = f.start(), request = f.request(), operationId = crypto.randomUUID();
  denied('baseline-unavailable', () => journal.prepare(request, operationId, { ...baseline(request, operationId), arbitraryDraft: 'fixture' }));
  assert.equal(journal.lookup(request), null); close(journal);
});
check('closed observation schema refuses coercible objects in scalar fields', () => {
  const f = fixture(), journal = f.start(), request = f.request(), operationId = crypto.randomUUID();
  const value = baseline(request, operationId); value.version = { toString: () => '1.2.3.4' };
  denied('baseline-unavailable', () => journal.prepare(request, operationId, value));
  assert.equal(journal.lookup(request), null); close(journal);
});
check('single operation ID cannot own two independent requests', () => {
  const f = fixture(), journal = f.start(), first = prepared(f, journal); journal.markFailedBeforeSend(first.request.requestId, 'draft-present');
  const second = f.request(); denied('operation-id-conflict', () => journal.prepare(second, first.operationId, baseline(second, first.operationId))); close(journal);
});
check('sending requires exact committed baseline and cannot become a false failure', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal);
  denied('invalid-transition', () => journal.markSending(value.request.requestId, protocol.sha('wrong')));
  journal.markSending(value.request.requestId, value.digest);
  denied('invalid-transition', () => journal.markFailedBeforeSend(value.request.requestId, 'draft-present'));
  journal.markUnknown(value.request.requestId, 'native-timeout'); close(journal);
});
check('unattempted unknown cannot acquire acceptance from a matching desktop row', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal); journal.markUnknown(value.request.requestId, 'native-timeout');
  denied('invalid-transition', () => journal.accept(value.request.requestId, after(value.before, value.request))); close(journal);
});
check('accepted receipt reports display only without text key or execution claims', () => {
  const f = fixture(), journal = f.start(), value = accepted(f, journal);
  assert.equal(value.receipt.shownInDesktopConversation, true); assert.equal(value.receipt.submitted, true);
  assert.equal(value.receipt.serverAcknowledged, false); assert.equal(value.receipt.executionConfirmed, false);
  assert(!Object.hasOwn(value.receipt, 'text')); assert(!Object.hasOwn(value.receipt, 'proof'));
  assert.deepEqual(journal.accept(value.request.requestId, value.after), value.receipt); close(journal);
  const restarted = f.make(); assert.equal(restarted.lookup(value.request).state, 'accepted'); close(restarted);
});
check('old rows extra user actions wrong binding and changed context cannot prove delivery', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal); journal.markSending(value.request.requestId, value.digest);
  const variants = [value.before, { ...after(value.before, value.request), requestId: crypto.randomUUID() },
    { ...after(value.before, value.request), operationId: crypto.randomUUID() },
    { ...after(value.before, value.request), windowHandle: '2' }];
  const extraUser = after(value.before, value.request); extraUser.rows.push(row('user', 'different fixture')); extraUser.materializedRowCount++;
  variants.push(extraUser);
  for (const invalid of variants) denied('delivery-proof-unavailable', () => journal.accept(value.request.requestId, invalid));
  assert.equal(journal.lookup(value.request).state, 'sending'); close(journal);
});
check('one native row cannot be reserved by another same-text request', () => {
  const f = fixture(), journal = f.start(), first = accepted(f, journal);
  const next = f.request(first.request.text, first.request.threadId), operationId = crypto.randomUUID();
  const before = baseline(next, operationId, first.before.rows), nextAfter = after(before, next, first.after.rows[first.before.rows.length].observationId);
  journal.prepare(next, operationId, before); journal.markSending(next.requestId, protocol.baselineDigest(before));
  denied('delivery-proof-reused', () => journal.accept(next.requestId, nextAfter)); close(journal);
});
check('load revalidates full accepted observation and its recomputed proof', () => {
  const f = fixture(), journal = f.start(); accepted(f, journal); close(journal);
  const body = f.readBody(); body.records[0].proof.observationId = protocol.sha('forged fixture'); f.writeBody(body);
  denied('journal-unavailable', () => f.make());
});
check('load rejects a journal-wide duplicate proof reservation', () => {
  const f = fixture(), journal = f.start(), first = accepted(f, journal); close(journal);
  const body = f.readBody(), second = JSON.parse(JSON.stringify(body.records[0]));
  second.request.requestId = crypto.randomUUID(); second.operationId = crypto.randomUUID();
  for (const value of [second.baseline, second.afterObservation]) { value.requestId = second.request.requestId; value.operationId = second.operationId; }
  second.baselineDigest = protocol.baselineDigest(second.baseline);
  second.proof = protocol.verifyFreshDesktopRow(second.baseline, second.afterObservation, second.request, second.operationId);
  assert(second.proof); body.records.push(second); f.writeBody(body); denied('journal-unavailable', () => f.make());
});
check('authenticated malformed record schemas still fail closed on load', () => {
  const f = fixture(), journal = f.start(); prepared(f, journal); close(journal);
  const body = f.readBody(); body.records[0].unexpected = 'fixture'; f.writeBody(body); denied('journal-unavailable', () => f.make());
});
check('ciphertext tamper and wrong private key fail closed on restart', () => {
  const tampered = fixture(), first = tampered.start(); prepared(tampered, first); close(first);
  const envelope = JSON.parse(fs.readFileSync(tampered.file, 'utf8')), bytes = Buffer.from(envelope.data, 'base64'); bytes[0] ^= 1;
  envelope.data = bytes.toString('base64'); fs.writeFileSync(tampered.file, JSON.stringify(envelope)); denied('journal-unavailable', () => tampered.make());
  const wrong = fixture(), second = wrong.start(); close(second); wrong.setMaterial(crypto.randomBytes(32)); denied('journal-unavailable', () => wrong.make());
});
check('capacity preserves accepted and failed ID fences without eviction', () => {
  const f = fixture(2), journal = f.start(), first = accepted(f, journal), second = prepared(f, journal);
  journal.markFailedBeforeSend(second.request.requestId, 'draft-present');
  const third = f.request(), operationId = crypto.randomUUID(); denied('journal-capacity', () => journal.prepare(third, operationId, baseline(third, operationId)));
  assert.equal(journal.lookup(first.request).state, 'accepted'); assert.equal(journal.lookup(second.request).state, 'failed'); close(journal);
});
check('capacity configuration rejects fractional zero or coerced values', () => {
  for (const maximumRecords of [0, 1.5, '2', NaN, 257]) {
    const f = fixture(maximumRecords); denied('journal-options-invalid', () => f.start()); assert(!fs.existsSync(f.file));
  }
});
check('backward wall clock cannot invalidate an already committed record', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal), originalNow = Date.now;
  try { Date.now = () => 1; journal.markSending(value.request.requestId, value.digest); }
  finally { Date.now = originalNow; }
  assert.equal(journal.lookup(value.request).state, 'sending'); close(journal);
});
check('ACK gates require one registered helper exact stage and committed digest', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal), child = { pid: 1001, creationTicks: '101' };
  denied('child-registration-required', () => journal.assertReadyForAck('paste', value.request.requestId, value.digest));
  journal.registerChild(child); assert.equal(journal.assertReadyForAck('paste', value.request.requestId, value.digest), true);
  denied('invalid-transition', () => journal.assertReadyForAck('invoke', value.request.requestId, value.digest));
  denied('invalid-transition', () => journal.assertReadyForAck('paste', value.request.requestId, protocol.sha('wrong')));
  journal.markSending(value.request.requestId, value.digest); assert.equal(journal.assertReadyForAck('invoke', value.request.requestId, value.digest), true);
  journal.unregisterChild(child, true); close(journal);
});
check('release is blocked until matching child birth identity has actual CLOSE', () => {
  const f = fixture(), journal = f.start(), child = { pid: 1002, creationTicks: '102' }; journal.registerChild(child);
  denied('children-not-closed', () => journal.close({ allChildrenClosed: false }));
  denied('children-not-closed', () => close(journal)); denied('child-not-closed', () => journal.unregisterChild(child, false));
  denied('child-identity-conflict', () => journal.unregisterChild({ ...child, creationTicks: '103' }, true));
  assert.equal(journal.status().available, true); journal.unregisterChild(child, true); close(journal);
});
check('every mutation and ACK refuses deleted journal or changed provider continuity', () => {
  for (const mutate of [f => fs.unlinkSync(f.file), f => f.setMarker({ ...f.marker(), provisioned: false }),
    f => f.setMarker({ ...f.marker(), keyIdentity: crypto.randomBytes(32).toString('hex') }), f => f.setMaterial(crypto.randomBytes(32))]) {
    const f = fixture(), journal = f.start(), value = prepared(f, journal); journal.registerChild({ pid: 1003, creationTicks: '103' }); mutate(f);
    denied('journal-unavailable', () => journal.assertReadyForAck('paste', value.request.requestId, value.digest));
    denied('journal-unavailable', () => journal.markSending(value.request.requestId, value.digest)); assert.equal(journal.status().available, false);
  }
});
check('both Send ACK stages refuse encrypted file changes after load', () => {
  for (const sending of [false, true]) {
    const f = fixture(), journal = f.start(), value = prepared(f, journal); journal.registerChild({ pid: 1004, creationTicks: '104' });
    if (sending) journal.markSending(value.request.requestId, value.digest);
    const body = f.readBody(); body.revision++; f.writeBody(body);
    denied('journal-unavailable', () => journal.assertReadyForAck(sending ? 'invoke' : 'paste', value.request.requestId, value.digest));
  }
});
check('journal replacement failure grants no committed preparation or ACK authority', () => {
  const f = fixture(); let fail = false;
  const create = _testOnly.withFileSystem({ ...fs, renameSync(source, target) {
    if (fail && target === f.file) throw new Error('fixture-rename-failure'); return fs.renameSync(source, target);
  } });
  const journal = create({ ...f.options, provision: true }), prior = fs.readFileSync(f.file); fail = true;
  const request = f.request(), operationId = crypto.randomUUID(); denied('journal-unavailable', () => journal.prepare(request, operationId, baseline(request, operationId)));
  assert.deepEqual(fs.readFileSync(f.file), prior); denied('journal-unavailable', () => journal.assertReadyForAck('paste', request.requestId, 'invalid'));
  assert.equal(journal.status().available, false); close(journal);
});
check('irreversible continuity failure zeros the derived key without closing or deleting child and owner evidence', () => {
  const f = fixture(), { journal, key } = captureEngineKey(() => f.start()), value = prepared(f, journal);
  const child = { pid: 1101, creationTicks: '1101' }; journal.registerChild(child);
  const ownerPath = path.join(f.file + '.owner-lock', 'owner.json'), ownerBefore = fs.readFileSync(ownerPath), ciphertextBefore = fs.readFileSync(f.file);
  f.setMarker({ ...f.marker(), provisioned: false });
  denied('journal-unavailable', () => journal.assertReadyForAck('paste', value.request.requestId, value.digest));
  assert(key.every(byte => byte === 0)); assert.equal(journal.status().available, false);
  assert.deepEqual(fs.readFileSync(ownerPath), ownerBefore); assert.deepEqual(fs.readFileSync(f.file), ciphertextBefore);
  assert.equal(JSON.parse(ownerBefore).children.length, 1); denied('children-not-closed', () => close(journal));
  denied('owner-locked', () => f.make()); denied('child-not-closed', () => journal.unregisterChild(child, false));
  // Even restoring the marker cannot resurrect the burned, latched engine.
  f.setMarker({ ...f.marker(), provisioned: true }); denied('journal-unavailable', () => journal.lookup(value.request));
  assert(key.every(byte => byte === 0)); journal.unregisterChild(child, true); close(journal);
});
check('failed encrypted commit zeros the derived key while retaining exact prior requests and ownership', () => {
  const f = fixture(); let fail = false;
  const create = _testOnly.withFileSystem({ ...fs, renameSync(source, target) {
    if (fail && target === f.file) throw new Error('fixture-key-disposal-write-failure'); return fs.renameSync(source, target);
  } });
  const { journal, key } = captureEngineKey(() => create({ ...f.options, provision: true }));
  const value = prepared(f, journal), child = { pid: 1102, creationTicks: '1102' }; journal.registerChild(child);
  const ownerPath = path.join(f.file + '.owner-lock', 'owner.json'), ownerBefore = fs.readFileSync(ownerPath), ciphertextBefore = fs.readFileSync(f.file);
  fail = true; denied('journal-unavailable', () => journal.markSending(value.request.requestId, value.digest));
  assert(key.every(byte => byte === 0)); assert.equal(journal.status().available, false);
  assert.deepEqual(fs.readFileSync(ownerPath), ownerBefore); assert.deepEqual(fs.readFileSync(f.file), ciphertextBefore);
  denied('children-not-closed', () => close(journal)); denied('owner-locked', () => f.make());
  fail = false; denied('journal-unavailable', () => journal.lookup(value.request));
  journal.unregisterChild(child, true); close(journal);
});
check('child identity persistence failure blocks ACK and preserves writer ownership', () => {
  const f = fixture(); let fail = false;
  const create = _testOnly.withFileSystem({ ...fs, renameSync(source, target) {
    if (fail && path.basename(target) === 'owner.json') throw new Error('fixture-child-record-failure');
    return fs.renameSync(source, target);
  } });
  const journal = create({ ...f.options, provision: true }), value = prepared(f, journal); fail = true;
  denied('owner-unavailable', () => journal.registerChild({ pid: 1006, creationTicks: '106' }));
  denied('journal-unavailable', () => journal.assertReadyForAck('paste', value.request.requestId, value.digest));
  denied('owner-locked', () => f.make()); assert.equal(journal.status().available, false);
});
check('second parent cannot load recover or provision the owned journal', () => {
  const f = fixture(), journal = f.start(); prepared(f, journal); const prior = fs.readFileSync(f.file);
  denied('owner-locked', () => f.make()); assert.deepEqual(fs.readFileSync(f.file), prior); close(journal);
});
check('absent corrupt or partial owner manifests never permit takeover', () => {
  for (const value of [null, '{broken', '{}']) {
    const f = fixture(), journal = f.start(); close(journal); const directory = f.file + '.owner-lock'; fs.mkdirSync(directory);
    if (value !== null) fs.writeFileSync(path.join(directory, 'owner.json'), value);
    denied('owner-unavailable', () => f.make());
  }
});
check('a live or uncertain original owner with registered child is never reclaimed', () => {
  const f = fixture(), journal = f.start(); journal.registerChild({ pid: 1005, creationTicks: '105' });
  const file = path.join(f.file + '.owner-lock', 'owner.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.parentPid = 2147483647; fs.writeFileSync(file, JSON.stringify(manifest)); denied('owner-locked', () => f.make());
});
check('unavailable factory objects are rejected before releasing any writer boundary', () => {
  const f = fixture(), journal = f.start(); close(journal);
  const owner = acquireJournalOwner({ journalFile: f.file, keyProvider: f.provider, parentIdentityProvider: f.options.parentIdentityProvider });
  denied('journal-unavailable', () => owner.openJournal(() => ({ status: () => ({ available: false }), close() {} })));
  denied('owner-unavailable', () => owner.release({ allChildrenClosed: true }));
});
check('target-bound receipts and closed journals never reveal or recover private records', () => {
  const f = fixture(), journal = f.start(), value = prepared(f, journal);
  denied('target-mismatch', () => journal.receipt(value.request.requestId, crypto.randomUUID()));
  denied('invalid-request', () => journal.lookup({ ...value.request, requestId: { toString: () => value.request.requestId } }));
  close(journal); denied('journal-unavailable', () => journal.lookup(value.request)); assert.equal(journal.status().available, false);
});
check('valid stale ciphertext rollback after restart is an explicit remaining limitation', () => {
  const f = fixture(), first = f.start(), older = fs.readFileSync(f.file), value = prepared(f, first);
  first.markFailedBeforeSend(value.request.requestId, 'draft-present'); close(first); fs.writeFileSync(f.file, older);
  const restarted = f.make(); assert.equal(restarted.lookup(value.request), null); close(restarted);
});
fs.writeFileSync(path.join(base, 'RESULT.json'), JSON.stringify({ nativeActions: false, productionKeys: false,
  passed: results.length, results, limitations: ['No crash reclaim', 'Valid stale ciphertext rollback after restart remains undetected',
    'Windows directory power-loss durability and ACLs need separate validation'] }, null, 2));
console.log(JSON.stringify({ nativeActions: false, productionKeys: false, passed: results.length }));
