// Isolated regression for public tunnel request classification. Never starts
// a real tunnel or gateway and never reads runtime secrets.
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const os = require('os');
const tunnel = require('./tunnel.js');
const origin = require('./request-origin.js');

const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const request = (host, remoteAddress = '127.0.0.1', extra = {}) => ({
  socket: { remoteAddress },
  headers: { host, ...extra }
});

(async () => {
  const providers = tunnel.listProviders().map((p) => p.id);
  assert.deepEqual(providers, ['cloudflare-named', 'cloudflare-quick']);
  assert.deepEqual(tunnel.candidatesForMode('dynamic').map((p) => p.id), ['cloudflare-quick']);
  assert.deepEqual(tunnel.candidatesForMode('fixed').map((p) => p.id), ['cloudflare-named']);
  assert.equal(tunnel.extractPublicUrl('url=https://test.ngrok-free.app'), null);
  assert.equal(tunnel.extractPublicUrl('url=https://test.ngrok.io'), null);
  assert.equal(tunnel.extractPublicUrl('url=https://test.ts.net'), null);
  assert.equal(tunnel.extractPublicUrl('url=https://test.trycloudflare.com'),
    'https://test.trycloudflare.com');

  // Old configurations may still explicitly ask for ngrok. It must not be
  // launched or silently replaced with a different public tunnel.
  const disabled = await tunnel.startTunnel(1, 'ngrok');
  assert.equal(disabled.provider, null);
  assert.equal(disabled.url, null);
  assert.deepEqual(disabled.attempts.map((a) => a.provider), ['ngrok']);
  assert.equal(disabled.attempts[0].ok, false);

  const ngrok = request('demo.ngrok-free.app:443');
  assert.equal(origin.viaRelay(ngrok), true);
  assert.equal(origin.isLoopback(ngrok), false);
  for (const host of ['demo.ngrok.io', 'demo.trycloudflare.com', 'bridge.example.org', '']) {
    const forwarded = request(host);
    assert.equal(origin.viaRelay(forwarded), true, `public/unknown Host ${host}`);
    assert.equal(origin.isLoopback(forwarded), false, `admin denied for ${host}`);
  }
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(origin.isLoopback(request('localhost:8080', remote)), true);
  }
  assert.equal(origin.viaRelay(request('127.0.0.1:8080', '127.0.0.1',
    { 'cf-ray': 'relay' })), true);
  assert.equal(origin.viaRelay(request('127.0.0.1:8080', '127.0.0.1',
    { 'x-forwarded-host': 'demo.ngrok-free.app' })), true);
  assert.equal(origin.isLoopback(request('localhost:8080', '203.0.113.9')), false);

  const lan = Object.values(os.networkInterfaces()).flat().find((x) =>
    x && x.family === 'IPv4' && !x.internal);
  if (lan) assert.equal(origin.viaRelay(request(`${lan.address}:8080`, lan.address)), false);

  // The pure boundary above must be the one used by the real admin and E2EE
  // gates; a future inline Cloudflare-only shortcut would reopen the hole.
  assert.match(gateway, /function isLoopback\(req\)\s*\{[\s\S]*?return requestOrigin\.isLoopback\(req\);/);
  assert.match(gateway, /function isSelfCheck\(req\)\s*\{\s*return req\.headers\['x-dsh-selfcheck'\] === '1' && isLocalRequest\(req\);/);
  assert.match(gateway, /function viaRelay\(req\)\s*\{\s*return requestOrigin\.viaRelay\(req\);/);
  assert.match(gateway, /u\.pathname === '\/__console\/status'[\s\S]{0,120}!isLoopback\(req\)/);
  assert.match(gateway, /E2EE_CONTENT_PATHS\.has\(u\.pathname\)[\s\S]{0,130}viaRelay\(req\)/);
  assert.match(gateway, /wsGateSecret && viaRelay\(req\)/);

  console.log('Tunnel security: ngrok disabled; nonlocal Host denies admin and requires relay E2EE.');
})().catch((err) => { console.error(err); process.exitCode = 1; });
