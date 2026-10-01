'use strict';

// Read only the official legacy pending-request stream. Phone responses are
// rebuilt from observed session/rpc bindings; this is never an API proxy.
const { StringDecoder } = require('node:string_decoder');
const MAX_BODY = 64 * 1024;
const MAX_STREAM = 1024 * 1024;
const MAX_PENDING = 128;
const SEEN_TTL = 60 * 1000;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const keys = (value, required, optional = []) => record(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const fault = (status, code) => Object.assign(new Error(code), { status, code });

function runtimeIdentity(runtime) {
  if (!runtime || !runtime.running || runtime.profile !== 'legacy-events' ||
      !Number.isInteger(runtime.pid) || runtime.pid < 1 || !Number.isInteger(runtime.port) ||
      runtime.port < 1 || runtime.port > 65535) throw fault(503, 'legacy-runtime-unavailable');
  return JSON.stringify([runtime.pid, runtime.port, runtime.profile, runtime.version || null]);
}
function pendingFrame(frame) {
  if (!record(frame) || frame.type !== 'server-request' || !id(frame.rpcId) || !record(frame.payload) ||
      frame.method !== frame.payload.type) return null;
  const value = frame.payload;
  if (!id(value.sessionId)) return null;
  if (value.type === 'approval/requested') {
    if (!id(value.approvalId) || !text(value.toolName, 500) ||
        (value.reason !== undefined && !text(value.reason, 10000))) throw fault(502, 'legacy-event-invalid');
    return { rpcId: frame.rpcId, sessionId: value.sessionId, kind: 'approval', approvalId: value.approvalId,
      interaction: { id: frame.rpcId, sessionId: value.sessionId, kind: 'approval',
        title: 'DSH 请求授权：' + value.toolName, text: value.reason || value.toolName } };
  }
  if (value.type !== 'question/requested') return null;
  if (!Array.isArray(value.questions) || !value.questions.length || value.questions.length > 20)
    throw fault(502, 'legacy-event-invalid');
  const questions = value.questions.map(question => {
    if (!record(question) || !id(question.id) || !text(question.question, 10000) ||
        (question.detail !== undefined && !text(question.detail, 20000)) ||
        (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') ||
        (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > 50)))
      throw fault(502, 'legacy-event-invalid');
    const options = (question.options || []).map(option => {
      if (!record(option) || !text(option.label, 1000) || !option.label ||
          (option.description !== undefined && !text(option.description, 5000))) throw fault(502, 'legacy-event-invalid');
      return { label: option.label, description: option.description || '' };
    });
    if (new Set(options.map(option => option.label)).size !== options.length) throw fault(502, 'legacy-event-invalid');
    return { id: question.id, question: question.question, detail: question.detail || '',
      options, multiSelect: question.multiSelect === true };
  });
  if (new Set(questions.map(question => question.id)).size !== questions.length) throw fault(502, 'legacy-event-invalid');
  return { rpcId: frame.rpcId, sessionId: value.sessionId, kind: 'question', questions,
    interaction: { id: frame.rpcId, sessionId: value.sessionId, kind: 'question',
      title: 'DSH 需要回答', text: '', questions } };
}

function responseValue(pending, answer) {
  if (pending.kind === 'approval') {
    if (!keys(answer, ['type']) || !['approve', 'reject'].includes(answer.type)) throw fault(400, 'invalid-answer');
    return { sessionId: pending.sessionId, approvalId: pending.approvalId,
      outcome: answer.type === 'approve' ? 'allowed-once' : 'rejected' };
  }
  if (!keys(answer, ['type', 'answers']) || answer.type !== 'answers' || !Array.isArray(answer.answers) ||
      answer.answers.length !== pending.questions.length) throw fault(400, 'invalid-answer');
  const answers = pending.questions.map(question => {
    const matches = answer.answers.filter(item => record(item) && item.id === question.id);
    if (matches.length !== 1) throw fault(400, 'invalid-answer');
    const value = matches[0];
    if (!keys(value, ['id', 'selected'], ['custom']) || !Array.isArray(value.selected) ||
        value.selected.some(label => !question.options.some(option => option.label === label)) ||
        new Set(value.selected).size !== value.selected.length || (!question.multiSelect && value.selected.length > 1) ||
        (value.custom !== undefined && !text(value.custom, 10000))) throw fault(400, 'invalid-answer');
    const custom = typeof value.custom === 'string' ? value.custom.trim() : '';
    if (!value.selected.length && !custom) throw fault(400, 'invalid-answer');
    return { id: question.id, selected: value.selected, ...(custom ? { custom } : {}) };
  });
  return { sessionId: pending.sessionId, answer: { answers } };
}

async function collectPending(stream, sessionId, windowMs) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8'), pending = new Map();
    let buffer = '', bytes = 0, done = false;
    function finish(error) {
      if (done) return; done = true; clearTimeout(timer);
      stream.removeListener('data', data);
      stream.destroy();
      if (error) reject(error); else resolve(pending);
    }
    function data(chunk) {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STREAM) { finish(fault(502, 'legacy-stream-too-large')); return; }
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      buffer = buffer.replace(/\r\n/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const json = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!json) continue;
        try {
          const frame = JSON.parse(json), value = pendingFrame(frame);
          if (frame && frame.type === 'server-request' && frame.payload && frame.payload.type === 'stream/error')
            throw fault(502, 'legacy-stream-unavailable');
          if (value && value.sessionId === sessionId) pending.set(value.rpcId, value);
          if (frame && frame.type === 'server-request' && frame.payload && frame.payload.sessionId === sessionId) {
            if (frame.payload.type === 'question/resolved') pending.delete(frame.payload.questionRpcId);
            if (frame.payload.type === 'approval/resolved') for (const [rpcId, item] of pending)
              if (item.kind === 'approval' && item.approvalId === frame.payload.approvalId) pending.delete(rpcId);
          }
          if (pending.size > MAX_PENDING) throw fault(502, 'legacy-pending-too-large');
        } catch (error) { finish(error.status ? error : fault(502, 'legacy-event-invalid')); return; }
      }
    }
    const timer = setTimeout(() => finish(bytes ? null : fault(502, 'legacy-stream-unavailable')), windowMs);
    stream.on('data', data);
    stream.on('error', () => finish(fault(502, 'legacy-stream-unavailable')));
    stream.on('end', () => finish(fault(502, 'legacy-stream-unavailable')));
  });
}

