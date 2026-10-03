'use strict';
// Lossless, connection-scoped history transport inside the existing AES-GCM
// channel. This is a read-only adapter, never a history cache or writer API.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const wsf = require('./ws-frame.js');

const METHOD = 'bridge/history/list';
const LIMITS = Object.freeze({
  requestBytes: 32 * 1024,
  resultBytes: 8 * 1024 * 1024,
  frameBytes: 16 * 1024 * 1024,
  handshakeBytes: 8192,
  pending: 16,
  pendingMs: 45000
});
const HEX_NONCE = /^[0-9a-f]{32}$/;
const HEX_REVISION = /^[0-9a-f]{64}$/;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => Number.isSafeInteger(id) || (typeof id === 'string' && id.length > 0 && id.length <= 128);
const idKey = id => typeof id + ':' + String(id);

/** Match the caller's exact page selection; absent optional fields stay absent
 * upstream and are represented as null only in the response scope. */
function scopeOf(query) {
  return { threadId: query.threadId, limit: query.limit === undefined ? null : query.limit,
    cursor: query.cursor === undefined ? null : query.cursor,
    sortDirection: query.sortDirection === undefined ? null : query.sortDirection };
}

function validateRequest(params) {
  if (!record(params) || params.v !== 1 || typeof params.nonce !== 'string' || !HEX_NONCE.test(params.nonce) ||
      Object.keys(params).some(key => !['v','nonce','query','acceptEncoding','revision'].includes(key)) ||
      (params.revision !== undefined && (typeof params.revision !== 'string' || !HEX_REVISION.test(params.revision))) ||
      !Array.isArray(params.acceptEncoding) || params.acceptEncoding.length > 1 ||
      (params.acceptEncoding.length && params.acceptEncoding[0] !== 'gzip') || !record(params.query)) return false;
  const query = params.query;
  return typeof query.threadId === 'string' && query.threadId.length > 0 && query.threadId.length <= 256 &&
    Object.keys(query).every(key => ['threadId','limit','cursor','sortDirection'].includes(key)) &&
    (query.limit === undefined || (Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= 2000)) &&
    (query.cursor === undefined || query.cursor === null || (typeof query.cursor === 'string' && query.cursor.length <= 4096)) &&
    (query.sortDirection === undefined || query.sortDirection === 'asc' || query.sortDirection === 'desc');
}

/** Reuse the established frame decoder only after validating header lengths,
 * opcodes and FIN. The AES frame primitive does not preserve continuation
 * semantics, so fragmented application messages fail closed here. */
function createFrameReader(maxBytes, masked) {
  let rest = Buffer.alloc(0);
  return {
    push(chunk) {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const slices = [];
      let off = 0;
      while (off + 2 <= buf.length) {
        const b0 = buf[off], b1 = buf[off + 1], opcode = b0 & 15;
        if ((b0 & 0x70) || !(b0 & 0x80) || !!(b1 & 0x80) !== masked || opcode === wsf.OP_CONT ||
            ![wsf.OP_TEXT,wsf.OP_BIN,wsf.OP_CLOSE,wsf.OP_PING,wsf.OP_PONG].includes(opcode)) {
          throw new Error('history-transport-invalid-frame');
        }
        let len = b1 & 127, end = off + 2;
        if (len === 126) { if (end + 2 > buf.length) break; len = buf.readUInt16BE(end); end += 2; }
        else if (len === 127) {
          if (end + 8 > buf.length) break;
          const big = buf.readBigUInt64BE(end); end += 8;
          if (big > BigInt(maxBytes)) throw new Error('history-transport-frame-limit');
          len = Number(big);
        }
        if (len > maxBytes || (opcode >= 8 && len > 125)) throw new Error('history-transport-frame-limit');
        if (b1 & 0x80) end += 4;
        if (end + len > buf.length) break;
        slices.push(buf.subarray(off, end + len)); off = end + len;
      }
      rest = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0);
      if (rest.length > maxBytes + 14) throw new Error('history-transport-frame-limit');
      return slices.map(raw => {
        const parsed = wsf.parseFrames(raw);
        if (parsed.frames.length !== 1 || parsed.rest.length) throw new Error('history-transport-invalid-frame');
        return { raw, frame: parsed.frames[0] };
      });
    },
    close() { rest = Buffer.alloc(0); }
  };
}

