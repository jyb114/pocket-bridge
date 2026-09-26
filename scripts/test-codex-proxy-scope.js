'use strict';

// Exercise the gateway's real automatic-proxy function in a sandbox. A release
// check must never change the machine's user-wide environment or launch setx.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./page-source.js');

const base = path.resolve(__dirname, '..');
const proxySource = fs.readFileSync(path.join(base, 'scripts', 'mobile-proxy.js'), 'utf8');
const targetSource = fs.readFileSync(path.join(base, 'scripts', 'targets.js'), 'utf8');
const consoleSource = fs.readFileSync(path.join(base, 'pwa', 'console.html'), 'utf8');

const autoFix = extractFunction(proxySource, 'autoFixCodexProxy');
const writes = [];
const context = {
  process: { platform: 'win32' },
  Date,
  log() {},
  codexProxyInfo() { return { system: 'http://127.0.0.1:17777', fixable: true }; },
  require(name) {
    assert.equal(name, 'child_process');
    return { execFileSync(command, args) { writes.push({ command, args }); } };
  }
};
if (autoFix) {
  vm.runInNewContext(`let codexProxyAutoFixedAt = null; ${autoFix}\nautoFixCodexProxy('isolated test');`, context);
}
assert.deepEqual(writes, [], 'gateway startup must not overwrite user-wide proxy variables');
assert.doesNotMatch(proxySource, /autoFixCodexProxy\('网关启动'\)/,
  'gateway startup must not invoke an automatic user-wide proxy writer');
const manualStart = proxySource.indexOf("body.action === 'fix-codex-proxy'");
const manualEnd = proxySource.indexOf("body.action === 'rotate-pair-code'", manualStart);
assert.ok(manualStart >= 0 && manualEnd > manualStart, 'manual proxy action is separately identifiable');
assert.doesNotMatch(proxySource.slice(0, manualStart) + proxySource.slice(manualEnd),
  /execFileSync\('setx'/, 'setx must appear only in the explicit manual action');
const proxyInfo = extractFunction(proxySource, 'codexProxyInfo');
assert.ok(proxyInfo, 'proxy status must remain testable');
const stale = vm.runInNewContext(`${proxyInfo}\ncodexProxyInfo()`, {
  process: { platform: 'win32' },
  systemProxyUrl() { return null; },
  regQuery() { return 'http://127.0.0.1:17777'; }
});
assert.equal(stale.staleUserProxy, true,
  'old user proxy variables must be visible after the system proxy is turned off');

assert.match(targetSource, /env:\s*Object\.assign\(\{\},\s*process\.env,\s*proxy\)/,
  'Pocket Bridge-managed Codex app-server should still receive a process-scoped proxy');
assert.doesNotMatch(consoleSource, /网关自己会做（启动时检查一次，之后每 10 分钟复查）/,
  'desktop console must not promise automatic user-wide proxy changes');
assert.match(consoleSource, /if\s*\(!confirm\(t\('要覆盖 Windows 当前用户的代理环境变量/,
  'manual action must warn before changing proxy settings for other applications');
assert.match(proxySource, /body\.action === 'fix-codex-proxy'[\s\S]{0,450}body\.confirm !== true/,
  'manual action must require explicit confirmation at the gateway');
console.log('Proxy scope: no automatic global writes; managed process proxy retained; UI truthful.');
