'use strict';

// Workspace-only download for the small mobile DSH client. DSH's official
// workspaceFiles/readBytes Remote deliberately accepts paths outside a
// workspace, so never expose it as a generic phone file proxy. This route
// independently binds a Session to a DSH-owned workspace record, resolves
// symlinks/junctions, then serves only files below that canonical root.
const fs = require('node:fs');
const path = require('node:path');
const { dshHomeCandidates } = require('./first-run');

const MAX_REQUEST_BYTES = 8192;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function validFilePath(value, paths) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('\\\\') || value.startsWith('//')) return false;
  const components = value.split(/[\\/]/);
  if (components.includes('..') || components.includes('.')) return false;
  // Reject Windows alternate data streams, including paths that use forward
  // slashes; the only allowed colon is an absolute drive's second character.
  const rest = paths.isAbsolute(value) && /^[A-Za-z]:/.test(value) ? value.slice(2) : value;
  return !rest.includes(':');
}

function inside(root, target, paths) {
  const relative = paths.relative(root, target);
  return relative !== '' && relative !== '..' &&
    !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative);
}

async function readLimited(req) {
  const declared = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error('too-large');
  const chunks = [];
  let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > MAX_REQUEST_BYTES) throw new Error('too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, count);
}

function workspaceRootFor(sessionId, options) {
  const io = options.fs || fs;
  const paths = options.path || path;
  const homes = options.homes || dshHomeCandidates();
  const roots = new Set();
  for (const home of homes) {
    try {
      const file = paths.join(home, 'storages', 'workspace.json');
      const stat = io.statSync(file);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) continue;
      const store = JSON.parse(io.readFileSync(file, 'utf8'));
      const workspaces = store && store.tables && store.tables.workspaces;
      if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) continue;
      for (const workspace of Object.values(workspaces)) {
        if (!workspace || !Array.isArray(workspace.sessionIds) ||
            !workspace.sessionIds.includes(sessionId) ||
            typeof workspace.path !== 'string' || !paths.isAbsolute(workspace.path)) continue;
        roots.add(io.realpathSync(workspace.path));
      }
    } catch (_) { /* Unsupported/old DSH storage fails closed. */ }
  }
  return roots.size === 1 ? [...roots][0] : null;
}

function createDshLiteDownload(options = {}) {
  const io = options.fs || fs;
  const paths = options.path || path;
  return async function handleDshLiteDownload(req, res) {
    function reply(status, value) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    }
    if (req.method !== 'POST') { reply(405, { error: 'method-not-allowed' }); return; }
    if (!req.__dshE2eeDecrypted || !req.headers || req.headers['x-dsh-e2ee'] !== '1') {
      reply(403, { error: 'encrypted-request-required' }); return;
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
      reply(415, { error: 'json-required' }); return;
    }
    let params;
    try { params = new URL(req.url, 'http://localhost').searchParams; }
    catch (_) { reply(400, { error: 'invalid-download-request' }); return; }
    if ([...params.keys()].length) { reply(400, { error: 'invalid-download-request' }); return; }
    let input;
    try { input = JSON.parse((await readLimited(req)).toString('utf8')); }
    catch (_) { reply(400, { error: 'invalid-download-request' }); return; }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 2 || !Object.hasOwn(input, 'sessionId') ||
        !Object.hasOwn(input, 'path') || !validId(input.sessionId) ||
        !validFilePath(input.path, paths)) {
      reply(400, { error: 'invalid-download-request' }); return;
    }
    const root = workspaceRootFor(input.sessionId, options);
    if (!root) { reply(404, { error: 'session-workspace-unavailable' }); return; }
    let file;
    try {
      const candidate = paths.resolve(root, input.path);
      // Real paths prevent `link/secret` and Windows junction escapes.
      file = io.realpathSync(candidate);
      if (!inside(root, file, paths)) { reply(403, { error: 'outside-workspace' }); return; }
      const stat = io.statSync(file);
      if (!stat.isFile()) { reply(404, { error: 'file-unavailable' }); return; }
      if (stat.size > MAX_FILE_BYTES) { reply(413, { error: 'file-too-large' }); return; }
      const body = io.readFileSync(file);
      if (!Buffer.isBuffer(body) || body.length > MAX_FILE_BYTES || body.length !== stat.size) {
        reply(502, { error: 'file-changed' }); return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    } catch (_) { reply(404, { error: 'file-unavailable' }); }
  };
}

module.exports = { createDshLiteDownload, workspaceRootFor, MAX_FILE_BYTES };
