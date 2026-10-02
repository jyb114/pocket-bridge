'use strict';
// Execute the actual console waiter/action/render functions with controlled
// HTTP responses and timers. No gateway action, native helper, or browser runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { extractFunction, extractRegisterArg } = require('./page-source.js');
const root = path.resolve(__dirname, '..');
if (process.platform === 'win32' && path.parse(root).root.toLowerCase() !== 'd:\\') throw Error('Run this isolated suite on D:.');
const source = fs.readFileSync(path.join(root, 'pwa', 'console.html'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
function check(name, test) { test(); passed++; console.log('PASS ' + name); }
function status(bootId = 'old-boot', phase = 'running', kind = null, code = null) {
  return { instanceId: 'persistent-installation', hostname: 'fixture', platform: 'win32',
    gateway: { running: true, bootId, desktopShutdown: { phase, kind, code } }, targets: [] };
}
function clock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const until = now + ms;
      for (let steps = 0; ; steps++) {
        if (steps > 1000) throw Error('Fixture timer did not settle.');
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn(); await flush();
      }
      now = until; await flush();
    }
  };
}
function harness(sequence = [], options = {}) {
  const timer = clock(), requests = [], notices = [], elements = Object.create(null);
  function element(id) {
    return elements[id] || (elements[id] = { className: '', textContent: '', innerHTML: '', children: [],
      appendChild(child) { this.children.push(child); } });
  }
  const state = { data: options.initial || status(), busy: false, restartWait: null };
  const box = {
    state, $: element, t: text => text, toast: text => notices.push(text),
    AbortController, Promise, Error, Date, Object,
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    addressChanging: false, mkBtn: text => ({ textContent: text }), bestEntry: () => null,
    renderTargets() {}, renderEntries() {}, renderDevices() {}, renderNotify() {},
    loadBalance() {}, loadCodexQuota() {}, renderAdvanced() {}, renderCodexProxy() {},
    applyI18n() {}, renderDesktopSummary() {},
    fetch(url, init) {
      requests.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      const next = sequence.length ? sequence.shift() : options.repeat;
      if (next === undefined || next === 'hang') return new Promise(() => {});
      if (next === 'gap') return Promise.reject(Error('fixture transport gap'));
      const response = next && next.response ? next : { data: next };
      return Promise.resolve({ ok: response.ok !== false, status: response.status || 200,
        json() { return response.jsonError ? Promise.reject(Error('fixture invalid JSON')) : Promise.resolve(response.data); } });
    }
  };
  vm.createContext(box);
  for (const name of ['restartFailureMessage', 'renderRestartWait', 'waitForRestart', 'load', 'action', 'render']) {
    const implementation = extractFunction(source, name);
    assert.ok(implementation, 'actual console function must exist');
    vm.runInContext(implementation, box, { filename: 'actual-console-' + name });
  }
  return { box, state, timer, requests, notices, elements, element };
}
function track(promise) {
  const result = { phase: 'pending' };
  promise.then(value => { result.phase = 'resolved'; result.value = value; },
    error => { result.phase = 'rejected'; result.error = error; });
  return result;
}
async function begin(h, boot = 'old-boot') {
  const result = track(h.box.waitForRestart('fixture scheduled restart', boot));
  await flush(); return result;
}
async function complete(h, result, data = status('new-boot')) {
  h.box.fetch = (url, init) => { h.requests.push({ url, init }); return Promise.resolve({ ok: true, json: () => Promise.resolve(data) }); };
  await h.timer.advance(500); assert.equal(result.phase, 'resolved');
  assert.equal(h.timer.pending(), 0);
}

