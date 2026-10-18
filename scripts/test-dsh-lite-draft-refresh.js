'use strict';

// Offline state-transition regression for the real UI functions. Rendering
// and transport are stubbed; test-dsh-lite-ui.js covers the actual mobile DOM
// with pointer/keyboard input. No browser, DSH process, or network is used here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite-ui.js'), 'utf8');
function section(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, 'UI function boundaries must remain identifiable');
  return source.slice(begin, finish);
}

function fixture() {
  const noop = () => {};
  const firstReceipt = { receiptId: 'receipt-s1', file: { name: 'one.txt' } };
  const state = {
    projectId: 'p1', sessionId: 's1', connection: 'connected', connecting: 0,
    drafts: new Map(), uploads: [firstReceipt], sessionLoad: 0, projectLoad: 0,
    filesLoad: 0, interactions: new Map(), contextVersion: 0
  };
  const refs = {
    input: { value: 'Unsent original' }, filesModal: {},
    projectsToggle: { setAttribute: noop }
  };
  let fail = false, hold = false, release = null, sent = 0;
  const adapter = {
    disconnect: async () => {}, connect: async () => {},
    listProjects: async () => [{ id: 'p1' }, { id: 'p2' }],
    listSessions: async projectId => {
      if (hold) {
        hold = false;
        await new Promise(resolve => { release = resolve; });
      }
      if (fail) { fail = false; throw new Error('Fixture list unavailable'); }
      return projectId === 'p1' ? [{ id: 's1' }, { id: 's2' }] : [{ id: 's3' }];
    },
    loadSession: async () => ({ records: [] }),
    sendMessage: async () => { sent++; }
  };
  const context = {
    state, refs, adapter, app: { dataset: {} },
    document: { body: { classList: { add: noop } } },
    safeId: value => String(value || ''), remember: noop, t: value => value,
    safeError: (_error, fallback) => fallback,
    reconcilePendingCreate: () => false, restoreSessionIfPossible: () => false,
    setStatus: value => { state.connection = value; }
  };
  for (const name of [
    'clearDownloadUrls', 'resetSessionExtras', 'renderUploads', 'renderProjects',
    'renderSessions', 'renderTitle', 'renderRecords', 'renderInteractions',
    'renderControls', 'clearError', 'renderEmpty', 'showError', 'mergeRecords',
    'refreshQueue', 'refreshGoal', 'refreshSelection', 'closeSettingsMenu', 'handleEvent'
  ]) context[name] = noop;
  vm.createContext(context);
  vm.runInContext(
    section('    function draftKey(', '    function resetSessionExtras(') +
    section('    function stateAfterProjectLoad(', '    async function createSession('), context);
  return {
    context, state, refs, firstReceipt,
    failNextList() { fail = true; },
    holdNextList() { hold = true; },
    releaseList() { assert.equal(typeof release, 'function'); release(); },
    sentCount() { return sent; }
  };
}

async function run() {
  const f = fixture();
  const { context: ui, state, refs, firstReceipt } = f;
  function expectDraft(text, receipt, message) {
    assert.equal(refs.input.value, text, message + ': text');
    assert.equal(state.uploads.length, receipt ? 1 : 0, message + ': attachment count');
    if (receipt) assert.equal(state.uploads[0], receipt, message + ': exact uploaded receipt');
    assert.equal(f.sentCount(), 0, 'refresh and draft restoration must never send a message');
  }

  await ui.connect();
  await Promise.resolve();
  expectDraft('Unsent original', firstReceipt, 'reconnect');
  await ui.selectProject('p1');
  expectDraft('Unsent original', firstReceipt, 'same-project reselection');

  f.holdNextList();
  const pending = ui.selectProject('p1');
  expectDraft('Unsent original', firstReceipt, 'while the list is pending');
  refs.input.value = 'Typed during the list read';
  f.releaseList();
  await pending;
  expectDraft('Typed during the list read', firstReceipt, 'list completion after newer typing');

  f.failNextList();
  await ui.selectProject('p1');
  expectDraft('Typed during the list read', firstReceipt, 'list failure');
  refs.input.value = 'Edited after list failure';
  await ui.selectProject('p1');
  expectDraft('Edited after list failure', firstReceipt, 'retry after list failure');

  await ui.selectSession('s2');
  expectDraft('', null, 'another session starts empty');
  const secondReceipt = { receiptId: 'receipt-s2', file: { name: 'two.txt' } };
  refs.input.value = 'Second chat draft'; state.uploads = [secondReceipt];
  await ui.selectSession('s1');
  expectDraft('Edited after list failure', firstReceipt, 'original session restored');

  await ui.selectProject('p2');
  expectDraft('', null, 'another project starts empty');
  await ui.selectSession('s3');
  const otherReceipt = { receiptId: 'receipt-s3', file: { name: 'three.txt' } };
  refs.input.value = 'Other project draft'; state.uploads = [otherReceipt];
  await ui.selectProject('p1');
  expectDraft('', null, 'returning project waits for a session choice');
  await ui.selectSession('s1');
  expectDraft('Edited after list failure', firstReceipt, 'original project and session restored');
  await ui.selectSession('s2');
  expectDraft('Second chat draft', secondReceipt, 'unrelated session draft preserved');
  await ui.selectProject('p2');
  await ui.selectSession('s3');
  expectDraft('Other project draft', otherReceipt, 'unrelated project draft preserved');
  console.log('DSH draft refresh checks passed (reconnect / reselect / pending edits / retry / exact receipts / isolation / no sends)');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
