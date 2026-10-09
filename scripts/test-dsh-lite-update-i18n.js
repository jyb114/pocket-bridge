'use strict';

// Actual emergency-updater bytes, isolated DOM/worker/HTTP doubles. No network,
// real Service Worker, credentials, gateway or model process is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'pwa', name), 'utf8');
const source = read('dsh-lite-update.js');
const i18n = read('i18n.js');
const dictionary = read('dsh-lite-lang.js');
const required = ['/dsh-lite-ui.js', '/dsh-lite-adapter.js', '/dsh-lite-pin.js', '/e2ee.js',
  '/dsh-lite-legacy.js', '/dsh-lite-router.js', '/dsh-lite-switch.js', '/i18n.js', '/dsh-lite-lang.js'];
const manifest = letter => ({ files: Object.fromEntries(required.map(file => [file, letter.repeat(64)])) });
const build = letter => Array(4).fill(letter.repeat(8)).join('-');
const workerReason = '新版本文件未能完整下载并验证；旧版本仍可用。';
const expected = {
  zh: {
    warning: /这个地址缺少加密密钥/, notice: /手机上的界面不是最新的/, phone: '手机上：', unknown: '未知',
    update: '更新到最新版', updating: '正在更新…', retry: '重试更新', verifying: '正在核验…', progress: /正在下载并核验新版文件/,
    fallback: '新版本文件未能完整下载并验证，手机仍在使用旧版。请重试更新。', worker: workerReason,
    manifest: '读不到代码指纹清单', invalid: '代码指纹清单无效', unavailable: 'Service Worker 尚未就绪',
    old: '手机还在使用旧版更新器。请刷新页面后重试，旧版仍可用。',
    waiting: '新版更新器尚未启用。请刷新页面后重试，旧版仍可用。',
    redundant: '新版更新器未能启用。请刷新页面后重试，旧版仍可用。'
  },
  en: {
    warning: /This link is missing the encryption key/, notice: /The interface on your phone is out of date/, phone: 'Phone:', unknown: 'Unknown',
    update: 'Update to the latest version', updating: 'Updating…', retry: 'Retry update', verifying: 'Verifying…', progress: /Downloading and verifying the new files/,
    fallback: 'The new files could not be fully downloaded and verified. Your phone is still using the old version. Retry the update.',
    worker: 'The new files could not be fully downloaded and verified; the old version is still available.',
    manifest: 'Could not read the code fingerprint manifest.', invalid: 'The code fingerprint manifest is invalid.', unavailable: 'The Service Worker is not ready yet.',
    old: 'Your phone is still using the old updater. Refresh this page and retry; the old version is still available.',
    waiting: 'The new updater is not active yet. Refresh this page and retry; the old version is still available.',
    redundant: 'The new updater could not activate. Refresh this page and retry; the old version is still available.'
  },
  es: {
    warning: /A este enlace le falta la clave de cifrado/, notice: /La interfaz del teléfono no está actualizada/, phone: 'Teléfono:', unknown: 'Desconocido',
    update: 'Actualizar a la última versión', updating: 'Actualizando…', retry: 'Reintentar actualización', verifying: 'Verificando…', progress: /Descargando y verificando los archivos nuevos/,
    fallback: 'No se pudieron descargar y verificar todos los archivos nuevos. El teléfono sigue usando la versión anterior. Vuelve a intentar la actualización.',
    worker: 'No se pudieron descargar y verificar todos los archivos nuevos; la versión anterior sigue disponible.',
    manifest: 'No se pudo leer el manifiesto de huellas del código.', invalid: 'El manifiesto de huellas del código no es válido.', unavailable: 'El Service Worker aún no está listo.',
    old: 'El teléfono sigue usando el actualizador anterior. Actualiza esta página y vuelve a intentarlo; la versión anterior sigue disponible.',
    waiting: 'El nuevo actualizador aún no está activo. Actualiza esta página y vuelve a intentarlo; la versión anterior sigue disponible.',
    redundant: 'No se pudo activar el nuevo actualizador. Actualiza esta página y vuelve a intentarlo; la versión anterior sigue disponible.'
  }
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const nodes = new Map(), docEvents = new Map(), swEvents = new Map(), workerEvents = new Map(), timers = new Map();
  const storage = new Map([['dsh-lite:build', build('a')]]);
  if (options.stored) storage.set('dsh-lang', options.stored);
  const writes = [], sent = [], requests = [];
  let nextTimer = 1, reloads = 0, updates = 0, cookieWrites = 0, currentManifest = manifest('a'), failure = null;
  const events = map => ({
    addEventListener(type, callback, settings) {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push({ callback, once: Boolean(settings && settings.once) });
    },
    removeEventListener(type, callback) {
      map.set(type, (map.get(type) || []).filter(item => item.callback !== callback));
    }
  });
  function emit(map, type, event) {
    for (const item of (map.get(type) || []).slice()) {
      if (item.once) map.set(type, map.get(type).filter(entry => entry !== item));
      item.callback(event);
    }
  }
  function element(tag) {
    const node = { tagName: tag.toUpperCase(), textContent: '', children: [], disabled: false, attributes: {}, style: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, callback) { this[type] = callback; },
      appendChild(child) { this.children.push(child); },
      querySelector(selector) { return this.children.find(child => child.tagName === selector.toUpperCase()) || null; }
    };
    Object.defineProperty(node, 'innerHTML', { set() { assert.fail('recovery text must never become HTML'); } });
    return node;
  }
  const body = { appendChild(node) { nodes.set(node.id, node); } };
  const document = { ...events(docEvents), hidden: false, body: options.noBody ? null : body,
    documentElement: { setAttribute() {} }, querySelectorAll: () => [],
    createElement: element, getElementById: id => nodes.get(id) || null };
  Object.defineProperty(document, 'cookie', { get: () => '', set() { cookieWrites++; } });
  const worker = { state: 'activated', postMessage(message) { sent.push(message); } };
  const incoming = { ...events(workerEvents), state: options.pendingState || 'installing',
    postMessage(message) { sent.push(message); } };
  const registration = { active: options.noWorker ? null : worker,
    update() { updates++; if (options.pendingState) this.installing = incoming; return Promise.resolve(); } };
  const serviceWorker = { ...events(swEvents), ready: Promise.resolve(registration), controller: worker };
  const localStorage = {
    getItem(key) {
      assert.ok(key === 'dsh-lang' || key === 'dsh-lite:build', 'only existing language/build preferences are read');
      if (options.blockStorage) throw new Error('Storage unavailable');
      return storage.get(key) || null;
    },
    setItem(key, value) { writes.push([key, value]); storage.set(key, value); },
    removeItem() { assert.fail('emergency localization cannot delete preferences'); }
  };
  const context = vm.createContext({ document, localStorage,
    navigator: { languages: options.languages || ['en-US'], language: options.language, serviceWorker },
    location: { hash: options.hash || '', reload() { reloads++; } },
    fetch(url, init) {
      requests.push([url, init]);
      assert.equal(url, '/code-manifest.json');
      assert.deepEqual(Object.keys(init), ['cache']); assert.equal(init.cache, 'no-store');
      if (failure && failure.kind === 'reject') return Promise.reject(failure.error);
      return Promise.resolve({ ok: !failure, status: failure ? 503 : 200, json: async () => currentManifest });
    },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    XMLHttpRequest() { assert.fail('unexpected transport'); }, WebSocket() { assert.fail('unexpected transport'); }
  });
  context.window = context;
  if (options.secret) context.__dshE2eeSecret = 'SYNTHETIC';
  if (options.bundle === 'i18n' || options.bundle === 'full') {
    vm.runInContext(i18n, context);
    if (options.bundle === 'full') vm.runInContext(dictionary, context);
  } else if (options.bundle === 'dictionary-only') vm.runInContext(dictionary, context);
  if (options.i18nOverride) context.DshI18n = options.i18nOverride;
  writes.length = 0; cookieWrites = 0;
  vm.runInContext(source, context, { filename: 'pwa/dsh-lite-update.js' });
  return {
    nodes, storage, writes, sent, requests, context,
    foreground() { emit(docEvents, 'visibilitychange'); },
    emit(data) { emit(swEvents, 'message', { data }); },
    showBody() { document.body = body; emit(docEvents, 'DOMContentLoaded'); },
    manifest(value) { currentManifest = value; },
    fail(value) { failure = value; },
    fireTimer(delay) {
      const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
      assert.ok(entry, 'expected the existing ' + delay + 'ms timer');
      timers.delete(entry[0]); entry[1].callback();
    },
    get reloads() { return reloads; }, get updates() { return updates; }, get cookieWrites() { return cookieWrites; }
  };
}

