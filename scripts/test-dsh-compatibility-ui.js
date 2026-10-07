'use strict';
// Execute the actual compatibility-panel and button-label functions in a
// small DOM. These are UI contract checks, not live DSH workflow acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction, sliceBalanced } = require('./page-source.js');
const { buildFeatureCapabilities } = require('./dsh-feature-capabilities.js');
const source = fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite-ui.js'), 'utf8');
const marker = 'composerPicksRelabel = function ()';
const at = source.lastIndexOf(marker), open = source.indexOf('{', at);
const close = sliceBalanced(source, open, '{', '}');
assert.ok(at >= 0 && close > open);
const relabel = source.slice(at, close + 1) + ';';
let checks = 0;
function equal(a, b, label) { assert.deepEqual(a, b, label); checks++; }
function check(value, label) { assert.ok(value, label); checks++; }
class Node {
  constructor(tag, cls, text) { this.tagName = tag; this.className = cls || ''; this.ownText = text || ''; this.children = []; this.attrs = {}; this.events = {}; this.disabled = false; this.isConnected = true; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.ownText = value; this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.ownText = ''; this.children = nodes; }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) { return this.attrs[name]; }
  addEventListener(name, action) { this.events[name] = action; }
}
function runtime(profile = 'remote-mux', overrides = {}) {
  const value = { profile, kind: 'cli', version: profile === 'legacy-events' ? '0.1.0-rc.8' : '0.2.0-rc.2',
    running: true, supported: true, httpEvidence: 'dsh-app-html', ...overrides };
  value.featureCapabilities = buildFeatureCapabilities(value);
  return value;
}
function fixture(value, translate = text => text) {
  const picks = [['model', '模型', '选择模型'], ['mode', '工具组', '工具配置'], ['perm', '授权范围', '选择授权范围'], ['goal', '目标', '计划/目标']];
  const holder = new Node('div'); holder.append(...picks.map(item => new Node('button', '', item[1])));
  const refs = { railSettings: new Node('button'), composerBalance: new Node('button') };
  let overlayBody, requests = 0, fetchResponse;
  const box = vm.createContext({ holder, picks, refs, Array, AbortController, setTimeout, clearTimeout,
    state: { selection: {}, disposed: false }, connectionInfo: { profile: value.profile, runtime: value },
    adapter: { profile: value.profile }, t: translate, composerPicksRelabel: null,
    el: (tag, cls, text) => new Node(tag, cls, text), closeSettingsMenu() {},
    overlay(_title, render) { overlayBody = new Node('section'); render(overlayBody); },
    window: { fetch: async (url, options) => { requests++; equal(url, '/__targets', 'Refresh reads the existing runtime endpoint'); equal(options.credentials, 'same-origin', 'Refresh retains device authentication'); return typeof fetchResponse === 'function' ? fetchResponse() : fetchResponse; } }
  });
  vm.runInContext(extractFunction(source, 'interfaceState') + '\n' + relabel + '\n' + extractFunction(source, 'showCompatibility'), box);
  box.composerPicksRelabel();
  return { box, holder, refs, open() { box.showCompatibility(); return overlayBody; },
    respond(value) { fetchResponse = value; }, requests: () => requests };
}
function rows(body) { return body.children[0].children.filter(item => item.className.includes('compatibility-row')); }
function renderedStatuses(body) { return rows(body).map(item => item.children[1].textContent); }
function action(body) { return body.children[1].events.click(); }

