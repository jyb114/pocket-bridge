'use strict';
// Isolated protocol test: fake browser, fake encrypted fetch and fake DSH WS.
// Never starts DSH or sends a real prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sent = [];
const rpcCalls = [];
const events = [];
let instance;
const instances = [];
let failPromptOnce = false;
let delayCloseOnce = false;
let permissionProjection = { asOfSeq: 15, values: { permissions: { currentValue: 'workspace-write' } } };
let attachmentMode = 'ok';
const attachmentReads = [];
const rasterBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0WQAAAAASUVORK5CYII=', 'base64');
class FakeSocket {
  constructor(url) {
    assert.match(url, /^wss:\/\/fixture\.test\/api\/remote\.mux$/);
    this.readyState = 0;
    instance = this;
    instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen(); });
  }
  send(raw) {
    const wire = JSON.parse(raw);
    sent.push(wire);
    if (wire.type === 'open' && wire.endpoint === 'workspace/follow') {
      queueMicrotask(() => this.frame(wire.streamId, { type: 'baseline', value: { items: [
        { workspaceId: 'workspace-1', path: 'D:\\project', title: 'Bridge', sessionIds: ['session-1'] }
      ] } }));
    }
    if (wire.type === 'open' && wire.endpoint === '$events') {
      queueMicrotask(() => this.frame(wire.streamId, { type: 'ready', clientId: 'client-1' }));
    }
    if (wire.type === 'open' && wire.endpoint === 'session/follow') {
      queueMicrotask(() => this.frame(wire.streamId, { type: 'snapshot', records: [
        { type: 'event', event: { type: 'turn/start', seq: 10, data: {} } },
        { type: 'event', event: { type: 'user/message', seq: 11, data: {
          id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' },
            { type: 'image', src: 'base64-private' }] } } },
        { type: 'event', event: { type: 'assistant/message', seq: 12, data: {
          turn: 1, step: 1, message: { id: 'm2', content: [
            { type: 'reasoning', text: 'Inspecting' }, { type: 'text', text: 'World' },
            { type: 'file', attachment: { attachmentId: 'a1', name: 'report.txt', bytes: 5, path: 'D:\\project\\report.txt' } }
          ] } } } },
        { type: 'event', event: { type: 'tool/call', seq: 13, data: { callId: 'call-1', name: 'read', arguments: '{"path":"a"}' } } },
        { type: 'event', event: { type: 'tool/result', seq: 14, data: { message: {
          source: { callId: 'call-1' }, content: [{ type: 'text', text: 'Done' }], isError: false } } } },
        { type: 'event', event: { type: 'turn/end', seq: 15, data: {} } }
      ], hasMore: true, cursor: 15, assistantStream: { revision: 0 },
      projections: { values: { title: 'Greeting' } } }));
    }
  }
  frame(streamId, value) { this.onmessage({ data: JSON.stringify({ type: 'item', streamId, value }) }); }
  close() {
    if (this.readyState === 2 || this.readyState === 3) return;
    if (delayCloseOnce) {
      delayCloseOnce = false;
      this.readyState = 2;
      return;
    }
    this.finishClose();
  }
  finishClose() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
  drop() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006 }); }
}
// 假 document。**必须支持 addEventListener** ——
// 适配器是靠 visibilitychange 决定"回到前台要不要重连"的。
// 原来这里是个空对象，那条路**从来没被覆盖过**，而使用者报的
// 「同意语音权限后对话内容加载不出来、要刷新重选项目」正好就在那条路上。
const docListeners = {};
let visibility = 'visible';
const fakeDocument = {
  dispatchEvent() {},
  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  removeEventListener(type, fn) {
    docListeners[type] = (docListeners[type] || []).filter(f => f !== fn);
  }
};
Object.defineProperty(fakeDocument, 'visibilityState', { get: () => visibility, configurable: true });
function setVisibility(state) {
  visibility = state;
  (docListeners.visibilitychange || []).slice().forEach(fn => fn());
}
const runtime = {
  window: null, WebSocket: FakeSocket, Map, Promise, Uint8Array, DataView, TextEncoder, Blob,
  Event: class Event { constructor(type) { this.type = type; } },
  setTimeout, clearTimeout,
  document: fakeDocument,
  location: { protocol: 'https:', host: 'fixture.test' },
  crypto: { randomUUID: () => 'random-uuid', getRandomValues: bytes => bytes.fill(1) },
  __dshE2eeSecret: 'fixture-secret',
  DshE2EE: {
    available: () => true, prove: async () => true,
    encryptedFetch: async (_secret, url, init) => {
      if (url === '/__dsh/directories') return { status: 200, ok: true,
        json: async () => ({ ok: true, path: 'D:\\project', parent: 'D:\\', roots: [
          { name: 'D:', path: 'D:\\' } ], directories: [{ name: 'src', path: 'D:\\project\\src' }] }) };
      if (url === '/__dsh/lite-upload') {
        assert.equal(init.headers['content-type'], 'application/octet-stream');
        const bytes = init.body, length = new DataView(bytes.buffer).getUint32(0, false);
        assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))),
          { sessionId: 'session-1', name: 'report.txt' });
        assert.equal(new TextDecoder().decode(bytes.slice(4 + length)), 'file bytes');
        return { status: 200, ok: true, json: async () => ({ ok: true, value: {
          receiptId: 'receipt-1', file: { attachmentId: 'a2', name: 'report.txt', bytes: 10 } } }) };
      }
      if (url === '/__dsh/lite-download') {
        assert.deepEqual(JSON.parse(init.body), { sessionId: 'session-1', path: 'D:\\project\\report.txt' });
        return { status: 200, ok: true, blob: async () => new Blob(['file bytes']) };
      }
      if (url === '/__dsh/lite-attachment') {
        attachmentReads.push({ body: JSON.parse(init.body), signal: init.signal });
        assert.equal(init.method, 'POST');
        assert.equal(init.credentials, 'same-origin');
        assert.equal(init.cache, 'no-store');
        assert.equal(init.headers['content-type'], 'application/json; charset=utf-8');
        const status = ({ unsupported: 501, unavailable: 404, large: 413 })[attachmentMode] || 200;
        const type = attachmentMode === 'svg' ? 'image/svg+xml' : 'image/png';
        return { status, ok: status === 200, headers: { get: key => ({
          'content-type': type, 'x-dsh-e2ee-decrypted': attachmentMode === 'plaintext' ? null : '1',
          'x-dsh-e2ee': attachmentMode === 'ciphertext' ? '1' : null
        })[key] || null }, blob: async () => new Blob([
          attachmentMode === 'empty' ? new Uint8Array() : attachmentMode === 'oversize' ? new Uint8Array(8 * 1024 * 1024 + 1) : rasterBytes
        ], { type }) };
      }
      if (url === '/__dsh/lite-files') {
        assert.deepEqual(JSON.parse(init.body), { sessionId: 'session-1', path: '', offset: 0 });
        return { status: 200, ok: true, json: async () => ({ path: '', entries: [
          { name: 'report.txt', path: 'report.txt', type: 'file', bytes: 10 }
        ], nextOffset: null }) };
      }
      assert.equal(url, '/__dsh/lite-rpc');
      assert.equal(init.headers['content-type'], 'application/json; charset=utf-8');
      const request = JSON.parse(init.body);
      rpcCalls.push(request);
      if (request.method === 'session/prompt' && failPromptOnce) {
        failPromptOnce = false;
        throw new Error('fixture response lost after upstream acceptance');
      }
      let value = {};
      if (request.method === 'workspace/create') value = { workspace: {
        workspaceId: 'workspace-2', path: request.request.path, title: 'New', sessionIds: [] } };
      if (request.method === 'session/list') value = { items: [{ sessionId: 'session-1', blank: false,
        projections: { values: { title: 'Greeting', agentPreset: 'standard',
          modelSelection: { lastUsed: { provider: 'deepseek', model: 'V3' },
            next: { provider: 'deepseek', model: 'V4', reasoningEffort: 'high' } },
          plan: { active: false, pending: true } } } }] };
      if (request.method === 'session/create') value = { sessionId: 'session-2' };
      if (request.method === 'session/projections') value = request.request.sessionId === 'session-2'
        ? { values: { agentPreset: null, modelSelection: { lastUsed: null, next: null },
          sessionListMetadata: { blank: true } } }
        : { values: { agentPreset: 'ptc',
          modelSelection: { lastUsed: { provider: 'deepseek', model: 'V3' },
            next: { provider: 'deepseek', model: 'V4', reasoningEffort: 'high' } },
          plan: { active: true, pending: true },
          sessionListMetadata: { blank: false } } };
      if (request.method === 'session/projections') {
        value = { ...value, asOfSeq: permissionProjection.asOfSeq,
          values: { ...value.values, permissions: permissionProjection.values && permissionProjection.values.permissions } };
      }
      if (request.method === 'agentPresets/list') value = { presets: [
        { id: 'standard', name: 'Standard', description: 'General coding', isDefault: true },
        { id: 'ptc', name: 'Code tool', description: 'run_code', isDefault: false,
          broken: 'PTC runtime missing' }
      ] };
      if (request.method === 'session/prompt') value = { accepted: true };
      if (request.method === 'session/cancel') value = { accepted: true };
      if (request.method === 'session/page') value = { records: [
        { type: 'event', event: { type: 'user/message', seq: 8, data: {
          id: 'older', source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier' }] } } },
        { type: 'event', event: { type: 'turn/end', seq: 9, data: {} } }
      ], hasMore: false };
      return { status: 200, ok: true, json: async () => ({ result: { ok: true, value } }) };
    }
  }
};
runtime.window = runtime;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-adapter.js'), 'utf8'), runtime);

