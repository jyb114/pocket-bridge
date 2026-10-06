'use strict';

// DSH runs independently. Gateway restart never owns or stops its process.
// Preserve one scoped restart/shutdown transaction and await the restart
// helper's actual spawn before exiting; no native desktop adapters are loaded.
function createGatewayLifecycle({ spawnRestart, exit, onState = () => {} } = {}) {
  if (typeof spawnRestart !== 'function' || typeof exit !== 'function' || typeof onState !== 'function') {
    throw new TypeError('Invalid gateway lifecycle dependencies.');
  }
  let phase = 'running', kind = null, completion = null, failure = null;
  function publish(next, code = null) {
    phase = next; failure = code;
    try { onState({ phase, kind, code }); } catch (_) { /* Logging cannot authorize exit. */ }
  }
  function begin(nextKind, detail) {
    if (phase !== 'running') return kind === nextKind && phase !== 'failed';
    kind = nextKind; publish('draining');
    completion = Promise.resolve().then(async () => {
      try {
        if (kind === 'restart') {
          publish('restarting');
          try { await spawnRestart(detail); } catch (_) { throw Error('restart-helper-failed'); }
        }
        await exit(0); publish('closed');
        return { closed: true, restartHelperStarted: kind === 'restart' };
      } catch (error) {
        const code = error?.message === 'restart-helper-failed' ? error.message : 'gateway-close-failed';
        publish('failed', code); return { closed: false, code };
      }
    });
    return true;
  }
  return Object.freeze({
    scheduleRestart(reason, options = {}) { return begin('restart', { reason, notifyAddress: options?.notifyAddress === true }); },
    scheduleShutdown() { return begin('shutdown', null); },
    completion() { return completion; }, status() { return { phase, kind, code: failure }; }
  });
}
module.exports = { createGatewayLifecycle };
