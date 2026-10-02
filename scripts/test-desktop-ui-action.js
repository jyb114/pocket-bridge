'use strict';
// In-memory scheduling only: no native helper, window, subprocess, file or network.
const assert = require('node:assert/strict');
const { runDesktopAction, createDesktopActionScheduler, DesktopActionError } = require('./desktop-ui-action.js');
let checks = 0;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function idleTurn() { return new Promise(resolve => setImmediate(resolve)); }
async function check(name, operation) { await operation(); checks++; console.log('PASS ' + name); }
function refusal(code, status) {
  return error => {
    assert(error instanceof DesktopActionError);
    assert.equal(error.name, 'DesktopActionError'); assert.equal(error.code, code);
    assert.equal(error.status, status); assert.equal(error.submitted, false);
    assert.equal(error.cause, undefined); assert.equal(error.label, undefined);
    assert.equal(error.message, code === 'desktop-busy' ?
      'Another desktop operation is still running. Retry after it finishes.' : 'The desktop operation is invalid.');
    return true;
  };
}
const codexAdapter = { send: operation => require('./desktop-ui-action.js').runDesktopAction('codex-send', operation) };
const dotAdapter = { read: operation => require('./desktop-ui-action.js').runDesktopAction('dot-read', operation) };

async function main() {
  await check('all four fixed labels return the actual operation result', async () => {
    for (const label of ['codex-send', 'codex-inspect', 'dot-read', 'dot-send']) {
      const result = { completed: label };
      assert.equal(await runDesktopAction(label, async () => result), result);
    }
  });

  await check('separate Codex and Dot adapters share the singleton and refuse competing work immediately', async () => {
    const gate = deferred(); let codexCalls = 0, dotCalls = 0;
    const first = codexAdapter.send(async () => { codexCalls++; await gate.promise; return 'first completed'; });
    assert.equal(codexCalls, 1);
    try {
      await assert.rejects(dotAdapter.read(async () => { dotCalls++; }), refusal('desktop-busy', 409));
      assert.equal(dotCalls, 0);
    } finally { gate.resolve(); }
    assert.equal(await first, 'first completed');
    assert.equal(await dotAdapter.read(async () => { dotCalls++; return 'fresh request'; }), 'fresh request');
    assert.equal(dotCalls, 1);
  });

  await check('a held Dot read also prevents a Codex send callback', async () => {
    const gate = deferred(); let attemptedSends = 0;
    const first = dotAdapter.read(() => gate.promise);
    try {
      await assert.rejects(codexAdapter.send(async () => { attemptedSends++; }), refusal('desktop-busy', 409));
      assert.equal(attemptedSends, 0);
    } finally { gate.resolve(); }
    await first;
  });

  await check('polling refusals never enqueue callbacks to run after the current action', async () => {
    const gate = deferred(); let refusedCallbacks = 0;
    const first = runDesktopAction('dot-send', () => gate.promise);
    try {
      await Promise.all(Array.from({ length: 40 }, () => assert.rejects(
        runDesktopAction('codex-inspect', async () => { refusedCallbacks++; }), refusal('desktop-busy', 409))));
      assert.equal(refusedCallbacks, 0);
    } finally { gate.resolve(); }
    await first; await idleTurn();
    assert.equal(refusedCallbacks, 0);
    await runDesktopAction('codex-inspect', async () => { refusedCallbacks++; });
    assert.equal(refusedCallbacks, 1);
  });

  await check('a synchronous callback error releases the lease without replacing the error', async () => {
    const original = new Error('fixture operation failed');
    await assert.rejects(runDesktopAction('codex-send', () => { throw original; }), error => error === original);
    assert.equal(await runDesktopAction('dot-read', async () => 'recovered'), 'recovered');
  });

  await check('a pending operation rejection releases the lease only when the operation actually rejects', async () => {
    const gate = deferred(), original = new Error('fixture asynchronous failure'); let blockedCalls = 0;
    const first = runDesktopAction('dot-send', () => gate.promise);
    const firstFailure = assert.rejects(first, error => error === original);
    try {
      await assert.rejects(runDesktopAction('codex-send', async () => { blockedCalls++; }), refusal('desktop-busy', 409));
      assert.equal(blockedCalls, 0);
    } finally { gate.reject(original); }
    await firstFailure;
    assert.equal(await runDesktopAction('codex-send', async () => 'after rejection'), 'after rejection');
  });

  await check('an external caller timeout does not release a still-pending native operation', async () => {
    const gate = deferred(); let completed = false, competingCalls = 0;
    const first = runDesktopAction('codex-send', async () => { await gate.promise; completed = true; return 'settled'; });
    try {
      const timeout = new Promise(resolve => setTimeout(() => resolve('caller timeout'), 0));
      assert.equal(await Promise.race([first, timeout]), 'caller timeout');
      assert.equal(completed, false);
      await assert.rejects(runDesktopAction('dot-read', async () => { competingCalls++; }), refusal('desktop-busy', 409));
      await idleTurn();
      await assert.rejects(runDesktopAction('dot-send', async () => { competingCalls++; }), refusal('desktop-busy', 409));
      assert.equal(competingCalls, 0);
    } finally { gate.resolve(); }
    assert.equal(await first, 'settled'); assert.equal(completed, true);
    assert.equal(await runDesktopAction('dot-read', async () => 'after actual settlement'), 'after actual settlement');
  });

  await check('invalid labels are rejected before the busy check without coercion or callback execution', async () => {
    const gate = deferred(); let callbacks = 0, coerced = 0;
    const first = runDesktopAction('codex-send', () => gate.promise);
    const privateLabel = 'PRIVATE FIXTURE INPUT';
    try {
      for (const label of ['', 'Codex-send', 'codex-send\n', privateLabel, new String('dot-read'),
        { toString() { coerced++; return 'dot-read'; } }, null, undefined, Symbol('fixture'), 12]) {
        await assert.rejects(runDesktopAction(label, async () => { callbacks++; }), error => {
          refusal('invalid-desktop-action', 400)(error);
          assert(!JSON.stringify(error).includes(privateLabel)); assert(!error.message.includes(privateLabel));
          return true;
        });
      }
      assert.equal(callbacks, 0); assert.equal(coerced, 0);
      await assert.rejects(runDesktopAction('dot-read', async () => { callbacks++; }), refusal('desktop-busy', 409));
      assert.equal(callbacks, 0);
    } finally { gate.resolve(); }
    await first;
  });

  await check('invalid callbacks are rejected before busy and do not displace the current operation', async () => {
    const gate = deferred();
    const first = runDesktopAction('dot-read', () => gate.promise);
    try {
      for (const operation of [null, undefined, false, 'fixture', {}, Promise.resolve('not a callback')]) {
        await assert.rejects(runDesktopAction('codex-send', operation), refusal('invalid-desktop-action', 400));
      }
      await assert.rejects(runDesktopAction('codex-inspect', async () => {}), refusal('desktop-busy', 409));
    } finally { gate.resolve(); }
    await first;
    assert.equal(await runDesktopAction('codex-inspect', async () => 'still usable'), 'still usable');
  });

  await check('validation failures when idle do not consume the lease', async () => {
    await assert.rejects(runDesktopAction('unknown', async () => assert.fail('must not run')), refusal('invalid-desktop-action', 400));
    await assert.rejects(runDesktopAction('dot-read', null), refusal('invalid-desktop-action', 400));
    assert.equal(await runDesktopAction('dot-read', async () => 7), 7);
  });

  await check('fixture factories isolate their leases while each fixture still rejects overlapping actions', async () => {
    const one = createDesktopActionScheduler(), two = createDesktopActionScheduler(), gate = deferred();
    const first = one.runDesktopAction('codex-send', () => gate.promise);
    try {
      assert.equal(await two.runDesktopAction('dot-read', async () => 'independent fixture'), 'independent fixture');
      await assert.rejects(one.runDesktopAction('dot-read', async () => {}), refusal('desktop-busy', 409));
    } finally { gate.resolve(); }
    await first;
    assert.equal(await one.runDesktopAction('dot-read', async () => 'released'), 'released');
  });

  console.log(`Desktop UI scheduler: ${checks} in-memory concurrency checks passed; no native actions, subprocesses, files or network.`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
