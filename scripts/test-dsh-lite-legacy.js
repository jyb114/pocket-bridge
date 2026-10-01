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
  console.log('legacy-adapter: project, history, thought, creation, prompt, encrypted-interaction replies passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
