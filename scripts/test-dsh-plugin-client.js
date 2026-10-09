#!/usr/bin/env node
'use strict';
// Isolated client behavior regression. Real DSH installation and browser use
// are separate acceptance steps; this script never connects to the user's PC.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let registration;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dsh-plugin/client.js'), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { registration = value; } } }, URL, TextEncoder, Date
}, { filename: 'pocket-bridge-client.js' });
const react = { createElement: (...args) => args };
const client = registration.factory((name) => { assert.equal(name, 'react'); return react; });
let checks = 0;
function check(description, fn) { fn(); checks++; console.log('PASS ' + description); }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function response(body, status = 200) { return { ok: status < 400, status, async json() { return body; } }; }
function fixture(protocol = 'http:', hostname = '127.0.0.1') {
  const queue = [], requests = [], timers = new Map(), docListeners = new Map(), winListeners = new Map(); let sequence = 0, clock = Date.now();
  const document = { hidden: false, addEventListener(name, callback) { docListeners.set(name, callback); }, removeEventListener(name, callback) { if (docListeners.get(name) === callback) docListeners.delete(name); } };
  const window = { addEventListener(name, callback) { winListeners.set(name, callback); }, removeEventListener(name, callback) { if (winListeners.get(name) === callback) winListeners.delete(name); } };
  const env = { location: { protocol, hostname }, document, window, AbortController, now: () => clock,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) { requests.push({ url, options }); const next = queue.shift(); if (!next) throw new Error('No fixture response'); return typeof next === 'function' ? next(options) : next; }
  };
  const controller = client.createController(env);
  return { controller, env, queue, requests, timers,
    visible(hidden) { document.hidden = hidden; const listener = docListeners.get('visibilitychange'); if (listener) listener(); },
    leave() { const listener = winListeners.get('pagehide'); if (listener) listener(); },
    advance(ms) { clock += ms; },
    fire(delay) { const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay === delay); assert(entry, 'Expected timer with delay ' + delay); timers.delete(entry[0]); entry[1].callback(); },
    listenerCount() { return docListeners.size + winListeners.size; }
  };
}
const gateway = { bootId: 'test-boot', instanceId: 'test-instance', pid: 12345, consoleUrl: 'http://127.0.0.1:8081/console' };
const controlToken = crypto.randomBytes(32).toString('base64url');
const running = () => ({ ok: true, state: 'running', version: 'test-version', controlToken, gateway: { ...gateway }, connection: { available: true, mode: 'tunnel', encrypted: true }, runtime: { available: true, version: 'test-dsh' } });
const privateLink = () => 'https://bridge-fixture.invalid/k/' + crypto.randomBytes(18).toString('base64url') + '?target=lite#k=' + crypto.randomBytes(24).toString('base64url');
const pairing = (url, instance = gateway) => ({ ok: true, url, mode: 'tunnel', gateway: { ...instance } });

