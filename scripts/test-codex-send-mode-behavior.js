'use strict';

// Run the actual footer/send/confirm/steer/queue functions with a small fake DOM.
// No gateway, account, live thread, or phone is touched.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFunction } = require('./page-source.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'codex.html'), 'utf8');
let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(options = {}) {
  const threadA = { id: 'thread-A' };
  const threadB = { id: 'thread-B' };
  const confirm = deferred();
  const enqueue = deferred();
  const rpc = [];
  const notices = [];
  const sent = [];
  const select = {
    value: options.mode || 'immediate', style: {},
    querySelector() { return { disabled: false, title: '' }; }
  };
  const input = { value: 'A message', style: {} };
  const sendButton = { disabled: false, textContent: '', style: {}, setAttribute() {} };
  const row = { querySelector() { return null; }, insertBefore() {} };
  const footer = { style: {}, querySelector() { return row; } };
  const elements = { footer, 'send-mode': select, send: sendButton, input };
  const state = {
    ready: true, view: 'thread', thread: threadA, running: false,
    sending: false, turnId: null, pick: {}, resumed: true
  };
  const task = { kind: 'checking' };
  const box = {
    state, task, window: {}, document: { createElement() { return { style: {} }; } },
    $: (id) => elements[id],
    t: (text) => text,
    toast: (message) => notices.push(message),
    renderTaskStatus() {}, renderAttachments() {}, renderQueue() {}, updateLockHint() {},
    draftAttachments() { return []; },
    refreshObservedThread() {},
    stopTurn() {},
    attachmentInput(text) { return [{ type: 'text', text }]; },
    attachmentLabel(text) { return text; },
    attachmentSent(tid, attachments) { sent.push({ tid, attachments }); },
    setTask(kind) { task.kind = kind; },
    addLocalUser() {}, addError() {},
    sendModePref() { return select.value; },
    crypto: { randomUUID() { return 'draft-id'; } },
    queueDraft: null,
    queueRequest(payload) { rpc.push({ method: 'queue', payload }); return enqueue.promise; },
    call(method, payload) {
      rpc.push({ method, payload });
      if (method === 'thread/turns/list') return confirm.promise;
      if (method === 'turn/steer') return Promise.resolve({});
      throw new Error('Unexpected RPC ' + method);
    },
    Promise, Array, Object, JSON, Date, Math, Error
  };
  vm.createContext(box);
  for (const name of ['queueOnly', 'enqueueDraft', 'renderFooter', 'send',
    'confirmRunningTurn', 'sendWhenUncertain', 'steerTurn']) {
    const fn = extractFunction(src, name);
    if (!fn) throw new Error('Missing function ' + name);
    vm.runInContext(fn, box);
  }
  // Mirrors the page's $('send').onclick=send binding and disabled button behavior.
  sendButton.onclick = box.send;
  sendButton.click = function () { if (!this.disabled) this.onclick(); };
  return { box, state, task, threadA, threadB, confirm, enqueue, rpc, notices,
    select, input, sendButton };
}

(async () => {
  console.log('\n[1] The immediate choice remains actionable while the task status is uncertain');
  {
    const h = harness();
    h.box.renderFooter();
    check('renderFooter enables Send for immediate confirmation', h.sendButton.disabled === false,
      'disabled=' + h.sendButton.disabled);
    check('the selected mode stays immediate', h.select.value === 'immediate');
    h.sendButton.click();
    check('a real button click starts one confirmation',
      h.rpc.filter((r) => r.method === 'thread/turns/list').length === 1,
      JSON.stringify(h.rpc));
  }

  console.log('\n[2] A pending confirmation cannot redirect a message into another thread');
  {
    const h = harness();
    h.box.send();
    h.state.thread = h.threadB;
    h.confirm.resolve({ data: [{ id: 'turn-A', status: 'inProgress' }] });
    await flush();
    check('no steer or enqueue targets the newly opened thread',
      !h.rpc.some((r) => (r.method === 'turn/steer' || r.method === 'queue') &&
        r.payload.threadId === h.threadB.id), JSON.stringify(h.rpc));
  }
  {
    const h = harness();
    h.box.send();
    h.state.thread = h.threadB;
    h.confirm.resolve({ data: [] });
    await flush();
    check('switching threads before fallback does not queue the captured draft elsewhere',
      !h.rpc.some((r) => r.method === 'queue'), JSON.stringify(h.rpc));
    check('switching threads releases the confirmation lock', h.state.sending === false);
  }

  console.log('\n[3] A failed fallback is not announced as saved');
  {
    const h = harness();
    h.box.send();
    h.confirm.resolve({ data: [] });
    await flush();
    check('before enqueue resolves, no success toast appears',
      !h.notices.some((n) => /已按排队保存/.test(n)), JSON.stringify(h.notices));
    h.enqueue.reject(new Error('disk unavailable'));
    await flush();
    check('after enqueue fails, no success toast appears',
      !h.notices.some((n) => /已按排队保存/.test(n)), JSON.stringify(h.notices));
    check('failure says draft was retained',
      h.notices.some((n) => /文字和附件已保留/.test(n)), JSON.stringify(h.notices));
  }
  {
    const h = harness();
    h.box.send();
    h.confirm.resolve({ data: [] });
    await flush();
    h.enqueue.resolve({});
    await flush();
    check('successful fallback announces saved only after enqueue resolves',
      h.notices.filter((n) => /已按排队保存/.test(n)).length === 1,
      JSON.stringify(h.notices));
    check('successful fallback targets the original thread',
      h.rpc.some((r) => r.method === 'queue' && r.payload.threadId === h.threadA.id),
      JSON.stringify(h.rpc));
  }

  console.log('\n[4] A second tap during confirmation cannot duplicate the dispatch');
  {
    const h = harness();
    h.box.send();
    h.box.send();
    check('only one confirm RPC is in flight',
      h.rpc.filter((r) => r.method === 'thread/turns/list').length === 1, JSON.stringify(h.rpc));
    h.confirm.resolve({ data: [{ id: 'turn-A', status: 'inProgress' }] });
    await flush();
    check('only one steer RPC is issued',
      h.rpc.filter((r) => r.method === 'turn/steer').length === 1, JSON.stringify(h.rpc));
  }

  console.log('\n[5] Queue stays a separate deliberate choice');
  {
    const h = harness({ mode: 'queue' });
    h.box.renderFooter();
    h.sendButton.click();
    check('queue mode uses enqueue without a confirmation RPC',
      h.rpc.filter((r) => r.method === 'queue').length === 1 &&
      !h.rpc.some((r) => r.method === 'thread/turns/list'), JSON.stringify(h.rpc));
  }

  console.log('\n[6] Missing turn ID follows the same safe fallback');
  {
    const h = harness();
    h.task.kind = 'running';
    h.state.running = true;
    h.box.steerTurn('A message', h.input, []);
    h.confirm.resolve({ data: [] });
    await flush();
    check('a stale running state with no confirmed turn can still save a deferred queue entry',
      h.rpc.some((r) => r.method === 'queue' && r.payload.threadId === h.threadA.id),
      JSON.stringify(h.rpc));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((err) => { console.error(err); process.exitCode = 1; });
