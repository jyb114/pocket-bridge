// Bind the actual gateway sockets before publishing a port. In particular,
// Windows permits another process to bind a specific IPv4 address after a
// wildcard listener: a :: or 0.0.0.0 listener alone does not reserve the tunnel's
// 127.0.0.1 origin. Keep an exact loopback HTTP listener for that origin.
'use strict';

const http = require('http');

function failure(code) { return Object.assign(new Error(code), { code }); }

function listen(server, options) {
  return new Promise((resolve, reject) => {
    function cleanup() { server.removeListener('error', onError); server.removeListener('listening', onReady); }
    function onError(error) { cleanup(); reject(error); }
    function onReady() { cleanup(); resolve(); }
    server.once('error', onError); server.once('listening', onReady);
    try { server.listen({ ...options, exclusive: true }); } catch (error) { onError(error); }
  });
}

async function closeOwned(listeners, sockets, watchers) {
  // This is used only on startup rollback or explicit owned-listener close.
  // Upgraded sockets must not keep a failed candidate port alive.
  for (const socket of sockets) socket.destroy();
  await Promise.all(listeners.map(server => new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve()); server.closeAllConnections?.();
  })));
  for (const [server, watcher] of watchers) server.removeListener('connection', watcher);
}

function probeLoopback(port, expected, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    let settled = false, request;
    function finish(error, value) {
      if (settled) return; settled = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    }
    const deadline = setTimeout(() => {
      request?.destroy(); finish(failure('gateway-loopback-unverified'));
    }, timeoutMs);
    try {
      request = http.get({ host: '127.0.0.1', port, path: '/__health', agent: false }, response => {
        let bytes = 0, body = '';
        response.on('data', data => {
          bytes += data.length;
          if (bytes > 16384) { request.destroy(); finish(failure('gateway-loopback-unverified')); }
          else body += data.toString('utf8');
        });
        response.on('error', () => finish(failure('gateway-loopback-unverified')));
        response.on('aborted', () => finish(failure('gateway-loopback-unverified')));
        response.on('end', () => {
          try {
            const value = JSON.parse(body);
            if (response.statusCode !== 200 || value.service !== 'pocket-bridge-gateway' ||
                value.port !== port || value.pid !== expected.pid || value.bootId !== expected.bootId ||
                value.instanceId !== expected.instanceId) throw failure('gateway-loopback-unverified');
            finish(null, value);
          } catch (_) { finish(failure('gateway-loopback-unverified')); }
        });
      });
      request.on('error', () => finish(failure('gateway-loopback-unverified')));
    } catch (_) { finish(failure('gateway-loopback-unverified')); }
  });
}

async function bindGateway(options) {
  const { server, createSibling, preferred, identity, onPortBound } = options;
  const tries = options.tries === undefined ? 20 : options.tries;
  const platform = options.platform || process.platform;
  const lan = options.enableLan !== false;
  if (!server || typeof createSibling !== 'function' || !Number.isInteger(preferred) || preferred < 1 ||
      preferred > 65535 || !Number.isInteger(tries) || tries < 1 || tries > 100 ||
      !identity || !Number.isSafeInteger(identity.pid) || !identity.bootId || !identity.instanceId ||
      typeof onPortBound !== 'function') throw failure('invalid-gateway-listener-options');

  for (let offset = 0; offset < tries && preferred + offset <= 65535; offset++) {
    const port = preferred + offset, listeners = [], sockets = new Set(), watchers = [];
    const watch = candidate => {
      listeners.push(candidate);
      const watcher = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
      candidate.on('connection', watcher); watchers.push([candidate, watcher]);
      return candidate;
    };
    try {
      // On other platforms a wildcard socket reserves its specific addresses.
      // On Windows the exact loopback socket is required, and a second HTTP
      // server supplies LAN access with precisely the same request/upgrade code.
      await listen(watch(server), { port, host: platform === 'win32' || !lan ? '127.0.0.1' : '0.0.0.0' });
      if (platform === 'win32' && lan) await listen(watch(createSibling()), { port, host: '0.0.0.0' });
      let ipv6 = false;
      const v6 = watch(createSibling());
      try {
        await listen(v6, { port, host: lan ? '::' : '::1', ipv6Only: true });
        ipv6 = true;
      } catch (error) {
        // IPv6 being unavailable must not disable the exact IPv4 tunnel origin.
        // A foreign IPv6 listener means the candidate is occupied, however.
        if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT', 'ENODEV'].includes(error.code)) throw error;
      }
      await onPortBound(port);
      await probeLoopback(port, identity, options.probeTimeoutMs);
      for (const candidate of listeners) {
        candidate.on('error', error => options.onError?.(error));
      }
      let closed = false;
      return { port, ipv6, listeners,
        async close() { if (closed) return; closed = true; await closeOwned(listeners, sockets, watchers); }
      };
    } catch (error) {
      await closeOwned(listeners, sockets, watchers);
      // Retry the real listening operation, avoiding the old probe/close race.
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') continue;
      throw error;
    }
  }
  throw failure('gateway-port-unavailable');
}

module.exports = { bindGateway, probeLoopback };
