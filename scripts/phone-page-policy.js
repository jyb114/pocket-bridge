'use strict';

// Browser hardening for the bridge-owned phone document. This mitigates script
// injection and unwanted outbound requests; it is not an independent trust
// anchor against a relay that can replace the document and its headers.
function socketSource(req) {
  const authority = String(req && req.headers && req.headers.host || '');
  if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(authority)) return null;
  try {
    const parsed = new URL('https://' + authority);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/') return null;
    const tls = !!(req && req.socket && req.socket.encrypted) ||
      String(req && req.headers && req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ||
      !!(req && req.headers && req.headers['cf-ray']);
    return (tls ? 'wss://' : 'ws://') + parsed.host;
  } catch (_) { return null; }
}

function headersFor(req) {
  const socket = socketSource(req);
  return {
    'content-security-policy': [
      "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'" + (socket ? ' ' + socket : ''),
      "img-src 'self' blob: data:", "font-src 'self'", "media-src 'self' blob:",
      "worker-src 'self'", "manifest-src 'self'", "object-src 'none'",
      "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)'
  };
}

module.exports = { headersFor, socketSource };
