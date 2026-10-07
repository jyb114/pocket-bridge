'use strict';

// Isolated browser-adapter test. No real DSH process, browser, or prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const calls = [], events = [];
let interactions = [];
const fullReasoning = 'R'.repeat(120000);
const workspace = { workspaceId: 'workspace-1', title: 'Old project',
  path: 'D:\\old-project', sessionIds: ['session-1'] };
const summary = { sessionId: 'session-1', updatedAt: 1, running: false,
  projections: { values: { title: 'Old conversation' } } };
const tail = { events: [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' },
    content: [{ type: 'text', text: 'Question' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [
    { type: 'reasoning', text: fullReasoning }, { type: 'text', text: 'Answer' }
  ] } } } },
  { event: { seq: 12, type: 'tool/call', data: { name: 'read', arguments: '{"path":"a"}' } } }
], hasMore: true, projections: { values: { title: 'Old conversation' } } };
const older = { events: [
  { event: { seq: 8, type: 'user/message', data: { source: { kind: 'user' },
    content: [{ type: 'text', text: 'Earlier' }] } } },
  { event: { seq: 9, type: 'assistant/message', data: { message: {
    content: [{ type: 'text', text: 'Older answer' }] } } } }
], hasMore: false };
const browser = {
  window: null, Map, Array, Promise, Number, TextEncoder, Uint8Array, DataView,
  __dshE2eeSecret: 'fixture-secret',
  setTimeout: () => 1, clearTimeout: () => {},
  DshE2EE: {
    prove: async () => true,
    encryptedFetch: async (_secret, url, init) => {
      if (url === '/__dsh/legacy-upload') {
        const packet = Buffer.from(init.body), length = packet.readUInt32BE(0);
        assert.deepEqual(JSON.parse(packet.subarray(4, length+4)), { sessionId: 'session-1', name: 'sample.png', mediaType: 'image/png' });
        assert.deepEqual(packet.subarray(length+4), Buffer.from([137,80,78,71,13,10,26,10]));
        return { status: 200, ok: true, json: async () => ({ ok: true, value: {
          receiptId:'image-receipt', file:{name:'sample.png',kind:'image',bytes:8} } }) };
      }
      if (url === '/__dsh/legacy-interactions') {
        assert.equal(JSON.parse(init.body).sessionId, 'session-1');
        return { status: 200, ok: true, json: async () => ({ ok: true, interactions }) };
      }
      if (url === '/__dsh/legacy-response') {
        const body = JSON.parse(init.body); calls.push({ method: 'legacy-response', request: body });
        interactions = interactions.filter(item => item.id !== body.id);
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }
      if (url === '/__dsh/lite-files') {
        assert.deepEqual(JSON.parse(init.body), { sessionId: 'session-1', path: '', offset: 0 });
        return { status: 200, ok: true, json: async () => ({ path: '', entries: [
          { name: 'report.txt', path: 'report.txt', type: 'file', bytes: 4 } ], nextOffset: null }) };
      }
      if (url === '/__dsh/lite-download') {
        assert.deepEqual(JSON.parse(init.body), { sessionId: 'session-1', path: 'report.txt' });
        return { status: 200, ok: true, blob: async () => ({ size: 4 }) };
      }
      assert.equal(url, '/__dsh/legacy-rpc', 'legacy adapter may not use raw /api/events SSE');
      assert.equal(init.method, 'POST');
      const { method, request } = JSON.parse(init.body);
      calls.push({ method, request });
      let value;
      if (method === 'host.describe') value = { version: '0.0.1', home: 'D:\\home' };
      else if (method === 'workspace.list') value = { items: [workspace], archivedSessionIds: [] };
      else if (method === 'session.list') value = { items: [summary] };
      else if (method === 'session.history') value = request.beforeSeq === 10 ? older : tail;
      else if (method === 'session.prompt' || method === 'session.cancel') value = { accepted: true };
      else if (method === 'workspace.create') value = { workspace: {
        workspaceId: 'workspace-2', title: 'New', path: request.path, sessionIds: [] }, created: true };
      else if (method === 'session.create') value = { sessionId: 'session-2' };
      else throw new Error('unexpected method ' + method);
      return { status: 200, ok: true, json: async () => ({ result: { ok: true, value } }) };
    }
  }
};
browser.window = browser;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-legacy.js'), 'utf8'),
  browser, { filename: 'dsh-lite-legacy.js' });

