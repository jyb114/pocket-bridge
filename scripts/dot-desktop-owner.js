'use strict';
// Parent-owned boundary for the independent Dot journal. This grants no Send
// capability: its callers must retain the separately reviewed native gate.
// No UI, native helper, PID probing, lock takeover, or automatic stale recovery.
// The trusted private key provider owns marker storage, key selection, and ACLs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HASH = /^[0-9a-f]{64}$/;
const TICKS = /^[1-9]\d{0,19}$/;
const error = code => Object.assign(new Error(code), { code });
const ownKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equalToken = (first, second) => HASH.test(first || '') && HASH.test(second || '') &&
  crypto.timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));

function implementation(fileSystem) {
  function readSmallJson(file) {
    let descriptor;
    try {
      const link = fileSystem.lstatSync(file);
      if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) throw error('owner-unavailable');
      descriptor = fileSystem.openSync(file, 'r');
      const stat = fileSystem.fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 2 || stat.size > 4096) throw error('owner-unavailable');
      const raw = fileSystem.readFileSync(descriptor);
      if (raw.length !== stat.size || raw.length > 4096) throw error('owner-unavailable');
      return JSON.parse(raw.toString('utf8'));
    } catch (_) { throw error('owner-unavailable'); }
    finally { if (descriptor !== undefined) fileSystem.closeSync(descriptor); }
  }
  function marker(provider) {
    let value;
    try { value = provider.readContinuityMarker(); } catch (_) { throw error('continuity-unavailable'); }
    if (!ownKeys(value, ['version', 'journalIdentity', 'keyIdentity', 'provisioned']) || value.version !== 1 ||
        typeof value.journalIdentity !== 'string' || !HASH.test(value.journalIdentity) ||
        typeof value.keyIdentity !== 'string' || !HASH.test(value.keyIdentity) ||
        typeof value.provisioned !== 'boolean') throw error('continuity-unavailable');
    return { ...value };
  }
  function journalExists(file) {
    try {
      const stat = fileSystem.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1) throw error('continuity-unavailable');
      return true;
    } catch (cause) {
      if (cause.code === 'ENOENT') return false;
      throw error('continuity-unavailable');
    }
  }
  function acquireJournalOwner(options) {
    if (!ownKeys(options, ['journalFile', 'keyProvider', 'parentIdentityProvider']) || typeof options.journalFile !== 'string' ||
        !path.isAbsolute(options.journalFile) || !options.keyProvider ||
        typeof options.keyProvider.readContinuityMarker !== 'function' ||
        typeof options.parentIdentityProvider !== 'function') throw error('owner-options-invalid');
    const provider = options.keyProvider;
    const initialMarker = marker(provider);
    let parentIdentity;
    try { parentIdentity = options.parentIdentityProvider(); }
    catch (_) { throw error('parent-identity-unavailable'); }
    if (!ownKeys(parentIdentity, ['pid', 'creationTicks']) || parentIdentity.pid !== process.pid ||
        typeof parentIdentity.creationTicks !== 'string' || !TICKS.test(parentIdentity.creationTicks))
      throw error('parent-identity-unavailable');
    let file;
    try {
      // A configured parent directory must already exist. Resolve aliases before
      // deriving the ONE fixed lock directory used by every owner of this file.
      const supplied = path.resolve(options.journalFile);
      file = path.join(fileSystem.realpathSync(path.dirname(supplied)), path.basename(supplied));
    } catch (_) { throw error('owner-unavailable'); }
    const lockDirectory = file + '.owner-lock';
    const manifestFile = path.join(lockDirectory, 'owner.json');
    const continuitySha256 = digest([initialMarker.journalIdentity, initialMarker.keyIdentity]);
    let manifest = { version: 1, token: crypto.randomBytes(32).toString('hex'), parentPid: parentIdentity.pid,
      parentCreationTicks: parentIdentity.creationTicks,
      createdAt: Date.now(), journalPathSha256: digest(file), continuitySha256, children: [] };
    const manifestKeys = Object.keys(manifest);
    function childIdentity(value) {
      return ownKeys(value, ['pid', 'creationTicks']) && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        typeof value.creationTicks === 'string' && TICKS.test(value.creationTicks);
    }
    function childRecords(value) {
      if (!Array.isArray(value) || value.length > 16) return false;
      const pids = new Set();
      return value.every(child => {
        if (!childIdentity(child) || pids.has(child.pid)) return false;
        pids.add(child.pid); return true;
      });
    }
    function validateManifest(value) {
      return ownKeys(value, manifestKeys) && value.version === 1 && typeof value.token === 'string' && HASH.test(value.token) &&
        Number.isSafeInteger(value.parentPid) && value.parentPid > 0 &&
        typeof value.parentCreationTicks === 'string' && TICKS.test(value.parentCreationTicks) &&
        Number.isSafeInteger(value.createdAt) && value.createdAt > 0 &&
        typeof value.journalPathSha256 === 'string' && HASH.test(value.journalPathSha256) &&
        typeof value.continuitySha256 === 'string' && HASH.test(value.continuitySha256) && childRecords(value.children);
    }
    try { fileSystem.mkdirSync(lockDirectory, { mode: 0o700 }); }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw error('owner-unavailable');
      // Even a plausibly dead PID is never permission to steal this lock.
      // A missing/corrupt manifest is never interpreted as stale or first use.
      const existing = readSmallJson(manifestFile);
      if (!validateManifest(existing)) throw error('owner-unavailable');
      throw error('owner-locked');
    }
    let descriptor;
    try {
      descriptor = fileSystem.openSync(manifestFile, 'wx', 0o600);
      fileSystem.writeFileSync(descriptor, JSON.stringify(manifest));
      fileSystem.fsyncSync(descriptor);
    } catch (_) {
      // Keep partial ownership evidence in place. Automatic cleanup could hide
      // a failed ownership write and permit an unsafe competing constructor.
      throw error('owner-unavailable');
    } finally { if (descriptor !== undefined) fileSystem.closeSync(descriptor); }
    let closed = false, unavailable = false, journal = null, opening = false;
    function assertOwned() {
      if (closed || unavailable) throw error('owner-unavailable');
      try {
        const lock = fileSystem.lstatSync(lockDirectory);
        if (!lock.isDirectory() || lock.isSymbolicLink()) throw error('owner-unavailable');
      } catch (_) { unavailable = true; throw error('owner-unavailable'); }
      let current;
      try { current = readSmallJson(manifestFile); }
      catch (_) { unavailable = true; throw error('owner-unavailable'); }
      if (!validateManifest(current) || !equalToken(current.token, manifest.token) ||
          manifestKeys.some(key => !['token', 'children'].includes(key) && current[key] !== manifest[key]) ||
          JSON.stringify(current.children) !== JSON.stringify(manifest.children)) {
        unavailable = true; throw error('owner-unavailable');
      }
      return true;
    }
    function persistChildren(children) {
      assertOwned();
      const next = { ...manifest, children };
      if (!validateManifest(next)) throw error('child-identity-invalid');
      const temporary = path.join(lockDirectory, 'owner-' + crypto.randomBytes(12).toString('hex') + '.tmp');
      let handle;
      try {
        handle = fileSystem.openSync(temporary, 'wx', 0o600);
        fileSystem.writeFileSync(handle, JSON.stringify(next)); fileSystem.fsyncSync(handle);
        fileSystem.closeSync(handle); handle = undefined;
        fileSystem.renameSync(temporary, manifestFile);
        manifest = next;
      } catch (_) { unavailable = true; throw error('owner-unavailable'); }
      finally { if (handle !== undefined) fileSystem.closeSync(handle); }
    }
    function currentMarker() {
      assertOwned();
      const current = marker(provider);
      if (digest([current.journalIdentity, current.keyIdentity]) !== continuitySha256) throw error('continuity-mismatch');
      return current;
    }
    function context(current) {
      return Object.freeze({ file, journalIdentity: current.journalIdentity, keyIdentity: current.keyIdentity });
    }
    return {
      assertOwned,
      assertNoChildren() {
        assertOwned();
        if (manifest.children.length) throw error('children-not-closed');
        return true;
      },
      assertOneChild() {
        assertOwned();
        if (manifest.children.length !== 1) throw error('child-registration-required');
        return true;
      },
      assertJournalContinuity() {
        const current = currentMarker();
        if (!current.provisioned) throw error('journal-provisioning-required');
        if (!journalExists(file)) throw error('journal-missing');
        return true;
      },
      registerChild(value) {
        assertOwned();
        if (!childIdentity(value)) throw error('child-identity-invalid');
        const existing = manifest.children.find(child => child.pid === value.pid);
        if (existing) {
          if (existing.creationTicks !== value.creationTicks) throw error('child-identity-conflict');
          return { registered: false };
        }
        if (manifest.children.length >= 16) throw error('child-capacity');
        // The caller must complete this synchronous persistence before sending
        // any ACK that authorizes the child to change native input or Invoke.
        persistChildren([...manifest.children, { ...value }]);
        return { registered: true };
      },
      unregisterChild(detail) {
        assertOwned();
        if (!ownKeys(detail, ['pid', 'creationTicks', 'closeObserved']) || detail.closeObserved !== true)
          throw error('child-not-closed');
        const identity = { pid: detail.pid, creationTicks: detail.creationTicks };
        if (!childIdentity(identity)) throw error('child-identity-invalid');
        const index = manifest.children.findIndex(child => child.pid === identity.pid);
        if (index < 0) throw error('child-not-found');
        if (manifest.children[index].creationTicks !== identity.creationTicks) throw error('child-identity-conflict');
        // closeObserved must come from the actual child CLOSE event, never
        // timeout, kill request, exit observation alone, or a liveness guess.
        persistChildren(manifest.children.filter((_, childIndex) => childIndex !== index));
        return { unregistered: true };
      },
      provisionJournal(initializeEncryptedJournal) {
        const current = currentMarker();
        if (current.provisioned || journalExists(file)) throw error('journal-provisioning-conflict');
        if (manifest.children.length || journal || opening) throw error('journal-provisioning-conflict');
        if (typeof initializeEncryptedJournal !== 'function' || typeof provider.commitProvisionedMarker !== 'function')
          throw error('journal-provisioning-required');
        let result;
        try { result = initializeEncryptedJournal(context(current)); }
        catch (_) { unavailable = true; throw error('owner-unavailable'); }
        if (result && typeof result.then === 'function') {
          unavailable = true; throw error('journal-provisioning-sync-required');
        }
        assertOwned();
        if (!journalExists(file)) throw error('journal-initialization-required');
        try {
          const committed = provider.commitProvisionedMarker(Object.freeze({ ...current, provisioned: true }));
          if (committed && typeof committed.then === 'function') throw error('continuity-unavailable');
        } catch (_) { throw error('continuity-unavailable'); }
        if (!currentMarker().provisioned) throw error('continuity-unavailable');
        // The initializer/provider must each make their own writes durable.
        // A crash between those commits remains ambiguous and fails closed.
        return { provisioned: true };
      },
      openJournal(createJournal) {
        const current = currentMarker();
        if (!current.provisioned) throw error('journal-provisioning-required');
        if (!journalExists(file)) throw error('journal-missing');
        if (journal || opening) throw error('journal-already-open');
        if (typeof createJournal !== 'function') throw error('owner-options-invalid');
        opening = true;
        try {
          // No journal constructor or restart recovery runs before ownership
          // and provider continuity have both been established.
          const created = createJournal(context(current));
          if (!created || typeof created.close !== 'function' || typeof created.then === 'function') {
            unavailable = true; throw error('journal-factory-invalid');
          }
          if (typeof created.status === 'function' && created.status().available !== true) {
            try { created.close(); } catch (_) {}
            unavailable = true; throw error('journal-unavailable');
          }
          journal = created; return journal;
        } catch (cause) {
          unavailable = true; throw cause;
        } finally { opening = false; }
      },
      closeJournal() {
        assertOwned();
        if (opening) throw error('journal-already-open');
        if (journal) {
          try { journal.close(); journal = null; }
          catch (_) { unavailable = true; throw error('owner-unavailable'); }
        }
      },
      release(detail) {
        if (!ownKeys(detail, ['allChildrenClosed']) || detail.allChildrenClosed !== true) throw error('children-not-closed');
        assertOwned();
        if (manifest.children.length) throw error('children-not-closed');
        if (journal || opening) throw error('journal-not-closed');
        try {
          const entries = fileSystem.readdirSync(lockDirectory);
          if (entries.length !== 1 || entries[0] !== 'owner.json') throw error('owner-unavailable');
          // Never recursively remove an ownership directory.
          fileSystem.unlinkSync(manifestFile);
          fileSystem.rmdirSync(lockDirectory);
          closed = true;
        } catch (_) { unavailable = true; throw error('owner-unavailable'); }
        return { released: true };
      }
    };
  }
  return acquireJournalOwner;
}
module.exports = { acquireJournalOwner: implementation(fs),
  _testOnly: Object.freeze({ withFileSystem: implementation }) };
