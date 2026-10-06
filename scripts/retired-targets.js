'use strict';

// Fixed, content-free replies for old bookmarks and cached clients. This module
// never loads a retired adapter, reads its data or changes authentication.
const BODY = JSON.stringify({ ok: false, code: 'target-retired', supportedTargets: ['dsh'],
  message: 'This release supports DeepSeek Harness only. Existing local data is retained.' });
function isRetiredTarget(value) { return typeof value === 'string' && /^(codex|dot)$/i.test(value); }
function isRetiredRequest(url) {
  let parsed;
  try { parsed = new URL(String(url || ''), 'http://localhost'); } catch (_) { return false; }
  let pathname = parsed.pathname;
  try { pathname = decodeURIComponent(pathname); } catch (_) { /* No retired route accepts malformed escapes. */ }
  return /^\/(?:codex|dot)(?:\/|\.html$|$)/i.test(pathname) || /^\/dot-guide(?:\.html)?\/?$/i.test(pathname) ||
    /^\/__codex(?:\/|$)/i.test(pathname) || isRetiredTarget(parsed.searchParams.get('target'));
}
function replyHttp(req, res) {
  res.writeHead(410, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(BODY) });
  res.end(req.method === 'HEAD' ? undefined : BODY);
}
function replyUpgrade(socket) {
  socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\nCache-Control: no-store\r\n' +
    'Content-Type: application/json; charset=utf-8\r\nContent-Length: ' + Buffer.byteLength(BODY) + '\r\n\r\n' + BODY);
}
module.exports = { isRetiredTarget, isRetiredRequest, replyHttp, replyUpgrade };
