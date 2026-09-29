'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createUpstreamAuth } = require('./dsh-upstream-auth');
let checks = 0;
function check(label, fn) { fn(); checks++; }
const AUTHORITY = '127.0.0.1:58347';
const HTML = '<!doctype html><title>DSH</title><script type="module" src="/assets/index-fixture.js"></script>';
const secretA = Buffer.alloc(32, 21), secretB = Buffer.alloc(32, 39), secretC = Buffer.alloc(32, 58);
const yaml = secret => `refs:\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: ${secret.toString('base64url')}\n`;
const modern = (port = 19387, pid = 200) => ({ running: true, port, pid, profile: 'remote-mux',
  httpEvidence: 'dsh-auth-challenge', capabilities: { browserAuth: true } });

function virtualFs(files = {}) {
  const records = new Map(); let revision = 1, reads = 0, stats = 0;
  const set = (file, text) => records.set(file, { text, revision: revision++ });
  for (const [file, text] of Object.entries(files)) set(file, text);
  return {
    set, remove: file => records.delete(file), counters: () => ({ reads, stats }),
    statSync(file) {
      stats++; const record = records.get(file); if (!record) throw new Error('missing-private-path');
      return { isFile: () => true, size: Buffer.byteLength(record.text), mtimeMs: record.revision, ctimeMs: record.revision, ino: record.revision };
    },
    readFileSync(file) { reads++; const record = records.get(file); if (!record) throw new Error('missing-private-path'); return record.text; }
  };
}

function cookieValid(header, expected, authority = AUTHORITY) {
  if (!header || !expected) return false;
  const cookieName = 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url');
  if (!header.startsWith(cookieName + '=')) return false;
  const parts = header.slice(cookieName.length + 1).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return payload.authority === authority && payload.version === 1 && payload.expiresAt > payload.issuedAt &&
    parts[2] === crypto.createHmac('sha256', expected).update(parts[1]).digest('base64url');
}

function fakeHttp(state = {}) {
  const calls = [], delayed = [];
  return {
    calls, delayed,
    request(options, callback) {
      calls.push(options);
      const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
      req.end = () => {
        const serverSecret = (state.secrets || {})[options.port];
        const accepted = cookieValid(options.headers.Cookie, serverSecret);
        const response = state.response || (accepted ? { statusCode: 200, headers: { 'content-type': 'text/html' }, body: HTML } :
          { statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'dsh web authentication required; reopen the URL printed by dsh web.' });
        const complete = () => {
          if (state.timeout) { req.emit('timeout'); return; }
          if (state.error) { req.emit('error', new Error('private-token-error-must-not-leak')); return; }
          const res = new EventEmitter(); res.statusCode = response.statusCode; res.headers = response.headers;
          res.complete = true; res.destroy = () => { res.destroyed = true; };
          callback(res);
          if (!res.destroyed) { res.emit('data', response.body); res.emit('end'); res.emit('close'); }
        };
        if (state.defer) delayed.push(complete); else process.nextTick(complete);
      };
      return req;
    }
  };
}

