'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createBackupPreparation } = require('./backup-preparation.js');
const { createBackupPreparationHttp } = require('./backup-preparation-http.js');
const { FRESHNESS_MS } = require('./tunnel-state.js');
const { extractFunction } = require('./page-source.js');
const now = 1800000000000, origin = 'https://fixture-backup.trycloudflare.com', primary = 'https://fixture-main.trycloudflare.com';
const generation = 'a'.repeat(32), nonce = 'b'.repeat(48), challenge = 'c'.repeat(48), deviceId = 'fixture_device_id';
const primaryGeneration = 'd'.repeat(32);
function fixture() {
  let active = true, nullToken = false;
  const reissues = [];
  const context = { enabled: true, supported: true, instanceId: '11111111-1111-1111-1111-111111111111',
    bootId: '22222222-2222-2222-2222-222222222222', port: 8080, accessVersion: 'a'.repeat(64), e2eeVersion: 'b'.repeat(64),
    backup: { origin, generation, phase: 'ready', reachable: true, checkedAt: now },
    primary: { origin: primary, generation: primaryGeneration, phase: 'ready', reachable: true, checkedAt: now } };
  const preparation = createBackupPreparation({ readContext: () => context, isDeviceActive: () => active,
    reissueDevice: (id, authority) => { reissues.push({ id, authority }); return nullToken ? null : 'SYNTHETIC_COOKIE_TOKEN'; }, now: () => now });
  const http = createBackupPreparationHttp({ preparation, readContext: () => context,
    now: () => now,
    receiverHtml: () => '<script type="application/json">__PB_PREPARATION_CONTEXT__</script>',
    authCookies: token => { assert.equal(token, 'SYNTHETIC_COOKIE_TOKEN'); return ['fixture=SYNTHETIC_COOKIE_TOKEN; HttpOnly']; } });
  function request(input, from = primary, patch = {}) {
    const req = Readable.from([Buffer.from(typeof input === 'string' ? input : JSON.stringify(input))]);
    Object.assign(req, { method: 'POST', headers: { origin: from, host: new URL(from).host, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', 'x-dsh-e2ee': '1' }, __dshE2eeDecrypted: true }, patch);
    return req;
  }
  function result() { return { writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; try { this.json = JSON.parse(body); } catch (_) {} this.writableEnded = true; } }; }
  async function call(input, from = primary, patch = {}, device = { id: deviceId, proven: true }) {
    const res = result(); await http.protectedAction(request(input, from, patch), res, device); return res;
  }
  async function redeem(ticket, from = origin, extra = {}) {
    const res = result(); await http.redeem(request({ ticket, nonce, challenge, ...extra }, from), res); return res;
  }
  return { context, preparation, http, request, result, call, redeem, reissues, revoke() { active = false; }, failReissue() { nullToken = true; } };
}
(async () => {
  for (const sourceRole of ['primary', 'backup']) {
    const f = fixture(), source = f.context[sourceRole].origin;
    const { origin, generation } = f.context[sourceRole === 'primary' ? 'backup' : 'primary'];
    const before = structuredClone(f.context);
    const issued = await f.call({ action: 'issue', origin, generation, nonce, challenge }, source); assert.equal(issued.status, 200);
    const redeemed = await f.redeem(issued.json.ticket, origin); assert.equal(redeemed.status, 200);
    assert.deepEqual(f.reissues, [{ id: deviceId, authority: new URL(origin).host }]);
    assert.match(redeemed.headers['set-cookie'][0], /HttpOnly/); assert.match(redeemed.headers['set-cookie'][0], /; Secure/); assert.doesNotMatch(redeemed.body, /SYNTHETIC_COOKIE|token/);
    assert.equal((await f.redeem(issued.json.ticket, origin)).status, 403, 'ticket is one-use');
    const input = { action: 'complete', preparationId: issued.json.preparationId, origin, generation, nonce, challenge };
    assert.equal((await f.call(input, origin)).status, 403, 'completion cannot precede recipient verification');
    const proof = { action: 'confirm-receiver', preparationId: issued.json.preparationId, receipt: redeemed.json.receipt, nonce, challenge };
    assert.equal((await f.call(proof, origin)).status, 403, 'receiving cookie cannot confirm a source receipt');
    const confirmed = await f.call(proof, source); assert.equal(confirmed.json.receiverVerified, true);
    assert.doesNotMatch(confirmed.body, /bpr1_|SYNTHETIC_COOKIE/); assert.equal((await f.call(proof, source)).status, 403, 'receipt is one-use');
    assert.equal((await f.call(input, source)).status, 403, 'source cookie/proof cannot complete receiving origin');
    assert.equal((await f.call(input, origin, {}, { id: deviceId, proven: false })).status, 403);
    const completed = await f.call(input, origin); assert.equal(completed.status, 200);
    const status = await f.call({ action: 'status', preparationId: issued.json.preparationId }, source); assert.equal(status.json.phase, 'completed');
    assert.doesNotMatch(status.body, /bp1_|bpr1_|token|SYNTHETIC/);
    for (const action of ['status', 'revoke'])
      assert.equal((await f.call({ action, preparationId: issued.json.preparationId }, origin)).status, 403);
    assert.deepEqual(f.context, before, 'preparation never rewrites the global slot configuration');
    const cancelled = await f.call({ action: 'revoke', preparationId: issued.json.preparationId }, source); assert.equal(cancelled.status, 200);
    assert.equal((await f.call({ action: 'status', preparationId: issued.json.preparationId }, source)).status, 403);
  }
  for (const patch of [{ method: 'GET' }, { __dshE2eeDecrypted: false }, { headers: {} },
    { headers: { origin: primary, host: new URL(primary).host, 'content-type': 'text/plain', 'x-dsh-e2ee': '1' } },
    { headers: { origin: 'https://evil.example', host: new URL(primary).host, 'content-type': 'application/json', 'x-dsh-e2ee': '1' } },
    { headers: { origin: primary, host: new URL(primary).host, 'content-type': 'application/json', 'x-dsh-e2ee': '1', 'sec-fetch-site': 'cross-site' } }]) {
    const f = fixture(); assert.equal((await f.call({ action: 'issue', origin, generation, nonce, challenge }, primary, patch)).status, 403);
  }
  for (const input of ['x'.repeat(4097), '{', '[]', 'null', { action: 'unknown' }]) {
    const f = fixture(); assert.equal((await f.call(input)).status, 403);
  }
  for (const from of ['https://unknown.trycloudflare.com', 'https://unknown.example',
    'http://localhost:8080', 'https://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    const f = fixture();
    assert.equal((await f.call({ action: 'issue', origin, generation, nonce, challenge, sourceOrigin: primary }, from)).status, 403,
      'body cannot substitute a current source for the actual request origin');
    assert.equal(f.reissues.length, 0);
  }
  for (const sourceRole of ['primary', 'backup']) {
    const targetRole = sourceRole === 'primary' ? 'backup' : 'primary';
    const changes = [
      context => { context.enabled = false; },
      context => { context.supported = false; },
      ...['primary', 'backup'].flatMap(role => [
        context => { context[role].checkedAt = now - FRESHNESS_MS - 1; },
        context => { context[role].checkedAt = now + 1; },
        context => { context[role].phase = 'unreachable'; },
        context => { context[role].reachable = false; },
        context => { context[role].origin = null; }
      ]),
      context => { context.primary.origin = context.backup.origin; }
    ];
    for (const change of changes) {
      const f = fixture(), source = f.context[sourceRole].origin, target = { ...f.context[targetRole] };
      change(f.context);
      const issued = await f.call({ action: 'issue', origin: target.origin, generation: target.generation, nonce, challenge }, source);
      assert.equal(issued.status, 403); assert.equal(issued.headers['set-cookie'], undefined);
      assert.equal(f.reissues.length, 0);
    }
    for (const target of ['https://unknown.trycloudflare.com', 'https://unknown.example',
      'http://localhost:8080', fixture().context[sourceRole].origin]) {
      const f = fixture();
      assert.equal((await f.call({ action: 'issue', origin: target, generation: f.context[targetRole].generation, nonce, challenge },
        f.context[sourceRole].origin)).status, 403);
      assert.equal(f.reissues.length, 0);
    }
    for (const changedRole of ['primary', 'backup']) {
      for (const phase of ['redeem', 'confirm-receiver', 'complete', 'status']) {
        for (const property of ['origin', 'generation', 'roles']) {
          const f = fixture(), source = f.context[sourceRole].origin, target = { ...f.context[targetRole] };
          const issued = await f.call({ action: 'issue', origin: target.origin, generation: target.generation, nonce, challenge }, source);
          assert.equal(issued.status, 200);
          const preparationId = issued.json.preparationId;
          const redeemed = phase === 'redeem' ? null : await f.redeem(issued.json.ticket, target.origin);
          const proof = { action: 'confirm-receiver', preparationId, receipt: redeemed?.json.receipt, nonce, challenge };
          if (phase === 'complete') assert.equal((await f.call(proof, source)).status, 200);
          if (property === 'roles') [f.context.primary, f.context.backup] = [f.context.backup, f.context.primary];
          else f.context[changedRole][property] = property === 'origin' ? 'https://replacement.trycloudflare.com' : 'e'.repeat(32);
          const response = phase === 'redeem' ? await f.redeem(issued.json.ticket, target.origin) :
            phase === 'confirm-receiver' ? await f.call(proof, source) :
              await f.call({ action: phase, preparationId, origin: target.origin, generation: target.generation, nonce, challenge },
                phase === 'complete' ? target.origin : source);
          assert.equal(response.status, 403, sourceRole + '/' + changedRole + '/' + phase + '/' + property);
          assert.equal(response.headers['set-cookie'], undefined);
          if (phase === 'redeem') assert.equal(f.reissues.length, 0);
          else assert.equal((await f.call({ action: 'revoke', preparationId }, source)).status, 200,
            'original source may cancel after either slot changes');
        }
      }
    }
  }
  for (const change of ['revoked', 'disabled', 'generation', 'boot', 'port', 'key', 'null-token', 'wrong-host', 'wrong-challenge']) {
    const f = fixture(); const issued = await f.call({ action: 'issue', origin, generation, nonce, challenge });
    if (change === 'revoked') f.revoke(); if (change === 'disabled') f.context.enabled = false;
    if (change === 'generation') f.context.backup.generation = 'd'.repeat(32); if (change === 'boot') f.context.bootId = '33333333-3333-3333-3333-333333333333';
    if (change === 'port') f.context.port++; if (change === 'key') f.context.e2eeVersion = 'd'.repeat(64); if (change === 'null-token') f.failReissue();
    const response = await f.redeem(issued.json.ticket, change === 'wrong-host' ? primary : origin, change === 'wrong-challenge' ? { challenge: 'd'.repeat(48) } : {});
    assert.equal(response.status, 403, change); assert.equal(response.headers['set-cookie'], undefined, 'never partial cookie after failure');
    assert.doesNotMatch(response.body, /SYNTHETIC|bp1_|bpr1_/);
  }
  for (const sourceRole of ['primary', 'backup']) {
    const f = fixture(), source = f.context[sourceRole].origin, target = f.context[sourceRole === 'primary' ? 'backup' : 'primary'].origin;
    const res = f.result(), url = new URL(target + '/__backup/prepare?source=' + encodeURIComponent(source) + '&nonce=' + nonce);
    f.http.landing({ method: 'GET', headers: { host: new URL(target).host } }, res, url);
    assert.equal(res.status, 200); assert.equal(res.headers['referrer-policy'], 'no-referrer'); assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(res.headers.location, undefined);
    assert.doesNotMatch(res.body, /SYNTHETIC|bp1_|bpr1_/);
    assert.equal(res.headers['set-cookie'], undefined); assert.equal(f.reissues.length, 0, 'GET never creates a session');
    const config = JSON.parse(res.body.replace(/^.*?<script[^>]*>/, '').replace(/<\/script>.*$/, ''));
    assert.equal(config.origin, target); assert.equal(config.source, source);
    for (const candidate of ['https://user:pass@evil.example', 'javascript:alert(1)', 'https://evil.example/path',
      'https://evil.example', 'https://stale.trycloudflare.com', 'http://localhost:8080', 'https://localhost:8080', target, source + '/']) {
      url.searchParams.set('source', candidate); const r = f.result();
      f.http.landing({ method: 'GET', headers: { host: new URL(target).host } }, r, url); assert.equal(r.status, 409);
      assert.equal(r.headers['set-cookie'], undefined);
    }
    url.searchParams.set('source', source);
    for (const req of [{ method: 'POST', headers: { host: new URL(target).host } },
      { method: 'GET', headers: { host: new URL(source).host } }]) {
      const r = f.result(); f.http.landing(req, r, url); assert.equal(r.status, 409);
    }
    for (const role of ['primary', 'backup']) {
      f.context[role].checkedAt = now - FRESHNESS_MS - 1;
      const r = f.result(); f.http.landing({ method: 'GET', headers: { host: new URL(target).host } }, r, url);
      assert.equal(r.status, 409); f.context[role].checkedAt = now;
    }
    f.context.primary.origin = f.context.backup.origin;
    const duplicate = f.result(); f.http.landing({ method: 'GET', headers: { host: new URL(target).host } }, duplicate, url);
    assert.equal(duplicate.status, 409); assert.equal(f.reissues.length, 0);
  }
  // Re-run the actual post-decryption cookie verifier with strictly synthetic
  // dependencies; legacy verification success does not excuse a wrong authority.
  const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
  for (const mode of ['valid', 'no-auth-cookie', 'invalid-device', 'unproven', 'wrong-authority']) {
    const token = 'fixture.' + Buffer.from(JSON.stringify({ a: mode === 'wrong-authority' ? new URL(primary).host : new URL(origin).host })).toString('base64url') + '.signature';
    const c = { Buffer, hasAuthCookie: () => mode !== 'no-auth-cookie', readDeviceToken: () => token,
      authProvenAt: () => mode !== 'unproven', sessions: { verify: () => ({ ok: mode !== 'invalid-device', device: { id: deviceId } }) } };
    vm.createContext(c); vm.runInContext(extractFunction(gateway, 'verifiedBackupPreparationDevice'), c);
    assert.equal(!!c.verifiedBackupPreparationDevice({ headers: { host: new URL(origin).host } }), mode === 'valid');
  }
  assert.match(gateway, /protectedAction\(decrypted, response,\s*verifiedBackupPreparationDevice\(decrypted\)\)/);
  assert.match(gateway, /'\/__dsh\/lite-addresses', '\/__dsh\/backup-prepare'/);
  console.log('Backup preparation HTTP: encrypted source gates, cookie/proof authority, receiver receipts, one-time expiry/rotation, no redirects or credential bodies passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