function textIs(node, language, value) {
  assert.ok(node);
  assert.equal(node.attributes.lang, language === 'zh' ? 'zh-CN' : language);
  if (value instanceof RegExp) assert.match(node.textContent, value);
  else assert.equal(node.textContent, value);
  if (language !== 'zh') assert.doesNotMatch(node.textContent, /[\u3400-\u9fff]/, 'owned recovery strings must not fall back to Chinese');
}
function untouched(f) {
  assert.equal(f.reloads, 0, 'a failed/pending update cannot reload');
  assert.equal(f.storage.get('dsh-lite:build'), build('a'), 'the old verified build is retained');
  assert.deepEqual(f.writes, [], 'localization and failures never change build/language storage');
  assert.equal(f.cookieWrites, 0, 'localization never mirrors a new language preference');
  assert.equal(f.context.__dshE2eeSecret, undefined, 'recovery must not fabricate a key');
}
async function shown(language, extra = {}) {
  const f = fixture({ languages: [language + '-XX'], ...extra });
  await tick();
  f.manifest(manifest('b')); f.foreground(); await tick();
  const notice = f.nodes.get('dsh-lite-update-notice');
  assert.ok(notice);
  textIs(notice.querySelector('span'), language, expected[language].notice);
  assert.ok(notice.querySelector('span').textContent.includes(expected[language].phone));
  textIs(notice.querySelector('button'), language, expected[language].update);
  assert.equal(f.requests.length, 2, 'localization does not add HTTP requests');
  assert.equal(f.updates, 0); assert.deepEqual(f.sent, []); untouched(f);
  return f;
}
async function beginVerified(f, language) {
  const button = f.nodes.get('dsh-lite-update-notice').querySelector('button');
  const previous = f.sent.length;
  button.click(); button.click();
  assert.equal(button.disabled, true);
  textIs(button, language, expected[language].updating);
  await tick();
  assert.equal(f.sent.length, previous + 1, 'repeated clicks only start one capability probe');
  const probe = f.sent.at(-1);
  assert.equal(probe.type, 'dsh-verified-update-capability');
  f.emit({ type: 'dsh-verified-update-ready', requestId: 'unrelated' }); await tick();
  assert.equal(f.sent.length, previous + 1);
  f.emit({ type: 'dsh-verified-update-ready', requestId: probe.requestId }); await tick();
  const request = f.sent.at(-1);
  assert.equal(request.type, 'dsh-repin-code-verified');
  assert.deepEqual(JSON.parse(JSON.stringify(request.manifest)), manifest('b'));
  return request;
}
function failed(f, language, detail) {
  const notice = f.nodes.get('dsh-lite-update-notice');
  textIs(notice.querySelector('span'), language, detail);
  textIs(notice.querySelector('button'), language, expected[language].retry);
  assert.equal(notice.querySelector('button').disabled, false);
  untouched(f);
}

