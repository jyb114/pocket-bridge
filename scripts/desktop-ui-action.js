'use strict';

// One Node-process lease shared by the Codex and Dot adapters. Cross-process
// exclusion belongs to the native helper's Windows mutex, not this module.
const ACTION_LABELS = new Set(['codex-send', 'codex-inspect', 'dot-read', 'dot-send']);

class DesktopActionError extends Error {
  constructor(code) {
    const busy = code === 'desktop-busy';
    const stopping = code === 'desktop-stopping';
    super(stopping ? 'Desktop operations are stopped while the gateway shuts down.' : busy ? 'Another desktop operation is still running. Retry after it finishes.' :
      'The desktop operation is invalid.');
    this.name = 'DesktopActionError';
    this.code = stopping ? 'desktop-stopping' : busy ? 'desktop-busy' : 'invalid-desktop-action';
    this.status = stopping ? 503 : busy ? 409 : 400;
    this.submitted = false;
  }
}

function createDesktopActionScheduler() {
  let busy = false, stopping = false, current = null, drainPromise = null;

  async function runDesktopAction(label, asyncOperation) {
    // Validate before the lease check without coercing or retaining arbitrary
    // input. Neither action data nor labels are logged or copied into errors.
    if (typeof label !== 'string' || !ACTION_LABELS.has(label) || typeof asyncOperation !== 'function') {
      throw new DesktopActionError('invalid-desktop-action');
    }
    if (stopping) throw new DesktopActionError('desktop-stopping');
    if (busy) throw new DesktopActionError('desktop-busy');
    busy = true;
    let completed;
    current = new Promise(resolve => { completed = resolve; });
    try {
      // No queue or timeout releases this lease. The caller must return a
      // promise covering the native child's full lifetime, including cleanup.
      return await asyncOperation();
    } finally {
      busy = false;
      current = null;
      completed();
    }
  }

  function stop() { stopping = true; return { stopped: true }; }
  function drain() {
    stop();
    if (!drainPromise) drainPromise = Promise.resolve(current).then(() => ({ drained: true }));
    return drainPromise;
  }
  return Object.freeze({ runDesktopAction, stop, drain,
    status() { return { stopping, busy }; } });
}

// A controlled restart is one permanent stop-admission transaction. Timing out
// never cancels an owned action, clears a lock, or schedules a later exit. An
// unexpected process crash is a different boundary: its durable owner evidence
// is retained for explicit recovery, rather than advertised as a clean close.
function createDesktopLifecycle({ scheduler, dotRuntime, codexRelay, spawnRestart, exit,
  onState = () => {}, timeoutMs = 90000 } = {}) {
  if (!scheduler || typeof scheduler.stop !== 'function' || typeof scheduler.drain !== 'function' ||
      !dotRuntime || typeof dotRuntime.stop !== 'function' || typeof dotRuntime.close !== 'function' ||
      !codexRelay || typeof codexRelay.stop !== 'function' || typeof codexRelay.drain !== 'function' ||
      typeof spawnRestart !== 'function' || typeof exit !== 'function' || typeof onState !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new TypeError('Invalid desktop shutdown dependencies.');
  }
  let phase = 'running', kind = null, completion = null, failure = null;
  function publish(next, code = null) {
    phase = next; failure = code;
    try { onState({ phase, kind, code }); } catch (_) { /* Logging cannot permit an unsafe exit. */ }
  }
  function begin(nextKind, detail) {
    if (phase !== 'running') return kind === nextKind && phase !== 'failed';
    kind = nextKind; publish('draining');
    // Stop all three independently even when one collaborator throws. No new
    // GUI callback may begin after this synchronous admission boundary.
    let stopFailed = false;
    for (const owner of [scheduler, codexRelay, dotRuntime]) {
      try { owner.stop(); } catch (_) { stopFailed = true; }
    }
    completion = Promise.resolve().then(async () => {
      let timer;
      try {
        if (stopFailed) throw Error('desktop-drain-failed');
        const dotClose = Promise.resolve().then(async () => {
          const failedDotInitialization = typeof dotRuntime.status === 'function' && dotRuntime.status()?.initialization === 'failed';
          if (!failedDotInitialization) return dotRuntime.close({ timeoutMs });
          // An incomplete provision has unresolved durable owner evidence.
          // Await any owned children, but do not call close or claim it clean.
          if (typeof dotRuntime.drain === 'function') await dotRuntime.drain();
          throw Error('desktop-drain-failed');
        });
        const drained = await Promise.race([
          Promise.allSettled([dotClose, Promise.resolve().then(() => codexRelay.drain()), Promise.resolve().then(() => scheduler.drain())]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('desktop-drain-timeout')), timeoutMs); })
        ]);
        if (drained.some(result => result.status !== 'fulfilled') ||
            drained[0].value?.closed !== true || drained[1].value?.drained !== true || drained[2].value?.drained !== true ||
            typeof dotRuntime.status === 'function' && dotRuntime.status()?.initialization === 'failed') {
          throw Error('desktop-drain-failed');
        }
        clearTimeout(timer); timer = null;
        if (kind === 'restart') {
          publish('restarting');
          try { await spawnRestart(detail); } catch (_) { throw Error('restart-helper-failed'); }
        }
        // The exit callback also owns the short HTTP-response flush delay.
        // Neither the HTTP listener nor health routing is closed during drain.
        await exit(0);
        publish('closed');
        return { closed: true, restartHelperStarted: kind === 'restart' };
      } catch (error) {
        const code = ['desktop-drain-timeout', 'restart-helper-failed'].includes(error?.message) ? error.message : 'desktop-drain-failed';
        publish('failed', code);
        return { closed: false, code };
      } finally { clearTimeout(timer); }
    });
    return true;
  }
  return Object.freeze({
    scheduleRestart(reason, options = {}) { return begin('restart', { reason, notifyAddress: options?.notifyAddress === true }); },
    scheduleShutdown() { return begin('shutdown', null); },
    completion() { return completion; },
    status() { return { phase, kind, code: failure }; }
  });
}

const scheduler = createDesktopActionScheduler();
module.exports = { runDesktopAction: scheduler.runDesktopAction, stop: scheduler.stop, drain: scheduler.drain,
  status: scheduler.status, createDesktopActionScheduler, createDesktopLifecycle, DesktopActionError };
