'use strict';
// Reuse only the existing isolated console DOM factory, without executing its
// optional live check. The real renderEntries and dictionary are evaluated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction, extractRegisterArg } = require('./page-source');
const BASE = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(BASE, 'pwa/console.html'), 'utf8');
const fixtureSource = fs.readFileSync(path.join(__dirname, 'test-console-help.js'), 'utf8');
const dict = vm.runInNewContext('(' + extractRegisterArg(html) + ')');
const functions = ['fakeEl', 'runRenderEntries'].map(name => extractFunction(fixtureSource, name)).join('\n');
const fixture = new Function('html', 'dict', 'vm', 'fs', 'path', 'BASE', 'extractFunction', functions + '\nreturn runRenderEntries;')(
  html, dict, vm, fs, path, BASE, extractFunction);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function allText(node) { return node.textContent + (node._innerHTML || '') + node.children.map(allText).join(' '); }
function buttons(node) { return node.children.flatMap(child => child.tagName === 'BUTTON' ? [child] : buttons(child)); }
function state(patch = {}, slot = {}) {
  return { enabled: true, supported: true, requested: true, ...patch, backup: {
    phase: 'ready', reachable: true, generation: 'a'.repeat(32), checkedAt: Date.now(),
    origin: 'https://fixture-backup.trycloudflare.com', url: 'https://fixture-backup.trycloudflare.com/dsh-lite', ...slot } };
}
(async () => {
  for (const lang of ['zh', 'en', 'es']) {
    for (const patch of [{ enabled: false, requested: false }, { enabled: false, requested: true, supported: false, code: 'public-tunnels-disabled' },
      { enabled: false, requested: true, supported: false, code: 'dual-tunnel-platform-unsupported' }, { enabled: false, requested: true, supported: false, code: 'quick-tunnels-required' }]) {
      const f = fixture([], { lang, data: { tunnels: state(patch) } });
      const card = f.find('backup-tunnel-card'), [toggle, copy] = buttons(card);
      assert.equal(toggle.getAttribute('aria-checked'), String(patch.requested));
      assert.equal(toggle.disabled, false, 'supported off or unsupported saved-on may be changed intentionally');
      assert.equal(copy.disabled, true);
      if (lang !== 'zh') assert.doesNotMatch(allText(card), /[\u4e00-\u9fff]/);
      const changes = []; f.sandbox.action = async (...args) => { changes.push(args); }; f.sandbox.confirm = () => false;
      toggle.onclick(); await flush(); assert.equal(changes.length, 0, 'confirmation cancellation is a no-op');
      f.sandbox.confirm = () => true; toggle.onclick(); toggle.onclick(); await flush();
      assert.equal(changes.length, 1, 'double-click submits one explicit change');
      assert.equal(changes[0][0], 'set-backup-tunnel'); assert.equal(changes[0][2].enabled, !patch.requested);
    }
    {
      const f = fixture([], { lang, data: { tunnels: state({ enabled: false, requested: false, supported: false }) } });
      const [toggle, copy] = buttons(f.find('backup-tunnel-card')); assert.equal(toggle.disabled, true); assert.equal(copy.disabled, true);
    }
  }
  {
    const f = fixture([], { data: { tunnels: state() } });
    const [, copy] = buttons(f.find('backup-tunnel-card')); assert.equal(copy.disabled, false); copy.onclick();
    assert.equal(f.copied[0][0], 'https://fixture-backup.trycloudflare.com/dsh-lite');
    f.sandbox.state.data.tunnels.backup.checkedAt = Date.now() - 180001; copy.onclick(); assert.equal(f.copied.length, 1, 'stale old callback cannot copy');
  }
  for (const slot of [{ reachable: false }, { phase: 'rebuilding' }, { checkedAt: Date.now() - 180001 }, { url: 'https://fixture-backup.trycloudflare.com/k/SECRET#k=SECRET' },
    { url: 'https://user:pass@fixture-backup.trycloudflare.com/dsh-lite' }, { url: 'https://fixture-backup.trycloudflare.com/dsh-lite?token=SECRET' }]) {
    const f = fixture([], { data: { tunnels: state({}, slot) } }); const card = f.find('backup-tunnel-card');
    assert.equal(buttons(card)[1].disabled, true); assert.doesNotMatch(allText(card), /SECRET|user:pass/);
  }
  for (const replacement of [state({ enabled: false, requested: false }), state({}, { generation: 'b'.repeat(32), url: 'https://other-backup.trycloudflare.com/dsh-lite', origin: 'https://other-backup.trycloudflare.com' }),
    state({ enabled: false, supported: false, requested: true, code: 'public-tunnels-disabled' })]) {
    const f = fixture([], { data: { tunnels: state() } }); const [toggle, copy] = buttons(f.find('backup-tunnel-card'));
    const changes = []; f.sandbox.action = async (...args) => { changes.push(args); }; f.sandbox.confirm = () => true;
    f.sandbox.state.data = { tunnels: replacement };
    copy.onclick(); toggle.onclick(); await flush(); assert.equal(f.copied.length, 0); assert.equal(changes.length, 0, 'detached stale controls cannot act on new state');
  }
  {
    const f = fixture([], { data: { tunnels: state() } }); const [toggle, copy] = buttons(f.find('backup-tunnel-card'));
    const changes = []; f.sandbox.action = async (...args) => { changes.push(args); }; f.sandbox.confirm = () => true;
    f.sandbox.state.data.tunnels.backup.generation = 'b'.repeat(32); copy.onclick(); toggle.onclick(); await flush();
    assert.equal(f.copied.length, 0); assert.equal(changes.length, 0, 'in-place generation mutation also rejects old callbacks');
  }
  for (const lang of ['zh', 'en', 'es']) {
    const f = fixture([], { lang, data: { tunnels: state({ code: 'tunnel-migration-unconfirmed' }, { phase: 'blocked', url: null }) } });
    const card = f.find('backup-tunnel-card'); assert.equal(buttons(card)[1].disabled, true);
    assert.match(allText(card), lang === 'zh' ? /停止桥接/ : lang === 'en' ? /Stop bridge/ : /Detener puente/);
  }
  for (const lang of ['zh', 'en', 'es']) {
    const primary = { phase: 'ready', reachable: true, generation: 'c'.repeat(32), checkedAt: Date.now(),
      origin: 'https://fixture-primary.trycloudflare.com', url: 'https://fixture-primary.trycloudflare.com/dsh-lite' };
    const f = fixture([], { lang, entries: { publicTunnelManaged: true, publicTunnelVerified: true,
      wan: primary.origin + '/k/fixture-access#k=fixture-encryption-key-123456' }, data: { tunnels: state({ managed: true, primary }) } });
    const wan = f.box.children.find(card => card.className.includes('wan-card'));
    assert.equal(buttons(wan)[0].disabled, false);
    const note = wan.children.find(child => child.className === 'tunnel-notice').textContent;
    assert.match(note, lang === 'zh' ? /不会推送/ : lang === 'en' ? /does not send/ : /no envía/);
    if (lang !== 'zh') assert.doesNotMatch(note, /[\u4e00-\u9fff]/);
    vm.runInContext(extractFunction(html, 'renderNotify'), f.sandbox); f.sandbox.renderNotify({ webPushDevices: 1 });
    assert.equal(f.node('notify-hint').textContent, note, 'notification page makes no automatic managed-recovery promise');
    const staleCopy = buttons(wan)[0]; primary.checkedAt = Date.now() - 180001; staleCopy.onclick();
    assert.equal(f.copied.length, 0, 'managed primary copy rechecks freshness at click time');
    f.sandbox.renderEntries(f.entries); const unavailable = f.box.children.find(card => card.className.includes('wan-card'));
    assert.equal(buttons(unavailable)[0].disabled, true); assert.equal(buttons(unavailable)[1].disabled, true);
    assert.doesNotMatch(unavailable._innerHTML, /access-state good/, 'expired managed primary cannot keep its available label');
  }
  {
    const primary = { phase: 'ready', reachable: true, generation: 'c'.repeat(32), checkedAt: Date.now(),
      origin: 'https://fixture-primary.trycloudflare.com', url: 'https://fixture-primary.trycloudflare.com/dsh-lite' };
    const f = fixture([], { entries: { publicTunnelManaged: true, publicTunnelVerified: true,
      wan: primary.origin + '/k/fixture-access#k=fixture-encryption-key-123456' }, data: { tunnels: state({ managed: true, primary }) } });
    const oldButtons = buttons(f.box.children.find(card => card.className.includes('wan-card')));
    f.sandbox.state.data.tunnels = state({ managed: true, primary: { ...primary, generation: 'd'.repeat(32) } });
    oldButtons[0].onclick(); oldButtons[1].onclick(); assert.equal(f.copied.length, 0); assert.equal(f.opened.length, 0);
  }
  for (const change of ['expired-status-failure', 'new-data', 'new-tunnels']) {
    const primary = { phase: 'ready', reachable: true, generation: 'c'.repeat(32), checkedAt: Date.now(),
      origin: 'https://fixture-primary.trycloudflare.com', url: 'https://fixture-primary.trycloudflare.com/dsh-lite' };
    const targets = [{ id: 'dsh', installed: true, running: true }];
    const f = fixture(targets, { entries: { publicTunnelManaged: true, publicTunnelVerified: true,
      wan: primary.origin + '/k/fixture-access#k=fixture-encryption-key-123456' }, data: { tunnels: state({ managed: true, primary }) } });
    f.sandbox.render({ ...f.sandbox.state.data, gateway: { running: true }, targets, entries: f.entries, devices: [] });
    const shortcuts = f.node('heroActs').children.filter(button => /复制/.test(button.textContent));
    assert.equal(shortcuts.length, 2, 'both top-level primary shortcuts exist while verified');
    if (change === 'expired-status-failure') {
      primary.checkedAt = Date.now() - 180001;
      f.sandbox.fetch = async () => { throw Error('Synthetic status failure'); };
      vm.runInContext(extractFunction(html, 'load'), f.sandbox); await f.sandbox.load();
      assert.equal(shortcuts.every(button => button.disabled === true), true, 'failed status load disables both expired primary shortcuts');
    } else if (change === 'new-data') {
      f.sandbox.state.data = { ...f.sandbox.state.data, tunnels: state({ managed: true, primary: { ...primary, generation: 'd'.repeat(32) } }) };
    } else f.sandbox.state.data.tunnels = state({ managed: true, primary: { ...primary, generation: 'd'.repeat(32) } });
    shortcuts.forEach(button => button.onclick()); assert.equal(f.copied.length, 0, change + ' blocks both stale top-level callbacks');
  }
  {
    const primary = { phase: 'ready', reachable: true, generation: 'c'.repeat(32), checkedAt: Date.now(),
      origin: 'https://fixture-primary.trycloudflare.com', url: 'https://fixture-primary.trycloudflare.com/dsh-lite' };
    const targets = [{ id: 'dsh', installed: true, running: true }];
    const f = fixture(targets, { entries: { publicTunnelManaged: true, publicTunnelVerified: true,
      wan: 'https://different-primary.trycloudflare.com/k/fixture-access#k=fixture-encryption-key-123456' },
      data: { tunnels: state({ managed: true, primary }) } });
    f.sandbox.render({ ...f.sandbox.state.data, gateway: { running: true }, targets, entries: f.entries, devices: [] });
    assert.equal(f.node('heroActs').children.some(button => /复制/.test(button.textContent)), false,
      'hero target origin must match the verified primary projection');
    const wan = f.box.children.find(card => card.className.includes('wan-card'));
    assert.equal(buttons(wan)[0].disabled, true, 'mismatched primary origin cannot be copied from the WAN card');
  }
  console.log('Backup desktop UI: default-off, dormant unsupported/none opt-in can be disabled, explicit confirmation, double-click guard, safe/stale copy and ZH/EN/ES passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
