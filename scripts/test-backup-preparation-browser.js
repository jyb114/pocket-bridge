'use strict';
// Real Chromium popup, cross-origin windows, MessagePorts, storage and navigation.
// Only owned loopback ports and synthetic secrets are used. The sole source
// substitution replaces the production Quick-origin predicate with ONE exact
// loopback receiver origin. Production host validation is tested separately.
// No browser is launched by importing this module; CI invokes it explicitly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { extractFunction } = require('./page-source.js');
const e2ee = require('./e2ee.js');
const root = path.resolve(__dirname, '..');
const browserFile = path.join(__dirname, 'browser-check.js');
const isolated = new Module(browserFile, module); isolated.filename = browserFile; isolated.paths = module.paths;
const browserSource = fs.readFileSync(browserFile, 'utf8'), sweepCall = '    sweepOrphanBrowsers();';
assert.equal(browserSource.split(sweepCall).length, 2, 'disable exactly one orphan sweep call');
isolated._compile(browserSource.replace(sweepCall, '    // Never sweep another browser in this fixture.'), browserFile);
const { Browser } = isolated.exports;
const KEY = 'SYNTHETIC_BROWSER_PREPARATION_KEY_ONLY', OLD = 'SYNTHETIC_OLD_BROWSER_KEY_ONLY';
const BOOT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', GENERATION = 'a'.repeat(32);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = name => fs.readFileSync(path.join(root, 'pwa', name), 'utf8');
async function run() {
  let mainOrigin, backupOrigin, browser, scenario = 'success', heldConfirm = null, heldComplete = null;
  let issueCount = 0, proofCount = 0, replacementKeys = 0, documentSerial = 0;
  let sourcePage = null, lastReceiver = null;
  const records = new Map(), unexpected = [], handlerErrors = [];
  const sourceScript = read('dsh-backup-prepare.js'), originFunction = extractFunction(sourceScript, 'origin');
  assert.ok(originFunction && sourceScript.split(originFunction).length === 2, 'replace exactly one origin predicate');
  function script() { return sourceScript.replace(originFunction,
    `function origin(value) { return value === ${JSON.stringify(backupOrigin)} ? value : ''; }`); }
  function send(res, value, encrypted = false, status = 200) {
    let body = Buffer.from(JSON.stringify(value));
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-type': 'application/json' };
    if (encrypted) { body = e2ee.encrypt(e2ee.deriveKeys(KEY, e2ee.slotAt()).b, body); headers['content-type'] = 'application/octet-stream';
      headers['x-dsh-e2ee'] = '1'; headers['x-dsh-e2ee-type'] = 'application/json'; }
    else headers['x-dsh-e2ee-decrypted'] = '1';
    res.writeHead(status, headers); res.end(body);
  }
  function publicTuple(record) { const { ticket, receipt, cookie, phase, ...tuple } = record; return tuple; }
  async function body(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Error('oversize fixture request'); chunks.push(chunk); }
    const raw = Buffer.concat(chunks); if (req.headers['x-dsh-e2ee'] === '1') {
      const plain = e2ee.decrypt(e2ee.deriveKeys(KEY, e2ee.slotAt()).a, raw); if (!plain) throw Error('invalid synthetic ciphertext'); return JSON.parse(plain);
    } return JSON.parse(raw); }
  function fixtureSource() { return `
window.__dshE2eeSecret=${JSON.stringify(KEY)}; window.__states=[]; window.__pauseReady=false;
window.confirm=()=>true;
const nativeOpen=window.open.bind(window); window.open=(...args)=>{if(location.search.includes('blocked'))return null;window.__child=nativeOpen(...args);return window.__child;};
window.addEventListener('message',event=>{if(event.isTrusted&&event.data&&event.data.type==='pocket-bridge-backup-ready'){window.__lastReady=event.data;if(window.__pauseReady)event.stopImmediatePropagation();}});
window.DshE2EE={encryptedFetch:(_key,url,init)=>fetch(url,init)};
window.__prepare=PocketBridgeBackupPrepare.createSource({t:x=>x,ready:()=>true,active:()=>true,context:()=>1,
read:async()=>({url:${JSON.stringify(backupOrigin + '/dsh-lite')},generation:${JSON.stringify(GENERATION)},current:()=>true}),
onState:value=>{window.__states.push(value);document.getElementById('state').textContent=value.phase;}});
document.getElementById('prepare').onclick=()=>window.__prepare.begin();
window.addEventListener('pagehide',()=>window.__prepare.dispose());
`; }
  function receiverPrelude() { return `
localStorage.setItem('dsh-e2ee-secret-persist-v1',${JSON.stringify(OLD)});
sessionStorage.setItem('dsh-e2ee-secret-v1',${JSON.stringify(OLD)});
${scenario === 'storage-failure' ? `const set=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){set.call(this,name,value);if(name==='dsh-e2ee-secret-persist-v1'&&value===${JSON.stringify(KEY)})throw Error('Synthetic write-then-fail');};` : ''}
`; }
  async function route(req, res, receiver) {
    const expected = receiver ? backupOrigin : mainOrigin, url = new URL(req.url, expected);
    if (req.headers.host !== new URL(expected).host) throw Error('unexpected fixture authority');
    if (req.method === 'GET') {
      const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
      if (url.pathname === '/app' && !receiver) { res.writeHead(200, { ...headers, 'content-type': 'text/html' });
        res.end('<!doctype html><button id="prepare">Prepare</button><p id="state"></p><script src="/dsh-backup-prepare.js"></script><script src="/fixture-source.js"></script>'); return; }
      if (url.pathname === '/fixture-source.js' && !receiver) { res.writeHead(200, { ...headers, 'content-type': 'application/javascript' }); res.end(fixtureSource()); return; }
      if (url.pathname === '/fixture-receiver.js' && receiver) { res.writeHead(200, { ...headers, 'content-type': 'application/javascript' }); res.end(receiverPrelude()); return; }
      if (url.pathname === '/__backup/prepare' && receiver) { const config = { origin: backupOrigin, source: url.searchParams.get('source'), nonce: url.searchParams.get('nonce'), bootId: BOOT };
        res.writeHead(200, { ...headers, 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(read('backup-prepare.html').replace('<head>', '<head><meta name="fixture-document" content="' + (++documentSerial) + '">').replace('__PB_PREPARATION_CONTEXT__', JSON.stringify(config)).replace('<script src="/e2ee.js"', '<script src="/fixture-receiver.js" defer></script><script src="/e2ee.js"')); return; }
      if (url.pathname === '/replacement' && receiver) { res.writeHead(200, { ...headers, 'content-type': 'text/html' });
        res.end('<!doctype html><meta name="fixture-document" content="' + (++documentSerial) + '"><p>Replacement document</p><script src="/fixture-replacement.js"></script>'); return; }
      if (url.pathname === '/fixture-replacement.js' && receiver) { res.writeHead(200, { ...headers, 'content-type': 'application/javascript' });
        res.end("addEventListener('message',event=>{if(event.data&&event.data.key)fetch('/fixture-observation',{method:'POST',body:'{}'});});"); return; }
      if (url.pathname === '/storage' && receiver) { res.writeHead(200, { ...headers, 'content-type': 'text/html' }); res.end('<!doctype html><p>Owned storage check</p>'); return; }
      if (url.pathname === '/dsh-backup-prepare.js') { res.writeHead(200, { ...headers, 'content-type': 'application/javascript' }); res.end(script()); return; }
      if (receiver && ['/i18n.js', '/dsh-lite-lang.js', '/e2ee.js', '/backup-prepare.css'].includes(url.pathname)) {
        res.writeHead(200, { ...headers, 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' }); res.end(read(url.pathname.slice(1))); return; }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    }
    if (req.method === 'POST') {
      if (url.pathname === '/fixture-observation' && receiver) { replacementKeys++; send(res, { ok: true }); return; }
      const input = await body(req);
      if (url.pathname === '/__auth/verify' && receiver) {
        proofCount++; const derived = crypto.hkdfSync('sha256', Buffer.from(KEY), Buffer.from('dsh-gw-auth'), Buffer.from('dsh-gw|auth|v1'), 32);
        assert.equal(input.response, crypto.createHmac('sha256', derived).update(input.ts + '|' + input.nonce).digest('base64url'));
        send(res, { ok: true }); return;
      }
      if (url.pathname === '/__backup/redeem' && receiver) {
        const record = [...records.values()].find(r => r.ticket === input.ticket);
        assert.ok(record && record.phase === 'pending' && record.nonce === input.nonce && record.challenge === input.challenge);
        record.phase = 'redeemed'; res.setHeader('set-cookie', 'fixture-prepared=' + record.cookie + '; Path=/; HttpOnly; SameSite=Lax');
        send(res, { ok: true, receipt: record.receipt, ...publicTuple(record) }); return;
      }
      if (url.pathname === '/__dsh/backup-prepare') {
        const encrypted = req.headers['x-dsh-e2ee'] === '1';
        if (input.action === 'issue' && !receiver) {
          issueCount++; const record = { preparationId: 'bprep1_' + crypto.randomBytes(32).toString('base64url'), ticket: 'bp1_' + crypto.randomBytes(32).toString('base64url'),
            receipt: 'bpr1_' + crypto.randomBytes(32).toString('base64url'), cookie: 'fixture_' + crypto.randomBytes(24).toString('hex'), bootId: BOOT, origin: backupOrigin, generation: GENERATION,
            nonce: input.nonce, challenge: input.challenge, expiresAt: Date.now() + 60000, phase: 'pending' };
          records.set(record.preparationId, record); send(res, { ok: true, ticket: record.ticket, ...publicTuple(record) }); return;
        }
        const record = records.get(input.preparationId); assert.ok(record, 'unknown synthetic preparation');
        if (input.action === 'confirm-receiver' && !receiver) {
          assert.ok(record.phase === 'redeemed' && record.receipt === input.receipt && record.nonce === input.nonce && record.challenge === input.challenge);
          const finish = () => { if (res.destroyed || res.writableEnded) return; record.phase = 'confirmed'; send(res, { ok: true, receiverVerified: true, ...publicTuple(record) }); };
          if (scenario === 'replace') { heldConfirm = finish; return; } finish(); return;
        }
        if (input.action === 'complete' && receiver) {
          assert.equal(encrypted, true); assert.equal((req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('fixture-prepared=')), 'fixture-prepared=' + record.cookie, 'completion requires this preparation cookie, not an earlier scenario'); assert.equal(record.phase, 'confirmed');
          const finish = () => { if (res.destroyed || res.writableEnded) return; record.phase = 'completed'; send(res, { ok: true, checkedAt: Date.now(), ...publicTuple(record) }, true); };
          if (scenario === 'reload') { heldComplete = finish; return; } finish(); return;
        }
        if (input.action === 'status' && !receiver) { send(res, { ok: true, phase: record.phase, ...publicTuple(record) }); return; }
        if (input.action === 'revoke' && !receiver) { record.phase = 'revoked'; send(res, { ok: true }); return; }
      }
    }
    unexpected.push(url.pathname); res.writeHead(404); res.end();
  }
  function server(receiver) { return http.createServer((req, res) => { route(req, res, receiver).catch(error => {
    const pathname = new URL(req.url, receiver ? backupOrigin : mainOrigin).pathname;
    handlerErrors.push({ receiver, route: ['/__auth/verify', '/__backup/redeem', '/__dsh/backup-prepare'].includes(pathname) ? pathname : 'other', kind: error instanceof assert.AssertionError ? 'assertion' : 'exception' });
    unexpected.push('fixture-handler-failed'); if (!res.headersSent) send(res, { ok: false }, false, 500); else res.end(); }); }); }
  const main = server(false), backup = server(true);
  await new Promise(resolve => main.listen(0, '127.0.0.1', resolve)); mainOrigin = 'http://127.0.0.1:' + main.address().port;
  await new Promise(resolve => backup.listen(0, '127.0.0.1', resolve)); backupOrigin = 'http://127.0.0.1:' + backup.address().port;
  // Deliberately enumerate safe fields. Never serialize requests, tuples, CDP
  // errors, storage contents or message payloads into a CI failure report.
  async function diagnostics() {
    let source = 'unavailable', receiver = 'unavailable';
    try { if (sourcePage) source = await sourcePage.eval("({phases:(window.__states||[]).map(s=>s.phase),busy:!!window.__prepare?.busy(),childClosed:window.__child?window.__child.closed:null})", 1000); } catch (_) {}
    try { if (lastReceiver) receiver = await lastReceiver.eval("({document:Number(document.querySelector('meta[name=fixture-document]')?.content)||0,ready:document.readyState,openVisible:!!document.getElementById('backup-prepare-open')&&!document.getElementById('backup-prepare-open').hidden,hasKey:!!window.__dshE2eeSecret})"); } catch (_) {}
    return { scenario, source, receiver, issueCount, proofCount, replacementKeys, recordPhases: [...records.values()].map(r => r.phase), handlerErrors, unexpectedCount: unexpected.length };
  }
  async function until(fn, description, timeoutMs = 12000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await fn()) return; await sleep(40); } throw Error('Timed out: ' + description + ' ' + JSON.stringify(await diagnostics())); }
  const documentMarker = "Number(document.querySelector('meta[name=fixture-document]')?.content)||0";
  async function documentBoundary(target, previous) {
    let boundary = '';
    await until(async () => {
      // A delivered pagehide failure can make the source close its child before
      // a new document commits. That is also a verified safe teardown boundary.
      if (await sourcePage.eval('!!window.__child?.closed')) { boundary = 'closed'; return true; }
      try { const current = await target.eval(documentMarker); if (current > 0 && current !== previous) { boundary = 'replaced'; return true; } } catch (_) {}
      return false;
    }, 'receiver document replaced or owned child closed');
    return boundary;
  }
  async function receiverPage() {
    let target; await until(async () => { target = (await browser.send('Target.getTargets')).targetInfos.find(t => t.type === 'page' && t.url.startsWith(backupOrigin + '/__backup/prepare')); return !!target; }, 'owned receiver popup');
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    return lastReceiver = { targetId: target.targetId, send: (method, params = {}) => browser.send(method, params, sessionId),
      eval: async expression => { const value = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (value.exceptionDetails) throw Error('Receiver fixture evaluation failed'); return value.result?.value; } };
  }
  try {
    browser = await Browser.launch(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']);
    const page = sourcePage = await browser.newPage();
    async function start(kind) { scenario = kind; heldConfirm = heldComplete = null; issueCount = proofCount = replacementKeys = 0; records.clear(); lastReceiver = null; console.log('SCENARIO ' + kind);
      await page.goto(mainOrigin + '/app?' + kind, 150); await until(() => page.eval('!!window.__prepare'), 'source fixture ready'); }
    async function click() { await page.send('Runtime.evaluate', { expression: "document.getElementById('prepare').click()", userGesture: true }); }
    async function phase(value, timeoutMs = 12000, forbidPrepared = false) {
      await until(async () => {
        if (forbidPrepared) assert.equal(await page.eval("window.__states.some(s=>s.phase==='prepared')"), false, 'interrupted preparation never reports prepared');
        return page.eval(`document.getElementById('state').textContent===${JSON.stringify(value)}`);
      }, 'source phase ' + value, timeoutMs);
    }
    async function closeReceivers() { for (const t of (await browser.send('Target.getTargets')).targetInfos) if (t.type === 'page' && t.url.startsWith(backupOrigin)) await browser.send('Target.closeTarget', { targetId: t.targetId }); }
    await start('success'); await page.eval('window.__pauseReady=true'); await click(); const child = await receiverPage();
    await until(() => page.eval('!!window.__lastReady'), 'real receiver ready');
    for (const wrong of ['origin', 'source', 'nonce']) await page.eval(`window.dispatchEvent(new MessageEvent('message',{origin:${wrong === 'origin' ? JSON.stringify(mainOrigin) : JSON.stringify(backupOrigin)},source:${wrong === 'source' ? 'window' : 'window.__child'},data:Object.assign({},window.__lastReady,${wrong === 'nonce' ? "{nonce:'bad'}" : '{}'})}));`);
    assert.equal(issueCount, 0, 'wrong-origin/source/nonce events cannot mint');
    await page.eval('window.__pauseReady=false'); await phase('prepared');
    assert.equal(proofCount, 1); assert.equal(await child.eval('window.opener===null'), true);
    assert.equal(await child.eval('location.href'), backupOrigin + '/__backup/prepare');
    assert.equal(await child.eval("localStorage.getItem('dsh-e2ee-secret-persist-v1')==='" + KEY + "'"), true);
    assert.equal(await child.eval("!document.getElementById('backup-prepare-open').hidden"), true);
    await child.send('Page.navigate', { url: backupOrigin + '/storage' }); await sleep(100);
    assert.equal(await child.eval("localStorage.getItem('dsh-e2ee-secret-persist-v1')==='" + KEY + "'"), true, 'bare subsequent page retains verified key');
    await closeReceivers();
    await start('blocked'); await click(); await phase('failed'); assert.equal(issueCount, 0); assert.equal(proofCount, 0);
    await start('storage-failure'); await click(); await phase('failed');
    const storage = await browser.newPage(backupOrigin + '/storage'); await sleep(150);
    assert.equal(await storage.eval("localStorage.getItem('dsh-e2ee-secret-persist-v1')==='" + OLD + "'"), true, 'write-then-fail restores existing browser storage');
    await closeReceivers();
    await start('replace'); await click(); const replaced = await receiverPage(); await until(() => !!heldConfirm, 'receipt validation held before key');
    const replacedDocument = await replaced.eval(documentMarker); assert.ok(replacedDocument);
    await replaced.send('Page.navigate', { url: backupOrigin + '/replacement' }).catch(error => { if (!/closed|No session|No target|Session with given id not found/i.test(error.message)) throw error; }); await documentBoundary(replaced, replacedDocument); heldConfirm(); await sleep(300);
    assert.equal(proofCount, 0); assert.equal(replacementKeys, 0, 'replacement document receives no key'); await closeReceivers();
    await start('reload'); await click(); const reloaded = await receiverPage(); await until(() => !!heldComplete, 'encrypted completion held');
    const reloadedDocument = await reloaded.eval(documentMarker); assert.ok(reloadedDocument);
    await reloaded.send('Page.reload').catch(error => { if (!/closed|No session|No target|Session with given id not found/i.test(error.message)) throw error; }); const boundary = await documentBoundary(reloaded, reloadedDocument);
    assert.notEqual(await page.eval("document.getElementById('state').textContent"), 'prepared', 'teardown before completion cannot report prepared');
    if (boundary === 'replaced') {
      let inheritedKey;
      try { inheritedKey = await reloaded.eval('!!window.__dshE2eeSecret'); }
      catch (_) { assert.equal(await page.eval('window.__child.closed'), true, 'receiver evaluation can disappear only after the owned child closes'); }
      assert.notEqual(inheritedKey, true, 'new receiver document inherits no transferred key');
    }
    heldComplete();
    // Unloading may discard the old document's MessagePort failure notice. Its
    // WindowProxy stays open, so the source intentionally fails at the original
    // 60-second capability deadline. Observe that bound without changing it,
    // and reject even a transient prepared claim throughout the wait.
    await phase('failed', 65000, true);
    assert.notEqual(await page.eval("document.getElementById('state').textContent"), 'prepared', 'reload cannot resume a prepared claim');
    assert.equal([...records.values()].some(r => r.phase === 'pending'), false);
    assert.deepEqual(unexpected, []);
    console.log('PASS real Chromium synthetic loopback preparation: popup, exact window/origin, document-owned ports, encrypted verification, storage rollback and reload.');
  } finally {
    if (heldConfirm) heldConfirm(); if (heldComplete) heldComplete();
    if (browser) await browser.kill();
    main.closeAllConnections?.(); backup.closeAllConnections?.();
    await Promise.all([new Promise(resolve => main.close(resolve)), new Promise(resolve => backup.close(resolve))]);
  }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
