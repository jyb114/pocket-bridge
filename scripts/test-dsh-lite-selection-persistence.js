'use strict';

// Run the real selection functions against owned synthetic state/storage.
// No browser profile, runtime, network, credentials or project files are read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./page-source.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'pwa/dsh-lite-ui.js'), 'utf8');
assert.match(source, /async function selectProject\(id\)/);
const functions = ['persistSelection', 'scheduleSessionRestore', 'restoreSessionIfPossible', 'selectProject']
  .map(name => (name === 'selectProject' ? 'async ' : '') + extractFunction(source, name)).join('\n');
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
function fixture(changes = {}) {
  const stored = new Map([['project', 'project-a'], ['session', 'saved-session']]);
  const state = Object.assign({ projectId: 'project-a', sessionId: '', restoreSession: 'saved-session',
    sessions: [], records: [], projectLoad: 0, sessionLoad: 0, filesLoad: 0, interactions: new Map() }, changes);
  const selected = []; let list = async () => [];
  const context = vm.createContext({
    state, refs: { filesModal: { hidden: false } },
    safeId: value => typeof value === 'string' ? value : '',
    recall: key => stored.get(key) || '',
    remember(key, value) { if (value) stored.set(key, String(value)); else stored.delete(key); },
    selectSession(id, reason) { selected.push({ id, reason }); },
    adapter: { listSessions(id) { return list(id); } },
    clearDownloadUrls() {}, saveCurrentDraft() {}, restoreDraft() {}, resetSessionExtras() {},
    renderProjects() {}, renderSessions() {}, renderTitle() {}, renderRecords() {},
    renderInteractions() {}, renderControls() {}, clearError() {},
    reconcilePendingCreate() { return false; }, stateAfterProjectLoad() {},
    safeError() { return 'synthetic list failure'; }, t(value) { return value; }, showError() {}
  });
  vm.runInContext(functions, context, { filename: 'actual-lite-selection-functions.js' });
  return { state, stored, selected,
    setList(fn) { list = fn; },
    persist() { vm.runInContext('persistSelection()', context); },
    schedule() { vm.runInContext('scheduleSessionRestore()', context); },
    restore() { return vm.runInContext('restoreSessionIfPossible()', context); },
    async project(id) {
      context.__project = id;
      const operation = vm.runInContext('selectProject(__project)', context);
      delete context.__project;
      return operation;
    }
  };
}
(async () => {
  await test('hide during initialization retains the pending session for the next page', () => {
    const f = fixture(); f.persist();
    assert.equal(f.stored.get('session'), 'saved-session');
    const next = fixture({ restoreSession: '' }); next.stored.set('session', f.stored.get('session')); next.schedule();
    next.state.sessions = [{ id: 'saved-session' }]; assert.equal(next.restore(), true);
    assert.equal(next.selected.length, 1); assert.equal(next.selected[0].reason, 'restore');
  });
  await test('an active session wins over an older pending restore', () => {
    const f = fixture({ sessionId: 'new-session' }); f.persist(); assert.equal(f.stored.get('session'), 'new-session');
  });
  await test('an explicitly empty choice without a pending restore clears saved session state', () => {
    const f = fixture({ restoreSession: '' }); f.persist(); assert.equal(f.stored.has('session'), false);
  });
  await test('a pending ID without its project is not retained', () => {
    const f = fixture({ projectId: '' }); f.persist();
    assert.equal(f.stored.has('project'), false); assert.equal(f.stored.has('session'), false);
  });
  await test('switching projects invalidates the old pending restore before the new list resolves', async () => {
    const f = fixture(); let release;
    f.setList(() => new Promise(resolve => { release = resolve; }));
    const operation = f.project('project-b');
    assert.equal(f.state.projectId, 'project-b'); assert.equal(f.state.restoreSession, '');
    f.persist(); assert.equal(f.stored.get('project'), 'project-b'); assert.equal(f.stored.has('session'), false);
    release([{ id: 'saved-session' }]); await operation;
    assert.equal(f.restore(), false); assert.equal(f.selected.length, 0, 'the same ID under another project cannot resurrect an old choice');
  });
  await test('same-project refresh keeps the pending restore until list validation', async () => {
    const f = fixture(); await f.project('project-a');
    assert.equal(f.state.restoreSession, 'saved-session'); f.persist();
    assert.equal(f.stored.get('session'), 'saved-session');
  });
  await test('a missing session is still discarded after authoritative validation', () => {
    const f = fixture(); assert.equal(f.restore(), false);
    assert.equal(f.state.restoreSession, ''); assert.equal(f.stored.has('session'), false);
    f.persist(); assert.equal(f.stored.has('session'), false);
  });
  await test('a validated session restores once and cannot override a later user choice', () => {
    const f = fixture({ sessions: [{ id: 'saved-session' }] }); assert.equal(f.restore(), true);
    assert.equal(f.state.restoreSession, ''); f.state.sessionId = 'user-selected';
    assert.equal(f.restore(), false); f.persist(); assert.equal(f.stored.get('session'), 'user-selected');
    assert.equal(f.selected.length, 1);
  });
  await test('an inaccessible list preserves the pending choice for an explicit retry', async () => {
    const f = fixture(); f.setList(async () => { throw new Error('synthetic offline'); });
    assert.equal(await f.project('project-a'), false); f.persist();
    assert.equal(f.stored.get('session'), 'saved-session'); assert.equal(f.state.restoreSession, 'saved-session');
  });
  console.log('PASS: ' + checks + ' actual selection persistence checks');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
