'use strict';

// Execute the unchanged UI script with only its pre-mount DOM. No server,
// browser install, credentials, encryption key or real adapter is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'pwa', name), 'utf8');
const ui = read('dsh-lite-ui.js');
const i18n = read('i18n.js');
const dictionary = read('dsh-lite-lang.js');
const messages = {
  zh: ['正在识别 DSH 版本', '连接组件不可用',
    'DSH 手机版的连接组件未加载。请重新打开页面，或检查桥是否已更新。', '重试', '重连'],
  en: ['Identifying the DSH version', 'Connection component unavailable',
    'The DSH mobile connection component did not load. Reopen this page, or check whether the bridge has been updated.', 'Retry', 'Reconnect'],
  es: ['Identificando la versión de DSH', 'Componente de conexión no disponible',
    'No se cargó el componente de conexión de DSH para móviles. Vuelve a abrir esta página o comprueba si el puente se ha actualizado.', 'Reintentar', 'Reconectar']
};

function fixture(options = {}) {
  const effects = { network: 0, writes: 0, navigation: 0, reloads: 0, timers: 0, mountEntries: 0 };
  const blocked = name => () => { effects[name]++; throw new Error('Unexpected ' + name); };
  const events = new Map();
  const nodes = new Map(['connection-status', 'error-banner', 'error-text', 'error-retry', 'reconnect']
    .map(id => [id, { id, textContent: '', dataset: {}, hidden: id === 'error-banner', onclick: null,
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }]));
  for (const node of nodes.values()) {
    Object.defineProperty(node, 'innerHTML', { set: blocked('writes') });
  }
  nodes.get('error-retry').textContent = '重试';
  nodes.get('reconnect').textContent = '重连';
  const document = {
    readyState: options.readyState || 'loading',
    getElementById: id => nodes.get(id) || null,
    documentElement: { setAttribute() {} },
    querySelectorAll: () => [],
    createElement: blocked('network'),
    addEventListener(type, fn, settings) {
      if (!events.has(type)) events.set(type, []);
      events.get(type).push({ fn, once: Boolean(settings && settings.once) });
    }
  };
  Object.defineProperty(document, 'cookie', { get: () => '', set: blocked('writes') });
  const location = { reload() { effects.reloads++; } };
  Object.defineProperty(location, 'href', {
    get: () => 'https://bridge.example.invalid/k/SYNTHETIC#k=SYNTHETIC', set: blocked('navigation')
  });
  const localStorage = {
    getItem(key) {
      assert.equal(key, 'dsh-lang', 'pre-mount localization only reads its existing language preference');
      if (options.blockStorage) throw new Error('Storage blocked');
      return options.stored || null;
    },
    setItem: blocked('writes'), removeItem: blocked('writes'), clear: blocked('writes')
  };
  const context = vm.createContext({
    document, location, localStorage,
    sessionStorage: { getItem: blocked('writes'), setItem: blocked('writes'), removeItem: blocked('writes') },
    navigator: {
      languages: options.languages === undefined ? ['en-US'] : options.languages,
      language: options.language,
      sendBeacon: blocked('network')
    },
    fetch: blocked('network'), XMLHttpRequest: blocked('network'), WebSocket: blocked('network'),
    setTimeout: blocked('timers'), setInterval: blocked('timers'),
    __dshLiteDeferAutoMount: options.defer === true
  });
  context.window = context;
  if (options.blockNavigator) Object.defineProperty(context, 'navigator', {
    get() { throw new Error('Navigator blocked'); }
  });
  if (options.bundle === 'i18n' || options.bundle === 'full') {
    vm.runInContext(i18n, context, { filename: 'pwa/i18n.js' });
    if (options.bundle === 'full') vm.runInContext(dictionary, context, { filename: 'pwa/dsh-lite-lang.js' });
  } else if (options.bundle === 'dictionary-only') {
    vm.runInContext(dictionary, context, { filename: 'pwa/dsh-lite-lang.js' });
  }
  if (options.i18nOverride) context.DshI18n = options.i18nOverride;
  // An existing i18n module may have mirrored an already-saved preference.
  // Only effects of the actual UI startup under test are counted below.
  for (const key of Object.keys(effects)) effects[key] = 0;
  const mountSentinel = new Error('Reached the actual mount adapter guard');
  const adapter = {};
  Object.defineProperty(adapter, 'connect', { get() { effects.mountEntries++; throw mountSentinel; } });
  if (options.adapter) context.DshLiteAdapter = adapter;
  function fire(type) {
    for (const item of (events.get(type) || []).slice()) {
      if (item.once) events.set(type, events.get(type).filter(entry => entry !== item));
      item.fn();
    }
  }
  function run() { vm.runInContext(ui, context, { filename: 'pwa/dsh-lite-ui.js' }); }
  return { context, nodes, effects, events, fire, run, adapter, mountSentinel };
}

