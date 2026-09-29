// Read-only computer directories for the phone picker. Route authentication,
// device proof and application encryption are supplied by mobile-proxy.js.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function createDirectoryService(options = {}) {
  const io = options.fs || fs.promises;
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path;
  const defaultPath = options.defaultPath || process.cwd();
  const maxEntries = options.maxEntries || 2000;
  async function list(input = {}) {
    if (input.path !== undefined && typeof input.path !== 'string') throw Object.assign(new Error('invalid-path'), { code: 'invalid-path' });
    const raw = input.path === undefined ? defaultPath : input.path;
    if (!raw || raw.length > 4096 || raw.includes('\0') || !paths.isAbsolute(raw) ||
        (platform === 'win32' && (/^[\\/]{2}/.test(raw) || !/^[A-Za-z]:[\\/]/.test(raw)))) {
      throw Object.assign(new Error('absolute-local-path-required'), { code: 'invalid-path' });
    }
    const selected = paths.resolve(raw);
    const stat = await io.stat(selected);
    if (!stat.isDirectory()) throw Object.assign(new Error('not-a-directory'), { code: 'not-a-directory' });
    const entries = await io.readdir(selected, { withFileTypes: true });
    const directories = entries.filter(e => e.isDirectory()).map(e => ({ name: e.name, path: paths.join(selected, e.name) }));
    // Junctions and symlinks remain useful computer folders; unreadable links are
    // omitted. No files are read and no directories are created.
    const links = entries.filter(e => e.isSymbolicLink());
    for (let i = 0; i < links.length; i += 16) {
      const inspected = await Promise.all(links.slice(i, i + 16).map(async e => {
        const target = paths.join(selected, e.name);
        try { return (await io.stat(target)).isDirectory() ? { name: e.name, path: target } : null; }
        catch (_) { return null; }
      }));
      directories.push(...inspected.filter(Boolean));
    }
    directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const rootCandidates = platform === 'win32'
      ? [...new Set([paths.parse(selected).root, paths.parse(defaultPath).root,
          paths.parse(options.homePath || os.homedir()).root, 'C:\\', 'D:\\'].filter(Boolean).map(root => paths.normalize(root)))]
      : ['/'];
    const roots = (await Promise.all(rootCandidates.map(async root => {
      try { return (await io.stat(root)).isDirectory() ? { name: root, path: root } : null; }
      catch (_) { return null; }
    }))).filter(Boolean);
    const parent = paths.dirname(selected);
    return { ok: true, path: selected, parent: parent === selected ? null : parent,
      roots, directories: directories.slice(0, maxEntries), truncated: directories.length > maxEntries };
  }
  function handle(req, res) {
    const reply = (status, value) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST') { reply(405, { ok: false, error: 'method-not-allowed' }); return; }
    const chunks = []; let size = 0, finished = false;
    req.on('data', chunk => {
      if (finished) return;
      const buf = Buffer.from(chunk); size += buf.length;
      if (size > 8192) { finished = true; reply(413, { ok: false, error: 'request-too-large' }); return; }
      chunks.push(buf);
    });
    req.on('error', () => { if (!finished) { finished = true; reply(400, { ok: false, error: 'invalid-request' }); } });
    req.on('end', async () => {
      if (finished) return; finished = true;
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      } catch (_) { reply(400, { ok: false, error: 'invalid-json' }); return; }
      try { reply(200, await list(input)); }
      catch (error) {
        const code = String(error.code || 'directory-unavailable');
        reply(code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 400, { ok: false, error: code });
      }
    });
  }
  return { list, handle };
}
module.exports = { createDirectoryService };
