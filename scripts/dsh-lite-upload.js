'use strict';

// A fixed, session-addressed upload route for the small mobile DSH client.
// The gateway must call this only behind its auth/proof gates and e2eeWrap.
// DSH itself stages the returned receipt for exactly this Session; sending a
// prompt with that receipt is a separate, explicit user action.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_META_BYTES = 4096;
const MAX_RESPONSE_BYTES = 64 * 1024;

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function validName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

async function readLimited(req) {
  const declared = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MAX_META_BYTES + 4) {
    throw Object.assign(new Error('too-large'), { status: 413 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_UPLOAD_BYTES + MAX_META_BYTES + 4) throw Object.assign(new Error('too-large'), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function createDshLiteUpload(options = {}) {
  if (typeof options.callUpstream !== 'function') throw new TypeError('callUpstream is required');
  return async function handleDshLiteUpload(req, res) {
    function reply(status, value) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    }
    if (req.method !== 'POST') { reply(405, { error: 'method-not-allowed' }); return; }
    // Header survives the e2eeWrap decrypted shim. It is not proof on its own.
    if (!req.__dshE2eeDecrypted || !req.headers || req.headers['x-dsh-e2ee'] !== '1') {
      reply(403, { error: 'encrypted-request-required' }); return;
    }
    if (!/^application\/octet-stream(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
      reply(415, { error: 'binary-required' }); return;
    }
    // Session ID and filename stay inside the encrypted body, never the
    // tunnel-visible URL. Wire: uint32be metadata length, JSON metadata,
    // then exact file bytes. The handler forwards only a fixed local path.
    let params;
    try { params = new URL(req.url, 'http://localhost').searchParams; }
    catch (_) { reply(400, { error: 'invalid-upload-request' }); return; }
    if ([...params.keys()].length) {
      reply(400, { error: 'invalid-upload-request' }); return;
    }
    let packet;
    try { packet = await readLimited(req); }
    catch (err) { reply(err && err.status === 413 ? 413 : 400,
      { error: err && err.status === 413 ? 'upload-too-large' : 'invalid-upload-body' }); return; }
    if (packet.length < 6) { reply(400, { error: 'invalid-upload-body' }); return; }
    const metaLength = packet.readUInt32BE(0);
    if (metaLength < 2 || metaLength > MAX_META_BYTES || packet.length <= 4 + metaLength) {
      reply(400, { error: 'invalid-upload-body' }); return;
    }
    let meta;
    try { meta = JSON.parse(packet.subarray(4, 4 + metaLength).toString('utf8')); }
    catch (_) { reply(400, { error: 'invalid-upload-body' }); return; }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
        Object.keys(meta).length !== 2 || !Object.hasOwn(meta, 'sessionId') ||
        !Object.hasOwn(meta, 'name') || !validId(meta.sessionId) || !validName(meta.name)) {
      reply(400, { error: 'invalid-upload-request' }); return;
    }
    const sessionId = meta.sessionId;
    const name = meta.name;
    const body = packet.subarray(4 + metaLength);
    if (body.length > MAX_UPLOAD_BYTES) { reply(413, { error: 'upload-too-large' }); return; }
    if (body.length === 0) { reply(400, { error: 'empty-upload' }); return; }

    const upstreamPath = '/api/session/uploadFileBinary?sessionId=' + encodeURIComponent(sessionId) +
      '&name=' + encodeURIComponent(name);
    let upstream;
    try {
      upstream = await options.callUpstream({ path: upstreamPath, method: 'POST', body,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length),
          accept: 'application/json', 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(60_000) });
    } catch (_) { reply(502, { error: 'upstream-upload-unavailable' }); return; }
    const status = Number(upstream && (upstream.statusCode ?? upstream.status));
    const bytes = upstream && (Buffer.isBuffer(upstream.body) ? upstream.body :
      typeof upstream.body === 'string' ? Buffer.from(upstream.body, 'utf8') : null);
    if (status !== 200 || !bytes || bytes.length > MAX_RESPONSE_BYTES) {
      reply(502, { error: 'upstream-upload-unavailable' }); return;
    }
    let decoded;
    try { decoded = JSON.parse(bytes.toString('utf8')); }
    catch (_) { reply(502, { error: 'upstream-upload-invalid' }); return; }
    if (!decoded || typeof decoded !== 'object' || typeof decoded.ok !== 'boolean') {
      reply(502, { error: 'upstream-upload-invalid' }); return;
    }
    if (!decoded.ok) {
      const code = decoded.error && decoded.error.code;
      reply(200, { ok: false, error: { code: typeof code === 'string' ? code.slice(0, 100) : 'upload/rejected' } });
      return;
    }
    const value = decoded.value;
    if (!value || !validId(value.receiptId) || !value.file ||
        !validId(value.file.attachmentId) || !validName(value.file.name) ||
        !Number.isSafeInteger(value.file.bytes) || value.file.bytes !== body.length) {
      reply(502, { error: 'upstream-upload-invalid' }); return;
    }
    reply(200, { ok: true, value: { receiptId: value.receiptId,
      file: { attachmentId: value.file.attachmentId, name: value.file.name, bytes: value.file.bytes } } });
  };
}

module.exports = { createDshLiteUpload, MAX_UPLOAD_BYTES };
