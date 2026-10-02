'use strict';
// Independent encrypted Dot request journal. No UI/native action or key creation.
// Desktop-row acceptance is display evidence, never an official server receipt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const protocol = require('./dot-desktop-protocol.js');
const ownership = require('./dot-desktop-owner.js');
const DOMAIN = 'PocketBridge.IndependentDot.RequestJournal.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const STATES = new Set(['prepared', 'sending', 'accepted', 'failed', 'unknown']);
const RECORD_KEYS = ['request', 'fingerprint', 'operationId', 'baseline', 'baselineDigest', 'state',
  'createdAt', 'at', 'submitted', 'code', 'invokeAuthorized', 'afterObservation', 'proof'];
const error = code => Object.assign(new Error(code), { code, submitted: null });
const ownKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const clone = value => JSON.parse(JSON.stringify(value));
function request(value) {
  if (!ownKeys(value, ['requestId', 'threadId', 'text']) || typeof value.requestId !== 'string' ||
      typeof value.threadId !== 'string') throw error('invalid-request');
  try { return protocol.normalizeRequest(value); } catch (_) { throw error('invalid-request'); }
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw error('invalid-request');
  return value.toLowerCase();
}
function observation(value, valueRequest, operationId, maximum = 40) {
  try {
    const normalized = protocol.normalizeObservation(value, valueRequest, operationId, maximum);
    if (!ownKeys(value, Object.keys(normalized)) || typeof value.version !== 'string' ||
        !value.rows.every(row => ownKeys(row, ['observationId', 'role', 'textSha256']) &&
          typeof row.observationId === 'string' && typeof row.textSha256 === 'string'))
      throw error('baseline-unavailable');
    return normalized;
  } catch (_) { throw error('baseline-unavailable'); }
}
function safeCode(value) {
  if (typeof value !== 'string' || !CODE.test(value)) throw error('invalid-transition');
  return value;
}
const envelopeDigest = value => protocol.sha(JSON.stringify([value.version, value.algorithm, value.nonce, value.tag, value.data]));

