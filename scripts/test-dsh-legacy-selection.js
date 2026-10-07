'use strict';
// Exact inspected legacy HTTP methods and independent readback contracts.
// Synthetic native responses here are NOT actual version/UI acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Readable } = require('node:stream');
const { createDshLiteLegacyRpc } = require('./dsh-lite-legacy-rpc.js');
let checks = 0;
function equal(a, b, label) { assert.deepEqual(a, b, label); checks++; }
function check(value, label) { assert.ok(value, label); checks++; }
async function rejects(promise, pattern, label) { await assert.rejects(promise, pattern, label); checks++; }
const plain = value => JSON.parse(JSON.stringify(value));
async function backendChecks() {
  const calls = []; let profile = 'legacy-events';
  const handler = createDshLiteLegacyRpc({ runtimeProfile: async () => profile,
    callUpstream: async call => { const wire = JSON.parse(call.body); calls.push({ call, wire });
      return { status: 200, body: JSON.stringify({ type: 'server-response', rpcId: wire.rpcId,
        result: { ok: true, value: { accepted: true } } }) }; } });
  async function invoke(method, request, decrypted = true) {
    const req = Readable.from([Buffer.from(JSON.stringify({ method, request }))]);
    req.method = 'POST'; req.__dshE2eeDecrypted = decrypted;
    req.headers = { 'x-dsh-e2ee': '1', 'content-type': 'application/json' };
    const res = { writeHead(n) { this.status = n; }, end(data) { this.body = JSON.parse(data); this.writableEnded = true; } };
    await handler(req, res); return res;
  }
  const valid = [['llm.models', {}], ['session.models', { sessionId: 's1' }], ['agentPreset.list', {}],
    ['session.selectModel', { sessionId: 's1', provider: 'provider-a', model: 'model-a' }],
    ['session.selectModel', { sessionId: 's1', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }],
    ['agentPreset.select', { sessionId: 's1', agentPreset: 'standard' }]];
  for (const [method, request] of valid) {
    equal((await invoke(method, request)).status, 200, 'Exact legacy method accepts the inspected DTO: ' + method);
    equal(calls.at(-1).call.path, '/api/' + method, 'The path cannot be selected by the caller');
    equal(calls.at(-1).wire.payload, request, 'Legacy DTO uses a direct payload, never modern args/request or agentId');
    equal(Object.keys(calls.at(-1).wire).sort(), ['method', 'payload', 'rpcId', 'type'], 'No extra envelope/configuration is forwarded');
  }
  const before = calls.length;
  for (const [method, request] of [
    ['agentPreset.read', { agentPreset: 'standard' }], ['agentPreset.copy', { from: 'standard', agentPreset: 'custom' }],
    ['agentPreset.openDocument', { agentPreset: 'standard' }], ['credentials.describe', {}], ['llm.discoverModels', {}],
    ['agentPresets/select', { agentId: 's1', agentPreset: 'standard' }], ['agentPreset.list', { sessionId: 's1' }],
    ['llm.models', { apiKey: 'DO_NOT_FORWARD' }], ['session.models', { sessionId: 's1', cwd: 'D:/escape' }],
    ['session.selectModel', { sessionId: 's1', model: 'model-a' }],
    ['session.selectModel', { agentId: 's1', provider: 'provider-a', model: 'model-a' }],
    ['session.selectModel', { sessionId: 's1', provider: ' ', model: 'model-a' }],
    ['session.selectModel', { sessionId: 's1', provider: 'provider-a', model: 'x'.repeat(257) }],
    ['session.selectModel', { sessionId: 's1', provider: 'provider-a', model: 'model-a', reasoningEffort: false }],
    ['session.selectModel', { sessionId: 's1', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high\nKEY' }],
    ['agentPreset.select', { sessionId: 's1', agentPreset: 'standard', force: true }],
    ['agentPreset.select', { sessionId: 's1', agentPreset: 'x'.repeat(257) }],
    ['agentPreset.select', { sessionId: 's1', agentPreset: '\0escape' }]
  ]) equal((await invoke(method, request)).status, 400, 'Uninspected method or malformed/broad parameters never reach native DSH');
  equal(calls.length, before, 'Rejected requests make no native call');
  equal((await invoke('session.selectModel', valid[3][1], false)).status, 403, 'A browser header alone cannot authorize a selection write');
  profile = 'remote-mux';
  equal((await invoke('agentPreset.select', valid[5][1])).status, 409, 'A cached legacy UI cannot write to another live protocol');
  profile = null;
  equal((await invoke('session.models', { sessionId: 's1' })).status, 503, 'Unknown runtime does not become a selection-capable protocol');
  equal(calls.length, before, 'Auth/profile failures forward neither reads nor writes');
}
async function browserChecks() {
  const calls = []; const events = [];
  const rows = [{ sessionId: 's1', blank: true, running: false, agentPreset: 'standard', updatedAt: 1 },
    { sessionId: 's2', blank: true, running: false, agentPreset: 'standard', updatedAt: 1 }];
  let current = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' };
  let refuse = false, readFails = false, ackOnly = false, delayed = null, resolveWrite;
  const catalog = { groups: [{ id: 'provider-a', name: 'Provider A', models: [
    { id: 'model-a', name: 'Model A', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
    { id: 'model-b', name: 'Model B' }] }], failures: [] };
  const global = { Map, Array, Promise, Number, TextEncoder, Uint8Array, DataView,
    __dshE2eeSecret: 'synthetic-secret-never-used-live', setTimeout: () => 1, clearTimeout() {},
    DshE2EE: { prove: async () => true, encryptedFetch: async (_secret, url, init) => {
      equal(init.method, 'POST', 'All selection traffic stays in encrypted POST');
      if (url === '/__dsh/legacy-interactions') return { status: 200, ok: true, json: async () => ({ ok: true, interactions: [] }) };
      equal(url, '/__dsh/legacy-rpc', 'No direct native, plaintext or arbitrary endpoint is opened');
      const { method, request } = JSON.parse(init.body); calls.push({ method, request });
      let value, failure;
      if (method === 'host.describe') value = { version: '0.0.1', home: 'D:/fixture' };
      else if (method === 'workspace.list') value = { items: [{ workspaceId: 'w1', path: 'D:/fixture', sessionIds: ['s1', 's2'] }] };
      else if (method === 'session.list') { if (readFails) throw Error('Synthetic read interrupted'); value = { items: rows }; }
      else if (method === 'session.history') value = { events: [], hasMore: false };
      else if (method === 'agentPreset.list') value = { presets: [{ id: 'standard', isDefault: true }, { id: 'creative', isDefault: false }], authorable: false, hasDocument: false };
      else if (method === 'llm.models') value = catalog;
      else if (method === 'session.models') { if (readFails) throw Error('Synthetic read interrupted'); value = { ...catalog, current, routable: true }; }
      else if (method === 'agentPreset.select') {
        if (refuse || rows.find(row => row.sessionId === request.sessionId).blank === false) failure = { code: 'agent-preset-locked', message: 'Session already started.' };
        else { if (!ackOnly) rows.find(row => row.sessionId === request.sessionId).agentPreset = request.agentPreset; value = { agentPreset: request.agentPreset }; }
      } else if (method === 'session.selectModel') {
        if (refuse) failure = { code: 'model-unavailable', message: 'Model unavailable.' };
        else { if (!ackOnly) current = { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) }; value = { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) } }; }
        if (delayed) await new Promise(resolve => { resolveWrite = resolve; });
      } else throw Error('Unexpected synthetic method');
      return { status: 200, ok: true, json: async () => plain({ result: failure ? { ok: false, error: failure } : { ok: true, value } }) };
    } } };
  global.window = global;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite-legacy.js'), 'utf8'), global);
  const adapter = global.DshLegacyAdapter;
  await adapter.connect(event => events.push(event)); await adapter.loadSession('s1');
  equal((await adapter.listModes()).map(item => item.id), ['standard', 'creative'], 'Inspected preset rows are mapped without guessing another protocol');
  equal(plain(await adapter.listModels('s1')).map(item => [item.id, item.provider, item.defaultEffort, item.efforts.length]),
    [['model-a', 'provider-a', 'low', 2], ['model-b', 'provider-a', '', 0]], 'The exact provider and advertised reasoning options reach the picker');
  const initial = await adapter.readSelection('s1');
  equal(plain(initial.modelSelection), { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' }, 'The current choice is read from session.models, not catalog defaults');
  equal(initial.blank, true, 'Native blank state reaches tool-selection locking');
  equal(initial.agentPreset, 'standard', 'Native session metadata supplies the selected tool preset');
  calls.length = 0;
  equal(plain(await adapter.selectModel('s1', 'model-b', '', 'provider-a')).selected.model, 'model-b', 'A model write is confirmed by fresh native current state');
  equal(calls.map(item => item.method), ['session.selectModel', 'session.models'], 'Model selection writes once and independently reads back');
  equal(calls[0].request, { sessionId: 's1', provider: 'provider-a', model: 'model-b' }, 'The legacy write includes its exact provider/model and sessionId');
  calls.length = 0;
  equal((await adapter.selectMode('s1', 'creative')).agentPreset, 'creative', 'Preset selection waits for a fresh session summary');
  equal(calls.map(item => item.method), ['agentPreset.select', 'session.list'], 'Preset selection writes once and reads authoritative state');
  equal(calls[0].request, { sessionId: 's1', agentPreset: 'creative' }, 'The modern agentId shape cannot accidentally enter the old wire');
  calls.length = 0; ackOnly = true;
  await rejects(adapter.selectModel('s1', 'model-a', 'high', 'provider-a'), /尚未确认/, 'An ACK without changed current state is not displayed as a successful switch');
  equal(calls.filter(item => item.method === 'session.selectModel').length, 1, 'ACK/readback mismatch never resends the write');
  await rejects(adapter.selectMode('s1', 'standard'), /尚未确认/, 'Preset ACK alone is insufficient');
  equal(calls.filter(item => item.method === 'agentPreset.select').length, 1, 'Unconfirmed preset write is never automatically repeated');
  ackOnly = false; refuse = true; calls.length = 0;
  await rejects(adapter.selectModel('s1', 'model-a', '', 'provider-a'), /拒绝/, 'Official model refusal remains visible');
  equal(calls.map(item => item.method), ['session.selectModel'], 'Refusal does not invoke a provider-omitted fallback or second write');
  refuse = false; readFails = true; calls.length = 0;
  await rejects(adapter.selectModel('s1', 'model-a', '', 'provider-a'), /尚未确认/, 'Interrupted readback retains an honest unknown choice');
  equal(calls.filter(item => item.method === 'session.selectModel').length, 1, 'A lost confirmation cannot cause a duplicate write');
  readFails = false; rows[0].blank = false; await adapter.readSelection('s1'); calls.length = 0;
  await rejects(adapter.selectMode('s1', 'standard'), /不能更换/, 'Started native sessions reject local preset changes');
  equal(calls.length, 0, 'A proven nonblank session does not send an unnecessary preset mutation');
  rows[0].blank = true; await adapter.readSelection('s1'); calls.length = 0;
  await rejects(adapter.selectModel('s1', 'model-a', 0, 'provider-a'), /完整/, 'Non-string effort input is not silently omitted');
  await rejects(adapter.selectModel('s2', 'model-a', '', 'provider-a'), /对话已切换/, 'A caller cannot select a model on a different active session');
  equal(calls.length, 0, 'Invalid/cross-session arguments cause no native request');
  delayed = true; const selection = adapter.selectModel('s1', 'model-b', '', 'provider-a');
  await Promise.resolve(); await adapter.loadSession('s2'); resolveWrite();
  await rejects(selection, /对话已切换/, 'A late write acknowledgement cannot update a newly opened conversation');
  equal(calls.filter(item => item.method === 'session.selectModel').length, 1, 'Context changes never replay an admitted write');
  adapter.disconnect();
  await rejects(adapter.readSelection('s2'), /连接已断开/, 'Disconnected state cannot invent a current model selection');
  check(!calls.some(item => /^(?:credentials|settings|agentPreset\.(?:copy|read|openDocument))/.test(item.method)), 'No global configuration or content-reading interface is opened');
}
(async () => { await backendChecks(); await browserChecks(); console.log('Legacy model/tool selection safety checks passed: ' + checks); })()
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