async function main() {
  check('uses the root package module ID and host React', () => assert.equal(registration.id, 'pocket-bridge'));
  check('registers an independent settings.section with no external service dependency', () => {
    let slot; client.apply({ slots: { inject(name, fn) { assert.equal(name, 'settings.section'); fn(); }, register(meta, component) { slot = { meta, component }; } } });
    assert.deepEqual(Array.from(client.inject), ['slots']); assert.equal(slot.meta.id, 'pocket-bridge'); assert.equal(slot.meta.label(), 'Pocket Bridge'); assert.equal(typeof slot.component, 'function');
  });
  check('admits only literal local HTTP(S) or the exact native DSH origin', () => {
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) assert(client.localOrigin({ protocol: 'http:', hostname }));
    for (const hostname of ['localhost.attacker.invalid', '192.168.1.2', '127.1', 'attacker.invalid']) assert(!client.localOrigin({ protocol: 'https:', hostname }));
    assert(!client.localOrigin({ protocol: 'file:', hostname: '' }));
    assert(client.localOrigin(new URL('dsh-app://app/')));
    for (const url of ['dsh-app://app.attacker.invalid/', 'dsh-app://localhost/', 'dsh-app://app:123/', 'dsh-app://user@app/', 'dsh-app://user:pass@app/', 'file://app/']) assert(!client.localOrigin(new URL(url)), url);
    assert(!client.localOrigin({ protocol: 'dsh-app:', hostname: 'app', href: 'dsh-app://user@app/' }));
  });
  check('validates loopback controls without credentials, redirects or secrets', () => {
    assert.equal(client.consoleUrl('http://127.0.0.1:8081/console'), gateway.consoleUrl);
    for (const value of ['https://attacker.invalid/console', 'http://localhost.attacker.invalid/console', 'http://user:pass@localhost/console', 'http://localhost/console?redirect=https://attacker.invalid', 'http://localhost/console#secret', 'http://localhost/arbitrary', 'dsh-app://app/console', 'http://127.1/console', 'http://2130706433/console', 'http://127.0.0.1/__console']) assert.equal(client.consoleUrl(value), null);
  });
  check('requires HTTPS and the complete encryption fragment for phone links', () => {
    assert(client.pairingUrl(privateLink()));
    for (const value of ['http://bridge.invalid/#k=abcdefghijklmnop', 'https://user:pass@bridge.invalid/#k=abcdefghijklmnop', 'https://bridge.invalid/', 'javascript:alert(1)', 'https://bridge.invalid/#k=short']) assert.equal(client.pairingUrl(value), null);
  });
  check('encryption readiness does not depend on tunnel availability or claim phone delivery', () => {
    assert.equal(client.encryptionLabel({ connection: { encrypted: true, available: false } }), 'Key ready; phone delivery not tested');
    assert.equal(client.encryptionLabel({ connection: { encrypted: true, available: true } }), 'Key ready; phone delivery not tested');
    assert.equal(client.encryptionLabel({ connection: { encrypted: false, available: true } }), 'Encryption key not confirmed');
    assert.equal(client.encryptionLabel(null), 'Encryption key not confirmed');
  });
  for (const code of ['node-unavailable', 'node-24-required']) {
    const failedStart = fixture(); failedStart.queue.push(response({ ...running(), state: 'stopped' }));
    failedStart.controller.start(); await tick();
    failedStart.queue.push(response({ ok: false, code }, 500), response({ ...running(), state: 'stopped', operation: { phase: 'failed', code } }));
    await failedStart.controller.action('start');
    check(code + ' explains runtime installation and retry without assuming a Windows shortcut', () => {
      const state = failedStart.controller.getState(); assert.equal(state.code, code);
      assert.match(state.error, /Node.js 24/); assert.match(state.error, /restart DSH/); assert.match(state.error, /Start bridge/);
      assert(!state.error.includes('Windows shortcut'));
    }); failedStart.controller.dispose();
  }
  const f = fixture(); f.queue.push(response(running())); f.controller.start(); await tick();
  check('initial status load never requests the private phone URL', () => { assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/pocket-bridge/status'); assert.equal(f.controller.getState().connection, null); });
  const url = privateLink(); f.queue.push(response(pairing(url))); await f.controller.reveal();
  check('explicit reveal uses same-origin JSON POST with no-store and native Origin handling', () => {
    const request = f.requests[1]; assert.equal(request.url, '/pocket-bridge/connection'); assert.equal(request.options.method, 'POST'); assert.equal(request.options.body, '{}'); assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.headers['Content-Type'], 'application/json'); assert(!('Origin' in request.options.headers));
    assert.equal(f.controller.getState().connection.url, url); assert(f.controller.getState().connection.matrix);
  });
  f.queue.push(response(running())); await f.controller.refresh();
  check('same-instance status refresh keeps revealed pairing', () => assert.equal(f.controller.getState().connection.url, url));
  const restarted = running(); restarted.gateway.bootId = 'new-test-boot'; f.queue.push(response(restarted)); await f.controller.refresh();
  check('gateway restart immediately clears pairing', () => assert.equal(f.controller.getState().connection, null));
  f.queue.push(response(pairing(privateLink()))); await f.controller.reveal();
  check('stale-instance pairing is rejected rather than shown', () => { assert.equal(f.controller.getState().connection, null); assert.equal(f.controller.getState().code, 'identity-mismatch'); });
  f.queue.push(response(running())); await f.controller.refresh(); f.queue.push(response(pairing(url))); await f.controller.reveal();
  f.visible(true); await tick();
  check('hidden tabs wipe the URL and pause all polling', () => { assert.equal(f.controller.getState().connection, null); assert.equal(f.timers.size, 0); });
  f.queue.push(response(running())); f.visible(false); await tick();
  check('visible tabs resume fresh status checks', () => { assert.equal(f.controller.getState().status.state, 'running'); assert(Array.from(f.timers.values()).some((timer) => timer.delay === 5000)); });
  f.queue.push(response(pairing(url))); await f.controller.reveal(); f.leave();
  check('page exit clears private pairing without persistent storage', () => assert.equal(f.controller.getState().connection, null));
  f.queue.push(response(running())); await f.controller.refresh();
  const beforeStop = f.requests.length; await f.controller.action('stop');
  check('first Stop click asks for confirmation and sends nothing', () => { assert.equal(f.requests.length, beforeStop); assert.equal(f.controller.getState().confirmStop, true); });
  f.queue.push(response({ ok: true, phase: 'stopped' }), response({ ...running(), state: 'stopped', connection: { available: false, encrypted: true } }));
  await f.controller.action('stop');
  check('confirmed stop pins both instance IDs and refreshes real status', () => { const request = f.requests[beforeStop]; assert.equal(request.url, '/pocket-bridge/action'); assert.deepEqual(JSON.parse(request.options.body), { action: 'stop', expectedBootId: gateway.bootId, expectedInstanceId: gateway.instanceId }); assert.equal(f.controller.getState().status.state, 'stopped'); assert.match(f.controller.getState().note, /DSH stays open/); });
  f.queue.push(response({ ok: true, phase: 'starting' }), response({ ...running(), state: 'stopped' })); await f.controller.action('start');
  check('acknowledged action is not reported as successful without matching status', () => assert.match(f.controller.getState().note, /not confirmed/));
  check('start sends only the allowed action field', () => { const request = f.requests.filter((item) => item.url === '/pocket-bridge/action').at(-1); assert.deepEqual(JSON.parse(request.options.body), { action: 'start' }); });
  f.queue.push(response({ ok: false, code: 'dsh-target-mismatch' }, 409), response(running())); await f.controller.action('start');
  check('action failure keeps specific recovery advice after status refresh', () => { assert.equal(f.controller.getState().code, 'dsh-target-mismatch'); assert.match(f.controller.getState().error, /different DSH runtime/); });
  f.queue.push(response({ ok: true, checks: [{ id: 'encryption', label: 'End-to-end encryption', state: 'pass', detail: 'Ready' }, { id: 'secret', label: 'Privacy', state: 'unknown', detail: url }] })); await f.controller.diagnostics();
  check('diagnostics preserve result states and suppress accidental secret links', () => { assert.equal(f.controller.getState().diagnostics.checks[0].state, 'pass'); assert(!f.controller.getState().diagnostics.checks[1].detail.includes('#k=')); });
  f.queue.push(response(running())); await f.controller.refresh(); f.queue.push(response(pairing(url))); await f.controller.reveal();
  f.queue.push(() => { throw new Error('Simulated disconnect'); }); await f.controller.refresh();
  check('disconnect clears stale status and secret; it remains retryable', () => { assert.equal(f.controller.getState().connection, null); assert.equal(f.controller.getState().status, null); assert.equal(f.controller.getState().code, 'network'); });
  f.controller.dispose();
  check('unmount removes listeners, cancels timers and clears pairing', () => { assert.equal(f.listenerCount(), 0); assert.equal(f.timers.size, 0); assert.equal(f.controller.getState().connection, null); });
  const remote = fixture('https:', 'phone-fixture.invalid'); remote.controller.start(); await remote.controller.action('start'); await remote.controller.diagnostics(); await remote.controller.reveal(); await tick();
  check('remote origins make no sensitive request, including actions', () => assert.equal(remote.requests.length, 0)); remote.controller.dispose();
  const setup = fixture(); setup.queue.push(response({ ok: false, state: 'unconfigured', code: 'installation-unavailable', connection: { available: false, encrypted: false } })); setup.controller.start(); await tick();
  check('unconfigured status is displayed rather than treated as a disconnected gateway', () => { assert.equal(setup.controller.getState().status.state, 'unconfigured'); assert.equal(setup.controller.getState().status.code, 'installation-unavailable'); }); setup.controller.dispose();
  const changing = fixture(); changing.queue.push(response({ ...running(), operation: { phase: 'stopping' } })); changing.controller.start(); await tick(); const changingCount = changing.requests.length; await changing.controller.action('stop'); await changing.controller.action('start'); await changing.controller.reveal();
  check('backend operation progress blocks duplicate actions and private reveal', () => assert.equal(changing.requests.length, changingCount)); changing.controller.dispose();
  const blocked = fixture(); blocked.queue.push(response(running())); blocked.controller.start(); await tick();
  let release; blocked.queue.push((options) => new Promise((resolve, reject) => { release = resolve; options.signal.addEventListener('abort', () => reject(new Error('Aborted'))); }));
  const revealPending = blocked.controller.reveal(); await tick(); const sent = blocked.requests.length; await blocked.controller.reveal();
  check('busy requests block repeated clicks', () => assert.equal(blocked.requests.length, sent));
  blocked.visible(true); release(response(pairing(url))); await revealPending; await tick();
  check('late responses after tab hiding cannot restore the secret', () => assert.equal(blocked.controller.getState().connection, null)); blocked.controller.dispose();
  const timeout = fixture(); timeout.queue.push((options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))))); timeout.controller.start(); await tick();
  const deadline = Array.from(timeout.timers.values()).find((timer) => timer.delay === 8000); deadline.callback(); await tick();
  check('timeout is distinct from disconnection and offers safe refresh', () => { assert.equal(timeout.controller.getState().code, 'timeout'); assert.match(timeout.controller.getState().error, /actually happened/); }); timeout.controller.dispose();
  check('QR renders every supported version with fixed square dimensions', () => {
    for (const length of [1, 30, 50, 75, 100, 130, 150, 190, 225, 270]) { const matrix = client.qrMatrix('a'.repeat(length)); assert.equal(matrix.length % 4, 1); assert(matrix.every((row) => row.length === matrix.length)); assert(matrix[0][0]); assert(!matrix[1][1]); assert(matrix[3][3]); }
    assert.throws(() => client.qrMatrix('a'.repeat(272)), /qr-too-long/);
  });
  const expiry = fixture(); expiry.queue.push(response(running())); expiry.controller.start(); await tick();
  expiry.queue.push(response({ ...pairing(url), expiresAt: new Date(expiry.env.now() + 120000).toISOString() })); await expiry.controller.reveal();
  check('revealing a connection creates a separate two-minute expiry timer', () => { assert(expiry.controller.getState().connection); assert(Array.from(expiry.timers.values()).some(timer => timer.delay === 120000)); });
  let finishSlowStatus;
  expiry.queue.push(() => new Promise(resolve => { finishSlowStatus = resolve; })); const slowStatus = expiry.controller.refresh({ quiet: true }); await tick();
  expiry.fire(120000);
  check('private QR clears on its independent deadline even while status is slow', () => { assert.equal(expiry.controller.getState().connection, null); assert.match(expiry.controller.getState().note, /hidden automatically/); });
  finishSlowStatus(response(running())); await slowStatus;
  check('stale slow status responses cannot resurrect an expired pairing', () => assert.equal(expiry.controller.getState().connection, null));
  expiry.queue.push(response(pairing(url))); await expiry.controller.reveal(); const staleExpiry = Array.from(expiry.timers.values()).find(timer => timer.delay === 120000).callback;
  expiry.controller.hide();
  check('Hide connection cancels its expiry timer', () => { assert.equal(expiry.controller.getState().connection, null); assert(!Array.from(expiry.timers.values()).some(timer => timer.delay === 120000)); });
  expiry.queue.push(response(pairing(url))); await expiry.controller.reveal(); staleExpiry();
  check('a cancelled old expiry callback cannot clear the next revealed connection', () => { assert(expiry.controller.getState().connection); assert(Array.from(expiry.timers.values()).some(timer => timer.delay === 120000)); });
  expiry.advance(120001);
  check('getState lazily hides an overdue private link when browser timers did not run', () => assert.equal(expiry.controller.getState().connection, null));
  check('copy access cannot retrieve a link after its display deadline', () => assert.equal(expiry.controller.getState().connection, null));
  expiry.queue.push(response({ ...pairing(url), expiresAt: new Date(expiry.env.now() + 600000).toISOString() })); await expiry.controller.reveal();
  check('server deadlines longer than two minutes are capped locally', () => { assert.equal(Date.parse(expiry.controller.getState().connection.expiresAt) - expiry.env.now(), 120000); });
  expiry.queue.push(response({ ok: false, code: 'bridge-unavailable' }, 500)); await expiry.controller.refresh();
  check('HTTP 500 clears private pairing and keeps specific recovery advice', () => { assert.equal(expiry.controller.getState().connection, null); assert.equal(expiry.controller.getState().code, 'bridge-unavailable'); assert(!Array.from(expiry.timers.values()).some(timer => timer.delay === 120000)); });
  expiry.queue.push(response(running())); await expiry.controller.refresh(); expiry.queue.push(response(pairing(url))); await expiry.controller.reveal();
  expiry.queue.push(response({ ok: false, code: 'local-authenticated-request-required' }, 403)); await expiry.controller.refresh();
  check('host route 403 clears pairing and explains the authenticated local entrance', () => { assert.equal(expiry.controller.getState().connection, null); assert.equal(expiry.controller.getState().code, 'local-authenticated-request-required'); assert.match(expiry.controller.getState().error, /authenticated DSH/); });
  expiry.queue.push(response(running())); await expiry.controller.refresh(); expiry.queue.push(response({ ...pairing(url), expiresAt: new Date(expiry.env.now() - 1).toISOString() })); await expiry.controller.reveal();
  check('an already-expired reveal response never displays a QR or private URL', () => { assert.equal(expiry.controller.getState().connection, null); assert.equal(expiry.controller.getState().code, 'connection-unavailable'); });
  expiry.queue.push(response(running())); await expiry.controller.refresh();
  expiry.queue.push(response(pairing(url))); await expiry.controller.reveal(); expiry.controller.dispose();
  check('unmount cancels the independent expiry timer alongside polling and requests', () => { assert.equal(expiry.timers.size, 0); assert.equal(expiry.controller.getState().connection, null); });
  const transport = fixture(); const originalHost = new URL(url).host;
  transport.queue.push(response({ ...running(), connection: { ...running().connection, host: originalHost } })); transport.controller.start(); await tick();
  transport.queue.push(response(pairing(url))); await transport.controller.reveal();
  transport.queue.push(response({ ...running(), connection: { ...running().connection, host: 'replacement-tunnel.invalid' } })); await transport.controller.refresh();
  check('same-boot tunnel address changes immediately hide the old QR and URL', () => { assert.equal(transport.controller.getState().connection, null); assert(!Array.from(transport.timers.values()).some(timer => timer.delay === 120000)); });
  transport.queue.push(response(pairing(url))); await transport.controller.reveal();
  check('a reveal reply for a different transport host is rejected', () => { assert.equal(transport.controller.getState().connection, null); assert.equal(transport.controller.getState().code, 'connection-unavailable'); });
  transport.queue.push(response({ ...running(), connection: { ...running().connection, host: originalHost } })); await transport.controller.refresh(); transport.queue.push(response(pairing(url))); await transport.controller.reveal();
  transport.queue.push(response({ ...running(), connection: { ...running().connection, host: originalHost, mode: 'private-https' } })); await transport.controller.refresh();
  check('same-boot transport mode changes immediately hide pairing', () => assert.equal(transport.controller.getState().connection, null));
  transport.queue.push(response({ ...pairing(url), mode: 'private-https' })); await transport.controller.reveal();
  transport.queue.push(response({ ...running(), connection: { ...running().connection, host: 'private-replacement.invalid', mode: 'private-https' } })); await transport.controller.refresh();
  check('same-boot private HTTPS origin changes immediately hide pairing', () => assert.equal(transport.controller.getState().connection, null)); transport.controller.dispose();
  const rejectedOperation = fixture(); rejectedOperation.queue.push(response({ ...running(), state: 'stopped' })); rejectedOperation.controller.start(); await tick();
  rejectedOperation.queue.push(response({ ok: true, phase: 'starting' }), response({ ...running(), state: 'stopped', operation: { phase: 'failed', code: 'start-unconfirmed' } }));
  await rejectedOperation.controller.action('start');
  check('fresh failed operation keeps its error without a contradictory acknowledgement note', () => { const state = rejectedOperation.controller.getState(); assert.equal(state.code, 'start-unconfirmed'); assert.match(state.error, /did not finish starting/); assert.equal(state.note, ''); assert.equal(state.busy, ''); }); rejectedOperation.controller.dispose();
  const lostAcknowledgement = fixture(); lostAcknowledgement.queue.push(response({ ...running(), state: 'stopped' })); lostAcknowledgement.controller.start(); await tick();
  lostAcknowledgement.queue.push(response({ ok: true, phase: 'starting' }), response({ ok: false, code: 'bridge-unavailable' }, 500)); await lostAcknowledgement.controller.action('start');
  check('failed status after action acknowledgement remains an error without a success-sounding note', () => { const state = lostAcknowledgement.controller.getState(); assert.equal(state.code, 'bridge-unavailable'); assert(state.error); assert.equal(state.note, ''); assert.equal(state.status, null); }); lostAcknowledgement.controller.dispose();
  check('all earlier POST routes carry the private control token only in a header', () => {
    for (const request of f.requests.filter(request => request.options.method === 'POST')) { assert.equal(request.options.headers['X-Pocket-Bridge-Control-Token'], controlToken); assert(!request.url.includes(controlToken)); assert(!request.options.body.includes(controlToken)); }
    for (const request of f.requests.filter(request => request.options.method === 'GET')) assert(!('X-Pocket-Bridge-Control-Token' in request.options.headers));
  });
  const native = fixture('dsh-app:', 'app'); const nativeToken = crypto.randomBytes(32).toString('base64url');
  const nativeSnapshots = []; native.controller.subscribe(state => nativeSnapshots.push(state));
  native.queue.push(response({ ...running(), controlToken: nativeToken })); native.controller.start(); await tick();
  check('the native desktop origin loads status and enables controls after authorization', () => { assert.equal(native.requests[0].url, '/pocket-bridge/status'); assert.equal(native.controller.getState().local, true); assert.equal(native.controller.getState().controlsReady, true); });
  check('control capability is stripped before getState, subscribers and UI can see it', () => {
    for (const state of nativeSnapshots) { assert(!JSON.stringify(state).includes(nativeToken)); assert(!Object.hasOwn(state, 'controlToken')); if (state.status) assert(!Object.hasOwn(state.status, 'controlToken')); }
  });
  native.queue.push(response({ ok: true, checks: [{ id: 'carrier', state: 'pass', label: 'Local carrier', detail: 'Ready' }] })); await native.controller.diagnostics();
  check('native POST sends the capability without forging the browser Origin header', () => { const request = native.requests.at(-1); assert.equal(request.options.headers['X-Pocket-Bridge-Control-Token'], nativeToken); assert.equal(request.options.credentials, 'same-origin'); assert(!('Origin' in request.options.headers)); });
  native.queue.push(response(pairing(url))); await native.controller.reveal();
  const replacementToken = crypto.randomBytes(32).toString('base64url');
  native.queue.push(response({ ...running(), controlToken: replacementToken })); await native.controller.refresh();
  check('host capability rotation hides an already revealed private connection', () => { assert.equal(native.controller.getState().connection, null); assert.equal(native.controller.getState().controlsReady, true); assert(!JSON.stringify(native.controller.getState()).includes(replacementToken)); });
  native.queue.push(response({ ok: false, code: 'local-authenticated-request-required' }, 403)); const beforeRejected = native.requests.length; await native.controller.diagnostics();
  check('rejected authorization drops the old capability and asks for explicit Refresh', () => { const state = native.controller.getState(); assert.equal(state.controlsReady, false); assert.equal(state.code, 'local-authenticated-request-required'); assert.match(state.error, /Refresh/); assert.equal(native.requests.length, beforeRejected + 1); });
  native.queue.push(response({ ...running(), controlToken: nativeToken })); await native.controller.refresh();
  check('refresh reacquires authorization without replaying a rejected POST', () => { assert.equal(native.requests.at(-1).options.method, 'GET'); assert.equal(native.controller.getState().controlsReady, true); });
  native.queue.push(response({ ok: true, checks: [] })); await native.controller.diagnostics();
  check('only an explicit retry uses the fresh authorization token', () => assert.equal(native.requests.at(-1).options.headers['X-Pocket-Bridge-Control-Token'], nativeToken));
  native.visible(true);
  check('hidden native pages discard their control capability as well as pairing', () => assert.equal(native.controller.getState().controlsReady, false)); native.controller.dispose();
  const noToken = fixture(); noToken.queue.push(response({ ...running(), controlToken: undefined })); noToken.controller.start(); await tick();
  check('missing status capability disables write controls and shows authorization recovery', () => { assert.equal(noToken.controller.getState().controlsReady, false); assert.equal(noToken.controller.getState().code, 'control-token-unavailable'); });
  noToken.queue.push(response(running())); const beforeBlocked = noToken.requests.length; await noToken.controller.action('start');
  check('a tokenless action may refresh authorization but never sends or replays the write', () => { assert.equal(noToken.requests.length, beforeBlocked + 1); assert.equal(noToken.requests.at(-1).options.method, 'GET'); assert.equal(noToken.controller.getState().controlsReady, true); assert.match(noToken.controller.getState().error, /No write request was sent/); });
  noToken.queue.push(response({ ok: true, phase: 'running' }), response(running())); await noToken.controller.action('start');
  check('the user can explicitly retry after a successful authorization refresh', () => { assert.equal(noToken.requests.filter(request => request.options.method === 'POST').length, 1); assert.equal(noToken.controller.getState().error, ''); }); noToken.controller.dispose();
  const setupAuthorized = fixture(); setupAuthorized.queue.push(response({ ok: false, state: 'unconfigured', code: 'installation-unavailable', connection: { available: false }, controlToken })); setupAuthorized.controller.start(); await tick();
  check('business-unconfigured status can provide authorization without leaking it', () => { const state = setupAuthorized.controller.getState(); assert.equal(state.status.state, 'unconfigured'); assert.equal(state.controlsReady, true); assert(!Object.hasOwn(state.status, 'controlToken')); }); setupAuthorized.controller.dispose();
  for (const invalid of [undefined, '', 'a'.repeat(42), 'a'.repeat(44), 'é'.repeat(43), [controlToken]]) {
    const malformedToken = fixture(); malformedToken.queue.push(response({ ...running(), controlToken: invalid })); malformedToken.controller.start(); await tick();
    check('rejects a malformed status capability (' + (Array.isArray(invalid) ? 'array' : typeof invalid === 'string' ? invalid.length + '-character input' : 'missing') + ')', () => { assert.equal(malformedToken.controller.getState().controlsReady, false); assert.equal(malformedToken.controller.getState().code, 'control-token-unavailable'); }); malformedToken.controller.dispose();
  }
  const staleNative = fixture('dsh-app:', 'app'); let finishStaleAuth;
  staleNative.queue.push(() => new Promise(resolve => { finishStaleAuth = resolve; })); staleNative.controller.start(); await tick(); staleNative.visible(true); finishStaleAuth(response({ ...running(), controlToken: nativeToken })); await tick();
  check('late status after hiding cannot restore a control capability', () => { assert.equal(staleNative.controller.getState().controlsReady, false); assert(!JSON.stringify(staleNative.controller.getState()).includes(nativeToken)); }); staleNative.controller.dispose();
  const disposedNative = fixture('dsh-app:', 'app'); disposedNative.queue.push(response({ ...running(), controlToken: nativeToken })); disposedNative.controller.start(); await tick(); disposedNative.controller.dispose();
  check('unmount discards the native control capability and all polling', () => { assert.equal(disposedNative.controller.getState().controlsReady, false); assert.equal(disposedNative.timers.size, 0); assert(!JSON.stringify(disposedNative.controller.getState()).includes(nativeToken)); });
  const checklist = () => ({ ok: true, checkedAt: '2026-10-07T21:40:00.000Z', checks: [{ id: 'entrance', label: 'Secure entrance', state: 'fail', detail: 'Not ready at the recorded check time.' }] });
  const diagnosis = fixture(); const diagnosisBase = { ...running(), runtime: { ...running().runtime, port: 19389 }, connection: { ...running().connection, host: 'stable-fixture.invalid' }, tunnel: { running: true, reachable: true, checkedAt: '2026-10-07T21:40:00.000Z' }, operation: { phase: 'idle' } };
  diagnosis.queue.push(response(diagnosisBase)); diagnosis.controller.start(); await tick(); diagnosis.queue.push(response(checklist())); await diagnosis.controller.diagnostics(); const initialChecklist = diagnosis.controller.getState().diagnostics;
  check('diagnostics record a valid check time rather than implying a continuously current result', () => assert.equal(initialChecklist.checkedAt, '2026-10-07T21:40:00.000Z'));
  diagnosis.queue.push(response({ ...diagnosisBase, updatedAt: 'later-poll', tunnel: { ...diagnosisBase.tunnel, checkedAt: '2026-10-07T21:41:00.000Z' } })); await diagnosis.controller.refresh({ quiet: true });
  check('ordinary same-identity status polling preserves checks despite poll timestamp changes', () => { assert.equal(diagnosis.controller.getState().diagnostics, initialChecklist); assert.equal(diagnosis.controller.getState().diagnosticsStale, false); });
  await diagnosis.controller.action('stop'); diagnosis.controller.cancelStop();
  check('opening or cancelling Stop confirmation preserves the recorded diagnostics', () => assert.equal(diagnosis.controller.getState().diagnostics, initialChecklist));
  await diagnosis.controller.action('stop'); diagnosis.queue.push(response({ ok: true, phase: 'stopping' }), response({ ...diagnosisBase, state: 'stopped', gateway: undefined, connection: { available: false, encrypted: true }, operation: { phase: 'idle' } })); await diagnosis.controller.action('stop');
  check('confirmed stop discards the previous checklist and requests a fresh run', () => { assert.equal(diagnosis.controller.getState().diagnostics, null); assert.equal(diagnosis.controller.getState().diagnosticsStale, true); }); diagnosis.controller.dispose();
  const contextChanges = [
    ['gateway boot', value => { value.gateway.bootId = 'different-boot'; }],
    ['installation identity', value => { value.gateway.instanceId = 'different-installation'; }],
    ['gateway PID', value => { value.gateway.pid++; }],
    ['gateway port', value => { value.gateway.port = 8082; }],
    ['bridge version', value => { value.version = 'new-version'; }],
    ['runtime target', value => { value.runtime.port = 19390; }],
    ['runtime availability', value => { value.runtime.available = false; }],
    ['bridge state', value => { value.state = 'stopped'; }],
    ['transport mode', value => { value.connection.mode = 'private-https'; }],
    ['transport host', value => { value.connection.host = 'replacement-fixture.invalid'; }],
    ['secure entrance availability', value => { value.connection.available = false; }],
    ['key readiness', value => { value.connection.encrypted = false; }],
    ['tunnel reachability', value => { value.tunnel.reachable = false; }],
    ['tunnel startup policy', value => { value.tunnel.disabled = true; }],
    ['operation phase', value => { value.operation.phase = 'stopping'; }],
    ['operation error code', value => { value.operation.code = 'node-unavailable'; }]
  ];
  for (const [label, change] of contextChanges) {
    const changed = fixture(); changed.queue.push(response(JSON.parse(JSON.stringify(diagnosisBase)))); changed.controller.start(); await tick(); changed.queue.push(response(checklist())); await changed.controller.diagnostics();
    const next = JSON.parse(JSON.stringify(diagnosisBase)); change(next); changed.queue.push(response(next)); await changed.controller.refresh();
    check('a changed ' + label + ' clears the old diagnostic results', () => { assert.equal(changed.controller.getState().diagnostics, null); assert.equal(changed.controller.getState().diagnosticsStale, true); assert.equal(changed.controller.getState().controlsReady, true); if (label !== 'key readiness') assert.equal(client.encryptionLabel(changed.controller.getState().status), 'Key ready; phone delivery not tested'); }); changed.controller.dispose();
  }
  const oldDiagnostics = fixture(); oldDiagnostics.queue.push(response(diagnosisBase)); oldDiagnostics.controller.start(); await tick(); let finishOldDiagnostics;
  oldDiagnostics.queue.push(() => new Promise(resolve => { finishOldDiagnostics = resolve; })); const oldDiagnosticsRequest = oldDiagnostics.controller.diagnostics(); await tick();
  oldDiagnostics.queue.push(response({ ...diagnosisBase, gateway: { ...diagnosisBase.gateway, bootId: 'new-diagnostic-boot' } })); await oldDiagnostics.controller.refresh(); finishOldDiagnostics(response(checklist())); await oldDiagnosticsRequest;
  check('late diagnostic completion from a previous boot cannot be written into the new UI', () => { const state = oldDiagnostics.controller.getState(); assert.equal(state.diagnostics, null); assert.equal(state.diagnosticsStale, true); assert.equal(state.status.gateway.bootId, 'new-diagnostic-boot'); assert.equal(state.controlsReady, true); }); oldDiagnostics.controller.dispose();
  const stablePending = fixture(); stablePending.queue.push(response(diagnosisBase)); stablePending.controller.start(); await tick(); let finishStableDiagnostics;
  stablePending.queue.push(() => new Promise(resolve => { finishStableDiagnostics = resolve; })); const stableDiagnosticsRequest = stablePending.controller.diagnostics(); await tick(); stablePending.queue.push(response({ ...diagnosisBase, tunnel: { ...diagnosisBase.tunnel, checkedAt: 'later-status-time' } })); await stablePending.controller.refresh(); finishStableDiagnostics(response(checklist())); await stableDiagnosticsRequest;
  check('same-context polling does not discard an in-flight diagnostic check', () => { assert(stablePending.controller.getState().diagnostics); assert.equal(stablePending.controller.getState().diagnosticsStale, false); }); stablePending.controller.dispose();
  const abaDiagnostics = fixture(); abaDiagnostics.queue.push(response(diagnosisBase)); abaDiagnostics.controller.start(); await tick(); let finishAbaDiagnostics;
  abaDiagnostics.queue.push(() => new Promise(resolve => { finishAbaDiagnostics = resolve; })); const abaRequest = abaDiagnostics.controller.diagnostics(); await tick(); abaDiagnostics.queue.push(response({ ...diagnosisBase, gateway: { ...diagnosisBase.gateway, bootId: 'temporary-other-boot' } })); await abaDiagnostics.controller.refresh(); abaDiagnostics.queue.push(response(diagnosisBase)); await abaDiagnostics.controller.refresh(); finishAbaDiagnostics(response(checklist())); await abaRequest;
  check('returning to the same identity after an intervening change cannot admit an older result', () => assert.equal(abaDiagnostics.controller.getState().diagnostics, null)); abaDiagnostics.controller.dispose();
  const tokenDiagnostics = fixture('dsh-app:', 'app'); tokenDiagnostics.queue.push(response(diagnosisBase)); tokenDiagnostics.controller.start(); await tick(); let finishRejectedDiagnostics;
  tokenDiagnostics.queue.push(() => new Promise(resolve => { finishRejectedDiagnostics = resolve; })); const rejectedDiagnosticRequest = tokenDiagnostics.controller.diagnostics(); await tick(); tokenDiagnostics.queue.push(response({ ...diagnosisBase, controlToken: nativeToken })); await tokenDiagnostics.controller.refresh(); finishRejectedDiagnostics(response({ ok: false, code: 'local-authenticated-request-required' }, 403)); await rejectedDiagnosticRequest;
  check('a stale diagnostic error cannot revoke freshly rotated authorization or regress key readiness', () => { const state = tokenDiagnostics.controller.getState(); assert.equal(state.controlsReady, true); assert.equal(state.error, ''); assert.equal(state.diagnostics, null); assert.equal(client.encryptionLabel(state.status), 'Key ready; phone delivery not tested'); }); tokenDiagnostics.controller.dispose();
  const invalidCheckTime = fixture(); invalidCheckTime.queue.push(response(running())); invalidCheckTime.controller.start(); await tick(); invalidCheckTime.queue.push(response({ ...checklist(), checkedAt: 'not-a-date' })); await invalidCheckTime.controller.diagnostics();
  check('invalid diagnostic timestamp gets a finite local completion time', () => { assert.equal(invalidCheckTime.controller.getState().diagnostics.checkedAt, new Date(invalidCheckTime.env.now()).toISOString()); }); invalidCheckTime.controller.dispose();
  // Optional private fixture export for an independent QR decoder. This is not
  // a self-consistency decoding test and does not contain a real access key.
  const fixtureIndex = process.argv.indexOf('--qr-fixtures');
  if (fixtureIndex >= 0) {
    const directory = path.resolve(process.argv[fixtureIndex + 1] || '');
    if (!/^D:\\/i.test(directory)) throw new Error('QR validation artifacts must stay on D:');
    fs.mkdirSync(directory, { recursive: true }); const manifest = [];
    const versionFixtures = [1, 30, 50, 75, 100, 130, 150, 190, 225, 270].map((length, i) => ['version-' + (i + 1), 'a'.repeat(length)]);
    for (const [name, payload] of [['short', 'Pocket Bridge'], ['pairing', privateLink()], ...versionFixtures]) {
      const matrix = client.qrMatrix(payload), scale = 8, pixels = (matrix.length + 8) * scale;
      const image = Buffer.alloc(pixels * pixels, 255);
      for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) if (matrix[y][x]) for (let dy = 0; dy < scale; dy++) image.fill(0, ((y + 4) * scale + dy) * pixels + (x + 4) * scale, ((y + 4) * scale + dy) * pixels + (x + 5) * scale);
      fs.writeFileSync(path.join(directory, name + '.pgm'), Buffer.concat([Buffer.from(`P5\n${pixels} ${pixels}\n255\n`), image])); manifest.push({ name, payload, file: name + '.pgm', modules: matrix.length });
    }
    fs.writeFileSync(path.join(directory, 'fixtures.json'), JSON.stringify(manifest, null, 2));
    console.log('Independent QR fixture images written to ' + directory);
  }
  console.log(`PASS ${checks} isolated client checks. Real DSH/browser acceptance is separate.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