(async () => {
  for (const language of ['zh', 'en', 'es']) {
    for (const bundle of ['none', 'i18n', 'dictionary-only', 'full']) {
      for (const noBody of [false, true]) {
        const f = fixture({ languages: ['fr-FR', language + '-XX'], bundle, noBody });
        if (noBody) {
          assert.equal(f.nodes.size, 0);
          f.emit({ type: 'dsh-code-mismatch', path: '/dsh-lite-ui.js' });
          f.showBody();
        }
        await tick();
        const warning = f.nodes.get('dsh-lite-key-warning');
        textIs(warning, language, expected[language].warning);
        assert.match(warning.textContent, /#k=/);
        f.fireTimer(2500);
        assert.equal(f.nodes.get('dsh-lite-key-warning'), warning, 'the delayed check does not duplicate the warning');
        if (noBody) textIs(f.nodes.get('dsh-lite-update-notice').querySelector('span'), language, expected[language].notice);
        assert.equal(f.requests.length, noBody ? 2 : 1);
        assert.deepEqual(f.sent, []); untouched(f);
      }
      const f = await shown(language, { bundle });
      const request = await beginVerified(f, language);
      f.fireTimer(15000);
      textIs(f.nodes.get('dsh-lite-update-notice').querySelector('button'), language, expected[language].verifying);
      textIs(f.nodes.get('dsh-lite-update-notice').querySelector('span'), language, expected[language].progress);
      assert.equal(f.nodes.get('dsh-lite-update-notice').querySelector('button').disabled, true);
      untouched(f);
      f.emit({ type: 'dsh-repin-verified-result', requestId: request.requestId, ok: false, reason: workerReason });
      failed(f, language, expected[language].worker);
      f.emit({ type: 'dsh-repin-verified-result', requestId: request.requestId, ok: true });
      untouched(f);
      const retry = await beginVerified(f, language);
      assert.notEqual(retry.requestId, request.requestId, 'retry has a fresh request identity');
      f.emit({ type: 'dsh-repin-verified-result', requestId: request.requestId, ok: true });
      untouched(f);
      f.emit({ type: 'dsh-repin-verified-result', requestId: retry.requestId, ok: false });
      failed(f, language, expected[language].fallback);
      f.emit({ type: 'dsh-repin-verified-result', requestId: retry.requestId, ok: true });
      untouched(f);
    }
    // Both rejected messages and blank rejection reasons take the same existing
    // failure transition and leave a usable retry without changing the build.
    for (const failure of [{ kind: 'http' }, { kind: 'reject', error: new Error('读不到代码指纹清单') },
      { kind: 'reject', error: null }, { kind: 'reject', error: new Error('') }]) {
      const f = await shown(language);
      f.fail(failure);
      f.nodes.get('dsh-lite-update-notice').querySelector('button').click(); await tick();
      failed(f, language, failure.kind === 'http' || failure.error && failure.error.message ? expected[language].manifest : expected[language].fallback);
      assert.deepEqual(f.sent, []); assert.equal(f.updates, 0);
      f.fail(null); const retry = await beginVerified(f, language);
      f.emit({ type: 'dsh-repin-verified-result', requestId: retry.requestId, ok: false });
      failed(f, language, expected[language].fallback);
    }
    const invalid = await shown(language);
    invalid.manifest({ files: {} });
    invalid.nodes.get('dsh-lite-update-notice').querySelector('button').click(); await tick();
    failed(invalid, language, expected[language].invalid);
    assert.deepEqual(invalid.sent, []);
    for (const [extra, error] of [[{ noWorker: true }, 'unavailable'], [{ pendingState: 'installing' }, 'waiting'], [{ pendingState: 'redundant' }, 'redundant'], [{}, 'old']]) {
      const f = await shown(language, extra);
      f.nodes.get('dsh-lite-update-notice').querySelector('button').click(); await tick();
      if (error === 'waiting' || error === 'old') { f.fireTimer(10000); await tick(); }
      failed(f, language, expected[language][error]);
      assert.equal(f.sent.length, error === 'old' ? 1 : 0, 'failed activation/capability never submits a repin');
    }
  }
  for (const [options, language] of [
    [{ stored: 'es', languages: ['en'] }, 'es'],
    [{ stored: 'unsupported', languages: ['fr', 'ES-419'] }, 'es'],
    [{ stored: '__proto__', languages: ['zh-CN'] }, 'zh'],
    [{ blockStorage: true, languages: [], language: 'es-MX' }, 'es'],
    [{ blockStorage: true, languages: ['fr'] }, 'en'],
    [{ languages: ['en'], i18nOverride: { lang: () => 'es', t: value => value } }, 'es'],
    [{ languages: ['es'], i18nOverride: { lang() { throw new Error('Unavailable'); }, t() { throw new Error('Unavailable'); } } }, 'es']
  ]) {
    const f = fixture(options); await tick();
    textIs(f.nodes.get('dsh-lite-key-warning'), language, expected[language].warning);
    assert.equal(f.cookieWrites, 0);
    assert.ok(f.writes.every(([key]) => key === 'dsh-lite:build'), 'no preference is written by localization');
  }
  for (const options of [{ secret: true }, { hash: '#k=SYNTHETIC' }]) {
    const f = fixture(options); await tick(); f.fireTimer(2500);
    assert.equal(f.nodes.has('dsh-lite-key-warning'), false, 'existing key/readiness conditions are unchanged');
  }
  console.log('PASS: emergency ZH/EN/ES guidance survives missing localization; actual failure/retry/timeout/worker events retain the old build and verified-update protocol.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