async function backgroundReadChecks() {
  let checks = 0;
  function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
  function check(value, label) { assert.ok(value, label); checks++; }
  function fixture() {
    const emitted = [], reads = [], timers = new Map(), failures = new Map();
    let timerId = 0, updatedAt = 1, allowProof = true, deferred = null;
    const row = (seq, text) => ({ event: { seq, type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } } } });
    const ok = value => ({ status: 200, ok: true, json: async () => ({ result: { ok: true, value } }) });
    const failure = (status, payload) => ({ status, ok: false, json: async () => {
      if (payload instanceof Error) throw payload;
      return payload;
    } });
    const box = { window: null, Map, Array, Promise, Number, TextEncoder, Uint8Array, DataView,
      __dshE2eeSecret: 'isolated-poll-secret',
      setTimeout(callback, delay) { assert.equal(delay, 5000); timers.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timers.delete(id); },
      DshE2EE: { prove: async () => allowProof, encryptedFetch: async (_secret, url, init) => {
        if (url === '/__dsh/legacy-interactions') {
          reads.push({ method: 'interactions', request: JSON.parse(init.body) });
          const injected = failures.get('interactions');
          if (injected && injected.length) return injected.shift();
          return { status: 200, ok: true, json: async () => ({ ok: true, interactions: [] }) };
        }
        assert.equal(url, '/__dsh/legacy-rpc');
        const { method, request } = JSON.parse(init.body);
        reads.push({ method, request });
        if (deferred && deferred.method === method) {
          const hold = deferred; deferred = null; hold.ready(); return hold.response;
        }
        const injected = failures.get(method);
        if (injected && injected.length) {
          const result = injected.shift();
          if (result instanceof Error) throw result;
          return result;
        }
        if (method === 'host.describe') return ok({ version: '0.0.1', home: 'D:\\isolated-home' });
        if (method === 'workspace.list') return ok({ items: [{ workspaceId: 'project', sessionIds: ['A', 'B'] }] });
        if (method === 'session.list') return ok({ items: ['A', 'B'].map(sessionId => ({ sessionId, updatedAt, running: false })) });
        if (method === 'session.history') return ok({ events: [row(0, request.sessionId + ' retained'),
          row(1, request.sessionId + ' reply')].concat(updatedAt > 1 ? [row(2, request.sessionId + ' newest')] : []), hasMore: false });
        if (method === 'session.prompt') return ok({ accepted: true });
        throw new Error('Unexpected fixture RPC: ' + method);
      } }
    };
    box.window = box;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-legacy.js'), 'utf8'), box);
    return { box, adapter: box.DshLegacyAdapter, emitted, reads, timers,
      async start() { await box.DshLegacyAdapter.connect(event => emitted.push(event)); return box.DshLegacyAdapter.loadSession('A'); },
      async tick() { equal(timers.size, 1, 'Each poll has exactly one scheduled next read');
        const [id, callback] = timers.entries().next().value; timers.delete(id); await callback(); },
      update(value) { updatedAt = value; }, proof(value) { allowProof = value; },
      inject(method, result) { const queue = failures.get(method) || []; queue.push(result); failures.set(method, queue); },
      fail(method, status, payload) { this.inject(method, failure(status, payload)); },
      defer(method) {
        let ready, resolve; const entered = new Promise(value => { ready = value; });
        const response = new Promise(value => { resolve = value; });
        deferred = { method, ready, response };
        return { entered, resolve: (status, payload) => resolve(failure(status, payload)) };
      }
    };
  }
  function eventsOf(value, type) { return value.emitted.filter(event => event.type === type); }
  for (const method of ['workspace.list', 'session.list', 'session.history']) {
    const f = fixture(), initial = await f.start();
    if (method === 'session.history') f.update(2);
    f.fail(method, 503, { error: 'dsh-runtime-unavailable' });
    const readsBeforeFailure = f.reads.length;
    await f.tick();
    equal(eventsOf(f, 'background-read-warning').map(event => [event.tag, event.sessionId]),
      [['legacy-poll', 'A']], 'Only the known periodic read failure is scoped as a warning');
    equal(eventsOf(f, 'error').length, 0, 'Transient read warning does not claim disconnection');
    equal(eventsOf(f, 'records').length, 0, 'Failed poll does not remove retained records');
    equal(Array.from(initial.records, item => item.text), ['A retained', 'A reply'], 'Existing content remains complete');
    check(f.reads.slice(readsBeforeFailure).every(item => ['workspace.list', 'session.list', 'session.history'].includes(item.method)),
      'The failed read introduces no mutation or replay');
    await f.tick();
    equal(eventsOf(f, 'background-read-recovered').map(event => [event.tag, event.sessionId]),
      [['legacy-poll', 'A']], 'Recovery is emitted only after a real same-session refresh');
    equal(eventsOf(f, 'status').map(event => event.state), ['disconnected', 'connecting', 'connected'],
      'Background retry never fabricates another connected/disconnected status');
    check(f.reads.slice(readsBeforeFailure).some(item => item.method === 'session.history'),
      'Recovery verifies actual retained-session history even when catalog timestamp is unchanged');
    if (method === 'session.history') equal(Array.from(eventsOf(f, 'records').at(-1).records, item => item.text),
      ['A retained', 'A reply', 'A newest'], 'Failed tail is really fetched again at the same settled timestamp');
    await f.tick();
    equal(eventsOf(f, 'background-read-recovered').length, 1, 'Normal later polls do not invent recovery events');
    f.adapter.disconnect(); equal(f.timers.size, 0, 'Disconnect stops the owned read timer');
  }

  // The marker fix must also retry a non-transient tail failure. Recovery UI
  // classification cannot be the mechanism that secretly makes history work.
  const hardTail = fixture(); await hardTail.start(); hardTail.update(2);
  hardTail.fail('session.history', 502, { error: 'upstream-rpc-unavailable' });
  await hardTail.tick(); await hardTail.tick();
  equal(eventsOf(hardTail, 'error').length, 1, 'An upstream failure stays an explicit ordinary error');
  equal(Array.from(eventsOf(hardTail, 'records').at(-1).records, item => item.text), ['A retained', 'A reply', 'A newest'],
    'An ordinary failed history read is not falsely marked current');
  equal(eventsOf(hardTail, 'background-read-recovered').length, 0, 'Success never clears an untagged hard error');
  hardTail.adapter.disconnect();

  for (const cause of ['runtime-unavailable', 'invalid-page']) {
    const initialFailure = fixture();
    if (cause === 'runtime-unavailable') initialFailure.fail('session.history', 503, { error: 'dsh-runtime-unavailable' });
    else initialFailure.inject('session.history', { status: 200, ok: true,
      json: async () => ({ result: { ok: true, value: null } }) });
    await assert.rejects(initialFailure.start(), cause === 'runtime-unavailable' ? /HTTP 503/ : /记录格式无效/); checks++;
    equal(initialFailure.reads.filter(item => item.method === 'session.history').length, 1,
      'An initial read failure is not retried inside the opening action: ' + cause);
    await initialFailure.tick();
    equal(initialFailure.reads.filter(item => item.method === 'session.history').length, 2,
      'The next existing periodic read really retries the initial history at the identical settled timestamp: ' + cause);
    equal(Array.from(eventsOf(initialFailure, 'records').at(-1).records, item => item.text), ['A retained', 'A reply'],
      'The failed initial history is recovered from actual subsequent rows: ' + cause);
    equal(eventsOf(initialFailure, 'background-read-warning').length + eventsOf(initialFailure, 'background-read-recovered').length, 0,
      'Initial action errors never gain a clearable background tag: ' + cause);
    check(initialFailure.reads.every(item => ['host.describe', 'workspace.list', 'session.list', 'session.history', 'interactions'].includes(item.method)),
      'Opening recovery introduces no write replay: ' + cause);
    initialFailure.adapter.disconnect();
  }

  for (const [status, payload] of [
    [401, { error: 'authentication-required' }], [403, { error: 'device-proof-required' }],
    [404, { error: 'not-found' }], [409, { error: 'dsh-protocol-changed' }],
    [502, { error: 'upstream-rpc-unavailable' }], [503, { code: 'replay-store-corrupt' }],
    [503, { error: 'dsh-runtime-unavailable', code: 'replay-clock-rollback' }],
    [503, { error: 'unknown' }], [503, new Error('invalid-json')]
  ]) {
    const f = fixture(); await f.start(); f.update(2); f.proof(false);
    f.fail('session.history', status, payload); await f.tick(); f.proof(true); await f.tick();
    equal(eventsOf(f, 'error').length, 1, 'Auth/protocol/replay/unknown failures remain ordinary errors: ' + status);
    equal(eventsOf(f, 'background-read-warning').length, 0, 'HTTP status alone never creates a transient warning');
    equal(eventsOf(f, 'background-read-recovered').length, 0, 'An ordinary error has no clear-on-success event');
    f.adapter.disconnect();
  }
  for (const cause of ['missing-key', 'crypto-type-error', 'invalid-success']) {
    const f = fixture(); await f.start(); f.update(2);
    if (cause === 'missing-key') f.box.__dshE2eeSecret = '';
    else if (cause === 'crypto-type-error') f.inject('session.history', new TypeError('fixture encrypted-body failure'));
    else f.inject('session.history', { status: 200, ok: true, json: async () => ({ result: { ok: true, value: null } }) });
    await f.tick(); f.box.__dshE2eeSecret = 'isolated-poll-secret'; await f.tick();
    equal(eventsOf(f, 'error').length, 1, 'Security/data failure stays ordinary: ' + cause);
    equal(eventsOf(f, 'background-read-warning').length + eventsOf(f, 'background-read-recovered').length, 0,
      'Key, crypto and malformed results are never hidden by retry classification');
    f.adapter.disconnect();
  }

  const mutation = fixture(); await mutation.start();
  mutation.fail('session.prompt', 503, { error: 'dsh-runtime-unavailable' });
  await assert.rejects(mutation.adapter.sendMessage({ sessionId: 'A', text: 'One attempt only' }), /HTTP 503/); checks++;
  await mutation.tick();
  equal(mutation.reads.filter(item => item.method === 'session.prompt').length, 1, 'A failed write is never repeated by the background loop');
  equal(eventsOf(mutation, 'background-read-recovered').length + eventsOf(mutation, 'background-read-warning').length, 0,
    'A mutation cannot acquire a clearable background tag');
  mutation.adapter.disconnect();

  const stale = fixture(); await stale.start();
  const held = stale.defer('workspace.list'), oldTick = stale.tick(); await held.entered;
  await stale.adapter.loadSession('B'); held.resolve(503, { error: 'dsh-runtime-unavailable' }); await oldTick;
  equal(eventsOf(stale, 'background-read-warning').length + eventsOf(stale, 'error').length, 0,
    'An old-session read failure cannot warn over the newly selected conversation');
  await stale.tick(); equal(eventsOf(stale, 'background-read-recovered').length, 0, 'New-session success is not old-session recovery');
  stale.adapter.disconnect();

  const retired = fixture(); await retired.start();
  const heldRetired = retired.defer('workspace.list'), retiredTick = retired.tick(); await heldRetired.entered;
  retired.adapter.disconnect(); heldRetired.resolve(503, { error: 'dsh-runtime-unavailable' }); await retiredTick;
  equal(eventsOf(retired, 'background-read-warning').length, 0, 'A retired connection cannot emit a late warning');
  equal(retired.timers.size, 0, 'A retired poll cannot schedule a replacement timer');

  const switched = fixture(); await switched.start();
  switched.fail('workspace.list', 503, { error: 'dsh-runtime-unavailable' }); await switched.tick();
  await switched.adapter.loadSession('B'); await switched.tick();
  equal(eventsOf(switched, 'background-read-recovered').length, 0, 'Switching sessions discards the old recovery scope');
  switched.adapter.disconnect();

  const incomplete = fixture(); await incomplete.start();
  incomplete.fail('workspace.list', 503, { error: 'dsh-runtime-unavailable' }); await incomplete.tick();
  incomplete.fail('interactions', 401, { error: 'authentication-required' }); await incomplete.tick();
  equal(eventsOf(incomplete, 'background-read-recovered').length, 0, 'Partial history success cannot clear a warning before the full same-session refresh succeeds');
  equal(eventsOf(incomplete, 'error').length, 1, 'A later interaction-auth failure remains an ordinary error');
  await incomplete.tick(); equal(eventsOf(incomplete, 'background-read-recovered').length, 1, 'Only the subsequent complete read can recover its own tag');
  incomplete.adapter.disconnect();
  console.log('legacy periodic read and scoped recovery checks passed: ' + checks);
}

