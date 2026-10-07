'use strict';

// The inspected 0.1.0-rc.8 and 0.1.1-rc.2 HTTP builds use dotted unary
// method names and a direct payload. Keep this adapter separate from the
// newer /api/remote.mux carrier. The caller must wrap this handler in e2eeWrap
// and place it behind the normal device/proof gates.
const crypto = require('node:crypto');
const path = require('node:path');

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const METHODS = new Set(['host.describe', 'workspace.list', 'workspace.create',
  'session.list', 'session.create', 'session.history', 'session.prompt', 'session.cancel',
  'llm.models', 'session.models', 'session.selectModel', 'agentPreset.list', 'agentPreset.select']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value, required, optional = []) {
  return record(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function id(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
function directory(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 4096 &&
    !value.includes('\0') && (process.platform === 'win32'
      ? /^[A-Za-z]:[\\/]/.test(value) && path.win32.isAbsolute(value)
      : path.posix.isAbsolute(value));
}
function selectionId(value) {
  return id(value) && value.length <= 256 && value.trim().length > 0;
}
function validRequest(method, value) {
  if (method === 'host.describe' || method === 'workspace.list' || method === 'session.list' ||
      method === 'llm.models' || method === 'agentPreset.list')
    return keys(value, []);
  if (method === 'session.models') return keys(value, ['sessionId']) && id(value.sessionId);
  if (method === 'session.selectModel') return keys(value, ['sessionId', 'provider', 'model'], ['reasoningEffort']) &&
    id(value.sessionId) && selectionId(value.provider) && selectionId(value.model) &&
    (!Object.hasOwn(value, 'reasoningEffort') || selectionId(value.reasoningEffort));
  if (method === 'agentPreset.select') return keys(value, ['sessionId', 'agentPreset']) &&
    id(value.sessionId) && selectionId(value.agentPreset);
  if (method === 'workspace.create') return keys(value, ['path']) && directory(value.path);
  if (method === 'session.create') return keys(value, ['workspaceId']) && id(value.workspaceId);
  if (method === 'session.history') return keys(value, ['sessionId'], ['beforeSeq', 'maxMessages']) &&
    id(value.sessionId) &&
    (!Object.hasOwn(value, 'beforeSeq') || (Number.isSafeInteger(value.beforeSeq) && value.beforeSeq >= 0)) &&
    (!Object.hasOwn(value, 'maxMessages') ||
      (Number.isSafeInteger(value.maxMessages) && value.maxMessages >= 1 && value.maxMessages <= 30));
  if (method === 'session.prompt') return keys(value, ['sessionId', 'mode', 'content'], ['attachmentReceipts']) &&
    id(value.sessionId) && (value.mode === 'queue' || value.mode === 'steer') &&
    Array.isArray(value.content) && value.content.length === 1 &&
    keys(value.content[0], ['type', 'text']) && value.content[0].type === 'text' &&
    typeof value.content[0].text === 'string' && value.content[0].text.length <= 64000 &&
    (!Object.hasOwn(value, 'attachmentReceipts') || (Array.isArray(value.attachmentReceipts) &&
      value.attachmentReceipts.length > 0 && value.attachmentReceipts.length <= 4 &&
      value.attachmentReceipts.every(id) && new Set(value.attachmentReceipts).size === value.attachmentReceipts.length)) &&
    (value.content[0].text.trim().length > 0 || value.attachmentReceipts && value.attachmentReceipts.length > 0);
  if (method === 'session.cancel') return keys(value, ['sessionId']) && id(value.sessionId);
  return false;
}
async function readLimited(req) {
  const length = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw Object.assign(new Error('too-large'), { status: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('too-large'), { status: 413 });
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}

function createDshLiteLegacyRpc(options = {}) {
  if (typeof options.callUpstream !== 'function' || typeof options.runtimeProfile !== 'function')
    throw new TypeError('callUpstream and runtimeProfile are required');
  return async function handleDshLiteLegacyRpc(req, res) {
    function reply(status, value) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    }
    if (req.method !== 'POST') { reply(405, { error: 'method-not-allowed' }); return; }
    if (!req.__dshE2eeDecrypted || !req.headers || req.headers['x-dsh-e2ee'] !== '1') {
      reply(403, { error: 'encrypted-request-required' }); return;
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
      reply(415, { error: 'json-required' }); return;
    }
    let input;
    try { input = JSON.parse((await readLimited(req)).toString('utf8')); }
    catch (error) { reply(error && error.status === 413 ? 413 : 400,
      { error: error && error.status === 413 ? 'request-too-large' : 'invalid-json' }); return; }
    if (!keys(input, ['method', 'request']) || !METHODS.has(input.method) ||
        !validRequest(input.method, input.request)) {
      reply(400, { error: 'invalid-rpc-request' }); return;
    }
    // Never aim a legacy write at an unknown/new runtime just because an old
    // phone page remained cached after the desktop application was upgraded.
    let profile;
    try { profile = await options.runtimeProfile(input.method); }
    catch (_) { reply(503, { error: 'dsh-runtime-unavailable' }); return; }
    if (!profile) { reply(503, { error: 'dsh-runtime-unavailable' }); return; }
    if (profile !== 'legacy-events') {
      reply(409, { error: 'dsh-protocol-changed' }); return;
    }
    let staged = null, request = input.request;
    if (input.method === 'session.prompt' && input.request.attachmentReceipts) {
      if (typeof options.resolveAttachments !== 'function') { reply(400, { error: 'legacy-image-upload-unavailable' }); return; }
      try { staged = await options.resolveAttachments(input.request.sessionId, input.request.attachmentReceipts); }
      catch (error) { reply(error.status || 503, { error: error.code || 'legacy-image-unavailable' }); return; }
      request = { sessionId: input.request.sessionId, mode: input.request.mode,
        content: input.request.content.filter(part => part.text.trim()).concat(staged.content) };
    }
    const wire = { type: 'client-request', rpcId: crypto.randomUUID(),
      method: input.method, payload: request };
    const body = Buffer.from(JSON.stringify(wire), 'utf8');
    if (body.length > (staged ? 12 * 1024 * 1024 : MAX_REQUEST_BYTES)) {
      if (staged && typeof staged.release === 'function') staged.release();
      reply(413, { error: 'request-too-large' }); return;
    }
    try {
      const upstream = await options.callUpstream({ path: '/api/' + input.method, method: 'POST', body,
        verifiedRuntime: staged && staged.runtime,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        headers: { 'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length), accept: 'application/json',
          'accept-encoding': 'identity' }, signal: AbortSignal.timeout(15000) });
      const status = Number(upstream && (upstream.statusCode ?? upstream.status));
      const bytes = upstream && (Buffer.isBuffer(upstream.body) ? upstream.body :
        typeof upstream.body === 'string' ? Buffer.from(upstream.body, 'utf8') : null);
      if (status !== 200 || !bytes || bytes.length > MAX_RESPONSE_BYTES) {
        reply(502, { error: 'upstream-rpc-unavailable' }); return;
      }
      let decoded;
      try { decoded = JSON.parse(bytes.toString('utf8')); }
      catch (_) { reply(502, { error: 'upstream-rpc-invalid' }); return; }
      if (!record(decoded) || decoded.type !== 'server-response' || decoded.rpcId !== wire.rpcId ||
          !record(decoded.result) || typeof decoded.result.ok !== 'boolean') {
        reply(502, { error: 'upstream-rpc-invalid' }); return;
      }
      if (staged && decoded.result.ok === true && decoded.result.value && decoded.result.value.accepted === true) staged.commit();
      else if (staged && typeof staged.release === 'function') staged.release();
      reply(200, { result: decoded.result });
    } catch (_) { reply(502, { error: 'upstream-rpc-unavailable' }); }
  };
}

module.exports = { createDshLiteLegacyRpc, validRequest, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES };
