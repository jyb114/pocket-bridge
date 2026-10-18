'use strict';

// Pure, deterministic capability tests. Every device, token, key version,
// origin, clock and entropy source is synthetic. No HTTP, sessions module,
// runtime files, provider, native process or real credentials are used.
const assert = require('node:assert/strict');
const { createBackupPreparation, TTL_MS, MAX_RECORDS, MAX_PER_DEVICE } = require('./backup-preparation.js');
const { FRESHNESS_MS } = require('./tunnel-state.js');

const START = 1700000000000;
const DEVICE = 'synthetic-device-0001';
const OTHER_DEVICE = 'synthetic-device-0002';
const ORIGIN = 'https://synthetic-backup.trycloudflare.com';
const PRIMARY_ORIGIN = 'https://synthetic-primary.trycloudflare.com';
const OTHER_ORIGIN = 'https://synthetic-replacement.trycloudflare.com';
const GENERATION = 'c'.repeat(32);
const PRIMARY_GENERATION = 'd'.repeat(32);
const TOKEN = 'synthetic-device-token';
const NONCE = '1'.repeat(48);
const CHALLENGE = '2'.repeat(48);
const INVALID = 'backup-preparation-invalid';
const UNAVAILABLE = 'backup-preparation-unavailable';
const CHANGED = 'backup-preparation-target-changed';
const INACTIVE = 'backup-preparation-device-inactive';
const REISSUE_FAILED = 'backup-preparation-device-reissue-failed';
let passes = 0;
const failures = [];

function check(name, operation) {
  try { operation(); passes++; console.log('PASS ' + name); }
  catch (error) { failures.push(name); console.error('FAIL ' + name + '\n' + error.stack); }
}
function rejects(operation, code = INVALID) {
  assert.throws(operation, error => {
    if (Array.isArray(code)) assert(code.includes(error.code), 'unexpected rejection: ' + error.code);
    else assert.equal(error.code, code);
    return true;
  });
}
function fixture(sourceRole = 'primary') {
  const state = {
    time: START, serial: 0, receipts: new Map(), active: new Set([DEVICE, OTHER_DEVICE]), reissues: [], entropyCalls: 0,
    context: {
      enabled: true, supported: true,
      instanceId: '11111111-1111-4111-8111-111111111111',
      bootId: '22222222-2222-4222-8222-222222222222',
      port: 43123, accessVersion: 'a'.repeat(64), e2eeVersion: 'b'.repeat(64),
      backup: { phase: 'ready', reachable: true, checkedAt: START, origin: ORIGIN, generation: GENERATION },
      primary: { phase: 'ready', reachable: true, checkedAt: START, origin: PRIMARY_ORIGIN, generation: PRIMARY_GENERATION }
    }
  };
  const options = {
    readContext() { return state.readContext ? state.readContext() : state.context; },
    isDeviceActive(id) { return state.isDeviceActive ? state.isDeviceActive(id) : state.active.has(id); },
    reissueDevice(id, authority) {
      state.reissues.push({ id, authority });
      return state.reissue ? state.reissue(id, authority) : TOKEN;
    },
    now() { return state.time; },
    randomBytes(size) {
      state.entropyCalls++;
      assert.equal(size, 32);
      if (state.entropy) return state.entropy(size);
      const bytes = Buffer.alloc(size);
      bytes.writeUInt32BE(++state.serial, size - 4);
      return bytes;
    }
  };
  const api = createBackupPreparation(options);
  const sourceOrigin = state.context[sourceRole].origin;
  const target = { ...state.context[sourceRole === 'primary' ? 'backup' : 'primary'] };
  const owner = minted => ({ preparationId: minted.preparationId, deviceId: DEVICE, sourceOrigin });
  const proof = minted => ({ nonce: minted.nonce, challenge: minted.challenge });
  const mint = (extra = {}) => api.mint({ deviceId: DEVICE, sourceOrigin, origin: target.origin, generation: target.generation, nonce: NONCE, challenge: CHALLENGE, ...extra });
  const redeem = (minted, extra = {}) => {
    const result = api.redeem({ ticket: minted.ticket, origin: minted.origin, ...proof(minted), ...extra });
    state.receipts.set(minted.preparationId, result.receipt);
    return result;
  };
  const confirm = (minted, extra = {}) => api.confirmReceiver({ ...owner(minted), ...proof(minted),
    receipt: state.receipts.get(minted.preparationId), ...extra });
  const complete = (minted, extra = {}) => api.complete({ ...owner(minted), origin: minted.origin, generation: minted.generation, ...proof(minted), ...extra });
  const finish = minted => { confirm(minted); return complete(minted); };
  return { state, options, api, owner, proof, mint, redeem, confirm, complete, finish, sourceOrigin };
}

check('factory rejects missing or non-function dependencies', () => {
  rejects(() => createBackupPreparation(), 'backup-preparation-invalid-options');
  for (const name of ['readContext', 'isDeviceActive', 'reissueDevice', 'now', 'randomBytes']) {
    const f = fixture();
    for (const value of [null, false, 1, 'function', {}])
      rejects(() => createBackupPreparation({ ...f.options, [name]: value }), 'backup-preparation-invalid-options');
  }
});

