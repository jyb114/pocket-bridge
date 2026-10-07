import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import controllerModule from '../scripts/dsh-plugin-controller.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createBridgeController } = controllerModule;

// Optional injection keeps non-Web and native IPC-only profiles operable.
export const inject = [];
export const Config = z.object({
  bridgeDirectory: z.string().default('').description(
    'Optional existing Pocket Bridge installation directory, for example D:\\Pocket Bridge. '
    + 'Leave empty to keep the gateway under DSH_HOME/pocket-bridge/gateway, outside the installed plugin. '
    + 'Only this selected directory is used; '
    + 'the plugin does not scan personal folders or change system settings.'),
});

const ROUTES = Object.freeze([
  Object.freeze({ path: '/pocket-bridge/status', method: 'GET', operation: 'status' }),
  Object.freeze({ path: '/pocket-bridge/connection', method: 'POST', operation: 'connection' }),
  Object.freeze({ path: '/pocket-bridge/diagnostics', method: 'POST', operation: 'diagnostics' }),
  Object.freeze({ path: '/pocket-bridge/action', method: 'POST', operation: 'action' }),
]);
const MAX_BODY_BYTES = 2048;
const MAX_RESPONSE_BYTES = 256 * 1024;
const OWN_BODY_ERROR = Symbol('pocket-bridge-body-validation');

function isDirectLocalRequest(req, port, connection, controlToken) {
  const remote = String(req.socket?.remoteAddress || '').toLowerCase();
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return false;
  const headers = req.headers || {};
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'forwarded' || lower.startsWith('x-forwarded-') || lower.startsWith('cf-')
      || ['x-real-ip', 'true-client-ip', 'via', 'x-original-host'].includes(lower)) return false;
  }
  if (typeof headers.host !== 'string' || !/^(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/i.test(headers.host)) return false;
  const host = headers.host.toLowerCase();
  if (Number(host.slice(host.lastIndexOf(':') + 1)) !== port) return false;
  const origin = headers.origin;
  // The native dsh-app://app carrier strips Origin before forwarding with its
  // authority-bound DSH cookie. A private capability returned only by an
  // authenticated direct status read covers that carrier's missing marker.
  // An attached Origin must always match, even if a capability is supplied.
  if (origin !== undefined && origin !== `http://${host}`) return false;
  if (req.method === 'POST' && origin === undefined) {
    const supplied = headers['x-pocket-bridge-control-token'];
    if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied, 'ascii'), controlToken)) return false;
  }
  try {
    return typeof connection?.requestRejection === 'function'
      && connection.requestRejection(req) === undefined;
  } catch (_) { return false; }
}

function bodyError(status, code) {
  return Object.assign(new Error(code), { status, code, [OWN_BODY_ERROR]: true });
}

function readBody(req, signal) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd);
      req.off('error', onError); req.off('aborted', onAborted);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        finish(bodyError(413, 'body-too-large'));
        req.resume();
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
        finish(null, value);
      } catch (_) { finish(bodyError(400, 'invalid-json-object')); }
    };
    const onError = () => finish(bodyError(400, 'unreadable-request'));
    const onAborted = () => finish(bodyError(400, 'request-closed'));
    const onAbort = () => { finish(bodyError(408, 'request-closed')); req.resume(); };
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^[0-9]+$/.test(String(length)) || Number(length) > MAX_BODY_BYTES)) {
      finish(bodyError(413, 'body-too-large')); req.resume(); return;
    }
    if (signal.aborted || req.destroyed || req.aborted) { onAbort(); return; }
    req.on('data', onData); req.on('end', onEnd);
    req.on('error', onError); req.on('aborted', onAborted);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function validatedAction(body) {
  if (!Object.hasOwn(body, 'action') || !['start', 'stop'].includes(body.action)) return null;
  if (Object.keys(body).some(key => !['action', 'expectedBootId', 'expectedInstanceId'].includes(key))) return null;
  for (const field of ['expectedBootId', 'expectedInstanceId']) {
    if (Object.hasOwn(body, field) && (typeof body[field] !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(body[field]))) return null;
  }
  if (body.action === 'stop' && (!body.expectedBootId || !body.expectedInstanceId)) return null;
  return { action: body.action,
    ...(Object.hasOwn(body, 'expectedBootId') ? { expectedBootId: body.expectedBootId } : {}),
    ...(Object.hasOwn(body, 'expectedInstanceId') ? { expectedInstanceId: body.expectedInstanceId } : {}) };
}

