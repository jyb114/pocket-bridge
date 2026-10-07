'use strict';

// An additional, optional ingress restriction. Admission here is NEVER device
// authentication or proof of a Tailscale process: existing app gates still run.
const { normalizePrivateOrigin } = require('./tailscale-private-https.js');
const MARK = Symbol('private-https-remote-only');
const HEADER_LIMIT = 1024;
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
const MANAGEMENT = Object.freeze(['/console', '/console.html', '/__console', '/__health', '/__notify', '/__recover', '/__gateway-action', '/__private-https']);

function hasTailnetText(value) {
  return (Array.isArray(value) ? value : [value]).some(part => typeof part === 'string' && /\.ts\.net(?:[.:/\s,?#]|$)/i.test(part));
}

function uniqueHeader(req, name) {
  const value = req.headers && req.headers[name];
  if (value !== undefined && (typeof value !== 'string' || value.length > HEADER_LIMIT || /[\r\n\0]/.test(value))) return { valid: false, value: null };
  const raw = req.rawHeaders;
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length % 2 !== 0) return { valid: false, value: null };
    let count = 0;
    let rawValue = null;
    for (let index = 0; index < raw.length; index += 2) {
      if (typeof raw[index] !== 'string' || typeof raw[index + 1] !== 'string') return { valid: false, value: null };
      if (raw[index].toLowerCase() === name) { count++; rawValue = raw[index + 1]; }
    }
    if (count > 1 || (value === undefined ? count !== 0 : count !== 1 || rawValue !== value)) return { valid: false, value: null };
  }
  return { valid: true, value: value === undefined ? null : value };
}

function canonicalAuthority(value) {
  if (typeof value !== 'string') return null;
  const origin = normalizePrivateOrigin('https://' + value);
  return origin ? origin.origin : null;
}

function loopback(req) {
  const address = req.socket && req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address === '::1';
}

function requestPath(req) {
  if (typeof req.url !== 'string' || req.url.length > 8192 || !req.url.startsWith('/') || req.url.startsWith('//') || /[\r\n\0\\]/.test(req.url)) return null;
  try {
    let value = new URL(req.url, 'http://127.0.0.1').pathname;
    // Refuse encoded management aliases too, without normalizing the request
    // handed to the existing router or allowing an arbitrary proxy target.
    for (let index = 0; index < 3 && value.includes('%'); index++) {
      const next = decodeURIComponent(value);
      if (next === value) break;
      value = next;
    }
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('%') || /[\r\n\0\\]/.test(value)) return null;
    return new URL(value, 'http://127.0.0.1').pathname;
  } catch (_) { return null; }
}

function managementPath(value) {
  const p = value.toLowerCase();
  return MANAGEMENT.some(prefix => p === prefix || p.startsWith(prefix + '/'));
}

function evaluateRequest(req, config = {}, options = {}) {
  const headers = (req && req.headers) || {};
  const applies = hasTailnetText(headers.host) || hasTailnetText(headers['x-forwarded-host']) || hasTailnetText(headers.origin) || own(headers, 'tailscale-funnel-request');
  const result = { applies, allowed: !applies, forceRemote: applies, status: applies ? 403 : null, code: applies ? 'private-https-refused' : 'not-private-https' };
  if (!applies) return Object.freeze(result);
  const refuse = code => Object.freeze({ ...result, allowed: false, code });
  if (own(headers, 'tailscale-funnel-request')) return refuse('private-https-funnel-refused');
  if (!config || config.enabled !== true) return refuse('private-https-disabled');
  const expected = normalizePrivateOrigin(config.origin);
  if (!expected) return refuse('private-https-invalid-config');
  const host = uniqueHeader(req, 'host');
  const forwardedHost = uniqueHeader(req, 'x-forwarded-host');
  const forwardedProto = uniqueHeader(req, 'x-forwarded-proto');
  const origin = uniqueHeader(req, 'origin');
  if (![host, forwardedHost, forwardedProto, origin].every(header => header.valid)) return refuse('private-https-malformed-request');
  if (canonicalAuthority(host.value) !== expected.origin) return refuse('private-https-host-mismatch');
  // Metadata is only a narrowing constraint, not an authentication assertion.
  if (!loopback(req) || canonicalAuthority(forwardedHost.value) !== expected.origin || forwardedProto.value !== 'https') return refuse('private-https-proxy-mismatch');
  const method = typeof req.method === 'string' ? req.method : '';
  if (!/^[A-Z]+$/.test(method)) return refuse('private-https-malformed-request');
  if ((origin.value !== null && origin.value !== expected.origin) || (origin.value === null && (options.upgrade === true || (method !== 'GET' && method !== 'HEAD')))) return refuse('private-https-origin-mismatch');
  const pathname = requestPath(req);
  if (!pathname) return refuse('private-https-malformed-request');
  if (managementPath(pathname)) return refuse('private-https-management-refused');
  return Object.freeze({ ...result, allowed: true, forceRemote: true, status: null, code: 'private-https-admitted' });
}

function isForceRemote(req) {
  return !!(req && req[MARK] === true);
}

function markRemote(req, decision) {
  if (decision.applies) Object.defineProperty(req, MARK, { value: true, configurable: false, enumerable: false });
}

function inheritRemote(from, to) {
  // Decryption creates an in-process Readable shim. Copy only the stricter
  // remote classification; this never creates authentication or local trust.
  if (isForceRemote(from)) Object.defineProperty(to, MARK, { value: true, configurable: false, enumerable: false });
}

function enforceHttp(req, res, config) {
  const decision = evaluateRequest(req, config);
  markRemote(req, decision);
  if (decision.allowed) return false;
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify({ ok: false, code: decision.code, message: 'This private HTTPS request is not permitted. Check the computer connection settings.' }));
  return true;
}

function enforceUpgrade(req, socket, config) {
  const decision = evaluateRequest(req, config, { upgrade: true });
  markRemote(req, decision);
  if (decision.allowed) return false;
  // No upgrade, upstream connection, raw request or private data on refusal.
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n');
  return true;
}

module.exports = { evaluateRequest, enforceHttp, enforceUpgrade, isForceRemote, inheritRemote };
