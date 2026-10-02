'use strict';
// Native-free persistence/lifecycle fixtures. The injected protection and ACL
// adapter proves contracts, NOT Windows DPAPI, OS ACLs, or actual helper CLOSE.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createDotDesktopPrivateStore, _testOnly } = require('./dot-desktop-private-store.js');
const isolated = process.env.DOT_PRIVATE_STORE_TEST_DIRECTORY || path.join(__dirname, '..', 'logs', 'isolated-tests');
fs.mkdirSync(isolated, { recursive: true });
const evidence = fs.mkdtempSync(path.join(isolated, 'dot-private-store-'));
let passed = 0;
const denied = (code, run) => assert.throws(run, cause => cause?.code === code);
const refused = async (code, operation) => assert.rejects(operation, cause => cause?.code === code);
async function check(name, run) { await run(); passed++; console.log('PASS ' + name); }
function fixture() {
  const base = path.join(evidence, crypto.randomUUID()); fs.mkdirSync(base);
  const protectionKey = crypto.randomBytes(32), privatePaths = new Set(), calls = [];
  const adapter = {
    protect(bytes) {
      calls.push('protect'); const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', protectionKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    unprotect(bytes) {
      if (bytes.length < 29) throw Error('fixture-ciphertext-invalid');
      calls.push('unprotect'); const decipher = crypto.createDecipheriv('aes-256-gcm', protectionKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
    secureNewPath(file, directory) {
      calls.push('secure-' + (directory ? 'directory' : 'file')); privatePaths.add(file);
      // Atomic rename preserves a file's real ACL. This fixture adapter models
      // that using the exact logical final path, not a real ACL assertion.
      if (file.endsWith('.tmp')) privatePaths.add(file.replace(/\.[0-9a-f]{24}\.tmp$/, ''));
    },
    assertPrivatePath(file) { calls.push('check'); if (!privatePaths.has(file)) throw Error('fixture-acl-unavailable'); }
  };
  const identity = () => ({ pid: process.pid, creationTicks: '100000000000000001' });
  let lastPair;
  function enableBatch() {
    adapter.readProtectedPair = context => {
      calls.push('read-pair');
      adapter.assertPrivatePath(context.directory, true); adapter.assertPrivatePath(context.anchorFile, false);
      adapter.assertPrivatePath(context.stateFile, false);
      lastPair = { anchor: adapter.unprotect(fs.readFileSync(context.anchorFile)), state: adapter.unprotect(fs.readFileSync(context.stateFile)) };
      return lastPair;
    };
  }
  const make = overrides => createDotDesktopPrivateStore({ base, protectedStore: adapter, parentIdentityProvider: identity, ...overrides });
  const open = () => { const store = make(), journal = store.createJournal(); return { store, journal }; };
  function read(file) { const bytes = adapter.unprotect(fs.readFileSync(file)); try { return JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); } }
  function write(file, body) { const bytes = Buffer.from(JSON.stringify(body)); try { fs.writeFileSync(file, adapter.protect(bytes)); } finally { bytes.fill(0); } }
  return { base, adapter, privatePaths, calls, make, open, read, write, enableBatch, lastPair: () => lastPair };
}
const close = journal => journal.close({ allChildrenClosed: true });

(async () => {
  await check('exclusive first provisioning stores an independent protected key and fixed identities', () => {
    const f = fixture(), store = f.make(), marker = store.keyProvider.readContinuityMarker();
    assert.equal(marker.provisioned, false); assert(!fs.existsSync(store.paths.journalFile));
    assert.equal(Object.keys(marker).length, 4); assert.equal(marker.journalIdentity.length, 64);
    const context = { journalIdentity: marker.journalIdentity, keyIdentity: marker.keyIdentity };
    denied('private-store-provisioning-conflict', () => store.keyProvider.commitProvisionedMarker({ ...marker, provisioned: true }));
    const first = store.keyProvider.readJournalKey(context), second = store.keyProvider.readJournalKey(context);
    assert.equal(first.length, 32); assert.deepEqual(first, second); assert.notEqual(first, second);
    assert(!fs.readFileSync(store.paths.stateFile).includes(Buffer.from(first.toString('base64'))));
    first.fill(0); second.fill(0);
    denied('private-store-continuity-unavailable', () => store.keyProvider.readJournalKey({ ...context, keyIdentity: '0'.repeat(64) }));
    const journal = store.createJournal(); assert.equal(journal.status().available, true);
    assert.equal(store.keyProvider.readContinuityMarker().provisioned, true);
    denied('private-store-provisioning-conflict', () => store.keyProvider.commitProvisionedMarker({ ...marker, provisioned: true }));
    denied('private-store-journal-unavailable', () => store.createJournal()); close(journal);
    const reopened = f.make(), again = reopened.createJournal();
    assert.deepEqual(reopened.keyProvider.readContinuityMarker(), { ...marker, provisioned: true }); close(again);
  });
  await check('a second owner cannot open or replace the same receipt journal', () => {
    const f = fixture(), { store, journal } = f.open();
    const before = fs.readFileSync(store.paths.journalFile);
    denied('owner-locked', () => f.make().createJournal());
    assert.deepEqual(fs.readFileSync(store.paths.journalFile), before); close(journal);
  });
  await check('old unprovisioned state never completes provisioning on restart', () => {
    const f = fixture(), store = f.make();
    denied('private-store-continuity-unavailable', () => f.make().createJournal());
    assert(!fs.existsSync(store.paths.journalFile)); assert.equal(store.keyProvider.readContinuityMarker().provisioned, false);
  });
  for (const part of ['stateFile', 'anchorFile']) await check('missing ' + part + ' refuses restart without generating replacement identities', () => {
    const f = fixture(), { store, journal } = f.open(); close(journal);
    fs.unlinkSync(store.paths[part]); const retained = fs.readFileSync(store.paths.journalFile);
    denied('private-store-continuity-unavailable', () => f.make());
    assert(!fs.existsSync(store.paths[part])); assert.deepEqual(fs.readFileSync(store.paths.journalFile), retained);
  });
  await check('missing provisioned journal remains blocked with ownership evidence retained', () => {
    const f = fixture(), { store, journal } = f.open(); close(journal); fs.unlinkSync(store.paths.journalFile);
    denied('journal-missing', () => f.make().createJournal());
    assert.equal(store.keyProvider.readContinuityMarker().provisioned, true);
    assert(fs.existsSync(store.paths.journalFile + '.owner-lock')); assert(!fs.existsSync(store.paths.journalFile));
  });
  await check('corrupt protected metadata, extra keys and mismatched key material fail closed', () => {
    for (const mutate of [
      (f, store) => fs.writeFileSync(store.paths.stateFile, 'broken-fixture-ciphertext'),
      (f, store) => f.write(store.paths.stateFile, { ...f.read(store.paths.stateFile), extra: true }),
      (f, store) => f.write(store.paths.stateFile, { ...f.read(store.paths.stateFile), material: crypto.randomBytes(32).toString('base64') })
    ]) {
      const f = fixture(), { store, journal } = f.open(); close(journal); const before = fs.readFileSync(store.paths.journalFile);
      mutate(f, store); denied('private-store-continuity-unavailable', () => f.make());
      assert.deepEqual(fs.readFileSync(store.paths.journalFile), before);
    }
  });
  await check('live provider continuity loss disables reads and does not recover automatically', () => {
    const f = fixture(), { store, journal } = f.open(); const original = fs.readFileSync(store.paths.stateFile);
    fs.writeFileSync(store.paths.stateFile, 'corrupt'); assert.equal(journal.status().available, false);
    fs.writeFileSync(store.paths.stateFile, original); assert.equal(journal.status().available, false);
    denied('private-store-unavailable', () => store.keyProvider.readContinuityMarker());
    close(journal);
  });
  await check('an unverified ACL prevents protected metadata decryption', () => {
    const f = fixture(), { store, journal } = f.open(); close(journal);
    f.privatePaths.delete(store.paths.directory); const count = f.calls.filter(value => value === 'unprotect').length;
    assert.throws(() => f.make()); assert.equal(f.calls.filter(value => value === 'unprotect').length, count);
  });
  await check('parent PID and birth are validated before journal ownership', () => {
    for (const identity of [() => ({ pid: process.pid + 1, creationTicks: '100' }),
      () => ({ pid: process.pid, creationTicks: '0' }), () => ({ pid: process.pid, creationTicks: '100', extra: true })]) {
      const f = fixture(), store = f.make({ parentIdentityProvider: identity });
      denied('parent-identity-unavailable', () => store.createJournal());
      assert(!fs.existsSync(store.paths.journalFile + '.owner-lock'));
    }
  });
  await check('batched native observation retains closed continuity/key checks and clears both plaintext buffers', () => {
    const f = fixture(); f.enableBatch(); const { store, journal } = f.open();
    const before = f.calls.filter(value => value === 'read-pair').length;
    assert.equal(journal.status().available, true);
    assert.equal(f.calls.filter(value => value === 'read-pair').length - before, 0,
      'unchanged marker/key still receive fresh byte and metadata checks without native launches');
    for (const bytes of Object.values(f.lastPair())) assert(bytes.every(value => value === 0));
    f.write(store.paths.stateFile, { ...f.read(store.paths.stateFile), material: crypto.randomBytes(32).toString('base64') });
    assert.equal(journal.status().available, false); close(journal);
  });
  await check('unchanged ciphertext with changed file identity or metadata requires fresh native verification', () => {
    const f = fixture(); f.enableBatch(); const { store, journal } = f.open();
    const before = f.calls.filter(value => value === 'read-pair').length;
    const replacement = store.paths.stateFile + '.fixture-replacement';
    fs.writeFileSync(replacement, fs.readFileSync(store.paths.stateFile)); fs.renameSync(replacement, store.paths.stateFile);
    assert.equal(journal.status().available, true);
    assert.equal(f.calls.filter(value => value === 'read-pair').length - before, 1);
    const count = f.calls.filter(value => value === 'read-pair').length;
    const changed = new Date(Date.now() + 10000); fs.utimesSync(store.paths.stateFile, changed, changed);
    assert.equal(journal.status().available, true);
    assert.equal(f.calls.filter(value => value === 'read-pair').length - count, 1); close(journal);
  });
  await check('cached state never bypasses changed ACL metadata or concurrent proof mutations', () => {
    const f = fixture(); f.enableBatch(); const { store, journal } = f.open();
    f.privatePaths.delete(store.paths.stateFile); const changed = new Date(Date.now() + 20000);
    fs.utimesSync(store.paths.stateFile, changed, changed);
    const count = f.calls.filter(value => value === 'unprotect').length;
    assert.equal(journal.status().available, false);
    assert.equal(f.calls.filter(value => value === 'unprotect').length, count); close(journal);
    const other = fixture(); other.enableBatch(); const active = other.open(), original = other.adapter.readProtectedPair;
    other.adapter.readProtectedPair = context => { const pair = original(context);
      fs.writeFileSync(context.stateFile, other.adapter.protect(Buffer.from('{"changed":true}'))); return pair; };
    fs.utimesSync(active.store.paths.stateFile, changed, changed);
    assert.equal(active.journal.status().available, false);
    for (const bytes of Object.values(other.lastPair())) assert(bytes.every(value => value === 0)); close(active.journal);
  });
  await check('batched read refuses ACL loss before decrypting and malformed observations without fallback', () => {
    const f = fixture(); f.enableBatch(); const { store, journal } = f.open(); close(journal);
    f.privatePaths.delete(store.paths.stateFile); const count = f.calls.filter(value => value === 'unprotect').length;
    denied('private-store-continuity-unavailable', () => f.make());
    assert.equal(f.calls.filter(value => value === 'unprotect').length, count);
    f.privatePaths.add(store.paths.stateFile);
    f.adapter.readProtectedPair = () => ({ anchor: Buffer.from('{}'), state: Buffer.from('{}'), extra: true });
    denied('private-store-continuity-unavailable', () => f.make());
  });
  await check('shutdown stops admission, waits for the owned-close drain, then releases the journal', async () => {
    const f = fixture(), { store, journal } = f.open(), order = []; let release;
    const drain = new Promise(resolve => { release = resolve; });
    const options = { service: { close() { order.push('close'); close(journal); } },
      stopNewSends() { order.push('stop'); return { stopped: true }; },
      drainOwnedActions() { order.push('drain'); return drain; }, timeoutMs: 1000 };
    const pending = store.shutdown(options); assert.equal(store.shutdown(options), pending);
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['stop', 'drain']);
    assert(fs.existsSync(store.paths.journalFile + '.owner-lock'));
    denied('private-store-journal-unavailable', () => store.createJournal());
    release({ allOwnedChildrenClosed: true }); assert.deepEqual(await pending, { closed: true });
    assert.deepEqual(order, ['stop', 'drain', 'close']); assert(!fs.existsSync(store.paths.journalFile + '.owner-lock'));
    denied('private-store-unavailable', () => store.keyProvider.readContinuityMarker());
  });
  await check('unconfirmed or timed-out shutdown never calls close or releases ownership', async () => {
    const f = fixture(), { store, journal } = f.open(); let closes = 0;
    const options = { service: { close() { closes++; close(journal); } }, stopNewSends: () => ({ stopped: true }),
      drainOwnedActions: () => ({ allOwnedChildrenClosed: false }), timeoutMs: 10 };
    await refused('private-store-shutdown-unconfirmed', store.shutdown(options));
    await refused('private-store-shutdown-timeout', store.shutdown({ ...options, drainOwnedActions: () => new Promise(() => {}) }));
    assert.equal(closes, 0); assert(fs.existsSync(store.paths.journalFile + '.owner-lock'));
    await store.shutdown({ ...options, drainOwnedActions: () => ({ allOwnedChildrenClosed: true }) }); assert.equal(closes, 1);
  });
  await check('journal child registration independently refuses a dishonest empty drain', async () => {
    const f = fixture(), { store, journal } = f.open(), helper = { pid: process.pid + 101, creationTicks: '100' };
    journal.registerChild(helper);
    const options = { service: { close() { close(journal); } }, stopNewSends: () => ({ stopped: true }),
      drainOwnedActions: () => ({ allOwnedChildrenClosed: true }), timeoutMs: 100 };
    await refused('children-not-closed', store.shutdown(options));
    assert(fs.existsSync(store.paths.journalFile + '.owner-lock'));
    journal.unregisterChild(helper, true); await store.shutdown(options);
  });
  await check('idempotent secret disposal disables use without closing children or changing persistence', () => {
    const f = fixture(); f.enableBatch(); const { store, journal } = f.open();
    const helper = { pid: process.pid + 202, creationTicks: '200' }; journal.registerChild(helper);
    const files = [store.paths.stateFile, store.paths.anchorFile, store.paths.journalFile,
      path.join(store.paths.journalFile + '.owner-lock', 'owner.json')];
    const before = files.map(file => fs.readFileSync(file));
    assert.deepEqual(store.discardSecrets(), { discarded: true }); assert.deepEqual(store.discardSecrets(), { discarded: true });
    denied('private-store-unavailable', () => store.keyProvider.readContinuityMarker());
    denied('private-store-journal-unavailable', () => store.createJournal());
    assert.equal(journal.status().available, false);
    for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(files[i]), before[i]);
    denied('children-not-closed', () => close(journal));
    journal.unregisterChild(helper, true); close(journal);
  });
  await check('Windows adapter uses constant code, stdin data and scoped hidden processes (stub only)', () => {
    const temporary = path.join(evidence, 'stub-temp'), calls = [];
    const adapter = _testOnly.createWindowsAdapter(temporary, { platform: 'win32', execFileSync(executable, args, options) {
      calls.push({ executable, args, options }); const input = JSON.parse(options.input);
      if (input.operation === 'parent') return JSON.stringify({ pid: process.pid, creationTicks: '100' });
      if (input.operation === 'read-pair') return JSON.stringify({ anchor: Buffer.from('{"fixture":"anchor"}').toString('base64'),
        state: Buffer.from('{"fixture":"state"}').toString('base64') });
      if (input.operation === 'write-protected') return JSON.stringify({ verifiedSha256: crypto.createHash('sha256')
        .update(Buffer.from(input.data, 'base64')).digest('hex') });
      if (['protect', 'unprotect'].includes(input.operation)) return JSON.stringify({ data: input.data });
      return '{"ok":true}';
    } });
    adapter.secureNewPath(path.join(evidence, "中文-literal-$()-'path"), true); adapter.assertPrivatePath(evidence, true);
    assert.deepEqual(adapter.unprotect(adapter.protect(Buffer.from('synthetic fixture'))), Buffer.from('synthetic fixture'));
    assert.deepEqual(adapter.parentIdentity(), { pid: process.pid, creationTicks: '100' });
    const count = calls.length, pair = adapter.readProtectedPair({ directory: evidence, anchorFile: '中文-anchor', stateFile: '中文-state' });
    assert.equal(calls.length, count + 1); assert.equal(pair.anchor.toString(), '{"fixture":"anchor"}');
    assert.equal(pair.state.toString(), '{"fixture":"state"}'); pair.anchor.fill(0); pair.state.fill(0);
    const writeCount = calls.length;
    adapter.writeProtectedFile({ directory: evidence, file: '中文-state.dpapi', mustBeAbsent: true }, Buffer.from('fixture-state'));
    assert.equal(calls.length, writeCount + 1);
    for (const call of calls) { assert.equal(call.args.at(-1), _testOnly.WINDOWS_PROGRAM);
      assert.equal(call.options.windowsHide, true); assert.equal(call.options.env.TEMP, temporary); assert.equal(call.options.env.TMP, temporary);
      assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
      assert(!call.options.env.OPENAI_API_KEY); assert(!call.options.env.ACCESS_TOKEN); }
    denied('private-store-platform-unavailable', () => _testOnly.createWindowsAdapter(temporary, { platform: 'linux' }));
    assert(_testOnly.WINDOWS_PROGRAM.indexOf('[Console]::InputEncoding=$utf8') < _testOnly.WINDOWS_PROGRAM.indexOf('[Console]::In.ReadToEnd()'));
    assert(_testOnly.WINDOWS_PROGRAM.includes('[Console]::OutputEncoding=$utf8'));
    assert(!_testOnly.WINDOWS_PROGRAM.includes('.SetOwner('), 'the ACL operation must never request an owner write');
    assert(!_testOnly.WINDOWS_PROGRAM.includes('[IO.File]::Replace('), 'atomic replacement must not merge destination security');
    assert(_testOnly.WINDOWS_PROGRAM.includes('MoveFileEx($pending,$target,$flags)'));
    assert(_testOnly.WINDOWS_PROGRAM.includes('$ownerAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value'));
    assert(_testOnly.WINDOWS_PROGRAM.includes('$acl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)'));
    const failing = _testOnly.createWindowsAdapter(temporary, { platform: 'win32', execFileSync(_file, _args, options) {
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']); throw Error('PRIVATE_SYNTHETIC_STDERR');
    } });
    assert.throws(() => failing.protect(Buffer.from('PRIVATE_SYNTHETIC_MATERIAL')),
      cause => cause.code === 'private-store-unavailable' && !cause.message.includes('PRIVATE'));
  });
  console.log(`Passed ${passed} native-free private-store checks. Windows DPAPI/ACL and physical child CLOSE were not run.`);
})().catch(cause => { console.error(cause?.stack || cause); process.exitCode = 1; });
