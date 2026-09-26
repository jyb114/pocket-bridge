'use strict';

// Deterministic replay of the real detach timer calling the real lock service.
// The RPC and timers are fakes; no running gateway, Codex, or process is touched.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractFunction } = require('./page-source.js');
const { createLockService } = require('./codex-lock.js');

const src = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const THREAD = '019fe0dd-83db-7881-affb-77f675c36bb9';
let passed = 0, failed = 0;
function check(label, condition, details) {
  if (condition) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (details ? ' → ' + details : '')); }
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function scenario(options = {}) {
  const listed = deferred();
  const unsubscribe = deferred();
  const timers = [];
  const rpc = [];
  const stopped = [];
  const lock = createLockService('/isolated', {
    port: () => 18790,
    rpcFor: () => async (method, params) => {
      rpc.push({ method, params });
      if (method === 'thread/loaded/list') return listed.promise;
      if (method === 'thread/unsubscribe' && options.deferUnsubscribe) return unsubscribe.promise;
      return {};
    },
    targetsFor: () => ({ managedPid: () => 4242,
      stop: async () => { stopped.push('own service'); return { ok: true }; },
      stopDesktop: async () => { stopped.push('desktop'); return { ok: true }; } })
  });
  const box = {
    codexLock: lock,
    codexPhoneClients: 0,
    codexReleaseTimer: null,
    CODEX_RELEASE_GRACE_MS: 60000,
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {}, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cancelled = true; },
    log() {}, Math
  };
  vm.createContext(box);
  vm.runInContext('let codexPhoneClients=0; let codexReleaseTimer=null; let codexPhoneGeneration=0; let codexHandbackUnsubscribe=null; const CODEX_RELEASE_GRACE_MS=60000;', box);
  for (const name of ['codexPhoneAttached', 'codexPhoneDetached', 'codexPhoneEntering']) {
    const fn = extractFunction(src, name);
    if (!fn) throw new Error('Cannot extract ' + name);
    vm.runInContext(name === 'codexPhoneEntering' ? 'async ' + fn : fn, box);
  }
  return { box, timers, listed, unsubscribe, rpc, stopped };
}

(async () => {
  const proxyStart = src.indexOf('async function proxyCodexWs(');
  const gateAt = src.indexOf('await codexPhoneEntering(socket)', proxyStart);
  const connectAt = src.indexOf('portAlive(port', proxyStart);
  check('real WS entry waits at the handback gate before connecting upstream',
    proxyStart >= 0 && gateAt > proxyStart && connectAt > gateAt);
  console.log('\n[1] New phone attaches while the old no-phone timer awaits enumeration');
  {
    const h = scenario();
    h.box.codexPhoneDetached();
    check('zero clients schedules a timer', h.timers.length === 1);
    const pending = h.timers[0].fn();
    await Promise.resolve();
    h.box.codexPhoneAttached();
    h.listed.resolve({ data: [THREAD] });
    await pending;
    check('stale handback never unsubscribes the newly attached phone thread',
      !h.rpc.some((x) => x.method === 'thread/unsubscribe'), JSON.stringify(h.rpc));
    check('stale handback never stops either service', h.stopped.length === 0, JSON.stringify(h.stopped));
  }
  console.log('\n[2] Without reconnect, the old phone releases its loaded thread');
  {
    const h = scenario();
    h.box.codexPhoneDetached();
    const pending = h.timers[0].fn();
    h.listed.resolve({ data: [THREAD] });
    await pending;
    check('genuinely idle handback still unsubscribes loaded thread',
      h.rpc.filter((x) => x.method === 'thread/unsubscribe' && x.params.threadId === THREAD).length === 1,
      JSON.stringify(h.rpc));
    check('idle handback keeps the app-server and desktop running', h.stopped.length === 0);
  }
  console.log('\n[3] New connection waits for an unsubscribe already sent to the server');
  {
    const other = '02a098d4-f36d-75e2-ab16-0cd6ffbdd72f';
    const h = scenario({ deferUnsubscribe: true });
    h.box.codexPhoneDetached();
    const handback = h.timers[0].fn();
    h.listed.resolve({ data: [THREAD, other] });
    await flush();
    check('the old cleanup has one unsubscribe in flight',
      h.rpc.filter((x) => x.method === 'thread/unsubscribe').length === 1, JSON.stringify(h.rpc));
    const socket = { destroyed: false, once(_event, callback) { this.onClose = callback; } };
    let entered = false;
    const entering = h.box.codexPhoneEntering(socket).then(() => { entered = true; });
    await flush();
    check('new phone cannot enter before the in-flight unsubscribe completes', !entered);
    h.unsubscribe.resolve({});
    await Promise.all([entering, handback]);
    check('new phone enters after the old unsubscribe finishes', entered);
    check('reconnection cancels every later unsubscribe in the old batch',
      h.rpc.filter((x) => x.method === 'thread/unsubscribe').length === 1, JSON.stringify(h.rpc));
    check('neither owned service nor desktop was stopped', h.stopped.length === 0);
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
