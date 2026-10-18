'use strict';

// A journal of bridge submission identities, never of prompt plaintext. A
// dispatch decision is an exclusive, immutable file. Restart, lost responses
// and simultaneous handlers can inspect it but can never dispatch it again.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILES = 65536;
const MAX_PENDING = 64;
const MAX_FILE_BYTES = 4096;
const failure = code => Object.assign(Error(code), { code });
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const exact = (value, keys) => value && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function createDshPromptState({ directory, fileSystem = fs, now = Date.now } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw failure('prompt-state-invalid-options');
  const io = fileSystem, root = path.resolve(directory);
  function parents(file) {
    let at = path.resolve(file);
    for (;;) {
      try { const stat = io.lstatSync(at); if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('prompt-state-storage-unavailable'); }
      catch (error) { if (error.code !== 'ENOENT') throw failure('prompt-state-storage-unavailable'); }
      const next = path.dirname(at); if (next === at) break; at = next;
    }
  }
  function context(input, sessionId) {
    if (!input || typeof input.deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.deviceId) ||
        typeof input.runtimeId !== 'string' || !input.runtimeId || input.runtimeId.length > 4096 ||
        typeof input.secret !== 'string' || input.secret.length < 16 || input.secret.length > 256 ||
        typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || /[\u0000-\u001f\u007f]/.test(sessionId))
      throw failure('prompt-state-context-unavailable');
    const device = hash(input.deviceId), session = hash(sessionId);
    return { device, session, runtime: hash(input.runtimeId), key: hash(input.secret), secret: input.secret,
      folder: path.join(root, device, session) };
  }
  function file(ctx, id, suffix) {
    if (typeof id !== 'string' || !UUID.test(id)) throw failure('prompt-state-invalid-request');
    return path.join(ctx.folder, id.toLowerCase() + '.' + suffix + '.json');
  }
  function admissionFile(ctx, number) { return path.join(ctx.folder, 'admission-' + number + '.json'); }
  function admission(ctx, number) {
    const value = read(admissionFile(ctx, number), true);
    if (value && (!exact(value, ['version', 'requestId', 'at']) || value.version !== 1 || !UUID.test(value.requestId || '') ||
        !Number.isSafeInteger(value.at) || value.at <= 0)) throw failure('prompt-state-storage-unavailable');
    return value;
  }
  function read(name, optional = false) {
    parents(path.dirname(name));
    let fd;
    try {
      const before = io.lstatSync(name);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > MAX_FILE_BYTES)
        throw failure('prompt-state-storage-unavailable');
      fd = io.openSync(name, 'r'); const held = io.fstatSync(fd);
      if (held.dev !== before.dev || held.ino !== before.ino) throw failure('prompt-state-storage-unavailable');
      const bytes = io.readFileSync(fd), after = io.fstatSync(fd);
      if (bytes.length !== held.size || after.size !== held.size || after.mtimeMs !== held.mtimeMs || bytes.length > MAX_FILE_BYTES)
        throw failure('prompt-state-storage-unavailable');
      const value = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('prompt-state-storage-unavailable');
      return value;
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw failure('prompt-state-storage-unavailable');
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  function ensureFolder(ctx) {
    parents(ctx.folder);
    io.mkdirSync(ctx.folder, { recursive: true, mode: 0o700 });
    parents(ctx.folder);
  }
  function write(name, value) {
    let fd;
    try {
      parents(path.dirname(name));
      fd = io.openSync(name, 'wx', 0o600);
      io.writeFileSync(fd, JSON.stringify(value)); io.fsyncSync(fd);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      // A partially written file is retained as uncertain evidence.
      throw failure('prompt-state-storage-unavailable');
    } finally { if (fd !== undefined) io.closeSync(fd); }
    return true;
  }
  function names(ctx) {
    parents(ctx.folder);
    let result;
    try { result = io.readdirSync(ctx.folder); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw failure('prompt-state-storage-unavailable');
    }
    if (result.length > MAX_FILES || result.some(name => !/^(?:[a-f0-9-]{36}\.(?:intent|decision|receipt|review|unadmitted)|admission-[1-9][0-9]{0,5})\.json$/i.test(name)))
      throw failure('prompt-state-storage-unavailable');
    const intents = new Set(result.filter(name => name.endsWith('.intent.json')).map(name => name.slice(0, 36)));
    if (result.some(name => !name.startsWith('admission-') && !intents.has(name.slice(0, 36)))) throw failure('prompt-state-storage-unavailable');
    return result;
  }
  function operation(ctx, id) {
    const intent = read(file(ctx, id, 'intent'));
    if (!exact(intent, ['version', 'requestId', 'device', 'session', 'runtime', 'key', 'digest', 'createdAt',
      ...(intent.version === 2 ? ['admission'] : [])]) || ![1, 2].includes(intent.version) ||
        intent.requestId !== id.toLowerCase() || intent.device !== ctx.device || intent.session !== ctx.session ||
        !HASH.test(intent.runtime || '') || !HASH.test(intent.key || '') || !HASH.test(intent.digest || '') ||
        !Number.isSafeInteger(intent.createdAt) || intent.createdAt <= 0 || intent.version === 2 &&
        (!Number.isSafeInteger(intent.admission) || intent.admission < 1 || intent.admission > MAX_FILES))
      throw failure('prompt-state-storage-unavailable');
    const slot = intent.version === 2 ? admission(ctx, intent.admission) : null;
    const admitted = intent.version === 1 || slot?.requestId === intent.requestId;
    const decision = read(file(ctx, id, 'decision'), true);
    const receipt = read(file(ctx, id, 'receipt'), true);
    const review = read(file(ctx, id, 'review'), true);
    for (const item of [decision, receipt, review].filter(Boolean)) if (!exact(item, ['version', 'requestId', 'kind', 'at']) ||
        item.version !== 1 || item.requestId !== intent.requestId ||
        !Number.isSafeInteger(item.at) || item.at < intent.createdAt) throw failure('prompt-state-storage-unavailable');
    if (decision && (!['dispatch', 'cancel'].includes(decision.kind) || decision.kind === 'dispatch' && !admitted) ||
        receipt && (receipt.kind !== 'accepted' || decision?.kind !== 'dispatch') ||
        review && !['acknowledged', 'uncertain-reviewed', 'cancelled'].includes(review.kind)) throw failure('prompt-state-storage-unavailable');
    const state = receipt ? 'accepted' : decision?.kind === 'cancel' ? 'cancelled' : decision ? 'uncertain' : 'prepared';
    if (review && (review.kind === 'acknowledged' && state !== 'accepted' || review.kind === 'cancelled' && state !== 'cancelled' ||
        review.kind === 'uncertain-reviewed' && !decision)) throw failure('prompt-state-storage-unavailable');
    return { intent, state, admitted, reviewed: !!review, contextChanged: intent.runtime !== ctx.runtime || intent.key !== ctx.key,
      at: Math.max(intent.createdAt, decision?.at || 0, receipt?.at || 0, review?.at || 0) };
  }
  function dto(value) {
    return { requestId: value.intent.requestId, state: value.state, reviewed: value.reviewed,
      contextChanged: value.contextChanged, createdAt: value.intent.createdAt, updatedAt: value.at };
  }
  function pending(ctx) {
    const list = names(ctx).filter(name => name.endsWith('.intent.json')).map(name => operation(ctx, name.slice(0, 36)))
      .filter(value => !value.reviewed && value.state !== 'cancelled').sort((a, b) => b.intent.createdAt - a.intent.createdAt);
    if (list.length > MAX_PENDING) throw failure('prompt-state-capacity');
    return list;
  }
  function nextAdmission(ctx, all) {
    const slots = all.filter(name => name.startsWith('admission-')).map(name => Number(name.slice(10, -5))).sort((a, b) => a - b);
    if (slots.some((number, index) => number !== index + 1)) throw failure('prompt-state-storage-unavailable');
    const count = slots.length;
    const head = count ? admission(ctx, count) : null;
    const value = head ? operation(ctx, head.requestId) : null;
    if (count && (!value || !value.admitted || value.intent.admission !== count)) throw failure('prompt-state-storage-unavailable');
    // Normal v2 histories need only their current head. Older journals and
    // interrupted, unclaimed preparations get the conservative full scan.
    const abandoned = all.filter(name => name.endsWith('.unadmitted.json'));
    for (const name of abandoned) {
      const marker = read(path.join(ctx.folder, name)), id = name.slice(0, 36), cancelled = operation(ctx, id);
      if (!exact(marker, ['version', 'requestId', 'at']) || marker.version !== 1 || marker.requestId !== id ||
          !Number.isSafeInteger(marker.at) || marker.at < cancelled.intent.createdAt || cancelled.admitted ||
          cancelled.state !== 'cancelled' || !cancelled.reviewed) throw failure('prompt-state-storage-unavailable');
    }
    const outstanding = all.filter(name => name.endsWith('.intent.json')).length - abandoned.length === count ?
      value && !value.reviewed && value.state !== 'cancelled' ? [value] : [] : pending(ctx);
    return { number: count + 1, outstanding };
  }
  function digest(ctx, request) {
    return crypto.createHmac('sha256', ctx.secret).update('pocket-bridge-prompt-v1\0')
      .update(JSON.stringify([ctx.device, ctx.session, ctx.runtime, request.mode, request.content])).digest('hex');
  }
  function recovery(ctx, request, values, code = 'prompt-recovery-required') {
    const problem = failure(code);
    problem.operations = values.map(value => ({ ...dto(value),
      matchesDraft: !value.contextChanged && value.intent.digest === digest(ctx, request) }));
    return problem;
  }
  function prepare(input, request) {
    const ctx = context(input, request?.sessionId);
    if (typeof request.requestId !== 'string' || !UUID.test(request.requestId)) throw failure('prompt-state-invalid-request');
    const id = request.requestId.toLowerCase();
    ensureFolder(ctx);
    if (read(file(ctx, id, 'intent'), true)) {
      const value = operation(ctx, id);
      if (value.contextChanged || value.intent.digest !== digest(ctx, request))
        throw recovery(ctx, request, [value], 'prompt-state-context-changed');
      return { ...dto(value), matchesDraft: true };
    }
    const all = names(ctx), next = nextAdmission(ctx, all), outstanding = next.outstanding;
    if (outstanding.length) throw recovery(ctx, request, outstanding);
    if (all.length >= MAX_FILES - 6) throw failure('prompt-state-capacity');
    const createdAt = now(); if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw failure('prompt-state-storage-unavailable');
    write(file(ctx, id, 'intent'), { version: 2, requestId: id, device: ctx.device, session: ctx.session,
      runtime: ctx.runtime, key: ctx.key, digest: digest(ctx, request), createdAt, admission: next.number });
    const claimed = write(admissionFile(ctx, next.number), { version: 1, requestId: id, at: now() });
    if (!claimed && admission(ctx, next.number)?.requestId !== id) {
      // Another process won this session's next slot. This intent can never
      // dispatch; preserve its cancellation and return the winning operation.
      write(file(ctx, id, 'decision'), { version: 1, requestId: id, kind: 'cancel', at: now() });
      write(file(ctx, id, 'review'), { version: 1, requestId: id, kind: 'cancelled', at: now() });
      write(file(ctx, id, 'unadmitted'), { version: 1, requestId: id, at: now() });
      throw recovery(ctx, request, pending(ctx));
    }
    const value = operation(ctx, id);
    if (value.contextChanged || value.intent.digest !== digest(ctx, request)) throw failure('prompt-state-context-changed');
    return { ...dto(value), matchesDraft: true };
  }
  function begin(input, request) {
    const ctx = context(input, request.sessionId), value = operation(ctx, request.requestId);
    if (value.contextChanged || value.intent.digest !== digest(ctx, request)) throw failure('prompt-state-context-changed');
    if (value.state !== 'prepared' || value.reviewed || !value.admitted) return { dispatch: false, operation: dto(value) };
    const claimed = write(file(ctx, request.requestId, 'decision'), { version: 1, requestId: value.intent.requestId, kind: 'dispatch', at: now() });
    return { dispatch: claimed, operation: dto(operation(ctx, request.requestId)) };
  }
  function accepted(input, request) {
    const ctx = context(input, request.sessionId), value = operation(ctx, request.requestId);
    if (value.contextChanged || value.intent.digest !== digest(ctx, request) || !['uncertain', 'accepted'].includes(value.state))
      throw failure('prompt-state-context-changed');
    write(file(ctx, request.requestId, 'receipt'), { version: 1, requestId: value.intent.requestId, kind: 'accepted', at: now() });
    return dto(operation(ctx, request.requestId));
  }
  function state(input, request) {
    const ctx = context(input, request.sessionId);
    if (request.action === 'list') return { operations: pending(ctx).map(dto) };
    let value = operation(ctx, request.requestId);
    if (request.action === 'status') return { operation: dto(value) };
    if (request.action === 'cancel-prepared') {
      if (value.state === 'prepared') write(file(ctx, request.requestId, 'decision'),
        { version: 1, requestId: value.intent.requestId, kind: 'cancel', at: now() });
      value = operation(ctx, request.requestId);
      if (value.state !== 'cancelled') throw failure('prompt-recovery-required');
    } else if (request.action === 'acknowledge') {
      if (value.state !== 'accepted') throw failure('prompt-recovery-required');
    } else if (request.action !== 'review-uncertain' || request.confirm !== true || value.state !== 'uncertain')
      throw failure('prompt-recovery-required');
    write(file(ctx, request.requestId, 'review'), { version: 1, requestId: value.intent.requestId,
      kind: value.state === 'accepted' ? 'acknowledged' : value.state === 'cancelled' ? 'cancelled' : 'uncertain-reviewed', at: now() });
    if (value.state === 'cancelled' && !value.admitted) write(file(ctx, request.requestId, 'unadmitted'),
      { version: 1, requestId: value.intent.requestId, at: now() });
    return { operation: dto(operation(ctx, request.requestId)) };
  }
  return { prepare, begin, accepted, state };
}
module.exports = { createDshPromptState, MAX_PENDING, MAX_FILES };
