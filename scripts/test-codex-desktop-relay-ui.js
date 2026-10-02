'use strict';
// Actual mobile browser events -> the real relay HTTP service and D-drive
// journal. Codex RPC/desktop interaction are isolated fixtures. This does not
// replace human, physical phone, tunnel, or native desktop acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
// Own only this test browser; parallel acceptance browsers are not orphans.
const browserSource = require.resolve('./browser-check.js');
const browserModule = new Module(browserSource);
browserModule.filename = browserSource;
browserModule.paths = Module._nodeModulePaths(path.dirname(browserSource));
browserModule._compile(fs.readFileSync(browserSource, 'utf8').replace('    sweepOrphanBrowsers();', ''), browserSource);
const { Browser } = browserModule.exports;
const { createDesktopRelayService } = require('./codex-desktop-relay.js');
const root = path.resolve(__dirname, '..');
const THREAD_A = '01a0f60e-881d-7ed0-8cfe-a5c356738b45';
const THREAD_B = '01a0f60e-881d-7ed0-8cfe-a5c356738b46';
if (process.platform !== 'win32') throw Error('This desktop relay browser test requires Windows.');
const evidence = path.join(root, 'logs', 'isolated-tests', `desktop-relay-ui-${Date.now()}-${process.pid}`);
if (process.platform === 'win32' && path.parse(evidence).root.toLowerCase() !== 'd:\\') throw Error('Run this test checkout on D:.');
fs.mkdirSync(evidence, { recursive: true });
const cwdA = path.join(evidence, 'Alpha'), cwdB = path.join(evidence, 'Beta');
fs.mkdirSync(cwdA); fs.mkdirSync(cwdB);
const rows = [{ id: THREAD_A, name: 'Same conversation title', cwd: cwdA, updatedAt: Date.now() },
  { id: THREAD_B, name: 'Same conversation title', cwd: cwdB, updatedAt: Date.now() - 1000 }];

function bootstrap(rows) {
  window.fixture = { messages: [], rows: rows };
  const storageFault = new URL(location.href).searchParams.get('fixtureStorage');
  const preferenceKey = 'codex-desktop-relay-enabled';
  const draftKey = 'codex-session-text-drafts-v1';
  const draftSeed = new URL(location.href).searchParams.get('fixtureDraftSeed');
  if (draftSeed) {
    const entry = { threadId: rows[0].id, text: 'Seeded draft must not execute.' };
    let saved = { version: 1, entries: [entry] };
    if (draftSeed === 'wrong-version') saved.version = 2;
    if (draftSeed === 'structured-text') entry.text = { text: 'not a string' };
    if (draftSeed === 'wrong-id') entry.threadId = '__proto__';
    if (draftSeed === 'oversized-entry') entry.text = 'x'.repeat(32769);
    if (draftSeed === 'too-many') saved.entries = Array.from({ length: 17 }, (_, index) => ({ threadId: rows[0].id.slice(0, -2) + index.toString(16).padStart(2, '0'), text: 'Bounded fixture draft.' }));
    sessionStorage.setItem(draftKey, draftSeed === 'bad-json' ? '{broken' : draftSeed === 'oversized-store' ? 'x'.repeat(131073) : JSON.stringify(saved));
  }
  const draftFault = new URL(location.href).searchParams.get('fixtureDraftStorage');
  if (draftFault) {
    for (const name of draftFault === 'throw-read' ? ['getItem'] : ['setItem', 'removeItem']) {
      const original = Storage.prototype[name];
      Storage.prototype[name] = function (key, ...args) {
        if (key === draftKey) throw new DOMException('Draft storage denied', 'SecurityError');
        return original.call(this, key, ...args);
      };
    }
  }
  if (storageFault === 'unavailable') {
    for (const name of ['localStorage', 'sessionStorage'])
      Object.defineProperty(window, name, { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } });
  } else if (storageFault === 'throw-read' || storageFault === 'throw-write') {
    const original = Storage.prototype[storageFault === 'throw-read' ? 'getItem' : 'setItem'];
    Storage.prototype[storageFault === 'throw-read' ? 'getItem' : 'setItem'] = function (key, ...args) {
      if (key === preferenceKey) throw new DOMException('Preference storage denied', 'SecurityError');
      return original.call(this, key, ...args);
    };
  }
  window.WebSocket = class {
    constructor() { this.readyState = 1; fixture.socket=this; setTimeout(() => this.onopen && this.onopen(), 0); }
    emit(message) { this.onmessage && this.onmessage({ data: JSON.stringify(message) }); }
    send(raw) {
      const request = JSON.parse(raw); fixture.messages.push(request);
      if (request.id === undefined || !request.method) return;
      let result = {};
      if (request.method === 'thread/list') result = { data: fixture.rows, nextCursor: null };
      else if (['model/list', 'collaborationMode/list', 'thread/items/list', 'thread/turns/list', 'thread/loaded/list'].includes(request.method)) result = { data: [], nextCursor: null };
      else if (request.method === 'thread/read') result = { thread: { id: request.params.threadId,
        cwd: fixture.rows.find(row => row.id === request.params.threadId)?.cwd, status: { type: 'notLoaded' } } };
      else if (!['initialize'].includes(request.method)) {
        setTimeout(() => this.emit({ id: request.id, error: { code: -32601, message: 'Unexpected RPC blocked in isolated UI test' } }), 0); return;
      }
      setTimeout(() => this.emit({ id: request.id, result }), 0);
    }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
  };
}

