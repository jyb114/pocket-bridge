// Shared Web Push delivery for events that happen outside mobile-proxy.js,
// notably a tunnel address replacement.  The browser push endpoint is reached
// directly from this computer; it does not depend on the old tunnel URL.
'use strict';

const fs = require('fs');
const path = require('path');
const { sendWebPush } = require('./webpush.js');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return fallback; }
}

async function sendStored(payload, options) {
  const opts = options || {};
  const base = opts.base || path.resolve(__dirname, '..');
  const logs = opts.logs || path.join(base, 'logs');
  const file = path.join(logs, 'push-subscriptions.json');
  const subscriptions = readJson(file, []);
  const vapid = readJson(path.join(logs, 'vapid.json'), null);
  const send = opts.send || sendWebPush;
  if (!Array.isArray(subscriptions) || !subscriptions.length) return { attempted: 0, delivered: 0, removed: 0, reason: 'no-subscriptions' };
  if (!vapid || !vapid.publicKey || !vapid.privateKey) return { attempted: 0, delivered: 0, removed: 0, reason: 'missing-vapid' };

  const survivors = [];
  let delivered = 0;
  let removed = 0;
  for (const subscription of subscriptions) {
    try {
      const result = await send(subscription, payload, vapid);
      if (result && result.ok) { delivered++; survivors.push(subscription); }
      else if (result && result.gone) removed++;
      else survivors.push(subscription); // transient failure: retain for a later retry
    } catch (err) {
      survivors.push(subscription);
    }
  }
  if (removed) fs.writeFileSync(file, JSON.stringify(survivors, null, 2), 'utf8');
  return { attempted: subscriptions.length, delivered, removed, reason: null };
}

module.exports = { sendStored };
