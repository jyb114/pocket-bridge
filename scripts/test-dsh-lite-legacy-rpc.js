'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDshLiteLegacyRpc } = require('./dsh-lite-legacy-rpc');

const calls = [];
let profile = 'legacy-events';
const handle = createDshLiteLegacyRpc({
  runtimeProfile: async () => profile,
  callUpstream: async call => {
    calls.push(call);
    const input = JSON.parse(call.body.toString('utf8'));
    assert.equal(call.path, '/api/' + input.method);
    assert.equal(input.type, 'client-request');
    assert.deepEqual(Object.keys(input).sort(), ['method', 'payload', 'rpcId', 'type']);
    return { statusCode: 200, body: Buffer.from(JSON.stringify({ type: 'server-response',
      rpcId: input.rpcId, result: { ok: true, value: { accepted: true } } })) };
  }
});
function request(body, overrides = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = overrides.method || 'POST';
  req.__dshE2eeDecrypted = overrides.decrypted !== false;
  req.headers = { 'x-dsh-e2ee': '1', 'content-type': 'application/json; charset=utf-8' };
  if (overrides.headers) Object.assign(req.headers, overrides.headers);
  return req;
}
async function invoke(body, overrides, handler = handle) {
  const result = { status: 0, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { this.body = JSON.parse(String(value)); this.writableEnded = true; } };
  await handler(request(body, overrides), result);
  return result;
}
(async () => {
  const valid = [
    ['host.describe', {}], ['workspace.list', {}], ['session.list', {}],
    ['workspace.create', { path: 'D:\\project' }],
    ['session.create', { workspaceId: 'workspace-1' }],
    ['session.history', { sessionId: 'session-1', beforeSeq: 12, maxMessages: 20 }],
    ['session.prompt', { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }],
    ['session.cancel', { sessionId: 'session-1' }]
  ];
  for (const [method, payload] of valid) {
    const output = await invoke({ method, request: payload });
    assert.equal(output.status, 200, method);
    assert.equal(output.body.result.value.accepted, true);
    assert.deepEqual(JSON.parse(calls.at(-1).body.toString()).payload, payload,
      'old unary payload must not use modern {args:{request}} nesting');
  }
  const before = calls.length;
  for (const bad of [
    { method: 'settings.mutate', request: {} },
    { method: 'session.prompt', request: { sessionId: 's', mode: 'queue',
      content: [{ type: 'file', receiptId: 'receipt' }] } },
    { method: 'session.history', request: { sessionId: 's', maxMessages: 10000 } },
    { method: 'workspace.create', request: { path: '..\\..\\' } },
    { method: 'session.create', request: { workspaceId: 's', path: 'D:\\escape' } }
  ]) assert.equal((await invoke(bad)).status, 400);
  assert.equal(calls.length, before, 'bad requests never reach DSH');
  assert.equal((await invoke({ method: 'workspace.list', request: {} }, { decrypted: false })).status, 403);
  assert.equal(calls.length, before, 'unencrypted request never reaches DSH');
  profile = 'remote-mux';
  assert.equal((await invoke({ method: 'session.prompt', request: { sessionId: 's', mode: 'queue',
    content: [{ type: 'text', text: 'write' }] } })).status, 409);
  assert.equal(calls.length, before, 'cached old page cannot write to upgraded DSH');
  profile = null;
  const unavailable = await invoke({ method: 'session.list', request: {} });
  assert.equal(unavailable.status, 503, 'missing runtime is unavailable, not a verified protocol upgrade');
  assert.equal(unavailable.body.error, 'dsh-runtime-unavailable');
  assert.equal(calls.length, before, 'unknown runtime cannot read or write DSH');
  let commits = 0, releases = 0, accepted = false, transportFailure = false, imageCall = null;
  const imageHandler = createDshLiteLegacyRpc({ runtimeProfile: async () => 'legacy-events',
    resolveAttachments: async (sessionId, receipts) => {
      assert.equal(sessionId, 'image-session'); assert.deepEqual(receipts, ['staged-image']);
      return { content: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'sample.png' }],
        commit() { commits++; }, release() { releases++; } };
    },
    callUpstream: async call => {
      imageCall = JSON.parse(call.body.toString());
      if (transportFailure) throw new Error('ambiguous-network-timeout');
      return { statusCode: 200, body: JSON.stringify({ type: 'server-response', rpcId: imageCall.rpcId,
        result: { ok: true, value: { accepted } } }) };
    }
  });
  const imagePrompt = { method: 'session.prompt', request: { sessionId: 'image-session', mode: 'queue',
    content: [{ type: 'text', text: '' }], attachmentReceipts: ['staged-image'] } };
  assert.equal((await invoke(imagePrompt, undefined, imageHandler)).status, 200);
  assert.equal(commits, 0, 'unaccepted prompt must not consume the image receipt');
  assert.equal(releases, 1, 'confirmed upstream rejection releases the image for retry');
  assert.deepEqual(Object.keys(imageCall.payload).sort(), ['content', 'mode', 'sessionId'], 'bridge receipt metadata must not reach the official strict legacy wire');
  assert.equal(imageCall.payload.content[0].type, 'image');
  accepted = true;
  assert.equal((await invoke(imagePrompt, undefined, imageHandler)).status, 200);
  assert.equal(commits, 1, 'accepted official prompt consumes its staged image receipt');
  assert.equal(releases, 1, 'accepted prompt must not release its consumed receipt');
  transportFailure = true;
  assert.equal((await invoke(imagePrompt, undefined, imageHandler)).status, 502);
  assert.equal(releases, 1, 'ambiguous network failure must not allow duplicate image submission');
  console.log('legacy-rpc: inspected envelope, method fence, E2EE proof, profile switch passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
