'use strict';

const { selectPreparationRoute } = require('./backup-preparation.js');

// Request plumbing is separate from the gateway so admission tests never start
// a listener, discover public egress, or read a real device/credential store.
function createBackupPreparationHttp({ preparation, readContext, receiverHtml, authCookies, now = Date.now }) {
  function requestOrigin(req) {
    const value = String(req.headers?.origin || '');
    try {
      const origin = new URL(value);
      if (origin.origin !== value || origin.username || origin.password ||
          !['https:', 'http:'].includes(origin.protocol) || origin.host !== req.headers.host) return '';
      if (origin.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(origin.hostname)) return '';
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return '';
      return value;
    } catch (_) { return ''; }
  }
  function reply(res, status, value, headers = {}) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...headers });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '') || !requestOrigin(req))
      throw Error('invalid-request');
    let raw = '', size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk); if (size > 4096) throw Error('invalid-request');
      raw += chunk.toString('utf8');
    }
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid-request');
    return value;
  }
  function landing(req, res, url) {
    try {
      const context = readContext();
      const source = url.searchParams.get('source') || '', nonce = url.searchParams.get('nonce') || '';
      const route = selectPreparationRoute(context, source, now());
      if (req.method !== 'GET' || new URL(route.origin).host !== req.headers.host ||
          !/^[a-f0-9]{48}$/.test(nonce)) throw Error('unavailable');
      const config = JSON.stringify({ origin: route.origin, source, nonce, bootId: context.bootId }).replace(/</g, '\\u003c');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
      res.end(receiverHtml().replace('__PB_PREPARATION_CONTEXT__', config));
    } catch (_) { reply(res, 409, { ok: false, code: 'backup-preparation-unavailable' }); }
  }
  async function redeem(req, res) {
    try {
      const input = await body(req);
      const value = preparation.redeem({ ticket: input.ticket, origin: requestOrigin(req), nonce: input.nonce, challenge: input.challenge });
      const { token, ...publicValue } = value;
      if (typeof token !== 'string' || !token) throw Error('reissue-failed');
      reply(res, 200, { ok: true, ...publicValue }, { 'set-cookie': authCookies(token).map(cookie => /;\s*Secure(?:;|$)/i.test(cookie) ? cookie : cookie + '; Secure') });
    } catch (_) { reply(res, 403, { ok: false, code: 'backup-preparation-rejected' }); }
  }
  async function protectedAction(req, res, device) {
    try {
      if (!req.__dshE2eeDecrypted || req.headers?.['x-dsh-e2ee'] !== '1' ||
          !device?.id || device.proven !== true) throw Error('unauthorized');
      const input = await body(req), deviceId = device.id, origin = requestOrigin(req);
      let value;
      if (input.action === 'issue') {
        value = preparation.mint({ deviceId, sourceOrigin: origin, origin: input.origin, generation: input.generation, nonce: input.nonce, challenge: input.challenge });
      } else if (input.action === 'confirm-receiver') {
        value = preparation.confirmReceiver({ preparationId: input.preparationId, deviceId, sourceOrigin: origin, receipt: input.receipt, nonce: input.nonce, challenge: input.challenge });
      } else if (input.action === 'complete') {
        if (input.origin !== origin) throw Error('wrong-origin');
        value = preparation.complete({ preparationId: input.preparationId, deviceId, origin, generation: input.generation, nonce: input.nonce, challenge: input.challenge });
      } else if (input.action === 'status') value = preparation.status({ preparationId: input.preparationId, deviceId, sourceOrigin: origin });
      else if (input.action === 'revoke') value = preparation.revoke({ preparationId: input.preparationId, deviceId, sourceOrigin: origin });
      else throw Error('invalid-action');
      reply(res, 200, { ok: true, ...value });
    } catch (_) { reply(res, 403, { ok: false, code: 'backup-preparation-rejected' }); }
  }
  return { landing, redeem, protectedAction };
}
module.exports = { createBackupPreparationHttp };
