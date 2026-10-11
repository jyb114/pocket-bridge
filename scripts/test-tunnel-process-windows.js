'use strict';

// Native Windows acceptance of the real ownership adapter. The executable is
// a byte-for-byte copy of this Node runtime, NOT cloudflared. Its owned script
// only waits on stdin/timers and never opens a socket or contacts a provider.
// No OS/PowerShell operation is mocked. Every queried/stopped PID belongs to
// one of this fixture's two children. Cleanup uses their private stdin channel
// or bounded self-exit, never a PID/image-name force-kill fallback.
if (process.platform !== 'win32') {
  console.log('SKIP native tunnel-process acceptance: Windows required; no child or native operation executed.');
  process.exit(0);
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createProcessAdapter } = require('./tunnel-process.js');
const { quickLaunch } = require('./tunnel-runtime.js');
const SELF_EXIT_MS = 180000;
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pb native ownership-'));
const executable = path.join(scratch, 'cloudflared.exe');
const children = [];
let checks = 0;
const adapter = createProcessAdapter({ timeoutMs: 10000 });
const clone = value => JSON.parse(JSON.stringify(value));
const check = async (label, operation) => { await operation(); checks++; console.log('PASS ' + label); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function start(role, generation) {
  const launch = { exe: executable, ...quickLaunch(path.join(scratch, 'logs'), role, generation, 8081) };
  fs.mkdirSync(path.dirname(launch.logFile), { recursive: true });
  fs.writeFileSync(launch.logFile, '', { flag: 'wx' });
  fs.writeFileSync(launch.configFile, '{}\n', { flag: 'wx' });
  // Node does not inherit preload/debug/module settings from the CI shell.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:NODE_|TUNNEL_|CLOUDFLARED_|ELECTRON_)/i.test(name)));
  const child = spawn(executable, launch.args, { cwd: scratch, env, windowsHide: true,
    detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const owned = { child, launch, closed: false, stdout: '', stderr: '', error: null };
  children.push(owned);
  owned.close = new Promise(resolve => child.once('close', (code, signal) => {
    owned.closed = true; owned.code = code; owned.signal = signal; resolve();
  }));
  child.once('error', error => { owned.error = error; });
  child.stdin.on('error', () => {}); // A closed private cleanup pipe is benign.
  child.stdout.on('data', data => { owned.stdout += data; });
  child.stderr.on('data', data => { owned.stderr += data; });
  const ready = new Promise((resolve, reject) => {
    const onData = () => {
      if (owned.stdout.includes('OWNED_WAITING_CHILD\n')) { child.stdout.off('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('close', () => reject(Error('Owned fixture exited before readiness: ' + owned.stderr)));
  });
  await bounded(ready, 15000, 'Owned fixture did not become ready');
  assert(Number.isSafeInteger(child.pid) && child.pid > 0);
  return owned;
}

async function main() {
  fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_EXCL);
  assert.equal(hash(executable), hash(process.execPath), 'Fixture must be the existing Node executable');
  fs.writeFileSync(path.join(scratch, 'tunnel'), `'use strict';\n` +
    `const deadline = setTimeout(() => process.exit(0), ${SELF_EXIT_MS});\n` +
    `let input = ''; process.stdin.setEncoding('utf8');\n` +
    `process.stdin.on('data', value => { input += value; if (input.includes('fixture-exit\\n')) process.exit(0); if (input.length > 1024) process.exit(2); });\n` +
    `process.stdin.on('end', () => process.exit(0));\n` +
    `process.stdout.write('OWNED_WAITING_CHILD\\n');\n`, { flag: 'wx' });
  const primary = await start('primary', 'a'.repeat(32));
  const backup = await start('backup', 'b'.repeat(32));
  let primaryProof, backupProof;

  await check('real PowerShell captures both exact owned executable/argv/native-birth proofs', async () => {
    primaryProof = await adapter.capture(primary.child.pid, primary.launch);
    backupProof = await adapter.capture(backup.child.pid, backup.launch);
    for (const [owned, proof] of [[primary, primaryProof], [backup, backupProof]]) {
      assert(proof, 'Native capture must succeed, not skip or substitute a mock');
      assert.equal(proof.pid, owned.child.pid);
      // The adapter uses fs.promises.realpath/native canonicalization. On
      // Windows the legacy sync resolver can retain RUNNER~1 while native
      // CIM and the async resolver return the same expanded long path.
      assert.equal(proof.exe.toLowerCase(), (await fs.promises.realpath(executable)).toLowerCase());
      assert.deepEqual(proof.args, owned.launch.args);
      assert.match(proof.birth, /^[1-9][0-9]{16,18}$/);
      assert.equal((await adapter.inspect(proof)).state, 'live');
    }
    assert.notEqual(primaryProof.pid, backupProof.pid);
  });
  await check('capture rejects a different executable and inconsistent slot marker', async () => {
    assert.equal(await adapter.capture(primary.child.pid, { ...primary.launch, exe: process.execPath }), null);
    assert.equal(await adapter.capture(primary.child.pid, { ...primary.launch, generation: 'c'.repeat(32) }), null);
    assert.equal((await adapter.inspect(primaryProof)).state, 'live');
  });
  await check('altered native birth cannot signal the still-live owned child', async () => {
    const altered = clone(primaryProof); altered.birth = (BigInt(altered.birth) + 1n).toString();
    assert.equal((await adapter.inspect(altered)).code, 'birth-changed');
    const result = await adapter.stop(altered);
    assert.equal(result.stopped, false); assert.equal(result.code, 'process-changed');
    assert.equal((await adapter.inspect(primaryProof)).state, 'live');
  });
  await check('valid-shaped altered command and invalid log proof cannot signal owned children', async () => {
    const command = clone(primaryProof);
    command.args[2] = 'http://127.0.0.1:9099';
    command.commandLine = command.commandLine.replace('http://127.0.0.1:8081', command.args[2]);
    const rejected = await adapter.stop(command);
    assert.equal(rejected.stopped, false); assert.equal(rejected.code, 'identity-changed');
    const marker = clone(primaryProof); marker.logFile += '.other';
    assert.deepEqual(await adapter.stop(marker), { stopped: false, code: 'invalid-proof' });
    assert.equal((await adapter.inspect(primaryProof)).state, 'live');
    assert.equal((await adapter.inspect(backupProof)).state, 'live');
  });
  await check('real held-handle stop closes only the exact primary while backup stays live', async () => {
    const result = await adapter.stop(primaryProof);
    assert.equal(result.stopped, true); assert.equal(result.code, 'stopped');
    await bounded(primary.close, 10000, 'Native primary stop did not produce physical child close');
    assert(primary.closed); assert.equal(backup.closed, false);
    assert.equal((await adapter.inspect(backupProof)).state, 'live');
  });
  await check('stale proof cannot authorize a different owned lifetime even with its PID substituted', async () => {
    // This models reuse against another strictly owned child; it never guesses
    // a host PID or tries to induce genuine system PID reuse.
    const stale = clone(primaryProof); stale.pid = backup.child.pid;
    const result = await adapter.stop(stale);
    assert.equal(result.stopped, false);
    assert(['process-changed', 'identity-changed'].includes(result.code));
    assert.equal((await adapter.inspect(backupProof)).state, 'live');
  });
  await check('real held-handle backup stop is followed by physical close', async () => {
    const result = await adapter.stop(backupProof);
    assert.equal(result.stopped, true); assert.equal(result.code, 'stopped');
    await bounded(backup.close, 10000, 'Native backup stop did not produce physical child close');
    assert(backup.closed);
  });
  console.log(`${checks} Windows native ownership groups passed using two harmless owned Node children; no real tunnel, provider or network was used.`);
}

async function cleanup() {
  for (const owned of children) if (!owned.closed) {
    try { owned.child.stdin.end('fixture-exit\n'); } catch (_) {}
  }
  // Even an uncertain adapter result must not trigger taskkill, process.kill,
  // or a new PID-based cleanup. The script exits itself within three minutes.
  await bounded(Promise.all(children.map(owned => owned.close)), SELF_EXIT_MS + 15000,
    'Owned child closure remains unconfirmed; fixture files were retained');
  assert(children.every(owned => owned.closed));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

(async () => {
  try { await main(); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
  finally {
    try { await cleanup(); }
    catch (error) { console.error(error.stack); process.exitCode = 1; }
  }
})();
