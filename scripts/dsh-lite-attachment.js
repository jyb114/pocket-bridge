'use strict';

// Read only images that the official remote-mux Session authorizes from its
// declared log references. This does not read paths, general file uploads,
// workspaces, upload receipts, or an attachment store directly.
const crypto = require('node:crypto');
const MAX_REQUEST_BYTES = 4096;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 20_000_000;
const TIMEOUT_MS = 20_000;
const METHOD = 'session/attachment';
const ID = /^sha256:[a-f0-9]{64}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, required, optional = []) {
  return plain(value) && required.every(name => Object.hasOwn(value, name)) &&
    Object.keys(value).every(name => required.includes(name) || optional.includes(name));
}
function validSession(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value); }
function validDimensions(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
    width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_IMAGE_PIXELS;
}
function dimensions(data, type) {
  if (type === 'image/png' && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii', 12, 16) === 'IHDR')
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  if (type === 'image/gif' && data.length >= 10 && /^(?:GIF87a|GIF89a)$/.test(data.toString('ascii', 0, 6)))
    return [data.readUInt16LE(6), data.readUInt16LE(8)];
  if (type === 'image/webp' && data.length >= 25 && data.toString('ascii', 0, 4) === 'RIFF' &&
    data.readUInt32LE(4) + 8 === data.length && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16), size = data.readUInt32LE(16);
    if (size + 20 > data.length) return null;
    if (kind === 'VP8X' && size >= 10) return [data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1];
    if (kind === 'VP8L' && size >= 5 && data[20] === 47) {
      const bits = data.readUInt32LE(21); return [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1];
    }
    if (kind === 'VP8 ' && size >= 10 && data.subarray(23, 26).equals(Buffer.from([157,1,42])))
      return [data.readUInt16LE(26) & 16383, data.readUInt16LE(28) & 16383];
  }
  if (type === 'image/jpeg' && data.length >= 4 && data[0] === 255 && data[1] === 216) {
    let offset = 2;
    const sof = new Set([192,193,194,195,197,198,199,201,202,203,205,206,207]);
    while (offset + 1 < data.length) {
      if (data[offset++] !== 255) return null;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 217 || marker === 218 || marker === undefined || marker === 0) return null;
      if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > data.length) return null;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) return null;
      if (sof.has(marker)) return size >= 8 ? [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)] : null;
      offset += size;
    }
  }
  return null;
}
function validateValue(value, attachmentId) {
  if (!exact(value, ['attachment', 'data']) || !exact(value.attachment,
    ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], ['name', 'originalDimensions'])) return null;
  const ref = value.attachment;
  if (ref.attachmentId !== attachmentId || !TYPES.has(ref.mediaType) ||
    !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_IMAGE_BYTES ||
    !validDimensions(ref.width, ref.height) ||
    Object.hasOwn(ref, 'name') && (typeof ref.name !== 'string' || ref.name.length > 255 || /[\u0000-\u001f\u007f]/.test(ref.name)) ||
    Object.hasOwn(ref, 'originalDimensions') && (!exact(ref.originalDimensions, ['width', 'height']) ||
      !Number.isSafeInteger(ref.originalDimensions.width) || !Number.isSafeInteger(ref.originalDimensions.height) ||
      ref.originalDimensions.width < 1 || ref.originalDimensions.height < 1 ||
      ref.originalDimensions.width > 1_000_000 || ref.originalDimensions.height > 1_000_000)) return null;
  if (typeof value.data !== 'string' || value.data.length < 4 || value.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) ||
    value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return null;
  const data = Buffer.from(value.data, 'base64');
  if (data.length !== ref.bytes || data.toString('base64') !== value.data ||
    'sha256:' + crypto.createHash('sha256').update(data).digest('hex') !== attachmentId) return null;
  const size = dimensions(data, ref.mediaType);
  if (!size || !validDimensions(...size) || size[0] !== ref.width || size[1] !== ref.height) return null;
  return { data, type: ref.mediaType };
}
async function readLimited(req) {
  const declared = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw Object.assign(Error('request-too-large'), { status: 413 });
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length;
    if (bytes > MAX_REQUEST_BYTES) throw Object.assign(Error('request-too-large'), { status: 413 });
    chunks.push(data);
  }
  return Buffer.concat(chunks, bytes);
}
function createDshLiteAttachment(options = {}) {
  if (typeof options.callUpstream !== 'function' || typeof options.resolveRuntime !== 'function')
    throw new TypeError('callUpstream and resolveRuntime are required');
  return async function handleDshLiteAttachment(req, res) {
    function reply(status, error, code) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify({ error, ...(code ? { code } : {}) }));
    }
    if (req.method !== 'POST') return reply(405, 'method-not-allowed');
    if (!req.__dshE2eeDecrypted || !req.headers || req.headers['x-dsh-e2ee'] !== '1') return reply(403, 'encrypted-request-required');
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) return reply(415, 'json-required');
    let input;
    try {
      if (new URL(req.url, 'http://localhost').search) return reply(400, 'invalid-attachment-request');
      input = JSON.parse((await readLimited(req)).toString('utf8'));
    } catch (error) { return reply(error?.status === 413 ? 413 : 400, error?.status === 413 ? 'request-too-large' : 'invalid-attachment-request'); }
    if (!exact(input, ['sessionId', 'attachmentId']) || !validSession(input.sessionId) ||
      typeof input.attachmentId !== 'string' || !ID.test(input.attachmentId)) return reply(400, 'invalid-attachment-request');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let timer;
    try {
      timer = setTimeout(cancel, TIMEOUT_MS);
      req.once?.('aborted', cancel); res.once?.('close', cancel);
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('read-aborted')), { once: true }));
      const runtime = await Promise.race([options.resolveRuntime(), aborted]);
      if (!runtime) return reply(503, 'dsh-unavailable');
      if (runtime.profile !== 'remote-mux') return reply(501, 'attachment-read-unsupported');
      const wire = { type: 'client-request', rpcId: crypto.randomUUID(), method: METHOD,
        payload: { args: { request: input } } };
      const body = Buffer.from(JSON.stringify(wire));
      const upstream = await Promise.race([options.callUpstream({ verifiedRuntime: runtime,
        path: '/api/' + METHOD, method: 'POST', body, maxResponseBytes: MAX_RESPONSE_BYTES,
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length),
          accept: 'application/json', 'accept-encoding': 'identity' }, signal: controller.signal }), aborted]);
      const bytes = Buffer.isBuffer(upstream?.body) ? upstream.body : typeof upstream?.body === 'string' ? Buffer.from(upstream.body) : null;
      if (bytes && bytes.length > MAX_RESPONSE_BYTES) return reply(413, 'image-too-large');
      if (Number(upstream?.statusCode ?? upstream?.status) !== 200 || !bytes) return reply(502, 'upstream-attachment-invalid');
      let decoded;
      try { decoded = JSON.parse(bytes.toString('utf8')); } catch (_) { return reply(502, 'upstream-attachment-invalid'); }
      if (!plain(decoded) || decoded.rpcId !== wire.rpcId || !plain(decoded.result) || typeof decoded.result.ok !== 'boolean') return reply(502, 'upstream-attachment-invalid');
      if (!decoded.result.ok) {
        const code = decoded.result.error?.code;
        if (code === 'session/not-found' || code === 'session/attachment-invalid') return reply(404, 'attachment-unavailable', code);
        if (['gateway/method-not-found', 'gateway/method-unavailable', 'gateway/arguments-invalid'].includes(code)) return reply(501, 'attachment-read-unsupported');
        return reply(502, 'upstream-attachment-unavailable');
      }
      const value = decoded.result.value;
      if (Number.isSafeInteger(value?.attachment?.bytes) && value.attachment.bytes > MAX_IMAGE_BYTES ||
        typeof value?.data === 'string' && value.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) return reply(413, 'image-too-large');
      const image = validateValue(value, input.attachmentId);
      if (!image) return reply(502, 'upstream-attachment-invalid');
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'content-type': image.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(image.data);
    } catch (error) {
      reply(error?.message === 'dsh-response-too-large' ? 413 : 502,
        error?.message === 'dsh-response-too-large' ? 'image-too-large' : 'upstream-attachment-unavailable');
    } finally {
      clearTimeout(timer); controller.abort(); req.off?.('aborted', cancel); res.off?.('close', cancel);
    }
  };
}
module.exports = { createDshLiteAttachment, MAX_REQUEST_BYTES, MAX_IMAGE_BYTES, MAX_RESPONSE_BYTES,
  MAX_DIMENSION, MAX_IMAGE_PIXELS, METHOD };
