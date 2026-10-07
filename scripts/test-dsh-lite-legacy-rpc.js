'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
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
  // Exercise the actual gateway initializer and actual legacy HTTP dispatcher,
  // rather than duplicating the production mutating-method list in a fake.
  const gatewaySource = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
  const initializerStart = gatewaySource.indexOf('const serveDshLiteLegacyRpcE2ee = e2eeWrap(');
  const initializerEnd = gatewaySource.indexOf('\nconst legacyRuntimeIdentity', initializerStart);
  assert(initializerStart >= 0 && initializerEnd > initializerStart);
  const refreshes = [], dispatched = [];
  let runtimeReady = true, runtimeProfile = 'legacy-events', discoveryThrows = false;
  const context = {
    // Encryption admission is covered above and by real AES fixtures. This
    // isolated initializer check retains the actual downstream decrypted flag.
    e2eeWrap: handler => handler,
    require(name) {
      assert.equal(name, './dsh-lite-legacy-rpc.js');
      return require('./dsh-lite-legacy-rpc.js');
    },
    async refreshDshRuntimeState(force) {
      refreshes.push(force);
      if (discoveryThrows) throw Error('synthetic-discovery-refusal');
      return { ready: runtimeReady, runtime: { profile: runtimeProfile } };
    },
    dshLegacyAttachments: { resolveForPrompt() { throw Error('No image fixture may stage an attachment'); } },
    async callDshLiteUpstream(call) {
      const input = JSON.parse(call.body.toString('utf8')); dispatched.push(input);
      return { statusCode: 200, body: JSON.stringify({ type: 'server-response',
        rpcId: input.rpcId, result: { ok: true, value: { accepted: true } } }) };
    }
  };
  const actualGatewayHandler = vm.runInNewContext(gatewaySource.slice(initializerStart, initializerEnd) +
    '\nserveDshLiteLegacyRpcE2ee;', context);
  const selection = { method: 'session.selectModel', request: { sessionId: 'fresh-session',
    provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'low' } };
  const preset = { method: 'agentPreset.select', request: { sessionId: 'fresh-session', agentPreset: 'minimal' } };
  let freshnessCases = 0;
  for (const [method, payload, force] of [
    ['host.describe', {}, false], ['workspace.list', {}, false], ['session.list', {}, false],
    ['session.history', { sessionId: 'fresh-session', maxMessages: 20 }, false],
    ['llm.models', {}, false], ['session.models', { sessionId: 'fresh-session' }, false],
    ['agentPreset.list', {}, false],
    ['workspace.create', { path: process.platform === 'win32' ? 'D:\\fixture' : '/fixture' }, true],
    ['session.create', { workspaceId: 'fresh-workspace' }, true],
    ['session.prompt', { sessionId: 'fresh-session', mode: 'queue', content: [{ type: 'text', text: 'fixture' }] }, true],
    ['session.cancel', { sessionId: 'fresh-session' }, true],
    [selection.method, selection.request, true], [preset.method, preset.request, true]
  ]) {
    refreshes.length = 0; const previous = dispatched.length;
    const output = await invoke({ method, request: payload }, undefined, actualGatewayHandler);
    assert.equal(output.status, 200, method + ' traverses the actual gateway dispatcher');
    assert.deepEqual(refreshes, [force], method + ' applies the correct discovery freshness');
    assert.equal(dispatched.length, previous + 1, 'Exactly one official call, with no write retry');
    assert.equal(dispatched.at(-1).method, method);
    assert.deepEqual(dispatched.at(-1).payload, payload);
    freshnessCases++;
  }
  const admittedBefore = dispatched.length;
  runtimeReady = false; refreshes.length = 0;
  assert.equal((await invoke(selection, undefined, actualGatewayHandler)).status, 503);
  assert.deepEqual(refreshes, [true]);
  assert.equal(dispatched.length, admittedBefore, 'Unavailable new selection cannot reach upstream');
  runtimeReady = true; runtimeProfile = 'remote-mux'; refreshes.length = 0;
  assert.equal((await invoke(preset, undefined, actualGatewayHandler)).status, 409);
  assert.deepEqual(refreshes, [true]);
  assert.equal(dispatched.length, admittedBefore, 'An upgraded protocol cannot receive a cached preset selection');
  runtimeProfile = 'legacy-events'; discoveryThrows = true; refreshes.length = 0;
  assert.equal((await invoke(selection, undefined, actualGatewayHandler)).status, 503);
  assert.deepEqual(refreshes, [true]);
  assert.equal(dispatched.length, admittedBefore, 'Discovery refusal never forwards or retries a selection');
  discoveryThrows = false; refreshes.length = 0;
  assert.equal((await invoke(preset, { decrypted: false }, actualGatewayHandler)).status, 403);
  assert.deepEqual(refreshes, []);
  assert.equal(dispatched.length, admittedBefore, 'A forged encryption marker cannot even request discovery');
  console.log('actual gateway legacy initializer: ' + freshnessCases + ' method freshness cases and 4 fail-closed boundaries passed');
  console.log('legacy-rpc: inspected envelope, method fence, E2EE proof, profile switch passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
