'use strict';

// Desktop relay journal and independently verified delivery receipts. The GUI
// driver owns native interaction; this service calls only read-only Codex RPCs.
const fs = require('node:fs');
const path = require('node:path');
const target = require('./codex-desktop-target.js');
const { normalizeComposerText, verifyComposerTextProof } = require('./codex-desktop-text.js');
const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['prepared', 'sending', 'unknown', 'accepted', 'failed']);
const TEXT = Object.freeze({
  'invalid-request': 'Invalid desktop relay request.',
  'invalid-thread-id': 'A conversation UUID is required.',
  'invalid-request-id': 'Invalid request ID.',
  'invalid-path': 'An absolute Windows project directory is required.',
  'invalid-text': 'A nonempty plain-text message is required.',
  'unsupported-request': 'This relay version accepts plain text only.',
  'request-id-conflict': 'This request ID belongs to different message content or a different conversation.',
  'wrong-project': 'The requested project does not match the conversation on the computer.',
  'conversation-unavailable': 'The conversation is missing, deleted, or archived.',
  'project-unavailable': 'The conversation project directory is unavailable.',
  'baseline-unavailable': 'Message history could not be checked before sending. Nothing was sent.',
  'desktop-unavailable': 'The Codex desktop window is unavailable.',
  'desktop-busy': 'Another desktop action is in progress. Wait for it to finish and retry.',
  'desktop-stopping': 'Desktop operations are stopped while the gateway shuts down. Nothing new was sent.',
  'draft-present': 'The desktop composer contains a draft. Nothing was sent.',
  'target-mismatch': 'The desktop conversation could not be verified. Nothing was sent.',
  'composer-unavailable': 'The desktop composer is unavailable. Nothing was sent.',
  'send-control-unavailable': 'The desktop send control is unavailable. Nothing was sent.',
  'journal-unavailable': 'The desktop relay journal is unavailable.',
  'delivery-unconfirmed': 'Delivery is not confirmed. Check this receipt instead of sending again.',
  'delivery-ambiguous': 'More than one matching delivery was found. This receipt cannot safely identify the submitted message.',
  'pending-request-exists': 'A previous desktop send for this conversation is unresolved. Check its receipt before sending another message.',
  'previous-queued-delivery': 'An earlier queued message may match this text. Check its receipt before sending.',
  'desktop-target-unconfirmed': 'The desktop send target could not be confirmed after dispatch.',
  'unknown': 'The desktop send result is unknown. This request will not be sent again automatically.',
  'not-found': 'No matching receipt was found.',
  'invalid-source': 'Invalid desktop relay request source.',
  'request-too-large': 'The request exceeds 64 KiB.',
  'unsupported-method': 'Unsupported request method.'
});
function relayError(code, status = 400) { const error = new Error(TEXT[code] || TEXT.unknown); error.code = code; error.status = status; return error; }
function safeCode(code, fallback) { return Object.prototype.hasOwnProperty.call(TEXT, code) ? code : fallback; }
function uncertainCode(code) { return ['unknown', 'delivery-unconfirmed', 'delivery-ambiguous', 'desktop-target-unconfirmed'].includes(code) ? code : 'unknown'; }
function proofKey(kind, id, itemId) { return JSON.stringify([kind, id, itemId]); }
function validItemId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }
function threadId(value) { if (typeof value !== 'string' || !UUID.test(value)) throw relayError('invalid-thread-id'); return value.toLowerCase(); }
function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['action', 'id', 'requestId', 'threadId', 'cwd', 'text'].includes(key)) ||
      (value.action !== undefined && value.action !== 'send') ||
      (value.id !== undefined && value.requestId !== undefined && value.id !== value.requestId)) throw relayError('invalid-request');
  try { return target.validateDesktopRequest({ requestId: value.id === undefined ? value.requestId : value.id,
    threadId: threadId(value.threadId), cwd: value.cwd, text: value.text }); }
  catch (error) { if (error.status) throw error; throw relayError(safeCode(error.code, 'invalid-request')); }
}
function unsupportedQueue(error) {
  return error && (Number(error.code) === -32601 || /(?:method (?:not found|is not supported)|unknown method|unrecognized method|unsupported method)/i.test(error.message || ''));
}
function exactText(input, text) { return Array.isArray(input) && input.length === 1 && input[0]?.type === 'text' && input[0].text === text; }
const DESKTOP_FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';
const TESTED_NATIVE_LF_VERSION = '26.928.3736.0';
function verifiedNativeSubmission(value, requestedText) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      Object.keys(value).some(key => !['packageFamilyName', 'version', 'composerTextProof'].includes(key)) ||
      value.packageFamilyName !== DESKTOP_FAMILY || typeof value.version !== 'string' || value.version.length > 40 ||
      value.version.split('.').length !== 4 || value.version.split('.').some(part => !part || /\D/.test(part))) return null;
  const proof = verifyComposerTextProof(value.composerTextProof, requestedText);
  return proof ? { packageFamilyName: DESKTOP_FAMILY, version: value.version, composerTextProof: proof } : null;
}
function dispatchedTextMatches(input, record) {
  if (exactText(input, record.request.text)) return true;
  const native = verifiedNativeSubmission(record.nativeSubmission, record.request.text);
  if (!native || native.version !== TESTED_NATIVE_LF_VERSION) return false;
  const copiedText = normalizeComposerText(record.request.text);
  // Actual paired native evidence: clipboard readback preserves the user's
  // text, while this exact desktop build persists one additional final LF.
  // Compare complete strings, retaining all original spaces and real newlines.
  return exactText(input, copiedText) || exactText(input, copiedText + '\n');
}
function dispatchTextVariants(record, prospective = false) {
  // Reservation is deliberately more conservative than receipt acceptance:
  // retain the original CRLF-equivalence protection even for legacy journals
  // without a native proof. This must never enable unproved history matching.
  const copiedText = normalizeComposerText(record.request.text);
  const variants = new Set([record.request.text, copiedText]);
  const native = verifiedNativeSubmission(record.nativeSubmission, record.request.text);
  if (prospective || (native && native.version === TESTED_NATIVE_LF_VERSION)) {
    variants.add(copiedText + '\n');
  }
  return variants;
}
function pendingQueuedTextOverlaps(previous, next) {
  // Before dispatch the next request has no clipboard proof yet. Reserve its
  // bounded possible native forms conservatively, including the one-LF form,
  // so neither direction of a real-final-newline overlap can steal a prior
  // queued message's later history ID. Compare full strings; never trim.
  const potential = dispatchTextVariants(next, true);
  return [...dispatchTextVariants(previous)].some(text => potential.has(text));
}

