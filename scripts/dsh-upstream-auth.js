'use strict';

// Upstream DSH authentication is separate from the phone's gateway identity.
// No credentials are modified, no user token is printed, and no RPC is sent.
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { fingerprintDshHttp, validPort } = require('./dsh-adapter');

const CACHE_MS = 5000;
const MAX_CANDIDATES = 8;
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DSH_HTTP_EVIDENCE = new Set(['dsh-auth-challenge', 'dsh-app-html']);

function browserSessionSecret(text) {
  // Same persisted grant and signing algorithm as mint-cookie.js. Scope the
  // lookup to the grant block, so another credential record cannot supply it.
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i].match(/^([ \t]*)(?:["']?client-connection\/browser-session["']?):\s*(?:#.*)?$/);
    if (!entry) continue;
    const indent = entry[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const leading = line.match(/^[ \t]*/)[0].length;
      if (leading <= indent) break;
      const found = line.match(/^\s+secret:\s*["']?([A-Za-z0-9_-]{43}=?)['"]?\s*(?:#.*)?$/);
      if (!found) continue;
      const encoded = found[1].replace(/=$/, '');
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length === 32 && bytes.toString('base64url') === encoded) return bytes;
    }
  }
  return null;
}

function mintBrowserCookie(authority, secret, issuedAt) {
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt,
    expiresAt: issuedAt + MAX_AGE_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return { name: 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url'),
    value: `v1.${body}.${signature}` };
}

function validAuthority(authority) {
  const found = String(authority || '').match(/^(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/);
  return Boolean(found && validPort(Number(found[1])));
}

function createUpstreamAuth(options = {}) {
  if (!validAuthority(options.authority)) throw new Error('A fixed loopback DSH authority is required.');
  const authority = options.authority;
  const io = options.fs || fs;
  const transport = options.http || http;
  const request = typeof transport === 'function' ? transport : transport.request.bind(transport);
  const now = options.now || Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(10, Math.min(1000, options.timeoutMs)) : 1000;
  const getCandidates = typeof options.credentialCandidates === 'function' ? options.credentialCandidates :
    Array.isArray(options.credentialCandidates) ? () => options.credentialCandidates :
      () => require('./first-run').credentialCandidates();
  let cached = null, pending = null, generation = 0;

  function snapshot() {
    let candidates;
    try { candidates = getCandidates(); } catch (_) { candidates = []; }
    const paths = Array.isArray(candidates) ? [...new Set(candidates.filter(p => typeof p === 'string' && p))].slice(0, MAX_CANDIDATES) : [];
    return paths.map(file => {
      try {
        const stat = io.statSync(file);
        const isFile = typeof stat.isFile !== 'function' || stat.isFile();
        const readable = isFile && Number.isSafeInteger(stat.size) && stat.size > 0 && stat.size <= MAX_CREDENTIAL_BYTES;
        return { file, readable, stamp: [stat.size, stat.mtimeMs || 0, stat.ctimeMs || 0, String(stat.ino || '')] };
      } catch (_) { return { file, readable: false, stamp: ['missing'] }; }
    });
  }

  function verifyCookie(port, cookie) {
    return new Promise(resolve => {
      let req, settled = false;
      const done = ok => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(ok);
      };
      const deadline = setTimeout(() => { done(false); if (req) req.destroy(); }, timeoutMs);
      try {
        req = request({ hostname: '127.0.0.1', port, path: '/', method: 'GET', agent: false,
          timeout: timeoutMs, headers: { Host: authority, Cookie: `${cookie.name}=${cookie.value}`,
            Accept: 'text/html', 'Accept-Encoding': 'identity' } }, res => {
          // Redirects and API-shaped responses never verify a browser grant.
          if (res.statusCode !== 200 || !String((res.headers || {})['content-type'] || '').toLowerCase().includes('text/html')) {
            done(false);
            if (typeof res.destroy === 'function') res.destroy();
            if (req) req.destroy();
            return;
          }
          let size = 0; const chunks = [];
          res.on('data', chunk => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_BODY_BYTES) {
              done(false); if (req) req.destroy(); if (typeof res.destroy === 'function') res.destroy(); return;
            }
            chunks.push(bytes);
          });
          res.on('end', () => done(fingerprintDshHttp({ statusCode: res.statusCode, headers: res.headers,
            body: Buffer.concat(chunks) }).evidence === 'dsh-app-html'));
          res.on('error', () => done(false));
          res.on('aborted', () => done(false));
          res.on('close', () => { if (!res.complete) done(false); });
        });
        req.on('error', () => done(false));
        req.on('timeout', () => { done(false); req.destroy(); });
        req.end();
      } catch (_) { done(false); if (req) req.destroy(); }
    });
  }

  async function attempt(runtime, files) {
    let usable = false;
    for (const entry of files) {
      if (!entry.readable) continue;
      let secret = null;
      try {
        const text = io.readFileSync(entry.file, 'utf8');
        if (Buffer.byteLength(text) > MAX_CREDENTIAL_BYTES) continue;
        secret = browserSessionSecret(text);
      } catch (_) { continue; }
      if (!secret) continue;
      usable = true;
      const cookie = mintBrowserCookie(authority, secret, now());
      if (await verifyCookie(runtime.port, cookie)) return { ok: true, cookie };
    }
    return { ok: false, reason: usable ? 'DSH browser authentication could not be verified.' : 'DSH browser-session grant is unavailable.' };
  }

  async function resolve(runtime, settings = {}) {
    if (!runtime || !runtime.running || !validPort(runtime.port) || !DSH_HTTP_EVIDENCE.has(runtime.httpEvidence)) {
      generation++; cached = null; pending = null;
      return { ok: false, reason: 'DSH HTTP runtime has not been verified.' };
    }
    // Authenticated modern evidence cannot be downgraded by a stale legacy label.
    if (runtime.profile === 'legacy-events' && runtime.httpEvidence === 'dsh-app-html' &&
        (!runtime.capabilities || runtime.capabilities.browserAuth !== true)) {
      generation++; cached = null; pending = null;
      return { ok: true, cookie: null };
    }
    const files = snapshot();
    const key = JSON.stringify([authority, runtime.port, runtime.pid || null, runtime.profile || null,
      files.map(entry => [entry.file, entry.readable, entry.stamp])]);
    if (!settings.force && cached && cached.key === key && now() - cached.at < CACHE_MS) return cached.value;
    if (!settings.force && pending && pending.key === key) return pending.work;
    const started = ++generation;
    cached = null;
    const work = attempt(runtime, files).then(value => {
      if (generation === started && pending && pending.work === work) cached = { key, at: now(), value };
      return value;
    }).finally(() => { if (pending && pending.work === work) pending = null; });
    pending = { key, work };
    return work;
  }
  return { resolve };
}

module.exports = { createUpstreamAuth };