(async () => {
  let time = 1000;
  const io = virtualFs(), state = { secrets: { 19387: secretA } }, http = fakeHttp(state);
  const auth = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: () => ['/store/.credentials.yaml'], fs: io, http, now: () => time });
  const missing = await auth.resolve(modern());
  check('initial missing browser grant fails without sending any cookie', () => { assert.equal(missing.ok, false); assert.equal(http.calls.length, 0); });
  io.set('/store/.credentials.yaml', yaml(secretA));
  const newlyCreated = await auth.resolve(modern());
  check('first CLI startup grant appears without gateway restart', () => { assert.equal(newlyCreated.ok, true); assert.ok(newlyCreated.cookie); });
  check('new cookie uses existing DSH signing scheme and authority', () => assert.equal(cookieValid(`${newlyCreated.cookie.name}=${newlyCreated.cookie.value}`, secretA), true));
  check('cookie has bounded 30 day expiry', () => {
    const payload = JSON.parse(Buffer.from(newlyCreated.cookie.value.split('.')[1], 'base64url'));
    assert.equal(payload.expiresAt - payload.issuedAt, 30 * 24 * 60 * 60 * 1000);
  });
  check('verification is unauthenticated-RPC-free loopback GET with fixed Host', () => {
    const r = http.calls[0]; assert.equal(r.hostname, '127.0.0.1'); assert.equal(r.path, '/'); assert.equal(r.method, 'GET');
    assert.equal(r.headers.Host, AUTHORITY); assert.equal(r.headers.Authorization, undefined); assert.equal(r.headers['Accept-Encoding'], 'identity');
  });
  const beforeCache = http.calls.length;
  await auth.resolve(modern());
  check('unchanged verified grant uses cache', () => assert.equal(http.calls.length, beforeCache));
  time += 5000; await auth.resolve(modern());
  check('positive cookie verification expires after five seconds', () => assert.equal(http.calls.length, beforeCache + 1));
  io.set('/store/.credentials.yaml', yaml(secretB)); state.secrets[19387] = secretB;
  const rotated = await auth.resolve(modern());
  check('credential rotation immediately invalidates existing cache', () => { assert.equal(rotated.ok, true); assert.notEqual(rotated.cookie.value, newlyCreated.cookie.value); assert.ok(cookieValid(`${rotated.cookie.name}=${rotated.cookie.value}`, secretB)); });
  state.secrets[19388] = secretB;
  const movedCount = http.calls.length; const moved = await auth.resolve(modern(19388, 201));
  check('new runtime port and pid require verification', () => { assert.equal(moved.ok, true); assert.equal(http.calls.length, movedCount + 1); assert.equal(http.calls.at(-1).port, 19388); });
  state.secrets[19388] = secretC;
  const rejected = await auth.resolve(modern(19388, 201), { force: true });
  check('failed authentication clears positive result without a downgrade', () => { assert.equal(rejected.ok, false); assert.equal(rejected.cookie, undefined); });
  check('failure reason contains no credential path, key or server error', () => {
    assert.ok(!JSON.stringify(rejected).includes('/store')); assert.ok(!JSON.stringify(rejected).includes(secretB.toString('base64url'))); assert.ok(!JSON.stringify(rejected).includes('private-token'));
  });

  const secondIo = virtualFs({ '/old-store': yaml(secretA), '/active-store': yaml(secretB) });
  const secondHttp = fakeHttp({ secrets: { 19387: secretB } });
  const second = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: ['/old-store', '/active-store'], fs: secondIo, http: secondHttp });
  const selected = await second.resolve(modern());
  check('mismatched credential store advances to next known candidate', () => { assert.equal(selected.ok, true); assert.equal(secondHttp.calls.length, 2); assert.ok(cookieValid(`${selected.cookie.name}=${selected.cookie.value}`, secretB)); });
  const limitIo = virtualFs(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/candidate-${i}`, yaml(secretA)])));
  const limitHttp = fakeHttp({ secrets: { 19387: secretB } });
  const limited = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: Array.from({ length: 10 }, (_, i) => `/candidate-${i}`), fs: limitIo, http: limitHttp });
  await limited.resolve(modern());
  check('credential probes have a maximum of eight candidates', () => { assert.equal(limitHttp.calls.length, 8); assert.equal(limitIo.counters().reads, 8); });

  const invalidIo = virtualFs({ '/invalid': 'records:\n  client-connection/browser-session:\n    payload: {}\n  another-record:\n    secret: ' + secretA.toString('base64url') });
  const invalidHttp = fakeHttp({ secrets: { 19387: secretA } });
  const invalid = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: ['/invalid'], fs: invalidIo, http: invalidHttp });
  const wrongRecord = await invalid.resolve(modern());
  check('secret from another credential record is never used', () => { assert.equal(wrongRecord.ok, false); assert.equal(invalidHttp.calls.length, 0); });
  const malformed = virtualFs({ '/invalid': yaml(secretA).replace(secretA.toString('base64url'), 'short-value') });
  const malformedAuth = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: ['/invalid'], fs: malformed, http: invalidHttp });
  check('invalid key length fails without requesting authentication', () => assert.equal((invalidHttp.calls.length), 0));
  const badKey = await malformedAuth.resolve(modern());
  check('malformed key is rejected', () => assert.equal(badKey.ok, false));
  const largeIo = virtualFs({ '/large': 'x'.repeat(256 * 1024 + 1) });
  const largeFile = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: ['/large'], fs: largeIo, http: invalidHttp });
  await largeFile.resolve(modern());
  check('oversized credential file is not read', () => assert.equal(largeIo.counters().reads, 0));

  const legacyHttp = fakeHttp();
  const legacy = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: () => { throw new Error('legacy needs no secrets'); }, http: legacyHttp });
  const legacyResult = await legacy.resolve({ running: true, port: 18001, pid: 2, profile: 'legacy-events', httpEvidence: 'dsh-app-html', capabilities: { browserAuth: false } });
  check('legacy unauthenticated transport succeeds without minting a cookie', () => { assert.deepEqual(legacyResult, { ok: true, cookie: null }); assert.equal(legacyHttp.calls.length, 0); });
  const contradictory = await legacy.resolve({ ...modern(), profile: 'legacy-events', capabilities: { browserAuth: false } });
  check('modern HTTP auth evidence prevents legacy downgrade', () => assert.equal(contradictory.ok, false));
  for (const r of [{ ...modern(), running: false }, { ...modern(), port: 65536 }, { ...modern(), httpEvidence: null }, { ...modern(), httpEvidence: 'generic-html' }]) {
    const got = await second.resolve(r);
    check('unverified runtime cannot receive credential cookies', () => assert.equal(got.ok, false));
  }

  for (const response of [
    { statusCode: 303, headers: { location: '/' }, body: '' },
    { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}' },
    { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<title>Generic dashboard</title>' },
    { statusCode: 200, headers: { 'content-type': 'text/html' }, body: HTML + 'x'.repeat(128 * 1024) }
  ]) {
    const transport = fakeHttp({ response });
    const instance = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: ['/old-store'], fs: secondIo, http: transport });
    const got = await instance.resolve(modern());
    check('redirect, non-DSH, non-HTML and oversized responses reject authentication', () => { assert.equal(got.ok, false); assert.equal(transport.calls.length, 1); });
  }
  for (const failure of ['timeout', 'error']) {
    const transport = fakeHttp({ [failure]: true });
    const instance = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: ['/old-store'], fs: secondIo, http: transport, timeoutMs: 10 });
    const got = await instance.resolve(modern());
    check('timeout and transport error resolve without secrets in output', () => { assert.equal(got.ok, false); assert.ok(!JSON.stringify(got).includes('private-token')); });
  }
  check('invalid Host authority refuses header injection', () => assert.throws(() => createUpstreamAuth({ authority: '127.0.0.1:58347\r\nCookie: fake' })));

  const sharedState = { secrets: { 19387: secretA }, defer: true };
  const sharedIo = virtualFs({ '/grant': yaml(secretA) }), sharedHttp = fakeHttp(sharedState);
  const shared = createUpstreamAuth({ authority: AUTHORITY, credentialCandidates: ['/grant'], fs: sharedIo, http: sharedHttp, now: () => time });
  const oldWork = shared.resolve(modern());
  const joined = shared.resolve(modern());
  check('concurrent unchanged reads share pending verification', () => assert.equal(sharedHttp.calls.length, 1));
  const fresh = shared.resolve(modern(), { force: true });
  check('forced refresh does not join an older in-flight request', () => assert.equal(sharedHttp.calls.length, 2));
  sharedHttp.delayed[1](); const freshResult = await fresh;
  sharedHttp.delayed[0](); await oldWork; await joined;
  const afterOld = await shared.resolve(modern());
  check('older completion cannot overwrite newer cache result', () => { assert.strictEqual(afterOld, freshResult); assert.equal(sharedHttp.calls.length, 2); });
  sharedIo.set('/grant', yaml(secretB)); sharedState.secrets[19387] = secretB;
  const rotation = shared.resolve(modern());
  check('stat change while otherwise cached starts new verification', () => assert.equal(sharedHttp.calls.length, 3));
  sharedHttp.delayed[2](); const latest = await rotation;
  check('newly rotated grant verifies using the new key', () => assert.ok(cookieValid(`${latest.cookie.name}=${latest.cookie.value}`, secretB)));
  console.log(`DSH upstream auth: ${checks} isolated checks passed; no live credentials, processes or network used.`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
