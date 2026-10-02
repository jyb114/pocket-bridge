'use strict';
// Lazy independent Dot runtime. No provider, process or native action is
// created at module load, construction or status. Private provisioning follows
// only an explicit verified durable snapshot and supported desktop inspection.
const path = require('node:path');
const { createDotDesktopDriver, validateSnapshot } = require('./dot-desktop-driver.js');
const { createDotTextSender } = require('./dot-desktop-send-driver.js');
const { createDotDesktopService } = require('./dot-desktop-service.js');
const { createDotDesktopPrivateStore } = require('./dot-desktop-private-store.js');
const SUPPORTED_VERSIONS = Object.freeze(['26.928.3736.0']);
const fail = code => Object.assign(new Error(code), { code, submitted: false });
function createDotDesktopRuntime(options = {}) {
  if (Object.keys(options).some(key => !['base','testOnlyEnableSend','driver','textSender','storeFactory'].includes(key)) ||
      typeof options.base !== 'string' || !path.isAbsolute(options.base) ||
      options.testOnlyEnableSend !== undefined && typeof options.testOnlyEnableSend !== 'boolean')
    throw fail('invalid-request');
  const enabled = options.testOnlyEnableSend === true;
  const native = options.driver || createDotDesktopDriver();
  const sender = options.textSender || createDotTextSender({ testOnlyEnableSend: enabled, allowedSendVersions: SUPPORTED_VERSIONS });
  const makeStore = options.storeFactory || createDotDesktopPrivateStore;
  if (!native || typeof native.snapshot !== 'function' || typeof native.inspect !== 'function' ||
      !sender || typeof sender.supports !== 'function' || typeof sender.send !== 'function' || typeof makeStore !== 'function')
    throw fail('invalid-request');
  let cache = { available: false, desktopRunning: false, version: null, reason: 'not-connected',
    statusScope: 'native-unchecked', observedAt: null };
  let initialization = 'empty', store = null, journal = null, stopping = false, closed = false, closePromise = null;
  let secretsDiscarded = false;
  let journalStatus = { available: false, pending: true, capacityRemaining: 0 };
  const ownedReads = new Set();
  function discardFailedProviderSecrets() {
    if (secretsDiscarded || !store || typeof store.discardSecrets !== 'function') return;
    try { store.discardSecrets(); secretsDiscarded = true; }
    catch (_) { /* No owner cleanup or provider reset is permitted on failure. */ }
  }
  const methods = ['lookup','pending','prepare','markSending','assertReadyForAck','markFailedBeforeSend',
    'markUnknown','accept','receipt','registerChild','unregisterChild'];
  const proxy = {
    // UI status is the last verified capability. Every actual Send/receipt
    // mutation delegates to the real continuity guard before acting.
    status() { return { ...journalStatus, available: !!journal && !closed && journalStatus.available === true }; },
    close(detail) { if (journal) return journal.close(detail); }
  };
  for (const method of methods) proxy[method] = (...args) => {
    if (!journal || closed) throw fail('journal-unavailable');
    try { return journal[method](...args); }
    catch (cause) { if (!['not-found','request-id-conflict','pending-request-exists'].includes(cause?.code)) journalStatus.available = false; throw cause; }
  };
  function ownRead(operation) {
    const result = Promise.resolve().then(operation); ownedReads.add(result);
    result.finally(() => ownedReads.delete(result)).catch(() => {}); return result;
  }
  const guarded = {
    // Cached status cannot start native PowerShell or provision persistence.
    async inspect() { return { ...cache }; },
    snapshot(input) {
      if (stopping || closed) return Promise.reject(fail('desktop-busy'));
      return ownRead(async () => {
        const snapshot = validateSnapshot({ ok: true, ...await native.snapshot(input) }, input?.threadId || null);
        if (stopping || closed) throw fail('desktop-busy');
        cache = { available: true, desktopRunning: true, version: null, reason: 'ready-to-connect',
          statusScope: 'last-verified-connect', observedAt: Date.now() };
        if (enabled) {
          const inspected = await native.inspect();
          if (stopping || closed) throw fail('desktop-busy');
          cache = { available: inspected?.available === true, desktopRunning: inspected?.desktopRunning === true,
            version: typeof inspected?.version === 'string' ? inspected.version : null, reason: inspected?.reason || 'ready-to-connect',
            statusScope: 'last-verified-connect', observedAt: Date.now() };
          if (initialization === 'empty' && cache.available && cache.desktopRunning &&
              SUPPORTED_VERSIONS.includes(cache.version) && sender.supports(cache.version)) {
            // One synchronous trusted initialization. Failure remains latched;
            // neither a status poll nor another Connect can reset key/owners.
            initialization = 'starting';
            try {
              store = makeStore({ base: options.base }); journal = store.createJournal();
              if (!journal || (journalStatus = journal.status()).available !== true) throw fail('journal-unavailable');
              initialization = 'ready';
            } catch (_) { journal = null; initialization = 'failed'; discardFailedProviderSecrets(); }
          }
          if (initialization === 'ready') journalStatus = journal.status();
        }
        return snapshot;
      });
    }
  };
  const service = createDotDesktopService({ driver: guarded, textSender: sender, journal: proxy, testOnlyEnableSend: enabled });
  function stop() { stopping = true; service.stopAcceptingSends(); return { stopped: true }; }
  async function drain() {
    stop();
    await Promise.allSettled([service.drainSends(), ...ownedReads]);
    return { allOwnedChildrenClosed: true };
  }
  function close({ timeoutMs = 90000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return Promise.reject(fail('invalid-request'));
    if (closed) return Promise.resolve({ closed: true });
    if (closePromise) return closePromise;
    stop();
    closePromise = (async () => {
      if (store && journal) {
        await store.shutdown({ service, stopNewSends: stop, drainOwnedActions: drain, timeoutMs });
      } else {
        // A failed first provision may retain incomplete ownership evidence.
        // Do not invent a journal object or remove that evidence on shutdown.
        if (initialization === 'failed') discardFailedProviderSecrets();
        let timer;
        try {
          await Promise.race([drain(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('private-store-shutdown-timeout')), timeoutMs); })]);
          service.close();
        } finally { clearTimeout(timer); }
      }
      closed = true; return { closed: true };
    })().finally(() => { closePromise = null; });
    return closePromise;
  }
  // External callers cannot bypass the runtime's owned-read CLOSE drain by
  // closing the narrower Send service directly. Store shutdown receives only
  // the internal service after the full runtime drain has completed.
  const publicService = Object.freeze({ ...service, close, stopAcceptingSends: stop, drainSends: drain });
  return Object.freeze({ service: publicService, stop, drain, close,
    status() { return { initialization, stopping, closed, ownedReads: ownedReads.size }; } });
}
module.exports = { createDotDesktopRuntime, SUPPORTED_VERSIONS };
