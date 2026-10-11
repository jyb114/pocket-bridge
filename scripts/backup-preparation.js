'use strict';

// Explicit, authenticated backup preparation only. These opaque capabilities
// are private to this gateway boot and are never accepted by legacy /t links.
// This module does not persist credentials, create devices, or contact a host.
// HTTP callers must supply the actual verified device identity, and call
// complete only behind the receiving origin's device-cookie/proof/E2EE gates.
const crypto = require('node:crypto');
const { quickOrigin, GENERATION, FRESHNESS_MS } = require('./tunnel-state.js');
const TTL_MS = 60000;
const MAX_RECORDS = 128;
const MAX_PER_DEVICE = 4;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VERSION = /^[a-f0-9]{64}$/;
const DEVICE = /^[A-Za-z0-9_-]{8,128}$/;
const TICKET = /^bp1_[A-Za-z0-9_-]{43}$/;
const PREPARATION = /^bprep1_[A-Za-z0-9_-]{43}$/;
const RECEIPT = /^bpr1_[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^[a-f0-9]{48}$/;
const BINDINGS = ['instanceId', 'bootId', 'port', 'accessVersion', 'e2eeVersion', 'origin', 'generation'];
const fail = code => Object.assign(Error(code), { code });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function createBackupPreparation({ readContext, isDeviceActive, reissueDevice, now = Date.now,
  randomBytes = crypto.randomBytes } = {}) {
  if (![readContext, isDeviceActive, reissueDevice, now, randomBytes].every(value => typeof value === 'function'))
    throw fail('backup-preparation-invalid-options');
  const records = new Map();
  const tickets = new Map();
  let observedTime = 0;
  let sequence = 0;

  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value <= 0) throw fail('backup-preparation-unavailable');
    if (value < observedTime) {
      records.clear(); tickets.clear(); observedTime = value;
      throw fail('backup-preparation-unavailable');
    }
    observedTime = value;
    return value;
  }
  function remove(record) {
    records.delete(record.preparationId);
    if (record.ticketDigest) tickets.delete(record.ticketDigest);
  }
  function prune(at) {
    for (const record of records.values()) if (at < record.issuedAt || at >= record.expiresAt) remove(record);
  }
  function device(deviceId) {
    if (typeof deviceId !== 'string' || !DEVICE.test(deviceId)) throw fail('backup-preparation-device-invalid');
    try { if (isDeviceActive(deviceId) === true) return; } catch (_) {}
    throw fail('backup-preparation-device-inactive');
  }
  function snapshot(at) {
    try {
      const value = readContext();
      const checkedAt = clock();
      const backup = value?.backup;
      if (value?.enabled !== true || value.supported !== true || typeof value.instanceId !== 'string' || !UUID.test(value.instanceId) ||
          typeof value.bootId !== 'string' || !UUID.test(value.bootId) || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
          typeof value.accessVersion !== 'string' || !VERSION.test(value.accessVersion) ||
          typeof value.e2eeVersion !== 'string' || !VERSION.test(value.e2eeVersion) ||
          !backup || backup.phase !== 'ready' || backup.reachable !== true ||
          checkedAt < at || !Number.isSafeInteger(backup.checkedAt) || backup.checkedAt <= 0 || backup.checkedAt > checkedAt ||
          checkedAt - backup.checkedAt > FRESHNESS_MS || typeof backup.generation !== 'string' || !GENERATION.test(backup.generation) ||
          !backup.origin || quickOrigin(backup.origin) !== backup.origin) throw Error('unavailable');
      return { instanceId: value.instanceId, bootId: value.bootId, port: value.port,
        accessVersion: value.accessVersion, e2eeVersion: value.e2eeVersion,
        origin: backup.origin, generation: backup.generation };
    } catch (_) { throw fail('backup-preparation-unavailable'); }
  }
  function verify(record, at) {
    device(record.deviceId);
    const current = snapshot(at);
    if (clock() >= record.expiresAt) throw fail('backup-preparation-invalid');
    if (!BINDINGS.every(key => current[key] === record[key])) throw fail('backup-preparation-target-changed');
  }
  function owned(preparationId, deviceId, at) {
    if (typeof preparationId !== 'string' || !PREPARATION.test(preparationId)) throw fail('backup-preparation-invalid');
    prune(at);
    const record = records.get(preparationId);
    if (!record || record.deviceId !== deviceId) throw fail('backup-preparation-invalid');
    device(deviceId);
    return record;
  }
  function random(prefix, bootId) {
    let bytes;
    try { bytes = randomBytes(32); } catch (_) { throw fail('backup-preparation-unavailable'); }
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw fail('backup-preparation-unavailable');
    if (!Number.isSafeInteger(++sequence)) throw fail('backup-preparation-unavailable');
    // Repeated entropy must not remint a consumed capability. A boot/purpose
    // domain and monotonic sequence provide uniqueness without tombstones.
    const value = crypto.createHash('sha256').update(`${prefix}|${bootId}|${sequence}|`).update(bytes).digest('base64url');
    return prefix + value;
  }
  function tuple(record) {
    return { preparationId: record.preparationId, bootId: record.bootId, origin: record.origin,
      generation: record.generation, expiresAt: record.expiresAt, nonce: record.nonce, challenge: record.challenge };
  }
  function sameHandshake(record, nonce, challenge) {
    return typeof nonce === 'string' && CHALLENGE.test(nonce) && typeof challenge === 'string' &&
      CHALLENGE.test(challenge) && nonce === record.nonce && challenge === record.challenge;
  }

  return Object.freeze({
    mint({ deviceId, origin, generation, nonce, challenge } = {}) {
      const at = clock(); prune(at); device(deviceId);
      const current = snapshot(at);
      if (typeof nonce !== 'string' || !CHALLENGE.test(nonce) || typeof challenge !== 'string' || !CHALLENGE.test(challenge))
        throw fail('backup-preparation-invalid');
      if (origin !== current.origin || generation !== current.generation) throw fail('backup-preparation-target-changed');
      if (records.size >= MAX_RECORDS || [...records.values()].filter(record => record.deviceId === deviceId).length >= MAX_PER_DEVICE)
        throw fail('backup-preparation-busy');
      const ticket = random('bp1_', current.bootId), preparationId = random('bprep1_', current.bootId), ticketDigest = digest(ticket);
      if (tickets.has(ticketDigest) || records.has(preparationId)) throw fail('backup-preparation-unavailable');
      const record = { ...current, deviceId, preparationId, ticketDigest, issuedAt: at,
        expiresAt: at + TTL_MS, phase: 'pending', checkedAt: null, nonce, challenge,
        receiptDigest: null, receiverVerified: false };
      records.set(preparationId, record); tickets.set(ticketDigest, record);
      return { ticket, ...tuple(record) };
    },
    redeem({ ticket, origin, nonce, challenge } = {}) {
      const at = clock(); prune(at);
      if (typeof ticket !== 'string' || !TICKET.test(ticket)) throw fail('backup-preparation-invalid');
      const key = digest(ticket), record = tickets.get(key);
      if (!record || record.phase !== 'pending') throw fail('backup-preparation-invalid');
      // Burn before validation/reissue so errors, wrong destinations and
      // concurrent requests can never retry this capability into a session.
      tickets.delete(key); record.ticketDigest = null; record.phase = 'consuming';
      try {
        if (origin !== record.origin) throw fail('backup-preparation-target-changed');
        if (!sameHandshake(record, nonce, challenge)) throw fail('backup-preparation-invalid');
        verify(record, at);
        const receipt = random('bpr1_', record.bootId);
        let token;
        try { token = reissueDevice(record.deviceId, new URL(record.origin).host); }
        catch (_) { throw fail('backup-preparation-device-reissue-failed'); }
        if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token))
          throw fail('backup-preparation-device-reissue-failed');
        const after = clock();
        if (records.get(record.preparationId) !== record || record.phase !== 'consuming' || after < at || after >= record.expiresAt)
          throw fail('backup-preparation-invalid');
        verify(record, after); // Reissue must not hide revocation/rotation races.
        if (records.get(record.preparationId) !== record || record.phase !== 'consuming')
          throw fail('backup-preparation-invalid');
        record.phase = 'redeemed'; record.expiresAt = after + TTL_MS; record.receiptDigest = digest(receipt);
        return { token, receipt, ...tuple(record) };
      } catch (error) {
        remove(record);
        throw /^backup-preparation-/.test(error?.code || '') ? error : fail('backup-preparation-unavailable');
      }
    },
    confirmReceiver({ preparationId, deviceId, receipt, nonce, challenge } = {}) {
      const at = clock(), record = owned(preparationId, deviceId, at);
      if (record.phase !== 'redeemed' || record.receiverVerified || !record.receiptDigest ||
          typeof receipt !== 'string' || !RECEIPT.test(receipt) ||
          !crypto.timingSafeEqual(Buffer.from(digest(receipt), 'hex'), Buffer.from(record.receiptDigest, 'hex')))
        throw fail('backup-preparation-invalid');
      // Only a genuine receiving-origin redemption can obtain this receipt.
      // The authenticated encrypted source confirms it once before releasing
      // the encryption key; knowing the public boot marker cannot substitute.
      record.receiptDigest = null;
      if (!sameHandshake(record, nonce, challenge)) throw fail('backup-preparation-invalid');
      verify(record, at);
      if (records.get(record.preparationId) !== record || record.phase !== 'redeemed') throw fail('backup-preparation-invalid');
      record.receiverVerified = true;
      return { ...tuple(record), receiverVerified: true, checkedAt: at };
    },
    complete({ preparationId, deviceId, origin, generation, nonce, challenge } = {}) {
      const at = clock(), record = owned(preparationId, deviceId, at);
      if (record.phase !== 'redeemed' || record.receiverVerified !== true || !sameHandshake(record, nonce, challenge))
        throw fail('backup-preparation-invalid');
      if (origin !== record.origin || generation !== record.generation) throw fail('backup-preparation-target-changed');
      verify(record, at);
      if (records.get(record.preparationId) !== record || record.phase !== 'redeemed') throw fail('backup-preparation-invalid');
      record.phase = 'completed'; record.checkedAt = at;
      return { ...tuple(record), checkedAt: at };
    },
    status({ preparationId, deviceId } = {}) {
      const at = clock(), record = owned(preparationId, deviceId, at);
      verify(record, at);
      if (records.get(record.preparationId) !== record) throw fail('backup-preparation-invalid');
      if (!['pending', 'redeemed', 'completed'].includes(record.phase)) throw fail('backup-preparation-invalid');
      return { ...tuple(record), phase: record.phase, checkedAt: record.checkedAt };
    },
    revoke({ preparationId, deviceId } = {}) {
      const at = clock(), record = owned(preparationId, deviceId, at);
      // Authenticated cancellation may retire an old target after replacement.
      remove(record); return { ok: true };
    }
  });
}

module.exports = { createBackupPreparation, TTL_MS, MAX_RECORDS, MAX_PER_DEVICE };
