'use strict';

// Fixed upstream reads remain bound to the runtime observed by their handler.
// Legacy event bindings keep their existing, stricter protocol-specific guard.
const legacyRuntimeIdentity = require('./dsh-legacy-interactions.js').runtimeIdentity;
function runtimeIdentity(runtime) {
  if (runtime && runtime.profile === 'legacy-events') return legacyRuntimeIdentity(runtime);
  if (!runtime || runtime.running !== true || runtime.profile !== 'remote-mux' ||
    !Number.isSafeInteger(runtime.pid) || runtime.pid < 1 ||
    !Number.isSafeInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535)
    throw Object.assign(new Error('dsh-runtime-unavailable'), { status: 503, code: 'dsh-runtime-unavailable' });
  return JSON.stringify([runtime.pid, runtime.port, runtime.profile, runtime.version || null]);
}
module.exports = { runtimeIdentity };
