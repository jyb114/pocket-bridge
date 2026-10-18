'use strict';

// Full native adapter and actual UI state/control functions, with only transport
// and DOM rendering replaced by isolated fixtures. No browser, socket, live DSH,
// credentials, prompts, or external writes are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const adapterSource = fs.readFileSync(path.join(root, 'pwa/dsh-lite-adapter.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'pwa/dsh-lite-ui.js'), 'utf8');
function section(start, end) {
  const begin = uiSource.indexOf(start), finish = uiSource.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, 'actual UI function boundaries remain identifiable');
  return uiSource.slice(begin, finish);
}
const uiFunctions =
  section('    function renderControls(', '    function currentProject(') +
  section('    function mergeRecords(', '    function clearDownloadUrls(') +
  section('    function handleEvent(', '    function scheduleSessionRestore(') +
  section('    function stateAfterProjectLoad(', '    async function createSession(') +
  section('    async function loadOlder(', '    async function stopSession(');
const flush = () => new Promise(resolve => setImmediate(resolve));
function message(seq, id, text) {
  return { type: 'event', event: { type: 'user/message', seq,
    data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] } } };
}
function olderPage(sessionId) {
  return { records: [message(9, sessionId + '-older', sessionId + ' older')], hasMore: false };
}

async function fixture() {
  const pages = [], events = [], sockets = [];
  class FakeSocket {
    constructor() {
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen(); });
    }
    send(raw) {
      const wire = JSON.parse(raw);
      if (wire.type !== 'open') return;
      let value;
      if (wire.endpoint === '$events') value = { type: 'ready', clientId: 'fixture-client' };
      if (wire.endpoint === 'workspace/follow') value = { type: 'baseline', value: { items: [
        { workspaceId: 'p', title: 'Fixture', sessionIds: ['A', 'B'] }
      ] } };
      if (wire.endpoint === 'session/follow') {
        const selected = wire.payload.args.request.address.sessionId;
        // Equal valid boundaries are deliberate: sequence validation must not
        // accidentally conceal a response being delivered to the wrong request.
        value = { type: 'snapshot', records: [message(10, selected + '-current', selected + ' current')],
          cursor: 10, hasMore: true, assistantStream: { revision: 0 } };
      }
      if (value) queueMicrotask(() => this.onmessage({ data: JSON.stringify({
        type: 'item', streamId: wire.streamId, value
      }) }));
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
  }
  const response = value => ({ ok: true, status: 200,
    json: async () => ({ result: { ok: true, value } }) });
  const runtime = {
    WebSocket: FakeSocket, Map, Promise, Uint8Array, DataView, TextEncoder, Blob,
    Event: class Event {}, setTimeout, clearTimeout,
    document: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    location: { protocol: 'https:', host: 'fixture.test' },
    crypto: { randomUUID: () => 'fixture-request' }, __dshE2eeSecret: 'fixture-only',
    DshE2EE: {
      available: () => true, prove: async () => true,
      encryptedFetch: async (_secret, _url, init) => {
        const request = JSON.parse(init.body);
        if (request.method === 'session/page') return new Promise((resolve, reject) => {
          pages.push({ sessionId: request.request.address.sessionId, request: request.request,
            resolve: value => resolve(response(value)), reject });
        });
        return response({ items: [] });
      }
    }
  };
  runtime.window = runtime;
  vm.runInNewContext(adapterSource, runtime, { filename: 'dsh-lite-adapter.js' });
  const adapter = runtime.DshLiteAdapter;
  const state = {
    projectId: 'p', sessionId: '', sessions: [], records: [], projects: [], uploads: [],
    sessionLoad: 0, projectLoad: 0, filesLoad: 0, connecting: 0,
    interactions: new Map(), hasMore: false, loadingOlder: false,
    connection: 'disconnected', disposed: false
  };
  const noop = () => {};
  const refs = {};
  for (const name of [
    'newProject', 'newSession', 'railNewProject', 'railNewSession', 'input', 'send', 'upload',
    'projectSubmit', 'browseFolder', 'filesOpen', 'stop', 'historyBar', 'loadOlder',
    'filesModal', 'projectsToggle', 'error'
  ]) refs[name] = { value: '', dataset: {}, setAttribute: noop };
  refs.error.hidden = true;
  const ui = {
    state, refs, adapter, app: { dataset: {} },
    document: { body: { classList: { add: noop } } },
    safeId: value => String(value || ''), remember: noop, t: value => value,
    safeError: (error, fallback) => error && error.userMessage || fallback,
    restoreSessionIfPossible: () => false, reconcilePendingCreate: () => false
  };
  for (const name of [
    'renderRecords', 'renderSessions', 'renderTitle', 'renderInteractions', 'renderEmpty',
    'renderProjects', 'clearDownloadUrls', 'saveCurrentDraft', 'restoreDraft',
    'resetSessionExtras', 'refreshQueue', 'refreshGoal', 'refreshSelection', 'closeSettingsMenu'
  ]) ui[name] = noop;
  // Keep actual renderControls() and its loading/disabled state transitions.
  // Its new composer sizing/history-padding hooks only measure or position
  // browser DOM; geometry belongs to test-dsh-lite-ui.js, not this race fixture.
  ui.resizeComposerInput = noop;
  ui.syncHistoryScroll = noop;
  ui.setStatus = value => { state.connection = value; ui.renderControls(); };
  ui.clearError = () => { ui.lastError = ''; refs.error.hidden = true; };
  ui.showError = (error, fallback) => {
    ui.lastError = error && error.userMessage || fallback;
    refs.error.hidden = false;
  };
  // Observe adapter events without replacing its normal callback routing.
  const connect = adapter.connect;
  adapter.connect = callback => connect(event => { events.push(event); callback(event); });
  vm.createContext(ui);
  vm.runInContext(uiFunctions, ui, { filename: 'dsh-lite-ui-extracted.js' });
  await ui.connect();
  await ui.selectSession('A');
  return { ui, state, refs, pages, events, sockets, adapter,
    async close() { adapter.disconnect(); await flush(); } };
}

