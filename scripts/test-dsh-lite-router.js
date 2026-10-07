'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction, sliceBalanced } = require('./page-source.js');
const requestOrigin = require('./request-origin.js');
const dshPhoneSurface = require('./dsh-phone-surface.js');
const privateHttpsAdmission = require('./private-https-admission.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-router.js'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite.html'), 'utf8');
const i18nSource = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'i18n.js'), 'utf8');
const languageSource = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-lang.js'), 'utf8');
assert.match(gateway, /'\/__dsh\/legacy-rpc'/);
assert.match(gateway, /'\/dsh-lite-router\.js': \{ file: 'dsh-lite-router\.js'/);
const order = ['/e2ee.js', '/dsh-lite-pin.js', '/dsh-lite-adapter.js',
  '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-lite-ui.js'].map(name => html.indexOf(name));
assert.ok(order.every(index => index >= 0) && order.every((index, i) => i === 0 || index > order[i - 1]),
  'the router must defer UI mount until both adapters and encryption are loaded');

// Execute the gateway's actual root branch. A remote phone must receive the
// owned shell before local discovery, regardless of profile, cookie or UA.
function verifyGatewayShell() {
  const at = gateway.indexOf("if (u.pathname === '/' || u.pathname === '/index.html')");
  const open = gateway.indexOf('{', at), end = sliceBalanced(gateway, open, '{', '}');
  assert.ok(at >= 0 && end > open);
  let localDecisions = 0;
  const box = vm.createContext({ Buffer, URL, requestOrigin, dshPhoneSurface, privateHttpsAdmission,
    cfg: { isOwnAddress: (_address, req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) },
    TARGET_COOKIE: 'fixture-target', targetCookie: () => 'fixture-target=dsh; Path=/',
    shouldShowLauncher: () => { localDecisions++; return false; },
    servePwa(_req, res, asset) {
      assert.equal(asset.file, 'dsh-lite.html'); assert.equal(asset.noCache, true);
      res.writeHead(200, { 'content-type': asset.type }); res.end('OWNED_LITE_SHELL');
    }
  });
  vm.runInContext(extractFunction(gateway, 'isOwnAddress') + '\n' + extractFunction(gateway, 'isLocalRequest') +
    '\nfunction root(req,res,u){' + gateway.slice(at, end + 1) + ';return false;}', box);
  for (const [host, peer, extra] of [
    ['fixture.trycloudflare.com', '127.0.0.1', {}],
    ['localhost', '127.0.0.1', { 'cf-ray': 'synthetic' }],
    ['localhost', '192.0.2.4', {}]
  ]) for (const query of ['', '?target=dsh', '?target=pick', '?target=lite']) {
    const req = { method: 'GET', url: '/k/SYNTHETIC' + query,
      headers: { host, cookie: 'fixture-target=dsh', 'user-agent': 'desktop-agent', ...extra }, socket: { remoteAddress: peer } };
    const res = { headers: { 'set-cookie': ['prior=synthetic'] }, getHeader(k) { return this.headers[k]; },
      setHeader(k,v) { this.headers[k] = v; }, writeHead(n,h) { this.status = n; Object.assign(this.headers,h); }, end(v) { this.body = v; } };
    box.root(req, res, new URL('http://localhost/' + query));
    assert.equal(res.status, 200); assert.equal(res.body, 'OWNED_LITE_SHELL');
    assert.equal(res.headers.location, undefined, 'Safari fragment stays in the browser URL');
    assert.equal(req.url, '/k/SYNTHETIC' + query);
    assert.equal(res.headers['set-cookie'][0], 'prior=synthetic');
    assert.equal(res.headers['set-cookie'][1], 'fixture-target=dsh; Path=/');
  }
  const req = { method: 'GET', headers: { host: 'fixture.trycloudflare.com' }, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writeHead(n) { this.status=n; }, end(v) { this.body=v; } };
  box.root(req, res, new URL('http://localhost/?target=dsh&view=classic'));
  assert.equal(res.status,410); assert.equal(JSON.parse(res.body).code,'dsh-classic-retired');
  assert.equal(localDecisions,0, 'remote shell never waits for local app selection or cached protocol');
}
verifyGatewayShell();

async function fixture(profile, options = {}) {
  const nodes = new Map();
  const scripts = [];
  const attempts = new Map();
  for (const id of ['connection-status', 'error-banner', 'error-text', 'error-retry',
    'reconnect', 'rail-reconnect', 'classic-view', 'settings-classic']) {
    nodes.set(id, { id, hidden: false, dataset: {}, textContent: '', href: 'https://stale.fixture.invalid', onclick: null,
      removeAttribute(name) { if (name === 'href') delete this.href; } });
  }
  const events = {};
  const head = {
    appendChild(script) {
      script.parentNode = head;
      scripts.push(script.src);
      const count = attempts.get(script.src) || 0;
      attempts.set(script.src, count + 1);
      const outcome = (options.scriptLoads && options.scriptLoads[script.src] || [])[count] || 'error';
      Promise.resolve().then(() => {
        if (outcome === 'hang') return;
        if (outcome === 'success') {
          if (script.src === '/dsh-lite-adapter.js') window.DshLiteRemoteAdapter = remote;
          if (script.src === '/dsh-lite-legacy.js') window.DshLegacyAdapter = legacy;
          if (script.src === '/dsh-lite-ui.js')
            window.DshLiteUI = { mount: adapter => mounts.push(adapter) };
        }
        if (outcome === 'error') script.onerror();
        else script.onload();
      });
    },
    removeChild(script) { script.parentNode = null; }
  };
  const document = { readyState: 'loading', getElementById: id => nodes.get(id),
    documentElement: { setAttribute() {} }, querySelectorAll: () => [],
    addEventListener: (name, callback) => { events[name] = callback; },
    createElement: () => ({ src: '', async: false, parentNode: null, onload: null, onerror: null }),
    head };
  const mounts = [];
  const remote = { profile: 'remote-mux' };
  const legacy = { profile: 'legacy-events' };
  let reloads = 0, fetchCalls = 0;
  const location = { href: 'https://example.test/k/ACCESS?target=lite#k=SECRET', reload() { reloads++; } };
  const window = { document, location, DshE2EE: { available: () => true,
    prove: async () => options.proof !== false }, __dshE2eeSecret: 'secret',
    DshLiteRemoteAdapter: options.missingRemote ? null : remote,
    DshLegacyAdapter: options.missingLegacy ? null : legacy,
    DshLiteUI: options.missingUI ? null : { mount: adapter => mounts.push(adapter) },
    setTimeout: (callback, delay) => setTimeout(callback,
      options.fastTimers ? 0 : delay), clearTimeout,
    fetch: async () => {
      fetchCalls++;
      if (options.fetchFails) throw new TypeError('Synthetic private transport details');
      const status = options.httpStatus || 200;
      return { ok: status === 200, status, json: async () => ({ targets: [{ id: 'dsh', profile }] }) };
    } };
  const context = vm.createContext({ window, URL });
  if (options.language) {
    window.navigator = { languages: [options.language], language: options.language };
    window.localStorage = { getItem: () => options.language, setItem() {}, removeItem() {} };
    vm.runInContext(i18nSource + '\n' + languageSource, context);
    assert.equal(window.DshI18n.lang(), options.language, 'the actual shared language module selects the stored language');
  }
  vm.runInContext(source, context);
  assert.equal(window.__dshLiteDeferAutoMount, true);
  await events.DOMContentLoaded();
  return { mounts, remote, legacy, nodes, scripts, location,
    counts: () => ({ reloads, fetchCalls }) };
}

(async () => {
  const newRuntime = await fixture('remote-mux');
  assert.equal(newRuntime.mounts[0], newRuntime.remote);
  for (const id of ['classic-view','settings-classic']) {
    assert.equal(newRuntime.nodes.get(id).hidden, true);
    assert.equal(newRuntime.nodes.get(id).href, undefined, 'remote classic fallback is removed before adapter mount');
  }
  const oldRuntime = await fixture('legacy-events');
  assert.equal(oldRuntime.mounts[0], oldRuntime.legacy);
  const unknown = await fixture('unsupported');
  assert.equal(unknown.mounts.length, 0);
  assert.equal(unknown.nodes.get('error-banner').hidden, false);
  assert.match(unknown.nodes.get('error-text').textContent, /协议尚未得到验证/);
  assert.doesNotMatch(unknown.nodes.get('error-text').textContent, /请使用原版界面/);
  assert.equal(unknown.nodes.get('classic-view').href, undefined, 'unsupported runtime never exposes an unencrypted fallback');
  const missing = await fixture('legacy-events', { missingLegacy: true });
  assert.equal(missing.mounts.length, 0);
  assert.match(missing.nodes.get('error-text').textContent, /旧版 DSH 连接组件.*dsh-lite-legacy\.js/);
  assert.deepEqual(missing.scripts, ['/dsh-lite-legacy.js', '/dsh-lite-legacy.js']);

  const recoveredLegacy = await fixture('legacy-events', {
    missingLegacy: true,
    scriptLoads: { '/dsh-lite-legacy.js': ['error', 'success'] }
  });
  assert.equal(recoveredLegacy.mounts[0], recoveredLegacy.legacy,
    'the legacy adapter can recover after one failed script load');
  assert.deepEqual(recoveredLegacy.scripts, ['/dsh-lite-legacy.js', '/dsh-lite-legacy.js']);

  const recoveredRemote = await fixture('remote-mux', {
    missingRemote: true, missingUI: true,
    scriptLoads: { '/dsh-lite-adapter.js': ['missing', 'success'],
      '/dsh-lite-ui.js': ['success'] }
  });
  assert.equal(recoveredRemote.mounts[0], recoveredRemote.remote,
    'onload without adapter registration still needs a second verified load');
  assert.deepEqual(recoveredRemote.scripts,
    ['/dsh-lite-adapter.js', '/dsh-lite-ui.js', '/dsh-lite-adapter.js']);

  const missingUI = await fixture('remote-mux', { missingUI: true });
  assert.equal(missingUI.mounts.length, 0);
  assert.match(missingUI.nodes.get('error-text').textContent, /手机界面组件.*dsh-lite-ui\.js/);
  assert.deepEqual(missingUI.scripts, ['/dsh-lite-ui.js', '/dsh-lite-ui.js']);

  const stalledUI = await fixture('remote-mux', {
    missingUI: true, fastTimers: true,
    scriptLoads: { '/dsh-lite-ui.js': ['hang', 'hang'] }
  });
  assert.equal(stalledUI.mounts.length, 0);
  assert.deepEqual(stalledUI.scripts, ['/dsh-lite-ui.js', '/dsh-lite-ui.js'],
    'a stalled script has a finite retry budget');
  assert.match(stalledUI.nodes.get('error-text').textContent, /手机界面组件/);
  const unauthorized = await fixture('remote-mux', { proof: false });
  assert.equal(unauthorized.mounts.length, 0);
  assert.match(unauthorized.nodes.get('error-text').textContent, /授权/);
  assert.deepEqual(unauthorized.scripts, [], 'auth failure must not load components');
  assert.deepEqual(unknown.scripts, [], 'unknown profile must not load arbitrary scripts');
  for (const language of ['en', 'es']) {
    const unsupported = await fixture('unsupported', { language });
    assert.equal(unsupported.mounts.length, 0); assert.deepEqual(unsupported.scripts, []);
    assert.equal(unsupported.nodes.get('connection-status').textContent,
      language === 'en' ? 'Connection unavailable' : 'Conexión no disponible');
    assert.match(unsupported.nodes.get('error-text').textContent, language === 'en' ? /protocol is unverified/ : /no está verificado/);
    assert.doesNotMatch(unsupported.nodes.get('error-text').textContent, /[\u4e00-\u9fff]/);
    assert.equal(unsupported.nodes.get('classic-view').href, undefined);
    unsupported.nodes.get('error-retry').onclick(); assert.equal(unsupported.counts().reloads, 1);
    assert.equal(unsupported.location.href, 'https://example.test/k/ACCESS?target=lite#k=SECRET');

    const components = await fixture('legacy-events', { language, missingLegacy: true, missingUI: true, fastTimers: true });
    const text = components.nodes.get('error-text').textContent;
    assert.match(text, language === 'en' ? /Legacy DSH connector/ : /Conector de DSH anterior/);
    assert.match(text, language === 'en' ? /Phone interface/ : /Interfaz del teléfono/);
    assert.match(text, /\/dsh-lite-legacy\.js/); assert.match(text, /\/dsh-lite-ui\.js/);
    assert.doesNotMatch(text, /\{components\}|\{name\}|\{path\}|[\u4e00-\u9fff]/);
    assert.deepEqual(components.scripts, ['/dsh-lite-legacy.js','/dsh-lite-ui.js','/dsh-lite-legacy.js','/dsh-lite-ui.js']);

    const httpError = await fixture('remote-mux', { language, httpStatus: 503 });
    assert.match(httpError.nodes.get('error-text').textContent, /HTTP 503/);
    assert.doesNotMatch(httpError.nodes.get('error-text').textContent, /\{status\}|[\u4e00-\u9fff]/);
    assert.deepEqual(httpError.scripts, []); assert.equal(httpError.mounts.length, 0);
    const proofError = await fixture('remote-mux', { language, proof: false });
    assert.match(proofError.nodes.get('error-text').textContent, language === 'en' ? /device authorization/ : /autorización del dispositivo/);
    assert.equal(proofError.counts().fetchCalls, 0, 'localization never bypasses a failed proof to query runtime');
    const networkError = await fixture('remote-mux', { language, fetchFails: true });
    assert.equal(networkError.nodes.get('error-text').textContent, language === 'en'
      ? 'Could not connect to DSH. Please retry.' : 'No se pudo conectar con DSH. Vuelve a intentarlo.');
    assert.doesNotMatch(networkError.nodes.get('error-text').textContent, /private|transport details/);
  }
  assert.doesNotMatch(missing.nodes.get('error-text').textContent, /\{components\}|\{name\}|\{path\}/,
    'Chinese fallback still formats dynamic guidance when the language module is unavailable');
  console.log('DSH phone adapter router: bounded recovery, protocol/auth gates and actual English/Spanish startup guidance passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
