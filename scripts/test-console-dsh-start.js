'use strict';
// Exercise the production router and UI functions with owned HTTP/DOM fixtures.
// No gateway, account, desktop application, native process or private file is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { extractFunction, extractRegisterArg } = require('./page-source.js');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../pwa/console.html'), 'utf8');
let checks = 0, starts = 0, authReads = 0;
let start = async lang => ({ ok: true, message: 'Started ' + lang });
const context = vm.createContext({ URL, Buffer, Promise, Number, Object,
  requestOrigin: require('./request-origin.js'),
  privateHttpsAdmission: require('./private-https-admission.js'),
  cfg: { loadConfig: () => ({ privateHttps: { enabled: false, origin: '' } }) },
  installCookieMerger() {}, migrateLegacyRequestCookies() {},
  keyMatches: () => false,
  PWA_ROUTES: {}, E2EE_CONTENT_PATHS: new Set(),
  dshLazyImageStore: { imageDigestFromPath: () => null },
  desktopLifecycle: { status: () => ({ phase: 'running' }) },
  pickLang: () => 'en', log() {}, pageLanguage: () => 'en',
  pageText: () => ({ errors: { noKey: 'access key required: ' } }),
  hasAuthCookie() { authReads++; return false; },
  require(name) {
    assert.equal(name, './targets.js', 'only the DSH target may be loaded');
    return { dsh: { async start(lang) { starts++; return start(lang); } } };
  }
});
vm.runInContext('let consoleDshStartPending = null;', context);
for (const name of ['isLoopback', 'requestConsoleDshStart', 'handleConsole', 'handleRequestInner']) {
  vm.runInContext((name === 'requestConsoleDshStart' ? 'async ' : '') + extractFunction(source, name), context);
}
const server = http.createServer((req, res) => context.handleRequestInner(req, res, 0));
function request(headers = {}, body = { action: 'start-dsh' }, pathname = '/__console/action', method = 'POST') {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method,
      headers: { host: '127.0.0.1:' + port, origin: 'http://127.0.0.1:' + port,
        'content-type': 'application/json', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
async function check(name, test) { await test(); checks++; console.log('PASS ' + name); }
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitUntil(fn) {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(fn(), 'owned fixture must reach its controlled boundary');
}
function element(tagName = 'div') {
  return { tagName: tagName.toUpperCase(), children: [], textContent: '', style: {}, disabled: false,
    set innerHTML(value) { this._innerHTML = value; this.children = []; },
    get innerHTML() { return this._innerHTML || ''; }, appendChild(child) { this.children.push(child); } };
}
const dictionary = vm.runInNewContext('(' + extractRegisterArg(html) + ')');
function ui(response, lang = 'en') {
  const requests = [], notices = [], box = element(), targets = [{ id: 'dsh', short: 'DSH', installed: true, running: false }];
  let loads = 0;
  const page = vm.createContext({ Promise, Error, Object, targetStartPending: null,
    state: { data: { targets } }, document: { createElement: element }, $: () => box,
    t(text, params) {
      let value = lang === 'zh' ? text : dictionary[text]?.[lang] || text;
      for (const [name, replacement] of Object.entries(params || {})) value = value.replace('{' + name + '}', replacement);
      return value;
    }, tr(text, params) { return page.t(text, params); }, esc: String, desktopIcon: () => '',
    mkBtn(text, className, onclick) { return { ...element('button'), textContent: text, className, onclick }; },
    toast(text) { notices.push(text); },
    fetch(url, options) { requests.push({ url, options }); return response(); },
    load() { loads++; targets[0].running = true; return Promise.resolve(); },
    window: { open() {} }
  });
  for (const name of ['renderTargets', 'readConsoleActionResponse', 'targetAction']) vm.runInContext(extractFunction(html, name), page);
  page.renderTargets(targets);
  return { page, requests, notices, targets, box, loads: () => loads,
    controls: () => box.children[0].children[0].children };
}
const jsonResponse = data => ({ ok: true, status: 200, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => data });

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.PORT = server.address().port; context.HTTPS_PORT = context.PORT + 1;
  try {
    await check('the actual local console route dispatches Start without a phone cookie exactly once', async () => {
      const before = starts, authBefore = authReads;
      const result = await request();
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).code, 'dsh-start-complete');
      assert.equal(starts, before + 1); assert.equal(authReads, authBefore);
      assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['access-control-allow-origin'], undefined);
    });
    const port = context.PORT, local = '127.0.0.1:' + port;
    for (const headers of [
      { host: 'public.invalid', origin: 'http://public.invalid' },
      { host: '192.0.2.10:' + port, origin: 'http://192.0.2.10:' + port },
      { host: '127.0.0.1:' + (port + 2), origin: 'http://127.0.0.1:' + (port + 2) },
      { origin: undefined }, { origin: 'null' }, { origin: 'https://' + local },
      { origin: 'http://evil.invalid' }, { origin: 'http://' + local + '/' },
      { 'sec-fetch-site': 'cross-site' },
      ...['cf-connecting-ip', 'cf-ray', 'cf-worker', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
        'forwarded', 'x-real-ip', 'true-client-ip', 'via', 'x-original-host'].map(name => ({ [name]: 'fixture' }))
    ]) {
      await check('untrusted local-control source cannot dispatch: ' + JSON.stringify(headers), async () => {
        const before = starts;
        const filtered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, value === undefined ? '' : value]));
        const result = await request(filtered);
        assert.equal(result.status, 403); assert.equal(starts, before);
      });
    }
    await check('a non-loopback socket is rejected even with exact local Host and Origin', async () => {
      const before = starts;
      const result = await context.requestConsoleDshStart({ method: 'POST', socket: { remoteAddress: '203.0.113.9' },
        headers: { host: local, origin: 'http://' + local, 'content-type': 'application/json' } }, { action: 'start-dsh' });
      assert.equal(result.status, 403); assert.equal(starts, before);
    });
    for (const host of ['localhost:' + port, '[::1]:' + port]) {
      await check('an exact literal loopback authority is allowed: ' + host, async () => {
        assert.equal((await request({ host, origin: 'http://' + host })).status, 200);
      });
    }
    await check('wrong content type, extra fields, malformed JSON and oversized bodies never launch DSH', async () => {
      const before = starts;
      assert.equal((await request({ 'content-type': 'text/plain' })).status, 415);
      assert.equal((await request({}, { action: 'start-dsh', target: 'codex' })).status, 400);
      for (const body of ['{', 'null', '[]']) assert.equal((await request({}, body)).status, 200);
      assert.equal((await request({}, ' '.repeat(65537))).status, 413);
      assert.equal(starts, before);
    });
    await check('the unchanged phone target route still rejects an unauthenticated request', async () => {
      const before = starts, authBefore = authReads;
      const result = await request({}, { target: 'dsh', action: 'start' }, '/__targets/action');
      assert.equal(result.status, 403); assert.match(result.text, /access key required/);
      assert.equal(authReads, authBefore + 1); assert.equal(starts, before);
    });
    await check('simultaneous console requests admit one upstream start and release the slot only on completion', async () => {
      let release; const before = starts;
      start = () => new Promise(resolve => { release = resolve; });
      const first = request(); await waitUntil(() => starts === before + 1);
      const second = await request(); assert.equal(second.status, 409); assert.equal(JSON.parse(second.text).code, 'dsh-start-in-progress');
      assert.equal(starts, before + 1); release({ ok: true, message: 'Ready' });
      assert.equal((await first).status, 200);
      start = async () => ({ ok: true, message: 'Already running', already: true });
      assert.equal(JSON.parse((await request()).text).already, true); assert.equal(starts, before + 2);
    });
    await check('target failure and gateway shutdown produce bounded JSON errors without native redispatch', async () => {
      start = async () => { throw Error('PRIVATE fixture exception'); };
      const result = await request(); assert.equal(result.status, 503); assert.doesNotMatch(result.text, /PRIVATE/);
      const before = starts; context.desktopLifecycle.status = () => ({ phase: 'draining' });
      assert.equal((await request()).status, 503); assert.equal(starts, before);
      context.desktopLifecycle.status = () => ({ phase: 'running' });
    });
    await check('real Start button uses local controls, coalesces clicks and remains disabled after polling rerender', async () => {
      let deliver;
      const f = ui(() => new Promise(resolve => { deliver = resolve; }));
      const button = f.controls()[0]; button.onclick(); button.onclick(); await flush();
      assert.equal(f.requests.length, 1); assert.equal(f.controls()[0].disabled, true);
      f.page.renderTargets(f.targets); assert.equal(f.controls()[0].disabled, true);
      f.controls()[0].onclick(); assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].url, '/__console/action');
      assert.deepEqual(JSON.parse(f.requests[0].options.body), { action: 'start-dsh' });
      assert.equal(f.requests[0].options.credentials, 'same-origin');
      const pending = f.page.targetStartPending; deliver(jsonResponse({ ok: true, message: 'DSH ready' })); await pending;
      assert.equal(f.loads(), 1); assert.equal(f.page.targetStartPending, null);
      assert.equal(f.controls().filter(control => control.tagName === 'BUTTON').length, 1, 'Open is the only running-state button');
      assert.match(f.controls()[1].textContent, /quit from the DSH application/);
    });
    for (const lang of ['zh', 'en', 'es']) {
      for (const kind of ['text-403', 'text-502', 'bad-json', 'json-error', 'array-json']) {
        await check('clear localized startup response failure: ' + lang + '/' + kind, async () => {
          let parsed = 0;
          const f = ui(async () => ({ ok: kind === 'bad-json' || kind === 'array-json', status: kind === 'text-403' ? 403 : 502,
            headers: { get: () => kind.startsWith('text') ? 'text/plain' : 'application/json' },
            async json() { parsed++; if (kind === 'bad-json') throw Error('Unexpected token PRIVATE'); return kind === 'array-json' ? [] : { ok: false }; }
          }), lang);
          await f.page.targetAction('dsh', 'start', 'DSH');
          assert.equal(f.page.targetStartPending, null); assert.equal(f.loads(), 0);
          assert.equal(f.controls()[0].disabled, false, 'failed startup restores an enabled Start button');
          assert.doesNotMatch(f.notices.join(' '), /Unexpected token|PRIVATE|access key/);
          if (kind.startsWith('text')) assert.equal(parsed, 0);
          if (lang !== 'zh') assert.doesNotMatch(f.notices.join(' '), /[\u4e00-\u9fff]/);
        });
      }
    }
    console.log(checks + ' local DSH startup checks passed; no native process or private data used.');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