function createDesktopRelayService(base, dependencies) {
  const { rpc, driver } = dependencies || {};
  if (typeof rpc !== 'function' || !driver || typeof driver.inspect !== 'function' || typeof driver.send !== 'function') throw Error('Desktop relay requires rpc and driver.');
  const confirmTimeoutMs = Math.max(1, Math.min(10000, dependencies.confirmTimeoutMs || 10000));
  const pollIntervalMs = Math.max(1, Math.min(1000, dependencies.pollIntervalMs || 200));
  const file = path.join(base, 'logs', 'codex-desktop-relay.json');
  const records = new Map(), reconciling = new Map(), proofOwners = new Map();
  let tail = Promise.resolve(), loadError = null, stopping = false, drainPromise = null;
  const ownedReads = new Set();
  function ownRead(operation) {
    const result = Promise.resolve().then(operation);
    ownedReads.add(result);
    result.finally(() => ownedReads.delete(result)).catch(() => {});
    return result;
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, records: [...records.values()] }));
      fs.renameSync(file + '.tmp', file);
    } catch (_) { loadError = 'journal-unavailable'; throw relayError(loadError, 503); }
  }
  if (fs.existsSync(file)) {
    try {
      const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (journal.version !== 1 || !Array.isArray(journal.records)) throw Error('Invalid journal');
      let recovered = false;
      for (const record of journal.records) {
        const request = normalizeRequest(record.request);
        if (records.has(request.requestId) || record.requestId !== request.requestId || record.threadId !== request.threadId ||
            record.fingerprint !== target.requestFingerprint(request) || !STATES.has(record.state)) throw Error('Invalid journal record');
        record.request = request;
        if (record.state === 'prepared' || record.state === 'sending') {
          record.state = 'unknown'; record.code = 'unknown'; record.at = Date.now(); recovered = true;
        }
        if (record.state === 'accepted') {
          if (!['message', 'queued'].includes(record.delivery) ||
              !validItemId(record.delivery === 'message' ? record.messageId : record.queueId)) throw Error('Invalid delivery proof');
          for (const [kind, key] of [['message', 'messageId'], ['queue', 'queueId']]) if (record[key] !== undefined) {
            if (!validItemId(record[key])) throw Error('Invalid proof ID');
            const ownerKey = proofKey(kind, record.threadId, record[key]);
            if (proofOwners.has(ownerKey)) throw Error('Delivery proof reused');
            proofOwners.set(ownerKey, record.requestId);
          }
        }
        if (record.baseline && (!Array.isArray(record.baseline.userIds) || !Array.isArray(record.baseline.queueIds) ||
            !record.baseline.userIds.every(validItemId) || !record.baseline.queueIds.every(validItemId) ||
            typeof record.baseline.queueSupported !== 'boolean')) throw Error('Invalid delivery baseline');
        if (record.nativeSubmission !== undefined) {
          const native = verifiedNativeSubmission(record.nativeSubmission, request.text);
          if (!native) throw Error('Invalid native text proof');
          record.nativeSubmission = native;
        }
        records.set(request.requestId, record);
      }
      if (recovered) save();
    } catch (_) { loadError = 'journal-unavailable'; }
  }
  function publicReceipt(record) {
    const result = { ok: record.state !== 'unknown' && record.state !== 'failed', requestId: record.requestId,
      threadId: record.threadId, state: record.state, at: record.at,
      delivery: record.delivery || null, deliveryConfirmed: record.state === 'accepted', executionConfirmed: false };
    for (const key of ['queueId', 'messageId', 'turnId']) if (typeof record[key] === 'string') result[key] = record[key];
    for (const key of ['desktopDraftRemaining', 'desktopDraftCleared']) if (typeof record[key] === 'boolean') result[key] = record[key];
    if (record.code) {
      result.code = record.state === 'unknown' ? uncertainCode(record.code) : safeCode(record.code, 'unknown');
      result.message = TEXT[result.code];
    }
    return result;
  }
  function setState(record, state, code, proof) {
    if (state === 'accepted' && proof) {
      for (const [kind, key] of [['message', 'messageId'], ['queue', 'queueId']]) if (proof[key]) {
        const ownerKey = proofKey(kind, record.threadId, proof[key]), owner = proofOwners.get(ownerKey);
        if (!validItemId(proof[key]) || (owner && owner !== record.requestId)) throw relayError('delivery-ambiguous', 409);
        proofOwners.set(ownerKey, record.requestId);
      }
    }
    record.state = state; record.at = Date.now();
    if (code) record.code = safeCode(code, 'unknown'); else delete record.code;
    if (proof) Object.assign(record, proof);
    save(); return publicReceipt(record);
  }
  function status() { return ownRead(inspectStatus); }
  async function inspectStatus() {
    if (loadError) return { available: false, reason: 'journal-unavailable' };
    if (stopping) return { available: false, reason: 'desktop-stopping' };
    try {
      const result = await driver.inspect();
      const response = { available: result?.available === true, reason: result?.available === true ? 'ready' : safeCode(result?.code || result?.reason, 'desktop-unavailable') };
      if (typeof result?.desktopRunning === 'boolean') response.desktopRunning = result.desktopRunning;
      if (typeof result?.version === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]{1,24})?$/.test(result.version)) response.version = result.version;
      return response;
    } catch (_) { return { available: false, reason: 'desktop-unavailable' }; }
  }
  async function boundedRpc(method, params, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw relayError('delivery-unconfirmed', 504);
    let timer;
    try { return await Promise.race([Promise.resolve().then(() => rpc(method, params)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(relayError('delivery-unconfirmed', 504)), remaining); })]); }
    finally { clearTimeout(timer); }
  }
  async function history(id, deadline) {
    const result = await boundedRpc('thread/turns/list', { threadId: id, limit: 10, sortDirection: 'desc', itemsView: 'full' }, deadline);
    if (!result || !Array.isArray(result.data)) throw relayError('baseline-unavailable', 503);
    const users = [];
    for (const turn of result.data) {
      if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items) || (turn.itemsView && turn.itemsView !== 'full')) throw relayError('baseline-unavailable', 503);
      for (const item of turn.items) if (item?.type === 'userMessage') {
        if (!validItemId(item.id) || !Array.isArray(item.content)) throw relayError('baseline-unavailable', 503);
        users.push({ id: item.id, input: item.content, turnId: turn.id });
      }
    }
    return users;
  }
  async function queue(id, deadline) {
    const result = [], cursors = new Set(); let cursor;
    for (let page = 0; page < 5; page++) {
      const params = { threadId: id, limit: 100 }; if (cursor) params.cursor = cursor;
      const response = await boundedRpc('thread/queue/list', params, deadline);
      if (!response || !Array.isArray(response.data)) throw relayError('baseline-unavailable', 503);
      for (const item of response.data) {
        if (!item || !validItemId(item.id) || !Array.isArray(item.input)) throw relayError('baseline-unavailable', 503);
        result.push(item);
      }
      if (!response.nextCursor) return result;
      if (typeof response.nextCursor !== 'string' || cursors.has(response.nextCursor)) throw relayError('baseline-unavailable', 503);
      cursor = response.nextCursor; cursors.add(cursor);
    }
    throw relayError('baseline-unavailable', 503);
  }
  async function baseline(id) {
    const deadline = Date.now() + 10000;
    const results = await Promise.allSettled([history(id, deadline), queue(id, deadline)]);
    if (results[0].status !== 'fulfilled') throw relayError('baseline-unavailable', 503);
    let queueSupported = true, queued = [];
    if (results[1].status === 'fulfilled') queued = results[1].value;
    else if (unsupportedQueue(results[1].reason)) queueSupported = false;
    else throw relayError('baseline-unavailable', 503);
    return { userIds: results[0].value.map(item => item.id), queueIds: queued.map(item => item.id), queueSupported };
  }
  async function authoritativeProject(request) {
    let response;
    try { response = await boundedRpc('thread/read', { threadId: request.threadId, includeTurns: false }, Date.now() + 10000); }
    catch (_) { throw relayError('conversation-unavailable', 409); }
    const thread = response?.thread;
    if (!thread || thread.id !== request.threadId || thread.archived === true || thread.deleted === true ||
        ['archived', 'deleted'].includes(thread.status?.type) ||
        (typeof thread.path === 'string' && thread.path.split(/[\\/]/).some(segment => segment.toLowerCase() === 'archived_sessions')))
      throw relayError('conversation-unavailable', 409);
    try {
      const real = fs.realpathSync.native || fs.realpathSync;
      const actualCwd = real(target.canonicalWindowsPath(thread.cwd));
      const claimedCwd = real(request.cwd);
      if (!fs.statSync(actualCwd).isDirectory() || !fs.statSync(claimedCwd).isDirectory()) throw relayError('project-unavailable', 409);
      if (!target.sameWindowsPath(actualCwd, claimedCwd)) throw relayError('wrong-project', 409);
      return target.canonicalWindowsPath(actualCwd);
    } catch (error) { if (error.code === 'wrong-project') throw error; throw relayError('project-unavailable', 409); }
  }
  function unclaimedMatches(items, kind, oldIds, record) {
    return items.filter(item => !oldIds.has(item.id) && dispatchedTextMatches(item.input, record) &&
      (!proofOwners.has(proofKey(kind, record.threadId, item.id)) ||
       proofOwners.get(proofKey(kind, record.threadId, item.id)) === record.requestId));
  }
  // Queued delivery is not yet a history message. Reserve every proven full
  // text variant until one unique new history item can be claimed by it.
  async function promoteQueued(record) {
    if (record.state !== 'accepted' || record.delivery !== 'queued' || !record.baseline) return publicReceipt(record);
    try {
      const messages = unclaimedMatches(await history(record.threadId, Date.now() + Math.min(3000, confirmTimeoutMs)),
        'message', new Set(record.baseline.userIds), record);
      if (messages.length === 1) return setState(record, 'accepted', null,
        { delivery: 'message', messageId: messages[0].id, turnId: messages[0].turnId });
    } catch (_) { /* A queue receipt remains valid; promotion is unconfirmed. */ }
    return publicReceipt(record);
  }
  async function confirm(record, oneRead = false) {
    if (!record.baseline || record.blockedReconcile) return publicReceipt(record);
    const deadline = Date.now() + (oneRead ? Math.min(3000, confirmTimeoutMs) : confirmTimeoutMs);
    const oldUsers = new Set(record.baseline.userIds), oldQueue = new Set(record.baseline.queueIds);
    let ambiguous = false;
    do {
      const reads = await Promise.allSettled([history(record.threadId, deadline),
        record.baseline.queueSupported ? queue(record.threadId, deadline) : Promise.resolve([])]);
      const messages = reads[0].status === 'fulfilled' ? unclaimedMatches(reads[0].value, 'message', oldUsers, record) : [];
      const queued = reads[1].status === 'fulfilled' ? unclaimedMatches(reads[1].value, 'queue', oldQueue, record) : [];
      ambiguous = messages.length + queued.length > 1;
      if (!ambiguous && messages.length === 1) return setState(record, 'accepted', null,
        { delivery: 'message', messageId: messages[0].id, turnId: messages[0].turnId });
      if (!ambiguous && queued.length === 1) return setState(record, 'accepted', null, { delivery: 'queued', queueId: queued[0].id });
      if (oneRead || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
    if (record.state === 'accepted') return publicReceipt(record);
    return setState(record, 'unknown', ambiguous ? 'delivery-ambiguous' : record.code || 'delivery-unconfirmed');
  }
  async function execute(record) {
    try {
      const available = await status();
      if (!available.available) return setState(record, 'failed', available.reason);
      record.canonicalCwd = await authoritativeProject(record.request);
      for (const previous of records.values()) if (previous !== record && previous.threadId === record.threadId &&
          previous.state === 'accepted' && previous.delivery === 'queued' && pendingQueuedTextOverlaps(previous, record)) {
        await promoteQueued(previous);
        if (previous.delivery === 'queued') return setState(record, 'failed', 'previous-queued-delivery');
      }
      record.baseline = await baseline(record.threadId);
      save();
    } catch (error) { return setState(record, 'failed', safeCode(error.code, 'baseline-unavailable')); }
    // A request admitted before shutdown can finish its read-only baseline,
    // but may not start a new native send after the admission boundary.
    if (stopping) return setState(record, 'failed', 'desktop-stopping');
    setState(record, 'sending');
    try {
      const result = await driver.send({ ...record.request, cwd: record.canonicalCwd });
      for (const key of ['desktopDraftRemaining', 'desktopDraftCleared']) if (typeof result?.[key] === 'boolean') record[key] = result[key];
      if (result?.submitted !== true) return setState(record, result?.submitted === false ? 'failed' : 'unknown',
        result?.submitted === false ? safeCode(result?.code, 'unknown') : uncertainCode(result?.code));
      let sameCwd = false;
      try { sameCwd = target.sameWindowsPath((fs.realpathSync.native || fs.realpathSync)(result.actualCwd), record.canonicalCwd); } catch (_) { }
      if (result.verifiedThreadId !== record.threadId || !sameCwd) {
        record.blockedReconcile = true; return setState(record, 'unknown', 'desktop-target-unconfirmed');
      }
      if (result.composerTextProof !== undefined) {
        if (!verifyComposerTextProof(result.composerTextProof, record.request.text)) {
          record.blockedReconcile = true;
          return setState(record, 'unknown', 'desktop-target-unconfirmed');
        }
        const native = verifiedNativeSubmission({ packageFamilyName: result.desktopIdentity?.packageFamilyName,
          version: result.desktopIdentity?.version, composerTextProof: result.composerTextProof }, record.request.text);
        if (native) {
          record.nativeSubmission = native;
          // Save the bounded clipboard/version proof before confirmation so a
          // restart can reconcile by read-only history, never by sending again.
          save();
        }
      }
      return await confirm(record);
    } catch (error) {
      if (record.state === 'accepted') return publicReceipt(record);
      for (const key of ['desktopDraftRemaining', 'desktopDraftCleared']) if (typeof error?.[key] === 'boolean') record[key] = error[key];
      return setState(record, error.submitted === false ? 'failed' : 'unknown',
        error.submitted === false ? safeCode(error.code, 'unknown') : uncertainCode(error.code));
    }
  }
  async function send(value) {
    if (stopping) throw relayError('desktop-stopping', 503);
    if (loadError) throw relayError(loadError, 503);
    const request = normalizeRequest(value), existing = records.get(request.requestId);
    if (existing) {
      try { target.checkDuplicateRequest(request, existing); }
      catch (_) { throw relayError('request-id-conflict', 409); }
      return publicReceipt(existing);
    }
    if ([...records.values()].some(record => record.threadId === request.threadId &&
        ['prepared', 'sending', 'unknown'].includes(record.state))) throw relayError('pending-request-exists', 409);
    const record = { requestId: request.requestId, threadId: request.threadId, request,
      fingerprint: target.requestFingerprint(request), state: 'prepared', at: Date.now(), baseline: null };
    records.set(record.requestId, record); save();
    const operation = tail.then(() => execute(record));
    tail = operation.catch(() => {});
    return operation;
  }
  function get(id, expectedThreadId) { return ownRead(() => readReceipt(id, expectedThreadId)); }
  async function readReceipt(id, expectedThreadId) {
    if (loadError) throw relayError(loadError, 503);
    const expected = threadId(expectedThreadId);
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id)) throw relayError('invalid-request-id');
    const record = records.get(id);
    if (!record || record.threadId !== expected) return null;
    // Existing receipts remain readable while health stays up. Shutdown does
    // not start fresh reconciliation or mutate an uncertain delivery.
    if (stopping) return publicReceipt(record);
    if (record.state === 'accepted' && record.delivery === 'queued') return promoteQueued(record);
    if (record.state === 'unknown' && record.baseline && !record.blockedReconcile) {
      if (!reconciling.has(id)) {
        const operation = confirm(record, true).finally(() => { if (reconciling.get(id) === operation) reconciling.delete(id); });
        reconciling.set(id, operation);
      }
      return reconciling.get(id);
    }
    return publicReceipt(record);
  }
  function json(res, code, body) {
    if (res.destroyed) return;
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function fail(res, error) { const code = safeCode(error.code, 'unknown'); json(res, error.status || 500, { ok: false, code, message: TEXT[code] }); }
  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET') {
      if (url.searchParams.has('id') || url.searchParams.has('requestId'))
        get(url.searchParams.get('id') || url.searchParams.get('requestId'), url.searchParams.get('threadId'))
          .then(receipt => receipt ? json(res, 200, receipt) : json(res, 404, { ok: false, code: 'not-found', message: TEXT['not-found'] })).catch(error => fail(res, error));
      else status().then(result => json(res, 200, result)).catch(error => fail(res, error));
      return;
    }
    if (req.method !== 'POST') { fail(res, relayError('unsupported-method', 405)); return; }
    if (req.headers['x-dsh-desktop-relay'] !== '1') { fail(res, relayError('invalid-source', 403)); return; }
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) throw Error('Mismatch'); }
      catch (_) { fail(res, relayError('invalid-source', 403)); return; }
    }
    let size = 0, oversized = false, chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY_BYTES) { oversized = true; chunks = []; } else if (!oversized) chunks.push(chunk); });
    req.on('end', () => {
      if (oversized) { fail(res, relayError('request-too-large', 413)); return; }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { fail(res, relayError('invalid-request')); return; }
      if (body?.action !== 'send') { fail(res, relayError('invalid-request')); return; }
      send(body).then(receipt => json(res, receipt.state === 'accepted' ? 200 : receipt.state === 'failed' ? 409 : 202, receipt)).catch(error => fail(res, error));
    });
  }
  function stop() { stopping = true; return { stopped: true }; }
  function drain() {
    stop();
    if (!drainPromise) drainPromise = (async () => {
      // The full send tail includes final history polling and receipt writes,
      // rather than only the GUI child's submission result. Owned reads cover
      // status inspection and reconciliation already admitted before stop.
      await Promise.allSettled([tail, ...ownedReads]);
      if (loadError) throw relayError(loadError, 503);
      return { drained: true };
    })();
    return drainPromise;
  }
  return { handle, status, send, get, stop, drain };
}

module.exports = { createDesktopRelayService, MAX_BODY_BYTES };