function texts(f) { return Array.from(f.state.records, row => row.text); }
function assertLoading(f, message) {
  assert.equal(f.state.loadingOlder, true, message + ': state stays loading');
  assert.equal(f.refs.loadOlder.disabled, true, message + ': button stays disabled');
  assert.equal(f.refs.loadOlder.textContent, '正在加载…', message + ': loading label stays');
}
function assertIdle(f, message) {
  assert.equal(f.state.loadingOlder, false, message + ': loading state ends');
  assert.equal(f.refs.loadOlder.textContent, '加载更早内容', message + ': loading label resets');
}
function finish(page, outcome, sessionId) {
  if (outcome === 'success') page.resolve(olderPage(sessionId));
  else page.reject({ userMessage: 'Stale ' + sessionId + ' page failed' });
}

async function race(mode, outcome, order) {
  const f = await fixture();
  try {
    const oldLoad = f.ui.loadOlder();
    assert.equal(f.pages.length, 1);
    assertLoading(f, 'original request');
    const selected = mode === 'switch' ? 'B' : 'A';
    if (mode === 'switch') await f.ui.selectSession(selected);
    else { await f.ui.connect(); await flush(); }
    await oldLoad;
    assertIdle(f, 'canceled request');
    assert.equal(f.state.sessionId, selected);
    assert.deepEqual(texts(f), [selected + ' current']);
    f.ui.clearError();
    const currentLoad = f.ui.loadOlder();
    assert.equal(f.pages.length, 2);
    assert.equal(f.pages[1].sessionId, selected);
    assert.equal(f.pages[0].request.beforeSeq, f.pages[1].request.beforeSeq);
    assertLoading(f, 'replacement request');
    if (order === 'stale-first') {
      finish(f.pages[0], outcome, 'A');
      await flush();
      assert.deepEqual(texts(f), [selected + ' current'], 'old response cannot supply current history');
      assertLoading(f, 'old response cannot settle or clear replacement');
      assert.equal(f.ui.lastError, '', 'old rejection cannot fail current history');
    }
    f.pages[1].resolve(olderPage(selected));
    await currentLoad;
    assertIdle(f, 'current response');
    assert.deepEqual(texts(f), [selected + ' older', selected + ' current']);
    assert.equal(f.refs.historyBar.hidden, true, 'current hasMore=false controls history visibility');
    if (order === 'current-first') {
      const before = JSON.stringify(f.events);
      finish(f.pages[0], outcome, 'A');
      await flush();
      assert.equal(JSON.stringify(f.events), before, 'old completion emits no new snapshot');
      assert.deepEqual(texts(f), [selected + ' older', selected + ' current']);
      assertIdle(f, 'old completion after current response');
      assert.equal(f.ui.lastError, '', 'old rejection cannot create a late error banner');
    }
  } finally { await f.close(); }
}

async function canceled(outcome) {
  const f = await fixture();
  try {
    const loading = f.ui.loadOlder();
    f.adapter.disconnect();
    await loading;
    assertIdle(f, 'explicit cancellation');
    const before = JSON.stringify(f.events), records = texts(f), error = f.ui.lastError;
    finish(f.pages[0], outcome, 'A');
    await flush();
    assert.equal(JSON.stringify(f.events), before, 'canceled callback cannot emit history');
    assert.deepEqual(texts(f), records, 'canceled callback cannot change records');
    assert.equal(f.ui.lastError, error, 'canceled callback cannot replace cancellation feedback');
    assertIdle(f, 'canceled callback');
  } finally { await f.close(); }
}

async function currentFailure() {
  const f = await fixture();
  try {
    const loading = f.ui.loadOlder();
    assertLoading(f, 'current request');
    await f.ui.loadOlder();
    assert.equal(f.pages.length, 1, 'repeated UI clicks cannot create another page request');
    f.pages[0].reject({ userMessage: 'Current history unavailable' });
    await loading;
    assertIdle(f, 'current failure');
    assert.equal(f.ui.lastError, 'Current history unavailable');
    assert.equal(f.refs.loadOlder.disabled, false, 'current failure permits an explicit retry');
    const retry = f.ui.loadOlder();
    assert.equal(f.pages.length, 2);
    f.pages[1].resolve(olderPage('A'));
    await retry;
    assert.deepEqual(texts(f), ['A older', 'A current']);
    assert.equal(f.ui.lastError, '', 'successful retry clears current failure');
  } finally { await f.close(); }
}

(async () => {
  let passed = 0, failed = 0;
  async function check(name, run) {
    try { await run(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  for (const mode of ['switch', 'reconnect']) {
    for (const outcome of ['success', 'error']) {
      for (const order of ['stale-first', 'current-first']) {
        await check(mode + ' / stale ' + outcome + ' / ' + order, () => race(mode, outcome, order));
      }
    }
  }
  for (const outcome of ['success', 'error']) await check('cancel / stale ' + outcome, () => canceled(outcome));
  await check('current failure, duplicate click and retry', currentFailure);
  assert.equal(failed, 0, failed + ' pagination race scenarios failed');
  console.log('DSH pagination race: ' + passed + ' full-adapter/UI scenarios passed');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
