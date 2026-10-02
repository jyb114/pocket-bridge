'use strict';
// Closed protocol for the independent native Dot adapter. A desktop row is
// only evidence of display in the intended app, never an official server ACK.
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const RUNTIME = /^-?\d+(?:,-?\d+){0,31}$/;
const FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';
const failure = code => Object.assign(new Error(code), { code, submitted: null });
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const contextKeys = ['threadId', 'hostId', 'packageFamilyName', 'version', 'windowHandle', 'processId',
  'creationTicks', 'viewportRuntimeId', 'messageListRuntimeId', 'contextGeneration'];
function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['requestId', 'threadId', 'text'].includes(key)) ||
      !UUID.test(value.requestId || '') || !UUID.test(value.threadId || '') ||
      typeof value.text !== 'string' || !value.text.length || value.text.includes('\0') ||
      value.text.length > 16000 || Buffer.byteLength(value.text) > 16000) throw failure('invalid-request');
  return { requestId: value.requestId.toLowerCase(), threadId: value.threadId.toLowerCase(), text: value.text };
}
function fingerprint(request) { return sha(JSON.stringify([request.threadId, request.text])); }
function contextGeneration(value) {
  return sha(JSON.stringify([value.threadId, value.processId, value.creationTicks, value.windowHandle,
    value.viewportRuntimeId, value.messageListRuntimeId]));
}
function context(value) {
  return !!value && value.hostId === 'durable' && UUID.test(value.threadId || '') &&
    value.packageFamilyName === FAMILY && /^\d+(?:\.\d+){3}$/.test(value.version || '') &&
    typeof value.windowHandle === 'string' && /^[1-9]\d{0,19}$/.test(value.windowHandle) &&
    Number.isSafeInteger(value.processId) && value.processId > 0 &&
    typeof value.creationTicks === 'string' && /^[1-9]\d{0,19}$/.test(value.creationTicks) &&
    ['viewportRuntimeId', 'messageListRuntimeId'].every(key => typeof value[key] === 'string' &&
      value[key].length <= 256 && RUNTIME.test(value[key])) && HASH.test(value.contextGeneration || '') &&
    value.contextGeneration === contextGeneration(value);
}
function validRows(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) return false;
  const ids = new Set();
  return value.every(row => {
    if (!row || Object.keys(row).some(key => !['observationId', 'role', 'textSha256'].includes(key)) ||
        !HASH.test(row.observationId || '') || ids.has(row.observationId) ||
        !['user', 'assistant'].includes(row.role) || !HASH.test(row.textSha256 || '')) return false;
    ids.add(row.observationId); return true;
  });
}
function observation(value, request, operationId, maximumRows) {
  return context(value) && value.schemaVersion === 1 && value.requestId === request.requestId &&
    value.operationId === operationId && value.requestFingerprint === fingerprint(request) &&
    value.threadId === request.threadId && validRows(value.rows, maximumRows) &&
    Number.isSafeInteger(value.observationSequence) && value.observationSequence > 0 &&
    Number.isSafeInteger(value.observedAt) && value.observedAt > 0 &&
    value.materializedRowCount === value.rows.length && value.completeMaterializedScope === true &&
    value.settled === true && Array.isArray(value.viewportBounds) && value.viewportBounds.length === 4 &&
    value.viewportBounds.every(n => Number.isFinite(n) && Math.abs(n) < 100000) &&
    value.viewportBounds[2] > 0 && value.viewportBounds[3] > 0;
}
function normalizeObservation(value, request, operationId, maximumRows = 40) {
  if (!observation(value, request, operationId, maximumRows)) throw failure('baseline-unavailable');
  // Retain only the closed technical schema. Accessibility strings/drafts are
  // never copied into a public receipt or accepted as arbitrary proof fields.
  const result = {};
  for (const key of ['schemaVersion', 'requestId', 'operationId', 'requestFingerprint', ...contextKeys,
    'observationSequence', 'observedAt', 'materializedRowCount', 'completeMaterializedScope', 'settled']) result[key] = value[key];
  result.viewportBounds = value.viewportBounds.slice();
  result.rows = value.rows.map(row => ({ observationId: row.observationId, role: row.role, textSha256: row.textSha256 }));
  return result;
}
function baselineDigest(baseline) { return sha(JSON.stringify(baseline)); }
function verifyFreshDesktopRow(baseline, afterValue, request, operationId) {
  let after;
  try { baseline = normalizeObservation(baseline, request, operationId); after = normalizeObservation(afterValue, request, operationId, 45); }
  catch (_) { return null; }
  if (contextKeys.some(key => baseline[key] !== after[key]) ||
      after.observationSequence <= baseline.observationSequence ||
      JSON.stringify(baseline.viewportBounds) !== JSON.stringify(after.viewportBounds) ||
      after.rows.length <= baseline.rows.length || after.rows.length > baseline.rows.length + 5) return null;
  for (let index = 0; index < baseline.rows.length; index++) {
    if (JSON.stringify(baseline.rows[index]) !== JSON.stringify(after.rows[index])) return null;
  }
  const appended = after.rows.slice(baseline.rows.length), users = appended.filter(row => row.role === 'user');
  // Another user action invalidates attribution even if only one row matches.
  if (users.length !== 1 || appended[0] !== users[0] || users[0].textSha256 !== sha(request.text)) return null;
  return { kind: 'desktop-row', requestId: request.requestId, operationId, requestFingerprint: fingerprint(request),
    baselineDigest: baselineDigest(baseline), observationId: users[0].observationId,
    contextGeneration: baseline.contextGeneration, threadId: request.threadId,
    observedAt: after.observedAt, observationSequence: after.observationSequence,
    serverAcknowledged: false, executionConfirmed: false, stableOfficialMessageId: false };
}
function proofOwnerKey(value) { return JSON.stringify([value.threadId, value.contextGeneration, value.observationId]); }
function frame(value, request, operationId, expectedSequence, expectedStage, expectedBaseline) {
  const fields = { locked: ['helper'], prepared: ['baseline', 'baselineDigest'],
    'ready-to-send': ['baselineDigest', 'composerTextHash'],
    result: ['baselineDigest', 'observation', 'submitted', 'code', 'draftCleared', 'draftRemaining'] };
  const allowed = fields[expectedStage];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== 1 ||
      !allowed || !UUID.test(operationId || '') || !UUID.test(value.operationId || '') ||
      !Number.isSafeInteger(expectedSequence) || expectedSequence < 1 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      value.operationId !== operationId || value.requestId !== request.requestId ||
      value.requestFingerprint !== fingerprint(request) || value.sequence !== expectedSequence ||
      value.stage !== expectedStage || Object.keys(value).some(key =>
        !['protocol', 'operationId', 'requestId', 'requestFingerprint', 'sequence', 'stage', ...allowed].includes(key)))
    throw failure('native-protocol-error');
  if (expectedStage === 'locked' && (!value.helper || Object.keys(value.helper).length !== 2 ||
      !Number.isSafeInteger(value.helper.pid) || value.helper.pid <= 0 ||
      typeof value.helper.creationTicks !== 'string' || !/^[1-9]\d{0,19}$/.test(value.helper.creationTicks)))
    throw failure('native-protocol-error');
  if (expectedStage === 'prepared') {
    const normalized = normalizeObservation(value.baseline, request, operationId);
    if (value.baselineDigest !== baselineDigest(normalized)) throw failure('native-protocol-error');
  }
  if (['ready-to-send', 'result'].includes(expectedStage)) {
    if (!expectedBaseline || value.baselineDigest !== baselineDigest(normalizeObservation(expectedBaseline, request, operationId)))
      throw failure('native-protocol-error');
  }
  if (expectedStage === 'ready-to-send' && value.composerTextHash !== sha(request.text)) throw failure('native-protocol-error');
  if (expectedStage === 'result' && ![true, false, null].includes(value.submitted)) throw failure('native-protocol-error');
  return value;
}
function acknowledgement(request, operationId, sequence, stage, baseline) {
  if (!UUID.test(operationId || '') || !Number.isSafeInteger(sequence) || sequence < 1 ||
      !['continue-preflight', 'paste', 'invoke'].includes(stage)) throw failure('native-protocol-error');
  let digest = null;
  if (stage !== 'continue-preflight') digest = baselineDigest(normalizeObservation(baseline, request, operationId));
  else if (baseline != null) throw failure('native-protocol-error');
  return { protocol: 1, operationId, requestId: request.requestId, requestFingerprint: fingerprint(request),
    sequence, stage, baselineDigest: digest };
}
function failureFrame(value, request, operationId, expectedSequence, baseline) {
  const allowed = ['protocol', 'operationId', 'requestId', 'requestFingerprint', 'sequence', 'stage',
    'code', 'submitted', 'baselineDigest', 'draftRemaining'];
  if (!value || Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key)) ||
      value.protocol !== 1 || !UUID.test(operationId || '') || value.operationId !== operationId ||
      value.requestId !== request.requestId || value.requestFingerprint !== fingerprint(request) ||
      !Number.isSafeInteger(expectedSequence) || expectedSequence < 1 || value.sequence !== expectedSequence ||
      value.stage !== 'error' || ![false, null].includes(value.submitted) || typeof value.draftRemaining !== 'boolean' ||
      typeof value.code !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.code) ||
      value.baselineDigest !== (baseline ? baselineDigest(baseline) : null)) throw failure('native-protocol-error');
  return value;
}
module.exports = { normalizeRequest, fingerprint, contextGeneration, normalizeObservation, baselineDigest,
  verifyFreshDesktopRow, proofOwnerKey, frame, failureFrame, acknowledgement, sha };
