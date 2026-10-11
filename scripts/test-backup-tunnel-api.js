'use strict';
// Execute only the setting/address handlers with synthetic dependencies. Never
// load the running gateway, save a real config or launch the repair helper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./page-source');
const source = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
const code = extractFunction(source, 'setBackupTunnel');
function fixture(options = {}) {
  const saved = [], requests = [];
  const config = { tunnelProvider: 'cloudflare', tunnelDomainMode: 'dynamic', enableLanAccess: true, tunnelBackup: { enabled: false, reserved: 'keep' } };
  const context = { URL, isLoopback: () => options.local !== false,
    cfg: { loadConfig: () => structuredClone(config), saveConfig(value) { if (options.fail) throw Error('fixture-save-failure'); saved.push(value); } },
    tunnelState: { backupPolicy: () => ({ supported: options.supported !== false }) },
    tunnelWatchdog: { request: value => { requests.push(value); return true; } } };
  vm.createContext(context); vm.runInContext(code, context);
  const req = { method: 'POST', socket: {}, headers: { 'content-type': 'application/json; charset=utf-8', host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' } };
  return { req, saved, requests, run: body => context.setBackupTunnel(req, body) };
}
for (const enabled of [true, false]) {
  const f = fixture(); const result = f.run({ enabled }); assert.equal(result.ok, true);
  assert.equal(f.saved.length, 1); assert.equal(f.saved[0].tunnelBackup.enabled, enabled); assert.equal(f.saved[0].tunnelBackup.reserved, 'keep');
  assert.equal(f.saved[0].enableLanAccess, true); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].retireBackup, !enabled);
  assert.doesNotMatch(result.message, /is ready|prepared|signed in/i);
}
for (const body of [{}, null, { enabled: 'true' }, { enabled: 1 }]) {
  const f = fixture(); assert.equal(f.run(body).ok, false); assert.equal(f.saved.length, 0); assert.equal(f.requests.length, 0);
}
for (const options of [{ local: false }, { supported: false }, { fail: true }]) {
  const f = fixture(options); assert.equal(f.run({ enabled: true }).ok, false); assert.equal(f.saved.length, 0); assert.equal(f.requests.length, 0);
}
{
  const f = fixture({ supported: false }); assert.equal(f.run({ enabled: false }).ok, true, 'disabling is allowed even if the selected provider/platform is unsupported');
}
for (const patch of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'https://127.0.0.1:8080' }, { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }, { 'sec-fetch-site': 'cross-site' }]) {
  const f = fixture(); Object.assign(f.req.headers, patch); assert.equal(f.run({ enabled: true }).ok, false); assert.equal(f.saved.length, 0);
}
{
  const f = fixture(); f.req.method = 'GET'; assert.equal(f.run({ enabled: true }).ok, false);
}
const consoleHandler = extractFunction(source, 'handleConsole');
assert.ok(consoleHandler.includes("result = setBackupTunnel(req, body)"));
assert.match(consoleHandler, /u\.pathname === '\/__console\/action' && req\.method === 'POST'/);
assert.match(source, /const tunnels = tunnelState\.publicTunnelState\(tunnelState\.readTunnelState\(LOG_DIR\)/);
assert.match(source, /'x-pocket-bridge-boot': GATEWAY_BOOT_ID/);
assert.match(source, /if \(tunnelWatchdog\) tunnelWatchdog\.stop\(\)/);
assert.match(source, /tunnelWatchdog\.start\(\)/);
assert.match(source, /managed: tunnelState\.readTunnelState\(LOG_DIR\) !== null/);
const addresses = extractFunction(source, 'serveDshLiteAddresses');
assert.match(addresses, /tunnels: data && data\.tunnels \|\| null/);
assert.match(addresses, /encrypted-request-required/);
console.log('Backup console API: desktop/JSON/origin/boolean gates, default-off explicit writes, supported policy, disable path, hook and safe DTO boundary checks passed.');
