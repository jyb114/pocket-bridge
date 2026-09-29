'use strict';

// Opt-in read-only proof against the running bridge and DSH. No frontend boot,
// workspace/session creation, prompts, native dialogs, or external URLs are used.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const Module = require('module');
const wsf = require('./ws-frame');
const BASE = path.resolve(__dirname, '..');
const DEFAULT_INSTALL = 'D:\\Pocket Bridge';
const DEFAULT_TEMP = 'D:\\bridge-codex-test-temp';
const TIMEOUT_MS = 12000;

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function boundedPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  return port;
}
function localOnly(value) {
  const parsed = new URL(value);
  if (parsed.hostname !== '127.0.0.1' || !['http:', 'ws:'].includes(parsed.protocol)) throw new Error('Loopback origin required');
  return parsed;
}
function loadSafeBrowserHelper() {
  const file = path.join(__dirname, 'browser-check.js');
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('    sweepOrphanBrowsers();')) throw new Error('Browser helper layout changed');
  const isolated = new Module(file, module);
  isolated.filename = file;
  isolated.paths = module.paths;
  // Keep the helper implementation but never sweep other agents' test browsers.
  isolated._compile(source.replace('    sweepOrphanBrowsers();', '    // Orphan sweeping disabled for this read-only probe.'), file);
  return isolated.exports.Browser;
}
async function safeBootstrap(origin, accessKey) {
  const response = await fetch(origin + '/k/' + encodeURIComponent(accessKey) + '?target=dsh', {
    redirect: 'manual', headers: { accept: 'text/html', 'user-agent': 'Pocket Bridge read-only local stream probe' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  await response.body?.cancel();
  if (response.status >= 500) throw new Error('Bridge bootstrap failed');
  return cookies.flatMap(cookie => {
    const match = String(cookie).match(/^([^=;\s]+)=([^;]*)/);
    return match ? [{ name: match[1], value: match[2] }] : [];
  });
}
function readOnlyFrame(frame) {
  if (frame.opcode === wsf.OP_PING || frame.opcode === wsf.OP_PONG || frame.opcode === wsf.OP_CLOSE) return true;
  if (frame.opcode !== wsf.OP_TEXT || !frame.fin) return false;
  let value;
  try { value = JSON.parse(frame.payload.toString('utf8')); } catch (_) { return false; }
  if (!value || typeof value.streamId !== 'string' || !value.streamId.startsWith('bridge-live-')) return false;
  if (value.type === 'cancel') return Object.keys(value).length === 2;
  if (value.type !== 'open' || Object.keys(value).length !== 4 || !value.payload || Object.keys(value.payload).length !== 1) return false;
  if (['$events', 'workspace/follow'].includes(value.endpoint)) return JSON.stringify(value.payload) === '{"args":{}}';
  if (value.endpoint !== 'session/follow') return false;
  const outerArgs = value.payload.args;
  if (!outerArgs || Object.keys(outerArgs).length !== 1) return false;
  const args = outerArgs.request;
  return !!args && Object.keys(args).length === 4 && args.assistantStream === true && args.maxMessages === 500 &&
    !!args.address && Object.keys(args.address).length === 2 && args.address.kind === 'session' &&
    typeof args.address.sessionId === 'string' && args.address.sessionId.length > 0 && args.address.sessionId.length <= 512 &&
    !!args.turnWindow && Object.keys(args.turnWindow).length === 2 && args.turnWindow.minMessages === 50 && args.turnWindow.minTurns === 2;
}
async function directComparator(dshPort, cookieRecord) {
  const control = { hostPings: 0, browserPongs: 0, browserPings: 0, hostPongs: 0, parsedHandshakes: 0 };
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><html><head><meta charset="utf-8"></head><body>Read-only stream comparator</body></html>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/remote.mux') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(dshPort, '127.0.0.1');
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.write('GET /api/remote.mux HTTP/1.1\r\n' +
        'Host: ' + cookieRecord.authority + '\r\n' +
        'Origin: http://' + cookieRecord.authority + '\r\n' +
        'Cookie: ' + cookieRecord.cookieName + '=' + cookieRecord.cookieValue + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + request.headers['sec-websocket-key'] + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n');
      if (head.length) accept(head);
    });
    let buffered = Buffer.alloc(0);
    function accept(bytes) {
      buffered = Buffer.concat([buffered, bytes]);
      if (buffered.length > 64 * 1024) { socket.destroy(); upstream.destroy(); return; }
      const parsed = wsf.parseFrames(buffered);
      for (const frame of parsed.frames) {
        if (!readOnlyFrame(frame)) { socket.destroy(); upstream.destroy(); return; }
        if (frame.opcode === wsf.OP_PONG) control.browserPongs++;
        if (frame.opcode === wsf.OP_PING) control.browserPings++;
        upstream.write(wsf.buildFrame(frame.opcode, frame.payload, true));
      }
      buffered = parsed.rest;
    }
    socket.on('data', accept);
    let hostHandshakeDone = false, hostBuffered = Buffer.alloc(0);
    upstream.on('data', bytes => {
      hostBuffered = Buffer.concat([hostBuffered, bytes]);
      if (!hostHandshakeDone) {
        const boundary = hostBuffered.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        hostBuffered = hostBuffered.subarray(boundary + 4);
        hostHandshakeDone = true;
        control.parsedHandshakes++;
      }
      if (hostBuffered.length > 32 * 1024 * 1024) { hostBuffered = Buffer.alloc(0); return; }
      const parsed = wsf.parseFrames(hostBuffered);
      for (const frame of parsed.frames) {
        if (frame.opcode === wsf.OP_PING) control.hostPings++;
        if (frame.opcode === wsf.OP_PONG) control.hostPongs++;
      }
      hostBuffered = parsed.rest;
    });
    upstream.pipe(socket);
    socket.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { origin: 'http://127.0.0.1:' + port, control, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
function streamProbeExpression(url, holdMs = 0, includeSession = false, sessionIndex = 0) {
  localOnly(url);
  return '(' + function streamProbe(target, timeoutMs, holdMs, includeSession, sessionIndex) {
    return new Promise(resolve => {
      let socket, settled = false, holdTimer = null, baselineAt = null, sessionCandidate = null, assistantRevision = null;
      const result = {
        opened: false, ready: false, hasClientId: false, baseline: false, workspaceCount: null, frames: 0, errors: 0,
        closeCode: null, order: [], stableMs: 0, sessionRequested: false, sessionAvailable: false, sessionSnapshot: false,
        sessionRecordCount: null, sessionSnapshotBytes: 0, sessionProjections: false, sessionAssistantStream: false,
        sessionAssistantFrames: 0, sessionRevisionGaps: 0, remoteErrors: []
      };
      const events = 'bridge-live-events', workspaces = 'bridge-live-workspaces', session = 'bridge-live-session';
      function done() {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(holdTimer);
        if (baselineAt !== null) result.stableMs = Date.now() - baselineAt;
        try {
          if (socket && socket.readyState === 1) {
            for (const streamId of [events, workspaces, ...(result.sessionRequested ? [session] : [])]) {
              socket.send(JSON.stringify({ type: 'cancel', streamId }));
            }
          }
          if (socket) socket.close(1000, 'read-only probe complete');
        } catch (_) {}
        resolve(result);
      }
      function readyToObserve() {
        if (!result.ready || !result.hasClientId || !result.baseline || holdTimer !== null) return;
        if (includeSession && sessionCandidate && !result.sessionRequested) {
          result.sessionRequested = true;
          socket.send(JSON.stringify({ type: 'open', streamId: session, endpoint: 'session/follow', payload: { args: { request: {
            address: { kind: 'session', sessionId: sessionCandidate }, assistantStream: true,
            maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 }
          } } } }));
        }
        if (includeSession && result.sessionRequested && !result.sessionSnapshot) return;
        baselineAt = Date.now();
        holdTimer = setTimeout(done, holdMs);
      }
      const timer = setTimeout(done, timeoutMs + holdMs);
      try {
        socket = new WebSocket(target);
        socket.onopen = () => {
          result.opened = true;
          socket.send(JSON.stringify({ type: 'open', streamId: events, endpoint: '$events', payload: { args: {} } }));
          socket.send(JSON.stringify({ type: 'open', streamId: workspaces, endpoint: 'workspace/follow', payload: { args: {} } }));
        };
        socket.onmessage = event => {
          let frame;
          try { frame = JSON.parse(event.data); } catch (_) { result.errors++; return; }
          result.frames++;
          if (frame.type === 'error') {
            result.errors++;
            const code = frame.error && frame.error.code;
            const allowed = ['gateway/bad-request','gateway/internal','gateway/cancelled','gateway/namespace-not-found','gateway/method-not-found','session/not-found','session/projections-unavailable','session/invalid-address'];
            result.remoteErrors.push(allowed.includes(code) ? code : 'unclassified-remote-error');
            done(); return;
          }
          if (frame.type !== 'item' || !frame.value || typeof frame.value !== 'object') return;
          if (frame.streamId === events && frame.value.type === 'ready') {
            result.order.push('ready');
            result.ready = true; result.hasClientId = typeof frame.value.clientId === 'string' && frame.value.clientId.length > 0;
          }
          if (frame.streamId === workspaces && frame.value.type === 'baseline' && frame.value.value && Array.isArray(frame.value.value.items)) {
            result.order.push('baseline');
            result.baseline = true; result.workspaceCount = frame.value.value.items.length;
            if (includeSession) {
              const candidates = frame.value.value.items.flatMap(item => Array.isArray(item.sessionIds) ? item.sessionIds : [])
                .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 512).sort();
              sessionCandidate = candidates[sessionIndex] || null;
              result.sessionAvailable = sessionCandidate !== null;
            }
          }
          if (frame.streamId === session) {
            if (frame.value.type === 'snapshot' && Array.isArray(frame.value.records)) {
              result.order.push('session-snapshot');
              result.sessionSnapshot = true;
              result.sessionRecordCount = frame.value.records.length;
              result.sessionSnapshotBytes = new TextEncoder().encode(event.data).length;
              result.sessionProjections = !!frame.value.projections && typeof frame.value.projections === 'object';
              result.sessionAssistantStream = !!frame.value.assistantStream && Number.isInteger(frame.value.assistantStream.revision);
              if (result.sessionAssistantStream) assistantRevision = frame.value.assistantStream.revision;
            } else if (frame.value.type === 'assistant-stream') {
              result.sessionAssistantFrames++;
              const revision = frame.value.frame && frame.value.frame.revision;
              if (!Number.isInteger(revision) || assistantRevision === null || revision !== assistantRevision + 1) result.sessionRevisionGaps++;
              if (Number.isInteger(revision)) assistantRevision = revision;
            }
          }
          readyToObserve();
        };
        socket.onerror = () => { result.errors++; };
        socket.onclose = event => { result.closeCode = event.code; done(); };
      } catch (_) { result.errors++; done(); }
    });
  }.toString() + ')(' + JSON.stringify(url) + ',' + TIMEOUT_MS + ',' + holdMs + ',' + includeSession + ',' + sessionIndex + ')';
}
async function safeProbePage(browser, origin, secret, cookies, selectedScript) {
  const page = await browser.newPage();
  for (const cookie of cookies) await page.send('Network.setCookie', {
    name: cookie.name, value: cookie.value, url: origin + '/', path: '/', httpOnly: true, sameSite: 'Lax'
  });
  const handshake = { offeredCompression: false, status: null, negotiatedCompression: false, errorCategory: null, wireBinaryFrames: 0, wireTextFrames: 0, wirePingFrames: 0, wirePongFrames: 0, mainNavigationCount: 0, mainNavigationsAfterHandshake: 0 };
  page.ws.on('message', text => {
    let frame;
    try { frame = JSON.parse(text); } catch (_) { return; }
    if (frame.method === 'Page.frameNavigated' && !frame.params.frame.parentId) {
      handshake.mainNavigationCount++;
      if (handshake.status !== null) handshake.mainNavigationsAfterHandshake++;
    }
    if (frame.method === 'Network.webSocketWillSendHandshakeRequest') handshake.offeredCompression = !!frame.params.request.headers['Sec-WebSocket-Extensions'];
    if (frame.method === 'Network.webSocketHandshakeResponseReceived') {
      handshake.status = frame.params.response.status;
      handshake.negotiatedCompression = !!frame.params.response.headers['Sec-WebSocket-Extensions'];
    }
    if (frame.method === 'Network.webSocketFrameReceived') {
      if (frame.params.response.opcode === 2) handshake.wireBinaryFrames++;
      if (frame.params.response.opcode === 1) handshake.wireTextFrames++;
      if (frame.params.response.opcode === 9) handshake.wirePingFrames++;
      if (frame.params.response.opcode === 10) handshake.wirePongFrames++;
    }
    if (frame.method === 'Network.webSocketFrameError') {
      const text = String(frame.params.errorMessage || '');
      handshake.errorCategory = /ERR_[A-Z_]+/.test(text) ? text.match(/ERR_[A-Z_]+/)[0] :
        /response code: ([0-9]+)/.test(text) ? 'http-' + text.match(/response code: ([0-9]+)/)[1] :
        /extensions/i.test(text) ? 'extensions' : /frame|RSV|reserved/i.test(text) ? 'frame-validation' :
        /closed|reset|refused/i.test(text) ? 'connection-closed' : text ? 'other-network-error' : null;
    }
  });
  // A Fetch.fulfillRequest synthetic Document can be assigned a public address
  // space, causing LNA to block its loopback WS before the bridge sees a request.
  // Navigate through the real local server while suppressing all page scripts.
  // After parsing completes, run only the selected real E2EE script in memory.
  await page.send('Emulation.setScriptExecutionDisabled', { value: true });
  await page.goto(origin + '/go#k=' + encodeURIComponent(secret), 1000);
  const loaded = await page.eval('document.readyState === "complete"');
  if (!loaded) throw new Error('Safe document did not finish parsing');
  await page.send('Emulation.setScriptExecutionDisabled', { value: false });
  let script = selectedScript;
  if (!script) {
    const response = await fetch(origin + '/e2ee.js', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error('Installed E2EE script unavailable');
    script = await response.text();
  }
  await page.eval(script);
  const state = await page.eval('(async()=>{for(let i=0;i<50;i++){if(window.DshE2EE&&window.__dshE2eeOn){await window.DshE2EE.prove(true);return {module:true,enabled:true,patched:!!window.WebSocket.__dshE2ee,proof:window.DshE2EE.proofState().ok};}await new Promise(r=>setTimeout(r,100));}return {module:!!window.DshE2EE,enabled:false,patched:false,proof:false};})()');
  return { page, state, scriptSeen: true, handshake };
}
async function cleanupBrowser(browser, tempRoot) {
  if (!browser) return;
  try { await browser.send('Browser.close'); } catch (_) {}
  try { browser.ws.close(); } catch (_) {}
  await new Promise(resolve => {
    if (browser.proc.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 1500); browser.proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  const profile = path.resolve(browser.profile || '');
  if (profile.startsWith(path.resolve(tempRoot) + path.sep) && path.basename(profile).startsWith('dsh-gw-browser-')) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }); } catch (_) {}
  }
}
async function main() {
  const probeStarted = Date.now();
  if (!process.argv.includes('--live')) {
    console.log('SKIP: live DSH connection proof requires --live. It only reads event readiness and workspace baselines.');
    return;
  }
  const installRoot = path.resolve(argValue('--install-root', DEFAULT_INSTALL));
  const tempRoot = path.resolve(argValue('--temp-root', DEFAULT_TEMP));
  if (!/^[Dd]:[\\/]/.test(installRoot) || !/^[Dd]:[\\/]/.test(tempRoot)) throw new Error('This recovery probe requires D drive paths');
  fs.mkdirSync(tempRoot, { recursive: true });
  process.env.TEMP = tempRoot; process.env.TMP = tempRoot;
  if (path.resolve(os.tmpdir()).toLowerCase() !== tempRoot.toLowerCase()) throw new Error('Browser temp directory must stay on D drive');
  const gatewayPort = boundedPort(argValue('--gateway-port', 8080)), dshPort = boundedPort(argValue('--dsh-port', 19387));
  const origin = 'http://127.0.0.1:' + gatewayPort;
  let phase = 'local prerequisites', browser, comparator;
  try {
    const secret = fs.readFileSync(path.join(installRoot, 'logs', 'e2ee-secret.txt'), 'utf8').trim();
    const accessKey = fs.readFileSync(path.join(installRoot, 'logs', 'access-key.txt'), 'utf8').trim();
    const cookieRecord = JSON.parse(fs.readFileSync(path.join(installRoot, 'logs', 'mint-cookie.json'), 'utf8'));
    if (!secret || !accessKey || !cookieRecord.cookieName || !cookieRecord.cookieValue) throw new Error('Required local credentials missing');
    if (!cookieRecord.authority || !/^127\.0\.0\.1:\d+$/.test(cookieRecord.authority)) throw new Error('Cookie authority must be loopback');
    const sourceMode = process.argv.includes('--source-e2ee');
    const legacyMode = process.argv.includes('--legacy-e2ee');
    if (sourceMode && legacyMode) throw new Error('Choose one E2EE implementation');
    const selectedScript = sourceMode ? fs.readFileSync(path.join(BASE, 'pwa', 'e2ee.js'), 'utf8') :
      legacyMode ? fs.readFileSync('D:\\桥\\runtime-backups\\dsh-instability-20260927\\e2ee.js.before', 'utf8') : null;
    phase = 'bridge authentication bootstrap';
    const cookies = await safeBootstrap(origin, accessKey);
    if (!cookies.length) cookies.push({ name: cookieRecord.cookieName, value: cookieRecord.cookieValue });
    phase = 'isolated browser launch';
    browser = await loadSafeBrowserHelper().launch();

    const includeSession = process.argv.includes('--session-follow');
    const sessionIndex = Number(argValue('--session-index', 0));
    if (!Number.isInteger(sessionIndex) || sessionIndex < 0 || sessionIndex > 1) throw new Error('Only two existing-session comparison candidates are allowed');
    const holdMs = Number(argValue('--hold-ms', 30000));
    if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 60000) throw new Error('Invalid observation window');
    phase = 'direct DSH read-only comparator';
    comparator = await directComparator(dshPort, cookieRecord);
    const directPage = await browser.newPage();
    await directPage.goto(comparator.origin + '/', 100);
    const direct = await directPage.eval(streamProbeExpression(comparator.origin.replace('http:', 'ws:') + '/api/remote.mux', includeSession ? holdMs : 0, includeSession, sessionIndex));
    directPage.close();
    phase = 'real bridge E2EE bootstrap';
    const loaded = await safeProbePage(browser, origin, secret, cookies, selectedScript);
    const delayedDecrypt = process.argv.includes('--delay-decrypt');
    if (delayedDecrypt) {
      await loaded.page.eval("(()=>{const s=crypto.subtle,n=s.decrypt.bind(s);let count=0;s.decrypt=function(...a){const delay=count++===0?250:0;return n(...a).then(v=>new Promise(r=>setTimeout(()=>r(v),delay)));};})()");
    }
    phase = 'real bridge encrypted read-only streams';
    const bridge = loaded.state.enabled && loaded.state.patched ?
      await loaded.page.eval(streamProbeExpression(origin.replace('http:', 'ws:') + '/api/remote.mux', holdMs, includeSession, sessionIndex)) :
      { opened: false, ready: false, hasClientId: false, baseline: false, workspaceCount: null, frames: 0, errors: 1 };
    const documentState = await loaded.page.eval('({isGo:location.pathname === "/go",serviceWorkerControlled:!!navigator.serviceWorker?.controller})').catch(()=>({isGo:false,serviceWorkerControlled:null}));
    loaded.page.close();
    const success = direct.ready && direct.hasClientId && direct.baseline && bridge.ready && bridge.hasClientId && bridge.baseline &&
      loaded.state.enabled && loaded.state.patched && loaded.scriptSeen && direct.workspaceCount === bridge.workspaceCount &&
      direct.errors === 0 && bridge.errors === 0 && bridge.stableMs >= Math.max(0, holdMs - 50) &&
      loaded.handshake.wireBinaryFrames >= 2 && loaded.handshake.wireTextFrames === 0 && documentState.isGo && loaded.handshake.mainNavigationsAfterHandshake === 0 &&
      (!includeSession || [direct, bridge].every(x => x.sessionSnapshot && x.sessionProjections && x.sessionAssistantStream && x.sessionRevisionGaps === 0 && x.stableMs >= Math.max(0, holdMs - 50)));
    const environmentBlocked = loaded.handshake.errorCategory === 'ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS';
    console.log(JSON.stringify({ mode: sourceMode ? 'source-e2ee-in-memory' : legacyMode ? 'legacy-e2ee-in-memory' : 'installed-e2ee', delayedDecrypt, includeSession, sessionCandidateIndex: sessionIndex, holdMs, elapsedMs: Date.now() - probeStarted, e2ee: loaded.state, handshake: loaded.handshake, documentState, directControl: comparator.control, direct, bridge,
      sameWorkspaceCount: direct.workspaceCount === bridge.workspaceCount,
      readyBeforeBaseline: bridge.order.indexOf('ready') < bridge.order.indexOf('baseline'),
      success: environmentBlocked ? null : success, inconclusive: environmentBlocked,
      limitation: environmentBlocked ? 'headless-local-network-access-check' : null }));
    process.exitCode = environmentBlocked ? 2 : success ? 0 : 1;
  } catch (_) {
    // CDP/HTTP errors can contain private URLs. Report only the fixed phase.
    console.error('Live DSH read-only connection proof failed during: ' + phase);
    process.exitCode = 1;
  } finally {
    if (comparator) await comparator.close();
    await cleanupBrowser(browser, tempRoot);
  }
}
module.exports = { readOnlyFrame, streamProbeExpression };
if (require.main === module) main();
