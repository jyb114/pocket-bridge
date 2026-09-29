'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'dsh-lite-switch.js'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, 'mobile-proxy.js'), 'utf8');
assert.match(gateway, /'<script src=\\?"\/dsh-lite-switch\.js/);
assert.match(gateway, /'\/dsh-lite-switch\.js': \{ file: 'dsh-lite-switch\.js'/);
assert.match(gateway, /'\/dsh-lite-switch\.js',/);
assert.match(gateway, /const canUseSmallPhoneShell = viaRelay\(req\) && phoneAgent &&\s*\(DSH_LAST_CONFIRMED_PROFILE === 'remote-mux' \|\|\s*DSH_LAST_CONFIRMED_PROFILE === 'legacy-events'\)/,
  'tunnel phone HTML must be served directly before official preloads');
assert.match(gateway, /runtime\.running && \(runtime\.profile === 'remote-mux' \|\| runtime\.profile === 'legacy-events'\)/,
  'route profile must persist across discovery gaps and unrecognized transient probes');
assert.match(gateway, /u\.searchParams\.get\('view'\) !== 'classic'/,
  'explicit classic view must bypass the small page');
assert.match(gateway, /if \(want === 'dsh' && canUseSmallPhoneShell\) \{[\s\S]*?servePwa\(req, res, \{ file: 'dsh-lite\.html'/,
  'normal launcher choice and canonical key link must serve the small page');
assert.match(gateway, /readTargetCookie\(req\) === 'dsh' && canUseSmallPhoneShell/,
  'bookmarked root with an existing DSH target must serve the small page');
function page(href, agent, touchPoints = 0, profile = 'remote-mux', encrypted = true) {
  let button = null, assigned = null, replaced = null;
  const document = {
    getElementById: () => button,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener(_name, fn) { this.click = fn; } }),
    body: { appendChild(value) { button = value; } }
  };
  const location = { href, assign(value) { assigned = value; }, replace(value) { replaced = value; } };
  vm.runInNewContext(source, { document, location,
    navigator: { userAgent: agent, maxTouchPoints: touchPoints },
    window: { __POCKET_BRIDGE_DSH__: { profile },
      DshE2EE: { available: () => encrypted }, __dshE2eeSecret: encrypted ? 'secret' : '' }, URL });
  return { button, get assigned() { return assigned; }, get replaced() { return replaced; } };
}

const original = 'https://example.test/k/ACCESS?target=dsh#k=SECRET';
for (const agent of ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari',
  'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit Mobile Chrome']) {
  const result = page(original, agent);
  assert.equal(result.button, null, 'mobile redirects before official UI loads');
  const target = new URL(result.replaced);
  assert.equal(target.pathname, '/k/ACCESS');
  assert.equal(target.searchParams.get('target'), 'lite');
  assert.equal(target.hash, '#k=SECRET');
}
assert.equal(page(original, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', 5).replaced !== null,
  true, 'iPadOS desktop user agent also enters phone shell');
assert.equal(new URL(page(original, 'Mozilla/5.0 (iPhone) Mobile Safari', 0, 'legacy-events').replaced)
  .searchParams.get('target'), 'lite', 'verified legacy DSH uses the encrypted phone adapter');
assert.equal(page(original, 'Mozilla/5.0 (iPhone) Mobile Safari', 0, 'remote-mux', false).replaced,
  null, 'insecure LAN without WebCrypto stays on the working original frontend');

const classic = page('https://example.test/k/ACCESS?target=dsh&view=classic#k=SECRET',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari');
assert.equal(classic.replaced, null, 'explicit original view remains available');
assert.equal(classic.button.textContent, '手机界面');
classic.button.click();
const back = new URL(classic.assigned);
assert.equal(back.searchParams.get('target'), 'lite');
assert.equal(back.searchParams.has('view'), false);
assert.equal(back.hash, '#k=SECRET');

const desktop = page(original, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome');
assert.equal(desktop.replaced, null, 'desktop DSH keeps original view');
assert.equal(desktop.button.textContent, '手机界面');
console.log('DSH phone route redirects before official plugins and preserves full keys; classic/desktop remain available');
