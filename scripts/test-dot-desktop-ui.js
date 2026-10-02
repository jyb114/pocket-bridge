'use strict';
// Real pointer/keyboard browser interactions and real content encryption.
// The independent native Dot driver is an explicit fixture, not native acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const Module = require('node:module');
const { Readable } = require('node:stream');
const { createDotDesktopService } = require('./dot-desktop-service.js');
const e2ee = require('./e2ee.js');
const browserFile = require.resolve('./browser-check.js');
const safeBrowserModule = new Module(browserFile); safeBrowserModule.filename = browserFile;
safeBrowserModule.paths = Module._nodeModulePaths(path.dirname(browserFile));
// Never sweep another agent's independently running browser.
safeBrowserModule._compile(fs.readFileSync(browserFile, 'utf8').replace('    sweepOrphanBrowsers();', ''), browserFile);
const { Browser } = safeBrowserModule.exports;
const root = path.resolve(__dirname, '..');
if (process.platform === 'win32' && path.parse(root).root.toLowerCase() !== 'd:\\') throw Error('Run the Dot browser fixture on D:.');
const evidence = path.join(root, 'logs', 'isolated-tests', `dot-ui-${Date.now()}-${process.pid}`);
fs.mkdirSync(evidence, { recursive: true });
const secret = crypto.randomBytes(24).toString('base64url');
const ID = '11111111-2222-7333-8444-555555555555';
const messages = [{ observationId: 'a'.repeat(64), role: 'user', text: 'A harmless fixture instruction.', hasText: true },
  { observationId: 'b'.repeat(64), role: 'assistant', text: 'Private fixture response: <img src="/should-never-load">\n' + 'Recent Dot conversation.\n'.repeat(50), hasText: true },
  { observationId: 'c'.repeat(64), role: 'assistant', text: '', hasText: false }];
