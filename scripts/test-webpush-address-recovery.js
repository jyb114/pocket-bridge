'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sendStored } = require('./webpush-notify.js');

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-push-'));
  const logs = path.join(base, 'logs'); fs.mkdirSync(logs);
  const good = { endpoint: 'https://push.example/good', keys: { p256dh: 'a', auth: 'b' } };
  const stale = { endpoint: 'https://push.example/stale', keys: { p256dh: 'c', auth: 'd' } };
  fs.writeFileSync(path.join(logs, 'push-subscriptions.json'), JSON.stringify([good, stale]));
  fs.writeFileSync(path.join(logs, 'vapid.json'), JSON.stringify({ publicKey: 'public', privateKey: 'private' }));
  const payload = { title: 'Address updated', body: 'Open the new one-time recovery link.', url: 'https://new.example/recover', forceOpen: true, tag: 'dsh-address-change' };
  const r = await sendStored(payload, { base, send: async (sub, got) => {
    assert.deepEqual(got, payload);
    return sub.endpoint.endsWith('/stale') ? { ok: false, gone: true } : { ok: true, gone: false };
  } });
  assert.deepEqual(r, { attempted: 2, delivered: 1, removed: 1, reason: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(logs, 'push-subscriptions.json'), 'utf8')), [good]);
  assert.deepEqual(await sendStored(payload, { base: path.join(base, 'empty') }), { attempted: 0, delivered: 0, removed: 0, reason: 'no-subscriptions' });
  fs.rmSync(base, { recursive: true, force: true });
  console.log('PASS: address recovery Web Push is delivered directly and stale subscriptions are removed.');
})().catch((err) => { console.error(err); process.exitCode = 1; });
