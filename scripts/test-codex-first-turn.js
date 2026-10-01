'use strict';

// Regression for the responses observed on a real Codex 0.159.0 app-server:
// idle thread/read succeeds while turns/list rejects before first materialization.
// This isolated test protects the page state machine; it is not a live compatibility claim.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFunction } = require('./page-source.js');

const page = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'codex.html'), 'utf8');
const unmaterialized = 'thread t is not materialized yet; thread/turns/list is unavailable before first user message';
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('PASS ' + name); };

function harness({ status = 'idle', turnsError = unmaterialized, turns = [] } = {}) {
  const timers = [], calls = [];
  const state = { view: 'thread', thread: { id: 't' }, ready: true, resumed: true,
    resuming: false, sending: false, running: false, items: {}, order: [], releaseTimer: null,
    awaitingFirstTurn: false };
  const box = {
    state, task: { kind: 'checking', detail: '' }, document: { hidden: false },
    observerEpoch: 1, observerTimer: null, observerBusy: false, activityVersion: 0, PAGE_SIZE: 30,
    Date, Promise, t: x => x, renderFooter() {}, renderTaskStatus() {}, refreshQueue() {},
    subscribeIfAlreadyLoaded() {}, upsertItem() {}, noteActivity() {}, tidyItems() {},
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    call(method) {
      calls.push(method);
      if (method === 'thread/read') return Promise.resolve({ thread: { status: { type: status } } });
      if (method === 'thread/turns/list') return turnsError ? Promise.reject(Error(turnsError)) : Promise.resolve({ data: turns });
      if (method === 'thread/items/list') return Promise.reject(Error('thread/items/list is not supported yet'));
      if (method === 'thread/loaded/list') return Promise.resolve({ data: ['t'] });
      throw Error('Unexpected RPC: ' + method);
    },
    releaseThread() { calls.push('thread/unsubscribe'); state.resumed = false; }
  };
  vm.createContext(box);
  for (const name of ['displayThreadTitle', 'statusKind', 'beforeFirstTurn', 'syncThreadIdentity', 'setTask', 'queueOnly',
    'applyObservedStatus', 'refreshObservedThread', 'scheduleRelease']) {
    vm.runInContext(extractFunction(page, name), box);
  }
  return { box, state, calls, timers };
}

async function observe(h) {
  h.box.refreshObservedThread();
  await new Promise(resolve => setImmediate(resolve));
}

(async () => {
  const fresh = harness();
  await observe(fresh);
  check('idle metadata plus the exact first-message response enables Send',
    fresh.box.task.kind === 'idle' && !fresh.box.queueOnly());
  check('fresh conversation is marked as awaiting its first turn', fresh.state.awaitingFirstTurn);
  check('empty history is not shown as a progress synchronization failure',
    !fresh.box.task.detail.includes('暂未同步'));
  fresh.box.scheduleRelease();
  check('writing the first message is not subject to a destructive idle timer',
    fresh.state.releaseTimer === null && !fresh.timers.some(t => t.delay === 30_000));

  const unavailable = harness({ turnsError: 'request timeout' });
  await observe(unavailable);
  check('generic pagination failure remains unknown and cannot send',
    unavailable.box.task.kind === 'unknown' && unavailable.box.queueOnly());
  const unloaded = harness({ status: 'notLoaded' });
  await observe(unloaded);
  check('a thread outside this execution service is never inferred to be idle',
    unloaded.box.task.kind === 'unknown' && !unloaded.state.awaitingFirstTurn);
  const active = harness({ status: 'active' });
  await observe(active);
  check('authoritative active status remains running despite unavailable history',
    active.box.task.kind === 'running' && active.state.running && !active.state.awaitingFirstTurn);

  const persisted = harness({ turnsError: '', turns: [{ id: 'turn', status: 'completed' }] });
  persisted.state.awaitingFirstTurn = true;
  await observe(persisted);
  check('a materialized turn exits the first-message state',
    !persisted.state.awaitingFirstTurn && persisted.box.task.kind === 'completed');
  check('ordinary idle handback resumes after materialization',
    persisted.state.releaseTimer && persisted.state.releaseTimer.delay === 30_000);
  persisted.state.releaseTimer.fn();
  check('the ordinary handback still releases only the phone subscription',
    persisted.calls.at(-1) === 'thread/unsubscribe' && !persisted.state.resumed);
  console.log(`${passed} first-turn regression checks passed`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