function createTransport(options = {}) {
  const limits = { ...LIMITS, ...(options.limits || {}) };
  for (const key of Object.keys(LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > LIMITS[key]) {
      throw new Error('Invalid history transport limit: ' + key);
    }
  }
  const encryptedReader = createFrameReader(limits.frameBytes, true);
  const clientReader = createFrameReader(limits.frameBytes, true);
  const upstreamReader = createFrameReader(limits.frameBytes, false);
  const pending = new Map(), phoneIds = new Set();
  const hmacKey = crypto.randomBytes(32);
  const prefix = 'pb-history-' + crypto.randomBytes(16).toString('hex') + '-';
  let nextId = 0, closed = false, handshakeDone = false, header = Buffer.alloc(0), earlyReplies = [];
  const counters = { rewritten: 0, compressed: 0, unchanged: 0, identity: 0, refused: 0, expired: 0, orphaned: 0 };

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear(); phoneIds.clear(); hmacKey.fill(0);
    encryptedReader.close(); clientReader.close(); upstreamReader.close(); header = Buffer.alloc(0); earlyReplies = [];
  }
  function fail(code) {
    if (closed) return;
    counters.refused++;
    close();
    if (typeof options.onError === 'function') { try { options.onError(new Error(code)); } catch {} }
  }
  function replyFrame(message) {
    return wsf.buildFrame(wsf.OP_TEXT, Buffer.from(JSON.stringify(message)), false);
  }
  function emitError(id, code, message) {
    const frame = replyFrame({ jsonrpc: '2.0', id, error: { code, message } });
    if (!handshakeDone) {
      if (earlyReplies.length >= limits.pending) { fail('history-transport-early-reply-limit'); return; }
      earlyReplies.push(frame);
    } else if (typeof options.onClientOutput === 'function') {
      try { options.onClientOutput(frame); } catch { fail('history-transport-output-failed'); }
    }
  }
  function remove(upstreamId) {
    const entry = pending.get(upstreamId);
    if (!entry) return null;
    clearTimeout(entry.timer); pending.delete(upstreamId); phoneIds.delete(idKey(entry.id));
    return entry;
  }
  function readJson(payload) {
    // Invalid UTF-8 must not normalize an arbitrary binary payload into a
    // matching method or correlation ID. Non-JSON text remains unchanged.
    const text = payload.toString('utf8');
    if (!Buffer.from(text).equals(payload)) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  function fromClient(chunk) {
    if (closed || !chunk.length) return Buffer.alloc(0);
    const output = [];
    try {
      for (const { raw, frame } of clientReader.push(chunk)) {
        const message = frame.opcode === wsf.OP_TEXT ? readJson(frame.payload) : null;
        if (!record(message) || message.method !== METHOD) {
          // A phone cannot steal an internal response correlation by choosing
          // our private upstream ID for an unrelated request.
          if (record(message) && has(message,'method') && typeof message.id === 'string' &&
              message.id.startsWith(prefix)) throw new Error('history-transport-id-collision');
          output.push(raw); continue;
        }
        if (!validId(message.id) || (typeof message.id === 'string' && message.id.startsWith(prefix))) {
          throw new Error('history-transport-invalid-request-id');
        }
        if (options.encrypted !== true) {
          counters.refused++; emitError(message.id,-32072,'Encrypted history transport is required.'); continue;
        }
        if (message.jsonrpc !== '2.0' || frame.payload.length > limits.requestBytes ||
            !validateRequest(message.params)) {
          counters.refused++; emitError(message.id,-32602,'Invalid history transport request.'); continue;
        }
        if (pending.size >= limits.pending || phoneIds.has(idKey(message.id))) {
          counters.refused++; emitError(message.id,-32070,'Too many outstanding history reads.'); continue;
        }
        const upstreamId = prefix + (++nextId);
        const entry = { id: message.id, params: message.params, scope: scopeOf(message.params.query), timer: null };
        entry.timer = setTimeout(() => {
          if (closed || !remove(upstreamId)) return;
          counters.expired++;
          emitError(entry.id,-32070,'History read timed out. Retry this page.');
        },limits.pendingMs);
        entry.timer.unref?.(); pending.set(upstreamId,entry); phoneIds.add(idKey(message.id));
        counters.rewritten++;
        output.push(wsf.buildFrame(wsf.OP_TEXT,Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: upstreamId,
          method: 'thread/items/list', params: message.params.query })),frame.masked));
      }
      return closed ? Buffer.alloc(0) : Buffer.concat(output);
    } catch (error) { fail(error.message); return Buffer.alloc(0); }
  }
  function fromEncryptedClient(chunk, decrypt) {
    if (closed || !chunk.length) return Buffer.alloc(0);
    try {
      if (options.encrypted !== true || typeof decrypt !== 'function') throw new Error('history-transport-encryption-required');
      // Validate original FIN/RSV/mask before the established AES transform
      // rebuilds complete plaintext frames. TCP splitting is still supported.
      const complete = encryptedReader.push(chunk);
      if (!complete.length) return Buffer.alloc(0);
      const plain = decrypt(Buffer.concat(complete.map(part => part.raw)));
      if (!Buffer.isBuffer(plain)) throw new Error('history-transport-decryptor-invalid');
      return fromClient(plain);
    } catch (error) { fail(error.message); return Buffer.alloc(0); }
  }
  function transformResponse(raw, frame) {
    if (frame.opcode !== wsf.OP_TEXT) return raw;
    const message = readJson(frame.payload);
    if (!record(message) || has(message,'method') || !has(message,'id')) return raw;
    if (!pending.has(message.id)) {
      // A timed-out or duplicate adapter reply is still a history response,
      // not a new ordinary RPC. Never leak its full result outside our bound.
      if (typeof message.id === 'string' && message.id.startsWith(prefix) &&
          (has(message,'result') || has(message,'error'))) { counters.orphaned++; return Buffer.alloc(0); }
      return raw;
    }
    if ((has(message,'result') === has(message,'error')) || (has(message,'jsonrpc') && message.jsonrpc !== '2.0')) {
      throw new Error('history-transport-invalid-response');
    }
    const entry = remove(message.id);
    if (has(message,'error')) return replyFrame({ ...message, id: entry.id });
    const result = Buffer.from(JSON.stringify(message.result));
    if (result.length > limits.resultBytes) {
      counters.refused++;
      return replyFrame({ jsonrpc:'2.0',id:entry.id,error:{ code:-32071,
        message:'History page exceeds the transport limit. Existing history is preserved; use the full-page history option to retry.' } });
    }
    const revision = crypto.createHmac('sha256',hmacKey).update('pb-history-v1\0')
      .update(JSON.stringify(entry.params.query)).update('\0').update(result).digest('hex');
    const envelope = { __pbHistory:1,nonce:entry.params.nonce,scope:entry.scope,revision,unchanged:false };
    if (entry.params.revision && crypto.timingSafeEqual(Buffer.from(revision,'hex'),Buffer.from(entry.params.revision,'hex'))) {
      envelope.unchanged = true; counters.unchanged++;
    } else {
      envelope.decodedBytes = result.length;
      const zipped = entry.params.acceptEncoding[0] === 'gzip' ? zlib.gzipSync(result) : null;
      // Compare actual encoded body bytes, including base64 expansion, before
      // claiming compression saves tunnel traffic.
      if (zipped && Math.ceil(zipped.length / 3) * 4 + 32 < result.length) {
        envelope.encoding = 'gzip'; envelope.body = zipped.toString('base64'); counters.compressed++;
      } else {
        envelope.encoding = 'identity'; envelope.value = message.result; counters.identity++;
      }
    }
    return replyFrame({ ...message, id:entry.id,result:envelope });
  }
  function fromUpstream(chunk) {
    if (closed || !chunk.length) return Buffer.alloc(0);
    const output = [];
    try {
      if (!handshakeDone) {
        header = header.length ? Buffer.concat([header,chunk]) : chunk;
        const end = header.indexOf('\r\n\r\n');
        if (end < 0) {
          if (header.length > limits.handshakeBytes) throw new Error('history-transport-handshake-limit');
          return Buffer.alloc(0);
        }
        if (end + 4 > limits.handshakeBytes || !/^HTTP\/1\.[01] 101(?: |\r)/.test(header.toString('latin1',0,end))) {
          throw new Error('history-transport-upgrade-unverified');
        }
        output.push(header.subarray(0,end + 4)); chunk = header.subarray(end + 4); header = Buffer.alloc(0);
        handshakeDone = true; output.push(...earlyReplies); earlyReplies = [];
      }
      for (const { raw,frame } of upstreamReader.push(chunk)) output.push(transformResponse(raw,frame));
      return closed ? Buffer.alloc(0) : Buffer.concat(output);
    } catch (error) { fail(error.message); return Buffer.alloc(0); }
  }
  return { fromClient,fromEncryptedClient,fromUpstream,close,stats:() => ({ ...counters,pending:pending.size,closed }) };
}

module.exports = { createTransport,METHOD,LIMITS,scopeOf };
