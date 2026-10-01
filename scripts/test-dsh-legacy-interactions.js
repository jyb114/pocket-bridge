'use strict';

// Protocol/security fixtures only. They do not claim a model-generated
// approval/question was exercised against an installed DSH runtime.
const assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const { createDshLegacyInteractions } = require('./dsh-legacy-interactions');
const runtime = { running: true, profile: 'legacy-events', pid: 123, port: 19087, version: '0.1.0-rc.8' };
const frame = (rpcId, payload) => ({ type: 'server-request', rpcId, method: payload.type, payload });
const approval = frame('rpc-a', { type: 'approval/requested', sessionId: 's1', approvalId: 'approval-1', toolName: 'read', reason: 'Read this project?' });
const question = frame('rpc-q', { type: 'question/requested', sessionId: 's1', questions: [
  { id: 'q1', question: 'Which?', options: [{ label: 'First' }, { label: 'Second' }] },
  { id: 'q2', question: 'Details?' }
] });
function fixture() {
  const state = { runtime: { ...runtime }, frames: [approval, question], raw: null, streams: 0, responses: [], accepted: true, time: 1000 };
  const handle = createDshLegacyInteractions({ now: () => state.time, windowMs: 8,
    getRuntime: async () => state.runtime,
    openEvents: async () => {
      state.streams++;
      const stream = new PassThrough();
      setImmediate(() => stream.write(state.raw || ': connected\n\n' + state.frames.map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('')));
      return stream;
    },
    respond: async (actual, message) => { state.responses.push({ actual, message }); return { accepted: state.accepted }; }
  });
  return { state, handle };
}
async function invoke(handle, body, options = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  const req = Readable.from([bytes]);
  req.method = options.method || 'POST'; req.url = options.url || '/__dsh/legacy-interactions';
  req.__dshE2eeDecrypted = options.decrypted !== false;
  req.headers = { 'x-dsh-e2ee': '1', 'content-type': 'application/json', 'content-length': bytes.length, ...options.headers };
  const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); this.writableEnded = true; } };
  await handle(req, res); return res;
}
const respond = (handle, id, answer, sessionId = 's1') => invoke(handle, { sessionId, id, answer }, { url: '/__dsh/legacy-response' });
(async () => {
  let checks = 0;
  const check = async (name, test) => { await test(); checks++; console.log('PASS ' + name); };
  await check('encrypted fixed routes only; no query metadata, unexpected keys or generic API forwarding', async () => {
    const { state, handle } = fixture();
    for (const options of [{ decrypted: false }, { method: 'GET' }, { headers: { 'x-dsh-e2ee': '0' } },
      { headers: { 'content-type': 'text/plain' } }, { url: '/__dsh/legacy-interactions?sessionId=s1' }, { url: '/api/respond' },
      { headers: { 'content-length': 65537 } }]) assert.ok((await invoke(handle, { sessionId: 's1' }, options)).status >= 400);
    assert.equal((await invoke(handle, { sessionId: 's1', upstream: 'http://evil.test' })).status, 400);
    assert.equal(state.streams, 0); assert.equal(state.responses.length, 0);
  });
  await check('only current session server requests are delivered; resolved and mismatched frames cannot bind', async () => {
    const { state, handle } = fixture();
    state.frames.push(frame('elsewhere', { ...approval.payload, sessionId: 's2' }));
    state.frames.push({ ...approval, rpcId: 'mismatched', method: 'question/requested' });
    state.frames.push(frame('resolution', { type: 'approval/resolved', sessionId: 's1', approvalId: 'approval-1' }));
    const listed = await invoke(handle, { sessionId: 's1' });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.interactions.map(item => item.id), ['rpc-q']);
    assert.equal((await respond(handle, 'elsewhere', { type: 'approve' }, 's2')).status, 409);
  });
  await check('unobserved, cross-session and stale pending requests fail closed', async () => {
    const { state, handle } = fixture();
    assert.equal((await respond(handle, 'rpc-a', { type: 'approve' })).status, 409);
    assert.equal(state.streams, 0);
    await invoke(handle, { sessionId: 's1' });
    assert.equal((await respond(handle, 'rpc-a', { type: 'approve' }, 's2')).status, 409);
    state.frames = [];
    assert.equal((await respond(handle, 'rpc-a', { type: 'approve' })).status, 409);
    assert.equal(state.responses.length, 0);
  });
  await check('runtime restart, unknown owner and observation expiry invalidate response bindings', async () => {
    const { state, handle } = fixture();
    await invoke(handle, { sessionId: 's1' }); state.runtime.pid++;
    assert.equal((await respond(handle, 'rpc-a', { type: 'approve' })).status, 409);
    assert.equal(state.responses.length, 0);
    state.runtime.pid = null;
    assert.equal((await invoke(handle, { sessionId: 's1' })).status, 503);
    state.runtime = { ...runtime }; await invoke(handle, { sessionId: 's1' }); state.time += 60001;
    assert.equal((await respond(handle, 'rpc-a', { type: 'approve' })).status, 409);
  });
  await check('real official reply envelope is constructed from observed approval binding; always-allow is forbidden', async () => {
    const { state, handle } = fixture(); await invoke(handle, { sessionId: 's1' });
    assert.equal((await respond(handle, 'rpc-a', { type: 'approve', outcome: 'allowed-always' })).status, 400);
    assert.equal(state.responses.length, 0);
    assert.equal((await respond(handle, 'rpc-a', { type: 'approve' })).status, 200);
    assert.deepEqual(state.responses[0].message, { type: 'client-response', rpcId: 'rpc-a',
      result: { ok: true, value: { sessionId: 's1', approvalId: 'approval-1', outcome: 'allowed-once' } } });
    assert.equal((await respond(handle, 'rpc-a', { type: 'approve' })).status, 409, 'accepted reply cannot be replayed without rediscovery');
  });
  await check('question replies must cover the exact requested ids and allowed selections', async () => {
    const { state, handle } = fixture(); await invoke(handle, { sessionId: 's1' });
    const valid = { type: 'answers', answers: [{ id: 'q1', selected: ['First'] }, { id: 'q2', selected: [], custom: 'Details' }] };
    for (const answers of [[{ id: 'q1', selected: ['First'] }],
      [{ id: 'q1', selected: ['Not requested'] }, valid.answers[1]],
      [{ id: 'q1', selected: ['First', 'Second'] }, valid.answers[1]],
      [{ id: 'q1', selected: ['First'] }, { id: 'q1', selected: [], custom: 'duplicate' }]])
      assert.equal((await respond(handle, 'rpc-q', { type: 'answers', answers })).status, 400);
    assert.equal(state.responses.length, 0);
    assert.equal((await respond(handle, 'rpc-q', valid)).status, 200);
    assert.deepEqual(state.responses[0].message.result.value, { sessionId: 's1', answer: { answers: valid.answers } });
  });
  await check('oversized, malformed and upstream-error streams never authorize a response', async () => {
    for (const raw of ['data: {bad json}\n\n', ': ' + 'x'.repeat(1024*1024),
      'data: ' + JSON.stringify(frame('err', { type: 'stream/error', error: { message: 'PRIVATE DETAIL' } })) + '\n\n']) {
      const { state, handle } = fixture(); state.raw = raw;
      const result = await invoke(handle, { sessionId: 's1' });
      assert.equal(result.status, 502); assert.ok(!JSON.stringify(result.body).includes('PRIVATE DETAIL'));
      assert.equal((await respond(handle, 'rpc-a', { type: 'approve' })).status, 409); assert.equal(state.responses.length, 0);
    }
  });
  console.log('Legacy interactions: ' + checks + ' protocol/security fixture groups passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