function verify(options, language) {
  const f = fixture(options);
  if (options.bundle === 'full') {
    messages.zh.forEach((key, index) => assert.equal(f.context.DshI18n.t(key), messages[language][index],
      'the registered dictionary and emergency fallback must stay consistent'));
  }
  f.run();
  assert.equal(typeof f.context.DshLiteUI.mount, 'function');
  if (!options.readyState || options.readyState === 'loading') {
    assert.equal(f.nodes.get('connection-status').textContent, '', 'startup waits for the DOM');
    assert.equal(f.events.get('DOMContentLoaded').length, 1);
    assert.equal(f.events.get('DOMContentLoaded')[0].once, true);
    f.fire('DOMContentLoaded');
    f.fire('DOMContentLoaded');
  }
  const [waiting, unavailable, detail, retry, reconnect] = messages[language];
  assert.equal(f.nodes.get('connection-status').textContent, options.defer ? waiting : unavailable);
  assert.equal(f.nodes.get('error-retry').textContent, retry);
  assert.equal(f.nodes.get('reconnect').textContent, reconnect);
  for (const id of ['connection-status', 'error-text', 'error-retry', 'reconnect']) {
    assert.equal(f.nodes.get(id).attributes.lang, language === 'zh' ? 'zh-CN' : language,
      'fallback text declares its actual language without changing the document language');
  }
  assert.deepEqual(f.effects, { network: 0, writes: 0, navigation: 0, reloads: 0, timers: 0, mountEntries: 0 });
  if (options.defer) {
    assert.equal(f.nodes.get('error-banner').hidden, true);
    assert.equal(f.nodes.get('error-text').textContent, '');
    assert.equal(f.nodes.get('error-retry').onclick, null);
    assert.equal(f.nodes.get('reconnect').onclick, null);
  } else {
    assert.equal(f.nodes.get('error-banner').hidden, false);
    assert.equal(f.nodes.get('connection-status').dataset.state, 'disconnected');
    assert.equal(f.nodes.get('error-text').textContent, detail);
    for (const id of ['error-retry', 'reconnect']) {
      f.nodes.get(id).onclick();
      f.nodes.get(id).onclick();
    }
    assert.deepEqual(f.effects, { network: 0, writes: 0, navigation: 0, reloads: 4, timers: 0, mountEntries: 0 },
      'each explicit retry/reconnect still only reloads the current URL');
  }
  return f;
}

for (const language of ['zh', 'en', 'es']) {
  for (const bundle of ['none', 'i18n', 'dictionary-only', 'full']) {
    for (const defer of [false, true]) {
      for (const readyState of ['loading', 'complete']) {
        verify({ languages: [language + '-XX'], bundle, defer, readyState }, language);
      }
    }
  }
  verify({ languages: ['en-US'], stored: language }, language);
  verify({ languages: ['fr-FR', language.toUpperCase() + '-XX', 'en-US'] }, language);
  verify({ languages: [], language: language + '-XX', blockStorage: true }, language);
  verify({ languages: ['en-US'], stored: 'es', i18nOverride: { lang: () => language, t: value => value } }, language);
  verify({ languages: [language], i18nOverride: { lang() { throw new Error('Unavailable'); }, t() { throw new Error('Unavailable'); } } }, language);
}
verify({ languages: ['fr-FR', 'de-DE'], stored: 'unsupported' }, 'en');
verify({ languages: ['es-MX'], stored: '__proto__' }, 'es');
verify({ blockNavigator: true, blockStorage: true }, 'en');
verify({ languages: ['es'], i18nOverride: { lang: () => 'unsupported', t: () => null } }, 'es');
verify({ languages: ['es'], i18nOverride: { lang: () => 'es', t: () => '' } }, 'es');

// A registered translation remains authoritative; the local fallback is used
// only when lookup fails or the main dictionary returns its untranslated key.
const custom = fixture({ i18nOverride: { lang: () => 'en', t: value => 'translated:' + value } });
custom.run(); custom.fire('DOMContentLoaded');
assert.equal(custom.nodes.get('connection-status').textContent, 'translated:' + messages.zh[1]);

// Exercise the real mount entry guard rather than rewriting/stubbing start().
// The sentinel stops before application initialization or adapter side effects;
// successful full UI mounting is covered separately by test-dsh-lite-ui.js.
for (const readyState of ['loading', 'complete']) {
  const f = fixture({ adapter: true, readyState });
  if (readyState === 'loading') {
    f.run();
    assert.equal(f.effects.mountEntries, 0);
    assert.throws(() => f.fire('DOMContentLoaded'), error => error === f.mountSentinel);
  } else assert.throws(f.run, error => error === f.mountSentinel);
  assert.equal(f.effects.mountEntries, 1, 'an available adapter still mounts automatically');
}
const late = verify({ languages: ['es'], defer: true, adapter: true }, 'es');
late.fire('dsh-lite-adapter-ready');
assert.equal(late.effects.mountEntries, 0, 'router deferral still suppresses adapter-ready auto-mount');
late.context.__dshLiteDeferAutoMount = false;
assert.throws(() => late.fire('dsh-lite-adapter-ready'), error => error === late.mountSentinel);
assert.equal(late.effects.mountEntries, 1);
const missing = verify({ languages: ['en'] }, 'en');
missing.fire('dsh-lite-adapter-ready');
assert.equal(missing.effects.mountEntries, 0, 'a readiness event without an adapter is harmless');
missing.context.DshLiteAdapter = missing.adapter;
assert.throws(() => missing.fire('dsh-lite-adapter-ready'), error => error === missing.mountSentinel);
assert.equal(missing.effects.mountEntries, 1, 'a late adapter still follows the existing mount route');

console.log('PASS: ZH/EN/ES pre-mount guidance survives missing language scripts/storage; no network or persistent writes; retry and auto-mount entry behavior preserved.');
