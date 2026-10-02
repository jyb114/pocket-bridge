'use strict';

// Pure checks for the text-only desktop relay. This module never enumerates
// processes, controls windows, reads a clipboard, or sends a Codex message.
// The caller must resolve cwd/exe through its trusted Windows filesystem and
// collect fresh process/window metadata. Path normalization here does not
// resolve filesystem junctions or attest the publisher of an executable.
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TEXT_BYTES = 64 * 1024;
const DEFAULT_PREFLIGHT_AGE_MS = 5000;
const RECEIPT_STATES = Object.freeze(['prepared', 'submitted', 'accepted', 'running', 'completed', 'unknown', 'failed']);

class DesktopTargetError extends Error {
  constructor(code, message) { super(message); this.name = 'DesktopTargetError'; this.code = code; }
}
function refuse(code, message) { throw new DesktopTargetError(code, message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('invalid-' + label, 'Invalid ' + label + '.');
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value) || value.includes('..'))
    refuse('invalid-' + label, 'Invalid ' + label + '.');
  return value;
}

/** Compare already-resolved Windows paths, including native realpath prefixes. */
function canonicalWindowsPath(value) {
  if (typeof value !== 'string' || !value || value.length > 32767 || value !== value.trim() || /[\u0000-\u001f]/.test(value))
    refuse('invalid-path', 'An absolute Windows path is required.');
  let input = value.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(input)) input = '\\\\' + input.slice(8);
  else if (/^\\\\\?\\[A-Za-z]:\\/.test(input)) input = input.slice(4);
  if (/^\\\\[?.]\\/.test(input)) refuse('invalid-path', 'Windows device namespaces are not project paths.');
  if (!/^[A-Za-z]:\\/.test(input) && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(input))
    refuse('invalid-path', 'An absolute drive or UNC path is required.');
  const root = path.win32.parse(input).root;
  if (/[<>"|?*]/.test(input) || input.slice(root.length).includes(':') || (input.startsWith('\\\\') && root.includes(':')))
    refuse('invalid-path', 'Unsupported Windows path syntax.');
  // Trailing dots/spaces are aliases under ordinary Win32 file operations.
  // Accept dot traversal only so path.normalize can remove it explicitly.
  if (input.split('\\').some(part => part && part !== '.' && part !== '..' && /[. ]$/.test(part)))
    refuse('invalid-path', 'Ambiguous Windows path components are not accepted.');
  let result = path.win32.normalize(input);
  while (result.length > path.win32.parse(result).root.length && result.endsWith('\\')) result = result.slice(0, -1);
  if (/^[a-z]:/.test(result)) result = result[0].toUpperCase() + result.slice(1);
  return result;
}
function windowsPathKey(value) { return canonicalWindowsPath(value).toLowerCase(); }
function sameWindowsPath(left, right) { return windowsPathKey(left) === windowsPathKey(right); }

function validateDesktopRequest(value) {
  object(value, 'request');
  if (Object.keys(value).some(key => !['requestId', 'threadId', 'cwd', 'text'].includes(key)))
    refuse('unsupported-request', 'Desktop relay version 1 accepts only a target conversation and plain text.');
  const requestId = id(value.requestId, 'request-id');
  const threadId = id(value.threadId, 'thread-id');
  const cwd = canonicalWindowsPath(value.cwd);
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.includes('\0') || Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES)
    refuse('invalid-text', 'A nonempty plain-text message of at most 64 KiB is required.');
  return Object.freeze({ requestId, threadId, cwd, text: value.text });
}
function pid(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) refuse('invalid-' + label, 'Invalid ' + label + '.');
  return value;
}
function windowHandle(value) {
  let raw = value;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) refuse('invalid-window', 'The window handle must not lose integer precision.');
    raw = String(raw);
  }
  if (typeof raw !== 'string' || !/^(?:[1-9]\d*|0x[0-9a-f]+)$/i.test(raw)) refuse('invalid-window', 'Invalid window handle.');
  let handle;
  try { handle = BigInt(raw); } catch (_) { refuse('invalid-window', 'Invalid window handle.'); }
  if (handle < 1n || handle > 0xffffffffffffffffn) refuse('invalid-window', 'Invalid window handle.');
  return handle.toString(10);
}
function timestamp(value, label) {
  const ms = typeof value === 'number' ? value :
    typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 1 || !Number.isFinite(new Date(ms).getTime())) refuse('invalid-' + label, 'Invalid ' + label + '.');
  return ms;
}

/** target must be collected on the computer, never accepted from the phone. */
function validateDesktopTarget(value) {
  object(value, 'target');
  const exe = canonicalWindowsPath(value.exe);
  if (path.win32.basename(exe).toLowerCase() !== 'chatgpt.exe')
    refuse('wrong-application', 'The target must be the verified Codex desktop window, not its app-server or another application.');
  const processId = pid(value.pid, 'process');
  const windowPid = pid(value.windowPid, 'window-process');
  if (windowPid !== processId) refuse('window-process-mismatch', 'The target window belongs to another process.');
  return Object.freeze({ exe, pid: processId, processStartedAt: timestamp(value.processStartedAt, 'process-start'),
    hwnd: windowHandle(value.hwnd), windowPid, cwd: canonicalWindowsPath(value.cwd) });
}