(async () => {
  {
    const old = status(); old.instanceId = 'another-installation';
    const h = harness([old, status('old-boot', 'draining', 'restart'), status('old-boot', 'restarting', 'restart')]);
    const result = await begin(h);
    check('ordinary old-process status and changed installation identity do not complete a restart', () => assert.equal(result.phase, 'pending'));
    await h.timer.advance(500);
    check('a draining old gateway keeps waiting and never changes installation credentials', () => {
      assert.equal(result.phase, 'pending'); assert.equal(h.state.data.instanceId, 'persistent-installation');
    });
    await h.timer.advance(500);
    check('restart-helper startup on the old process is not recovery', () => assert.equal(result.phase, 'pending'));
    await complete(h, result);
    check('a different healthy boot confirms recovery without requiring a sampled connection gap', () => {
      assert.equal(result.value.gateway.bootId, 'new-boot'); assert.equal(h.state.restartWait, null);
      assert.ok(h.requests.every(request => request.url === '/__console/status' && !request.init.method && request.init.cache === 'no-store'));
    });
  }
  {
    const h = harness(['gap', status()]); const result = await begin(h);
    await h.timer.advance(500);
    check('a network gap followed by the same known boot never confirms recovery', () => assert.equal(result.phase, 'pending'));
    await complete(h, result);
  }
  {
    const notRunning = status('new-boot'); notRunning.gateway.running = false;
    const h = harness([status('new-boot', 'draining', 'restart'), status('new-boot', 'closed', 'shutdown'),
      status('new-boot', 'running', 'restart'), status('new-boot', 'running', null, 'desktop-drain-failed'),
      notRunning, status(''), {}, status('new-boot')]);
    const result = await begin(h);
    for (let i = 0; i < 6; i++) { assert.equal(result.phase, 'pending'); await h.timer.advance(500); }
    check('new boot identity alone, wrong lifecycle, inactive gateway and malformed status cannot resolve', () => assert.equal(result.phase, 'pending'));
    await h.timer.advance(500);
    check('only a running new gateway with a normal lifecycle confirms completion', () => assert.equal(result.phase, 'resolved'));
  }
  for (const code of ['desktop-drain-timeout', 'desktop-drain-failed', 'restart-helper-failed']) {
    const h = harness([status('old-boot', 'failed', 'restart', code)]); const result = await begin(h);
    check('terminal shutdown failure reports its actionable reason and cancels polling: ' + code, () => {
      assert.equal(result.phase, 'rejected'); assert.equal(result.error.restartWaitCode, 'restart-blocked');
      assert.equal(h.state.restartWait.phase, 'failed'); assert.match(result.error.message, /日志/);
      assert.equal(h.element('hero').className, 'hero bad'); assert.equal(h.timer.pending(), 0);
    });
  }
  {
    const h = harness([status('old-boot', 'failed', 'restart', 'untrusted error text')]); const result = await begin(h);
    check('unrecognized shutdown codes cannot expose backend error text', () => {
      assert.equal(result.phase, 'rejected'); assert.doesNotMatch(result.error.message, /untrusted/);
    });
  }
  {
    const h = harness([], { repeat: status('old-boot', 'draining', 'restart') }); const result = await begin(h);
    await h.timer.advance(120000);
    check('a gateway that remains reachable while draining reaches a failed bounded deadline', () => {
      assert.equal(result.phase, 'rejected'); assert.equal(result.error.restartWaitCode, 'restart-wait-timeout');
      assert.equal(h.timer.pending(), 0); assert.match(h.element('heroText').textContent, /未确认完成/);
    });
  }
  {
    let deliver;
    const h = harness([], { fetch: () => new Promise(resolve => { deliver = resolve; }) }); const result = await begin(h);
    const signal = h.requests[0].init.signal;
    await h.timer.advance(120000);
    check('an indefinitely hanging status request is aborted at the deadline', () => {
      assert.equal(result.phase, 'rejected'); assert.equal(signal.aborted, true); assert.equal(h.timer.pending(), 0);
    });
    deliver({ ok: true, json: () => Promise.resolve(status('new-boot')) }); await flush();
    check('a late healthy response cannot replace a timed-out result or failure notice', () => {
      assert.equal(result.phase, 'rejected'); assert.equal(h.state.restartWait.phase, 'failed');
    });
  }
  {
    const h = harness([status(), { response: true, ok: false, status: 503 }, { response: true, jsonError: true },
      status(), 'gap', {}, status('new-boot')]); const result = await begin(h, null);
    for (let i = 0; i < 3; i++) { assert.equal(result.phase, 'pending'); await h.timer.advance(500); }
    check('legacy waiting requires a transport gap; HTTP errors and invalid JSON are insufficient', () => assert.equal(result.phase, 'pending'));
    await h.timer.advance(500); await h.timer.advance(500);
    check('a legacy transport gap followed by malformed status still keeps waiting', () => assert.equal(result.phase, 'pending'));
    await h.timer.advance(500);
    check('legacy recovery resolves only after a transport gap and a healthy gateway', () => assert.equal(result.phase, 'resolved'));
  }
  {
    const data = { gateway: { running: true } };
    const h = harness([data, 'gap', data]); const result = await begin(h, null);
    assert.equal(result.phase, 'pending'); await h.timer.advance(500); await h.timer.advance(500);
    check('a gateway predating boot and lifecycle metadata uses the same gap-first fallback', () => assert.equal(result.phase, 'resolved'));
  }
  {
    const legacy = { gateway: { running: true } };
    const malformed = { gateway: { running: true, desktopShutdown: null } };
    const h = harness(['gap', malformed, status(''), legacy]); const result = await begin(h, null);
    await h.timer.advance(500); await h.timer.advance(500);
    check('explicit malformed lifecycle or empty boot fields cannot masquerade as healthy legacy status', () => assert.equal(result.phase, 'pending'));
    await h.timer.advance(500); assert.equal(result.phase, 'resolved');
  }
  {
    const h = harness([status('old-boot', 'draining', 'restart')]); const result = await begin(h);
    h.box.render(status());
    check('periodic status rendering cannot overwrite the pending restart notice with normal old-gateway status', () => {
      assert.equal(h.element('heroTitle').textContent, '正在重启服务…'); assert.equal(result.phase, 'pending');
    });
    h.box.fetch = () => Promise.reject(Error('fixture read failure')); await h.box.load();
    check('periodic load failure preserves the truthful waiting notice', () => assert.equal(h.element('heroTitle').textContent, '正在重启服务…'));
    await h.timer.advance(120000); h.box.render(status());
    check('an old gateway status cannot erase the terminal timeout report', () => assert.equal(h.element('heroTitle').textContent, '服务重启未完成'));
  }
  {
    const j = { ok: true, restarting: true, restartScheduled: true, restartBootId: 'old-boot', message: 'fixture scheduled' };
    const h = harness([j, status(), status('new-boot'), status('new-boot')], { initial: status('stale-page-boot') });
    const result = track(h.box.action('set-lan-https', 'fixture settings', { enabled: true })); await flush();
    check('action metadata supplies the authoritative old boot and action stays pending on its status', () => {
      assert.equal(result.phase, 'pending'); assert.equal(h.requests[0].url, '/__console/action');
      assert.equal(h.requests[0].init.method, 'POST');
    });
    await h.timer.advance(500);
    check('action refreshes and returns its original result only after fresh gateway recovery', () => {
      assert.equal(result.phase, 'resolved'); assert.equal(result.value, j);
      assert.equal(h.state.data.gateway.bootId, 'new-boot'); assert.equal(h.requests.length, 4);
    });
  }
  {
    const j = { ok: true, restarting: true };
    const h = harness([j, status(), status('new-boot'), status('new-boot')]);
    const result = track(h.box.action('set-lan-https', 'fixture settings')); await flush();
    check('a legacy action response uses the pre-action page boot instead of accepting ordinary old status', () => assert.equal(result.phase, 'pending'));
    await h.timer.advance(500); assert.equal(result.phase, 'resolved');
  }
  {
    const h = harness([{ ok: true, restarting: true, restartScheduled: true, restartBootId: 'old-boot' },
      status('old-boot', 'failed', 'restart', 'desktop-drain-failed')]);
    const result = track(h.box.action('set-lan-https', 'fixture settings')); await flush();
    check('action cannot return a successful scheduled result or run completion load after shutdown failure', () => {
      assert.equal(result.phase, 'resolved'); assert.equal(result.value.ok, false);
      assert.equal(result.value.code, 'restart-blocked'); assert.equal(h.requests.length, 2);
    });
  }
  {
    const h = harness([{ ok: true, restarting: true, restartScheduled: true, restartBootId: 'old-boot' }, 'hang']);
    const result = track(h.box.action('set-lan-https', 'fixture settings')); await flush(); await h.timer.advance(120000);
    check('action deadline returns an explicit unconfirmed result without claiming completion or refreshing', () => {
      assert.equal(result.value.ok, false); assert.equal(result.value.code, 'restart-wait-timeout'); assert.equal(h.requests.length, 2);
    });
  }
  {
    const h = harness([{ ok: false, restarting: false, restartScheduled: false,
      restartState: { phase: 'failed', kind: 'restart', code: 'restart-helper-failed' } }]);
    const result = track(h.box.action('set-lan-https', 'fixture settings')); await flush();
    check('already failed restart scheduling reports a terminal reason without status polling or completion load', () => {
      assert.equal(result.value.ok, false); assert.match(result.value.message, /助手/); assert.equal(h.requests.length, 1);
      assert.equal(h.element('heroTitle').textContent, '服务重启未完成');
    });
  }
  {
    const h = harness([{ ok: true, restarting: true, message: 'fixture tunnel reconnect' }, status()]);
    const result = track(h.box.action('refresh-tunnel', 'fixture tunnel')); await flush();
    check('tunnel-only reconnection does not wait for a gateway boot replacement it never schedules', () => {
      assert.equal(result.phase, 'resolved'); assert.equal(result.value.ok, true); assert.equal(h.state.restartWait, null);
    });
  }
  {
    const dictionary = vm.runInNewContext('(' + extractRegisterArg(source) + ')');
    const h = harness();
    const messages = ['服务重启未完成', '正在等待电脑操作安全结束并重启服务；确认恢复后，这个页面会自己刷新。',
      '等待服务重启超时，未确认完成。设置可能已部分生效，请检查当前状态与日志；不要连续重试。',
      ...['desktop-drain-timeout', 'desktop-drain-failed', 'restart-helper-failed', null].map(code => h.box.restartFailureMessage(code))];
    check('all new waiting, deadline and shutdown failure messages have English and Spanish translations', () => {
      for (const message of messages) for (const lang of ['en', 'es']) assert.ok(dictionary[message] && dictionary[message][lang]);
    });
  }
  {
    let received = 0;
    const server = http.createServer((req, res) => {
      assert.equal(req.method, 'GET'); assert.equal(req.url, '/__console/status'); received++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(received === 1 ? status('old-boot', 'draining', 'restart') : status('new-boot')));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = 'http://127.0.0.1:' + server.address().port;
      const h = harness([], { fetch: (url, init) => fetch(endpoint + url, init) }); const result = await begin(h);
      async function until(predicate) {
        for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
        throw Error('Isolated HTTP fixture did not settle.');
      }
      await until(() => h.timer.pending() === 2);
      assert.equal(result.phase, 'pending'); await h.timer.advance(500);
      await until(() => result.phase !== 'pending');
      check('real isolated HTTP status drain then fresh boot exercises the actual waiter without any action endpoint', () => {
        assert.equal(result.phase, 'resolved'); assert.equal(received, 2); assert.equal(h.timer.pending(), 0);
      });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  console.log(passed + ' console restart waiter checks passed');
})().catch(() => { console.error('FAIL console restart waiter fixture'); process.exitCode = 1; });