function implementation(fileSystem, acquireOwner) {
  function deriveKey(provider, context) {
    let supplied, material;
    try {
      supplied = provider.readJournalKey(Object.freeze({ journalIdentity: context.journalIdentity, keyIdentity: context.keyIdentity }));
      if (!Buffer.isBuffer(supplied) || supplied.length !== 32) throw error('journal-key-required');
      material = Buffer.from(supplied);
      return Buffer.from(crypto.hkdfSync('sha256', material, Buffer.from(context.journalIdentity, 'hex'),
        Buffer.from(DOMAIN + '.AES256GCM'), 32));
    } catch (_) { throw error('journal-key-required'); }
    finally { if (material) material.fill(0); }
  }
  function readEnvelope(file) {
    let descriptor;
    try {
      const link = fileSystem.lstatSync(file);
      if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) throw error('journal-unavailable');
      descriptor = fileSystem.openSync(file, 'r');
      const stat = fileSystem.fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 2 || stat.size > 12 * 1024 * 1024) throw error('journal-unavailable');
      const raw = fileSystem.readFileSync(descriptor);
      if (raw.length !== stat.size || raw.length > 12 * 1024 * 1024) throw error('journal-unavailable');
      const envelope = JSON.parse(raw.toString('utf8'));
      if (!ownKeys(envelope, ['version', 'algorithm', 'nonce', 'tag', 'data']) || envelope.version !== 1 ||
          envelope.algorithm !== 'aes-256-gcm') throw error('journal-unavailable');
      for (const name of ['nonce', 'tag', 'data']) {
        if (typeof envelope[name] !== 'string' || !envelope[name].length ||
            Buffer.from(envelope[name], 'base64').toString('base64') !== envelope[name]) throw error('journal-unavailable');
      }
      if (Buffer.from(envelope.nonce, 'base64').length !== 12 || Buffer.from(envelope.tag, 'base64').length !== 16)
        throw error('journal-unavailable');
      return envelope;
    } catch (_) { throw error('journal-unavailable'); }
    finally { if (descriptor !== undefined) fileSystem.closeSync(descriptor); }
  }
  function encryptedStore(context, key, value, assertOwned) {
    let plaintext, temporary, descriptor;
    try {
      assertOwned();
      plaintext = Buffer.from(JSON.stringify(value));
      if (plaintext.length > 8 * 1024 * 1024) throw error('journal-capacity');
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify([DOMAIN, context.journalIdentity, context.keyIdentity])));
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelopeValue = { version: 1, algorithm: 'aes-256-gcm', nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      const envelope = JSON.stringify(envelopeValue);
      temporary = context.file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
      descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
      fileSystem.writeFileSync(descriptor, envelope); fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor); descriptor = undefined;
      assertOwned();
      fileSystem.renameSync(temporary, context.file); temporary = null;
      return envelopeDigest(envelopeValue);
    } catch (cause) { throw error(cause.code === 'journal-capacity' ? 'journal-capacity' : 'journal-unavailable'); }
    finally {
      if (plaintext) plaintext.fill(0);
      if (descriptor !== undefined) { try { fileSystem.closeSync(descriptor); } catch (_) {} }
      if (temporary) { try { fileSystem.unlinkSync(temporary); } catch (_) {} }
    }
  }
  function createDotDesktopJournal(options) {
    const allowed = ['file', 'keyProvider', 'parentIdentityProvider', 'maximumRecords', 'provision'];
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => !allowed.includes(key)) || typeof options.file !== 'string' ||
        !path.isAbsolute(options.file) || !options.keyProvider || typeof options.keyProvider.readJournalKey !== 'function' ||
        (options.provision !== undefined && typeof options.provision !== 'boolean') ||
        (options.maximumRecords !== undefined && (!Number.isSafeInteger(options.maximumRecords) || options.maximumRecords < 1 || options.maximumRecords > 256)))
      throw error('journal-options-invalid');
    const capacity = options.maximumRecords === undefined ? 256 : options.maximumRecords;
    // Ownership exists before ANY ciphertext load, recovery, or provisioning.
    let owner;
    try { owner = acquireOwner({ journalFile: options.file, keyProvider: options.keyProvider,
      parentIdentityProvider: options.parentIdentityProvider }); }
    catch (cause) { throw error(typeof cause.code === 'string' ? cause.code : 'journal-unavailable'); }
    if (options.provision === true) {
      try {
        owner.provisionJournal(context => {
          const key = deriveKey(options.keyProvider, context);
          try { encryptedStore(context, key, { version: 1, journalIdentity: context.journalIdentity,
            keyIdentity: context.keyIdentity, revision: 0, records: [] }, owner.assertOwned); }
          finally { key.fill(0); }
        });
      } catch (cause) { throw error(typeof cause.code === 'string' ? cause.code : 'journal-unavailable'); }
    }
    let engine;
    try { engine = owner.openJournal(context => {
      const key = deriveKey(options.keyProvider, context);
      let records = new Map(), proofOwners = new Map(), operationOwners = new Map(), revision = 0,
        committedEnvelopeDigest = null, unavailable = false, closed = false;
      function latchUnavailable() {
        unavailable = true;
        // This engine can never become ready again. Burn only its derived
        // in-memory AES key; persisted requests, ownership and children remain
        // untouched and require their normal separately verified lifecycle.
        key.fill(0);
      }
      function ready() {
        if (unavailable || closed) throw error('journal-unavailable');
        let freshKey;
        try {
          owner.assertJournalContinuity();
          freshKey = deriveKey(options.keyProvider, context);
          if (!crypto.timingSafeEqual(freshKey, key) || envelopeDigest(readEnvelope(context.file)) !== committedEnvelopeDigest)
            throw error('journal-unavailable');
        } catch (_) { latchUnavailable(); throw error('journal-unavailable'); }
        finally { if (freshKey) freshKey.fill(0); }
      }
      function validateRecord(value) {
        if (!ownKeys(value, RECORD_KEYS)) throw error('journal-unavailable');
        const valueRequest = request(value.request), operationId = uuid(value.operationId);
        const baseline = observation(value.baseline, valueRequest, operationId);
        if (value.operationId !== operationId || value.fingerprint !== protocol.fingerprint(valueRequest) ||
            value.baselineDigest !== protocol.baselineDigest(baseline) || !STATES.has(value.state) ||
            !Number.isSafeInteger(value.createdAt) || value.createdAt < 1 || !Number.isSafeInteger(value.at) || value.at < value.createdAt ||
            !(value.code === null || (typeof value.code === 'string' && CODE.test(value.code))) ||
            typeof value.invokeAuthorized !== 'boolean') throw error('journal-unavailable');
        const expectedSubmitted = ['prepared', 'failed'].includes(value.state) ? false : value.state === 'accepted' ? true : null;
        if (value.submitted !== expectedSubmitted ||
            (['prepared', 'failed'].includes(value.state) && value.invokeAuthorized) ||
            (['sending', 'accepted'].includes(value.state) && !value.invokeAuthorized)) throw error('journal-unavailable');
        let afterObservation = null, proof = null;
        if (value.state === 'accepted') {
          afterObservation = observation(value.afterObservation, valueRequest, operationId, 45);
          proof = protocol.verifyFreshDesktopRow(baseline, afterObservation, valueRequest, operationId);
          if (!proof || !ownKeys(value.proof, Object.keys(proof)) || Object.keys(proof).some(field => value.proof[field] !== proof[field]))
            throw error('journal-unavailable');
        } else if (value.afterObservation !== null || value.proof !== null) throw error('journal-unavailable');
        return { ...clone(value), request: valueRequest, baseline, afterObservation, proof };
      }
      function indexes(next) {
        const proofs = new Map(), operations = new Map(), unresolved = new Set();
        for (const [id, record] of next) {
          if (id !== record.request.requestId || operations.has(record.operationId)) throw error('journal-unavailable');
          operations.set(record.operationId, id);
          if (['prepared', 'sending', 'unknown'].includes(record.state)) {
            if (unresolved.has(record.request.threadId)) throw error('journal-unavailable');
            unresolved.add(record.request.threadId);
          }
          if (record.state === 'accepted') {
            const proofKey = protocol.proofOwnerKey(record.proof);
            if (proofs.has(proofKey)) throw error('delivery-proof-reused');
            proofs.set(proofKey, id);
          }
        }
        return { proofs, operations };
      }
      function store(next) {
        ready();
        try {
          if (next.size > capacity || revision >= Number.MAX_SAFE_INTEGER) throw error('journal-capacity');
          const nextIndexes = indexes(next);
          const nextDigest = encryptedStore(context, key, { version: 1, journalIdentity: context.journalIdentity,
            keyIdentity: context.keyIdentity, revision: revision + 1, records: [...next.values()] }, ready);
          records = next; proofOwners = nextIndexes.proofs; operationOwners = nextIndexes.operations; revision++;
          committedEnvelopeDigest = nextDigest;
        } catch (cause) { latchUnavailable(); throw error(cause.code === 'journal-capacity' ? 'journal-capacity' : 'journal-unavailable'); }
      }
      try {
        const envelope = readEnvelope(context.file);
        committedEnvelopeDigest = envelopeDigest(envelope);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
        decipher.setAAD(Buffer.from(JSON.stringify([DOMAIN, context.journalIdentity, context.keyIdentity])));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
        let parsed;
        try {
          if (plaintext.length > 8 * 1024 * 1024) throw error('journal-unavailable');
          parsed = JSON.parse(plaintext.toString('utf8'));
        } finally { plaintext.fill(0); }
        if (!ownKeys(parsed, ['version', 'journalIdentity', 'keyIdentity', 'revision', 'records']) || parsed.version !== 1 ||
            parsed.journalIdentity !== context.journalIdentity || parsed.keyIdentity !== context.keyIdentity ||
            !Number.isSafeInteger(parsed.revision) || parsed.revision < 0 || !Array.isArray(parsed.records) || parsed.records.length > capacity)
          throw error('journal-unavailable');
        revision = parsed.revision;
        let recovered = false;
        for (const value of parsed.records) {
          const record = validateRecord(value);
          if (records.has(record.request.requestId)) throw error('journal-unavailable');
          if (['prepared', 'sending'].includes(record.state)) {
            record.state = 'unknown'; record.submitted = null; record.code = 'interrupted';
            record.at = Math.max(record.at, Date.now()); recovered = true;
          }
          records.set(record.request.requestId, record);
        }
        const loaded = indexes(records); proofOwners = loaded.proofs; operationOwners = loaded.operations;
        if (recovered) store(new Map(records));
      } catch (_) { key.fill(0); records.clear(); throw error('journal-unavailable'); }
      function receipt(record) {
        return { requestId: record.request.requestId, threadId: record.request.threadId, state: record.state,
          at: record.at, submitted: record.submitted, shownInDesktopConversation: record.state === 'accepted',
          serverAcknowledged: false, executionConfirmed: false, code: record.code };
      }
      function get(id) {
        ready(); const value = records.get(uuid(id));
        if (!value) throw error('not-found'); return value;
      }
      function update(current, fields) {
        const value = validateRecord({ ...clone(current), ...fields, at: Math.max(current.at, Date.now()) });
        const next = new Map(records); next.set(value.request.requestId, value); store(next); return receipt(value);
      }
      return {
        status() {
          try { ready(); return { available: true, pending: [...records.values()].some(record => ['prepared', 'sending', 'unknown'].includes(record.state)),
            capacityRemaining: capacity - records.size }; }
          catch (_) { return { available: false, pending: true, capacityRemaining: 0 }; }
        },
        lookup(value) {
          ready(); const normalized = request(value), existing = records.get(normalized.requestId);
          if (!existing) return null;
          if (existing.fingerprint !== protocol.fingerprint(normalized)) throw error('request-id-conflict');
          return receipt(existing);
        },
        pending(threadId) {
          ready(); threadId = uuid(threadId);
          return [...records.values()].some(record => record.request.threadId === threadId && ['prepared', 'sending', 'unknown'].includes(record.state));
        },
        prepare(value, operationId, baselineValue) {
          ready(); const normalized = request(value), existing = records.get(normalized.requestId);
          if (existing) {
            if (existing.fingerprint !== protocol.fingerprint(normalized)) throw error('request-id-conflict');
            return { created: false, receipt: receipt(existing) };
          }
          if ([...records.values()].some(record => record.request.threadId === normalized.threadId && ['prepared', 'sending', 'unknown'].includes(record.state)))
            throw error('pending-request-exists');
          if (records.size >= capacity) throw error('journal-capacity');
          operationId = uuid(operationId);
          if (operationOwners.has(operationId)) throw error('operation-id-conflict');
          const baseline = observation(baselineValue, normalized, operationId), now = Date.now();
          const record = validateRecord({ request: normalized, fingerprint: protocol.fingerprint(normalized), operationId,
            baseline, baselineDigest: protocol.baselineDigest(baseline), state: 'prepared', createdAt: now, at: now,
            submitted: false, code: null, invokeAuthorized: false, afterObservation: null, proof: null });
          const next = new Map(records); next.set(normalized.requestId, record); store(next);
          return { created: true, receipt: receipt(record) };
        },
        markSending(id, digest) {
          const current = get(id);
          if (current.state !== 'prepared' || digest !== current.baselineDigest) throw error('invalid-transition');
          return update(current, { state: 'sending', submitted: null, invokeAuthorized: true, code: null });
        },
        assertReadyForAck(stage, id, digest) {
          const current = get(id);
          if (!['paste', 'invoke'].includes(stage) || current.state !== (stage === 'paste' ? 'prepared' : 'sending') ||
              digest !== current.baselineDigest) throw error('invalid-transition');
          owner.assertOneChild();
          ready();
          return true;
        },
        markFailedBeforeSend(id, code) {
          const current = get(id);
          if (current.state !== 'prepared') throw error('invalid-transition');
          return update(current, { state: 'failed', submitted: false, code: safeCode(code) });
        },
        markUnknown(id, code) {
          const current = get(id);
          if (!['prepared', 'sending', 'unknown'].includes(current.state)) throw error('invalid-transition');
          return update(current, { state: 'unknown', submitted: null, code: safeCode(code) });
        },
        accept(id, afterValue) {
          const current = get(id);
          if (!['sending', 'unknown', 'accepted'].includes(current.state) || !current.invokeAuthorized) throw error('invalid-transition');
          let after;
          try { after = observation(afterValue, current.request, current.operationId, 45); }
          catch (_) { throw error('delivery-proof-unavailable'); }
          const proof = protocol.verifyFreshDesktopRow(current.baseline, after, current.request, current.operationId);
          if (!proof) throw error('delivery-proof-unavailable');
          const priorOwner = proofOwners.get(protocol.proofOwnerKey(proof));
          if (priorOwner && priorOwner !== current.request.requestId) throw error('delivery-proof-reused');
          if (current.state === 'accepted') {
            if (JSON.stringify(current.afterObservation) !== JSON.stringify(after)) throw error('invalid-transition');
            return receipt(current);
          }
          return update(current, { state: 'accepted', submitted: true, code: null, afterObservation: after, proof });
        },
        receipt(id, threadId) {
          const current = get(id);
          if (current.request.threadId !== uuid(threadId)) throw error('target-mismatch');
          return receipt(current);
        },
        close() { closed = true; key.fill(0); records.clear(); proofOwners.clear(); operationOwners.clear(); }
      };
    }); }
    catch (cause) { throw error(typeof cause.code === 'string' ? cause.code : 'journal-unavailable'); }
    let closed = false;
    const journal = { ...engine,
      registerChild(helper) { if (closed || !engine.status().available) throw error('journal-unavailable'); return owner.registerChild(helper); },
      unregisterChild(helper, closeObserved) {
        if (closed) throw error('journal-unavailable');
        return owner.unregisterChild({ ...helper, closeObserved });
      },
      close(detail) {
        if (!ownKeys(detail, ['allChildrenClosed']) || detail.allChildrenClosed !== true) throw error('children-not-closed');
        if (closed) throw error('journal-unavailable');
        owner.assertNoChildren(); owner.closeJournal(); owner.release(detail); closed = true;
      }
    };
    return journal;
  }
  return createDotDesktopJournal;
}
module.exports = { createDotDesktopJournal: implementation(fs, ownership.acquireJournalOwner),
  _testOnly: Object.freeze({ withFileSystem(fileSystem) {
    return implementation(fileSystem, ownership._testOnly.withFileSystem(fileSystem));
  } }) };