/** Call immediately before typing and again before sending, after navigation. */
function preflightDesktopTarget(requestValue, targetValue, evidence, options = {}) {
  const request = validateDesktopRequest(requestValue), target = validateDesktopTarget(targetValue);
  object(evidence, 'preflight');
  const now = options.now === undefined ? Date.now() : timestamp(options.now, 'current-time');
  const maxAgeMs = options.maxAgeMs === undefined ? DEFAULT_PREFLIGHT_AGE_MS : options.maxAgeMs;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 30000) refuse('invalid-freshness', 'Invalid preflight freshness limit.');
  const observedAt = timestamp(evidence.observedAt, 'observation-time');
  if (observedAt > now || now - observedAt > maxAgeMs) refuse('stale-preflight', 'Desktop identity must be checked again immediately before sending.');
  if (evidence.processAlive !== true || evidence.windowExists !== true) refuse('desktop-unavailable', 'The selected desktop process or window is no longer available.');
  const actual = validateDesktopTarget({ ...evidence, cwd: evidence.actualCwd });
  if (actual.pid !== target.pid || actual.processStartedAt !== target.processStartedAt || actual.hwnd !== target.hwnd ||
      actual.windowPid !== target.windowPid || !sameWindowsPath(actual.exe, target.exe))
    refuse('desktop-identity-changed', 'The selected desktop process or window has changed.');
  if (evidence.verifiedThreadId !== request.threadId)
    refuse('wrong-conversation', 'Desktop conversation ID does not match the requested conversation. A title match is insufficient.');
  if (!sameWindowsPath(target.cwd, request.cwd) || !sameWindowsPath(actual.cwd, request.cwd))
    refuse('wrong-project', 'Desktop project does not match the requested project.');
  return Object.freeze({ ok: true, request, target, observedAt });
}

function requestFingerprint(value) {
  const request = validateDesktopRequest(value);
  return crypto.createHash('sha256').update(JSON.stringify([request.threadId, windowsPathKey(request.cwd), request.text])).digest('hex');
}
/** Existing journal data must be read before any desktop side effect. */
function checkDuplicateRequest(value, existing) {
  const request = validateDesktopRequest(value), fingerprint = requestFingerprint(request);
  if (existing == null) return Object.freeze({ duplicate: false, fingerprint });
  object(existing, 'receipt');
  if (existing.requestId !== request.requestId || existing.fingerprint !== fingerprint)
    refuse('request-id-conflict', 'This request ID is already bound to different message content or a different conversation.');
  return Object.freeze({ duplicate: true, fingerprint, receipt: existing });
}

/**
 * submitted means the GUI send action was attempted, not confirmed delivery.
 * accepted requires the correct conversation's new user message. Neither an
 * empty composer nor a changed quote/queue bar is sufficient delivery proof.
 */
function makeDesktopReceipt(value, state, details = {}) {
  const request = validateDesktopRequest(value);
  if (!RECEIPT_STATES.includes(state)) refuse('invalid-receipt-state', 'Invalid desktop relay receipt state.');
  object(details, 'receipt-details');
  const at = timestamp(details.at === undefined ? Date.now() : details.at, 'receipt-time');
  const confirmed = ['accepted', 'running', 'completed'].includes(state);
  let turnId = null;
  if (confirmed) {
    const proof = details.proof;
    object(proof, 'delivery-proof');
    if (proof.threadId !== request.threadId || proof.messageText !== request.text || proof.newUserMessage !== true)
      refuse('unconfirmed-delivery', 'The matching new user message must be verified in the requested conversation.');
    if (state === 'running' || state === 'completed') turnId = id(proof.turnId, 'turn-id');
    if (state === 'running' && proof.turnStatus !== 'inProgress') refuse('unconfirmed-task-state', 'An actual running turn is required.');
    if (state === 'completed' && proof.turnStatus !== 'completed') refuse('unconfirmed-task-state', 'An actually completed turn is required.');
  }
  const receipt = { ok: state !== 'failed' && state !== 'unknown', requestId: request.requestId,
    threadId: request.threadId, fingerprint: requestFingerprint(request), state, at,
    deliveryConfirmed: confirmed, executionConfirmed: state === 'running' || state === 'completed' };
  if (turnId) receipt.turnId = turnId;
  if (details.code !== undefined) receipt.code = id(details.code, 'result-code');
  return Object.freeze(receipt);
}

module.exports = { DesktopTargetError, MAX_TEXT_BYTES, DEFAULT_PREFLIGHT_AGE_MS, RECEIPT_STATES,
  canonicalWindowsPath, windowsPathKey, sameWindowsPath, validateDesktopRequest, validateDesktopTarget,
  preflightDesktopTarget, requestFingerprint, checkDuplicateRequest, makeDesktopReceipt };
