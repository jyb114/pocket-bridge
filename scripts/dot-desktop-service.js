'use strict';

// Native Dot is a separate durable-host conversation, never a local Codex thread.
// The gateway must authenticate the phone and wrap this handler with e2eeWrap.
const { validateSnapshot, durableId } = require('./dot-desktop-driver.js');
const protocol = require('./dot-desktop-protocol.js');
const MAX_BODY_BYTES = 24 * 1024;
const MESSAGES = Object.freeze({
  'invalid-request': 'Invalid Dot request.',
  'invalid-source': 'This Dot request is not from the paired phone page.',
  'encryption-required': 'Open the complete encrypted phone address before using Dot.',
  'request-too-large': 'This Dot request is too large.',
  'unsupported-method': 'Use the Dot phone page to connect.',
  'not-connected': 'Connect to Your dot on this computer first.',
  'desktop-unavailable': 'Open the official desktop app and sign in before connecting to Dot.',
  'desktop-ambiguous': 'More than one official desktop window is open.',
  'desktop-busy': 'The computer is busy. Wait for the other desktop action to finish and retry.',
  'dot-unavailable': 'Your dot could not be identified in the desktop app.',
  'target-mismatch': 'The desktop dot changed. Reconnect from the correct account; nothing was sent.',
  'history-unavailable': 'The current Dot messages could not be read safely. Your draft is preserved.',
  'clipboard-unavailable': 'The computer clipboard could not be preserved.',
  'source-unverified': 'The current desktop chat could not be verified safely. On the computer, open Your dot and its profile, keep any existing draft, then retry Connect. Nothing was sent.',
  'send-unavailable': 'Text sending is not yet available for this desktop version. Your draft is preserved.',
  'draft-present': 'The desktop Dot contains an unsent draft. Nothing was sent; your phone draft is preserved.',
  'journal-unavailable': 'The private Dot receipt journal is unavailable. Text sending is disabled.',
  'journal-capacity': 'The private Dot receipt journal is full. Existing receipts must be preserved.',
  'request-id-conflict': 'This request ID belongs to different Dot message content.',
  'pending-request-exists': 'A previous Dot send is unresolved. Check that receipt before sending another message.',
  'not-found': 'No matching Dot receipt was found.',
  'unknown': 'The Dot desktop action could not be confirmed. Your draft is preserved.'
});
function error(code, status = 400) { return Object.assign(new Error(MESSAGES[code] || MESSAGES.unknown), { code, status }); }
function safeCode(value) { return Object.hasOwn(MESSAGES, value) ? value : 'unknown'; }
const RECEIPT_CHECK_MESSAGES = Object.freeze({
  'desktop-busy': 'The computer is busy. Wait, then check this receipt again. The original send remains unconfirmed; do not resend.',
  'desktop-unavailable': 'The original desktop app is not available. Keep it open and check again. The original send remains unconfirmed; do not resend.',
  'source-unverified': 'The original Dot view could not be verified safely. Use Refresh, then Check receipt. The original send remains unconfirmed; do not resend.',
  'target-mismatch': 'The desktop Dot changed since this send. Return to the original Dot and check again. The original send remains unconfirmed; do not resend.',
  'history-unavailable': 'The original history and exact new message could not be verified. The original send remains unconfirmed; do not resend.',
  'clipboard-unavailable': 'The computer clipboard could not be preserved for this check. Check again when the computer is free. The original send remains unconfirmed; do not resend.'
});
function createDotDesktopService(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      ['enableSend','testOnlyEnableSend'].some(key => options[key] !== undefined && typeof options[key] !== 'boolean') ||
      options.enableSend !== undefined && options.testOnlyEnableSend !== undefined && options.enableSend !== options.testOnlyEnableSend)
    throw error('invalid-request');
  const driver = options.driver;
  if (!driver || typeof driver.inspect !== 'function' || typeof driver.snapshot !== 'function')
    throw Error('Dot service requires an independent native Dot driver.');
  let boundId = null, lastVersion = null;
  const sender = options.textSender, journal = options.journal;
  const permitted = options.enableSend === undefined ? options.testOnlyEnableSend === true : options.enableSend === true;
  const sendGate = permitted && sender && typeof sender.send === 'function' &&
    typeof sender.supports === 'function' && journal && typeof journal.status === 'function';
  const inFlight = new Map(), reconciling = new Map(), activeTargets = new Map();
  let acceptingSends = true;
  function canSend() { return !!(acceptingSends && sendGate && sender.supports(lastVersion) && journal.status().available === true); }
  async function status() {
    const value = await driver.inspect();
    lastVersion = typeof value?.version === 'string' ? value.version : null;
    return { ok: true, available: value?.available === true, desktopRunning: value?.desktopRunning === true,
      connected: !!boundId, sendAvailable: canSend(), sendUnavailableCode: canSend() ? null : 'draft-reader-unverified',
      version: typeof value?.version === 'string' ? value.version : null,
      statusScope: value?.statusScope || 'current-inspection',
      observedAt: Number.isSafeInteger(value?.observedAt) ? value.observedAt : null,
      reason: value?.available === true ? 'ready-to-connect' : safeCode(value?.reason),
      historyScope: 'materialized-recent', taskExecution: 'unknown', localComputerAccess: 'unverified' };
  }
  async function snapshot(value) {
    if (!value || !['connect', 'snapshot'].includes(value.action)) throw error('invalid-request');
    if (Object.keys(value).some(key => !['action', 'threadId'].includes(key))) throw error('invalid-request');
    const requested = value.threadId == null ? null : durableId(value.threadId);
    if (value.action === 'snapshot' && !boundId) throw error('not-connected', 409);
    if (requested && boundId && requested !== boundId) throw error('target-mismatch', 409);
    const expected = boundId || requested;
    const native = await driver.snapshot({ threadId: expected });
    const result = validateSnapshot({ ok: true, ...native }, expected);
    // Bind only after a complete same-target native snapshot succeeds.
    boundId = result.threadId;
    if (sendGate && !lastVersion) { const inspected = await driver.inspect(); lastVersion = inspected?.version || null; }
    return { ok: true, connected: true, ...result, sendAvailable: canSend(), sendUnavailableCode: canSend() ? null : result.sendUnavailableCode };
  }
  async function send(value) {
    if (!sendGate || !acceptingSends) throw error('send-unavailable', 409);
    if (!boundId) throw error('not-connected', 409);
    if (Object.keys(value).some(key => !['action', 'requestId', 'threadId', 'text'].includes(key))) throw error('invalid-request');
    let request;
    try { request = protocol.normalizeRequest({ requestId: value.requestId, threadId: value.threadId, text: value.text }); }
    catch (_) { throw error('invalid-request'); }
    if (request.threadId !== boundId) throw error('target-mismatch', 409);
    if (journal.status().available !== true) throw error('journal-unavailable', 503);
    const prior = journal.lookup(request);
    if (prior) return { ok: true, receipt: prior };
    const active = inFlight.get(request.requestId);
    if (active) {
      if (active.fingerprint !== protocol.fingerprint(request)) throw error('request-id-conflict', 409);
      return active.operation;
    }
    if (activeTargets.has(request.threadId) || journal.pending(request.threadId)) throw error('pending-request-exists', 409);
    const fingerprint = protocol.fingerprint(request); let registered = false, prepared = false;
    const operation = Promise.resolve().then(async () => {
      const inspected = await driver.inspect(); lastVersion = inspected?.version || null;
      if (!canSend()) throw error('send-unavailable', 409);
      try {
        const receipt = await sender.send(request, {
          version: lastVersion,
          onLocked(helper) { journal.registerChild(helper); registered = true; },
          onPrepared(_request, operationId, baseline) {
            const saved = journal.prepare(request, operationId, baseline);
            if (!saved.created) throw error('request-id-conflict', 409);
            prepared = true;
          },
          onReady(_request, _operationId, baseline) { journal.markSending(request.requestId, protocol.baselineDigest(baseline)); },
          beforeAck(stage, _request, _operationId, digest) {
            if (journal.status().available !== true) throw error('journal-unavailable', 503);
            if (stage !== 'continue-preflight') journal.assertReadyForAck(stage, request.requestId, digest);
          },
          onResult(frame) {
            if (!prepared) throw error('journal-unavailable', 503);
            if (frame.submitted !== true) return journal.markUnknown(request.requestId, 'delivery-unconfirmed');
            try { return journal.accept(request.requestId, frame.observation); }
            catch (_) { return journal.markUnknown(request.requestId, 'delivery-unconfirmed'); }
          },
          onFailure(frame) {
            if (!prepared) return;
            const current = journal.receipt(request.requestId, request.threadId);
            if (current.state === 'prepared' && frame.submitted === false) journal.markFailedBeforeSend(request.requestId, safeCode(frame.code));
            else if (['prepared', 'sending', 'unknown'].includes(current.state)) journal.markUnknown(request.requestId, safeCode(frame.code));
          },
          onClose(helper, _request, _operationId, detail) {
            try {
              if (prepared && (!detail.terminal || detail.forced)) {
                const current = journal.receipt(request.requestId, request.threadId);
                if (['prepared', 'sending', 'unknown'].includes(current.state)) journal.markUnknown(request.requestId, 'unknown');
              }
            } finally { if (registered) { journal.unregisterChild(helper, true); registered = false; } }
          }
        });
        return { ok: true, receipt };
      } catch (cause) {
        if (prepared) {
          try { return { ok: true, receipt: journal.receipt(request.requestId, request.threadId) }; } catch (_) {}
        }
        const denied = error(safeCode(cause?.code), cause?.status || 503);
        denied.submitted = prepared ? null : false; throw denied;
      }
    }).finally(() => { inFlight.delete(request.requestId); if (activeTargets.get(request.threadId) === request.requestId) activeTargets.delete(request.threadId); });
    inFlight.set(request.requestId, { operation, fingerprint }); activeTargets.set(request.threadId, request.requestId);
    return operation;
  }
  async function receipt(value) {
    if (!sendGate) throw error('send-unavailable', 409);
    if (!boundId) throw error('not-connected', 409);
    if (Object.keys(value).some(key => !['action', 'requestId', 'threadId'].includes(key)) ||
        typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId)) throw error('invalid-request');
    if (durableId(value.threadId) !== boundId) throw error('target-mismatch', 409);
    if (inFlight.has(value.requestId.toLowerCase())) {
      try { return { ok: true, receipt: journal.receipt(value.requestId, boundId) }; }
      catch (cause) { if (cause.code !== 'not-found') throw cause; }
      return { ok: true, receipt: { requestId: value.requestId.toLowerCase(), threadId: boundId, state: 'checking',
        submitted: null, shownInDesktopConversation: false, serverAcknowledged: false, executionConfirmed: false } };
    }
    const requestId = value.requestId.toLowerCase();
    const current = journal.receipt(requestId, boundId);
    if (current.state !== 'unknown' || !acceptingSends || typeof sender.observe !== 'function' ||
        typeof journal.reconciliationContext !== 'function' || typeof journal.assertReadyForReconcile !== 'function')
      return { ok: true, receipt: current };
    if (reconciling.has(requestId)) return reconciling.get(requestId);
    if (activeTargets.has(boundId)) return { ok: true, receipt: current };
    const context = journal.reconciliationContext(requestId, boundId);
    if (!context || !sender.supports(context.baseline.version)) return { ok: true, receipt: current };
    let registered = false, checkCode = null;
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await sender.observe(context, {
          version: context.baseline.version,
          onLocked(helper) { journal.registerChild(helper); registered = true; },
          beforeAck(stage, request, operationId, digest) {
            if (!['observe', 'observe-complete'].includes(stage) || request.requestId !== requestId ||
                operationId !== context.operationId || digest !== context.baselineDigest) throw error('unknown', 503);
            journal.assertReadyForReconcile(requestId, digest);
          },
          onObserved(frame) {
            try { return journal.accept(requestId, frame.observation); }
            catch (cause) { if (!['delivery-proof-unavailable', 'delivery-proof-reused'].includes(cause?.code)) throw cause;
              checkCode = 'history-unavailable';
              return journal.receipt(requestId, context.request.threadId); }
          },
          onFailure() { /* A failed read never resets or authorizes the original send. */ },
          onClose(helper) { if (registered) { journal.unregisterChild(helper, true); registered = false; } }
        });
        return { ok: true, receipt: result, ...(checkCode ? { checkCode, checkMessage: RECEIPT_CHECK_MESSAGES[checkCode] } : {}) };
      } catch (cause) {
        const code = Object.hasOwn(RECEIPT_CHECK_MESSAGES, cause?.code) ? cause.code : 'unknown';
        return { ok: true, receipt: journal.receipt(requestId, context.request.threadId), checkCode: code,
          checkMessage: RECEIPT_CHECK_MESSAGES[code] || 'The receipt check could not be completed. The original send remains unconfirmed; do not resend.' };
      }
    }).finally(() => {
      reconciling.delete(requestId);
      if (activeTargets.get(context.request.threadId) === requestId) activeTargets.delete(context.request.threadId);
    });
    reconciling.set(requestId, operation); activeTargets.set(context.request.threadId, requestId);
    return operation;
  }
  function json(res, statusCode, value) {
    if (res.destroyed) return;
    res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function fail(res, cause) {
    const code = safeCode(cause?.code);
    const statusCode = cause?.status || (['desktop-busy', 'target-mismatch', 'not-connected', 'send-unavailable'].includes(code) ? 409 : 503);
    json(res, statusCode, { ok: false, code, message: MESSAGES[code], submitted: cause?.submitted === null ? null : false });
  }
  function handle(req, res) {
    if (req.method !== 'POST') { fail(res, error('unsupported-method', 405)); return; }
    if (req.headers['x-dsh-dot'] !== '1') { fail(res, error('invalid-source', 403)); return; }
    if (req.__dshE2eeDecrypted !== true || req.headers['x-dsh-e2ee'] !== '1') {
      fail(res, error('encryption-required', 403)); return;
    }
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) throw Error('Origin'); }
      catch (_) { fail(res, error('invalid-source', 403)); return; }
    }
    let size = 0, oversized = false, chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { oversized = true; chunks = []; }
      else if (!oversized) chunks.push(chunk);
    });
    req.on('error', () => fail(res, error('invalid-request')));
    req.on('end', () => {
      if (oversized) { fail(res, error('request-too-large', 413)); return; }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { fail(res, error('invalid-request')); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail(res, error('invalid-request')); return; }
      const operation = value.action === 'send' ? send(value) : value.action === 'receipt' ? receipt(value) :
        value.action === 'status' && Object.keys(value).length === 1 ? status() : snapshot(value);
      operation.then(result => json(res, 200, result)).catch(cause => fail(res, cause));
    });
  }
  return { handle, status, snapshot, send, receipt,
    stopAcceptingSends() { acceptingSends = false; },
    async drainSends() { acceptingSends = false; await Promise.allSettled([...inFlight.values()].map(value => value.operation).concat([...reconciling.values()])); },
    close() { acceptingSends = false; if (inFlight.size || reconciling.size) throw error('desktop-busy', 409); if (journal) journal.close({ allChildrenClosed: true }); } };
}
module.exports = { createDotDesktopService, MAX_BODY_BYTES };