function backgroundErrorEventsChecks() {
  // Execute the production event/error functions, not a duplicate of their
  // matching rule. A successful background read must have no authority over
  // an operation, auth, key, replay-storage or uncertain-submission error.
  const error = { hidden: true, dataset: {} }, errorText = new Node('div');
  const input = { value: 'Unsent draft stays exactly here' }, list = new Node('div');
  const retainedRow = new Node('article', '', 'Retained conversation'); list.append(retainedRow);
  const refs = { error, errorText, input, list };
  const state = { disposed: false, sessionId: 'A', connection: 'connected' };
  const fixed = '暂时无法刷新旧版内容，已保留当前内容并继续重试。';
  const translated = 'Could not refresh older DSH content. Current content is retained and retrying.';
  const box = vm.createContext({ refs, state, t: text => text === fixed ? translated : text,
    setStatus(value) { state.connection = value; },
    renderProjects() { throw new Error('Background warning must not render projects'); },
    renderTitle() { throw new Error('Background warning must not navigate'); },
    mergeRecords() { throw new Error('Background warning must not replace records'); }
  });
  vm.runInContext(['safeId', 'safeError', 'showError', 'clearError', 'handleEvent']
    .map(name => extractFunction(source, name)).join('\n'), box);
  const event = (type, overrides = {}) => ({ type, tag: 'legacy-poll', sessionId: 'A', ...overrides });
  function retained(label) {
    equal(input.value, 'Unsent draft stays exactly here', label + ': draft retained');
    equal(list.children, [retainedRow], label + ': records retained');
    equal(state.sessionId, 'A', label + ': selection retained');
  }
  box.handleEvent(event('background-read-warning', { userMessage: 'PRIVATE_UNTRUSTED_ERROR' }));
  equal(error.hidden, false, 'A current transient background warning is visible');
  equal(error.dataset, { kind: 'background-read', backgroundReadTag: 'legacy-poll', backgroundReadSession: 'A' },
    'Background error carries only the exact tag and conversation scope');
  equal(errorText.textContent, translated, 'A background warning uses the registered localization, not an upstream error');
  retained('Background warning');
  box.handleEvent(event('background-read-recovered'));
  equal(error.hidden, true, 'Only the matching background warning is cleared on recovery');
  equal(error.dataset, {}, 'Clearing the warning removes its old scope');
  retained('Background recovery');

  for (const kind of ['operation', 'auth', 'key', 'replay-storage', 'mutation', 'uncertain', 'connection']) {
    box.handleEvent(event('background-read-warning'));
    box.showError({ userMessage: 'Preserve ' + kind }, 'fallback', kind);
    equal(error.dataset, { kind }, 'A stronger error removes the obsolete background tag: ' + kind);
    box.handleEvent(event('background-read-warning'));
    box.handleEvent(event('background-read-recovered'));
    equal(error.hidden, false, 'Background success cannot clear a stronger error: ' + kind);
    equal(errorText.textContent, 'Preserve ' + kind, 'Background retry cannot overwrite a stronger error: ' + kind);
    equal(error.dataset.kind, kind, 'Error ownership is retained: ' + kind);
    box.clearError();
  }
  box.handleEvent(event('background-read-warning'));
  box.handleEvent({ type: 'error', userMessage: 'The write was sent but could not be confirmed' });
  box.handleEvent(event('background-read-recovered'));
  equal(errorText.textContent, 'The write was sent but could not be confirmed', 'The actual generic error event overrides background status and stays visible');
  equal(error.dataset.kind, 'operation', 'The actual operation event cannot inherit a background tag');
  box.clearError();

  for (const overrides of [{ tag: 'other-poll' }, { sessionId: 'B' }, { sessionId: 0 }, { sessionId: undefined }]) {
    box.handleEvent(event('background-read-warning', overrides));
    equal(error.hidden, true, 'Invalid/stale warning cannot become current: ' + JSON.stringify(overrides));
    box.handleEvent(event('background-read-warning'));
    box.handleEvent(event('background-read-recovered', overrides));
    equal(error.hidden, false, 'Invalid/stale success cannot clear the current warning');
    box.clearError();
  }
  for (const connection of ['connecting', 'disconnected']) {
    state.connection = connection;
    box.handleEvent(event('background-read-warning'));
    equal(error.hidden, true, 'A non-connected page cannot accept a warning: ' + connection);
    state.connection = 'connected'; box.handleEvent(event('background-read-warning'));
    state.connection = connection; box.handleEvent(event('background-read-recovered'));
    equal(error.hidden, false, 'A non-connected page cannot accept recovery: ' + connection);
    box.clearError();
  }
  state.connection = 'connected'; box.handleEvent(event('background-read-warning'));
  state.disposed = true; box.handleEvent(event('background-read-recovered'));
  equal(error.hidden, false, 'A retired mount cannot clear an existing warning');
  box.clearError(); box.handleEvent(event('background-read-warning'));
  equal(error.hidden, true, 'A retired mount cannot add a warning');
  state.disposed = false;
  retained('All scoped background events');
}

