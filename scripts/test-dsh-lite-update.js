'use strict';

// The phone can be suspended while a conversation and an unsent draft are
// open. A build check on resume must not repin code or reload that page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-update.js'), 'utf8');
const manifest = (hash) => ({ files: Object.fromEntries(
  ['/dsh-lite-ui.js', '/dsh-lite-adapter.js', '/dsh-lite-pin.js', '/e2ee.js',
    '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-lite-switch.js',
    '/i18n.js', '/dsh-lite-lang.js']
    .map((name) => [name, hash.repeat(64)])) });

function fixture(options = {}) {
  const nodes = new Map();
  const docEvents = {};
  const swEvents = {};
  const sent = [];
  const oldSent = [];
  const newSent = [];
  const storage = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let updates = 0;
  let currentManifest = manifest('a');
  let reloads = 0;

  function element(tag) {
    return {
      tagName: tag.toUpperCase(), children: [], disabled: false, style: {},
      setAttribute() {},
      addEventListener(type, callback) { this[type] = callback; },
      appendChild(child) { this.children.push(child); },
      querySelector(selector) {
        return selector === 'span' ? this.children.find((child) => child.tagName === 'SPAN') :
          selector === 'button' ? this.children.find((child) => child.tagName === 'BUTTON') : null;
      }
    };
  }
  const document = {
    hidden: false,
    body: { appendChild(node) { nodes.set(node.id, node); } },
    createElement: element,
    getElementById(id) { return nodes.get(id) || null; },
    addEventListener(type, callback) { docEvents[type] = callback; }
  };
  const workerEvents = {};
  const worker = { state: 'activated', postMessage(message) { sent.push(message); oldSent.push(message); } };
  const incoming = {
    state: options.pendingState || 'installing',
    postMessage(message) { sent.push(message); newSent.push(message); },
    addEventListener(type, callback) { workerEvents[type] = callback; },
    removeEventListener(type, callback) {
      if (workerEvents[type] === callback) delete workerEvents[type];
    }
  };
  const registration = {
    active: worker, installing: null, waiting: null,
    update() {
      updates++;
      if (options.pendingState) {
        if (options.pendingState === 'installed') this.waiting = incoming;
        else this.installing = incoming;
      }
      return Promise.resolve();
    }
  };
  const serviceWorker = {
    controller: worker,
    ready: Promise.resolve(registration),
    addEventListener(type, callback) { swEvents[type] = callback; },
    removeEventListener(type, callback) {
      if (swEvents[type] === callback) delete swEvents[type];
    }
  };
  const context = {
    navigator: { serviceWorker },
    document,
    window: { __dshE2eeSecret: 'fixture-key' },
    location: { hash: '#k=fixture', reload() { reloads++; } },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); }
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => currentManifest }),
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    Promise, console
  };
  vm.runInNewContext(script, context, { filename: 'pwa/dsh-lite-update.js' });
  return {
    sent, oldSent, newSent, storage, nodes,
    setManifest(value) { currentManifest = value; },
    foreground() { docEvents.visibilitychange(); },
    emit(data) { swEvents.message({ data }); },
    activateNewWorker(signal = 'both') {
      assert.ok(options.pendingState, 'this fixture has no incoming worker');
      incoming.state = 'activated';
      registration.active = incoming;
      registration.installing = null;
      registration.waiting = null;
      if (signal !== 'controllerchange' && workerEvents.statechange)
        workerEvents.statechange();
      serviceWorker.controller = incoming;
      if (signal !== 'statechange' && swEvents.controllerchange)
        swEvents.controllerchange();
    },
    fireTimer(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'expected a ' + delay + 'ms timer');
      timers.delete(entry[0]);
      entry[1].callback();
    },
    get updates() { return updates; },
    get reloads() { return reloads; }
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  const page = fixture();
  await tick();
  await tick();
  const oldBuild = page.storage.get('dsh-lite:build');
  assert.ok(oldBuild, 'first read stores a comparison baseline');
  assert.equal(page.sent.length, 0);

  page.setManifest(manifest('b'));
  page.foreground();
  await tick();
  await tick();
  const notice = page.nodes.get('dsh-lite-update-notice');
  assert.ok(notice, 'new build is visible on return to the foreground');
  assert.equal(page.sent.length, 0, 'foreground may not rewrite a saved code pin');
  assert.equal(page.reloads, 0, 'foreground may not interrupt the conversation');
  assert.equal(page.storage.get('dsh-lite:build'), oldBuild,
    'a pending update may not be marked as already installed');

  page.emit({ type: 'dsh-repin-verified-result', ok: true });
  assert.equal(page.reloads, 0, 'another listener\'s update cannot reload this page');
  const button = notice.querySelector('button');
  button.click();
  await tick();
  assert.equal(page.updates, 1, 'explicit update refreshes the Service Worker first');
  assert.equal(page.sent.length, 1);
  assert.equal(page.sent[0].type, 'dsh-verified-update-capability');
  page.emit({ type: 'dsh-verified-update-ready', requestId: 'wrong' });
  assert.equal(page.sent.length, 1, 'unrelated capability replies are ignored');
  page.emit({ type: 'dsh-verified-update-ready', requestId: page.sent[0].requestId });
  await tick();
  assert.equal(page.sent[1].type, 'dsh-repin-code-verified',
    'manifest is submitted only after the new worker proves support');
  assert.equal(page.storage.get('dsh-lite:build'), oldBuild,
    'do not mark the update installed before worker success');
  page.fireTimer(15000);
  assert.equal(page.reloads, 0, 'slow verified downloads must remain pending');
  assert.equal(button.disabled, true, 'a slow update cannot start a conflicting second repin');
  page.emit({ type: 'dsh-repin-result', ok: true });
  assert.equal(page.reloads, 0, 'old pin.js result cannot complete this update');
  page.emit({ type: 'dsh-repin-verified-result', requestId: page.sent[1].requestId, ok: true });
  assert.equal(page.reloads, 1);
  page.emit({ type: 'dsh-repin-verified-result', requestId: page.sent[1].requestId, ok: true });
  assert.equal(page.reloads, 1, 'duplicate worker results cannot reload twice');
  assert.notEqual(page.storage.get('dsh-lite:build'), oldBuild);

  const failed = fixture();
  await tick();
  await tick();
  const failedOldBuild = failed.storage.get('dsh-lite:build');
  failed.setManifest(manifest('c'));
  failed.foreground();
  await tick();
  await tick();
  failed.nodes.get('dsh-lite-update-notice').querySelector('button').click();
  await tick();
  failed.emit({ type: 'dsh-verified-update-ready', requestId: failed.sent[0].requestId });
  await tick();
  failed.emit({ type: 'dsh-repin-verified-result', requestId: failed.sent[1].requestId, ok: false });
  assert.equal(failed.reloads, 0);
  assert.equal(failed.storage.get('dsh-lite:build'), failedOldBuild,
    'failed repin remains retryable');

  const oldWorker = fixture();
  await tick();
  await tick();
  oldWorker.setManifest(manifest('d'));
  oldWorker.foreground();
  await tick();
  await tick();
  const oldButton = oldWorker.nodes.get('dsh-lite-update-notice').querySelector('button');
  oldButton.click();
  await tick();
  assert.equal(oldWorker.sent.length, 1);
  oldWorker.fireTimer(10000);
  await tick();
  assert.equal(oldWorker.sent.length, 1,
    'an old worker that ignores the capability probe never receives a repin');
  assert.equal(oldButton.disabled, false, 'a stale worker can be retried after refresh');
  assert.equal(oldWorker.reloads, 0);

  for (const state of ['installing', 'installed']) {
    const upgrading = fixture({ pendingState: state });
    await tick();
    await tick();
    upgrading.setManifest(manifest('e'));
    upgrading.foreground();
    await tick();
    await tick();
    upgrading.nodes.get('dsh-lite-update-notice').querySelector('button').click();
    await tick();
    assert.equal(upgrading.sent.length, 0,
      'a ' + state + ' replacement must activate before the capability probe');
    upgrading.activateNewWorker(state === 'installed' ? 'controllerchange' : 'statechange');
    await tick();
    assert.equal(upgrading.oldSent.length, 0, 'the old worker receives no update message');
    assert.equal(upgrading.newSent[0].type, 'dsh-verified-update-capability');
    upgrading.emit({ type: 'dsh-verified-update-ready',
      requestId: upgrading.newSent[0].requestId });
    await tick();
    assert.equal(upgrading.newSent[1].type, 'dsh-repin-code-verified');
    upgrading.emit({ type: 'dsh-repin-verified-result',
      requestId: upgrading.newSent[1].requestId, ok: true });
    assert.equal(upgrading.reloads, 1);
  }

  const stalled = fixture({ pendingState: 'installing' });
  await tick();
  await tick();
  stalled.setManifest(manifest('f'));
  stalled.foreground();
  await tick();
  await tick();
  const stalledButton = stalled.nodes.get('dsh-lite-update-notice').querySelector('button');
  stalledButton.click();
  await tick();
  stalled.fireTimer(10000);
  await tick();
  assert.equal(stalled.sent.length, 0,
    'activation timeout must leave the old pin untouched, without probing old worker');
  assert.equal(stalledButton.disabled, false, 'activation timeout allows refresh and retry');
  assert.equal(stalled.reloads, 0);

  console.log('PASS: verified update waits for replacement activation and slow staging');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
