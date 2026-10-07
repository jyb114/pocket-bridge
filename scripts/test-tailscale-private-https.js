'use strict';

const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const originPolicy = require('./request-origin.js');
const privateHttps = require('./tailscale-private-https.js');

let checks = 0;
function check(name, callback) { callback(); checks++; console.log('PASS ' + name); }
const options = { enabled: true, origin: 'https://bridge.test-tailnet.ts.net:8443', gatewayPort: 8081 };
const hostname = 'bridge.test-tailnet.ts.net';
const hp = hostname + ':8443';
const status = { BackendState: 'Running', Self: { Online: true, DNSName: hostname + '.' }, CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: [hostname], Peer: { privatePeer: { PublicKey: 'DO-NOT-PROJECT-KEY' } }, User: { privateUser: { LoginName: 'DO-NOT-PROJECT-ACCOUNT' } }, AuthURL: 'DO-NOT-PROJECT-AUTH-URL' };
const serve = { TCP: { 8443: { HTTPS: true } }, Web: { [hp]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8081' } } } } };
const copy = value => JSON.parse(JSON.stringify(value));
function fakeDependencies(replies, calls) {
  return { findInstalledCli: () => 'C:\\Program Files\\Tailscale\\tailscale.exe', runReadOnly: async (file, args) => { calls.push(args); const value = replies.shift(); if (value instanceof Error) throw value; return value; } };
}
async function sample(overrides, serveOverrides, version = '1.102.4\n') {
  const s = Object.assign(copy(status), overrides);
  const calls = [];
  const result = await privateHttps.readStatus(options, fakeDependencies([version, JSON.stringify(s), JSON.stringify(serveOverrides || serve)], calls));
  return { result, calls };
}

async function main() {
  const untouched = () => { throw new Error('Disabled inspector performed discovery'); };
  const disabled = await privateHttps.readStatus({}, { findInstalledCli: untouched, runReadOnly: untouched });
  check('disabled mode performs no discovery or command', () => assert.equal(disabled.code, 'disabled'));
  check('disabled mode has no authority or phone claim', () => {
    assert.equal(disabled.configurationReady, false); assert.equal(disabled.gatewayAdmissionImplemented, false);
    assert.equal(disabled.phoneVerified, false); assert.equal(disabled.mutationPerformed, false);
  });
  const badOptions = await privateHttps.readStatus({ ...options, origin: 'https://outside.example' }, { findInstalledCli: untouched });
  check('invalid origin refuses before executable discovery', () => assert.equal(badOptions.code, 'invalid-options'));
  const absent = await privateHttps.readStatus(options, { findInstalledCli: () => null, runReadOnly: untouched });
  check('missing installation stays not installed and not connected', () => { assert.equal(absent.code, 'not-installed'); assert.equal(absent.installed, false); assert.equal(absent.connected, false); });
  const actual = await privateHttps.readStatus();
  check('real default invocation is also inert', () => assert.deepEqual(actual, disabled));

  for (const value of ['http://' + hostname, 'https://' + hostname + '/', 'https://' + hostname + '/k/secret', 'https://' + hostname + '?k=secret', 'https://' + hostname + '#k=secret', 'https://user@' + hostname, 'https://' + hostname + ':0', 'https://' + hostname + ':65536', 'https://' + hostname + ':08443', ' https://' + hostname, 'https://Bridge.test-tailnet.ts.net', 'https://bridge.test-tailnet.ts.net.', 'https://bridge.ts.net', 'https://bridge.test-tailnet.ts.net.evil.example', 'https://bridge.xn--test.ts.net', 'https://bridge.%74est.ts.net', 'https://127.0.0.1', 'https://[::1]', 'https://bridge.test-tailnet.ts.net\\@evil.example']) {
    check('reject nonexact origin ' + checks, () => assert.equal(privateHttps.normalizePrivateOrigin(value), null));
  }
  check('canonical origin and explicit default HTTPS port normalize identically', () => assert.deepEqual(privateHttps.normalizePrivateOrigin('https://' + hostname + ':443'), privateHttps.normalizePrivateOrigin('https://' + hostname)));
  for (const port of ['8081', 0, 65536, 8081.5, NaN]) check('refuse noninteger gateway port ' + checks, () => assert.equal(privateHttps.gatewayPortOf(port), null));

  const positive = await sample();
  check('connected exact private Serve status is advisory configured', () => { assert.equal(positive.result.code, 'configured'); assert.equal(positive.result.configurationReady, true); assert.equal(positive.result.phoneVerified, false); assert.equal(positive.result.gatewayAdmissionImplemented, false); });
  check('only fixed readonly argv ran, without login/serve mutation', () => assert.deepEqual(positive.calls, privateHttps.READ_COMMANDS));
  check('raw identity, peers, keys and auth URLs never leave inspector', () => { const output = JSON.stringify(positive.result); assert.ok(!output.includes('DO-NOT-PROJECT')); assert.ok(!output.includes('AuthURL')); assert.ok(!output.includes('Peer')); });
  for (const state of ['NeedsLogin', 'NeedsMachineAuth', 'Stopped', 'Starting', 'NoState', 'Unknown']) {
    const probe = await sample({ BackendState: state });
    check('explicit backend state refuses ' + state, () => { assert.equal(probe.result.configurationReady, false); assert.equal(probe.calls.length, 2); });
  }
  for (const self of [{ ...status.Self, Online: false }, { ...status.Self, Expired: true }, null]) {
    const probe = await sample({ Self: self });
    check('offline or expired self refuses ' + checks, () => assert.equal(probe.result.code, 'not-connected'));
  }
  const wrongSelf = await sample({ Self: { Online: true, DNSName: 'other.test-tailnet.ts.net.' } });
  check('peer name or arbitrary origin cannot replace exact Self DNS', () => assert.equal(wrongSelf.result.code, 'origin-mismatch'));
  for (const overrides of [{ CurrentTailnet: null }, { CurrentTailnet: { MagicDNSEnabled: false } }, { CertDomains: [] }]) {
    const probe = await sample(overrides);
    check('missing HTTPS prerequisite refuses ' + checks, () => assert.equal(probe.result.code, 'https-not-enabled'));
  }
  for (const version of ['1.50.1\n', '2.0.1\n', 'not a version\nDO-NOT-PROJECT']) {
    const probe = await sample({}, serve, version);
    check('unsupported client version refuses before status ' + checks, () => { assert.equal(probe.calls.length, 1); assert.equal(probe.result.configurationReady, false); });
  }
  const errorCalls = [];
  const failure = await privateHttps.readStatus(options, fakeDependencies(['1.102.4\n', new Error('SECRET-STDERR-AUTH-URL')], errorCalls));
  check('daemon failure is bounded fixed projection with no stderr', () => { assert.equal(failure.code, 'daemon-unavailable'); assert.ok(!JSON.stringify(failure).includes('SECRET')); });
  for (const body of ['{', '[]', '"private"', '{}'.padEnd(privateHttps.LIMITS.outputBytes + 1, ' ')]) {
    const result = await privateHttps.readStatus(options, fakeDependencies(['1.102.4\n', body], []));
    check('malformed or oversized status refuses ' + checks, () => assert.equal(result.code === 'daemon-unavailable' || result.code === 'not-connected', true));
  }
  const inspect = candidate => privateHttps.inspectServeConfig(candidate, options);
  check('empty Serve stays not configured', () => assert.equal(inspect({}).code, 'serve-not-configured'));
  check('foreground private Serve is supported without modification', () => assert.equal(inspect({ Foreground: { ownedSession: serve } }).configurationReady, true));
  check('optional trailing slash at exact loopback root is equivalent', () => { const s = copy(serve); s.Web[hp].Handlers['/'].Proxy += '/'; assert.equal(inspect(s).configurationReady, true); });
  const mutations = [
    s => { s.AllowFunnel = { [hp]: true }; },
    s => { s.Foreground = { other: { AllowFunnel: { 'other.test-tailnet.ts.net:443': true } } }; },
    s => { s.AllowFunnel = { [hp]: 'false' }; },
    s => { s.TCP[8443].HTTPS = false; s.TCP[8443].HTTP = true; },
    s => { s.TCP[8443].HTTP = 'false'; },
    s => { s.TCP[8443].TCPForward = '127.0.0.1:8081'; },
    s => { delete s.TCP; },
    s => { s.Web[hp].Handlers['/'].Proxy = 'http://127.0.0.1:8080'; },
    s => { s.Web[hp].Handlers['/'].Proxy = 'http://localhost:8081'; },
    s => { s.Web[hp].Handlers['/'].Proxy = 'http://127.0.0.1:8081/private'; },
    s => { s.Web[hp].Handlers['/'].Proxy = 'http://user@127.0.0.1:8081'; },
    s => { s.Web[hp].Handlers['/'].Proxy = 'http://127.0.0.1:8081?key=secret'; },
    s => { s.Web[hp].Handlers['/'].Path = 'D:\\private'; },
    s => { s.Web[hp].Handlers['/'].Redirect = 'https://elsewhere.example'; },
    s => { s.Web[hp].Handlers['/'].Text = false; },
    s => { s.Web[hp].Handlers['/'].AcceptAppCaps = ['identity-does-not-authorize']; },
    s => { s.Web[hp].Handlers['/elsewhere'] = { Proxy: 'http://127.0.0.1:8081' }; },
    s => { s.Web['other.test-tailnet.ts.net:443'] = copy(s.Web[hp]); },
    s => { s.Foreground = { duplicate: copy(serve) }; },
    s => { s.Foreground = { nested: { Foreground: { deeper: copy(serve) } } }; },
    s => { s.Services = { 'svc:hosted': copy(serve) }; },
    s => { s.FutureExposurePolicy = { public: true }; },
    s => { s.TCP[8443].FuturePublicPolicy = true; },
    s => { s.Web[hp].Handlers['/'].FutureAuthentication = 'none'; }
  ];
  for (const mutate of mutations) {
    const candidate = copy(serve); mutate(candidate); const before = JSON.stringify(candidate);
    check('reject exposure/schema/conflict mutation ' + checks, () => { assert.equal(inspect(candidate).configurationReady, false); assert.equal(JSON.stringify(candidate), before); });
  }
  check('false Funnel flag is not mistaken for enabled Funnel', () => { const s = copy(serve); s.AllowFunnel = { [hp]: false }; assert.equal(inspect(s).configurationReady, true); });

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ localHost: originPolicy.isLocalHost(req), viaRelay: originPolicy.viaRelay(req), local: originPolicy.isLoopback(req) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    async function request(headers) {
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/', headers }, res => { let text = ''; res.on('data', b => { text += b; }); res.on('end', () => resolve(JSON.parse(text))); });
        req.on('error', reject); req.end();
      });
    }
    const direct = await request({ host: '127.0.0.1' });
    check('owned real socket keeps direct local management local', () => assert.equal(direct.local, true));
    for (const headers of [
      { host: hp },
      { host: hp, 'x-forwarded-host': hp, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.2' },
      { host: '127.0.0.1', 'x-forwarded-host': hp, 'x-forwarded-for': '100.64.0.2' },
      { host: hp, 'tailscale-user-login': 'not-an-application-device', 'tailscale-user-name': 'not-local-auth' },
      { host: hp, 'tailscale-funnel-request': '?1' }
    ]) {
      const response = await request(headers);
      check('real loopback Tailscale-shaped authority stays remote ' + checks, () => { assert.equal(response.local, false); assert.equal(response.viaRelay, true); });
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  const source = fs.readFileSync(path.join(__dirname, 'tailscale-private-https.js'), 'utf8');
  check('module contains no installer, service start, settings write or mutation API', () => {
    assert.ok(!/writeFile|spawn\(|(?<!\.)\bexec\(|createServer|listen\(|msiexec|Start-Service|\['(?:up|login|funnel|cert|reset)'/.test(source));
    assert.deepEqual(Object.keys(privateHttps).sort(), ['LIMITS', 'READ_COMMANDS', 'gatewayPortOf', 'inspectServeConfig', 'normalizePrivateOrigin', 'readStatus'].sort());
  });
  console.log('Tailscale private HTTPS: ' + checks + ' isolated checks passed; no client or phone connection claimed.');
}

main().catch(error => { console.error('FAIL ' + error.message); process.exitCode = 1; });
