'use strict';

// Real loopback HTTP tests with an in-process callback fixture, never a Dot account.
// The trusted test transport maps a fictitious HTTPS origin to that HTTP fixture.
// Consequently this does not certify external HTTPS, OAuth, or actual Dot delivery.
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createDotInbox, signature, verifyWebhook, isPublicAddress, pinnedHttps, VERSION, EVENT } = require('./dot-inbox');

function chooseTestRoot(platform, configured, temporaryDirectory) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const base = configured || (platform === 'win32' ? 'D:\\桥\\dot-inbox-isolated-tests-20261001' :
    paths.join(temporaryDirectory, 'pocket-bridge-dot-inbox-tests'));
  if (!paths.isAbsolute(base)) throw new Error('Test root must be absolute');
  // Never create test artifacts on the user's Windows C drive, even via an override.
  if (platform === 'win32' && paths.parse(paths.resolve(base)).root.toLowerCase() !== 'd:\\') {
    throw new Error('Windows Dot inbox test artifacts must stay on D:');
  }
  return paths.resolve(base);
}
const runRoot = path.join(chooseTestRoot(process.platform, process.env.DOT_INBOX_TEST_ROOT, os.tmpdir()), crypto.randomUUID());
fs.mkdirSync(runRoot, { recursive: true });
const key = crypto.randomBytes(32);
const nonce = () => crypto.randomBytes(24).toString('base64url');
const secrets = new Map();
const tokens = new Map();
function account(kind, ownerId, principalId, queueIds, scopes) {
  const token = crypto.randomBytes(24).toString('base64url');
  tokens.set(token, { kind, ownerId, principalId, queueIds, scopes }); return token;
}
const phoneA = account('phone', 'ownerA', 'phoneA', ['main','second'], ['inbox:create','inbox:poll']);
const phoneOtherDevice = account('phone', 'ownerA', 'phoneB', ['main'], ['inbox:create','inbox:poll']);
const phoneB = account('phone', 'ownerB', 'phoneB', ['main'], ['inbox:create','inbox:poll']);
const pluginA = account('plugin', 'ownerA', 'dotA', ['main','second'], ['inbox:read','inbox:reply','events:subscribe']);
const pluginB = account('plugin', 'ownerB', 'dotB', ['main'], ['inbox:read','inbox:reply','events:subscribe']);
const pluginReadOnly = account('plugin', 'ownerA', 'dotReadOnly', ['main'], ['inbox:read']);
const pluginNarrow = account('plugin', 'ownerA', 'dotNarrow', ['second'], ['inbox:read','events:subscribe']);
const secret = 'whsec_' + crypto.randomBytes(32).toString('base64');
const secondSecret = 'whsec_' + crypto.randomBytes(32).toString('base64');
const callbackOrigin = 'https://receiver.example.test';
let clock = Date.now(), current, callbackServer, callbackBase, active = true, checks = 0;
const receipts = [], challenges = [], audits = [], modes = new Map();
const resources = [];
const createdRequests = [];
const time = () => clock;
function check(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
async function call(base, endpoint, token, body, headers = {}) {
  const response = await fetch(base + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
function auth(request) { return tokens.get((request.headers.authorization || '').slice(7)); }
function options(dir, extra = {}) {
  return { stateDir: path.join(runRoot, dir), storageKey: key, authorizePhone: auth, authorizePlugin: auth,
    callbackOrigins: [callbackOrigin], browserOrigins: ['https://phone.example.test'], now: time,
    reauthorizeSubscription: async actor => active && actor.ownerId === 'ownerA' && actor.principalId === 'dotA',
    audit: entry => audits.push(entry), rateLimit: 1000,
    webhookTransport: async (url, init) => {
      const response = await fetch(callbackBase + url.pathname, { method: 'POST', headers: init.headers,
        body: init.body, redirect: 'error', signal: init.signal });
      return { status: response.status, body: await response.text() };
    }, ...extra };
}
async function start(dir, extra) {
  const inbox = createDotInbox(options(dir, extra)); resources.push(inbox);
  const address = await inbox.listen(); inbox.base = 'http://127.0.0.1:' + address.port;
  return inbox;
}
async function rpc(inbox, token, method, params = {}, headers = {}) {
  const meta = { 'io.modelcontextprotocol/protocolVersion': VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'isolated-http-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {} };
  return call(inbox.base, '/mcp', token, { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } },
    { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': VERSION, 'Mcp-Method': method,
      ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}), ...headers });
}
const tool = (inbox, token, name, args, headers) => rpc(inbox, token, 'tools/call', { name, arguments: args }, headers);
async function create(inbox, token = phoneA, queue = 'main', message = 'Private synthetic test message', requestNonce = nonce(), issuedAt = clock) {
  const result = await call(inbox.base, '/dot-inbox/requests', token,
    { queue_id: queue, text: message, nonce: requestNonce, issued_at: issuedAt });
  if (result.status === 201) createdRequests.push(result.body);
  return result;
}
const poll = (inbox, request, token = phoneA, capability = request.capability, queue = request.queue_id) =>
  call(inbox.base, '/dot-inbox/request', token, { queue_id: queue, request_id: request.request_id, capability });
function subscribe(inbox, route = '/main', signingSecret = secret, extra = {}, token = pluginA, queue = 'main') {
  return rpc(inbox, token, 'events/subscribe', { name: EVENT, arguments: { queue_id: queue },
    delivery: { mode: 'webhook', url: callbackOrigin + route, secret: signingSecret }, cursor: null, ...extra });
}
async function main() {
  equal(chooseTestRoot('linux', undefined, '/tmp'), '/tmp/pocket-bridge-dot-inbox-tests', 'Linux default uses its actual temporary root');
  equal(chooseTestRoot('darwin', '/private/test-fixtures', '/tmp'), '/private/test-fixtures', 'Non-Windows absolute override');
  equal(chooseTestRoot('win32', 'D:\\fixture-tests', 'C:\\Temp'), 'D:\\fixture-tests', 'Windows override remains on D');
  assert.throws(() => chooseTestRoot('linux', 'relative-fixtures', '/tmp'), /absolute/); checks++;
  assert.throws(() => chooseTestRoot('win32', 'C:\\Temp\\fixtures', 'C:\\Temp'), /stay on D/); checks++;
  callbackServer = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const acceptedKeys = secrets.get(request.url) || [secret];
    const verified = acceptedKeys.some(signingSecret => verifyWebhook(signingSecret, request.headers, raw, clock));
    if (!verified) { response.writeHead(403); response.end('{}'); return; }
    const body = JSON.parse(raw), mode = modes.get(request.url) || {};
    if (body.type === 'verification') {
      challenges.push({ route: request.url, challenge: body.challenge, headers: request.headers, raw });
      response.writeHead(mode.challengeStatus || 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ challenge: mode.badChallenge ? 'wrong-challenge' : body.challenge }));
    } else {
      receipts.push({ route: request.url, body, headers: request.headers, raw });
      const status = mode.statuses && mode.statuses.length ? mode.statuses.shift() : 200;
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end('{}');
    }
  });
  await new Promise(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
  callbackBase = 'http://127.0.0.1:' + callbackServer.address().port;
  current = await start('main');

  equal((await rpc(current, pluginA, 'server/discover')).body.result.supportedVersions, [VERSION], 'Modern discovery');
  equal((await rpc(current, pluginA, 'events/list')).body.result.events[0].name, EVENT, 'Event discovery');
  equal((await rpc(current, pluginReadOnly, 'events/list')).body.result.events, [], 'No unauthorized events');
  equal((await rpc(current, pluginReadOnly, 'tools/list')).body.result.tools.map(t => t.name),
    ['bridge_list_requests','bridge_read_request'], 'Tools filtered by scope');
  equal((await rpc(current, pluginA, 'initialize')).status, 404, 'Legacy initialization is not silently accepted');
  equal((await rpc(current, pluginA, 'tools/list', {}, { 'Mcp-Method': 'events/list' })).body.error.code, -32020, 'Mirrored method mismatch');
  equal((await rpc(current, pluginA, 'tools/list', {}, { 'MCP-Protocol-Version': '' })).body.error.code, -32020, 'Version header required');
  equal((await tool(current, pluginA, 'bridge_list_requests', { queue_id: 'main' }, { 'Mcp-Name': 'wrong' })).body.error.code, -32020, 'Tool header mismatch');
  equal((await tool(current, pluginA, 'bridge_list_requests', { queue_id: 'main' },
    { 'Mcp-Name': '=?base64?' + Buffer.from('bridge_list_requests').toString('base64') + '?=' })).status, 200, 'Encoded mirrored name');
  const unsupported = await call(current.base, '/mcp', pluginA,
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } },
    { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/list' });
  equal(unsupported.body.error.code, -32022, 'Unsupported protocol uses standard error');
  equal(unsupported.body.error.data.supported, [VERSION], 'Supported version is explicit');
  const missingCapabilities = await call(current.base, '/mcp', pluginA,
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION } } },
    { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': VERSION, 'Mcp-Method': 'tools/list' });
  equal(missingCapabilities.body.error.code, -32602, 'Client capabilities required on every modern request');
  equal((await rpc(current, pluginA, 'tools/list', {}, { Accept: 'application/json' })).status, 406, 'Both transports must be accepted');
  equal((await rpc(current, pluginA, 'tools/list', {}, { Origin: 'https://evil.example.test' })).status, 403, 'Browser origin denied');
  equal((await rpc(current, pluginA, 'tools/list', {}, { Origin: 'https://phone.example.test' })).status, 200, 'Explicit browser origin');
  equal((await fetch(current.base + '/mcp')).status, 405, 'No GET stream');
  equal((await create(current, pluginA)).status, 403, 'Plugin auth cannot create phone messages');
  equal((await rpc(current, phoneA, 'tools/list')).status, 403, 'Phone auth cannot invoke MCP');
  equal((await create(current, 'unknown-token')).status, 403, 'Unrecognized credentials denied');
  equal((await call(current.base, '/dot-inbox/requests?text=private', phoneA, {})).status, 404, 'Query-string endpoints rejected');
  equal((await create(current, phoneA, 'unassigned')).status, 403, 'Phone queue scope');
  equal((await create(current, phoneA, 'main', 'hello', 'short')).status, 400, 'Long random nonce required');
  equal((await create(current, phoneA, 'main', 'hello', nonce(), clock - 300_001)).status, 400, 'Stale requests rejected');
  equal((await create(current, phoneA, 'main', 'x'.repeat(16 * 1024 + 1))).status, 400, 'Text size bounded');

  const requestNonce = nonce(), first = await create(current, phoneA, 'main', 'Private synthetic request NEVER IN EVENT', requestNonce);
  equal(first.status, 201, 'Phone creates request');
  equal(first.headers.get('cache-control'), 'no-store', 'Private responses are not cached');
  check(first.body.capability.length >= 40 && first.body.request_id !== first.body.capability, 'Independent random request capability');
  const second = (await create(current, phoneA, 'second')).body;
  check(second.request_id !== first.body.request_id && second.capability !== first.body.capability, 'Every request has a new ID and capability');
  equal((await create(current, phoneA, 'main', 'replay', requestNonce)).status, 409, 'Creation replay rejected');
  equal((await poll(current, first.body)).body.reply, null, 'Pending is not completed');
  equal((await poll(current, first.body, phoneB)).status, 403, 'Different owner denied');
  equal((await poll(current, first.body, phoneOtherDevice)).status, 403, 'Another phone identity denied');
  equal((await poll(current, first.body, phoneA, second.capability)).status, 403, 'Capabilities are request-specific');
  equal((await poll(current, first.body, phoneA, first.body.capability, 'second')).status, 403, 'Queue cannot be substituted');
  equal((await tool(current, pluginB, 'bridge_read_request', { queue_id: 'main', request_id: first.body.request_id })).status, 403, 'Other plugin owner denied');
  equal((await tool(current, pluginNarrow, 'bridge_read_request', { queue_id: 'main', request_id: first.body.request_id })).status, 403, 'Plugin queue scope');
  const read = await tool(current, pluginA, 'bridge_read_request', { queue_id: 'main', request_id: first.body.request_id });
  equal(read.body.result.structuredContent.request.text, 'Private synthetic request NEVER IN EVENT', 'Exact authorized read');
  const list = await tool(current, pluginA, 'bridge_list_requests', { queue_id: 'main' });
  check(!JSON.stringify(list.body).includes('NEVER IN EVENT'), 'List returns metadata only');
  equal((await tool(current, pluginA, 'bridge_list_requests', { queue_id: 'main', unexpected: true })).status, 400, 'Strict tool arguments');
  const reply = { queue_id: 'main', request_id: first.body.request_id, reply_id: crypto.randomUUID(), text: 'Private synthetic reply' };
  equal((await tool(current, pluginReadOnly, 'bridge_write_reply', reply)).status, 403, 'Read credential cannot write');
  equal((await tool(current, pluginA, 'bridge_write_reply', reply)).status, 200, 'Plugin replies');
  equal((await tool(current, pluginA, 'bridge_write_reply', reply)).status, 200, 'Same reply is idempotent');
  equal((await tool(current, pluginA, 'bridge_write_reply', { ...reply, text: 'different' })).status, 409, 'Different final reply rejected');
  equal((await poll(current, first.body)).body.reply, reply.text, 'Phone receives exact reply');

  modes.set('/bad', { badChallenge: true });
  equal((await subscribe(current, '/bad')).body.error.code, -32015, 'Incorrect challenge fails closed');
  const oldChallenges = challenges.length;
  modes.set('/bad', {});
  equal((await subscribe(current, '/bad')).status, 200, 'Fresh verification after failed challenge');
  check(challenges.length === oldChallenges + 1 && challenges.at(-1).challenge !== challenges.at(-2).challenge, 'Unique single-use challenge');
  await rpc(current, pluginA, 'events/unsubscribe', { name: EVENT, arguments: { queue_id: 'main' }, delivery: { mode: 'webhook', url: callbackOrigin + '/bad' } });
  equal((await subscribe(current, '/main', 'whsec_' + crypto.randomBytes(16).toString('base64'))).status, 400, 'Signing key length checked');
  equal((await subscribe(current, '/main', secret, { cursor: 'unsupported-history' })).status, 400, 'No invented event replay');
  equal((await subscribe(current, '/main', secret, { ttlMs: 0 })).status, 400, 'Subscription lifetime validated');
  const badUrls = ['http://receiver.example.test/main','https://unapproved.example.test/main',
    'https://user:pass@receiver.example.test/main','https://receiver.example.test/main#fragment'];
  for (const url of badUrls) equal((await subscribe(current, '/main', secret,
    { delivery: { mode: 'webhook', url, secret } })).status, 400, 'Invalid callback rejected');
  equal((await subscribe(current, '/main', secret, {}, pluginReadOnly)).status, 403, 'Subscribe scope required');

  const subscription = await subscribe(current);
  equal(subscription.status, 200, 'Signed challenge accepted');
  equal(subscription.body.result.cursor, null, 'Non-replayable event declared');
  const challengeCount = challenges.length;
  equal((await subscribe(current)).body.result.id, subscription.body.result.id, 'Subscription identity stable');
  equal(challenges.length, challengeCount, 'Verification cached for bounded same-key refresh');
  const eventRequest = (await create(current, phoneA, 'main', 'Secret payload excluded from webhook')).body;
  modes.set('/main', { statuses: [503, 200] });
  const previousReceipts = receipts.length;
  await current.drain();
  equal(receipts.length, previousReceipts + 1, 'Event delivered once per attempt');
  equal((await poll(current, eventRequest)).body.status, 'pending', '2xx/5xx webhook receipt never pretends to be a Dot reply');
  clock += 301;
  await current.drain();
  equal(receipts.length, previousReceipts + 2, 'Transient failure retries');
  equal(receipts.at(-1).body.eventId, receipts.at(-2).body.eventId, 'Retry preserves event ID');
  equal(receipts.at(-1).raw, receipts.at(-2).raw, 'Retry signs identical event bytes');
  check(!receipts.at(-1).raw.includes('Secret payload'), 'Event includes metadata, never private message text');
  equal(receipts.at(-1).headers['webhook-id'], receipts.at(-1).body.eventId, 'Signature ID matches event');
  equal((await poll(current, eventRequest)).body.status, 'pending', 'Receipt acknowledged without claiming completion');
  const verifiedHeader = receipts.at(-1).headers, verifiedBody = receipts.at(-1).raw;
  check(verifyWebhook(secret, verifiedHeader, verifiedBody, clock), 'Valid HMAC accepted');
  check(!verifyWebhook(secret, verifiedHeader, verifiedBody + ' ', clock), 'Altered bytes rejected');
  check(!verifyWebhook(secondSecret, verifiedHeader, verifiedBody, clock), 'Wrong HMAC key rejected');
  check(!verifyWebhook(secret, verifiedHeader, verifiedBody, clock + 301_000), 'Old signing timestamp rejected');
  const seen = new Map();
  check(verifyWebhook(secret, verifiedHeader, verifiedBody, clock, seen), 'First verified receipt accepted');
  check(!verifyWebhook(secret, verifiedHeader, verifiedBody, clock, seen), 'Replayed receipt does not execute twice');

  // Subscriptions, outstanding requests, reply capabilities and nonce protection survive restart.
  await current.close(); current = await start('main');
  equal((await poll(current, first.body)).body.reply, reply.text, 'Reply survives restart');
  equal((await create(current, phoneA, 'main', 'replay after restart', requestNonce)).status, 409, 'Nonce survives restart');
  const afterRestart = (await create(current)).body;
  await current.drain();
  equal(receipts.at(-1).body.data.request_id, afterRestart.request_id, 'Persisted subscription resumes delivery');
  equal(receipts.at(-1).headers['x-mcp-subscription-id'], subscription.body.result.id, 'Persisted subscription keeps owner identity');
  const disk = fs.readFileSync(path.join(runRoot, 'main', 'inbox.enc.json'), 'utf8');
  check(!disk.includes('Private synthetic') && !disk.includes('whsec_') && !disk.includes(first.body.capability), 'Persistent state encrypted, no plaintext credentials/content');
  assert.throws(() => createDotInbox(options('main')), /already has an owner/); checks++;

  // Refresh verifies a new key, then uses both keys for the documented short rotation window.
  secrets.set('/main', [secret, secondSecret]);
  equal((await subscribe(current, '/main', secondSecret)).body.result.id, subscription.body.result.id, 'Secret rotation keeps subscription identity');
  await create(current); await current.drain();
  check(verifyWebhook(secret, receipts.at(-1).headers, receipts.at(-1).raw, clock) &&
    verifyWebhook(secondSecret, receipts.at(-1).headers, receipts.at(-1).raw, clock), 'Rotation signs with old and new keys');
  clock += 60_001;
  await create(current); await current.drain();
  check(!verifyWebhook(secret, receipts.at(-1).headers, receipts.at(-1).raw, clock) &&
    verifyWebhook(secondSecret, receipts.at(-1).headers, receipts.at(-1).raw, clock), 'Old key retired');

  modes.set('/main', { statuses: [410] });
  await create(current); const beforeGone = receipts.length;
  await current.drain(); clock += 10_000; await current.drain();
  equal(receipts.length, beforeGone + 1, '410 is terminal');
  modes.set('/main', { statuses: [413] });
  await create(current); const beforeLarge = receipts.length;
  await current.drain(); clock += 10_000; await current.drain();
  equal(receipts.length, beforeLarge + 1, '413 is terminal');
  modes.set('/main', { statuses: [502, 502, 502, 502, 200] });
  await create(current); const beforeBounded = receipts.length;
  for (let attempt = 0; attempt < 6; attempt++) { await current.drain(); clock += 3000; }
  equal(receipts.length, beforeBounded + 4, 'Retries are bounded at four');
  modes.set('/main', {});

  active = false;
  await create(current); const beforeRevoked = receipts.length;
  await current.drain(); equal(receipts.length, beforeRevoked, 'Revoked plugin access stops delivery');
  active = true; await subscribe(current, '/main', secondSecret, { ttlMs: 1000 });
  await create(current); clock += 1001; const beforeExpiry = receipts.length;
  await current.drain(); equal(receipts.length, beforeExpiry, 'Expired subscription stops delivery');
  await subscribe(current, '/main', secondSecret);
  const unsubParams = { name: EVENT, arguments: { queue_id: 'main' }, delivery: { mode: 'webhook', url: callbackOrigin + '/main' } };
  await create(current);
  equal((await rpc(current, pluginB, 'events/unsubscribe', unsubParams)).status, 200, 'Other owner unsubscribe is an idempotent no-op');
  const beforeOtherUnsub = receipts.length; await current.drain();
  equal(receipts.length, beforeOtherUnsub + 1, 'Other owner cannot unsubscribe target');
  equal((await rpc(current, pluginA, 'events/unsubscribe', unsubParams)).status, 200, 'Owner unsubscribes');
  equal((await rpc(current, pluginA, 'events/unsubscribe', unsubParams)).status, 200, 'Unsubscribe idempotent');
  await create(current); const beforeUnsub = receipts.length; await current.drain();
  equal(receipts.length, beforeUnsub, 'Unsubscribe prevents events');

  const limited = await start('limited', { rateLimit: 2 });
  equal((await rpc(limited, pluginA, 'tools/list')).status, 200, 'First bounded request');
  equal((await rpc(limited, pluginA, 'tools/list')).status, 200, 'Second bounded request');
  equal((await rpc(limited, pluginA, 'tools/list')).status, 429, 'Principal rate limit enforced');
  for (const address of ['127.0.0.1','10.0.0.1','169.254.1.1','100.64.1.1','192.168.1.1','198.18.0.1',
    '224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::1','3fff::1']) {
    check(!isPublicAddress(address), 'Non-public destination rejected');
  }
  check(isPublicAddress('8.8.8.8') && isPublicAddress('2606:4700:4700::1111'), 'Public address policy');
  const protectedTransport = await start('ssrf', { webhookTransport: undefined, callbackOrigins: ['https://127.0.0.1'], rateLimit: 1000 });
  const ssrf = await subscribe(protectedTransport, '/main', secret, { delivery: { mode: 'webhook', url: 'https://127.0.0.1/never-connect', secret } });
  equal(ssrf.body.error.code, -32015, 'Production transport blocks local destination before TLS connection');
  // Exercise cancellation after an actual awaited DNS phase: no late socket is created.
  const originalLookup = dns.lookup, originalHttpsRequest = https.request;
  let finishLookup, socketAttempts = 0;
  try {
    dns.lookup = () => new Promise(resolve => { finishLookup = resolve; });
    https.request = () => { socketAttempts++; throw new Error('Unexpected late socket'); };
    const controller = new AbortController();
    const delayed = pinnedHttps(new URL(callbackOrigin), { signal: controller.signal, headers: {}, body: '{}' });
    controller.abort(new Error('isolated timeout'));
    finishLookup([{ address: '8.8.8.8', family: 4 }]);
    await assert.rejects(delayed, /isolated timeout/); checks++;
    equal(socketAttempts, 0, 'Cancelled DNS cannot start a late callback');
  } finally { dns.lookup = originalLookup; https.request = originalHttpsRequest; }

  let startReauth, releaseReauth;
  const startedReauth = new Promise(resolve => { startReauth = resolve; });
  const waitingReauth = new Promise(resolve => { releaseReauth = resolve; });
  secrets.set('/race', [secret, secondSecret]);
  const rotating = await start('rotation-race', { reauthorizeSubscription: async () => {
    startReauth(); await waitingReauth; return true;
  } });
  await subscribe(rotating, '/race'); await create(rotating);
  const pendingDrain = rotating.drain(); await startedReauth;
  equal((await subscribe(rotating, '/race', secondSecret)).status, 200, 'Refresh succeeds during reauthorization');
  releaseReauth(); await pendingDrain;
  const racedReceipt = receipts.findLast(receipt => receipt.route === '/race');
  check(verifyWebhook(secondSecret, racedReceipt.headers, racedReceipt.raw, clock), 'Delivery re-reads the rotated signing key');

  let transportAborted = false, lateDelivery = false;
  const timeoutInbox = await start('timeout', { webhookTimeoutMs: 20, webhookTransport: async (_url, init) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { lateDelivery = true; resolve(); }, 100);
      init.signal.addEventListener('abort', () => { transportAborted = true; clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(init.body).challenge }) };
  } });
  equal((await subscribe(timeoutInbox)).body.error.data.reason, 'timeout', 'Timeout abort is categorized');
  await new Promise(resolve => setTimeout(resolve, 110));
  check(transportAborted && !lateDelivery, 'Timed-out transport does not deliver later');
  check(audits.every(entry => Object.keys(entry).length === 1 && typeof entry.event === 'string'), 'Audit records contain categories only');

  await current.close(); current = null;
  assert.throws(() => createDotInbox(options('main', { storageKey: crypto.randomBytes(32) })), /cannot be authenticated/); checks++;
  const expiredReplay = await start('main');
  clock += 24 * 60 * 60 * 1000 + 1;
  equal((await create(expiredReplay, phoneA, 'main', 'expired replay', requestNonce, clock - 24 * 60 * 60 * 1000)).status, 400,
    'Unmodified old request cannot replay after nonce retention expires');
  console.log(`PASS: ${checks} isolated Dot inbox HTTP/security checks. No actual Dot/OAuth/TLS acceptance claim.`);
}
main().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; }).finally(async () => {
  for (const inbox of resources) { try { await inbox.close(); } catch { /* Preserve evidence without disclosing state. */ } }
  if (callbackServer && callbackServer.listening) await new Promise(resolve => callbackServer.close(resolve));
  key.fill(0);
  // Keep encrypted synthetic artifacts in the selected fixture directory; never read/remove production state.
});
