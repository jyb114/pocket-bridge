'use strict';

// Production createBackupRecovery, synthetic DOM/clock/decrypted metadata.
// No browser, real credentials, DSH, tunnel, network or notifications are used.
// Reuse the established fixture without executing its older regression body.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const fixtureFile = path.join(__dirname, 'test-dsh-lite-backup.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const boundary = fixtureSource.indexOf('\n(async () => {');
assert(boundary > 0);
const fixtureModule = new Module(fixtureFile, module);
fixtureModule.filename = fixtureFile; fixtureModule.paths = module.paths;
fixtureModule._compile(fixtureSource.slice(0, boundary) + '\nmodule.exports = { fixture, healthy, flush, primarySlot, origin, primaryOrigin };', fixtureFile);
const { fixture, healthy, flush, primarySlot, origin, primaryOrigin } = fixtureModule.exports;
const B = 'https://replacement-backup.trycloudflare.com', C = 'https://newest-backup.trycloudflare.com';
const generation = value => value.repeat(32);
function data(f, target = origin, gen = 'a', extra = {}) {
  return healthy({ origin: target, url: target + '/dsh-lite', generation: generation(gen), checkedAt: f.now },
    { primary: { ...primarySlot, checkedAt: f.now }, ...extra });
}
async function start(options) { const f = fixture(options); f.control.update(); await flush(); return f; }
function close(f) { f.ids.get('dsh-lite-backup-dialog').__liteClose(); }
async function poll(f, value, ms = 20000) { f.tick(ms); f.setData(value || data(f)); f.control.update(); await flush(); }
function address(f) { return f.ids.get('dsh-lite-backup-address').value; }
let checks = 0;
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
(async () => {
  await check('closed main page notices B then C once each; unchanged health and reconnect never re-prompt', async () => {
    const f = await start(); close(f);
    await poll(f, data(f, B, 'b')); assert.equal(f.overlays, 2); assert.equal(address(f), B + '/dsh-lite'); close(f);
    await poll(f, data(f, B, 'b')); assert.equal(f.overlays, 2);
    f.setReady(false); f.control.update(); f.setReady(true); f.nextConnection(); f.control.update(); await flush();
    assert.equal(f.overlays, 2);
    await poll(f, data(f, C, 'd')); assert.equal(f.overlays, 3); assert.equal(address(f), C + '/dsh-lite');
    assert.equal(f.preparations, 0); assert.equal(f.opened.length, 0); assert.equal(f.copies.length, 0);
    assert.doesNotMatch(JSON.stringify([...f.storage.values()]), /SECRET|#|\/k\//);
  });
  for (const kind of ['same URL new generation', 'new URL same generation']) await check(kind + ' is a new notice version', async () => {
    const f = await start(); close(f);
    await poll(f, data(f, kind.startsWith('same') ? origin : B, kind.startsWith('same') ? 'b' : 'a'));
    assert.equal(f.overlays, 2); assert.equal(f.ids.get('dsh-lite-backup-changed').hidden, false);
  });
  await check('open panel updates in place and closing that version suppresses only that version', async () => {
    const f = await start(); await poll(f, data(f, B, 'b'));
    assert.equal(f.overlays, 1); assert.equal(address(f), B + '/dsh-lite'); close(f);
    await poll(f, data(f, B, 'b')); assert.equal(f.overlays, 1);
    await poll(f, data(f, C, 'd')); assert.equal(f.overlays, 2);
  });
  await check('backup current entry symmetrically watches rebuilt primary', async () => {
    const f = await start({ origin }); close(f); f.tick(20000);
    const changed = data(f); changed.tunnels.primary = { ...primarySlot, generation: generation('d'), origin: B, url: B + '/dsh-lite', checkedAt: f.now };
    f.setData(changed); f.control.update(); await flush();
    assert.equal(f.overlays, 2); assert.equal(address(f), B + '/dsh-lite'); assert.notEqual(address(f), origin + '/dsh-lite');
  });
  await check('source-only generation replacement invalidates preparation without alternate-change popup', async () => {
    const f = await start(); f.setPrepared({ phase: 'prepared', origin, generation: generation('a'), message: 'Prepared fixture' }); close(f);
    const previous = f.invalidations, changed = data(f); changed.tunnels.primary.generation = generation('d');
    await poll(f, changed); assert.equal(f.overlays, 1); assert(f.invalidations > previous);
  });
  for (const state of ['unavailable', 'failure']) await check(state + ' drops preparation; same version recovery does not repeat', async () => {
    const f = await start(); f.setPrepared({ phase: 'prepared', origin, generation: generation('a'), message: 'Prepared fixture' }); close(f);
    const bad = data(f); bad.tunnels.backup.reachable = false;
    await poll(f, state === 'failure' ? Error('fixture read failed') : bad);
    assert.equal(f.overlays, 1); await poll(f, data(f)); assert.equal(f.overlays, 1);
    f.control.show(); await flush(); assert.match(f.ids.get('dsh-lite-backup-status').textContent, /尚未验证/);
  });
  await check('unavailable then rebuilt generation prompts, without claiming prepared', async () => {
    const f = await start(); close(f); const bad = data(f); bad.tunnels.backup.phase = 'rebuilding';
    await poll(f, bad); assert.equal(f.overlays, 1);
    await poll(f, data(f, B, 'b')); assert.equal(f.overlays, 2); assert.match(f.ids.get('dsh-lite-backup-status').textContent, /尚未验证/);
  });
  await check('another modal defers B and coalesces C; only latest C is shown', async () => {
    const f = await start(); close(f); f.external(true);
    await poll(f, data(f, B, 'b')); assert.equal(f.overlays, 1);
    await poll(f, data(f, C, 'd')); assert.equal(f.overlays, 1);
    f.external(false); f.control.update(); await flush();
    assert.equal(f.overlays, 2); assert.equal(address(f), C + '/dsh-lite');
  });
  for (const oldResult of ['success', 'failure']) await check('A→B→C out-of-order ' + oldResult + ' cannot overwrite C or restore old candidate', async () => {
    const f = await start(); close(f); f.tick(20000);
    const resolveB = f.deferRead(oldResult === 'success' ? data(f, B, 'b') : Error('obsolete failure'));
    f.control.update(); await flush();
    const resolveC = f.deferRead(data(f, C, 'd')); f.control.show(); await flush();
    assert.equal(f.reads.at(-2).init.signal.aborted, true, 'manual recheck aborts the old monitor');
    resolveC(); await flush(); assert.equal(address(f), C + '/dsh-lite');
    resolveB(); await flush(); assert.equal(address(f), C + '/dsh-lite');
    assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, false); assert.equal(f.timers.size, 0);
  });
  await check('preparation read supersedes pending B monitor; obsolete failure cannot clear accepted C', async () => {
    const f = await start(); f.tick(20000); const resolveB = f.deferRead(data(f, B, 'b'));
    f.control.update(); await flush(); const resolveC = f.deferRead(data(f, C, 'd'));
    const prepared = f.preparationRead().catch(error => error); await flush(); resolveC();
    assert.match((await prepared).message, /preparation-target-changed/); await flush();
    assert.equal(address(f), C + '/dsh-lite'); resolveB(); await flush(); assert.equal(address(f), C + '/dsh-lite');
  });
  await check('hidden page cancels reads and pauses, foreground reads latest without stale result resurrection', async () => {
    const f = await start(); close(f); f.tick(20000); const resolveB = f.deferRead(data(f, B, 'b'));
    f.control.update(); await flush(); const pending = f.reads.at(-1);
    f.visibility(true); await flush(); assert.equal(pending.init.signal.aborted, true); assert.equal(f.timers.size, 0);
    const count = f.reads.length; f.tick(120000); f.control.update(); await flush(); assert.equal(f.reads.length, count);
    f.setData(data(f, C, 'd')); f.visibility(false); await flush(); assert.equal(address(f), C + '/dsh-lite');
    resolveB(); await flush(); assert.equal(address(f), C + '/dsh-lite'); assert.equal(f.overlays, 2);
  });
  await check('visible heartbeat is single-flight and bounded at 20 seconds on success', async () => {
    const f = await start(); close(f); const count = f.reads.length;
    await poll(f, data(f), 19999); assert.equal(f.reads.length, count);
    const done = f.deferRead(data(f)); f.tick(1); f.control.update(); await flush();
    for (let i = 0; i < 30; i++) f.control.update(); await flush(); assert.equal(f.reads.length, count + 1);
    done(); await flush(); assert.equal(f.timers.size, 0);
  });
  await check('failure retries back off 20/40/80/120 seconds and cap; no error popup spam', async () => {
    const f = await start(); close(f); f.setData(Error('owned failure'));
    for (const delay of [20000, 20000, 40000, 80000, 120000, 120000]) {
      const count = f.reads.length; f.tick(delay - 1); f.control.update(); await flush(); assert.equal(f.reads.length, count);
      f.tick(1); f.control.update(); await flush(); assert.equal(f.reads.length, count + 1); assert.equal(f.overlays, 1);
    }
    f.tick(120000); f.setData(data(f, B, 'b')); f.control.update(); await flush(); assert.equal(f.overlays, 2);
  });
  await check('disabled clears deferred new version and polls slowly; explicit re-enable notices latest', async () => {
    const f = await start(); close(f); f.external(true); await poll(f, data(f, B, 'b'));
    await poll(f, data(f, B, 'b', { enabled: false })); f.external(false); f.control.update(); await flush(); assert.equal(f.overlays, 1);
    const count = f.reads.length; await poll(f, data(f, C, 'd'), 59999); assert.equal(f.reads.length, count);
    f.tick(1); f.control.update(); await flush(); assert.equal(f.overlays, 2); assert.equal(address(f), C + '/dsh-lite');
  });
  await check('read failure clears a deferred B; later current C is the only alert', async () => {
    const f = await start(); close(f); f.external(true); await poll(f, data(f, B, 'b'));
    await poll(f, Error('failed refresh')); f.external(false); f.control.update(); await flush(); assert.equal(f.overlays, 1);
    await poll(f, data(f, C, 'd')); assert.equal(f.overlays, 2); assert.equal(address(f), C + '/dsh-lite');
  });
  await check('poll hides stale manual selection candidate; timeout clears and late response cannot restore it', async () => {
    const f = await start(); f.tick(20000); const done = f.deferRead(data(f, B, 'b')); f.control.update(); await flush();
    assert.equal(address(f), ''); assert.equal(f.ids.get('dsh-lite-backup-select').disabled, true);
    for (const callback of [...f.timers.values()]) callback(); await flush(); assert.equal(address(f), '');
    done(); await flush(); assert.equal(address(f), ''); assert.equal(f.timers.size, 0); assert.equal(f.copies.length, 0);
  });
  await check('old clipboard completion cannot confirm or select an obsolete address after C replaces B', async () => {
    const f = await start(); let finish;
    f.context.navigator.clipboard.writeText = value => { f.copies.push(value); return new Promise(resolve => { finish = resolve; }); };
    f.setData(data(f, B, 'b')); f.ids.get('dsh-lite-backup-copy').click(); await flush(); assert.deepEqual(f.copies, [B + '/dsh-lite']);
    f.setData(data(f, C, 'd')); await assert.rejects(f.preparationRead(), /preparation-target-changed/);
    finish(); await flush(); assert.equal(address(f), C + '/dsh-lite'); assert.doesNotMatch(f.ids.get('dsh-lite-backup-status').textContent, /已复制/);
    // The already started clipboard write cannot be undone. Only its stale UI acknowledgement is suppressed.
  });
  await check('unknown/self/invalid origins clear candidate and never notify as a new alternate', async () => {
    const f = await start(); close(f); await poll(f, data(f, primaryOrigin, 'b')); assert.equal(f.overlays, 1);
    const bad = data(f, B, 'b'); bad.tunnels.primary.origin = 'https://unknown.trycloudflare.com';
    await poll(f, bad); assert.equal(f.overlays, 1); assert.equal(f.copies.length, 0);
  });
  await check('overdue deferred B is revalidated before any popup and only C appears', async () => {
    const f = await start(); close(f); f.external(true); await poll(f, data(f, B, 'b'));
    f.tick(20000); const done = f.deferRead(data(f, C, 'd')); f.external(false); f.control.update();
    await flush(); assert.equal(f.overlays, 1, 'do not flash overdue B before its recheck');
    done(); await flush(); assert.equal(f.overlays, 2); assert.equal(address(f), C + '/dsh-lite');
  });
  await check('unresolved clipboard permission cannot suspend new-version monitoring', async () => {
    const f = await start(); let done;
    f.context.navigator.clipboard.writeText = () => new Promise(resolve => { done = resolve; });
    f.ids.get('dsh-lite-backup-copy').click(); await flush();
    await poll(f, data(f, B, 'b')); assert.equal(address(f), B + '/dsh-lite');
    assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, false); assert.equal(f.timers.size, 0);
    done(); await flush(); assert.doesNotMatch(f.ids.get('dsh-lite-backup-status').textContent, /已复制/);
  });
  await check('clipboard UI deadline is uncertain and closing cancels its timer without undo claims', async () => {
    const f = await start(); f.context.navigator.clipboard.writeText = () => new Promise(() => {});
    f.ids.get('dsh-lite-backup-copy').click(); await flush();
    for (const callback of [...f.timers.values()]) callback(); await flush();
    assert.match(f.ids.get('dsh-lite-backup-status').textContent, /复制结果未能确认/);
    assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, false); assert.equal(f.timers.size, 0);
    f.ids.get('dsh-lite-backup-copy').click(); await flush(); close(f); await flush(); assert.equal(f.timers.size, 0);
  });
  for (const lang of ['en', 'es']) await check(lang + ' includes monitor and clipboard uncertainty translations', async () => {
    const f = await start({ lang });
    function content(node) { return node.textContent + node.children.map(content).join(' '); }
    assert.doesNotMatch(content(f.ids.get('dsh-lite-backup-dialog')), /[\u4e00-\u9fff]/);
    f.context.navigator.clipboard.writeText = () => new Promise(() => {}); f.ids.get('dsh-lite-backup-copy').click(); await flush();
    for (const callback of [...f.timers.values()]) callback(); await flush();
    assert.doesNotMatch(f.ids.get('dsh-lite-backup-status').textContent, /[\u4e00-\u9fff]/);
  });
  for (const replacement of ['connection', 'secret', 'component']) for (const outcome of ['success', 'timeout', 'rejection']) {
    await check('clipboard ' + outcome + ' checks ' + replacement + ' before the next heartbeat', async () => {
      const f = await start(); let done, fail;
      f.context.navigator.clipboard.writeText = () => new Promise((resolve, reject) => { done = resolve; fail = reject; });
      f.ids.get('dsh-lite-backup-copy').click(); await flush();
      if (replacement === 'connection') f.nextConnection();
      if (replacement === 'secret') f.context.__dshE2eeSecret = 'ROTATED_SYNTHETIC_KEY';
      if (replacement === 'component') f.context.DshE2EE = { ...f.context.DshE2EE };
      if (outcome === 'success') done(); else if (outcome === 'rejection') fail(Error('fixture clipboard rejected'));
      else for (const callback of [...f.timers.values()]) callback();
      await flush(); assert.equal(address(f), ''); assert.equal(f.ids.get('dsh-lite-backup-copy').disabled, true);
      assert.doesNotMatch(f.ids.get('dsh-lite-backup-status').textContent, /已复制|复制结果未能确认/);
      assert.equal(f.timers.size, 0);
    });
  }
  await check('initial read failure retries and first successful enabled check still reminds', async () => {
    const f = await start({ data: Error('initial fixture failure') }); assert.equal(f.overlays, 0);
    await poll(f, data(f)); assert.equal(f.overlays, 1); assert.equal(address(f), origin + '/dsh-lite');
  });
  await check('document-wide shown version survives remount but does not hide a later version', async () => {
    const f = await start(); close(f); await poll(f, data(f, B, 'b')); close(f); f.control.dispose();
    const next = f.mount(); next.update(); await flush(); assert.equal(f.overlays, 2);
    f.tick(20000); f.setData(data(f, C, 'd')); next.update(); await flush(); assert.equal(f.overlays, 3); next.dispose();
  });
  console.log(`${checks} visible-page backup-monitor scenarios passed (isolated fixtures only).`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
