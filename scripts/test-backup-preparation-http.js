'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createBackupPreparation } = require('./backup-preparation.js');
const { createBackupPreparationHttp } = require('./backup-preparation-http.js');
const { extractFunction } = require('./page-source.js');
const now = 1800000000000, origin = 'https://fixture-backup.trycloudflare.com', primary = 'https://fixture-main.trycloudflare.com';
const generation = 'a'.repeat(32), nonce = 'b'.repeat(48), challenge = 'c'.repeat(48), deviceId = 'fixture_device_id';
function fixture() {
  let active = true, nullToken = false;
  const context = { enabled: true, supported: true, instanceId: '11111111-1111-1111-1111-111111111111',
    bootId: '22222222-2222-2222-2222-222222222222', port: 8080, accessVersion: 'a'.repeat(64), e2eeVersion: 'b'.repeat(64),
    backup: { origin, generation, phase: 'ready', reachable: true, checkedAt: now } };
  const preparation = createBackupPreparation({ readContext: () => context, isDeviceActive: () => active,
    reissueDevice: () => nullToken ? null : 'SYNTHETIC_COOKIE_TOKEN', now: () => now });
  const http = createBackupPreparationHttp({ preparation, readContext: () => context,
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
  return { context, preparation, http, request, result, call, redeem, revoke() { active = false; }, failReissue() { nullToken = true; } };
}
(async () => {
  {
    const f = fixture(), issued = await f.call({ action: 'issue', origin, generation, nonce, challenge }); assert.equal(issued.status, 200);
    const redeemed = await f.redeem(issued.json.ticket); assert.equal(redeemed.status, 200);
    assert.match(redeemed.headers['set-cookie'][0], /HttpOnly/); assert.match(redeemed.headers['set-cookie'][0], /; Secure/); assert.doesNotMatch(redeemed.body, /SYNTHETIC_COOKIE|token/);
    assert.equal((await f.redeem(issued.json.ticket)).status, 403, 'ticket is one-use');
    const input = { action: 'complete', preparationId: issued.json.preparationId, origin, generation, nonce, challenge };
    assert.equal((await f.call(input, origin)).status, 403, 'completion cannot precede recipient verification');
    const proof = { action: 'confirm-receiver', preparationId: issued.json.preparationId, receipt: redeemed.json.receipt, nonce, challenge };
    const confirmed = await f.call(proof); assert.equal(confirmed.json.receiverVerified, true);
    assert.doesNotMatch(confirmed.body, /bpr1_|SYNTHETIC_COOKIE/); assert.equal((await f.call(proof)).status, 403, 'receipt is one-use');
    assert.equal((await f.call(input, primary)).status, 403, 'primary cookie/proof cannot confirm backup origin');
    assert.equal((await f.call(input, origin, {}, { id: deviceId, proven: false })).status, 403);
    const completed = await f.call(input, origin); assert.equal(completed.status, 200);
    const status = await f.call({ action: 'status', preparationId: issued.json.preparationId }); assert.equal(status.json.phase, 'completed');
    assert.doesNotMatch(status.body, /bp1_|bpr1_|token|SYNTHETIC/);
    const cancelled = await f.call({ action: 'revoke', preparationId: issued.json.preparationId }); assert.equal(cancelled.status, 200);
    assert.equal((await f.call({ action: 'status', preparationId: issued.json.preparationId })).status, 403);
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
  for (const change of ['revoked', 'disabled', 'generation', 'boot', 'port', 'key', 'null-token', 'wrong-host', 'wrong-challenge']) {
    const f = fixture(); const issued = await f.call({ action: 'issue', origin, generation, nonce, challenge });
    if (change === 'revoked') f.revoke(); if (change === 'disabled') f.context.enabled = false;
    if (change === 'generation') f.context.backup.generation = 'd'.repeat(32); if (change === 'boot') f.context.bootId = '33333333-3333-3333-3333-333333333333';
    if (change === 'port') f.context.port++; if (change === 'key') f.context.e2eeVersion = 'd'.repeat(64); if (change === 'null-token') f.failReissue();
    const response = await f.redeem(issued.json.ticket, change === 'wrong-host' ? primary : origin, change === 'wrong-challenge' ? { challenge: 'd'.repeat(48) } : {});
    assert.equal(response.status, 403, change); assert.equal(response.headers['set-cookie'], undefined, 'never partial cookie after failure');
    assert.doesNotMatch(response.body, /SYNTHETIC|bp1_|bpr1_/);
  }
  {
    const f = fixture(), res = f.result(), url = new URL(origin + '/__backup/prepare?source=' + encodeURIComponent(primary) + '&nonce=' + nonce);
    f.http.landing({ method: 'GET', headers: { host: new URL(origin).host } }, res, url);
    assert.equal(res.status, 200); assert.equal(res.headers['referrer-policy'], 'no-referrer'); assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(res.headers.location, undefined);
    assert.doesNotMatch(res.body, /SYNTHETIC|bp1_|bpr1_/);
    for (const source of ['https://user:pass@evil.example', 'javascript:alert(1)', 'https://evil.example/path']) {
      url.searchParams.set('source', source); const r = f.result(); f.http.landing({ method: 'GET', headers: { host: new URL(origin).host } }, r, url); assert.equal(r.status, 409);
    }
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