check('mint returns an opaque, bounded, boot-bound capability and a private-free pending status', () => {
  const f = fixture(), minted = f.mint();
  assert.equal(TTL_MS, 60000);
  assert.match(minted.ticket, /^bp1_[A-Za-z0-9_-]{43}$/);
  assert.match(minted.preparationId, /^bprep1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(minted.ticket.slice(4), minted.preparationId.slice(7));
  assert.deepEqual(Object.keys(minted).sort(), ['bootId', 'challenge', 'expiresAt', 'generation', 'nonce', 'origin', 'preparationId', 'ticket']);
  assert.equal(minted.bootId, f.state.context.bootId);
  assert.equal(minted.origin, ORIGIN);
  assert.equal(minted.generation, GENERATION);
  assert.equal(minted.expiresAt, START + TTL_MS);
  const status = f.api.status(f.owner(minted));
  assert.deepEqual(status, { preparationId: minted.preparationId, bootId: minted.bootId,
    origin: ORIGIN, generation: GENERATION, nonce: NONCE, challenge: CHALLENGE, expiresAt: START + TTL_MS, phase: 'pending', checkedAt: null });
  for (const secret of [DEVICE, TOKEN, f.state.context.accessVersion, f.state.context.e2eeVersion, f.state.context.instanceId])
    assert.equal(JSON.stringify([minted, status]).includes(secret), false);
  assert.equal(f.state.reissues.length, 0);
  assert.equal(Object.isFrozen(f.api), true);
});

check('redeem issues only for the recorded device and exact destination authority', () => {
  const f = fixture(), minted = f.mint();
  f.state.time += 1234;
  const result = f.redeem(minted);
  assert.deepEqual(f.state.reissues, [{ id: DEVICE, authority: 'synthetic-backup.trycloudflare.com' }]);
  assert.equal(result.token, TOKEN);
  assert.equal(result.preparationId, minted.preparationId);
  assert.equal(result.bootId, minted.bootId);
  assert.equal(result.expiresAt, f.state.time + TTL_MS);
  assert.equal(Object.hasOwn(result, 'ticket'), false);
  assert.equal(f.api.status(f.owner(minted)).phase, 'redeemed');
  rejects(() => f.redeem(minted));
  assert.equal(f.state.reissues.length, 1);
});

check('only the redeemed owning tuple completes and completed status does not refresh its expiry', () => {
  const f = fixture(), minted = f.mint();
  rejects(() => f.complete(minted));
  const redeemed = f.redeem(minted);
  f.state.time += 20;
  const result = f.finish(minted);
  assert.equal(result.checkedAt, f.state.time);
  assert.equal(result.expiresAt, redeemed.expiresAt);
  assert.equal(Object.hasOwn(result, 'token'), false);
  const status = f.api.status(f.owner(minted));
  assert.equal(status.phase, 'completed');
  assert.equal(status.checkedAt, result.checkedAt);
  f.state.time += 20;
  assert.equal(f.api.status(f.owner(minted)).expiresAt, redeemed.expiresAt);
  rejects(() => f.complete(minted));
  rejects(() => f.redeem(minted));
});

check('mutating returned tuples cannot change stored capability ownership or target', () => {
  const f = fixture(), minted = f.mint(), original = { ...minted };
  Object.assign(minted, { deviceId: OTHER_DEVICE, origin: OTHER_ORIGIN, generation: 'f'.repeat(32),
    bootId: '44444444-4444-4444-8444-444444444444', expiresAt: Number.MAX_SAFE_INTEGER });
  const status = f.api.status(f.owner(original));
  assert.equal(status.origin, ORIGIN);
  assert.equal(status.generation, GENERATION);
  assert.equal(status.expiresAt, START + TTL_MS);
  Object.assign(status, { phase: 'completed', checkedAt: START, expiresAt: Number.MAX_SAFE_INTEGER });
  assert.equal(f.api.status(f.owner(original)).phase, 'pending');
  assert.equal(f.redeem(original).token, TOKEN);
  assert.deepEqual(f.state.reissues.map(entry => entry.id), [DEVICE]);
});

check('invalid device identities and inactive or uncertain devices cannot mint', () => {
  for (const deviceId of [undefined, null, '', 'short', 'x'.repeat(129), 'bad device', 'bad.device', '\u4e0d\u662f\u8bbe\u5907', 123, {}]) {
    const f = fixture();
    rejects(() => f.mint({ deviceId }), 'backup-preparation-device-invalid');
    assert.equal(f.state.entropyCalls, 0);
  }
  for (const answer of [false, undefined, null, 1, 'true', {}, Promise.resolve(true)]) {
    const f = fixture(); f.state.isDeviceActive = () => answer;
    rejects(() => f.mint(), INACTIVE);
  }
  const f = fixture(); f.state.isDeviceActive = () => { throw Error('synthetic lookup failure'); };
  rejects(() => f.mint(), INACTIVE);
});

check('mint requires exact canonical origin and current generation', () => {
  for (const origin of [undefined, null, OTHER_ORIGIN, ORIGIN + '/', ORIGIN + '/dsh-lite', ORIGIN + '?x=1',
    ORIGIN + '#key', ORIGIN.toUpperCase(), 'http://synthetic-backup.trycloudflare.com',
    'https://synthetic-backup.trycloudflare.com:443', 'https://user@synthetic-backup.trycloudflare.com']) {
    const f = fixture(); rejects(() => f.mint({ origin }), CHANGED);
    assert.equal(f.state.entropyCalls, 0);
  }
  for (const generation of [undefined, null, '', 'd'.repeat(32), GENERATION.toUpperCase(), 1]) {
    const f = fixture(); rejects(() => f.mint({ generation }), CHANGED);
  }
});

const unavailableContexts = [
  ['disabled', c => { c.enabled = false; }],
  ['unsupported', c => { c.supported = false; }],
  ['truthy enabled', c => { c.enabled = 1; }],
  ['truthy supported', c => { c.supported = 'true'; }],
  ['missing backup', c => { delete c.backup; }],
  ...['starting', 'unreachable', 'rebuilding', 'blocked', 'unavailable', 'disabled'].map(phase =>
    ['phase ' + phase, c => { c.backup.phase = phase; }]),
  ['not reachable', c => { c.backup.reachable = false; }],
  ['truthy reachable', c => { c.backup.reachable = 1; }],
  ['stale health', c => { c.backup.checkedAt = START - FRESHNESS_MS - 1; }],
  ['future health', c => { c.backup.checkedAt = START + 1; }],
  ...[undefined, 0, -1, NaN, Infinity, '1700000000000', START + 0.5].map(value =>
    ['invalid health ' + String(value), c => { c.backup.checkedAt = value; }]),
  ...['instanceId', 'bootId'].map(key => ['invalid ' + key, c => { c[key] = 'not-a-uuid'; }]),
  ...['instanceId', 'bootId', 'accessVersion', 'e2eeVersion'].map(key =>
    ['boxed ' + key, c => { c[key] = new String(c[key]); }]),
  ['boxed generation', c => { c.backup.generation = new String(c.backup.generation); }],
  ...[0, -1, 65536, 1.5, '43123'].map(value => ['invalid port ' + value, c => { c.port = value; }]),
  ...['accessVersion', 'e2eeVersion'].flatMap(key => [undefined, '', 'synthetic-raw-key', 'g'.repeat(64), 'A'.repeat(64)]
    .map(value => ['invalid ' + key + ' ' + String(value), c => { c[key] = value; }])),
  ...[undefined, '', 'f'.repeat(31), 'G'.repeat(32)].map(value =>
    ['invalid generation ' + String(value), c => { c.backup.generation = value; }]),
  ...[undefined, '', 'https://example.test', 'http://synthetic-backup.trycloudflare.com',
    'https://api.trycloudflare.com', 'https://a.b.trycloudflare.com', ORIGIN + '/', ORIGIN + '/path',
    ORIGIN + '?q=x', ORIGIN + '#x', 'https://user:pass@synthetic-backup.trycloudflare.com',
    'https://synthetic-backup.trycloudflare.com:8443'].map(value =>
    ['invalid backup origin ' + String(value), c => { c.backup.origin = value; }])
];

// Apply every malformed slot fixture to each role; neither published endpoint
// may be guessed from a previously used hostname or substituted for the other.
for (const [label, change] of [...unavailableContexts]) {
  const before = fixture().state.context, after = structuredClone(before);
  change(after);
  if (JSON.stringify(before.backup) !== JSON.stringify(after.backup)) {
    unavailableContexts.push(['primary ' + label, context => {
      const projected = { ...context, backup: context.primary };
      change(projected); context.primary = projected.backup;
    }]);
  }
}
unavailableContexts.push(['identical origins', c => { c.primary.origin = c.backup.origin; }]);

check('disabled, unsupported, stale, future and malformed context fail every protected phase', () => {
  for (const [label, change] of unavailableContexts) {
    for (const phase of ['mint', 'redeem', 'complete', 'status']) {
      const f = fixture(), minted = phase === 'mint' ? null : f.mint();
      if (phase === 'complete') { f.redeem(minted); f.confirm(minted); }
      change(f.state.context);
      const action = phase === 'mint' ? () => f.mint() : phase === 'redeem' ? () => f.redeem(minted) :
        phase === 'complete' ? () => f.complete(minted) : () => f.api.status(f.owner(minted));
      assert.doesNotThrow(() => rejects(action, UNAVAILABLE), label + ' during ' + phase);
      if (phase === 'redeem') {
        assert.equal(f.state.reissues.length, 0, label);
        rejects(() => f.redeem(minted));
      }
    }
  }
});

check('readContext exceptions and missing values fail closed without exposing callback errors', () => {
  for (const read of [() => undefined, () => null, () => [], () => { throw Error('synthetic private context'); }]) {
    const f = fixture(), minted = f.mint(); f.state.readContext = read;
    rejects(() => f.redeem(minted), UNAVAILABLE);
    assert.equal(f.state.reissues.length, 0);
    rejects(() => f.redeem(minted));
  }
});

check('health freshness is inclusive at the boundary and rejects the next millisecond', () => {
  const f = fixture(); f.state.context.backup.checkedAt = START - FRESHNESS_MS;
  const minted = f.mint(); assert.equal(f.api.status(f.owner(minted)).phase, 'pending');
  f.state.time++;
  rejects(() => f.redeem(minted), UNAVAILABLE);
  assert.equal(f.state.reissues.length, 0);
});

const changedBindings = [
  ['installation', c => { c.instanceId = '33333333-3333-4333-8333-333333333333'; }],
  ['boot', c => { c.bootId = '44444444-4444-4444-8444-444444444444'; }],
  ['port', c => { c.port++; }],
  ['access key version', c => { c.accessVersion = 'd'.repeat(64); }],
  ['E2EE key version', c => { c.e2eeVersion = 'e'.repeat(64); }],
  ['origin', c => { c.backup.origin = OTHER_ORIGIN; }],
  ['generation', c => { c.backup.generation = 'f'.repeat(32); }],
  ['source origin', c => { c.primary.origin = OTHER_ORIGIN; }],
  ['source generation', c => { c.primary.generation = 'f'.repeat(32); }],
  ['slot swap', c => { [c.primary, c.backup] = [c.backup, c.primary]; }]
];

check('both current source slots prepare only their opposite configured target', () => {
  for (const role of ['primary', 'backup']) {
    const f = fixture(role), before = structuredClone(f.state.context), minted = f.mint();
    const target = f.state.context[role === 'primary' ? 'backup' : 'primary'];
    assert.equal(minted.origin, target.origin); assert.equal(minted.generation, target.generation);
    rejects(() => f.complete(minted));
    const redeemed = f.redeem(minted);
    assert.deepEqual(f.state.reissues, [{ id: DEVICE, authority: new URL(target.origin).host }]);
    assert.equal(redeemed.token, TOKEN); rejects(() => f.redeem(minted));
    rejects(() => f.complete(minted));
    f.finish(minted); assert.equal(f.api.status(f.owner(minted)).phase, 'completed');
    assert.deepEqual(f.state.context, before, 'preparation must never swap or rewrite configured roles');
    f.api.revoke(f.owner(minted)); rejects(() => f.api.status(f.owner(minted)));
  }
});

check('unknown, stale and noncanonical source origins cannot select a target', () => {
  for (const sourceOrigin of [undefined, null, '', {}, new String(PRIMARY_ORIGIN), OTHER_ORIGIN,
    'https://unknown.example', 'http://localhost:43123', 'https://localhost:43123',
    'http://127.0.0.1:43123', 'http://[::1]:43123', PRIMARY_ORIGIN + '/', PRIMARY_ORIGIN + '/dsh-lite',
    PRIMARY_ORIGIN + ':443', PRIMARY_ORIGIN.toUpperCase(), 'https://user@synthetic-primary.trycloudflare.com']) {
    const f = fixture(); rejects(() => f.mint({ sourceOrigin }), UNAVAILABLE);
    assert.equal(f.state.entropyCalls, 0); assert.equal(f.state.reissues.length, 0);
  }
  for (const role of ['primary', 'backup']) {
    const f = fixture(role);
    f.state.context[role].origin = OTHER_ORIGIN;
    rejects(() => f.mint(), UNAVAILABLE);
    assert.equal(f.state.entropyCalls, 0);
    const source = f.state.context[role];
    rejects(() => f.mint({ sourceOrigin: source.origin, origin: source.origin, generation: source.generation }), CHANGED);
    assert.equal(f.state.entropyCalls, 0);
  }
});

check('source-only receipt, status and cancellation never accept another authenticated origin', () => {
  for (const role of ['primary', 'backup']) {
    for (const sourceOrigin of [undefined, null, '', OTHER_ORIGIN, 'http://localhost:43123']) {
      const f = fixture(role), minted = f.mint(); f.redeem(minted);
      for (const from of [sourceOrigin, minted.origin]) {
        rejects(() => f.confirm(minted, { sourceOrigin: from }), CHANGED);
        rejects(() => f.api.status({ ...f.owner(minted), sourceOrigin: from }), CHANGED);
        rejects(() => f.api.revoke({ ...f.owner(minted), sourceOrigin: from }), CHANGED);
      }
      f.finish(minted); f.api.revoke(f.owner(minted));
    }
  }
});

check('primary-target preparations retain all gates and can cancel after either role changes', () => {
  for (const [label, change] of [...changedBindings, ...unavailableContexts]) {
    for (const phase of ['mint', 'redeem', 'confirm', 'complete', 'status', 'revoke']) {
      if (phase === 'mint' && changedBindings.some(([, candidate]) => candidate === change)) continue;
      const f = fixture('backup'), minted = phase === 'mint' ? null : f.mint();
      if (['confirm', 'complete'].includes(phase)) f.redeem(minted);
      if (phase === 'complete') f.confirm(minted);
      change(f.state.context);
      if (phase === 'revoke') { assert.deepEqual(f.api.revoke(f.owner(minted)), { ok: true }); continue; }
      const action = phase === 'status' ? () => f.api.status(f.owner(minted)) : () => f[phase](minted);
      assert.doesNotThrow(() => rejects(action, [CHANGED, UNAVAILABLE]), label + ' during ' + phase);
      if (phase === 'redeem') assert.equal(f.state.reissues.length, 0);
    }
  }
});

check('replacing either slot requires a fresh issue with the newly advertised pair', () => {
  for (const sourceRole of ['primary', 'backup']) {
    for (const changedRole of ['primary', 'backup']) {
      const f = fixture(sourceRole), old = f.mint();
      f.state.context[changedRole].origin = OTHER_ORIGIN;
      f.state.context[changedRole].generation = 'e'.repeat(32);
      rejects(() => f.redeem(old), CHANGED);
      const source = f.state.context[sourceRole], target = f.state.context[sourceRole === 'primary' ? 'backup' : 'primary'];
      const fresh = f.mint({ sourceOrigin: source.origin, origin: target.origin, generation: target.generation });
      f.redeem(fresh); f.confirm(fresh, { sourceOrigin: source.origin }); f.complete(fresh);
      assert.equal(f.api.status({ ...f.owner(fresh), sourceOrigin: source.origin }).phase, 'completed');
    }
  }
});

check('installation, boot, port, keys, origin and generation stay bound on every protected action', () => {
  for (const [label, change] of changedBindings) {
    for (const phase of ['redeem', 'complete', 'status']) {
      const f = fixture(), minted = f.mint();
      if (phase === 'complete') { f.redeem(minted); f.confirm(minted); }
      change(f.state.context);
      const action = phase === 'redeem' ? () => f.redeem(minted) : phase === 'complete' ?
        () => f.complete(minted) : () => f.api.status(f.owner(minted));
      assert.doesNotThrow(() => rejects(action, CHANGED), label + ' during ' + phase);
      if (phase === 'redeem') {
        assert.equal(f.state.reissues.length, 0, label);
        rejects(() => f.redeem(minted));
      }
    }
  }
});

check('redeemed and completed status rechecks all bindings and current health', () => {
  for (const phase of ['redeemed', 'completed']) {
    for (const [label, change] of [...changedBindings, ...unavailableContexts]) {
      const f = fixture(), minted = f.mint(); f.redeem(minted);
      if (phase === 'completed') f.finish(minted);
      change(f.state.context);
      assert.doesNotThrow(() => rejects(() => f.api.status(f.owner(minted)), [CHANGED, UNAVAILABLE]), phase + ': ' + label);
    }
  }
});

check('redeem at a wrong or noncanonical destination permanently burns its ticket', () => {
  for (const origin of [undefined, null, OTHER_ORIGIN, ORIGIN + '/', ORIGIN + ':443', ORIGIN + '/dsh-lite',
    ORIGIN.toUpperCase(), 'http://synthetic-backup.trycloudflare.com']) {
    const f = fixture(), minted = f.mint();
    rejects(() => f.api.redeem({ nonce: NONCE, challenge: CHALLENGE, ticket: minted.ticket, origin }), CHANGED);
    rejects(() => f.redeem(minted));
    rejects(() => f.api.status(f.owner(minted)));
    assert.equal(f.state.reissues.length, 0);
  }
});

check('unknown or malformed tickets, preparation IDs and legacy /t tickets cannot redeem', () => {
  const f = fixture(), minted = f.mint();
  for (const ticket of [undefined, null, '', 1, {}, 'bp1_' + 'z'.repeat(43), 'bp1_' + 'x'.repeat(42),
    'bp1_' + 'x'.repeat(44), minted.ticket + '=', minted.ticket + '\n', minted.preparationId,
    '/t/' + minted.ticket, 'synthetic.payload.signature', 't1_synthetic.payload.signature'])
    rejects(() => f.api.redeem({ nonce: NONCE, challenge: CHALLENGE, ticket, origin: ORIGIN }));
  assert.equal(f.state.reissues.length, 0);
  assert.equal(f.redeem(minted).token, TOKEN);
});

check('fabricated preparation and foreign device identities cannot inspect, complete or cancel', () => {
  const f = fixture(), minted = f.mint(); f.redeem(minted);
  for (const preparationId of [undefined, null, '', 1, {}, minted.ticket,
    'bprep1_' + 'z'.repeat(43), minted.preparationId + '=', minted.preparationId + '\n']) {
    rejects(() => f.api.status({ preparationId, deviceId: DEVICE }));
    rejects(() => f.api.complete({ nonce: NONCE, challenge: CHALLENGE, preparationId, deviceId: DEVICE, origin: ORIGIN, generation: GENERATION }));
    rejects(() => f.api.revoke({ preparationId, deviceId: DEVICE }));
  }
  for (const deviceId of [undefined, null, '', OTHER_DEVICE, 'synthetic-unknown-device']) {
    rejects(() => f.api.status({ preparationId: minted.preparationId, deviceId }));
    rejects(() => f.api.complete({ nonce: NONCE, challenge: CHALLENGE, preparationId: minted.preparationId, deviceId, origin: ORIGIN, generation: GENERATION }));
    rejects(() => f.api.revoke({ preparationId: minted.preparationId, deviceId }));
  }
  assert.equal(f.api.status(f.owner(minted)).phase, 'redeemed');
  f.finish(minted);
});

check('a valid device still cannot complete the wrong origin or generation', () => {
  const f = fixture(), minted = f.mint(); f.redeem(minted); f.confirm(minted);
  for (const origin of [undefined, null, OTHER_ORIGIN, ORIGIN + '/'])
    rejects(() => f.api.complete({ nonce: NONCE, challenge: CHALLENGE, ...f.owner(minted), origin, generation: GENERATION }), CHANGED);
  for (const generation of [undefined, null, '', 'f'.repeat(32)])
    rejects(() => f.api.complete({ nonce: NONCE, challenge: CHALLENGE, ...f.owner(minted), origin: ORIGIN, generation }), CHANGED);
  assert.equal(f.api.status(f.owner(minted)).phase, 'redeemed');
  f.complete(minted);
});

check('device revocation prevents redeem, completion, status and owner cancellation', () => {
  for (const phase of ['redeem', 'complete', 'status', 'revoke']) {
    const f = fixture(), minted = f.mint();
    if (phase === 'complete') { f.redeem(minted); f.confirm(minted); }
    f.state.active.delete(DEVICE);
    const action = phase === 'redeem' ? () => f.redeem(minted) : phase === 'complete' ? () => f.complete(minted) :
      () => f.api[phase](f.owner(minted));
    rejects(action, INACTIVE);
    if (phase === 'redeem') {
      f.state.active.add(DEVICE); rejects(() => f.redeem(minted));
      assert.equal(f.state.reissues.length, 0);
    }
  }
});

check('pending tickets expire exactly at 60 seconds and cannot be revived by clock restoration', () => {
  const f = fixture(), minted = f.mint();
  f.state.time = START + TTL_MS - 1;
  assert.equal(f.api.status(f.owner(minted)).phase, 'pending');
  f.state.time++;
  rejects(() => f.redeem(minted));
  f.state.time = START;
  rejects(() => f.redeem(minted), [INVALID, UNAVAILABLE]);
  rejects(() => f.redeem(minted));
  assert.equal(f.state.reissues.length, 0);
});

check('redeemed and completed proof windows expire without polling or completion extending them', () => {
  for (const completed of [false, true]) {
    const f = fixture(), minted = f.mint();
    f.state.time += TTL_MS - 1;
    const redeemed = f.redeem(minted);
    f.state.time = redeemed.expiresAt - 1;
    assert.equal(f.api.status(f.owner(minted)).phase, 'redeemed');
    if (completed) f.finish(minted);
    f.state.time = redeemed.expiresAt;
    rejects(() => f.api.status(f.owner(minted)));
    rejects(() => f.complete(minted));
    rejects(() => f.api.revoke(f.owner(minted)));
  }
});

check('invalid clocks cannot mint or redeem', () => {
  for (const time of [undefined, null, 0, -1, NaN, Infinity, '1700000000000', START + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(), minted = f.mint(); f.state.time = time;
    rejects(() => f.mint(), UNAVAILABLE);
    rejects(() => f.redeem(minted), UNAVAILABLE);
    assert.equal(f.state.reissues.length, 0);
  }
});

check('clock rollback before issuance permanently retires pending and redeemed records', () => {
  for (const phase of ['pending', 'redeemed', 'completed']) {
    const f = fixture(), minted = f.mint();
    if (phase !== 'pending') f.redeem(minted);
    if (phase === 'completed') f.finish(minted);
    f.state.time = START - 1;
    rejects(() => f.api.status(f.owner(minted)), [INVALID, UNAVAILABLE]);
    f.state.time = START;
    rejects(() => f.api.status(f.owner(minted)));
    rejects(() => f.redeem(minted));
  }
});

check('clock rollback after an observed forward time cannot extend capability validity', () => {
  const f = fixture(), minted = f.mint();
  f.state.time += 1000;
  f.api.status(f.owner(minted));
  f.state.time -= 500;
  assert.throws(() => f.redeem(minted), error => /^backup-preparation-/.test(error.code || ''));
  assert.equal(f.state.reissues.length, 0);
});

check('observed clock rollback invalidates all outstanding records across devices', () => {
  const f = fixture(), first = f.mint(), second = f.mint({ deviceId: OTHER_DEVICE });
  f.redeem(first);
  f.state.time += 1000; f.api.status(f.owner(first));
  f.state.time -= 500;
  rejects(() => f.api.status(f.owner(first)), [INVALID, UNAVAILABLE]);
  f.state.time += 500;
  rejects(() => f.api.status(f.owner(first)));
  rejects(() => f.api.status({ preparationId: second.preparationId, deviceId: OTHER_DEVICE }));
  rejects(() => f.redeem(second));
  assert.equal(f.state.reissues.length, 1);
  assert.equal(f.api.status(f.owner(f.mint())).phase, 'pending');
});

check('new factory instances never inherit old pending, redeemed or completed records', () => {
  for (const phase of ['pending', 'redeemed', 'completed']) {
    const f = fixture(), minted = f.mint();
    if (phase !== 'pending') f.redeem(minted);
    if (phase === 'completed') f.finish(minted);
    const restarted = createBackupPreparation(f.options);
    rejects(() => restarted.redeem({ nonce: NONCE, challenge: CHALLENGE, ticket: minted.ticket, origin: ORIGIN }));
    rejects(() => restarted.status(f.owner(minted)));
    rejects(() => restarted.complete({ nonce: NONCE, challenge: CHALLENGE, ...f.owner(minted), origin: ORIGIN, generation: GENERATION }));
    rejects(() => restarted.revoke(f.owner(minted)));
    const fresh = restarted.mint({ nonce: NONCE, challenge: CHALLENGE, deviceId: DEVICE, sourceOrigin: PRIMARY_ORIGIN, origin: ORIGIN, generation: GENERATION });
    assert.notEqual(fresh.ticket, minted.ticket);
    assert.equal(restarted.status(f.owner(fresh)).phase, 'pending');
  }
});

check('a new boot with repeated entropy cannot re-create an old ticket or preparation ID', () => {
  const f = fixture(); f.state.entropy = () => Buffer.alloc(32, 71);
  const minted = f.mint();
  f.state.context.bootId = '44444444-4444-4444-8444-444444444444';
  const restarted = createBackupPreparation(f.options);
  const replacement = restarted.mint({ nonce: NONCE, challenge: CHALLENGE, deviceId: DEVICE, sourceOrigin: PRIMARY_ORIGIN, origin: ORIGIN, generation: GENERATION });
  assert.notEqual(replacement.ticket, minted.ticket);
  assert.notEqual(replacement.preparationId, minted.preparationId);
  assert.notEqual(replacement.bootId, minted.bootId);
  rejects(() => restarted.redeem({ nonce: NONCE, challenge: CHALLENGE, ticket: minted.ticket, origin: ORIGIN }));
  rejects(() => restarted.status(f.owner(minted)));
  assert.equal(restarted.redeem({ nonce: NONCE, challenge: CHALLENGE, ticket: replacement.ticket, origin: ORIGIN }).token, TOKEN);
});

check('owner cancellation retires all phases, is one-shot and never reissues a device', () => {
  for (const phase of ['pending', 'redeemed', 'completed']) {
    const f = fixture(), minted = f.mint();
    if (phase !== 'pending') f.redeem(minted);
    if (phase === 'completed') f.finish(minted);
    const before = f.state.reissues.length;
    assert.deepEqual(f.api.revoke(f.owner(minted)), { ok: true });
    rejects(() => f.api.revoke(f.owner(minted)));
    rejects(() => f.api.status(f.owner(minted)));
    rejects(() => f.complete(minted));
    rejects(() => f.redeem(minted));
    assert.equal(f.state.reissues.length, before);
  }
});

check('owner can cancel an old preparation after origin, generation, keys or policy change', () => {
  for (const [, change] of [...changedBindings, ...unavailableContexts]) {
    const f = fixture(), minted = f.mint(); change(f.state.context);
    assert.deepEqual(f.api.revoke(f.owner(minted)), { ok: true });
    rejects(() => f.redeem(minted));
  }
  const f = fixture(), minted = f.mint();
  f.state.readContext = () => { throw Error('synthetic unavailable context'); };
  assert.deepEqual(f.api.revoke(f.owner(minted)), { ok: true });
});

check('per-device capacity includes pending, redeemed and completed records and cancellation frees it', () => {
  const f = fixture(), records = [];
  assert.equal(MAX_PER_DEVICE, 4);
  for (let index = 0; index < MAX_PER_DEVICE; index++) records.push(f.mint());
  f.redeem(records[1]); f.redeem(records[2]); f.finish(records[2]);
  const entropyCalls = f.state.entropyCalls;
  rejects(() => f.mint(), 'backup-preparation-busy');
  assert.equal(f.state.entropyCalls, entropyCalls);
  f.mint({ deviceId: OTHER_DEVICE });
  f.api.revoke(f.owner(records[2]));
  const replacement = f.mint();
  assert.notEqual(replacement.preparationId, records[2].preparationId);
  rejects(() => f.mint(), 'backup-preparation-busy');
});

check('global capacity is bounded across devices and expired records free space', () => {
  const f = fixture(), records = [];
  assert.equal(MAX_RECORDS, 128);
  for (let index = 0; index < MAX_RECORDS; index++) {
    const deviceId = 'synthetic-capacity-device-' + index;
    f.state.active.add(deviceId);
    records.push(f.mint({ deviceId }));
  }
  rejects(() => f.mint(), 'backup-preparation-busy');
  f.api.revoke({ preparationId: records[0].preparationId, deviceId: 'synthetic-capacity-device-0', sourceOrigin: f.sourceOrigin });
  f.mint();
  rejects(() => f.mint(), 'backup-preparation-busy');
  f.state.time += TTL_MS;
  assert.equal(f.api.status(f.owner(f.mint())).phase, 'pending');
  rejects(() => f.redeem(records[1]));
});

check('entropy exceptions and malformed random bytes fail atomically at either allocation', () => {
  const generators = [
    () => { throw Error('synthetic entropy failure'); }, () => undefined, () => null, () => 'x'.repeat(32),
    () => Buffer.alloc(31), () => Buffer.alloc(33), () => new Uint8Array(32), () => Promise.resolve(Buffer.alloc(32))
  ];
  for (const generate of generators) {
    for (const allocation of [1, 2]) {
      const f = fixture(); let calls = 0;
      f.state.entropy = () => ++calls === allocation ? generate() : Buffer.alloc(32, 7);
      rejects(() => f.mint(), UNAVAILABLE);
      f.state.entropy = null;
      for (let index = 0; index < MAX_PER_DEVICE; index++) f.mint();
      rejects(() => f.mint(), 'backup-preparation-busy');
      assert.equal(f.state.reissues.length, 0);
    }
  }
});

check('repeated entropy cannot collide with live tickets or preparation IDs or replace their owner', () => {
  for (const collision of ['ticket', 'preparation', 'both']) {
    const f = fixture(); let calls = 0;
    f.state.entropy = () => Buffer.alloc(32, ++calls % 2 === 1 ? 71 : 72);
    const minted = f.mint();
    f.state.entropy = () => (++calls % 2 === 1) ?
      Buffer.alloc(32, collision === 'preparation' ? 91 : 71) :
      Buffer.alloc(32, collision === 'ticket' ? 92 : 72);
    let replacement;
    try { replacement = f.mint({ deviceId: OTHER_DEVICE }); }
    catch (error) { assert.equal(error.code, UNAVAILABLE); }
    if (replacement) {
      assert.notEqual(replacement.ticket, minted.ticket);
      assert.notEqual(replacement.preparationId, minted.preparationId);
      assert.equal(f.api.status({ preparationId: replacement.preparationId, deviceId: OTHER_DEVICE, sourceOrigin: f.sourceOrigin }).phase, 'pending');
    }
    assert.equal(f.api.status(f.owner(minted)).phase, 'pending');
    assert.equal(f.redeem(minted).token, TOKEN);
    assert.deepEqual(f.state.reissues.map(entry => entry.id), [DEVICE]);
  }
});

check('repeated entropy cannot revive consumed, cancelled or expired capabilities for another device', () => {
  for (const phase of ['redeemed', 'completed', 'cancelled', 'expired']) {
    const f = fixture(); let calls = 0;
    f.state.entropy = () => Buffer.alloc(32, ++calls % 2 === 1 ? 71 : 72);
    const minted = f.mint();
    if (['redeemed', 'completed'].includes(phase)) f.redeem(minted);
    if (phase === 'completed') f.finish(minted);
    if (phase === 'cancelled') f.api.revoke(f.owner(minted));
    if (phase === 'expired') f.state.time += TTL_MS;
    f.state.entropy = () => Buffer.alloc(32, ++calls % 2 === 1 ? 71 : 93);
    let replacement;
    try { replacement = f.mint({ deviceId: OTHER_DEVICE }); }
    catch (error) { assert.equal(error.code, UNAVAILABLE); }
    if (replacement) {
      assert.notEqual(replacement.ticket, minted.ticket);
      assert.notEqual(replacement.preparationId, minted.preparationId);
    }
    rejects(() => f.redeem(minted));
    assert.deepEqual(f.state.reissues.map(entry => entry.id), ['redeemed', 'completed'].includes(phase) ? [DEVICE] : []);
  }
});

check('repeated entropy cannot reuse a cancelled preparation ID for a later action by its owner', () => {
  const f = fixture(); f.state.entropy = () => Buffer.alloc(32, 71);
  const minted = f.mint(); f.api.revoke(f.owner(minted));
  const replacement = f.mint();
  assert.notEqual(replacement.ticket, minted.ticket);
  assert.notEqual(replacement.preparationId, minted.preparationId);
  rejects(() => f.redeem(minted));
  rejects(() => f.api.status(f.owner(minted)));
  rejects(() => f.api.revoke(f.owner(minted)));
  assert.equal(f.api.status(f.owner(replacement)).phase, 'pending');
});

check('null, thrown, malformed and asynchronous reissue results burn the ticket permanently', () => {
  for (const reissue of [() => null, () => undefined, () => '', () => 1, () => ({}), () => 'a b',
    () => TOKEN + '\n', () => 'x'.repeat(8193), () => Promise.resolve(TOKEN),
    () => { throw Error('synthetic reissue exception'); }]) {
    const f = fixture(), minted = f.mint(); f.state.reissue = reissue;
    rejects(() => f.redeem(minted), REISSUE_FAILED);
    f.state.reissue = null;
    rejects(() => f.redeem(minted));
    rejects(() => f.api.status(f.owner(minted)));
    assert.equal(f.state.reissues.length, 1);
    for (let index = 0; index < MAX_PER_DEVICE; index++) f.mint();
  }
});

check('reentrant redeem cannot consume the same ticket twice or complete a consuming record', () => {
  const f = fixture(), minted = f.mint();
  f.state.reissue = () => {
    rejects(() => f.redeem(minted));
    rejects(() => f.complete(minted));
    rejects(() => f.api.status(f.owner(minted)));
    return TOKEN;
  };
  assert.equal(f.redeem(minted).token, TOKEN);
  assert.equal(f.state.reissues.length, 1);
  assert.equal(f.api.status(f.owner(minted)).phase, 'redeemed');
});

check('device revocation inside synchronous reissue is caught before its token is returned', () => {
  const f = fixture(), minted = f.mint();
  f.state.reissue = () => { f.state.active.delete(DEVICE); return TOKEN; };
  rejects(() => f.redeem(minted), INACTIVE);
  f.state.active.add(DEVICE);
  rejects(() => f.redeem(minted));
  rejects(() => f.api.status(f.owner(minted)));
});

check('binding changes inside synchronous reissue are caught before its token is returned', () => {
  for (const [label, change] of changedBindings) {
    const f = fixture(), minted = f.mint();
    f.state.reissue = () => { change(f.state.context); return TOKEN; };
    assert.doesNotThrow(() => rejects(() => f.redeem(minted), CHANGED), label);
    rejects(() => f.redeem(minted));
    rejects(() => f.api.status(f.owner(minted)));
    assert.equal(f.state.reissues.length, 1);
  }
});

check('health or policy invalidation inside synchronous reissue fails closed', () => {
  for (const [label, change] of unavailableContexts) {
    const f = fixture(), minted = f.mint();
    f.state.reissue = () => { change(f.state.context); return TOKEN; };
    assert.doesNotThrow(() => rejects(() => f.redeem(minted), UNAVAILABLE), label);
    rejects(() => f.redeem(minted));
    assert.equal(f.state.reissues.length, 1);
  }
});

check('expiry or backward time inside reissue cannot return a token', () => {
  for (const time of [START - 1, START + TTL_MS, START + TTL_MS + 1]) {
    const f = fixture(), minted = f.mint();
    f.state.reissue = () => { f.state.time = time; return TOKEN; };
    rejects(() => f.redeem(minted), [INVALID, UNAVAILABLE]);
    f.state.time = START;
    rejects(() => f.redeem(minted), [INVALID, UNAVAILABLE]);
    rejects(() => f.redeem(minted));
    rejects(() => f.api.status(f.owner(minted)));
  }
});

check('owner cancellation inside reissue prevents token return and record resurrection', () => {
  for (const replacedOrigin of [false, true]) {
    const f = fixture(), minted = f.mint();
    f.state.reissue = () => {
      if (replacedOrigin) f.state.context.backup.origin = OTHER_ORIGIN;
      assert.deepEqual(f.api.revoke(f.owner(minted)), { ok: true });
      f.state.context.backup.origin = ORIGIN;
      return TOKEN;
    };
    rejects(() => f.redeem(minted));
    rejects(() => f.api.status(f.owner(minted)));
    rejects(() => f.redeem(minted));
    assert.equal(f.state.reissues.length, 1);
  }
});

const invalidProofs = [undefined, null, '', 1, {}, new String(NONCE), 'x'.repeat(48), 'a'.repeat(47),
  'a'.repeat(49), 'A'.repeat(48), '1'.repeat(47) + '\n'];

check('mint requires primitive 48-character lowercase hexadecimal nonce and challenge', () => {
  for (const key of ['nonce', 'challenge']) {
    for (const value of invalidProofs) {
      const f = fixture();
      rejects(() => f.mint({ [key]: value }));
      assert.equal(f.state.reissues.length, 0);
      assert.equal(f.state.entropyCalls, 0);
    }
  }
});

check('redeem requires the exact nonce and challenge and burns mismatched tickets', () => {
  for (const key of ['nonce', 'challenge']) {
    for (const value of [...invalidProofs, '3'.repeat(48)]) {
      const f = fixture(), minted = f.mint();
      rejects(() => f.redeem(minted, { [key]: value }), [INVALID, CHANGED]);
      rejects(() => f.redeem(minted));
      rejects(() => f.api.status(f.owner(minted)));
      assert.equal(f.state.reissues.length, 0);
    }
  }
});

check('redeem returns one opaque receiver receipt and the exact bound nonce and challenge', () => {
  const f = fixture(), minted = f.mint(), result = f.redeem(minted);
  assert.match(result.receipt, /^bpr1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(result.receipt, minted.ticket);
  assert.notEqual(result.receipt, minted.preparationId);
  assert.equal(result.nonce, NONCE);
  assert.equal(result.challenge, CHALLENGE);
  for (const ticket of [result.receipt, result.receipt.replace(/^bpr1_/, 'bp1_')])
    rejects(() => f.api.redeem({ ticket, origin: ORIGIN, nonce: NONCE, challenge: CHALLENGE }));
  rejects(() => f.redeem(minted));
  assert.equal(f.state.reissues.length, 1);
});

check('completion is forbidden until the receiver receipt has been confirmed', () => {
  const f = fixture(), minted = f.mint();
  rejects(() => f.confirm(minted));
  rejects(() => f.complete(minted));
  f.redeem(minted);
  rejects(() => f.complete(minted));
  const confirmed = f.confirm(minted);
  assert.equal(confirmed.receiverVerified, true);
  assert.equal(confirmed.preparationId, minted.preparationId);
  assert.equal(confirmed.nonce, NONCE);
  assert.equal(confirmed.challenge, CHALLENGE);
  f.complete(minted);
  assert.equal(f.api.status(f.owner(minted)).phase, 'completed');
});

check('receiver confirmation consumes its receipt once and never extends the proof window', () => {
  const f = fixture(), minted = f.mint();
  f.state.time += 100;
  const redeemed = f.redeem(minted);
  f.state.time += 100;
  const confirmed = f.confirm(minted);
  assert.equal(confirmed.expiresAt, redeemed.expiresAt);
  rejects(() => f.confirm(minted));
  f.state.time += 100;
  const completed = f.complete(minted);
  assert.equal(completed.expiresAt, redeemed.expiresAt);
  rejects(() => f.confirm(minted));
});

check('status and confirmation never expose raw receipt, token, ticket or stored receipt digest', () => {
  const f = fixture(), minted = f.mint(), pending = f.api.status(f.owner(minted));
  const redeemed = f.redeem(minted), received = f.api.status(f.owner(minted));
  const confirmed = f.confirm(minted), verified = f.api.status(f.owner(minted));
  const completed = f.complete(minted), finalStatus = f.api.status(f.owner(minted));
  for (const value of [pending, received, confirmed, verified, completed, finalStatus]) {
    for (const key of ['ticket', 'token', 'receipt', 'ticketDigest', 'receiptDigest'])
      assert.equal(Object.hasOwn(value, key), false);
    for (const secret of [minted.ticket, redeemed.token, redeemed.receipt])
      assert.equal(JSON.stringify(value).includes(secret), false);
  }
});

check('absent, malformed, forged and wrong-purpose receipts never authenticate a receiver', () => {
  for (const receipt of [undefined, null, '', 1, {}, 'bpr1_' + 'z'.repeat(43), 'bpr1_' + 'x'.repeat(42),
    'bpr1_' + 'x'.repeat(44), 'bpr1_' + 'x'.repeat(43) + '=', 'bpr1_' + 'x'.repeat(43) + '\n', TOKEN]) {
    const f = fixture(), minted = f.mint(); f.redeem(minted);
    rejects(() => f.confirm(minted, { receipt }));
    rejects(() => f.complete(minted));
  }
  for (const key of ['ticket', 'preparationId']) {
    const f = fixture(), minted = f.mint(); f.redeem(minted);
    rejects(() => f.confirm(minted, { receipt: minted[key] }));
    rejects(() => f.complete(minted));
  }
});

check('receiver confirmation and completion require matching nonce and challenge', () => {
  for (const operation of ['confirm', 'complete']) {
    for (const key of ['nonce', 'challenge']) {
      for (const value of [...invalidProofs, '3'.repeat(48)]) {
        const f = fixture(), minted = f.mint(); f.redeem(minted);
        if (operation === 'complete') f.confirm(minted);
        rejects(() => f[operation](minted, { [key]: value }), [INVALID, CHANGED]);
        if (operation === 'confirm') rejects(() => f.complete(minted));
        assert.equal(f.api.status(f.owner(minted)).phase, 'redeemed');
      }
    }
  }
});

check('a genuine receipt remains consumed after a nonce, challenge or current-context failure', () => {
  for (const key of ['nonce', 'challenge']) {
    const f = fixture(), minted = f.mint(); f.redeem(minted);
    rejects(() => f.confirm(minted, { [key]: '3'.repeat(48) }));
    rejects(() => f.confirm(minted));
    rejects(() => f.complete(minted));
  }
  for (const [, change] of [...changedBindings, ...unavailableContexts]) {
    const f = fixture(), minted = f.mint(); f.redeem(minted);
    const original = structuredClone(f.state.context);
    change(f.state.context);
    rejects(() => f.confirm(minted), [CHANGED, UNAVAILABLE]);
    f.state.context = original;
    rejects(() => f.confirm(minted));
    rejects(() => f.complete(minted));
  }
});

check('a forged receipt or wrong owner cannot consume the rightful receiver receipt', () => {
  const f = fixture(), minted = f.mint(); f.redeem(minted);
  rejects(() => f.confirm(minted, { receipt: 'bpr1_' + 'z'.repeat(43) }));
  rejects(() => f.confirm(minted, { deviceId: OTHER_DEVICE }));
  assert.equal(f.confirm(minted).receiverVerified, true);
  f.complete(minted);
});

check('receipt is bound to its preparation and owning active device', () => {
  const f = fixture(), first = f.mint(), second = f.mint();
  const a = f.redeem(first), b = f.redeem(second);
  rejects(() => f.confirm(first, { receipt: b.receipt }));
  rejects(() => f.confirm(second, { receipt: a.receipt }));
  rejects(() => f.complete(first)); rejects(() => f.complete(second));
  for (const deviceId of [undefined, null, '', OTHER_DEVICE, 'synthetic-unknown-device'])
    rejects(() => f.confirm(first, { deviceId }));
  for (const preparationId of [undefined, null, '', first.ticket, 'bprep1_' + 'z'.repeat(43)])
    rejects(() => f.confirm(first, { preparationId }));
  assert.equal(f.state.reissues.length, 2);
});

check('receiver confirmation rechecks current binding, support policy and fresh health', () => {
  for (const [label, change] of [...changedBindings, ...unavailableContexts]) {
    const f = fixture(), minted = f.mint(); f.redeem(minted);
    change(f.state.context);
    assert.doesNotThrow(() => rejects(() => f.confirm(minted), [CHANGED, UNAVAILABLE]), label);
    assert.equal(f.state.reissues.length, 1);
  }
});

check('revoked or uncertain devices cannot confirm a receipt or finish', () => {
  for (const inactive of [() => false, () => null, () => Promise.resolve(true),
    () => { throw Error('synthetic inactive lookup'); }]) {
    const f = fixture(), minted = f.mint(); f.redeem(minted);
    f.state.isDeviceActive = inactive;
    rejects(() => f.confirm(minted), INACTIVE);
    rejects(() => f.complete(minted), INACTIVE);
    assert.equal(f.state.reissues.length, 1);
  }
});

check('expiry and observed rollback invalidate unconfirmed and confirmed receipts', () => {
  for (const confirmed of [false, true]) {
    for (const changeClock of [f => { f.state.time += TTL_MS; }, f => { f.state.time--; }]) {
      const f = fixture(), minted = f.mint(); f.redeem(minted);
      if (confirmed) f.confirm(minted);
      changeClock(f);
      rejects(() => f.confirm(minted), [INVALID, UNAVAILABLE]);
      rejects(() => f.complete(minted));
      assert.equal(f.state.reissues.length, 1);
    }
  }
});

check('cancellation retires unconfirmed and confirmed receipts including a replaced destination', () => {
  for (const confirmed of [false, true]) {
    for (const replaced of [false, true]) {
      const f = fixture(), minted = f.mint(); f.redeem(minted);
      if (confirmed) f.confirm(minted);
      if (replaced) f.state.context.backup.origin = OTHER_ORIGIN;
      assert.deepEqual(f.api.revoke(f.owner(minted)), { ok: true });
      f.state.context.backup.origin = ORIGIN;
      rejects(() => f.confirm(minted));
      rejects(() => f.complete(minted));
      rejects(() => f.api.status(f.owner(minted)));
    }
  }
});

check('receiver receipt cannot survive a new factory or changed gateway boot', () => {
  for (const changedBoot of [false, true]) {
    const f = fixture(), minted = f.mint(), redeemed = f.redeem(minted);
    if (changedBoot) f.state.context.bootId = '44444444-4444-4444-8444-444444444444';
    const restarted = createBackupPreparation(f.options);
    rejects(() => restarted.confirmReceiver({ ...f.owner(minted), ...f.proof(minted), receipt: redeemed.receipt }));
  }
});

check('repeated random bytes cannot reuse a consumed receiver receipt for another preparation', () => {
  const f = fixture(); f.state.entropy = () => Buffer.alloc(32, 71);
  const first = f.mint(), a = f.redeem(first); f.confirm(first);
  const second = f.mint(), b = f.redeem(second);
  assert.notEqual(a.receipt, b.receipt);
  rejects(() => f.confirm(second, { receipt: a.receipt }));
  rejects(() => f.complete(second));
});

check('reentrant confirmation cannot reuse a receipt or complete before verification returns', () => {
  const f = fixture(), minted = f.mint(); f.redeem(minted);
  f.state.readContext = () => {
    rejects(() => f.confirm(minted));
    rejects(() => f.complete(minted));
    return f.state.context;
  };
  assert.equal(f.confirm(minted).receiverVerified, true);
  f.state.readContext = null;
  rejects(() => f.confirm(minted));
  f.complete(minted);
});

check('cancellation during verification cannot return receiver confirmation, completion or status', () => {
  for (const operation of ['confirm', 'complete', 'status']) {
    for (const replacedOrigin of [false, true]) {
      const f = fixture(), minted = f.mint(); f.redeem(minted);
      if (operation === 'complete') f.confirm(minted);
      f.state.readContext = () => {
        if (replacedOrigin) f.state.context.backup.origin = OTHER_ORIGIN;
        assert.deepEqual(f.api.revoke(f.owner(minted)), { ok: true });
        f.state.context.backup.origin = ORIGIN;
        return f.state.context;
      };
      rejects(operation === 'status' ? () => f.api.status(f.owner(minted)) : () => f[operation](minted));
      f.state.readContext = null;
      rejects(() => f.confirm(minted));
      rejects(() => f.complete(minted));
      rejects(() => f.api.status(f.owner(minted)));
    }
  }
});

check('receipt entropy failure returns no token and permanently retires the consumed ticket', () => {
  for (const entropy of [() => { throw Error('synthetic receipt entropy failure'); }, () => null,
    () => Buffer.alloc(31), () => new Uint8Array(32)]) {
    const f = fixture(), minted = f.mint(); f.state.entropy = entropy;
    rejects(() => f.redeem(minted), UNAVAILABLE);
    f.state.entropy = null;
    rejects(() => f.redeem(minted));
    rejects(() => f.api.status(f.owner(minted)));
    for (let index = 0; index < MAX_PER_DEVICE; index++) f.mint();
    assert.equal(f.state.reissues.length, 0);
  }
});

check('time spent inside context validation cannot outlive receipt expiry or health freshness', () => {
  for (const operation of ['confirm', 'complete', 'status']) {
    const f = fixture(), minted = f.mint(); f.redeem(minted);
    if (operation === 'complete') f.confirm(minted);
    f.state.readContext = () => { f.state.time += TTL_MS; return f.state.context; };
    rejects(operation === 'status' ? () => f.api.status(f.owner(minted)) : () => f[operation](minted));
  }
  const f = fixture(), minted = f.mint(); f.redeem(minted);
  f.state.context.backup.checkedAt = f.state.time - FRESHNESS_MS + 1;
  f.state.readContext = () => { f.state.time += 2; return f.state.context; };
  rejects(() => f.confirm(minted), UNAVAILABLE);
});

console.log('\nBackup preparation: ' + passes + ' passed, ' + failures.length + ' failed.');
if (failures.length) process.exitCode = 1;
