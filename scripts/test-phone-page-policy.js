'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('./phone-page-policy.js');

(async function () {
  const cases = [
    [{ headers: { host: 'bridge.example.test', 'x-forwarded-proto': 'https' } }, 'wss://bridge.example.test'],
    [{ headers: { host: 'bridge.example.test', 'cf-ray': 'fixture' } }, 'wss://bridge.example.test'],
    [{ headers: { host: '127.0.0.1:19500' } }, 'ws://127.0.0.1:19500'],
    [{ headers: { host: '[::1]:19500' }, socket: { encrypted: true } }, 'wss://[::1]:19500']
  ];
  for (const [req, wanted] of cases) {
    assert.equal(policy.socketSource(req), wanted);
    const h = policy.headersFor(req);
    assert(h['content-security-policy'].includes("connect-src 'self' " + wanted));
    assert(h['content-security-policy'].includes("script-src 'self'"));
    assert(!h['content-security-policy'].includes('unsafe-eval'));
    assert(!h['content-security-policy'].includes("script-src 'self' 'unsafe-inline'"));
    assert.equal(h['referrer-policy'], 'no-referrer');
  }
  for (const host of ['', 'evil.test; script-src *', "evil.test'", 'good.test/evil',
    'user@good.test', 'good.test\r\nX-Test: injected', 'good.test:999999']) {
    assert.equal(policy.socketSource({ headers: { host } }), null);
    assert.equal(policy.headersFor({ headers: { host } })['content-security-policy'],
      policy.headersFor({ headers: {} })['content-security-policy']);
  }
  const html = fs.readFileSync(path.join(__dirname, '../pwa/dsh-lite.html'), 'utf8');
  assert(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html), 'phone page must not require inline scripts');
  const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
  assert(gateway.includes("route.file === 'dsh-lite.html'"));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', ...policy.headersFor(req) });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert(response.headers.get('permissions-policy').includes('microphone=(self)'));
    assert((await response.text()).includes('message-input'));
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('Passed phone-document authority, CSP and actual isolated HTTP header checks.');
})().catch(error => { console.error(error); process.exitCode = 1; });