(async () => {
  // Render the actual dynamic feature labels with the production dictionary.
  // The static literal-key scan cannot see t(label) and missed three labels
  // during real browser operation of the English compatibility panel.
  for (const locale of ['en', 'es']) {
    const translations = { navigator: { languages: [locale], language: locale },
      localStorage: { getItem: () => locale, setItem() {}, removeItem() {} },
      document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } };
    translations.window = translations;
    vm.createContext(translations);
    for (const script of ['i18n.js', 'dsh-lite-lang.js'])
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../pwa', script), 'utf8'), translations);
    const translated = fixture(runtime(), translations.DshI18n.t);
    const panel = translated.open();
    equal(rows(panel).length, 19, 'Localized coverage retains all interfaces: ' + locale);
    check(!/[\u3400-\u9fff]/u.test(panel.textContent), 'All dynamic compatibility labels are translated: ' + locale);
  }
  const modern = fixture(runtime());
  equal(modern.holder.children.map(item => item.disabled), [false, false, false, false], 'Recognized modern interfaces remain available without a fake workflow pass');
  let body = modern.open();
  equal(rows(body).length, 19, 'Every implemented feature, including tool presets, is visible');
  check(renderedStatuses(body).every(item => item === '接口已实现'), 'Modern UI labels interfaces, not model/phone acceptance');
  check(body.textContent.includes('不等于这个版本、模型和手机已经通过完整实测'), 'The human-acceptance limitation is explicit');
  check(!body.textContent.includes('已通过实测'), 'No historical pass is invented');
  check(body.textContent.includes('npm Web 版 · 0.2.0-rc.2'), 'The exact distribution and version are displayed');
  const legacy = fixture(runtime('legacy-events'));
  equal(legacy.holder.children.map(item => item.disabled), [false, false, true, true], 'Implemented legacy model/tools remain available while absent permission/goal interfaces are disabled');
  check(legacy.holder.children.filter(item => item.disabled).every(item => /当前连接未提供/.test(item.getAttribute('aria-label'))), 'Disabled controls have explanatory accessible labels');
  body = legacy.open();
  const tool = rows(body).find(item => item.children[0].textContent === '工具配置');
  equal(tool.children[1].textContent, '接口已实现', 'The new legacy tool adapter is distinct from untested workflow acceptance');
  const reasoning = rows(body).find(item => item.children[0].textContent === '思考过程');
  equal(reasoning.children[1].textContent, '接口已实现', 'The implemented legacy reasoning renderer and mapped model efforts are not falsely labeled absent');
  check(body.textContent.includes('已自动选择旧版连接方式'), 'Legacy protocol choice remains visible');
  const unknown = fixture(runtime('remote-mux', { running: false }));
  equal(unknown.holder.children.map(item => item.disabled), [false, false, false, false], 'Unverified is distinct from an absent interface');
  check(renderedStatuses(unknown.open()).every(item => item === '尚未验证'), 'Offline evidence cannot become supported or accepted');
  const missing = fixture({ profile: 'legacy-events', version: 'PRIVATE_PATH_SECRET', kind: 'unexpected' });
  body = missing.open();
  check(!body.textContent.includes('PRIVATE_PATH_SECRET'), 'Untrusted version strings never reach the panel');
  check(body.textContent.includes('来源未确认') && body.textContent.includes('版本未确认'), 'Missing source/version metadata has honest fallback');
  check(renderedStatuses(body).every(item => item === '尚未验证'), 'Old servers without capability metadata are not given fictitious coverage');

  body = modern.open();
  const absent = runtime('remote-mux', { featureObservations: { toolPresets: { basis: 'read-only-interface', interface: 'absent' } } });
  modern.respond({ ok: true, json: async () => ({ targets: [{ id: 'dsh', runtime: absent }] }) });
  await action(body);
  equal(modern.requests(), 1, 'Refresh is one read-only request');
  equal(modern.holder.children[1].disabled, true, 'A fresh authoritative absent interface disables the tool picker');
  check(body.children[2].textContent.includes('已重新检测'), 'Successful refresh is visible');
  const prior = modern.box.connectionInfo;
  modern.respond({ ok: true, json: async () => ({ targets: [{ id: 'dsh', runtime: runtime('legacy-events') }] }) });
  await action(body);
  equal(modern.box.connectionInfo, prior, 'A changed protocol never overwrites the connected adapter metadata');
  check(body.children[2].textContent.includes('版本已变化'), 'Changed protocol requests a real reconnect');
  modern.respond({ ok: false, status: 403 });
  await action(body);
  equal(modern.box.connectionInfo, prior, 'Authentication failure retains previous capability evidence');
  check(body.children[2].textContent.includes('保留上次结果'), 'Refresh error is explicit rather than inventing absence');
  equal(body.children[1].disabled, false, 'A failed refresh remains retryable');
  const retired = fixture(runtime());
  const retiredInfo = retired.box.connectionInfo;
  const retiredBody = retired.open();
  let resolveRefresh;
  retired.respond(() => new Promise(resolve => { resolveRefresh = resolve; }));
  const pendingRefresh = action(retiredBody);
  retired.box.state.disposed = true;
  resolveRefresh({ ok: true, json: async () => ({ targets: [{ id: 'dsh', runtime: absent }] }) });
  await pendingRefresh;
  equal(retired.box.connectionInfo, retiredInfo, 'A retired UI mount cannot accept late compatibility metadata');
  equal(retired.holder.children[1].disabled, false, 'A retired refresh cannot relabel reused composer buttons');
  const closed = fixture(runtime());
  const closedInfo = closed.box.connectionInfo;
  const closedBody = closed.open();
  let resolveClosedRefresh;
  closed.respond(() => new Promise(resolve => { resolveClosedRefresh = resolve; }));
  const closedRefresh = action(closedBody);
  closedBody.isConnected = false;
  resolveClosedRefresh({ ok: true, json: async () => ({ targets: [{ id: 'dsh', runtime: absent }] }) });
  await closedRefresh;
  equal(closed.box.connectionInfo, closedInfo, 'A closed panel cannot accept a late detection result');
  equal(closed.holder.children[1].disabled, false, 'Closing a detection panel preserves composer capability state');
  backgroundErrorEventsChecks();
  console.log('DSH compatibility panel contract checks passed: ' + checks);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