(async () => {
  let browser, page, passed = 0, sequence = 0, mode = 'message', sendGate, tamperNext = false,queueSaveGate;
  let queueMode='normal';
  const httpRequests = [], nativeRequests = [], rpcCalls = [], users = new Map(rows.map(row => [row.id, []]));
  const ordinaryQueuePosts = () => httpRequests.filter(request => request.method === 'POST' && request.url.startsWith('/codex/queue'));
  const receiptRequests = () => httpRequests.filter(request => request.url.startsWith('/codex/desktop-relay'));
  const postCount = () => receiptRequests().filter(request => request.method === 'POST').length;
  const rpc = async (method, params) => {
    rpcCalls.push({ method, params });
    if (method === 'thread/read') return { thread: rows.find(row => row.id === params.threadId) };
    if (method === 'thread/turns/list') return { data: [{ id: 'fixture-turn', itemsView: 'full', items: users.get(params.threadId) || [] }] };
    if (method === 'thread/queue/list') return { data: [], nextCursor: null };
    throw Error('Unexpected relay RPC: ' + method);
  };
  function addMessage(request) { users.get(request.threadId).push({ type: 'userMessage', id: 'message-' + (++sequence), content: [{ type: 'text', text: request.text }] }); }
  const service = createDesktopRelayService(evidence, { rpc, confirmTimeoutMs: 55, pollIntervalMs: 5,
    driver: { inspect: async () => ({ available: true, desktopRunning: true, version: '26.928.1915.0' }),
      send: async request => {
        nativeRequests.push(request); const currentMode = mode;
        if (currentMode === 'failed-remaining' || currentMode === 'failed-cleared')
          throw Object.assign(Error('PRIVATE NATIVE ERROR AND CLIPBOARD'), { code: 'send-control-unavailable', submitted: false,
            desktopDraftRemaining: currentMode === 'failed-remaining', desktopDraftCleared: currentMode === 'failed-cleared' });
        if (currentMode === 'delayed') await new Promise(resolve => { sendGate = resolve; });
        if (currentMode !== 'unknown') addMessage(request);
        return { submitted: true, verifiedThreadId: request.threadId, actualCwd: request.cwd };
      } } });
  const attachment = path.join(evidence, 'relay-attachment.txt'); fs.writeFileSync(attachment, 'Isolated attachment content.');
  const server = http.createServer((req, res) => {
    const record = { method: req.method, url: req.url }; httpRequests.push(record);
    if (req.url.startsWith('/codex/desktop-relay')) {
      if (req.method === 'POST') {
        const chunks = []; req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => { record.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); });
        if (tamperNext) {
          const replacement = tamperNext; tamperNext = false; const end = res.end;
          res.end = function (body, ...rest) { const receipt = JSON.parse(String(body)); Object.assign(receipt, replacement);
            return end.call(this, JSON.stringify(receipt), ...rest); };
        }
      }
      return service.handle(req, res);
    }
    if (req.url.startsWith('/codex/queue')) {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') {
        const chunks = []; req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => { record.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const finish=()=>res.end(JSON.stringify({ ok: true, id: record.body.id, entries: [] }));
          if(queueMode==='delayed')queueSaveGate=finish;else finish(); }); return;
      }
      return res.end('{"entries":[]}');
    }
    if (req.url.startsWith('/codex/threads')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, list: rows })); }
    if (req.url.startsWith('/codex/lock')) { res.writeHead(409, { 'content-type': 'application/json' }); return res.end('{"error":"Writer takeover is prohibited in this test"}'); }
    if (req.url.startsWith('/codex/upload')) {
      req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ path: attachment, name: 'relay-attachment.txt', kind: 'file' })); }); return;
    }
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''), file = path.resolve(root, 'pwa', name);
    if (name && file.startsWith(path.join(root, 'pwa') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/plain'); return res.end(fs.readFileSync(file));
    }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(path.join(root, 'pwa', 'codex.html')));
  });
  const E = fn => page.eval('(' + fn.toString() + ')()');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait(fn, description, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await pause(20); }
    const debug = await E(() => ({ thread: state?.thread?.id, busy: desktopRelayBusy,
      notice: document.getElementById('desktop-relay-status')?.textContent, input: document.getElementById('input')?.value }));
    throw Error('Timed out: ' + description + ' ' + JSON.stringify(debug));
  }
  async function click(selector) {
    const position = await page.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing selector');el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
  }
  async function type(text) {
    await click('#input');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
    await page.send('Input.insertText', { text });
  }
  async function replaceInput(text) {
    await click('#input'); await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await page.send('Input.insertText', { text });
  }
  async function open(index) {
    if (await E(() => state.view === 'thread')) await click('#back');
    await wait(() => E(() => state.listReady && document.querySelectorAll('#thlist .item').length === 2), 'two fixture conversations');
    const position = await page.eval(`(()=>{const el=document.querySelectorAll('#thlist .item')[${index}];el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
    await wait(() => E(() => state.view === 'thread' && !document.querySelector('#body .skel')), 'conversation opens');
  }
  function check(name, condition) { assert.ok(condition, name); passed++; console.log('PASS ' + name); }
  async function idle() { await wait(() => E(() => !desktopRelayBusy), 'relay finishes'); }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profiles = path.join(evidence, 'browser-profiles'); fs.mkdirSync(profiles);
    process.env.TEMP = profiles; process.env.TMP = profiles;
    browser = await Browser.launch(); page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + bootstrap.toString() + ')(' + JSON.stringify(rows) + ')' });
    const url = 'http://127.0.0.1:' + server.address().port;
    await page.goto(url, 300); await open(0);
    await wait(()=>E(()=>task.kind==='unlinked'),'real view-only status');
    check('desktop relay mode starts off and never dispatches on opening a conversation', await E(() => !desktopRelayEnabled && !document.getElementById('desktop-relay-mode').checked) && nativeRequests.length === 0);
    check('without an unresolved request the receipt check is truly hidden and consumes no phone space',await E(()=>{
      const check=document.getElementById('desktop-relay-check');return check.hidden&&getComputedStyle(check).display==='none'&&check.getBoundingClientRect().height===0;
    }));
    const ordinaryMainHeight=await E(()=>document.getElementById('main').getBoundingClientRect().height);
    // Storage restores only an explicit scalar choice, never a send/native/RPC
    // action. Use actual document reloads rather than extracted JS functions.
    const noDispatchSnapshot = () => ({ native: nativeRequests.length, receipts: receiptRequests().length, queues: ordinaryQueuePosts().length });
    const noDispatch = async baseline => nativeRequests.length === baseline.native && receiptRequests().length === baseline.receipts && ordinaryQueuePosts().length === baseline.queues &&
      await E(() => !fixture.messages.some(request => ['thread/resume', 'turn/start', 'turn/steer', 'thread/unsubscribe'].includes(request.method)));
    const preferenceReloadBaseline = noDispatchSnapshot();
    await click('#desktop-relay-mode');
    check('an explicit opt-in stores only boolean strings in both browser stores', await E(() => desktopRelayEnabled &&
      localStorage.getItem('codex-desktop-relay-enabled') === 'true' && sessionStorage.getItem('codex-desktop-relay-enabled') === 'true'));
    await page.goto(url, 300); await open(0);
    check('reload restores explicit desktop opt-in without connecting, checking a receipt, or sending', await E(() => desktopRelayEnabled && document.getElementById('desktop-relay-mode').checked && !state.resumed) && await noDispatch(preferenceReloadBaseline));
    await click('#desktop-relay-mode'); await page.goto(url, 300); await open(0);
    check('reload preserves explicit opt-out and does not auto-dispatch', await E(() => !desktopRelayEnabled && !document.getElementById('desktop-relay-mode').checked && localStorage.getItem('codex-desktop-relay-enabled') === 'false' && sessionStorage.getItem('codex-desktop-relay-enabled') === 'false') && await noDispatch(preferenceReloadBaseline));
    await E(() => { localStorage.setItem('codex-desktop-relay-enabled', '{"enabled":true}'); sessionStorage.setItem('codex-desktop-relay-enabled', 'TRUE'); });
    await page.goto(url, 300); await open(0);
    check('malformed or structured saved preferences cannot enable desktop mode', await E(() => !desktopRelayEnabled && !document.getElementById('desktop-relay-mode').checked) && await noDispatch(preferenceReloadBaseline));
    await E(() => { localStorage.setItem('codex-desktop-relay-enabled', 'true'); sessionStorage.setItem('codex-desktop-relay-enabled', 'false'); });
    await page.goto(url, 300); await open(0);
    check('conflicting remembered choices honor opt-out rather than enabling desktop mode', await E(() => !desktopRelayEnabled) && await noDispatch(preferenceReloadBaseline));
    await E(() => { localStorage.removeItem('codex-desktop-relay-enabled'); sessionStorage.removeItem('codex-desktop-relay-enabled'); });
    for (const fault of ['throw-read', 'unavailable']) {
      await page.goto(url + '?fixtureStorage=' + fault, 300); await open(0);
      check(fault + ' storage leaves a usable unchecked mode without auto-dispatch or script errors', await E(() => !desktopRelayEnabled && !document.getElementById('desktop-relay-mode').disabled) && await noDispatch(preferenceReloadBaseline) && page.exceptions.length === 0);
      await click('#desktop-relay-mode');
      check(fault + ' storage still permits an explicit page choice without auto-dispatch', await E(() => desktopRelayEnabled && document.getElementById('desktop-relay-mode').checked) && await noDispatch(preferenceReloadBaseline));
    }
    await page.goto(url, 300); await open(0);
    await E(() => { localStorage.removeItem('codex-desktop-relay-enabled'); sessionStorage.removeItem('codex-desktop-relay-enabled'); });
    await page.goto(url + '?fixtureStorage=throw-write', 300); await open(0); await click('#desktop-relay-mode');
    check('denied preference writes preserve the explicit page choice and explain it cannot be remembered', await E(() => desktopRelayEnabled && document.getElementById('toast').textContent.includes(t('已切换发送方式，但浏览器无法记住这个选择。刷新后请检查发送方式。'))) && await noDispatch(preferenceReloadBaseline));
    await page.goto(url, 300); await open(0);
    check('a failed preference write does not become an implicit opt-in on reload', await E(() => !desktopRelayEnabled) && await noDispatch(preferenceReloadBaseline));
    await click('#desktop-relay-mode');
    for (const flag of ['resumed', 'resuming', 'sending', 'handingBack', 'queueActivating', 'forking']) {
      await page.eval(`(()=>{state[${JSON.stringify(flag)}]=${flag === 'forking' ? 'state.thread.id' : 'true'};renderFooter();})()`);
      check(flag + ' state blocks both checkbox input and synthetic change from changing the remembered mode', await E(() => {
        const checkbox = document.getElementById('desktop-relay-mode'), before = desktopRelayEnabled;
        const disabled = checkbox.disabled; checkbox.checked = !before; checkbox.dispatchEvent(new Event('change'));
        return disabled && desktopRelayEnabled === before && checkbox.checked === before && localStorage.getItem('codex-desktop-relay-enabled') === 'true';
      }));
      await page.eval(`(()=>{state[${JSON.stringify(flag)}]=false;renderFooter();})()`);
    }
    const draftReloadBaseline = noDispatchSnapshot();
    const exactDraft = ' \nA unsent draft with exact spaces, 中文 and 🔒.\n ';
    await type(exactDraft);
    check('real typing saves an exact per-conversation text draft only in session storage', await E(() => {
      const entries = JSON.parse(sessionStorage.getItem('codex-session-text-drafts-v1')).entries;
      return entries.length === 1 && entries[0].threadId === state.thread.id && entries[0].text === document.getElementById('input').value &&
        !Object.keys(localStorage).some(key => localStorage.getItem(key).includes('A unsent draft'));
    }));
    await open(1); await type('B distinct unsent draft.'); await page.goto(url, 300); await open(0);
    check('same-tab reload restores the exact unsent A draft without dispatching it', await E(() => document.getElementById('input').value === ' \nA unsent draft with exact spaces, 中文 and 🔒.\n ') && await noDispatch(draftReloadBaseline));
    for(const width of [390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
      const image=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(evidence,'restored-exact-draft-'+width+'.png'),Buffer.from(image.data,'base64'));
      check('the restored exact draft remains visible inside the '+width+'px phone composer',await E(()=>{
        const input=document.getElementById('input'),rect=input.getBoundingClientRect(),style=getComputedStyle(input);
        return input.value===' \nA unsent draft with exact spaces, 中文 and 🔒.\n '&&rect.height>=parseFloat(style.lineHeight)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)&&input.scrollTop===0&&rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth;
      }));
    }
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await open(1);
    check('reloaded drafts remain scoped to B and never expose A in B composer', await E(() => document.getElementById('input').value === 'B distinct unsent draft.'));
    await replaceInput(''); await open(0); await replaceInput('');
    check('explicitly clearing both drafts removes their text from session storage', await E(() => sessionStorage.getItem('codex-session-text-drafts-v1') === null));
    for (const seed of ['bad-json', 'wrong-version', 'structured-text', 'wrong-id', 'oversized-entry', 'too-many', 'oversized-store']) {
      await page.goto(url + '?fixtureDraftSeed=' + seed, 300); await open(0);
      check(seed + ' draft storage cannot restore malformed or unbounded text or trigger a send', await E(() => document.getElementById('input').value === '' && Object.keys(textDrafts).length === 0) && await noDispatch(draftReloadBaseline) && page.exceptions.length === 0);
    }
    await page.goto(url + '?fixtureDraftSeed=valid&fixtureDraftStorage=throw-read', 300); await open(0);
    check('denied draft reads leave the page usable and do not restore or execute unknown stored text', await E(() => document.getElementById('input').value === '') && await noDispatch(draftReloadBaseline));
    await page.goto(url + '?fixtureDraftStorage=throw-write', 300); await open(0); await type('Storage-denied draft kept in page memory.');
    check('denied draft writes keep typed text in memory and explain reload recovery is unavailable', await E(() => document.getElementById('input').value === 'Storage-denied draft kept in page memory.' &&
      document.getElementById('toast').textContent === t('浏览器无法保存草稿；请勿刷新或关闭页面。')) && await noDispatch(draftReloadBaseline));
    await open(1); await open(0);
    check('storage failure does not lose a draft while navigating within the same page', await E(() => document.getElementById('input').value === 'Storage-denied draft kept in page memory.'));
    await replaceInput(''); await page.goto(url, 300); await open(0);
    await E(() => {
      textDrafts = Object.create(null);
      for(let index=0;index<17;index++)textDrafts['11111111-1111-4111-8111-'+index.toString(16).padStart(12,'0')] = 'Small bounded stored fixture '+index;
    });
    await type('Current exact draft remains within the count bound.');
    check('draft writes bound the stored conversation count while preserving the current exact text', await E(() => {
      const raw=sessionStorage.getItem('codex-session-text-drafts-v1'),saved=JSON.parse(raw);
      return saved.entries.length===16&&raw.length<=131072&&saved.entries.at(-1).threadId===state.thread.id&&saved.entries.at(-1).text===document.getElementById('input').value&&Object.keys(textDrafts).length===18;
    }));
    await E(() => {
      textDrafts = Object.create(null);
      for(let index=0;index<8;index++)textDrafts['22222222-2222-4222-8222-'+index.toString(16).padStart(12,'0')] = 'T'.repeat(32768);
    });
    await replaceInput('Current exact draft remains within the total bound.');
    check('draft writes bound total serialized storage without truncating any retained text', await E(() => {
      const raw=sessionStorage.getItem('codex-session-text-drafts-v1'),saved=JSON.parse(raw);
      return raw.length<=131072&&saved.entries.length<=16&&saved.entries.length>1&&saved.entries.slice(0,-1).every(entry=>entry.text.length===32768)&&saved.entries.at(-1).threadId===state.thread.id&&saved.entries.at(-1).text===document.getElementById('input').value;
    }));
    await E(() => { textDrafts = Object.create(null); }); await replaceInput('');
    const oversizedDraft = 'O'.repeat(32769); await type(oversizedDraft);
    check('an oversized typed draft remains in memory without truncation or oversized persisted text', await E(() => document.getElementById('input').value.length === 32769 && textDrafts[state.thread.id].length === 32769 &&
      sessionStorage.getItem('codex-session-text-drafts-v1') === null && document.getElementById('toast').textContent === t('草稿过长，无法在刷新后恢复；当前页面仍保留文字。')) && await noDispatch(draftReloadBaseline));
    await open(1); await open(0);
    check('an oversized draft remains intact when returning to its conversation before reload', await E(() => document.getElementById('input').value.length === 32769));
    await replaceInput(''); await page.goto(url, 300); await open(0);
    check('desktop mode visibly explains the send route without claiming a live executor connection',await E(()=>
      document.getElementById('lockhint').textContent===t('电脑代发已开启')&&
      document.getElementById('task-label').textContent===t('电脑代发 · 执行状态未知')&&
      document.getElementById('task-detail').textContent.startsWith(t('文字由电脑代发；任务执行状态仍未知。').slice(0,42))&&
      task.kind==='unlinked'&&!state.resumed));
    await click('#task-more');
    check('compact desktop status expands its truthful detail without taking a writer',await E(()=>
      document.getElementById('task-status').classList.contains('expanded')&&
      getComputedStyle(document.getElementById('task-detail')).display!=='none'&&
      document.getElementById('task-detail').textContent.includes(t('文字由电脑代发；任务执行状态仍未知。'))&&!state.resumed));
    await click('#task-more');
    await click('#menu');await click('#menu-session-controls');
    check('desktop mode conversation controls explain remaining limitations and hide unusable writer takeover choices',await E(()=>
      document.getElementById('lock-control-status').textContent===t('当前使用电脑代发文字，手机不接管会话锁。电脑端的授权、选择和提问仍需在电脑处理；此模式暂不支持附件。')&&
      !document.getElementById('lock-connect-current')&&
      !Array.from(document.querySelectorAll('#sheetInner button')).some(button=>button.textContent===t('复制上下文，在手机独立续聊'))));
    const lockShot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'desktop-conversation-controls.png'),Buffer.from(lockShot.data,'base64'));
    await E(()=>closeSheet());
    for(const width of [390,320]){
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
      check('desktop mode at '+width+'px keeps primary touch controls at least 44px and hides competing writer controls',await E(()=>{
        const send=document.getElementById('send'),r=send.getBoundingClientRect(),panel=document.getElementById('connect-thread-panel'),check=document.getElementById('desktop-relay-check');
        const controls=['back','menu','task-refresh','task-more'].map(id=>document.getElementById(id).getBoundingClientRect());
        return send.textContent==='↑'&&r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&
          controls.every(box=>box.width>=44&&box.height>=44&&box.left>=0&&box.right<=innerWidth)&&
          send.getAttribute('aria-label')===t('发送到电脑')&&send.title===t('通过电脑 Codex 发送')&&
          panel.hidden&&getComputedStyle(panel).display==='none'&&panel.getBoundingClientRect().height===0&&check.getBoundingClientRect().height===0&&
          document.documentElement.scrollWidth<=innerWidth&&task.kind==='unlinked'&&!state.resumed;
      }));
      const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'desktop-mode-'+width+'.png'),Buffer.from(shot.data,'base64'));
    }
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    check('desktop mode gives conversation content more phone space without changing the observed task state',await E(()=>document.getElementById('main').getBoundingClientRect().height)>ordinaryMainHeight);
    await E(()=>fixture.socket.emit({method:'turn/started',params:{threadId:state.thread.id,turn:{id:'fixture-observed-turn'}}}));
    check('an actual running notification does not expose the phone Stop command for the desktop writer',await E(()=>{
      const stop=document.querySelector('#footer .stop');return task.kind==='running'&&!!stop&&stop.disabled&&getComputedStyle(stop).display==='none'&&document.getElementById('send-mode').style.display==='none';
    }));
    await click('#desktop-relay-mode');
    check('turning desktop mode off restores the ordinary running-task controls without stopping the task',await E(()=>{
      const stop=document.querySelector('#footer .stop');return task.kind==='running'&&!desktopRelayEnabled&&!!stop&&!stop.disabled&&getComputedStyle(stop).display!=='none';
    }));
    await E(()=>fixture.socket.emit({method:'turn/completed',params:{threadId:state.thread.id,turn:{id:'fixture-observed-turn',status:'completed'}}}));
    await E(()=>refreshObservedThread());await wait(()=>E(()=>task.kind==='unlinked'),'fixture returns to read-only observation');
    await click('#desktop-relay-mode');
    await E(()=>{fixture.originalQueueEntries=queueEntries;queueEntries=[{id:'fixture-saved-queue',state:'queued',requiresConfirmation:true,label:'Earlier saved Bridge instruction'}];renderFooter();});
    check('desktop relay does not offer an unusable queue-connect action for earlier saved Bridge messages',await E(()=>
      !document.getElementById('queue-connect')&&document.getElementById('queued-messages').textContent.includes('Earlier saved Bridge instruction')&&
      document.querySelector('#queued-messages .queued-row button').textContent===t('取消')));
    await click('#desktop-relay-mode');
    check('earlier Bridge queue connection controls return after desktop mode is turned off',await E(()=>
      !!document.getElementById('queue-connect')&&!document.getElementById('queue-connect').disabled));
    await E(()=>{queueEntries=fixture.originalQueueEntries;renderFooter();});await click('#desktop-relay-mode');
    await click('#menu');
    check('desktop mode settings explicitly defer model, effort and collaboration choices to the computer', await E(() => {
      const labels=[t('模型'),t('思考强度'),t('协作模式')],settings=Array.from(document.querySelectorAll('#sheetInner .srow')).filter(row=>labels.includes(row.querySelector('.k')?.textContent));
      return settings.length===3&&settings.every(row=>row.disabled&&row.querySelector('.v')?.textContent===t('由电脑 Codex 决定'))&&document.getElementById('sheetInner').textContent.includes(t('桌面代发使用电脑当前的模型、思考强度与协作模式。手机上的选择不会应用；关闭桌面代发后可继续使用手机设置。'));
    }));
    await E(()=>closeSheet()); await click('#desktop-relay-mode'); await click('#btn-attach');
    check('turning desktop mode off restores a working Add attachment button and actual file chooser menu', await E(() => !document.getElementById('btn-attach').disabled&&document.getElementById('sheet').classList.contains('on')&&!!document.getElementById('choose-file')));
    check('leaving desktop mode restores the original view-only connection choices, save label and queue guidance',await E(()=>{
      const panel=document.getElementById('connect-thread-panel'),send=document.getElementById('send');return !panel.hidden&&panel.getBoundingClientRect().height>0&&
        !document.getElementById('connect-current').disabled&&!document.getElementById('fork-from-composer').disabled&&
        panel.textContent.includes(t('保存的待办不会因连接自动发送；请明确选择发送已存内容。'))&&
        send.textContent===t('保存待办')&&send.classList.contains('queue')&&!send.classList.contains('desktop-relay');
    }));
    check('leaving desktop mode restores the honest view-only header and history guidance',await E(()=>
      document.getElementById('lockhint').textContent===t('当前仅查看')&&
      document.getElementById('task-detail').textContent.startsWith(task.detail.slice(0,42))&&!state.resumed));
    await click('#cancel-attachment'); await click('#menu');
    check('phone model, effort and collaboration controls become selectable after leaving desktop mode',await E(()=>{
      const labels=[t('模型'),t('思考强度'),t('协作模式')],settings=Array.from(document.querySelectorAll('#sheetInner .srow')).filter(row=>labels.includes(row.querySelector('.k')?.textContent));
      return settings.length===3&&settings.every(row=>!row.disabled)&&!document.getElementById('sheetInner').textContent.includes(t('桌面代发使用电脑当前的模型、思考强度与协作模式。手机上的选择不会应用；关闭桌面代发后可继续使用手机设置。'));
    }));
    await E(()=>closeSheet());
    await click('#desktop-relay-mode'); await type('First exact desktop instruction.'); await click('#send'); await idle();
    check('actual phone Send targets immutable conversation ID and canonical project, even with duplicate titles', nativeRequests.length === 1 && nativeRequests[0].threadId === THREAD_A && nativeRequests[0].cwd === cwdA && nativeRequests[0].text === 'First exact desktop instruction.');
    check('a verified accepted receipt clears the exact submitted draft, its stored text and pending ID', await E(() => document.getElementById('input').value === '' && !desktopRelayPending[state.thread.id] &&
      !(JSON.parse(sessionStorage.getItem('codex-session-text-drafts-v1') || '{"entries":[]}').entries).some(entry => entry.threadId === state.thread.id) && document.getElementById('desktop-relay-status').textContent.includes(t('目标对话已收到消息；请查看后续结果。'))));

    mode = 'unknown'; await type('Preserve this uncertain desktop draft.'); await click('#send'); await idle();
    const uncertainId = await E(() => desktopRelayPending[state.thread.id]?.id);
    check('an unknown send preserves the draft and request ID while its local pending record contains only a text hash', typeof uncertainId === 'string' && await E(() => document.getElementById('input').value === 'Preserve this uncertain desktop draft.' && !!desktopRelayPending[state.thread.id] && !localStorage.getItem('codex-desktop-relay-pending').includes('Preserve this uncertain')));
    const uncertainPosts = postCount(); await click('#send'); await idle();
    check('pressing Send again for an uncertain request performs only GET receipt verification', postCount() === uncertainPosts && receiptRequests().at(-1).method === 'GET' && receiptRequests().at(-1).url.includes(encodeURIComponent(uncertainId)) && nativeRequests.length === 2);
    await click('#desktop-relay-check'); await idle();
    check('the visible Check result button retains the same request ID and unchanged draft', postCount() === uncertainPosts && await E(() => desktopRelayPending[state.thread.id]?.id === JSON.parse(localStorage.getItem('codex-desktop-relay-pending'))[state.thread.id].id && document.getElementById('input').value === 'Preserve this uncertain desktop draft.'));
    const requestsBeforeReload = receiptRequests().length;
    await page.goto(url, 300); await open(0); await pause(100);
    check('page reload keeps the unresolved exact draft, receipt ID and explicit mode without checking or auto-resending', postCount() === uncertainPosts && receiptRequests().length === requestsBeforeReload && await E(() => desktopRelayEnabled && document.getElementById('desktop-relay-mode').checked && !!desktopRelayPending[state.thread.id] && document.getElementById('input').value === 'Preserve this uncertain desktop draft.'));
    await click('#desktop-relay-mode');
    const unresolvedBaseline = noDispatchSnapshot(); await click('#send'); await idle();
    check('turning desktop mode off cannot save or send the identical unresolved draft through ordinary mode', await noDispatch(unresolvedBaseline) && await E(() =>
      document.getElementById('input').value === 'Preserve this uncertain desktop draft.' && !!desktopRelayPending[state.thread.id] &&
      document.getElementById('desktop-relay-status').textContent === t('这条草稿的电脑发送结果尚未确认，请先核对上次发送结果，再改用手机发送。') &&
      !document.getElementById('desktop-relay-check').hidden));
    const blockedShot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(evidence, 'ordinary-unconfirmed-draft-protection.png'), Buffer.from(blockedShot.data, 'base64'));
    await type('\n'); await click('#send'); await idle();
    check('a whitespace edit cannot bypass the receipt boundary when ordinary sending would trim to the same message', await noDispatch(unresolvedBaseline) && await E(() =>
      document.getElementById('input').value === 'Preserve this uncertain desktop draft.\n' && !!desktopRelayPending[state.thread.id]));
    await replaceInput(' \nA separate ordinary follow-up.\n '); await click('#send');
    await wait(() => E(() => !state.sending && !desktopRelayBusy), 'unrelated ordinary queue save finishes');
    check('an unrelated draft remains usable in ordinary mode while the original receipt stays unresolved', ordinaryQueuePosts().length === unresolvedBaseline.queues + 1 &&
      ordinaryQueuePosts().at(-1).body.input[0].text === 'A separate ordinary follow-up.' && ordinaryQueuePosts().at(-1).body.threadId === THREAD_A &&
      await E(() => document.getElementById('input').value === '' && !!desktopRelayPending[state.thread.id]));
    queueMode='delayed';await type('Ordinary draft edited during the queue save.');await click('#send');
    await wait(()=>Promise.resolve(typeof queueSaveGate==='function'),'delayed ordinary queue acknowledgement');
    await type('\n');const finishQueue=queueSaveGate;queueSaveGate=null;queueMode='normal';finishQueue();
    await wait(()=>E(()=>!state.sending&&!desktopRelayBusy),'delayed ordinary save finishes');
    check('an ordinary queue acknowledgement preserves a newer exact newline edit in memory and session storage',await E(()=>{
      const text=document.getElementById('input').value,entries=JSON.parse(sessionStorage.getItem('codex-session-text-drafts-v1')).entries;
      return text==='Ordinary draft edited during the queue save.\n'&&entries.some(entry=>entry.threadId===state.thread.id&&entry.text===text)&&!!desktopRelayPending[state.thread.id];
    }));
    const queueEditBaseline=noDispatchSnapshot();await page.goto(url,300);await open(0);
    check('a confirmed ordinary save does not delete or auto-send the edited draft on reload',await E(()=>document.getElementById('input').value==='Ordinary draft edited during the queue save.\n')&&await noDispatch(queueEditBaseline));
    await open(1); await type('Preserve this uncertain desktop draft.'); await click('#send');
    await wait(() => E(() => !state.sending), 'other conversation ordinary save finishes');
    check('an unresolved request in A does not block the same text in unrelated conversation B', ordinaryQueuePosts().at(-1).body.threadId === THREAD_B &&
      ordinaryQueuePosts().length === unresolvedBaseline.queues + 3 && await E(() => !desktopRelayPending[state.thread.id] && document.getElementById('input').value === ''));
    await open(0); await replaceInput('Preserve this uncertain desktop draft.');
    await E(() => {
      fixture.originalDigest = crypto.subtle.digest;
      crypto.subtle.digest = function (algorithm, bytes) { return fixture.originalDigest.call(crypto.subtle, algorithm, bytes).then(result => new Promise(resolve => { fixture.ordinaryDigestGate = () => resolve(result); })); };
    });
    const hashRaceBaseline = noDispatchSnapshot(); await click('#send');
    await wait(() => E(() => typeof fixture.ordinaryDigestGate === 'function'), 'ordinary pending-draft digest gate');
    check('a pending local draft check blocks duplicate clicks and mode switches without a native action', await E(() => document.getElementById('send').disabled && document.getElementById('desktop-relay-mode').disabled) && await noDispatch(hashRaceBaseline));
    await click('#send'); await type(' A newer edit.');
    await E(() => { fixture.ordinaryDigestGate(); crypto.subtle.digest = fixture.originalDigest; delete fixture.ordinaryDigestGate; }); await idle();
    check('changing a draft while its pending hash is checked prevents sending the stale or newer draft', await noDispatch(hashRaceBaseline) && await E(() => document.getElementById('input').value === 'Preserve this uncertain desktop draft. A newer edit.' && !!desktopRelayPending[state.thread.id]));
    await replaceInput('Preserve this uncertain desktop draft.');
    await E(() => {
      fixture.originalDigest = crypto.subtle.digest;
      crypto.subtle.digest = function (algorithm, bytes) { return fixture.originalDigest.call(crypto.subtle, algorithm, bytes).then(result => new Promise(resolve => { fixture.ordinaryDigestGate = () => resolve(result); })); };
    });
    const navigationHashBaseline = noDispatchSnapshot(); await click('#send');
    await wait(() => E(() => typeof fixture.ordinaryDigestGate === 'function'), 'ordinary navigation digest gate');
    await open(1); await type('B independent draft during A hash.');
    await E(() => { fixture.ordinaryDigestGate(); crypto.subtle.digest = fixture.originalDigest; delete fixture.ordinaryDigestGate; }); await idle();
    check('changing conversations during hash verification cannot dispatch A or B and keeps B draft', await noDispatch(navigationHashBaseline) && await E(() =>
      state.thread.id === fixture.rows[1].id && document.getElementById('input').value === 'B independent draft during A hash.' && !!desktopRelayPending[fixture.rows[0].id]));
    await open(0);
    await E(() => {
      fixture.originalDigest = crypto.subtle.digest;
      crypto.subtle.digest = function (algorithm, bytes) { return fixture.originalDigest.call(crypto.subtle, algorithm, bytes).then(result => new Promise(resolve => { fixture.ordinaryDigestGate = () => resolve(result); })); };
    });
    const activityHashBaseline = noDispatchSnapshot(); await replaceInput('Another ordinary follow-up after a handback.'); await click('#send');
    await wait(() => E(() => typeof fixture.ordinaryDigestGate === 'function'), 'ordinary active-state digest gate');
    await E(() => { state.handingBack = true; renderFooter(); fixture.ordinaryDigestGate(); crypto.subtle.digest = fixture.originalDigest; delete fixture.ordinaryDigestGate; }); await idle();
    check('a handback begun during a local hash check prevents the unrelated draft from entering an ordinary queue', await noDispatch(activityHashBaseline) && await E(() =>
      document.getElementById('input').value === 'Another ordinary follow-up after a handback.' && !!desktopRelayPending[state.thread.id]));
    await E(() => { state.handingBack = false; renderFooter(); }); await replaceInput('Preserve this uncertain desktop draft.');
    const hashFailureBaseline = noDispatchSnapshot();
    await E(() => { fixture.originalDigest = crypto.subtle.digest; crypto.subtle.digest = () => Promise.reject(Error('Injected digest failure')); });
    await click('#send'); await idle(); await E(() => { crypto.subtle.digest = fixture.originalDigest; });
    check('hash failure preserves the pending ID and draft without an ordinary save or automatic receipt check', await noDispatch(hashFailureBaseline) && await E(() => document.getElementById('input').value === 'Preserve this uncertain desktop draft.' && !!desktopRelayPending[state.thread.id]));
    await page.goto(url, 300); await open(0);
    check('explicit mode opt-out survives reload while retaining the unresolved request without dispatch', await E(() => !desktopRelayEnabled && !!desktopRelayPending[state.thread.id]) && await noDispatch(hashFailureBaseline));
    check('an opt-out reload preserves the unresolved exact phone draft', await E(() => document.getElementById('input').value === 'Preserve this uncertain desktop draft.'));
    addMessage(nativeRequests[1]);
    await click('#desktop-relay-check'); await idle();
    check('a later genuine history receipt is reconciled without a second native send', nativeRequests.length === 2 && await E(() => document.getElementById('input').value === '' && !desktopRelayPending[state.thread.id]));

    await click('#desktop-relay-mode'); mode = 'message'; tamperNext = { threadId: THREAD_B };
    await type('Reject the wrong conversation receipt.'); await click('#send'); await idle();
    check('an accepted response for another thread cannot clear this draft or its request ID', await E(() => document.getElementById('input').value === 'Reject the wrong conversation receipt.' && !!desktopRelayPending[state.thread.id]));
    await click('#desktop-relay-check'); await idle();
    check('only the matching receipt can subsequently clear the wrong-response draft', await E(() => document.getElementById('input').value === '' && !desktopRelayPending[state.thread.id]));

    tamperNext = { requestId: 'another-request-id' }; await type('Reject a mismatched request receipt.'); await click('#send'); await idle();
    check('a response with another request ID cannot clear a correctly targeted draft', await E(() => document.getElementById('input').value === 'Reject a mismatched request receipt.' && !!desktopRelayPending[state.thread.id]));
    await click('#desktop-relay-check'); await idle();
    tamperNext = { deliveryConfirmed: false }; await type('Accepted without proof is insufficient.'); await click('#send'); await idle();
    check('an accepted state without independently confirmed delivery preserves the draft', await E(() => document.getElementById('input').value === 'Accepted without proof is insufficient.' && !!desktopRelayPending[state.thread.id]));
    await click('#desktop-relay-check'); await idle();

    mode = 'delayed'; await type('Original in-flight text.'); await click('#send');
    await wait(() => Promise.resolve(!!sendGate), 'editable delayed draft');
    check('while desktop dispatch is pending the arrow remains readable and its busy state is announced accessibly',await E(()=>{
      const send=document.getElementById('send');return send.disabled&&send.textContent==='↑'&&send.getAttribute('aria-label')===t('定位并发送中…')&&send.getBoundingClientRect().width>=44;
    }));
    const busyPostCount = postCount(); await click('#send');
    await type(' Keep this newer edit.'); const finishEdit = sendGate; sendGate = null; finishEdit(); await idle();
    check('a busy Send button prevents a second dispatch and acceptance preserves a newer edit', postCount() === busyPostCount && await E(() => document.getElementById('input').value === 'Original in-flight text. Keep this newer edit.' && !desktopRelayPending[state.thread.id]));

    await replaceInput('Accepted digest race draft.'); mode = 'message';
    await E(() => {
      fixture.originalDigest = crypto.subtle.digest;
      fixture.matchingDigests = 0;
      crypto.subtle.digest = function (algorithm, bytes) {
        const genuine = fixture.originalDigest.call(crypto.subtle, algorithm, bytes);
        if (new TextDecoder().decode(bytes) === 'Accepted digest race draft.' && ++fixture.matchingDigests === 2)
          return genuine.then(result => new Promise(resolve => { fixture.digestGate = () => resolve(result); }));
        return genuine;
      };
    });
    await click('#send'); await wait(() => E(() => typeof fixture.digestGate === 'function'), 'real receipt digest delayed');
    await type(' Keep the edit made during digest verification.');
    await E(() => { fixture.digestGate(); crypto.subtle.digest = fixture.originalDigest; delete fixture.digestGate; });
    await idle();
    check('an edit during real asynchronous receipt hashing survives the synchronous final draft comparison', await E(() => document.getElementById('input').value === 'Accepted digest race draft. Keep the edit made during digest verification.' && !desktopRelayPending[state.thread.id]));
    await replaceInput('Preserve whitespace-only edits.'); mode = 'delayed'; await click('#send');
    await wait(() => Promise.resolve(!!sendGate), 'whitespace edit delayed dispatch');
    await type('\n'); const finishWhitespace = sendGate; sendGate = null; finishWhitespace(); await idle();
    check('adding only a newline while sending preserves the exact newer draft', await E(() =>
      document.getElementById('input').value === 'Preserve whitespace-only edits.\n' && !desktopRelayPending[state.thread.id]));
    const newlineReloadBaseline = noDispatchSnapshot(); await page.goto(url, 300); await open(0);
    check('an accepted earlier receipt never deletes or auto-sends the newer newline draft on reload', await E(() => document.getElementById('input').value === 'Preserve whitespace-only edits.\n' && !desktopRelayPending[state.thread.id]) && await noDispatch(newlineReloadBaseline));
    await replaceInput(' \nExact surrounding whitespace.\n '); mode = 'message'; await click('#send'); await idle();
    check('desktop relay sends and clears the exact submitted spaces and newlines', nativeRequests.at(-1).text === ' \nExact surrounding whitespace.\n ' &&
      await E(() => document.getElementById('input').value === '' && !desktopRelayPending[state.thread.id]));
    // Replace through real keyboard events before the independent navigation check.
    await replaceInput('A submitted draft during navigation.'); mode = 'delayed';

    await click('#send');
    await wait(() => Promise.resolve(!!sendGate), 'delayed native fixture dispatch'); await open(1);
    await replaceInput('B independent unsent draft.'); const finishA = sendGate; sendGate = null; finishA(); await idle();
    check('a late receipt for A never clears B composer while the user is in B', await E(() => document.getElementById('input').value === 'B independent unsent draft.' && state.thread.id === fixture.rows[1].id));
    await open(0);
    check('returning to A does not restore its already confirmed submitted text as a new draft', await E(() => document.getElementById('input').value === ''));
    await open(1);
    check('returning to B restores its independent unsent draft', await E(() => document.getElementById('input').value === 'B independent unsent draft.'));
    mode = 'message'; await click('#send'); await idle();
    check('sending in B targets B ID and B project rather than the same-title A conversation', nativeRequests.at(-1).threadId === THREAD_B && nativeRequests.at(-1).cwd === cwdB && await E(() => document.getElementById('input').value === ''));
    await open(0);

    mode = 'failed-remaining'; await type('Retain this draft after desktop refusal.'); await click('#send'); await idle();
    check('a refused desktop send with a remaining draft explicitly asks for a computer check and preserves phone text', await E(() =>
      document.getElementById('desktop-relay-status').textContent === t('电脑输入框仍有未发送的草稿，请在电脑检查后再试。手机草稿已保留。') &&
      document.getElementById('input').value === 'Retain this draft after desktop refusal.' && !desktopRelayPending[state.thread.id]));
    check('a driver exception cannot expose native errors or clipboard text in the visible failure notice', await E(() =>
      !document.getElementById('desktop-relay-status').textContent.includes('PRIVATE')));
    const failedDraftBaseline = noDispatchSnapshot(); await page.goto(url, 300); await open(0);
    check('a refused desktop send retains its exact draft through reload without another send', await E(() => document.getElementById('input').value === 'Retain this draft after desktop refusal.' && !desktopRelayPending[state.thread.id]) && await noDispatch(failedDraftBaseline));
    mode = 'failed-cleared'; await replaceInput('Retain this draft after safe cleanup.'); await click('#send'); await idle();
    check('a refused send with confirmed desktop cleanup explains the cleanup while keeping the phone draft', await E(() =>
      document.getElementById('desktop-relay-status').textContent === t('本次未发送的桥消息已从电脑输入框清除，手机草稿已保留。') &&
      document.getElementById('input').value === 'Retain this draft after safe cleanup.' && !desktopRelayPending[state.thread.id]));
    await replaceInput(''); mode = 'message';

    const doc = await page.send('DOM.getDocument');
    const fileInput = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#pick-files' });
    await page.send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [attachment] });
    await wait(() => E(() => draftAttachments().length === 1 && draftAttachments()[0].status === 'ready'), 'real file input upload');
    await type('Do not silently drop the attached file.'); const beforeAttachment = postCount(); await click('#send'); await pause(100);
    check('text-only desktop mode rejects an actual selected attachment and preserves both file and draft', postCount() === beforeAttachment && await E(() => draftAttachments().length === 1 && document.getElementById('input').value === 'Do not silently drop the attached file.'));
    await click('#desktop-relay-mode');
    check('turning desktop relay off keeps the selected attachment and phone draft and restores attachment controls', await E(() =>
      !desktopRelayEnabled && !document.getElementById('btn-attach').disabled && draftAttachments().length === 1 &&
      draftAttachments()[0].status === 'ready' && document.getElementById('input').value === 'Do not silently drop the attached file.'));
    check('only the three explicit unrelated ordinary saves use Bridge queue; relay interactions never release writer locks', ordinaryQueuePosts().length === 3 && !httpRequests.some(request => request.method === 'POST' && /\/codex\/lock/.test(request.url)) && await E(() => !fixture.messages.some(request => ['thread/resume', 'turn/start', 'turn/steer', 'thread/unsubscribe'].includes(request.method))));
    check('service confirmation uses only read-only conversation/history/queue RPCs', rpcCalls.every(call => ['thread/read', 'thread/turns/list', 'thread/queue/list'].includes(call.method)));
    check('desktop relay controls fit the phone width without horizontal page overflow', await E(() => document.documentElement.scrollWidth <= innerWidth));
    check('actual page has no uncaught script exceptions', page.exceptions.length === 0);
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed, browser: browser.browserName,
      humanAcceptance: false, nativeDesktopAcceptance: false, modelRequests: 0, relayPosts: postCount(), fixtureNativeSends: nativeRequests.length }, null, 2));
    console.log(passed + ' desktop relay browser interaction checks passed'); console.log('Isolated evidence: ' + evidence);
  } finally {
    if (page) page.close();
    if (browser) { try { await browser.send('Browser.close'); } catch (_) {} browser.ws.close(); try { browser.proc.kill(); } catch (_) {} }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ result: 'failed', error: error.message,
    humanAcceptance: false, nativeDesktopAcceptance: false, modelRequests: 0 }, null, 2));
  console.error(error.stack || error); process.exitCode = 1;
});
