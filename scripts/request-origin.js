// Classify the HTTP authority independently of the socket peer. A tunnel or
// local reverse proxy connects to the gateway over loopback, so the peer alone
// cannot establish that a request came from this computer.
'use strict';

const os = require('os');

function authorityName(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 1 ? host.slice(1, end) : '';
  }
  return host.split(':')[0];
}

function isLocalHost(req) {
  const name = authorityName(req && req.headers && req.headers.host);
  if (!name) return false;
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1') return true;

  try {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const entry of addresses || []) {
        if (entry && String(entry.address).toLowerCase() === name) return true;
      }
    }
  } catch (err) { /* An unknown authority is never trusted as local. */ }
  return false;
}

function viaRelay(req) {
  const headers = (req && req.headers) || {};
  if (headers['cf-connecting-ip'] || headers['cf-ray'] || headers['cf-worker']) return true;
  // These forwarding headers may be spoofed by a direct client, but can only
  // make the request subject to stricter checks, never relax them. They also
  // cover proxies that preserve the public authority only in a forwarded header.
  if (headers['x-forwarded-for'] || headers['x-forwarded-host'] || headers['forwarded']) return true;
  return !isLocalHost(req);
}

function isLoopback(req) {
  const remote = String((req && req.socket && req.socket.remoteAddress) || '');
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return local && !viaRelay(req);
}

module.exports = { authorityName, isLocalHost, viaRelay, isLoopback };
