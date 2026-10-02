'use strict';
// Real local HTTP exercises with isolated read-only RPC fixtures. These tests do
// not start Codex, touch a real desktop window, or submit a model request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { normalizeComposerText } = require('./codex-desktop-text.js');
const { createDesktopRelayService, MAX_BODY_BYTES } = require('./codex-desktop-relay.js');
const THREAD = '01a0f60e-881d-7ed0-8cfe-a5c356738b45';
const OTHER_THREAD = '01a0f60e-881d-7ed0-8cfe-a5c356738b46';
if (process.platform !== 'win32') throw Error('Run these Windows realpath checks on Windows.');
const evidenceRoot = path.resolve(__dirname, '..', '..', 'desktop-relay-service-check-20261001', `run-${Date.now()}-${process.pid}`);
if (path.parse(evidenceRoot).root.toLowerCase() !== 'd:\\') throw Error('Desktop relay tests must write to D:.');
fs.mkdirSync(evidenceRoot, { recursive: true });
let checks = 0, fixtureCount = 0;
function message(id, text, extra = {}) { return { id, type: 'userMessage', content: [{ type: 'text', text }], ...extra }; }
function queueItem(id, text) { return { id, input: [{ type: 'text', text }] }; }
function nativeResult(request, overrides = {}) {
  const bytes = Buffer.from(normalizeComposerText(request.text), 'utf8');
  return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd,
    desktopIdentity: { packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: '26.928.3736.0' },
    composerTextProof: { version: 1, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), utf8Bytes: bytes.length },
    ...overrides };
}
function fixture(options = {}) {
  const base = path.join(evidenceRoot, 'case-' + (++fixtureCount));
  const cwd = path.join(base, 'project'), otherCwd = path.join(base, 'other-project');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(otherCwd, { recursive: true });
  const state = { users: [], queued: [], calls: [], sendCalls: [], active: 0, maxActive: 0 };
  const rpc = async (method, params) => {
    state.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: options.authoritativeCwd || cwd,
      ...(options.thread || {}) } };
    if (method === 'thread/turns/list') {
      assert.equal(params.itemsView, 'full'); assert.equal(params.limit, 10);
      assert.equal(params.sortDirection, 'desc');
      if (options.historyError) throw options.historyError;
      return { data: [{ id: 'fixture-turn', itemsView: 'full', items: state.users.slice() }] };
    }
    if (method === 'thread/queue/list') {
      if (options.queueError) throw options.queueError;
      return { data: state.queued.slice(), nextCursor: null };
    }
    throw Error('A mutating or arbitrary RPC was called: ' + method);
  };
  const driver = {
    inspect: async () => options.inspect || { available: true, exe: 'PRIVATE EXE', clipboard: 'PRIVATE CLIPBOARD' },
    send: async request => {
      state.sendCalls.push(request); state.active++; state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (options.onSend) return await options.onSend(request, state);
        state.users.push(message('new-message-' + state.sendCalls.length, request.text));
        return { submitted: true, verifiedThreadId: request.threadId, actualCwd: cwd,
          desktopIdentity: { exe: 'PRIVATE EXE', clipboard: 'PRIVATE CLIPBOARD' } };
      } finally { state.active--; }
    }
  };
  const make = () => createDesktopRelayService(base, { rpc, driver, confirmTimeoutMs: 45, pollIntervalMs: 5 });
  return { base, cwd, otherCwd, state, rpc, driver, make, service: make(),
    request: (id = 'request-1', text = 'Exact private text\nSecond line.') => ({ action: 'send', id, threadId: THREAD, cwd, text }) };
}
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
async function denied(code, fn) { await assert.rejects(fn, error => error.code === code); }
async function withHttp(service, fn) {
  const server = http.createServer(service.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  async function request(method, query = '', body, headers = {}) {
    const raw = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/codex-desktop-relay' + query, method,
        headers: { ...(raw !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text), raw: text }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject); if (raw !== null) req.write(raw); req.end();
    });
  }
  try { await fn(request, port); } finally { await new Promise(resolve => server.close(resolve)); }
}
async function main() {
  await check('HTTP status and confirmed receipt expose no private message, paths or desktop metadata', async () => {
    const f = fixture();
    await withHttp(f.service, async (request, port) => {
      const status = await request('GET'); assert.deepEqual(status.body, { available: true, reason: 'ready' });
      const sent = await request('POST', '', f.request(), { 'x-dsh-desktop-relay': '1', origin: `http://127.0.0.1:${port}` });
      assert.equal(sent.status, 200); assert.equal(sent.body.state, 'accepted');
      assert.equal(sent.body.delivery, 'message'); assert.equal(sent.body.deliveryConfirmed, true);
      assert.equal(sent.body.executionConfirmed, false); assert.equal(sent.body.messageId, 'new-message-1');
      assert.equal(sent.headers['cache-control'], 'no-store');
      const receipt = await request('GET', `?id=request-1&threadId=${THREAD}`);
      assert.equal(receipt.body.state, 'accepted');
      for (const response of [status, sent, receipt]) {
        assert(!response.raw.includes(f.cwd)); assert(!response.raw.includes('Exact private text'));
        assert(!response.raw.includes('PRIVATE')); assert(!response.raw.includes('fingerprint'));
        assert(!response.raw.includes('canonicalCwd')); assert(!response.raw.includes('request":'));
      }
      assert.equal((await request('GET', `?id=request-1&threadId=${OTHER_THREAD}`)).status, 404);
      assert.equal((await request('GET', '?id=request-1')).body.code, 'invalid-thread-id');
    });
    assert.deepEqual(new Set(f.state.calls.map(call => call.method)), new Set(['thread/read', 'thread/turns/list', 'thread/queue/list']));
  });
  await check('HTTP rejects missing relay header, other origins, malformed input, non-UUIDs and oversized bodies before native action', async () => {
    const f = fixture();
    await withHttp(f.service, async request => {
      assert.equal((await request('POST', '', f.request())).status, 403);
      assert.equal((await request('POST', '', f.request(), { 'x-dsh-desktop-relay': '1', origin: 'https://other.example' })).status, 403);
      const headers = { 'x-dsh-desktop-relay': '1' };
      assert.equal((await request('POST', '', '{', headers)).body.code, 'invalid-request');
      assert.equal((await request('POST', '', { ...f.request(), threadId: 'title-is-not-identity' }, headers)).body.code, 'invalid-thread-id');
      assert.equal((await request('POST', '', { ...f.request(), attachments: [] }, headers)).body.code, 'invalid-request');
      assert.equal((await request('POST', '', 'x'.repeat(MAX_BODY_BYTES + 1), headers)).status, 413);
      assert.equal((await request('DELETE')).status, 405);
    });
    assert.equal(f.state.sendCalls.length, 0); assert.equal(f.state.calls.length, 0);
  });
  await check('authoritative project mismatch, unavailable directory and archived conversation prevent typing', async () => {
    const mismatch = fixture();
    const wrong = await mismatch.service.send({ ...mismatch.request(), cwd: mismatch.otherCwd });
    assert.equal(wrong.code, 'wrong-project'); assert.equal(mismatch.state.sendCalls.length, 0);
    const missing = fixture({ authoritativeCwd: path.join(evidenceRoot, 'not-created') });
    assert.equal((await missing.service.send(missing.request())).code, 'project-unavailable');
    const archived = fixture({ thread: { path: 'D:\\private\\archived_sessions\\thread.jsonl' } });
    assert.equal((await archived.service.send(archived.request())).code, 'conversation-unavailable');
    const deleted = fixture({ thread: { deleted: true } });
    assert.equal((await deleted.service.send(deleted.request())).code, 'conversation-unavailable');
    for (const f of [missing, archived, deleted]) assert.equal(f.state.sendCalls.length, 0);
  });
  await check('failed history or transient queue baseline stops before dispatch; an unsupported queue method remains compatible', async () => {
    for (const options of [{ historyError: Error('connection disconnected') }, { queueError: Error('temporary 502') }]) {
      const f = fixture(options); const result = await f.service.send(f.request());
      assert.equal(result.state, 'failed'); assert.equal(result.code, 'baseline-unavailable');
      assert.equal(f.state.sendCalls.length, 0);
    }
    const old = fixture({ queueError: Object.assign(Error('Method not found'), { code: -32601 }) });
    assert.equal((await old.service.send(old.request())).state, 'accepted');
    assert.equal(old.state.sendCalls.length, 1);
  });
  await check('old matching messages and queue items plus an empty composer never establish new delivery', async () => {
    const f = fixture({ onSend: async request => ({ submitted: true, composerEmpty: true,
      verifiedThreadId: request.threadId, actualCwd: request.cwd }) });
    f.state.users.push(message('old-message', f.request().text));
    f.state.queued.push(queueItem('old-queue', f.request().text));
    const result = await f.service.send(f.request());
    assert.equal(result.state, 'unknown'); assert.equal(result.deliveryConfirmed, false);
    assert.equal(result.code, 'delivery-unconfirmed'); assert.equal(result.messageId, undefined);
    assert.equal(f.state.sendCalls.length, 1);
  });
  await check('a new native queue ID confirms queued delivery without claiming execution', async () => {
    const f = fixture({ onSend: async (request, state) => {
      state.queued.push(queueItem('confirmed-new-queue', request.text));
      return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd };
    } });
    f.state.queued.push(queueItem('old-queue', f.request().text));
    const result = await f.service.send(f.request());
    assert.equal(result.state, 'accepted'); assert.equal(result.delivery, 'queued');
    assert.equal(result.queueId, 'confirmed-new-queue'); assert.equal(result.deliveryConfirmed, true);
    assert.equal(result.executionConfirmed, false); assert.equal(result.messageId, undefined);
  });
  await check('changed text or mixed attachments cannot be mistaken for exact plain-text delivery', async () => {
    const f = fixture({ onSend: async (request, state) => {
      state.users.push(message('different-text', request.text + 'changed'));
      state.users.push(message('mixed-content', request.text, { content: [{ type: 'text', text: request.text }, { type: 'image', url: 'private' }] }));
      state.queued.push(queueItem('trimmed-text', request.text.trim() + 'changed'));
      return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd };
    } });
    assert.equal((await f.service.send(f.request())).state, 'unknown');
  });
  await check('simultaneous same-ID requests send once and conflicting content is rejected even after acceptance', async () => {
    const f = fixture({ onSend: async (request, state) => {
      await new Promise(resolve => setTimeout(resolve, 15)); state.users.push(message('unique-new-message', request.text));
      return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd };
    } });
    const first = f.service.send(f.request()); const duplicate = await f.service.send(f.request());
    assert(['prepared', 'sending'].includes(duplicate.state)); assert.equal((await first).state, 'accepted');
    const acceptedDuplicate = await f.service.send({ ...f.request(), cwd: f.cwd.toLowerCase() + '\\' });
    assert.equal(acceptedDuplicate.messageId, 'unique-new-message'); assert.equal(f.state.sendCalls.length, 1);
    await denied('request-id-conflict', () => f.service.send(f.request('request-1', 'different text')));
    await denied('request-id-conflict', () => f.service.send({ ...f.request(), threadId: OTHER_THREAD }));
    assert.equal(f.state.sendCalls.length, 1);
  });
  await check('GUI operations for different requests are serialized', async () => {
    const f = fixture({ onSend: async (request, state) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      state.users.push(message('new-' + request.requestId, request.text));
      return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd };
    } });
    const results = await Promise.all([f.service.send(f.request('first', 'one')),
      f.service.send({ ...f.request('second', 'two'), threadId: OTHER_THREAD })]);
    assert(results.every(result => result.state === 'accepted')); assert.equal(f.state.maxActive, 1);
    assert.equal(f.state.sendCalls.length, 2);
  });
  await check('late read-only receipt reconciliation accepts a new message without another GUI send', async () => {
    const f = fixture({ onSend: async request => ({ submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd }) });
    assert.equal((await f.service.send(f.request())).state, 'unknown');
    assert.equal((await f.service.send(f.request())).state, 'unknown');
    f.state.users.push(message('late-message', f.request().text));
    const late = await f.service.get('request-1', THREAD);
    assert.equal(late.state, 'accepted'); assert.equal(late.messageId, 'late-message');
    assert.equal(f.state.sendCalls.length, 1);
    const restarted = f.make(); assert.equal((await restarted.get('request-1', THREAD)).state, 'accepted');
    assert.equal((await restarted.send(f.request())).state, 'accepted'); assert.equal(f.state.sendCalls.length, 1);
  });
  await check('restart treats prepared or sending records as unknown and never repeats their send', async () => {
    for (const interruptedState of ['prepared', 'sending']) {
      const f = fixture({ onSend: async request => ({ submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd }) });
      await f.service.send(f.request());
      const journalPath = path.join(f.base, 'logs', 'codex-desktop-relay.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal.records[0].state = interruptedState;
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      const restarted = f.make();
      assert.equal((await restarted.send(f.request())).state, 'unknown');
      assert.equal(f.state.sendCalls.length, 1);
      f.state.queued.push(queueItem('late-after-restart', f.request().text));
      assert.equal((await restarted.get('request-1', THREAD)).delivery, 'queued');
      assert.equal(f.state.sendCalls.length, 1);
    }
  });
  await check('a known pre-dispatch refusal fails; a possibly submitted error stays unknown without retry', async () => {
    for (const submitted of [false, null]) {
      const f = fixture({ onSend: async () => { throw Object.assign(Error('PRIVATE ERROR AND CLIPBOARD'), { code: 'draft-present', submitted }); } });
      const result = await f.service.send(f.request());
      assert.equal(result.state, submitted === false ? 'failed' : 'unknown');
      assert.equal(result.code, submitted === false ? 'draft-present' : 'unknown');
      if (submitted !== false) assert(!result.message.includes('Nothing was sent'));
      assert(!JSON.stringify(result).includes('PRIVATE')); await f.service.send(f.request());
      assert.equal(f.state.sendCalls.length, 1);
    }
  });
  await check('post-dispatch target mismatch blocks late proof from approving the wrong desktop target', async () => {
    const f = fixture({ onSend: async (request, state) => {
      state.users.push(message('coincidental-new-message', request.text));
      return { submitted: true, verifiedThreadId: OTHER_THREAD, actualCwd: request.cwd };
    } });
    const result = await f.service.send(f.request());
    assert.equal(result.state, 'unknown'); assert.equal(result.code, 'desktop-target-unconfirmed');
    assert.equal((await f.service.get('request-1', THREAD)).state, 'unknown');
    assert.equal(f.state.sendCalls.length, 1);
  });
  await check('only boolean draft cleanup hints survive a refusal, a receipt read and restart without exposing native errors', async () => {
    for (const throws of [false, true]) {
      const hints = { desktopDraftRemaining: true, desktopDraftCleared: false };
      const f = fixture({ onSend: async () => {
        const result = { submitted: false, code: 'send-control-unavailable', ...hints, privateDraft: 'PRIVATE DRAFT' };
        if (throws) throw Object.assign(Error('PRIVATE ERROR'), result);
        return result;
      } });
      const sent = await f.service.send(f.request());
      for (const receipt of [sent, await f.service.get('request-1', THREAD), await f.make().get('request-1', THREAD)]) {
        assert.equal(receipt.state, 'failed'); assert.equal(receipt.deliveryConfirmed, false);
        assert.equal(receipt.desktopDraftRemaining, true); assert.equal(receipt.desktopDraftCleared, false);
        assert(!JSON.stringify(receipt).includes('PRIVATE'));
      }
    }
    const invalid = fixture({ onSend: async () => ({ submitted: false, code: 'draft-present',
      desktopDraftRemaining: 'PRIVATE', desktopDraftCleared: { clipboard: 'PRIVATE' } }) });
    const receipt = await invalid.service.send(invalid.request());
    assert.equal(receipt.desktopDraftRemaining, undefined); assert.equal(receipt.desktopDraftCleared, undefined);
  });
  await check('a different request ID cannot bypass an in-flight or unknown send for the same conversation', async () => {
    let finish;
    const f = fixture({ onSend: async request => {
      await new Promise(resolve => { finish = resolve; });
      return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd };
    } });
    const first = f.service.send(f.request('first'));
    await denied('pending-request-exists', () => f.service.send(f.request('second', 'another text')));
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    finish(); assert.equal((await first).state, 'unknown');
    await denied('pending-request-exists', () => f.service.send(f.request('third')));
    await denied('pending-request-exists', () => f.make().send(f.request('after-restart')));
    assert.equal(f.state.sendCalls.length, 1);
    f.state.users.push(message('first-late-confirmation', f.request().text));
    assert.equal((await f.service.get('first', THREAD)).state, 'accepted');
  });
  await check('two fresh matching messages, or a message plus an unrelated matching queue entry, are ambiguous', async () => {
    for (const mixQueue of [false, true]) {
      const f = fixture({ onSend: async (request, state) => {
        state.users.push(message('matching-one', request.text));
        if (mixQueue) state.queued.push(queueItem('another-matching-delivery', request.text));
        else state.users.push(message('matching-two', request.text));
        return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd };
      } });
      const result = await f.service.send(f.request());
      assert.equal(result.state, 'unknown'); assert.equal(result.code, 'delivery-ambiguous');
      assert.equal(result.deliveryConfirmed, false); assert.equal(result.messageId, undefined);
      assert.equal(result.queueId, undefined); assert.equal(f.state.sendCalls.length, 1);
    }
  });
  await check('an identical new request waits until its earlier queue delivery is uniquely recorded in history', async () => {
    const f = fixture({ onSend: async (request, state) => {
      if (state.sendCalls.length === 1) state.queued.push(queueItem('prior-owned-queue', request.text));
      else state.users.push(message('second-owned-message', request.text));
      return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd };
    } });
    assert.equal((await f.service.send(f.request('first'))).delivery, 'queued');
    const blocked = await f.service.send(f.request('blocked'));
    assert.equal(blocked.state, 'failed'); assert.equal(blocked.code, 'previous-queued-delivery');
    assert.equal(f.state.sendCalls.length, 1);
    f.state.queued.length = 0; f.state.users.push(message('prior-promoted-message', f.request().text));
    const promoted = await f.service.get('first', THREAD);
    assert.equal(promoted.delivery, 'message'); assert.equal(promoted.queueId, 'prior-owned-queue');
    assert.equal(promoted.messageId, 'prior-promoted-message');
    const later = await f.service.send(f.request('second'));
    assert.equal(later.state, 'accepted'); assert.equal(later.messageId, 'second-owned-message');
    assert.equal(f.state.sendCalls.length, 2);
    const restarted = f.make(); assert.equal((await restarted.get('first', THREAD)).messageId, 'prior-promoted-message');
    assert.equal((await restarted.get('second', THREAD)).messageId, 'second-owned-message');
  });
  await check('a legacy stale unknown receipt cannot claim an item already owned by another persisted receipt', async () => {
    const f = fixture();
    await f.service.send(f.request('legacy-unknown')); await f.service.send(f.request('confirmed-owner'));
    const journalPath = path.join(f.base, 'logs', 'codex-desktop-relay.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const stale = journal.records[0]; stale.state = 'unknown'; stale.delivery = null;
    delete stale.messageId; delete stale.turnId; stale.baseline.userIds = ['new-message-1'];
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const restarted = f.make();
    assert.equal((await restarted.get('legacy-unknown', THREAD)).state, 'unknown');
    assert.equal((await restarted.get('confirmed-owner', THREAD)).messageId, 'new-message-2');
    assert.equal(f.state.sendCalls.length, 2);
  });
  await check('a journal that assigns one delivery item to two requests is rejected', async () => {
    const f = fixture(); await f.service.send(f.request('first')); await f.service.send(f.request('second'));
    const journalPath = path.join(f.base, 'logs', 'codex-desktop-relay.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.records[1].messageId = journal.records[0].messageId;
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    assert.deepEqual(await f.make().status(), { available: false, reason: 'journal-unavailable' });
  });
  await check('a corrupt journal fails closed and unavailable status never returns native details', async () => {
    const f = fixture(); fs.mkdirSync(path.join(f.base, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(f.base, 'logs', 'codex-desktop-relay.json'), '{invalid');
    const broken = f.make(); assert.deepEqual(await broken.status(), { available: false, reason: 'journal-unavailable' });
    await denied('journal-unavailable', () => broken.send(f.request())); assert.equal(f.state.sendCalls.length, 0);
    const unavailable = fixture({ inspect: { available: false, code: 'draft-present', clipboard: 'PRIVATE' } });
    assert.deepEqual(await unavailable.service.status(), { available: false, reason: 'draft-present' });
    assert.equal((await unavailable.service.send(unavailable.request())).state, 'failed');
    assert.equal(unavailable.state.sendCalls.length, 0);
    const installed = fixture({ inspect: { available: true, desktopRunning: false, version: '0.159.0', exe: 'PRIVATE' } });
    assert.deepEqual(await installed.service.status(), { available: true, reason: 'ready', desktopRunning: false, version: '0.159.0' });
  });
  await check('verified clipboard text accepts only exact contents or one extra LF for the tested desktop version', async () => {
    for (const text of ['Private native text', 'A real final newline\n', 'Unicode 🦀\r\nwith real spaces  \n']) {
      for (const extraLF of [false, true]) {
        const f = fixture({ onSend: async (request, state) => {
          state.users.push(message('verified-native-message', normalizeComposerText(request.text) + (extraLF ? '\n' : '')));
          return nativeResult(request);
        } });
        const result = await f.service.send(f.request('native', text));
        assert.equal(result.state, 'accepted'); assert.equal(result.messageId, 'verified-native-message');
        const publicText = JSON.stringify(result);
        for (const privateField of ['sha256', 'utf8Bytes', 'composerTextProof', 'nativeSubmission', 'packageFamilyName'])
          assert(!publicText.includes(privateField));
        assert(!publicText.includes(text));
      }
    }
  });
  await check('wrong clipboard proof, bytes, family or desktop version cannot enable the native LF variant', async () => {
    for (const variant of ['wrong-hash', 'wrong-bytes', 'proof-version', 'proof-extra', 'missing-proof', 'wrong-family', 'future-version']) {
      const f = fixture({ onSend: async (request, state) => {
        state.users.push(message('unverified-native-message', request.text + '\n'));
        const result = nativeResult(request);
        if (variant === 'wrong-hash') result.composerTextProof.sha256 = '0'.repeat(64);
        if (variant === 'wrong-bytes') result.composerTextProof.utf8Bytes++;
        if (variant === 'proof-version') result.composerTextProof.version = 2;
        if (variant === 'proof-extra') result.composerTextProof.text = request.text;
        if (variant === 'missing-proof') delete result.composerTextProof;
        if (variant === 'wrong-family') result.desktopIdentity.packageFamilyName = 'another-package';
        if (variant === 'future-version') result.desktopIdentity.version = '26.929.3736.0';
        return result;
      } });
      const result = await f.service.send(f.request());
      assert.equal(result.state, 'unknown', variant); assert.equal(result.deliveryConfirmed, false);
      assert.equal(result.messageId, undefined); assert.equal(f.state.sendCalls.length, 1);
      assert.equal((await f.make().get('request-1', THREAD)).state, 'unknown');
    }
  });
  await check('extra newlines, changed spaces, prefix text, mixed content and newline-only history remain unconfirmed', async () => {
    for (const variant of ['two-extra-LF', 'changed-space', 'prefix', 'mixed', 'newline-only']) {
      const f = fixture({ onSend: async (request, state) => {
        let text = request.text + '\n\n';
        if (variant === 'changed-space') text = request.text + ' \n';
        if (variant === 'prefix') text = request.text + 'additional text\n';
        if (variant === 'newline-only') text = '\n';
        const extra = variant === 'mixed' ? { content: [{ type: 'text', text: request.text + '\n' }, { type: 'image', url: 'private' }] } : {};
        state.users.push(message('changed-native-message', text, extra));
        return nativeResult(request);
      } });
      const result = await f.service.send(f.request('native', 'User real newline\n'));
      assert.equal(result.state, 'unknown', variant); assert.equal(result.messageId, undefined);
    }
    const f = fixture();
    await denied('invalid-text', () => f.service.send(f.request('invalid-newline-only', '\n')));
    assert.equal(f.state.sendCalls.length, 0);
  });
  await check('native LF matching still requires a fresh unique unclaimed ID outside the baseline', async () => {
    const old = fixture({ onSend: async request => nativeResult(request) });
    old.state.users.push(message('old-native-message', old.request().text + '\n'));
    old.state.queued.push(queueItem('old-native-queue', old.request().text + '\n'));
    assert.equal((await old.service.send(old.request())).state, 'unknown');
    const ambiguous = fixture({ onSend: async (request, state) => {
      state.users.push(message('new-exact', request.text), message('new-extra-LF', request.text + '\n'));
      return nativeResult(request);
    } });
    assert.equal((await ambiguous.service.send(ambiguous.request())).code, 'delivery-ambiguous');
    const wrongThread = fixture({ onSend: async (request, state) => {
      state.users.push(message('wrong-target-message', request.text + '\n'));
      return nativeResult(request, { verifiedThreadId: OTHER_THREAD });
    } });
    assert.equal((await wrongThread.service.send(wrongThread.request())).code, 'desktop-target-unconfirmed');
    const wrongCwd = fixture({ onSend: async (request, state) => {
      state.users.push(message('wrong-project-message', request.text + '\n'));
      return nativeResult(request, { actualCwd: wrongCwd.otherCwd });
    } });
    assert.equal((await wrongCwd.service.send(wrongCwd.request())).code, 'desktop-target-unconfirmed');
  });
  await check('persisted native proof reconciles a late LF receipt after restart without another desktop send', async () => {
    const f = fixture({ onSend: async request => nativeResult(request) });
    const before = await f.service.send(f.request()); assert.equal(before.state, 'unknown');
    const journalPath = path.join(f.base, 'logs', 'codex-desktop-relay.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(journal.records[0].nativeSubmission.version, '26.928.3736.0');
    journal.records[0].state = 'sending'; fs.writeFileSync(journalPath, JSON.stringify(journal));
    f.state.users.push(message('late-native-LF', f.request().text + '\n'));
    const restarted = f.make();
    assert.equal((await restarted.get('request-1', THREAD)).messageId, 'late-native-LF');
    assert.equal((await restarted.send(f.request())).state, 'accepted');
    assert.equal(f.state.sendCalls.length, 1);
    const corrupted = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    corrupted.records[0].nativeSubmission.composerTextProof.sha256 = '0'.repeat(64);
    fs.writeFileSync(journalPath, JSON.stringify(corrupted));
    assert.equal((await f.make().status()).reason, 'journal-unavailable');
  });
  await check('legacy unknown records without clipboard proof do not retroactively claim an extra-LF message', async () => {
    const f = fixture({ onSend: async request => ({ submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd }) });
    assert.equal((await f.service.send(f.request())).state, 'unknown');
    f.state.users.push(message('late-unproven-LF', f.request().text + '\n'));
    assert.equal((await f.make().get('request-1', THREAD)).state, 'unknown');
    assert.equal(f.state.sendCalls.length, 1);
  });
  await check('native LF variants cannot reuse another persisted receipt delivery ID', async () => {
    const f = fixture({ onSend: async (request, state) => {
      state.users.push(message('native-owned-' + state.sendCalls.length, request.text + '\n'));
      return nativeResult(request);
    } });
    await f.service.send(f.request('stale-native')); await f.service.send(f.request('native-owner'));
    const journalPath = path.join(f.base, 'logs', 'codex-desktop-relay.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const stale = journal.records[0]; stale.state = 'unknown'; stale.delivery = null;
    delete stale.messageId; delete stale.turnId; stale.baseline.userIds = ['native-owned-1'];
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const restarted = f.make();
    assert.equal((await restarted.get('stale-native', THREAD)).state, 'unknown');
    assert.equal((await restarted.get('native-owner', THREAD)).messageId, 'native-owned-2');
    assert.equal(f.state.sendCalls.length, 2);
  });
  await check('CRLF-equivalent requests cannot bypass a confirmed pending native queue', async () => {
    const f = fixture({ onSend: async (request, state) => {
      state.queued.push(queueItem('owned-native-queue', normalizeComposerText(request.text) + '\n'));
      return nativeResult(request);
    } });
    assert.equal((await f.service.send(f.request('first', 'text\r\n'))).delivery, 'queued');
    assert.equal((await f.service.send(f.request('second', 'text\n'))).code, 'previous-queued-delivery');
    assert.equal(f.state.sendCalls.length, 1);
  });
  await check('both directions of native final-LF and CRLF queue overlap block dispatch before stealing prior history, including restart', async () => {
    for (const restartBeforeSecond of [false, true]) for (const firstStorage of ['copied-exact', 'extra-LF']) for (const [firstText, nextText] of [
      ['hello', 'hello\n'], ['hello\n', 'hello'],
      ['hello\r\n', 'hello\n\n'], ['hello\n\n', 'hello\r\n'],
      ['hello\n', 'hello\n\n'], ['hello\n\n', 'hello\n']
    ]) {
      let allowNextDelivery = false;
      const firstStoredText = normalizeComposerText(firstText) + (firstStorage === 'extra-LF' ? '\n' : '');
      const f = fixture({ onSend: async (request, state) => {
        if (state.sendCalls.length === 1) {
          state.queued.push(queueItem('first-native-queue', firstStoredText));
        } else if (!allowNextDelivery) {
          // Reproduce the dangerous race: only the FIRST queued message enters
          // history during the second dispatch. The second has no delivery.
          state.queued.length = 0;
          state.users.push(message('first-owned-history', firstStoredText));
        } else state.users.push(message('next-owned-history', normalizeComposerText(request.text) + '\n'));
        return nativeResult(request);
      } });
      assert.equal((await f.service.send(f.request('first', firstText))).delivery, 'queued');
      const secondService = restartBeforeSecond ? f.make() : f.service;
      const refused = await secondService.send(f.request('second', nextText));
      assert.equal(refused.state, 'failed'); assert.equal(refused.code, 'previous-queued-delivery');
      assert.equal(refused.deliveryConfirmed, false); assert.equal(refused.messageId, undefined);
      assert.equal(f.state.sendCalls.length, 1, 'Overlap must be refused before native dispatch.');
      assert.equal(f.state.users.length, 0, 'The dangerous second-driver race must never run.');
      const restarted = f.make();
      assert.equal((await restarted.get('first', THREAD)).delivery, 'queued');
      assert.equal((await restarted.get('second', THREAD)).state, 'failed');
      assert.equal(f.state.sendCalls.length, 1);
      // Only explicit read-only evidence of the first message can release its
      // variant reservation; it must own that ID before another dispatch.
      f.state.queued.length = 0;
      f.state.users.push(message('first-owned-history', firstStoredText));
      allowNextDelivery = true;
      const next = await restarted.send(f.request('third', nextText));
      assert.equal((await restarted.get('first', THREAD)).messageId, 'first-owned-history');
      assert.equal(next.state, 'accepted'); assert.equal(next.messageId, 'next-owned-history');
      assert.equal(f.state.sendCalls.length, 2);
      const finalRestart = f.make();
      assert.equal((await finalRestart.get('first', THREAD)).messageId, 'first-owned-history');
      assert.equal((await finalRestart.get('third', THREAD)).messageId, 'next-owned-history');
      assert.equal((await finalRestart.get('second', THREAD)).messageId, undefined);
    }
  });
  await check('pending queue text reservations do not trim real spaces or collapse distinct multiple newlines', async () => {
    for (const [firstText, nextText] of [['hello', 'hello\n\n'], ['hello ', 'hello'], ['hello', 'hello ']]) {
      const f = fixture({ onSend: async (request, state) => {
        if (state.sendCalls.length === 1) state.queued.push(queueItem('first-distinct-queue', normalizeComposerText(request.text) + '\n'));
        else state.users.push(message('second-distinct-history', normalizeComposerText(request.text) + '\n'));
        return nativeResult(request);
      } });
      assert.equal((await f.service.send(f.request('first', firstText))).delivery, 'queued');
      const second = await f.service.send(f.request('second', nextText));
      assert.equal(second.state, 'accepted'); assert.equal(second.messageId, 'second-distinct-history');
      assert.equal((await f.service.get('first', THREAD)).delivery, 'queued');
      assert.equal(f.state.sendCalls.length, 2);
    }
  });
  await check('legacy and future-version exact queues reserve overlap with a prospective tested native LF form', async () => {
    for (const kind of ['legacy', 'future-version']) {
      const f = fixture({ onSend: async (request, state) => {
        state.queued.push(queueItem('exact-only-queue', request.text));
        return kind === 'legacy' ? { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd } :
          nativeResult(request, { desktopIdentity: { packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: '26.928.3737.0' } });
      } });
      assert.equal((await f.service.send(f.request('first', 'hello\n'))).delivery, 'queued');
      const refused = await f.make().send(f.request('second', 'hello'));
      assert.equal(refused.code, 'previous-queued-delivery'); assert.equal(f.state.sendCalls.length, 1);
    }
  });
  await check('legacy and future journals retain conservative CRLF reservations in both directions without accepting unproved normalized history', async () => {
    for (const kind of ['legacy', 'future-version']) for (const restartBeforeSecond of [false, true]) for (const [firstText, nextText] of [
      ['hello\r\n', 'hello\n'], ['hello\n', 'hello\r\n'], ['hello\r\n', 'hello']
    ]) {
      const f = fixture({ onSend: async (request, state) => {
        if (state.sendCalls.length === 1) state.queued.push(queueItem('original-exact-queue', request.text));
        else {
          // Only the old CRLF queue becomes normalized history, never a new
          // second delivery. Dispatch must be blocked before this race runs.
          state.queued.length = 0;
          state.users.push(message('first-normalized-only-history', normalizeComposerText(firstText)));
        }
        return kind === 'legacy' ? { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd } :
          nativeResult(request, { desktopIdentity: { packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: '26.928.3737.0' } });
      } });
      assert.equal((await f.service.send(f.request('first', firstText))).delivery, 'queued');
      const service = restartBeforeSecond ? f.make() : f.service;
      const refused = await service.send(f.request('second', nextText));
      assert.equal(refused.code, 'previous-queued-delivery'); assert.equal(refused.messageId, undefined);
      assert.equal(f.state.sendCalls.length, 1); assert.equal(f.state.users.length, 0);
      const restarted = f.make();
      assert.equal((await restarted.get('second', THREAD)).state, 'failed');
      // Conservative blocking is not evidence that a legacy CRLF message was
      // copied/normalized. Do not grant an unproved normalized-history receipt.
      if (firstText.includes('\r')) {
        f.state.queued.length = 0;
        f.state.users.push(message('first-normalized-only-history', normalizeComposerText(firstText)));
        assert.equal((await restarted.get('first', THREAD)).delivery, 'queued');
        assert.equal((await restarted.get('first', THREAD)).messageId, undefined);
      }
      assert.equal(f.state.sendCalls.length, 1);
    }
  });
  fs.writeFileSync(path.join(evidenceRoot, 'result.json'), JSON.stringify({ checks, result: 'passed', nativeDesktopTest: false, modelRequests: 0 }, null, 2));
  console.log(`${checks} desktop relay service checks passed`);
  console.log('Isolated evidence: ' + evidenceRoot);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