(async () => {
  const adapter = browser.DshLegacyAdapter;
  assert.equal(adapter.profile, 'legacy-events');
  assert.equal(adapter.capabilities.interactiveReplies, true);
  assert.equal(typeof adapter.uploadFile, 'function');
  assert.equal(typeof adapter.downloadFile, 'function');
  await adapter.connect(item => events.push(item));
  assert.equal(events.at(-1).state, 'connected');
  assert.equal((await adapter.listProjects())[0].id, 'workspace-1');
  assert.equal((await adapter.listSessions('workspace-1'))[0].title, 'Old conversation');
  const current = await adapter.loadSession('session-1');
  assert.equal(current.hasMore, true);
  assert.deepEqual(Array.from(current.records, row => row.role), ['user', 'thought', 'assistant', 'tool']);
  assert.equal(current.records.find(row => row.role === 'thought').text, fullReasoning);
  tail.events.push({ event: { seq: 13, type: 'turn/end', data: { turn: 1,
    reason: { kind: 'error', error: { status: 401, code: 'AUTH', message: 'sensitive credential detail' } } } } });
  const failed = (await adapter.loadSession('session-1')).records.find(row => row.status === 'error');
  assert.equal(failed.role, 'system');
  assert.match(failed.text, /401/);
  assert.ok(!failed.text.includes('sensitive credential detail'));
  interactions = [{ id: 'rpc-approval', sessionId: 'session-1', kind: 'approval', title: 'Read?' }];
  assert.equal((await adapter.loadSession('session-1')).interactions.length, 1);
  await adapter.respondToInteraction({ id: 'rpc-approval', answer: { type: 'reject' } });
  assert.deepEqual(calls.find(call => call.method === 'legacy-response').request,
    { sessionId: 'session-1', id: 'rpc-approval', answer: { type: 'reject' } });
  await assert.rejects(adapter.respondToInteraction({ id: 'rpc-approval', answer: { type: 'approve' } }), /已过期/);
  const earlier = await adapter.loadOlder('session-1');
  assert.equal(earlier.hasMore, false);
  assert.equal(earlier.records[0].text, 'Earlier');
  assert.equal((await adapter.listWorkspaceFiles({ sessionId: 'session-1', path: '', offset: 0 })).entries[0].name,
    'report.txt');
  assert.equal((await adapter.downloadFile({ sessionId: 'session-1', path: 'report.txt' })).blob.size, 4);
  assert.equal((await adapter.createProject({ path: 'D:\\new-project' })).id, 'workspace-2');
  assert.equal((await adapter.createSession({ projectId: 'workspace-1' })).id, 'session-2');
  await assert.rejects(adapter.sendMessage({ sessionId: 'session-1', text: 'no',
    attachments: [{ receiptId: 'unsupported' }] }), /仅支持.*图片附件/);
  await adapter.sendMessage({ sessionId: 'session-1', text: 'New prompt' });
  const sent = calls.find(call => call.method === 'session.prompt');
  assert.equal(sent.request.content[0].text, 'New prompt');
  assert.equal(sent.request.mode, 'queue');
  const image = await adapter.uploadFile({ sessionId:'session-1', file:{name:'sample.png',type:'image/png',size:8,
    arrayBuffer:async()=>new Uint8Array([137,80,78,71,13,10,26,10]).buffer} });
  await adapter.sendMessage({ sessionId:'session-1',text:'',attachments:[image] });
  assert.deepEqual(calls.filter(call=>call.method==='session.prompt').at(-1).request.attachmentReceipts,['image-receipt']);
  await assert.rejects(adapter.uploadFile({ sessionId:'session-1',file:{name:'arbitrary.txt',type:'text/plain',size:3} }), /仅支持/);
  await adapter.cancelSession('session-1');
  assert.ok(!calls.some(call => /events\./.test(call.method)), 'SSE is never sent through raw proxy');
  adapter.disconnect();
  await backgroundReadChecks();
  console.log('legacy-adapter: project, history, thought, creation, prompt, encrypted-interaction replies passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