function createDshLegacyInteractions(options) {
  const { getRuntime, openEvents, respond } = options || {};
  if (![getRuntime, openEvents, respond].every(fn => typeof fn === 'function')) throw new TypeError('legacy interaction transports required');
  const now = options.now || Date.now, seen = new Map(), answering = new Set();
  const windowMs = options.windowMs || 500;
  let activeIdentity = null, collecting = 0;
  async function snapshot(sessionId, force = false) {
    const runtime = await getRuntime(force), identity = runtimeIdentity(runtime);
    if (identity !== activeIdentity) { seen.clear(); activeIdentity = identity; }
    if (collecting >= 4) throw fault(429, 'legacy-sync-busy');
    collecting++;
    try {
      const stream = await openEvents(runtime);
      const pending = await collectPending(stream, sessionId, windowMs);
      if (identity !== runtimeIdentity(await getRuntime(false))) throw fault(409, 'legacy-runtime-changed');
      return { runtime, identity, pending };
    } finally { collecting--; }
  }
  return async function handle(req, res) {
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'POST') throw fault(405, 'method-not-allowed');
      if (!req.__dshE2eeDecrypted || req.headers['x-dsh-e2ee'] !== '1') throw fault(403, 'encrypted-request-required');
      if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) throw fault(415, 'json-required');
      const url = new URL(req.url, 'http://localhost');
      if (url.search || !['/__dsh/legacy-interactions', '/__dsh/legacy-response'].includes(url.pathname)) throw fault(400, 'invalid-request');
      let size = 0, chunks = [];
      if (Number(req.headers['content-length']) > MAX_BODY) throw fault(413, 'request-too-large');
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw fault(413, 'request-too-large'); chunks.push(chunk); }
      let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw fault(400, 'invalid-request'); }
      const isReply = url.pathname === '/__dsh/legacy-response';
      if (!keys(input, isReply ? ['sessionId', 'id', 'answer'] : ['sessionId']) || !id(input.sessionId) ||
          (isReply && !id(input.id))) throw fault(400, 'invalid-request');
      for (const [key, item] of seen) if (now() - item.at > SEEN_TTL) seen.delete(key);
      const key = input.sessionId + '\n' + input.id;
      if (isReply && (!seen.has(key) || answering.has(key))) throw fault(409, 'request-not-pending');
      if (isReply) answering.add(key);
      try {
        const current = await snapshot(input.sessionId, isReply);
        if (!isReply) {
          for (const [knownKey, item] of seen) if (item.pending.sessionId === input.sessionId) seen.delete(knownKey);
          for (const pending of current.pending.values()) {
            if (seen.size >= MAX_PENDING) seen.delete(seen.keys().next().value);
            seen.set(input.sessionId + '\n' + pending.rpcId, { pending, identity: current.identity, at: now() });
          }
          reply(200, { ok: true, interactions: Array.from(current.pending.values(), item => item.interaction) });
          return;
        }
        const observed = seen.get(key), pending = current.pending.get(input.id);
        if (!observed || !pending || observed.identity !== current.identity || JSON.stringify(observed.pending) !== JSON.stringify(pending)) {
          seen.delete(key); throw fault(409, 'request-not-pending');
        }
        const value = responseValue(pending, input.answer);
        if (current.identity !== runtimeIdentity(await getRuntime(true))) { seen.delete(key); throw fault(409, 'legacy-runtime-changed'); }
        const upstream = await respond(current.runtime, { type: 'client-response', rpcId: pending.rpcId, result: { ok: true, value } });
        if (!upstream || upstream.accepted !== true) { seen.delete(key); throw fault(409, 'request-not-pending'); }
        seen.delete(key); reply(200, { ok: true });
      } finally { if (isReply) answering.delete(key); }
    } catch (error) { reply(error.status || 502, { ok: false, error: error.code || 'legacy-interaction-unavailable' }); }
  };
}

module.exports = { createDshLegacyInteractions, pendingFrame, responseValue, runtimeIdentity };
