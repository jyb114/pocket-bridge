'use strict';
// Real browser layout, pointer and keyboard events with an isolated Codex RPC.
// Visible-viewport samples model keyboard animation/panning; this is not a
// physical iPhone Safari, Android keyboard, tunnel or native desktop test.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const browserFile = require.resolve('./browser-check.js');
const browserModule = new Module(browserFile);
browserModule.filename = browserFile;
browserModule.paths = Module._nodeModulePaths(path.dirname(browserFile));
browserModule._compile(fs.readFileSync(browserFile, 'utf8').replace('    sweepOrphanBrowsers();', ''), browserFile);
const { Browser } = browserModule.exports;
const root = path.resolve(__dirname, '..');
const evidence = process.env.PB_KEYBOARD_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function bootstrap() {
  const handlers = Object.create(null);
  const viewport = { height: 844, offsetTop: 0, scale: 1,
    addEventListener(name, fn) { (handlers[name] || (handlers[name] = [])).push(fn); } };
  window.fixture = { sent: [], viewport,
    resize(height, top, scale = 1) {
      viewport.height = height; viewport.offsetTop = top; viewport.scale = scale;
      for (const name of ['resize', 'scroll']) for (const fn of handlers[name] || []) fn();
    } };
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  window.WebSocket = class {
    constructor() { this.readyState = 1; fixture.socket = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    emit(message) { this.onmessage && this.onmessage({ data: JSON.stringify(message) }); }
    send(raw) {
      const request = JSON.parse(raw); fixture.sent.push(request);
      if (request.id === undefined || !request.method) return;
      let result = {};
      if (request.method === 'thread/list') result = { data: [{ id: 'keyboard-fixture', name: 'Keyboard review', cwd: 'D:/fixture', updatedAt: Date.now() }], nextCursor: null };
      else if (request.method === 'thread/items/list') result = { data: Array.from({ length: 80 }, (_, index) => ({
        item: { id: 'history-' + (80 - index), type: 'agentMessage', text: 'History paragraph ' + (80 - index) + '\n' + 'A long conversation stays readable while writing a draft. '.repeat(5) }
      })), nextCursor: null };
      else if (request.method === 'thread/read') result = { thread: { id: 'keyboard-fixture', cwd: 'D:/fixture', status: { type: 'idle' } } };
      else if (request.method === 'thread/loaded/list') result = { data: [] };
      else if (['model/list', 'collaborationMode/list', 'thread/turns/list'].includes(request.method)) result = { data: [], nextCursor: null };
      setTimeout(() => this.emit({ id: request.id, result }), 0);
    }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
  };
}

(async () => {
  const checks = [], geometry = [];
  let browser, page;
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.resolve(root, 'pwa', name);
    if (name && file.startsWith(path.join(root, 'pwa') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/plain');
      return res.end(fs.readFileSync(file));
    }
    if (req.url.startsWith('/codex/queue')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"entries":[]}'); }
    if (req.url.startsWith('/codex/desktop-relay/status')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"available":true,"desktopRunning":true}'); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(path.join(root, 'pwa', 'codex.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const E = fn => page.eval('(' + fn.toString() + ')()');
  function check(name, condition, detail) {
    checks.push({ name, passed: !!condition, ...(detail ? { detail } : {}) });
    console.log((condition ? 'PASS ' : 'FAIL ') + name);
  }
  async function click(selector) {
    const box = await page.eval(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
  }
  async function resize(height, top = 0, scale = 1) {
    await page.eval(`fixture.resize(${height},${top},${scale})`); await pause(100);
  }
  async function sample(label) {
    const value = await E(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right }; };
      const main = document.getElementById('main');
      const bubbles = document.querySelectorAll('#body .bub'), lastBubble = bubbles[bubbles.length - 1];
      return { body: rect(document.body), input: rect(document.getElementById('input')), footer: rect(document.getElementById('footer')),
        send: rect(document.getElementById('send')), jump: rect(document.getElementById('jump')), main: rect(main),
        lastBubble: lastBubble && rect(lastBubble),
        scrollTop: main.scrollTop, scrollHeight: main.scrollHeight, follow: stick, draft: document.getElementById('input').value,
        windowScroll: window.scrollY, width: window.innerWidth, viewport: { height: fixture.viewport.height, top: fixture.viewport.offsetTop } };
    });
    geometry.push({ label, ...value }); return value;
  }
  function visible(value) {
    const top = value.viewport.top, bottom = top + value.viewport.height;
    return Math.abs(value.body.top - top) < 1 && Math.abs(value.body.bottom - bottom) < 1 &&
      value.input.top >= top && value.send.bottom <= bottom + 1 && value.send.right <= value.width;
  }
  async function screenshot(name) {
    if (!evidence) return;
    const viewport = await E(() => ({ height: fixture.viewport.height, top: fixture.viewport.offsetTop, width: window.innerWidth }));
    const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
      clip: { x: 0, y: viewport.top, width: viewport.width, height: viewport.height, scale: 1 } });
    fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(result.data, 'base64'));
  }
  try {
    browser = await Browser.launch(); page = await browser.newPage();
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + bootstrap.toString() + ')()' });
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.goto('http://127.0.0.1:' + server.address().port, 350);
      await click('.item'); await pause(350);
      check(width + ': opens the actual phone conversation with long rendered history', await E(() => state.order.length === 80 && document.getElementById('main').scrollHeight > 8000));
      // Test the normal app-server composer, matching the user's screenshot.
      await E(() => { state.resumed = true; renderFooter(); scrollDown(true); }); await pause(260);
      await click('#input'); await page.send('Input.insertText', { text: 'A multiline phone draft\nkeeps its cursor and content.' });
      await resize(350);
      let value = await sample(width + '-keyboard-open');
      check(width + ': focused multiline composer stays above the keyboard', visible(value), value);
      check(width + ': typing leaves at least 70px of conversation visible', value.main.height >= 70, value);
      check(width + ': the latest reply has two visible lines rather than empty container padding',
        value.lastBubble && Math.min(value.lastBubble.bottom, value.main.bottom) - Math.max(value.lastBubble.top, value.main.top) >= 44, value);
      check(width + ': compact Send is a visible 44px touch button', value.send.height >= 44 && value.send.right - value.send.left >= 44);
      check(width + ': compact status keeps its state, refresh and expandable detail', await E(() =>
        document.body.classList.contains('compact-phone-keyboard') && document.getElementById('task-label').textContent &&
        document.getElementById('task-refresh').getBoundingClientRect().height >= 44 &&
        !document.getElementById('task-more').hidden && getComputedStyle(document.getElementById('task-detail')).display === 'none'));
      check(width + ': opening the keyboard preserves latest-message following', value.follow && value.scrollHeight - value.scrollTop - value.main.height < 2);
      check(width + ': focus and resize retain the unsent draft', value.draft === 'A multiline phone draft\nkeeps its cursor and content.');
      await screenshot('codex-' + width + '-keyboard-open');
      await click('#task-more'); await pause(80);
      check(width + ': tapping folded status Details actually shows the full detail', await E(() =>
        document.getElementById('task-status').classList.contains('expanded') &&
        getComputedStyle(document.getElementById('task-detail')).display !== 'none' &&
        document.getElementById('task-detail').textContent.includes(t('上次同步 '))));
      await click('#task-more'); await pause(80); await click('#input');
      check(width + ': collapsing Details restores chat space without editing the draft', await E(() =>
        !document.getElementById('task-status').classList.contains('expanded') &&
        document.getElementById('main').clientHeight >= 70 && document.getElementById('input').value === 'A multiline phone draft\nkeeps its cursor and content.'));
      await resize(350, 95);
      value = await sample(width + '-safari-pan');
      check(width + ': Safari-style viewport panning keeps the full composer visible', visible(value), value);
      check(width + ': document itself never scrolls', value.windowScroll === 0);
      await E(() => { document.getElementById('main').scrollTop = 1800; }); await pause(90);
      const history = await sample(width + '-history-before-resize');
      await resize(410, 48);
      value = await sample(width + '-history-resized');
      check(width + ': keyboard animation preserves the history the user is reading', !value.follow && Math.abs(value.scrollTop - history.scrollTop) < 1);
      check(width + ': Latest shortcut stays above the actual multiline composer', value.jump.height > 0 && value.jump.bottom <= value.footer.top && value.jump.top >= value.viewport.top);
      await resize(844);
      value = await sample(width + '-history-keyboard-closed');
      check(width + ': closing the keyboard does not jump away from older history', !value.follow && Math.abs(value.scrollTop - history.scrollTop) < 1);
      await resize(410, 48);
      await click('#jump'); await pause(90);
      check(width + ': tapping Latest resumes following', await E(() => stick && nearBottom()));
      await resize(844);
      value = await sample(width + '-keyboard-closed');
      check(width + ': dismissing the keyboard restores height and following', visible(value) && value.follow && value.main.height > 400);
      check(width + ': keyboard close restores the regular status details and spacing', await E(() =>
        !document.body.classList.contains('compact-phone-keyboard') && getComputedStyle(document.getElementById('task-detail')).display !== 'none'));
      // During Safari keyboard animation, different viewport metrics may lag.
      // Make dvh smaller while innerHeight remains large: old subtraction could
      // shrink the body to zero and push the composer to the top.
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 400, deviceScaleFactor: 1, mobile: true });
      await E(() => { Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 }); });
      await resize(350);
      value = await sample(width + '-mixed-animation-metrics');
      check(width + ': delayed layout metrics cannot double-subtract keyboard height', visible(value) && value.body.height === 350, value);
      await screenshot('codex-' + width + '-mixed-metrics');
      const cssBeforeZoom = await E(() => document.documentElement.style.cssText);
      await resize(200, 10, 2);
      check(width + ': pinch zoom does not reflow the app as if it were a keyboard', await E(() => document.documentElement.style.cssText) === cssBeforeZoom);
      await resize(350);
      await click('#menu'); await pause(80);
      const sheet = await E(() => { const r=document.getElementById('sheet').getBoundingClientRect(), inner=document.getElementById('sheetInner').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,innerTop:inner.top,innerBottom:inner.bottom}; });
      check(width + ': settings sheet is scrollable inside the visible viewport', sheet.top === 0 && sheet.bottom === 350 && sheet.innerTop >= 0 && sheet.innerBottom <= 350);
      await E(() => closeSheet());
      await resize(350);
      await E(() => { desktopRelayEnabled=true;state.resumed=false;renderFooter(); }); await pause(80);
      value = await sample(width + '-desktop-relay-keyboard');
      check(width + ': desktop relay mode also keeps its Send button visible', visible(value), value);
      await page.send('Input.insertText', { text: '\n' + 'Long multiline draft remains editable.\n'.repeat(9) });
      await pause(80);
      value = await sample(width + '-long-draft');
      check(width + ': a very long draft scrolls inside its input instead of covering Send', visible(value) && value.input.height <= 71 && value.draft.includes('Long multiline draft'), value);
      const options = await E(() => { const el=document.querySelector('.composer-options'); return {height:el.clientHeight, content:el.scrollHeight}; });
      check(width + ': send settings remain accessible in their own scroll area', options.height > 20 && options.content > options.height);
      await screenshot('codex-' + width + '-relay-long-draft');
      const validHeight = value.body.height;
      await resize(0, 0);
      check(width + ': an invalid transient viewport sample retains the last usable layout', await E(() => document.body.getBoundingClientRect().height) === validHeight);
      await resize(350);
      await E(() => { fixture.viewport.height = 430; fixture.viewport.offsetTop = 15; }); await pause(520);
      value = await sample(width + '-missing-resize-event');
      check(width + ': a missing Safari resize event recovers without losing the draft', visible(value) && value.body.height === 430 && value.draft.includes('Long multiline draft'));
      check(width + ': keyboard and settings interactions never send a message or seize a lock', await E(() => !fixture.sent.some(request => ['turn/start','thread/resume','turn/interrupt','thread/unsubscribe'].includes(request.method))));
      check(width + ': no page runtime exceptions', page.exceptions.length === 0, page.exceptions);
    }
    const failed = checks.filter(row => !row.passed).length;
    if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: checks.length - failed, failed,
      actualBrowserInteractions: true, mockedRpc: true, simulatedVisibleViewport: true, physicalPhone: false,
      nativeDesktop: false, modelRequests: 0, checks, geometry }, null, 2));
    console.log('Codex keyboard browser regression: ' + (checks.length - failed) + ' passed, ' + failed + ' failed.');
    if (failed) process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (browser) {
      // Browser.close owns only this test browser; never sweep other agents'
      // profiles or use a window-title taskkill to clean up parallel tests.
      try { await browser.send('Browser.close'); } catch (_) {}
      try { browser.ws.close(); } catch (_) {}
      try { browser.proc.kill(); } catch (_) {}
    }
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
