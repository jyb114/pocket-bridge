'use strict';

// A phone uses only bridge-owned, encrypted Lite content channels. Unknown
// upstream HTTP routes are never a compatibility fallback: their responses
// may contain prompts, history or files that the upstream does not encrypt.
const BODY = JSON.stringify({ ok: false, code: 'dsh-classic-retired',
  supportedInterface: 'lite', openPath: '/dsh-lite',
  message: 'The original DSH interface is available on the computer only. Open the encrypted phone interface.' });

function isRemoteMux(url) {
  // Admit only an origin-form, exact path. Encoded, relative, absolute and
  // trailing-slash aliases are deliberately unsupported, never forwarded.
  if (typeof url !== 'string' || !/^\/api\/remote\.mux(?:\?|$)/.test(url)) return false;
  try { return new URL(url, 'http://localhost').pathname === '/api/remote.mux'; }
  catch (_) { return false; }
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
module.exports = { isRemoteMux, replyHttp, replyUpgrade };