let mode = 'good', nativeCalls = 0, wireBodies = [], unwantedLoads = 0, sendCalls = 0, pendingFixture = null, releaseDeferred = null;
const service = createDotDesktopService({ driver: { inspect: async () => ({ available: true }), snapshot: async input => {
  nativeCalls++;
  if (mode === 'failure') throw Object.assign(Error('Private native stderr must never be shown'), { code: 'history-unavailable' });
  return { hostId: 'durable', threadId: ID, observedAt: Date.now(), historyScope: 'materialized-recent',
    materializedRowCount: messages.length, messages, taskExecution: 'unknown' };
} } });
const server = http.createServer((req, res) => {
  if (req.url === '/dot/desktop') {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const raw = Buffer.concat(chunks); wireBodies.push(raw);
      let plain = null;
      for (const keys of e2ee.candidateKeys(secret)) { plain = e2ee.decrypt(keys.a, raw); if (plain) break; }
      if (!plain || req.headers['x-dsh-e2ee'] !== '1') { res.writeHead(403); res.end('encrypted request required'); return; }
      const bodyRequest = JSON.parse(plain);
      function encryptedResponse(body, status = 200) {
        const encrypted = e2ee.encrypt(e2ee.deriveKeys(secret, e2ee.slotAt()).b, Buffer.from(JSON.stringify(body)));
        res.writeHead(status, { 'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1',
          'x-dsh-e2ee-type': 'application/json', 'cache-control': 'no-store' }); res.end(encrypted);
      }
      if (mode.startsWith('send-') && ['send', 'receipt'].includes(bodyRequest.action)) {
        if (bodyRequest.action === 'send') { sendCalls++; pendingFixture = { ...bodyRequest }; }
        assert.equal(bodyRequest.threadId, ID); assert.equal(bodyRequest.requestId, pendingFixture.requestId);
        const receipt = { requestId: bodyRequest.requestId, threadId: ID,
          state: mode === 'send-unknown' ? 'unknown' : mode === 'send-failed' ? 'failed' : 'accepted',
          submitted: mode === 'send-unknown' ? null : mode !== 'send-failed',
          shownInDesktopConversation: !['send-unknown', 'send-failed'].includes(mode),
          serverAcknowledged: false, executionConfirmed: false };
        if (mode === 'send-deferred') releaseDeferred = () => encryptedResponse({ ok: true, receipt });
        else encryptedResponse({ ok: true, receipt });
        return;
      }
      const shim = Readable.from([plain]); Object.assign(shim, { method: req.method, url: req.url,
        headers: req.headers, socket: req.socket, __dshE2eeDecrypted: true });
      let status = 200;
      service.handle(shim, { destroyed: false, writeHead(code) { status = code; }, end(body) {
        if (mode.startsWith('send-')) { const value = JSON.parse(body); value.sendAvailable = true; body = JSON.stringify(value); }
        if (mode === 'plaintext' || mode === 'forged-marker') {
          res.writeHead(status, { 'content-type': 'application/json', ...(mode === 'forged-marker' ? { 'x-dsh-e2ee-decrypted': '1' } : {}) });
          res.end(body); return;
        }
        const encrypted = e2ee.encrypt(e2ee.deriveKeys(secret, e2ee.slotAt()).b, Buffer.from(body));
        res.writeHead(status, { 'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1',
          'x-dsh-e2ee-type': 'application/json', 'cache-control': 'no-store' }); res.end(encrypted);
      } });
    }); return;
  }
  if (req.url.startsWith('/should-never-load')) unwantedLoads++;
  if (req.url.split('?')[0] === '/prove.js') {
    // Device pairing/proof is tested by the real gateway suite. This isolated
    // browser fixture still uses real AES-GCM for every Dot body and response.
    res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('// Isolated device-proof boundary.'); return;
  }
  const file = req.url.split('?')[0] === '/e2ee.js' ? 'e2ee.js' : req.url.split('?')[0] === '/dot' ? 'dot.html' : null;
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : 'text/html' });
  res.end(fs.readFileSync(path.join(root, 'pwa', file)));
});
let browser, page, passed = 0, previousExceptions = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, value) { assert.ok(value, name); passed++; console.log('PASS ' + name); }
async function wait(condition, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (await condition()) return; await pause(30); } throw Error('Timed out: ' + label); }
async function click(selector) {
  const position = await page.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
}
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profiles = path.join(evidence, 'profiles'); fs.mkdirSync(profiles); process.env.TEMP = profiles; process.env.TMP = profiles;
    browser = await Browser.launch(); page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.goto(origin + '/dot#k=' + secret, 300);
    check('opening Dot does not automatically move the desktop or read private history', nativeCalls === 0);
    await click('#draft'); await page.send('Input.insertText', { text: 'Preserved mobile draft\nSecond line' });
    await click('#connect'); await wait(() => page.eval('document.querySelectorAll(".message").length===3'), 'Dot history');
    check('real Connect click decrypts the independent native Dot transcript', nativeCalls === 1 && wireBodies.length === 1);
    check('only the exact recent materialized scope is claimed in clear language', await page.eval('document.getElementById("scope").textContent.includes("currently loaded")&&document.getElementById("notice").textContent.includes("unknown")'));
    check('connecting retains the complete phone draft', await page.eval('document.getElementById("draft").value==="Preserved mobile draft\\nSecond line"'));
    check('assistant text is rendered as text and cannot load embedded HTML', unwantedLoads === 0 && await page.eval('document.querySelector(".message.assistant").textContent.includes("<img")&&!document.querySelector(".message img")'));
    check('non-text content is honestly identified without claiming attachment transport', await page.eval('document.querySelector(".missing").textContent.includes("not available as text")'));
    check('an unverified native draft reader leaves Send disabled with a clear availability explanation', await page.eval('document.getElementById("send").disabled&&document.getElementById("send-note").textContent.includes("not available")'));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 190, y: 300, deltaY: -10000, deltaX: 0 });
    await wait(() => page.eval('!document.getElementById("jump").hidden'), 'jump to latest appears');
    await click('#jump');
    check('the visible jump control returns long history to its latest message', await page.eval('document.getElementById("jump").hidden&&(()=>{const main=document.getElementById("main");return main.scrollHeight-main.scrollTop-main.clientHeight<70;})()'));
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      check(width + 'px phone layout has no horizontal overflow and its main controls meet 44px', await page.eval('document.documentElement.scrollWidth<=innerWidth&&["refresh","about","send"].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>=44&&r.height>=44;})'));
      await page.send('Page.captureScreenshot', { format: 'png' }).then(result => fs.writeFileSync(path.join(evidence, `dot-${width}.png`), Buffer.from(result.data, 'base64')));
    }
    await click('#about');
    check('actual About control exposes capability and local-computer limits', await page.eval('document.getElementById("details").open&&document.getElementById("details").textContent.includes("unverified")'));
    await click('#close-details'); check('About can be closed through its visible button', await page.eval('!document.getElementById("details").open'));
    mode = 'failure'; await click('#refresh'); await wait(() => page.eval('document.getElementById("notice").classList.contains("error")'), 'honest failure');
    check('refresh failure retains history, draft and an enabled safe retry', await page.eval('document.querySelectorAll(".message").length===3&&document.getElementById("draft").value.includes("Preserved")&&!document.getElementById("refresh").disabled&&document.getElementById("connection").textContent.includes("Refresh needed")'));
    check('private native error details do not leak into the phone UI', !await page.eval('document.body.textContent.includes("Private native stderr")'));
    mode = 'plaintext'; await click('#refresh'); await wait(() => page.eval('document.getElementById("notice").textContent.includes("encrypted response")'), 'plaintext response rejected');
    check('an unmarked plaintext response cannot masquerade as decrypted Dot content', await page.eval('document.querySelectorAll(".message").length===3&&document.getElementById("draft").value.includes("Second line")'));
    mode = 'forged-marker'; await click('#refresh'); await wait(() => page.eval('document.getElementById("notice").textContent.includes("encrypted response")&&!document.getElementById("refresh").disabled'), 'forged marker rejected');
    check('a forged plaintext decrypt marker cannot refresh or verify a Dot snapshot', await page.eval('document.querySelectorAll(".message").length===3&&document.getElementById("connection").textContent.includes("Refresh needed")&&document.getElementById("draft").value.includes("Second line")'));
    mode = 'good'; await click('#refresh'); await wait(() => page.eval('!document.getElementById("notice").classList.contains("error")&&!document.getElementById("refresh").disabled'), 'retry recovers');
    check('explicit refresh restores a verified Dot view without sending a draft', nativeCalls === 5 && await page.eval('document.getElementById("draft").value.includes("Preserved")'));
    check('wire request bodies do not contain the action, durable identity or phone draft', wireBodies.every(body => !body.includes(Buffer.from('connect')) && !body.includes(Buffer.from(ID)) && !body.includes(Buffer.from('Preserved'))));
    check('the Back link preserves the local encryption fragment', await page.eval('document.getElementById("back").hash===location.hash'));
    mode = 'send-accepted'; await click('#refresh'); await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'test-gated capability');
    check('only a verified AES snapshot capability enables the existing nonempty phone draft', await page.eval('!document.getElementById("send").disabled'));
    await click('#send'); await wait(() => page.eval('document.getElementById("draft").value===""'), 'confirmed Send');
    check('accepted exact-own Send clears the draft and truthfully describes desktop-only evidence', sendCalls === 1 && await page.eval('document.getElementById("receipt-text").textContent.includes("unverified")&&document.getElementById("check-receipt").hidden'));
    mode = 'send-deferred'; await click('#draft'); await page.send('Input.insertText', { text: 'Exact sent draft' }); await click('#send');
    await wait(async () => !!releaseDeferred, 'deferred native receipt');
    await click('#draft'); await page.send('Input.insertText', { text: ' and new text typed while sending' }); releaseDeferred(); releaseDeferred = null;
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'deferred receipt completed');
    check('a confirmed receipt does not clear newer text typed while the send was running', await page.eval('document.getElementById("draft").value==="Exact sent draft and new text typed while sending"'));
    mode = 'send-failed'; await click('#send'); await wait(() => page.eval('document.getElementById("receipt-text").textContent.includes("Nothing was sent")&&!document.getElementById("refresh").disabled'), 'failed receipt');
    check('known failed-before-send receipt retains the draft and allows an explicit fresh attempt', await page.eval('!document.getElementById("send").disabled&&document.getElementById("draft").value.includes("new text")'));
    mode = 'send-unknown'; await click('#send'); await wait(() => page.eval('!document.getElementById("check-receipt").disabled&&!document.getElementById("check-receipt").hidden'), 'unknown receipt');
    const unknownCalls = sendCalls;
    check('an unknown result blocks Send and exposes Check receipt without clearing the draft', await page.eval('document.getElementById("send").disabled&&document.getElementById("draft").value.includes("new text")&&document.getElementById("receipt-text").textContent.includes("Do not resend")'));
    await click('#send'); await pause(120);
    check('clicking disabled Send does not replay an unknown native request', sendCalls === unknownCalls);
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      check(width + 'px unknown-receipt view fits and retains its 44px Check receipt control', await page.eval('document.documentElement.scrollWidth<=innerWidth&&document.getElementById("check-receipt").getBoundingClientRect().height>=44'));
      const shot = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(evidence, 'dot-unknown-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    }
    await click('#check-receipt'); await wait(() => page.eval('!document.getElementById("check-receipt").disabled'), 'read-only receipt remains unknown');
    check('checking an unresolved receipt is read-only and never resends', sendCalls === unknownCalls);
    mode = 'send-accepted'; await click('#check-receipt'); await wait(() => page.eval('document.getElementById("check-receipt").hidden'), 'reconciled accepted receipt');
    check('a later matching accepted receipt clears only the unchanged exact draft without another send', sendCalls === unknownCalls && await page.eval('document.getElementById("draft").value===""'));
    mode = 'forged-marker'; const priorCalls = nativeCalls;
    // A same-URL Page.navigate can preserve the existing document. Use an
    // actually new browsing context to test an unconnected page.
    previousExceptions = page.exceptions.slice(); page.close(); page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.goto(origin + '/dot#k=' + secret, 300); await click('#connect');
    await wait(() => page.eval('document.getElementById("notice").textContent.includes("encrypted response")&&!document.getElementById("connect").disabled'), 'forged first connection rejected');
    check('forged plaintext on first connection cannot render messages or claim a connected Dot', nativeCalls === priorCalls + 1 && await page.eval('document.querySelectorAll(".message").length===0&&!document.getElementById("connect").hidden&&document.getElementById("refresh").disabled&&!document.getElementById("connection").textContent.includes("Connected")'));
    check('no browser JavaScript exception occurred during real phone interactions', previousExceptions.length === 0 && page.exceptions.length === 0);
    fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ passed, nativeFixture: true, physicalPhone: false,
      realEncryption: true, nativeCalls, screenshotWidths: [390, 320], browser: browser.browserName }, null, 2));
    console.log(passed + ' real browser Dot UI checks passed; native driver and Send receipts are fixtures. Evidence: ' + evidence);
  } finally {
    if (page) page.close();
    if (browser) { try { await browser.send('Browser.close'); } catch (_) {} browser.ws.close(); try { browser.proc.kill(); } catch (_) {} }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
