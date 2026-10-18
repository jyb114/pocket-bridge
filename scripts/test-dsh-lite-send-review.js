'use strict';

// Actual UI gate and send functions; DOM, clocks and upstream are isolated
// fixtures. This mitigates blind fresh-page retries, not exactly-once execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite-ui.js'), 'utf8');
function section(start, end) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin);
  return source.slice(begin, finish);
}
const code = section('    function draftKey(', '    function resetSessionExtras(') +
  section('    function invalidateSendReview(', '    async function loadOlder(');
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
class Node {
  constructor(text = '') { this.textContent = text; this.children = []; this.events = {}; this.isConnected = true; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; this.textContent = ''; }
  addEventListener(type, callback) { this.events[type] = callback; }
  click() { if (!this.disabled && this.events.click) return this.events.click(); }
  focus() { this.focused = true; }
  find(id) { return this.id === id ? this : this.children.map(node => node.find(id)).find(Boolean); }
  text() { return this.textContent + this.children.map(node => node.text()).join('\n'); }
}
function fixture() {
  const state = { projectId: 'p', sessionId: 'A', connection: 'connected', connecting: 1,
    contextVersion: 1, sessionLoad: 1, sendReviewVersion: 0, reviewedSendSessions: new Set(),
    drafts: new Map(), uploads: [{ receiptId: 'r', file: { name: 'owned.txt', bytes: 12 } }],
    records: [{ role: 'user', text: 'Earlier question' }], hasMore: false };
  const input = new Node(); input.value = '  Intentional task  ';
  const refs = { input, send: new Node(), records: { scrollHeight: 42, scrollTop: 0 } };
  const timers = new Map(), calls = [], boxes = [];
  let timerId = 0, queue = async () => [{ text: 'Already queued task' }], sendResult = async () => {};
  const adapter = { listQueued: id => queue(id), sendMessage: async data => { calls.push(data); await sendResult(); } };
  const ui = { state, refs, adapter, window: { __dshE2eeSecret: 'fixture-only', DshE2EE: {} },
    backupConnectionEpoch: 1, t: value => value, label: (value, fallback) => typeof value === 'string' ? value : fallback,
    queueItemText: item => item.text || '', el: (_tag, _class, text) => new Node(text),
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    setTab: tab => { ui.tab = tab; }, showError: (_error, text) => { ui.error = text; }, clearError: () => {},
    renderControls: () => {}, renderUploads: () => {},
    overlay: (_title, build) => {
      for (const old of boxes) if (old.isConnected) old.__liteClose();
      const box = new Node(), body = new Node(); box.append(body);
      box.__liteClose = () => { box.isConnected = false; }; boxes.push(box); build(body, box); return box;
    }
  };
  vm.createContext(ui); vm.runInContext(code, ui, { filename: 'production-ui-send-review.js' });
  return { state, refs, ui, calls, boxes, timers,
    get box() { return boxes.at(-1); }, node(id) { return this.box.find(id); },
    queue(value) { queue = value; }, sendResult(value) { sendResult = value; },
    submit() { return ui.send({ preventDefault() {} }); },
    async review() { await this.submit(); await flush(); this.node('send-review-confirm').click(); },
    deadline() { for (const callback of Array.from(timers.values())) callback(); }
  };
}
let checks = 0;
async function check(name, run) { await run(fixture()); checks++; console.log('PASS ' + name); }
async function run() {
  function protocol(f, operation, resolve = async () => {}) {
    f.ui.adapter.listPromptOperations = async () => operation ? [operation] : [];
    f.ui.adapter.resolvePromptOperation = resolve;
    if (operation) f.sendResult(async () => {
      throw Object.assign(Error('receipt review'), { code: 'prompt-recovery-required', operations: [operation] });
    });
  }
  function recoveryButton(f) {
    function visit(node) { return node.dataset.requestId ? node : node.children.map(visit).find(Boolean); }
    return visit(f.box);
  }
  await check('durable protocol sends ordinary drafts without a generic fresh-page warning', async f => {
    protocol(f); await f.submit();
    assert.equal(f.calls.length, 1); assert.equal(f.boxes.length, 0); assert.equal(f.refs.input.value, '');
  });
  await check('accepted matching receipt only acknowledges and clears the unchanged draft', async f => {
    const resolved = [];
    protocol(f, { requestId: 'accepted-one', state: 'accepted', matchesDraft: true }, async value => resolved.push(value));
    await f.submit(); assert.match(f.box.text(), /电脑已接收/); await recoveryButton(f).click();
    assert.equal(f.calls.length, 1); assert.equal(resolved[0].action, 'acknowledge');
    assert.equal(Object.hasOwn(resolved[0], 'confirm'), false);
    assert.equal(f.refs.input.value, ''); assert.equal(f.state.uploads.length, 0);
  });
  await check('accepted different receipt preserves the new draft and uploaded receipts', async f => {
    const before = f.refs.input.value, attachment = f.state.uploads[0];
    protocol(f, { requestId: 'accepted-other', state: 'accepted', matchesDraft: false });
    await f.submit(); await recoveryButton(f).click();
    assert.equal(f.calls.length, 1); assert.equal(f.refs.input.value, before); assert.equal(f.state.uploads[0], attachment);
  });
  await check('an intentional new identical question can be kept without automatic dispatch', async f => {
    const before = f.refs.input.value, resolved = [];
    protocol(f, { requestId: 'same-but-new-intent', state: 'accepted', matchesDraft: true }, async value => resolved.push(value));
    await f.submit();
    function visit(node) { return node.dataset.intent === 'new-same-content' ? node : node.children.map(visit).find(Boolean); }
    await visit(f.box).click();
    assert.equal(resolved[0].action, 'acknowledge'); assert.equal(f.refs.input.value, before);
    assert.equal(f.state.uploads.length, 1); assert.equal(f.calls.length, 1);
  });
  await check('receipt without a draft match cannot acknowledge away the original identity', async f => {
    const resolved = [], before = f.refs.input.value;
    protocol(f, { requestId: 'unmatched-list-receipt', state: 'accepted' }, async value => resolved.push(value));
    await f.submit(); await recoveryButton(f).click();
    assert.equal(resolved.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.refs.input.value, before);
    assert.equal(f.box.isConnected, false);
  });
  await check('uncertain review explicitly confirms risk and never submits another prompt', async f => {
    const resolved = [];
    protocol(f, { requestId: 'uncertain-one', state: 'uncertain' }, async value => resolved.push(value));
    await f.submit(); assert.match(f.box.text(), /仍可能重复执行/); await recoveryButton(f).click();
    assert.equal(resolved[0].action, 'review-uncertain'); assert.equal(resolved[0].confirm, true);
    assert.equal(f.calls.length, 1); assert.notEqual(f.refs.input.value, '');
  });
  await check('prepared intent can be cancelled without dispatching or losing the draft', async f => {
    const resolved = [];
    protocol(f, { requestId: 'prepared-one', state: 'prepared' }, async value => resolved.push(value));
    await f.submit(); await recoveryButton(f).click();
    assert.equal(resolved[0].action, 'cancel-prepared'); assert.equal(Object.hasOwn(resolved[0], 'confirm'), false);
    assert.equal(f.calls.length, 1); assert.notEqual(f.refs.input.value, '');
  });
  for (const changed of ['conversation', 'draft', 'key', 'connection']) await check('recovery action refuses changed ' + changed, async f => {
    const resolved = [];
    protocol(f, { requestId: 'stale-one', state: 'accepted', matchesDraft: true }, async value => resolved.push(value));
    await f.submit();
    if (changed === 'conversation') f.state.sessionId = 'B';
    if (changed === 'draft') f.refs.input.value = 'New draft';
    if (changed === 'key') f.ui.window.__dshE2eeSecret = 'changed-fixture';
    if (changed === 'connection') f.ui.backupConnectionEpoch++;
    await recoveryButton(f).click(); assert.equal(resolved.length, 0); assert.equal(f.calls.length, 1);
  });
  await check('late receipt acknowledgement cannot discard an edited draft', async f => {
    let done;
    protocol(f, { requestId: 'slow-ack', state: 'accepted', matchesDraft: true }, () => new Promise(resolve => { done = resolve; }));
    await f.submit(); const pending = recoveryButton(f).click();
    f.refs.input.value = 'Edited while acknowledgement was pending'; done(); await pending;
    assert.equal(f.refs.input.value, 'Edited while acknowledgement was pending'); assert.equal(f.state.uploads.length, 1);
  });
  await check('failed receipt update retains the draft and offers no automatic prompt retry', async f => {
    protocol(f, { requestId: 'failed-ack', state: 'accepted', matchesDraft: true }, async () => { throw Error('offline'); });
    await f.submit(); await recoveryButton(f).click();
    assert.match(f.node('prompt-recovery-status').textContent, /无法确认/);
    assert.notEqual(f.refs.input.value, ''); assert.equal(f.calls.length, 1);
  });
  for (const phase of ['prepared', 'accepted']) await check('changed-context ' + phase + ' receipt uses its actual journal action', async f => {
    const { createDshPromptState } = require('./dsh-prompt-state.js');
    const crypto = require('node:crypto');
    const parent = path.resolve(__dirname, '..', '..', 'output'); fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'ui-journal-recovery-'));
    const journal = createDshPromptState({ directory });
    const context = { deviceId: 'owned-ui-device-123', runtimeId: 'previous-runtime', secret: 'synthetic-ui-only-encryption-key' };
    const request = { requestId: crypto.randomUUID(), sessionId: 'A', mode: 'queue', content: [{ type: 'text', text: 'Earlier task' }] };
    journal.prepare(context, request);
    if (phase === 'accepted') { journal.begin(context, request); journal.accepted(context, request); }
    const changed = { ...context, runtimeId: 'replacement-runtime', secret: 'synthetic-ui-replacement-key' };
    const operation = journal.state(changed, { sessionId: 'A', action: 'list' }).operations[0];
    assert.equal(operation.contextChanged, true); assert.equal(operation.state, phase);
    const before = f.refs.input.value, resolved = [];
    protocol(f, operation, async value => { resolved.push(value); return journal.state(changed, value).operation; });
    await f.submit(); await recoveryButton(f).click();
    assert.equal(resolved[0].action, phase === 'accepted' ? 'acknowledge' : 'cancel-prepared');
    assert.equal(journal.state(changed, { sessionId: 'A', action: 'list' }).operations.length, 0);
    assert.equal(f.refs.input.value, before); assert.equal(f.calls.length, 1);
  });
  await check('first existing-session send only opens review, displays history/queue and explicit risk', async f => {
    await f.submit(); await flush();
    assert.equal(f.calls.length, 0); assert.match(f.box.text(), /Earlier question/);
    assert.match(f.box.text(), /Already queued task/); assert.match(f.box.text(), /仍作为新消息，可能重复执行/);
    assert.equal(f.node('send-review-confirm').disabled, false);
  });
  for (const dismissal of ['cancel', 'close', 'history']) await check(dismissal + ' retains exact text/receipts and never sends', async f => {
    const text = f.refs.input.value, upload = f.state.uploads[0];
    await f.submit(); await flush();
    if (dismissal === 'close') f.box.__liteClose();
    else f.node('send-review-' + dismissal).click();
    assert.equal(f.calls.length, 0); assert.equal(f.refs.input.value, text); assert.equal(f.state.uploads[0], upload);
    assert.equal(f.state.sendReview, null); assert.equal(f.timers.size, 0);
    if (dismissal === 'history') { assert.equal(f.ui.tab, 'conversation'); assert.equal(f.refs.records.scrollTop, 42); }
    await f.submit(); assert.equal(f.box.isConnected, true); assert.equal(f.calls.length, 0);
  });
  await check('confirm requires a separate Send and normal later questions do not gate or text-deduplicate', async f => {
    await f.review(); assert.equal(f.calls.length, 0); assert.equal(f.box.isConnected, false);
    const oldConfirm = f.node('send-review-confirm'); oldConfirm.click();
    await f.submit(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].text, 'Intentional task');
    f.refs.input.value = 'Intentional task'; await f.submit(); assert.equal(f.calls.length, 2);
    assert.equal(f.boxes.length, 1);
  });
  await check('rapid submissions open one gate and rapid sends admit once while pending', async f => {
    await Promise.all([f.submit(), f.submit(), f.submit()]); await flush(); assert.equal(f.boxes.length, 1);
    f.node('send-review-confirm').click(); let finish;
    f.sendResult(() => new Promise(resolve => { finish = resolve; }));
    const first = f.submit(); await f.submit(); assert.equal(f.calls.length, 1); finish(); await first;
  });
  const changes = {
    'raw whitespace': f => { f.refs.input.value += ' '; },
    'attachment object': f => { f.state.uploads[0] = { ...f.state.uploads[0] }; },
    'receipt identity': f => { f.state.uploads[0].receiptId = 'new-receipt'; },
    'nested file metadata': f => { f.state.uploads[0].file.bytes++; },
    'attachment removal': f => { f.state.uploads = []; },
    'attachment order': f => { f.state.uploads.reverse(); },
    'session': f => { f.state.sessionId = 'B'; },
    'project': f => { f.state.projectId = 'q'; },
    'A to B to A context': f => { f.state.contextVersion += 2; },
    'same-session reload': f => { f.state.sessionLoad++; },
    'connect attempt': f => { f.state.connecting++; },
    'disconnect/reconnect': f => { f.ui.backupConnectionEpoch += 2; },
    'key rotation': f => { f.ui.window.__dshE2eeSecret = 'rotated-fixture'; },
    'crypto component': f => { f.ui.window.DshE2EE = {}; },
    'draft edit then undo': f => { f.ui.invalidateSendReview(); },
    'upload underway': f => { f.state.uploading = true; },
    'dispose': f => { f.state.disposed = true; }
  };
  for (const [name, change] of Object.entries(changes)) for (const phase of ['before confirmation', 'after confirmation']) {
    await check(name + ' ' + phase + ' invalidates exact review', async f => {
      f.state.uploads.push({ receiptId: 'r2', file: { name: 'two.txt' } });
      await f.submit(); await flush(); const confirm = f.node('send-review-confirm');
      if (phase === 'after confirmation') confirm.click();
      change(f); confirm.click();
      assert.equal(f.calls.length, 0); assert.equal(f.state.reviewedSendSessions.size, 0);
      if (!f.state.disposed && !f.state.uploading) {
        await f.submit(); assert.equal(f.calls.length, 0); assert.equal(f.box.isConnected, true);
      }
    });
  }
  await check('late queue response cannot replace new review or clear its timer', async f => {
    let resolve;
    f.queue(() => new Promise(done => { resolve = done; })); await f.submit(); await flush();
    const old = f.box; old.__liteClose();
    f.queue(async () => [{ text: 'Fresh queue' }]); await f.submit(); await flush();
    resolve([{ text: 'Obsolete queue' }]); await flush();
    assert.match(f.box.text(), /Fresh queue/); assert.doesNotMatch(f.box.text(), /Obsolete queue/);
    assert.equal(f.state.sendReview.box, f.box); assert.equal(f.calls.length, 0);
  });
  for (const mode of ['failed', 'timeout', 'unsupported', 'malformed', 'malformed entry']) await check('queue ' + mode + ' is explicitly uncertain, never empty-success', async f => {
    if (mode === 'failed') f.queue(async () => { throw Error('fixture'); });
    if (mode === 'timeout') f.queue(() => new Promise(() => {}));
    if (mode === 'unsupported') delete f.ui.adapter.listQueued;
    if (mode === 'malformed') f.queue(async () => ({ items: [] }));
    if (mode === 'malformed entry') f.queue(async () => [null]);
    await f.submit(); await flush(); if (mode === 'timeout') f.deadline();
    assert.match(f.box.text(), /队列未能读取/); assert.doesNotMatch(f.box.text(), /本次读取未见排队消息/);
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
    f.node('send-review-confirm').click(); assert.equal(f.calls.length, 0);
  });
  await check('malformed historical row cannot leave a half-built review', async f => {
    f.state.records = [null, { role: 'user', text: 'Valid history' }];
    await f.submit(); await flush(); assert.match(f.box.text(), /Valid history/);
    assert.equal(f.node('send-review-confirm').disabled, false);
  });
  await check('disposed reviewed session cannot dispatch from retained handler', async f => {
    await f.review(); await f.submit(); f.state.disposed = true; f.refs.input.value = 'Stale callback';
    await f.submit(); assert.equal(f.calls.length, 1);
  });
  for (const property of ['secret', 'crypto', 'connecting']) await check('new empty-session exemption fences late ' + property + ' change', async f => {
    f.state.records = []; let done;
    f.queue(() => new Promise(resolve => { done = resolve; }));
    f.ui.allowNewEmptySessionSend('p', 'A', 'A', null); await flush();
    if (property === 'secret') f.ui.window.__dshE2eeSecret = 'changed-fixture';
    if (property === 'crypto') f.ui.window.DshE2EE = {};
    if (property === 'connecting') f.state.connecting++;
    done([]); await flush(); f.queue(async () => []); await f.submit(); await flush();
    assert.equal(f.calls.length, 0); assert.equal(f.box.isConnected, true);
  });
  await check('empty history and queue do not assert prior send was not accepted', async f => {
    f.state.records = []; f.queue(async () => []); await f.submit(); await flush();
    assert.match(f.box.text(), /不能证明此前未发送/); assert.equal(f.calls.length, 0);
  });
  await check('failed dispatch retains draft and does not re-gate same-page retry', async f => {
    await f.review(); const text = f.refs.input.value, upload = f.state.uploads[0];
    f.sendResult(async () => { throw Error('lost reply'); }); await f.submit();
    assert.equal(f.refs.input.value, text); assert.equal(f.state.uploads[0], upload);
    f.sendResult(async () => {}); await f.submit(); assert.equal(f.calls.length, 2); assert.equal(f.boxes.length, 1);
  });
  await check('another conversation on same page still needs its first review', async f => {
    await f.review(); await f.submit(); f.state.sessionId = 'B'; f.state.contextVersion++;
    f.refs.input.value = 'Different conversation'; await f.submit(); assert.equal(f.calls.length, 1); assert.equal(f.boxes.length, 2);
  });
  for (const mode of ['confirmed empty', 'inferred id', 'lost create receipt', 'populated history', 'older history', 'queued', 'unread queue', 'late context']) {
    await check('new-session exemption: ' + mode, async f => {
      f.state.records = []; f.queue(async () => []);
      if (mode === 'populated history') f.state.records.push({ role: 'user', text: 'Other sender' });
      if (mode === 'older history') f.state.hasMore = true;
      if (mode === 'queued') f.queue(async () => [{ text: 'Other sender' }]);
      if (mode === 'unread queue') f.queue(async () => { throw Error('fixture'); });
      f.ui.allowNewEmptySessionSend('p', 'A', mode === 'inferred id' ? '' : 'A', mode === 'lost create receipt' ? Error('lost') : null);
      if (mode === 'late context') f.state.contextVersion++;
      await flush(); await f.submit(); await flush();
      assert.equal(f.calls.length, mode === 'confirmed empty' ? 1 : 0);
    });
  }
  assert.match(source, /if \(state.connection !== value\).*invalidateSendReview/);
  assert.match(section('    function resetSessionExtras(', '    refs.retry.onclick'), /invalidateSendReview/);
  assert.match(source, /listen\(refs.input, 'input', function \(\) \{ invalidateSendReview/);
  const translations = fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite-lang.js'), 'utf8');
  assert.ok(translations.includes('may execute twice')); assert.ok(translations.includes('podría ejecutarse dos veces'));
  console.log(`${checks} isolated production-UI send-review checks passed. No real browser, DSH, phone or public tunnel used.`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