/** Exact local HTTP routes; no generic forwarding, CORS, IPC or shell channel. */
export function createBridgeHostAdapter({ controller, connection, port, requestTimeoutMs = 20000 }) {
  let disposed = false;
  const active = new Set();
  // Per-host memory only; never a URL, QR code, log, cookie or persisted setting.
  const controlToken = Buffer.from(randomBytes(32).toString('base64url'), 'ascii');
  const handlers = ROUTES.map(route => ({ kind: 'exact', path: route.path,
    handler: async (req, res) => {
      let settled = false;
      const cancel = new AbortController();
      let timer;
      const cleanup = () => {
        clearTimeout(timer); active.delete(state);
        req.off('aborted', closed); res.off('close', closed);
      };
      const reply = (status, value, extraHeaders = {}) => {
        if (settled) return false;
        settled = true; cleanup(); cancel.abort();
        if (res.destroyed || res.writableEnded || res.headersSent) return false;
        let bytes;
        try {
          bytes = Buffer.from(JSON.stringify(value));
          if (bytes.length > MAX_RESPONSE_BYTES) throw Error();
        } catch (_) {
          status = 502;
          bytes = Buffer.from('{"ok":false,"code":"invalid-controller-response"}');
        }
        try {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
          res.end(bytes);
        } catch (_) { /* A closed socket is never retried or written twice. */ }
        return true;
      };
      const closed = () => {
        if (settled) return;
        settled = true; cleanup(); cancel.abort();
      };
      const state = { close: () => reply(503, { ok: false, code: 'plugin-unloaded' }) };
      if (disposed) { reply(503, { ok: false, code: 'plugin-unloaded' }); return; }
      active.add(state);
      req.on('aborted', closed); res.on('close', closed);
      // One budget covers admission, body transfer and the controller operation.
      timer = setTimeout(() => reply(504, { ok: false, code: 'request-timeout' }), requestTimeoutMs);
      timer.unref?.();
      if (!isDirectLocalRequest(req, port, connection, controlToken)) {
        reply(403, { ok: false, code: 'local-authenticated-request-required' }); return;
      }
      if (req.method !== route.method) {
        reply(405, { ok: false, code: 'method-not-allowed' }, { allow: route.method }); return;
      }
      try {
        let args;
        if (route.method === 'POST') {
          const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
          if (type !== 'application/json') { reply(415, { ok: false, code: 'json-content-type-required' }); return; }
          const body = await readBody(req, cancel.signal);
          if (settled || disposed) return;
          if (route.operation === 'action') {
            args = validatedAction(body);
            if (!args) { reply(400, { ok: false, code: 'invalid-action' }); return; }
          } else if (Object.keys(body).length) {
            reply(400, { ok: false, code: 'unexpected-parameters' }); return;
          }
        }
        if (settled || disposed) return;
        const value = route.operation === 'action'
          ? await controller.action(args) : await controller[route.operation]();
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          reply(502, { ok: false, code: 'invalid-controller-response' }); return;
        }
        const statusBusinessResult = route.operation === 'status' && (value.ok === true
          || value.ok === false && ['unconfigured', 'unavailable'].includes(value.state));
        reply(200, statusBusinessResult ? { ...value, controlToken: controlToken.toString('ascii') } : value);
      } catch (error) {
        // Only adapter-owned validation codes may leave this process.
        const own = error?.[OWN_BODY_ERROR] === true;
        reply(own ? error.status : 503, { ok: false, code: own ? error.code : 'bridge-unavailable' });
      }
    } }));
  return { routes: handlers, dispose() {
    if (disposed) return;
    disposed = true;
    controlToken.fill(0);
    for (const state of [...active]) state.close();
    try { Promise.resolve(controller.dispose()).catch(() => {}); } catch (_) { /* No raw controller error is exposed. */ }
  } };
}

/** Mount only while authenticated HTTP services exist; missing services are safe. */
export function apply(ctx, config = {}) {
  ctx.inject(['webServer', 'connection'], child => {
    child.effect(() => {
      const adapter = createBridgeHostAdapter({
        controller: createBridgeController({ bridgeDirectory: config.bridgeDirectory || dshHomePath('pocket-bridge', 'gateway'),
          sourceDirectory: ROOT, managed: !config.bridgeDirectory,
          hostRuntime: { port: child.webServer.port, host: child.webServer.host,
            profile: child.get('profileContext')?.name || 'web' } }),
        connection: child.connection,
        port: child.webServer.port,
      });
      const unregister = [];
      try {
        for (const route of adapter.routes) unregister.push(child.webServer.register(route));
      } catch (error) {
        for (const release of unregister.reverse()) { try { release(); } catch (_) {} }
        adapter.dispose(); throw error;
      }
      return () => {
        for (const release of unregister.reverse()) { try { release(); } catch (_) {} }
        adapter.dispose();
      };
    }, 'pocket-bridge: authenticated local HTTP routes');
  });
}
