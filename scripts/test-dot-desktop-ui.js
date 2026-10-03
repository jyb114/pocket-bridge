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
const otherSecret = crypto.randomBytes(24).toString('base64url');
const ID = '11111111-2222-7333-8444-555555555555';
const OTHER_ID = '11111111-2222-7333-8444-666666666666';
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
      let plain = null, requestSecret = secret;
      for (const candidate of [secret, otherSecret]) {
        for (const keys of e2ee.candidateKeys(candidate)) { plain = e2ee.decrypt(keys.a, raw); if (plain) break; }
        if (plain) { requestSecret = candidate; break; }
      }
      if (!plain || req.headers['x-dsh-e2ee'] !== '1') { res.writeHead(403); res.end('encrypted request required'); return; }
      const bodyRequest = JSON.parse(plain);
      function encryptedResponse(body, status = 200) {
        const encrypted = e2ee.encrypt(e2ee.deriveKeys(requestSecret, e2ee.slotAt()).b, Buffer.from(JSON.stringify(body)));
        res.writeHead(status, { 'content-type': 'application/octet-stream', 'x-dsh-e2ee': '1',
          'x-dsh-e2ee-type': 'application/json', 'cache-control': 'no-store' }); res.end(encrypted);
      }
      if (mode === 'other-dot' && bodyRequest.action === 'connect') {
        nativeCalls++; encryptedResponse({ ok: true, hostId: 'durable', threadId: OTHER_ID,
          observedAt: Date.now(), historyScope: 'materialized-recent', messages, sendAvailable: false }); return;
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
        else encryptedResponse({ ok: true, receipt, ...(mode === 'send-unknown' && bodyRequest.action === 'receipt' ? {
          checkCode: 'source-unverified', checkMessage: 'The original Dot view could not be verified safely. Use Refresh, then Check receipt. The original send remains unconfirmed; do not resend.'
        } : {}) });
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
        const encrypted = e2ee.encrypt(e2ee.deriveKeys(requestSecret, e2ee.slotAt()).b, Buffer.from(body));
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
const otherOriginServer = http.createServer(server.listeners('request')[0]);
let browser, page, passed = 0, previousExceptions = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, value) { assert.ok(value, name); passed++; console.log('PASS ' + name); }
async function wait(condition, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (await condition()) return; await pause(30); } throw Error('Timed out: ' + label); }
async function click(selector) {
  const position = await page.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
}
async function replaceDraft(text) {
  await click('#draft');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  if (text) await page.send('Input.insertText', { text });
}
async function reload(url) {
  await page.send('Page.navigate', { url: 'about:blank' });
  await pause(30); await page.goto(url, 300);
}
const draftKeysExpression = 'Object.keys(sessionStorage).filter(key=>key.startsWith("pocket-bridge-dot-text-v1:"))';
const pendingKeysExpression = 'Object.keys(sessionStorage).filter(key=>key.startsWith("pocket-bridge-dot-pending-v1:"))';
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => otherOriginServer.listen(0, '127.0.0.1', resolve));
    const profiles = path.join(evidence, 'profiles'); fs.mkdirSync(profiles); process.env.TEMP = profiles; process.env.TMP = profiles;
    browser = await Browser.launch(); page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const otherOrigin = 'http://127.0.0.1:' + otherOriginServer.address().port;
    await page.goto(origin + '/dot#k=' + secret, 300);
    check('opening Dot does not automatically move the desktop or read private history', nativeCalls === 0);
    check('an unconnected landing invites verification without prematurely disabling the product capability', await page.eval('document.getElementById("send").disabled&&document.getElementById("send-note").textContent==="Connect to check text sending. Drafts stay in this tab."&&document.getElementById("empty").textContent.includes("Talk to your desktop Dot.")'));
    await click('#draft'); await page.send('Input.insertText', { text: 'Preserved mobile draft\nSecond line' });
    await click('#connect'); await wait(() => page.eval('document.querySelectorAll(".message").length===3'), 'Dot history');
    check('real Connect click decrypts the independent native Dot transcript', nativeCalls === 1 && wireBodies.length === 1);
    check('only the exact recent materialized scope is claimed in clear language', await page.eval('document.getElementById("scope").textContent.includes("currently loaded")&&document.getElementById("notice").textContent.includes("unknown")'));
    check('connecting retains the complete phone draft', await page.eval('document.getElementById("draft").value==="Preserved mobile draft\\nSecond line"'));
    check('verified Dot saves its exact text draft only in this tab without saving its phone key', await page.eval(`(()=>{const keys=${draftKeysExpression};return keys.length===1&&JSON.parse(sessionStorage.getItem(keys[0])).text==="Preserved mobile draft\\nSecond line"&&!keys[0].includes(window.__dshE2eeSecret)&&!Object.keys(localStorage).some(key=>key.startsWith("pocket-bridge-dot-text"));})()`));
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
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
    await click('#about');
    check('actual About control exposes capability and local-computer limits', await page.eval('document.getElementById("details").open&&document.getElementById("details").textContent.includes("unverified")'));
    check('small-screen About starts at its heading and keeps Close on screen', await page.eval('(()=>{const d=document.getElementById("details"),h=document.getElementById("details-title").getBoundingClientRect(),c=document.getElementById("close-details").getBoundingClientRect();return d.scrollTop===0&&h.top>=0&&h.bottom<=innerHeight&&c.top>=0&&c.bottom<=innerHeight&&!d.querySelector("details").open;})()'));
    const aboutShot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidence, 'dot-about-320.png'), Buffer.from(aboutShot.data, 'base64'));
    await click('#close-details'); check('About can be closed through its visible button', await page.eval('!document.getElementById("details").open'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
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
    const reloadNativeBaseline = nativeCalls, reloadSendBaseline = sendCalls;
    await reload(origin + '/dot#k=' + secret);
    check('reload does not connect or restore private text before the same Dot is verified', nativeCalls === reloadNativeBaseline && sendCalls === reloadSendBaseline && await page.eval('document.getElementById("draft").value===""&&document.getElementById("refresh").disabled'));
    await click('#connect'); await wait(() => page.eval('document.querySelectorAll(".message").length===3'), 'reconnect restores scoped draft');
    check('same-tab reconnect restores exact multiline text without automatically sending it', nativeCalls === reloadNativeBaseline + 1 && sendCalls === reloadSendBaseline && await page.eval('document.getElementById("draft").value==="Preserved mobile draft\\nSecond line"&&document.getElementById("draft-status").textContent.includes("restored")'));
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      check(width + 'px restored draft is visibly sized without horizontal overflow', await page.eval('document.documentElement.scrollWidth<=innerWidth&&document.getElementById("draft").getBoundingClientRect().height>=48&&document.getElementById("draft").scrollHeight<=160'));
    }
    mode = 'other-dot'; await reload(origin + '/dot#k=' + secret); await click('#connect');
    await wait(() => page.eval('document.querySelectorAll(".message").length===3'), 'different Dot connection');
    check('a different verified durable Dot cannot inherit the saved text', await page.eval('document.getElementById("draft").value===""') && sendCalls === reloadSendBaseline);
    mode = 'good'; await reload(origin + '/dot#k=' + otherSecret); await click('#connect');
    await wait(() => page.eval('document.querySelectorAll(".message").length===3'), 'different phone key connection');
    check('the same Dot on another encrypted connection cannot inherit the saved text', await page.eval('document.getElementById("draft").value===""') && sendCalls === reloadSendBaseline);
    await reload(otherOrigin + '/dot#k=' + secret); await click('#connect');
    await wait(() => page.eval('document.querySelectorAll(".message").length===3'), 'different gateway origin connection');
    check('the same key and Dot on another gateway origin cannot inherit the saved text', await page.eval('document.getElementById("draft").value===""') && sendCalls === reloadSendBaseline);
    await reload(origin + '/dot#k=' + secret); await click('#draft'); await page.send('Input.insertText', { text: 'New typing before reconnect wins.' }); await click('#connect');
    await wait(() => page.eval('document.querySelectorAll(".message").length===3'), 'new typing reconnect');
    check('fresh text typed before reconnect is preserved rather than overwritten by an older draft', await page.eval('document.getElementById("draft").value==="New typing before reconnect wins."'));
    await replaceDraft('Preserved mobile draft\nSecond line');
    mode = 'send-accepted'; await click('#refresh'); await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'test-gated capability');
    check('only a verified AES snapshot capability enables the existing nonempty phone draft', await page.eval('!document.getElementById("send").disabled'));
    const liveLinkCalls = wireBodies.length;
    await page.eval(`location.hash='#k='+${JSON.stringify(otherSecret)}`);
    await wait(() => page.eval('document.getElementById("send").disabled&&document.getElementById("notice").textContent.includes("link changed")'), 'changed fragment refused');
    await click('#refresh'); await pause(100);
    check('changing the link in a live page refuses network actions and keeps the old draft intact', wireBodies.length === liveLinkCalls && await page.eval('document.getElementById("draft").value==="Preserved mobile draft\\nSecond line"&&document.getElementById("notice").textContent.includes("Reload")'));
    await reload(origin + '/dot#k=' + secret); await click('#connect'); await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'original link reconnect');
    const changedKeyCalls = wireBodies.length;
    await page.eval(`window.__dshE2eeSecret=${JSON.stringify(otherSecret)}`); await click('#send'); await pause(100);
    check('an in-memory phone key change refuses dispatch before creating a pending receipt', wireBodies.length === changedKeyCalls && await page.eval(`document.getElementById("draft").value==="Preserved mobile draft\\nSecond line"&&${pendingKeysExpression}.length===0&&document.getElementById("send").disabled`));
    await reload(origin + '/dot#k=' + secret); await click('#connect'); await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'key change recovery');
    await click('#send'); await wait(() => page.eval('document.getElementById("draft").value===""'), 'confirmed Send');
    check('accepted exact-own Send clears the draft and its saved text and truthfully describes desktop-only evidence', sendCalls === 1 && await page.eval(`document.getElementById("receipt-text").textContent.includes("unverified")&&document.getElementById("check-receipt").hidden&&${draftKeysExpression}.length===0&&${pendingKeysExpression}.length===0`));
    mode = 'send-deferred'; await click('#draft'); await page.send('Input.insertText', { text: 'Exact sent draft' }); await click('#send');
    await wait(async () => !!releaseDeferred, 'deferred native receipt');
    await click('#draft'); await page.send('Input.insertText', { text: ' and new text typed while sending' }); releaseDeferred(); releaseDeferred = null;
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'deferred receipt completed');
    check('a confirmed receipt does not clear newer text typed while the send was running', await page.eval('document.getElementById("draft").value==="Exact sent draft and new text typed while sending"'));
    mode = 'send-failed'; await click('#send'); await wait(() => page.eval('document.getElementById("receipt-text").textContent.includes("Nothing was sent")&&!document.getElementById("refresh").disabled'), 'failed receipt');
    check('known failed-before-send receipt retains the draft and allows an explicit fresh attempt', await page.eval('!document.getElementById("send").disabled&&document.getElementById("draft").value.includes("new text")'));
    const refusedCalls = sendCalls; await reload(origin + '/dot#k=' + secret); await click('#connect');
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'refused draft reconnect');
    check('a refused send draft survives reload and reconnect without being replayed', sendCalls === refusedCalls && await page.eval('document.getElementById("draft").value==="Exact sent draft and new text typed while sending"'));
    mode = 'send-unknown'; await click('#send'); await wait(() => page.eval('!document.getElementById("check-receipt").disabled&&!document.getElementById("check-receipt").hidden'), 'unknown receipt');
    const unknownCalls = sendCalls;
    check('an unknown result blocks Send and exposes Check receipt without clearing the draft', await page.eval('document.getElementById("send").disabled&&document.getElementById("draft").value.includes("new text")&&document.getElementById("receipt-text").textContent.includes("Do not resend")'));
    check('a retained unknown-send draft makes no false claim that it was never sent', await page.eval('document.getElementById("draft-status").textContent.includes("Draft")&&!document.getElementById("draft-status").textContent.includes("not been sent")'));
    await click('#send'); await pause(120);
    check('clicking disabled Send does not replay an unknown native request', sendCalls === unknownCalls);
    const unknownRequestId = pendingFixture.requestId;
    await reload(origin + '/dot#k=' + otherSecret);
    check('an unresolved receipt is not restored into another encrypted connection', await page.eval('document.getElementById("receipt").hidden') && sendCalls === unknownCalls);
    await reload(origin + '/dot#k=' + secret);
    check('an unresolved send restores its scoped receipt without connecting or replaying it', sendCalls === unknownCalls && await page.eval('document.getElementById("receipt-text").textContent.includes("Reconnect")&&document.getElementById("draft").value===""'));
    mode = 'other-dot'; await click('#connect');
    await wait(() => page.eval('document.getElementById("notice").classList.contains("error")&&!document.getElementById("connect").disabled'), 'pending wrong Dot refusal');
    check('an unresolved receipt prevents binding to another Dot or exposing its saved draft', sendCalls === unknownCalls && await page.eval('document.querySelectorAll(".message").length===0&&document.getElementById("draft").value===""&&document.getElementById("refresh").disabled'));
    mode = 'send-unknown'; await click('#connect');
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'unknown draft same Dot reconnect');
    check('the original unknown draft and receipt recover together and still block Send', sendCalls === unknownCalls && await page.eval('document.getElementById("draft").value==="Exact sent draft and new text typed while sending"&&document.getElementById("send").disabled&&!document.getElementById("check-receipt").hidden'));
    check('a restored unknown-send draft makes no false not-sent claim and offers the next receipt action after reconnect', await page.eval('document.getElementById("draft-status").textContent==="Draft restored for this Dot."&&document.getElementById("receipt-text").textContent.includes("Check the previous receipt")&&!document.getElementById("receipt-text").textContent.includes("Reconnect")'));
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      check(width + 'px unknown-receipt view fits and retains its 44px Check receipt control', await page.eval('document.documentElement.scrollWidth<=innerWidth&&document.getElementById("check-receipt").getBoundingClientRect().height>=44'));
      const shot = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(evidence, 'dot-unknown-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    }
    await click('#check-receipt'); await wait(() => page.eval('!document.getElementById("check-receipt").disabled'), 'read-only receipt remains unknown');
    check('checking a recovered unresolved receipt preserves its request ID and never resends', sendCalls === unknownCalls && pendingFixture.requestId === unknownRequestId);
    check('a refused native receipt check gives an actionable hint while preserving the unknown draft and Send fence', await page.eval('document.getElementById("notice").textContent.includes("Use Refresh, then Check receipt")&&document.getElementById("notice").textContent.includes("do not resend")&&document.getElementById("draft").value.includes("new text")&&document.getElementById("send").disabled'));
    mode = 'send-accepted'; await click('#check-receipt'); await wait(() => page.eval('document.getElementById("check-receipt").hidden'), 'reconciled accepted receipt');
    check('a later matching accepted receipt clears only the recovered unchanged exact draft without another send', sendCalls === unknownCalls && await page.eval(`document.getElementById("draft").value===""&&${draftKeysExpression}.length===0&&${pendingKeysExpression}.length===0`));
    const storageFailureCalls = sendCalls;
    const storageFault = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('pocket-bridge-dot-'))throw new DOMException('Fixture storage denied','SecurityError');return original.call(this,key,value);};})()` });
    await reload(origin + '/dot#k=' + secret); await click('#connect');
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'storage denied connection');
    await click('#draft'); await page.send('Input.insertText', { text: 'Storage-denied text remains visible.' });
    check('storage denial keeps typed text visible with an honest reload warning', await page.eval('document.getElementById("draft").value==="Storage-denied text remains visible."&&document.getElementById("draft-status").textContent.includes("Keep this page open")'));
    await click('#send'); await pause(120);
    check('receipt persistence failure refuses native Send before dispatch and preserves the phone draft', sendCalls === storageFailureCalls && await page.eval('document.getElementById("send").disabled&&document.getElementById("draft").value==="Storage-denied text remains visible."&&document.getElementById("receipt-text").textContent.includes("Nothing was sent")'));
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: storageFault.identifier });
    await reload(origin + '/dot#k=' + secret); await click('#connect');
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'explicit erase connection');
    await click('#draft'); await page.send('Input.insertText', { text: 'Explicitly discarded draft.' }); await replaceDraft('');
    check('explicitly clearing a draft removes its saved text without sending anything', sendCalls === storageFailureCalls && await page.eval(`${draftKeysExpression}.length===0`));
    await reload(origin + '/dot#k=' + secret); await click('#connect');
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'discarded draft reconnect');
    check('an explicitly discarded draft stays empty after reload and reconnect', await page.eval('document.getElementById("draft").value===""') && sendCalls === storageFailureCalls);
    await click('#draft'); await page.send('Input.insertText', { text: 'Trusted current Dot draft.' });
    const invalidDraftKey = await page.eval(`${draftKeysExpression}[0]`);
    await page.eval(`sessionStorage.setItem(${JSON.stringify(invalidDraftKey)},JSON.stringify({version:1,threadId:${JSON.stringify(OTHER_ID)},text:'A different Dot must not be restored.'}))`);
    await reload(origin + '/dot#k=' + secret); await click('#connect');
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'invalid stored target');
    check('a stored draft with the wrong identity is not restored or sent even under the current connection key', sendCalls === storageFailureCalls && await page.eval('document.getElementById("draft").value===""&&document.getElementById("draft-status").textContent.includes("safely")'));
    await page.eval(`sessionStorage.removeItem(${JSON.stringify(invalidDraftKey)});sessionStorage.setItem('pocket-bridge-dot-pending',JSON.stringify({requestId:'77777777-2222-7333-8444-555555555555',threadId:${JSON.stringify(ID)}}))`);
    await reload(origin + '/dot#k=' + secret); await click('#connect');
    await wait(() => page.eval('!document.getElementById("refresh").disabled'), 'unscoped legacy receipt');
    await click('#draft'); await page.send('Input.insertText', { text: 'Do not resend an unscoped legacy request.' }); await click('#send'); await pause(100);
    check('an older unscoped pending receipt is preserved and cannot silently become a new send', sendCalls === storageFailureCalls && await page.eval('sessionStorage.getItem("pocket-bridge-dot-pending")!==null&&document.getElementById("send").disabled&&document.getElementById("receipt-text").textContent.includes("no verified connection")'));
    await page.eval('sessionStorage.removeItem("pocket-bridge-dot-pending")');
    await replaceDraft('');
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
    otherOriginServer.closeAllConnections(); await new Promise(resolve => otherOriginServer.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
