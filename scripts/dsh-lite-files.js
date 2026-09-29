'use strict';

// Single-directory, paged browser for files in the verified DSH Session's
// workspace. Paths and names are returned only inside the encrypted response.
const fs = require('node:fs');
const path = require('node:path');
const { workspaceRootFor } = require('./dsh-lite-download');

const MAX_REQUEST_BYTES = 8192;
const MAX_ENTRIES = 10000;
const PAGE_SIZE = 100;

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function relativeParts(value) {
  if (typeof value !== 'string' || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value) || value.startsWith('\\\\') ||
      value.startsWith('//') || /^[A-Za-z]:/.test(value)) return null;
  if (!value) return [];
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  return parts;
}

function within(root, target, paths) {
  const relative = paths.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + paths.sep) &&
    !paths.isAbsolute(relative));
}

async function readLimited(req) {
  const declared = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new Error('too-large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function createDshLiteFiles(options = {}) {
  const io = options.fs || fs;
  const paths = options.path || path;
  return async function handleDshLiteFiles(req, res) {
    function reply(status, body) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    }
    if (req.method !== 'POST') { reply(405, { error: 'method-not-allowed' }); return; }
    if (!req.__dshE2eeDecrypted || !req.headers || req.headers['x-dsh-e2ee'] !== '1') {
      reply(403, { error: 'encrypted-request-required' }); return;
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
      reply(415, { error: 'json-required' }); return;
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch (_) { reply(400, { error: 'invalid-files-request' }); return; }
    if ([...url.searchParams.keys()].length) { reply(400, { error: 'invalid-files-request' }); return; }
    let input;
    try { input = JSON.parse((await readLimited(req)).toString('utf8')); }
    catch (_) { reply(400, { error: 'invalid-files-request' }); return; }
    const parts = input && relativeParts(input.path);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 3 || !Object.hasOwn(input, 'sessionId') ||
        !Object.hasOwn(input, 'path') || !Object.hasOwn(input, 'offset') ||
        !validId(input.sessionId) || parts === null ||
        !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > MAX_ENTRIES) {
      reply(400, { error: 'invalid-files-request' }); return;
    }
    const root = workspaceRootFor(input.sessionId, options);
    if (!root) { reply(404, { error: 'session-workspace-unavailable' }); return; }
    let directory;
    try {
      directory = io.realpathSync(paths.join(root, ...parts));
      if (!within(root, directory, paths)) { reply(403, { error: 'outside-workspace' }); return; }
      if (!io.statSync(directory).isDirectory()) { reply(404, { error: 'directory-unavailable' }); return; }
    } catch (_) { reply(404, { error: 'directory-unavailable' }); return; }
    const entries = [];
    let handle;
    try {
      handle = io.opendirSync(directory);
      let child;
      let scanned = 0;
      while ((child = handle.readSync())) {
        if (++scanned > MAX_ENTRIES) { reply(413, { error: 'directory-too-large' }); return; }
        if (!child.name || child.name === '.' || child.name === '..' ||
            /[\\/:\u0000-\u001f\u007f]/.test(child.name)) continue;
        let target, stat;
        try {
          target = io.realpathSync(paths.join(directory, child.name));
          if (!within(root, target, paths)) continue;
          stat = io.statSync(target);
        } catch (_) { continue; }
        const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
        if (!type) continue;
        const entry = { name: child.name, path: [...parts, child.name].join('/'), type };
        if (type === 'file') entry.bytes = stat.size;
        entries.push(entry);
      }
    } catch (_) { reply(404, { error: 'directory-unavailable' }); return; }
    finally { if (handle) { try { handle.closeSync(); } catch (_) {} } }
    entries.sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) :
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const offset = input.offset;
    reply(200, { path: parts.join('/'), entries: entries.slice(offset, offset + PAGE_SIZE),
      nextOffset: offset + PAGE_SIZE < entries.length ? offset + PAGE_SIZE : null });
  };
}

module.exports = { createDshLiteFiles, PAGE_SIZE };