(async () => {
  const api = runtime.DshLiteAdapter;
  await api.connect(event => events.push(event));
  assert.equal(typeof api.listProjects, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(await api.listProjects())), [
    { id: 'workspace-1', name: 'Bridge', path: 'D:\\project' }
  ]);
  assert.equal((await api.listSessions('workspace-1'))[0].id, 'session-1');
  await new Promise(resolve => setImmediate(resolve));
  const sessionRow = (await api.listSessions('workspace-1'))[0];
  assert.equal(sessionRow.title, 'Greeting');
  assert.equal(sessionRow.blank, false);
  assert.equal(sessionRow.agentPreset, 'standard');
  assert.deepEqual(JSON.parse(JSON.stringify(sessionRow.modelSelection)),
    { provider: 'deepseek', model: 'V4', reasoningEffort: 'high' });
  assert.deepEqual(JSON.parse(JSON.stringify(sessionRow.plan)), { active: false, pending: true });
  const selection = await api.readSelection('session-1');
  assert.deepEqual(JSON.parse(JSON.stringify(selection)), {
    agentPreset: 'ptc', modelSelection: { provider: 'deepseek', model: 'V4', reasoningEffort: 'high' },
    lastUsedModel: { provider: 'deepseek', model: 'V3' },
    plan: { active: true, pending: true }, blank: false
  });
  assert.deepEqual(rpcCalls.at(-1), { method: 'session/projections', request: { sessionId: 'session-1' } });
  for (const presetId of ['read-only', 'workspace-write', 'danger-full-access']) {
    permissionProjection = { asOfSeq: 15, values: { permissions: { currentValue: presetId } } };
    assert.deepEqual(JSON.parse(JSON.stringify(await api.readPermission('session-1'))), { presetId, asOfSeq: 15 });
    assert.deepEqual(rpcCalls.at(-1), { method: 'session/projections', request: { sessionId: 'session-1' } });
  }
  for (const value of [
    { asOfSeq: 15, values: {} },
    { asOfSeq: 15, values: { permissions: { currentValue: 'invented-scope' } } },
    { asOfSeq: '15', values: { permissions: { currentValue: 'workspace-write' } } },
    { asOfSeq: -2, values: { permissions: { currentValue: 'workspace-write' } } }
  ]) {
    permissionProjection = value;
    await assert.rejects(api.readPermission('session-1'), /当前授权范围/);
  }
  permissionProjection = { asOfSeq: 15, values: { permissions: { currentValue: 'workspace-write' } } };
  const readsBeforeEmpty = rpcCalls.length;
  await assert.rejects(api.readPermission(''), /请先打开/);
  assert.equal(rpcCalls.length, readsBeforeEmpty, 'an empty target never becomes a projection request');
  const presets = await api.listModes();
  assert.deepEqual(JSON.parse(JSON.stringify(presets)), [
    { id: 'standard', name: 'Standard', description: 'General coding', isDefault: true, broken: '' },
    { id: 'ptc', name: 'Code tool', description: 'run_code', isDefault: false,
      broken: 'PTC runtime missing' }
  ]);
  assert.deepEqual(rpcCalls.at(-1), { method: 'agentPresets/list', request: {} });
  assert.deepEqual(JSON.parse(JSON.stringify((await api.loadSession('session-1')).records)), [
    { id: 'm1', role: 'user', text: 'Hello', attachments: [] },
    { id: 'assistant:1:1:thought', role: 'thought', title: '思考过程', text: 'Inspecting', status: 'settled' },
    { id: 'assistant:1:1', role: 'assistant', text: 'World', status: 'settled', attachments: [
      { id: 'a1', name: 'report.txt', mimeType: '', size: 5, kind: 'file', path: 'D:\\project\\report.txt' }
    ] },
    { id: 'tool:call-1', role: 'tool', title: 'read', text: '{"path":"a"}\n\nDone', status: 'settled', attachments: [] }
  ]);
  assert.equal(sent.find(w => w.endpoint === 'session/follow').payload.args.request.maxMessages, 30);
  assert.equal(events.find(e => e.type === 'records').hasMore, true);
  assert.equal(events.filter(e => e.type === 'records').at(-1).running, false,
    'a snapshot with a latest turn/end must not infer running from historical rows');
  const older = await api.loadOlder('session-1');
  assert.equal(older.hasMore, false);
  assert.equal(older.records[0].text, 'Earlier');
  assert.equal(rpcCalls.at(-1).request.maxMessages, 20);
  assert.equal(rpcCalls.at(-1).request.beforeSeq, 10);
  instance.frame('lite-session-1', { type: 'assistant-stream', frame: {
    type: 'start', revision: 1, attemptId: 'attempt-1', turn: 2, step: 1, startedAfterSeq: 15 } });
  instance.frame('lite-session-1', { type: 'assistant-stream', frame: {
    type: 'chunk', revision: 2, attemptId: 'attempt-1', index: 0,
    chunk: { type: 'reasoning-delta', index: 0, text: 'Live thought' } } });
  instance.frame('lite-session-1', { type: 'assistant-stream', frame: {
    type: 'chunk', revision: 3, attemptId: 'attempt-1', index: 1,
    chunk: { type: 'text-delta', index: 1, text: 'Live ' } } });
  assert.ok(events.some(e => e.type === 'record' && e.record.role === 'thought' && e.record.text === 'Live thought'));
  assert.ok(events.some(e => e.type === 'record' && e.record.role === 'assistant' && e.record.text === 'Live '));
  instance.frame('lite-session-1', { type: 'event', event: { type: 'assistant/message', seq: 16,
    data: { turn: 2, step: 1, message: { id: 'm3', content: [
      { type: 'reasoning', text: 'Live thought' }, { type: 'text', text: 'Live reply' }
    ] } } } });
  instance.frame('lite-session-1', { type: 'assistant-stream', frame: {
    type: 'end', revision: 4, attemptId: 'attempt-1', index: 2,
    outcome: { kind: 'settled', seq: 16, eventType: 'assistant/message' } } });
  assert.ok(events.some(e => e.type === 'record' && e.record.text === 'Live reply'));
  instance.frame('lite-session-1', { type: 'event', event: { type: 'turn/start', seq: 17, data: {} } });
  instance.frame('lite-session-1', { type: 'event', event: { type: 'turn/end', seq: 18, data: {} } });
  assert.deepEqual(events.filter(e => e.type === 'session-status').map(e => e.running), [true, false]);
  instance.frame('lite-session-1', { type: 'event', event: { type: 'turn/end', seq: 19,
    data: { turn: 3, reason: { kind: 'error', error: { status: 401, code: 'AUTH',
      message: 'Authentication failed: sensitive credential detail' } } } } });
  const failedTurn = events.find(e => e.type === 'record' && e.record.id === 'turn-error:3');
  assert.equal(failedTurn.record.role, 'system');
  assert.equal(failedTurn.record.status, 'error');
  assert.match(failedTurn.record.text, /401/);
  assert.ok(!failedTurn.record.text.includes('sensitive credential detail'), 'model authentication errors never echo credential details');
  assert.equal((await api.listDirectories()).directories[0].name, 'src');
  assert.equal((await api.listWorkspaceFiles({ sessionId: 'session-1' })).entries[0].path, 'report.txt');
  const file = { name: 'report.txt', size: 10, arrayBuffer: async () => new TextEncoder().encode('file bytes').buffer };
  const upload = await api.uploadFile({ sessionId: 'session-1', file });
  assert.equal(upload.receiptId, 'receipt-1');
  const download = await api.downloadFile({ sessionId: 'session-1', path: 'D:\\project\\report.txt' });
  assert.equal(download.name, 'report.txt');
  assert.equal(await download.blob.text(), 'file bytes');
  // Official ID retrieval never accepts an arbitrary file path, non-digest ID,
  // unmarked plaintext, retained ciphertext, active format, or oversized bytes.
  const imageId = 'sha256:' + 'a'.repeat(64);
  const signal = new AbortController().signal;
  const image = await api.downloadImageAttachment({ sessionId: 'session-1', attachmentId: imageId, signal });
  assert.deepEqual(attachmentReads.at(-1).body, { sessionId: 'session-1', attachmentId: imageId });
  assert.equal(attachmentReads.at(-1).signal, signal);
  assert.equal(image.sessionId, 'session-1');
  assert.equal(image.attachmentId, imageId);
  assert.equal(image.blob.type, 'image/png');
  assert.deepEqual(Buffer.from(await image.blob.arrayBuffer()), rasterBytes);
  const readsBeforeInvalid = attachmentReads.length;
  for (const attachmentId of ['', 'D:\\private\\image.png', 'sha256:' + 'a'.repeat(63), 'sha256:' + 'A'.repeat(64)]) {
    await assert.rejects(api.downloadImageAttachment({ sessionId: 'session-1', attachmentId }), /标识无效/);
  }
  await assert.rejects(api.downloadImageAttachment({ sessionId: 'session\n1', attachmentId: imageId }), /标识无效/);
  assert.equal(attachmentReads.length, readsBeforeInvalid, 'invalid scope/ID never reaches encrypted HTTP');
  for (const [mode, message] of [
    ['unsupported', /尚不支持/], ['unavailable', /不属于当前对话/], ['large', /安全预览/],
    ['plaintext', /加密验证/], ['ciphertext', /加密验证/], ['svg', /格式不受支持/],
    ['empty', /安全预览/], ['oversize', /安全预览/]
  ]) {
    attachmentMode = mode;
    await assert.rejects(api.downloadImageAttachment({ sessionId: 'session-1', attachmentId: imageId }), message);
  }
  attachmentMode = 'ok';
  const project = await api.createProject({ path: 'D:\\new-project' });
  assert.equal(project.id, 'workspace-2');
  const session = await api.createSession({ projectId: project.id });
  assert.equal(session.id, 'session-2');
  assert.deepEqual(JSON.parse(JSON.stringify((await api.listSessions(project.id)).map(row => [row.id, row.title]))),
    [['session-2', '对话 1']], 'locally created session is first in newest-first workspace order');
  instance.frame('lite-workspaces', { type: 'upsert', workspace: {
    workspaceId: 'workspace-3', path: 'D:\\ordering', title: 'Ordering',
    sessionIds: ['untitled-2', 'untitled-1'] } });
  assert.deepEqual(JSON.parse(JSON.stringify((await api.listSessions('workspace-3')).map(row => [row.id, row.title]))),
    [['untitled-2', '对话 2'], ['untitled-1', '对话 1']], 'native workspace order is newest-first');
  instance.frame('lite-workspaces', { type: 'upsert', workspace: {
    workspaceId: 'workspace-3', path: 'D:\\ordering', title: 'Ordering',
    sessionIds: ['untitled-3', 'untitled-2', 'untitled-1'] } });
  assert.deepEqual(JSON.parse(JSON.stringify((await api.listSessions('workspace-3')).map(row => [row.id, row.title]))),
    [['untitled-3', '对话 3'], ['untitled-2', '对话 2'], ['untitled-1', '对话 1']],
    'new untitled session receives next number without renumbering older rows');
  assert.deepEqual(JSON.parse(JSON.stringify(await api.readSelection(session.id))),
    { agentPreset: null, modelSelection: null, lastUsedModel: null, plan: null, blank: true });
  await api.sendMessage({ sessionId: session.id, text: 'isolated text', attachments: [upload] });
  assert.equal(rpcCalls.at(-1).request.content[0].text, 'isolated text');
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls.at(-1).request.content[1])),
    { type: 'file', receiptId: 'receipt-1' });
  failPromptOnce = true;
  await assert.rejects(api.sendMessage({ sessionId: 'session-1', text: 'retry-safe' }));
  const uncertainId = rpcCalls.at(-1).request.requestId;
  await api.sendMessage({ sessionId: 'session-1', text: 'retry-safe' });
  assert.equal(rpcCalls.at(-1).request.requestId, uncertainId);
  await api.cancelSession('session-1');
  assert.equal(rpcCalls.at(-1).request.sessionId, 'session-1');
  instance.frame('lite-events', { type: 'waterfall', event: 'approval/request', eventId: 'approve-1',
    agentId: 'session-1', request: { toolName: 'shell', reason: 'Fixture' } });
  assert.ok(events.some(e => e.type === 'interaction' && e.interaction.kind === 'approval'));
  await api.respondToInteraction({ id: 'approve-1', answer: { type: 'approve' } });
  assert.equal(rpcCalls.at(-1).request.outcome.value, 'allowed-once');
  instance.frame('lite-events', { type: 'waterfall', event: 'user-questions/request', eventId: 'ask-1',
    agentId: 'session-1', request: { questions: [{ id: 'q1', question: 'Choose', options: [
      { label: 'A' }, { label: 'B' }] }] } });
  await api.respondToInteraction({ id: 'ask-1', answer: { type: 'answers', answers: [
    { id: 'q1', selected: ['B'] }] } });
  assert.equal(rpcCalls.at(-1).request.outcome.value.answers[0].selected[0], 'B');
  assert.equal(api.capabilities.interactiveReplies, true);
  const old = instance;
  old.drop();
  await new Promise(resolve => setTimeout(resolve, 600));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instances.length, 2);
  assert.ok(sent.filter(w => w.endpoint === 'session/follow').length >= 2);
  assert.ok(events.some(e => e.type === 'status' && e.state === 'connecting'));
  assert.ok(events.filter(e => e.type === 'status' && e.state === 'connected').length >= 2);
  // ── 回到前台必须无条件重连（使用者报的「同意语音权限后对话加载不出来」）──────
  //
  // 根因：原来回前台时有一道「离开不足 10 秒就什么都不做」的闸门。
  // 而 iOS 在页面失活期间会**静默丢弃** WebSocket，`readyState` 还留着 1 ——
  // 于是几秒钟的失活（**系统权限弹窗正是这种**，例如同意麦克风权限）回来之后，
  // 没有任何人发现连接已经死了：界面永远停在旧内容上，只能刷新页面、重选项目。
  //
  // 这条测试的关键是：**整个过程只用几百毫秒**。
  // 旧实现要"离开超过 10 秒"才动作，所以它必然在这里失败 —— 这正是要防的回归。
  const beforeHidden = instances.length;
  const followsBefore = sent.filter(w => w.endpoint === 'session/follow').length;
  setVisibility('hidden');
  assert.equal(instance.readyState, 3,
    '进后台应当主动断开 —— 而不是留一条"看着是通的、其实已经死了"的连接');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(instances.length, beforeHidden, '在后台不该反复重连（白耗电、白耗流量）');

  setVisibility('visible');            // ★ 立刻回来，远不到 10 秒
  await new Promise(resolve => setTimeout(resolve, 900));   // 重连自身有 500ms 退避
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(instances.length > beforeHidden,
    '回到前台必须重新建连 —— 不管刚才离开了多久（几秒的系统弹窗也算）');
  assert.ok(sent.filter(w => w.endpoint === 'session/follow').length > followsBefore,
    '重连后必须重新订阅当前对话 —— 否则界面就是"对话内容加载不出来"');
  assert.ok(events.filter(e => e.type === 'status' && e.state === 'connected').length >= 2,
    '重连成功要告诉界面"已连接"');

  // Safari can leave a suspended WebSocket in CLOSING without delivering
  // onclose until well after foregrounding. Reconnect must not wait for it.
  const stale = instance;
  const beforeDelayedClose = instances.length;
  const followsBeforeDelayedClose = sent.filter(w => w.endpoint === 'session/follow').length;
  delayCloseOnce = true;
  setVisibility('hidden');
  assert.equal(stale.readyState, 2, '模拟 iOS 后台里迟迟收不到 onclose');
  setVisibility('visible');
  await new Promise(resolve => setTimeout(resolve, 900));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instances.length, beforeDelayedClose + 1,
    '旧 WebSocket 停在 CLOSING 时也必须新建且只新建一条连接');
  assert.ok(sent.filter(w => w.endpoint === 'session/follow').length > followsBeforeDelayedClose,
    '新连接必须重新订阅原本打开的对话');
  const replacement = instance;
  stale.finishClose();
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(instance, replacement, '迟到的旧 onclose 不能替换新连接');
  assert.equal(replacement.readyState, 1, '迟到的旧 onclose 不能关闭新连接');
  assert.equal(instances.length, beforeDelayedClose + 1,
    '迟到的旧 onclose 不能再安排第二条重连');

  api.disconnect();
  console.log('DSH lite adapter: compact stream, history, reconnect, files and interactions passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
