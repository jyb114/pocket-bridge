'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDesktopActionScheduler } = require('./desktop-ui-action.js');
const { createDesktopDriver } = require('./codex-desktop-driver.js');

(async () => {
  const scheduler = createDesktopActionScheduler();
  const children = [];
  let starts = 0;
  const driver = createDesktopDriver({ platform: 'win32', runDesktopAction: scheduler.runDesktopAction,
    spawn(_Executable, _Arguments, options) {
      const expectedTemp = path.join(path.dirname(__dirname), 'logs', 'native-temp');
      assert.equal(options.env.TEMP, expectedTemp); assert.equal(options.env.TMP, expectedTemp);
      starts++;
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kills = 0; child.kill = () => { child.kills++; return true; };
      children.push(child);
      return child;
    }
  });
  const input = { requestId: 'private-lifecycle-regression', threadId: '11111111-1111-1111-1111-111111111111',
    cwd: 'D:\\disposable-test', text: 'synthetic lifecycle regression' };
  const pending = driver.send(input).then(() => { throw new Error('Oversized helper response accepted'); }, error => error);
  const child = children[0];
  child.stdout.write(Buffer.alloc(32769));
  assert.equal(child.kills, 1);
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'Helper kill must not release the lease before close.');
  await assert.rejects(() => scheduler.runDesktopAction('dot-read', async () => {}), error =>
    error.code === 'desktop-busy' && error.status === 409 && error.submitted === false);
  const concurrent = await driver.inspect();
  assert.equal(concurrent.reason, 'desktop-busy');
  assert.equal(starts, 1, 'Busy actions must not create another native helper.');
  child.emit('close', 1);
  const failure = await pending;
  assert.equal(failure.code, 'unknown'); assert.equal(failure.submitted, null);
  await scheduler.runDesktopAction('dot-read', async () => {});

  const busySend = driver.send(input).then(() => { throw new Error('OS busy response accepted'); }, error => error);
  const busyChild = children[1];
  busyChild.stdout.end(JSON.stringify({ ok: false, code: 'desktop-busy', submitted: false,
    stage: 'acquire-desktop-action', reason: 'Another desktop action is in progress.' }));
  busyChild.emit('close', 0);
  const busyFailure = await busySend;
  assert.equal(busyFailure.code, 'desktop-busy'); assert.equal(busyFailure.status, 409);
  assert.equal(busyFailure.submitted, false); assert.equal(busyFailure.stage, 'acquire-desktop-action');

  const failedStart = driver.send(input).then(() => { throw new Error('Failed helper start accepted'); }, error => error);
  const failedChild = children[2];
  failedChild.emit('error', new Error('synthetic child error'));
  await assert.rejects(() => scheduler.runDesktopAction('dot-read', async () => {}), error => error.code === 'desktop-busy');
  failedChild.emit('close', 1);
  assert.equal((await failedStart).submitted, null);
  await scheduler.runDesktopAction('dot-read', async () => {});
  for (const wrongProof of [false, true]) {
    const text = input.text + '\n';
    const bytes = Buffer.from(text, 'utf8');
    const request = { ...input, text };
    const pendingProof = driver.send(request).then(value => ({ value }), error => ({ error }));
    const proofChild = children[children.length - 1];
    proofChild.stdout.end(JSON.stringify({ ok: true, submitted: true, verifiedThreadId: request.threadId,
      actualCwd: request.cwd, desktopIdentity: { packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: '26.928.3736.0' },
      composerTextProof: { version: 1, sha256: wrongProof ? '0'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex'), utf8Bytes: bytes.length } }));
    proofChild.emit('close', 0);
    const result = await pendingProof;
    if (wrongProof) { assert.equal(result.error.code, 'unknown'); assert.equal(result.error.submitted, null); }
    else { assert.equal(result.value.composerTextProof.utf8Bytes, bytes.length); assert.equal(result.value.submitted, true); }
  }
  console.log('PASS desktop helper lifecycle: fail-fast busy, close-before-release, and preserved submission uncertainty; no native actions.');
})().catch(error => { console.error(error); process.exitCode = 1; });
