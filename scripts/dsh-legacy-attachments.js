'use strict';

// Bridge-owned temporary image receipts feed the official legacy base64
// image wire only when the person explicitly sends a prompt. No arbitrary
// file is written, and receipt ids cannot select paths or another Session.
const crypto = require('node:crypto');
const { workspaceRootFor } = require('./dsh-lite-download');
const { runtimeIdentity } = require('./dsh-legacy-interactions');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
const MAX_IMAGES = 4;
const TTL = 10 * 60 * 1000;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 255 &&
  !/[\\/:\u0000-\u001f\u007f]/.test(value) && value !== '.' && value !== '..';
const fault = (status, code) => Object.assign(new Error(code), { status, code });
function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
function createDshLegacyAttachments(options = {}) {
  if (typeof options.getRuntime !== 'function') throw new TypeError('getRuntime required');
  const rootFor = options.workspaceRootFor || (sessionId => workspaceRootFor(sessionId, options));
  const now = options.now || Date.now, receipts = new Map();
  let stagedBytes = 0;
  function remove(key) { const item = receipts.get(key); if (item) { stagedBytes -= item.bytes; receipts.delete(key); } }
  function sweep() { for (const [key, item] of receipts) if (now() - item.at > TTL) remove(key); }
  function resolveForPrompt(sessionId, ids, runtime) {
    sweep();
    const identity = runtimeIdentity(runtime), root = rootFor(sessionId);
    if (!root || !Array.isArray(ids) || !ids.length || ids.length > MAX_IMAGES || new Set(ids).size !== ids.length)
      throw fault(400, 'invalid-image-receipts');
    const values = ids.map(id => {
      const item = validId(id) && receipts.get(id);
      if (!item || item.reserved || item.sessionId !== sessionId || item.identity !== identity || item.root !== root)
        throw fault(409, 'image-receipt-expired');
      return item;
    });
    if (values.reduce((sum, item) => sum + item.bytes, 0) > MAX_BATCH_BYTES) throw fault(413, 'image-batch-too-large');
    const reservation = crypto.randomUUID();
    values.forEach(item => { item.reserved = reservation; });
    return { content: values.map(item => ({ type: 'image', mediaType: item.mediaType, data: item.data, name: item.name })),
      commit() { ids.forEach(key => { if (receipts.get(key)?.reserved === reservation) remove(key); }); },
      // Only a confirmed upstream rejection releases the reservation. A
      // timeout may follow an accepted prompt, so its receipts remain blocked
      // until expiry instead of silently allowing duplicate submission.
      release() { values.forEach(item => { if (item.reserved === reservation) delete item.reserved; }); } };
  }
  async function handle(req, res) {
    const reply = (status, value) => { if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value)); };
    try {
      if (req.method !== 'POST') throw fault(405, 'method-not-allowed');
      if (!req.__dshE2eeDecrypted || req.headers['x-dsh-e2ee'] !== '1') throw fault(403, 'encrypted-request-required');
      if (!/^application\/octet-stream(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) throw fault(415, 'binary-required');
      if (new URL(req.url, 'http://localhost').search) throw fault(400, 'invalid-upload-request');
      let length = 0; const chunks = [];
      if (Number(req.headers['content-length']) > MAX_IMAGE_BYTES + 4100) throw fault(413, 'image-too-large');
      for await (const chunk of req) { length += chunk.length; if (length > MAX_IMAGE_BYTES + 4100) throw fault(413, 'image-too-large'); chunks.push(chunk); }
      const packet = Buffer.concat(chunks);
      if (packet.length < 6) throw fault(400, 'invalid-upload-request');
      const metaLength = packet.readUInt32BE(0);
      if (metaLength < 2 || metaLength > 4096 || packet.length <= metaLength + 4) throw fault(400, 'invalid-upload-request');
      let meta; try { meta = JSON.parse(packet.subarray(4, metaLength + 4)); } catch (_) { throw fault(400, 'invalid-upload-request'); }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).sort().join(',') !== 'mediaType,name,sessionId' ||
          !validId(meta.sessionId) || !validName(meta.name)) throw fault(400, 'invalid-upload-request');
      const bytes = packet.subarray(metaLength + 4), mediaType = imageType(bytes);
      if (bytes.length > MAX_IMAGE_BYTES) throw fault(413, 'image-too-large');
      if (!mediaType || mediaType !== meta.mediaType) throw fault(415, 'raster-image-required');
      const runtime = await options.getRuntime(true), identity = runtimeIdentity(runtime), root = rootFor(meta.sessionId);
      if (!root) throw fault(404, 'session-workspace-unavailable');
      sweep();
      if (receipts.size >= 32 || stagedBytes + bytes.length > MAX_STAGED_BYTES) throw fault(429, 'image-staging-full');
      const receiptId = crypto.randomUUID();
      receipts.set(receiptId, { sessionId: meta.sessionId, identity, root, name: meta.name, mediaType,
        data: bytes.toString('base64'), bytes: bytes.length, at: now() }); stagedBytes += bytes.length;
      reply(200, { ok: true, value: { receiptId, file: { attachmentId: receiptId, name: meta.name,
        bytes: bytes.length, mediaType, kind: 'image' } } });
    } catch (error) { reply(error.status || 502, { ok: false, error: error.code || 'legacy-image-unavailable' }); }
  }
  const timer = setInterval(sweep, 60000); if (timer.unref) timer.unref();
  return { handle, resolveForPrompt, close() { clearInterval(timer); receipts.clear(); stagedBytes = 0; } };
}
module.exports = { createDshLegacyAttachments, MAX_IMAGE_BYTES, MAX_BATCH_BYTES };
