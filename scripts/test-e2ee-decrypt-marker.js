'use strict';

// A keyed caller may consume file bytes only after the browser has verified
// and decrypted the E2EE response. The marker must never appear on an
// unencrypted or undecryptable response.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const e2ee = require('./e2ee.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'e2ee.js'), 'utf8');
const secret = 'test-browser-decrypt-marker-secret-123';
const sentinel = Buffer.from('private Codex file contents');

function browser(response) {
  const window = { crypto: crypto.webcrypto, fetch: async () => response,
    location: { hash: '', href: 'https://phone.example/codex', origin: 'https://phone.example' } };
  vm.runInNewContext(source, { window, TextEncoder, TextDecoder, Response, Headers, Blob, URL,
    Uint8Array, ArrayBuffer, Map, Date, atob, btoa });
  assert.equal(window.DshE2EE.installFetchDecrypt(secret), true);
  return window;
}

(async () => {
  const keys = e2ee.deriveKeys(secret, e2ee.slotAt());
  const cipher = e2ee.encrypt(keys.b, sentinel);
  const sealed = new Response(cipher, { status: 200,
    headers: { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/octet-stream' } });
  const verified = await browser(sealed).fetch('/codex/file', { method: 'POST' });
  assert.equal(verified.headers.get('x-dsh-e2ee-decrypted'), '1');
  assert.equal(verified.headers.get('x-dsh-e2ee'), null);
  assert.deepEqual(Buffer.from(await verified.arrayBuffer()), sentinel);

  const accidentalPlaintext = new Response(sentinel, { status: 200,
    headers: { 'content-type': 'application/octet-stream' } });
  const unverified = await browser(accidentalPlaintext).fetch('/codex/file', { method: 'POST' });
  assert.equal(unverified.headers.get('x-dsh-e2ee-decrypted'), null);

  const forgedPlaintext = new Response(sentinel, { status: 503, statusText: 'Unavailable',
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
      'x-fixture-header': 'preserved', 'x-dsh-e2ee-decrypted': '1' } });
  const rejectedMarker = await browser(forgedPlaintext).fetch('/dot/desktop', { method: 'POST' });
  assert.equal(rejectedMarker.headers.get('x-dsh-e2ee-decrypted'), null);
  assert.equal(rejectedMarker.status, 503); assert.equal(rejectedMarker.statusText, 'Unavailable');
  assert.equal(rejectedMarker.headers.get('content-type'), 'application/octet-stream');
  assert.equal(rejectedMarker.headers.get('cache-control'), 'no-store');
  assert.equal(rejectedMarker.headers.get('x-fixture-header'), 'preserved');
  assert.deepEqual(Buffer.from(await rejectedMarker.arrayBuffer()), sentinel);

  const broken = new Response(Buffer.from('broken cipher'), { status: 200,
    headers: { 'x-dsh-e2ee': '1', 'x-dsh-e2ee-type': 'application/octet-stream', 'x-dsh-e2ee-decrypted': '1' } });
  const undecipherable = await browser(broken).fetch('/codex/file', { method: 'POST' });
  assert.equal(undecipherable.headers.get('x-dsh-e2ee-decrypted'), null);
  assert.equal(undecipherable.headers.get('x-dsh-e2ee'), '1');
  console.log('PASS decrypted marker appears only after authenticated E2EE response decryption');
})().catch(error => { console.error(error); process.exitCode = 1; });
