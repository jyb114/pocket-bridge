'use strict';

// Read-only raster previews. Model text never grants filesystem authority.
// Outside-workspace access requires an exact signed local CLI approval.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { workspaceRootFor } = require('./dsh-lite-download');
const { inspectRaster } = require('./dsh-lite-attachment');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 200 * 1024;
const MAX_REQUEST_BYTES = 8192;
const MAX_REGISTRY_BYTES = 128 * 1024;
const MAX_GRANT_MS = 24 * 60 * 60 * 1000;
const GRANT_DOMAIN = 'pocket-bridge-exact-image-grant-v1\0';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
let nativeConversions = 0;
const nativeQueue = [];
const fault = (status, code) => Object.assign(Error(code), { status, code });
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const validSession = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

function nativeLease() {
  nativeConversions = 1;
  let released = false;
  return () => {
    if (released) return;
    released = true; nativeConversions = 0;
    while (nativeQueue.length) {
      const waiting = nativeQueue.shift(); waiting.cleanup();
      if (waiting.signal?.aborted) { waiting.reject(fault(499, 'image-preview-aborted')); continue; }
      if (Date.now() >= waiting.deadline) { waiting.reject(fault(504, 'image-thumbnail-timeout')); continue; }
      waiting.resolve(nativeLease()); return;
    }
  };
}

function acquireNative(signal, deadline) {
  if (signal?.aborted) return Promise.reject(fault(499, 'image-preview-aborted'));
  if (Date.now() >= deadline) return Promise.reject(fault(504, 'image-thumbnail-timeout'));
  if (!nativeConversions) return Promise.resolve(nativeLease());
  if (nativeQueue.length >= 4) return Promise.reject(fault(429, 'image-thumbnail-busy'));
  return new Promise((resolve, reject) => {
    const waiting = { resolve, reject, signal, deadline };
    const cancel = code => { const index = nativeQueue.indexOf(waiting); if (index < 0) return; nativeQueue.splice(index, 1); waiting.cleanup(); reject(fault(code === 'image-preview-aborted' ? 499 : 504, code)); };
    const abort = () => cancel('image-preview-aborted');
    const timer = setTimeout(() => cancel('image-thumbnail-timeout'), Math.max(1, deadline - Date.now()));
    waiting.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true }); nativeQueue.push(waiting);
  });
}

function validPath(value, paths = path) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || /^(?:\\|\/\/)/.test(value)) return false;
  const absoluteDrive = /^[a-z]:[\\/]/i.test(value);
  if (paths.sep === '\\' && /^[\\/]/.test(value) && !absoluteDrive) return false;
  const rest = absoluteDrive ? value.slice(3) : value;
  if (rest.includes(':') || /[<>|"?*]/.test(rest)) return false;
  const parts = rest.split(/[\\/]/);
  if (paths.sep === '/' && value.startsWith('/')) parts.shift();
  return parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function inside(root, file, paths = path) {
  const relative = paths.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative);
}

function noLinks(file, io = fs, paths = path) {
  for (let current = paths.resolve(file);;) {
    const stat = io.lstatSync(current);
    if (stat.isSymbolicLink()) throw fault(403, 'image-path-changed');
    const parent = paths.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), nlink: String(stat.nlink),
    mtime: String(stat.mtimeNs ?? stat.mtimeMs), ctime: String(stat.ctimeNs ?? stat.ctimeMs) };
}
const sameIdentity = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));

// The opened descriptor must match the pre-open identity, then both descriptor
// and canonical pathname must still match after reading. Never return bytes on
// a junction/symlink/file replacement or an incomplete/changing file.
function readStable(file, limit = MAX_IMAGE_BYTES, options = {}) {
  const io = options.fs || fs, paths = options.path || path;
  let fd;
  try {
    noLinks(file, io, paths);
    const canonical = io.realpathSync(file);
    if (canonical !== file) throw fault(403, 'image-path-changed');
    const before = io.statSync(file, { bigint: true });
    if (!before.isFile() || Number(before.nlink) !== 1) throw fault(403, 'image-file-unavailable');
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > limit) throw fault(413, 'image-too-large');
    fd = io.openSync(file, io.constants ? io.constants.O_RDONLY | (io.constants.O_NOFOLLOW || 0) : 'r');
    const held = io.fstatSync(fd, { bigint: true });
    if (!sameIdentity(before, held) || io.realpathSync(file) !== file) throw fault(409, 'image-file-changed');
    const bytes = Buffer.alloc(size + 1);
    let at = 0;
    while (at < bytes.length) {
      const count = io.readSync(fd, bytes, at, bytes.length - at, at);
      if (!count) break;
      at += count;
    }
    const after = io.fstatSync(fd, { bigint: true });
    noLinks(file, io, paths);
    if (at !== size || !sameIdentity(held, after) || io.realpathSync(file) !== file ||
        !sameIdentity(after, io.statSync(file, { bigint: true }))) throw fault(409, 'image-file-changed');
    const data = bytes.subarray(0, size);
    return { data, canonical: file, bytes: size, sha256: sha256(data), identity: identity(after) };
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

function stillCurrent(snapshot, options = {}) {
  const io = options.fs || fs, paths = options.path || path;
  try {
    noLinks(snapshot.canonical, io, paths);
    return io.realpathSync(snapshot.canonical) === snapshot.canonical &&
      JSON.stringify(identity(io.statSync(snapshot.canonical, { bigint: true }))) === JSON.stringify(snapshot.identity);
  } catch { return false; }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const grantFiles = logDir => ({ registry: path.join(logDir, 'image-preview-grants.json'), key: path.join(logDir, 'image-preview-grants.key') });
const mac = (value, key) => crypto.createHmac('sha256', key).update(GRANT_DOMAIN + canonicalJson(value)).digest('hex');

function readGrants(logDir, options = {}) {
  const io = options.fs || fs;
  const files = grantFiles(logDir);
  try {
    noLinks(files.key, io, options.path || path);
    noLinks(files.registry, io, options.path || path);
    const key = readStable(io.realpathSync(files.key), 32, options).data;
    if (key.length !== 32) return null;
    const record = JSON.parse(readStable(io.realpathSync(files.registry), MAX_REGISTRY_BYTES, options).data.toString('utf8'));
    if (!exact(record, ['version', 'entries', 'signature']) || record.version !== 1 || !Array.isArray(record.entries) || record.entries.length > 64 || !DIGEST.test(record.signature || '')) return null;
    const payload = { version: record.version, entries: record.entries };
    if (!crypto.timingSafeEqual(Buffer.from(record.signature, 'hex'), Buffer.from(mac(payload, key), 'hex'))) return null;
    return { entries: record.entries, key };
  } catch { return null; }
}

function grantFor({ logDir, instanceId, sessionId, root, file, now = Date.now(), options = {} }) {
  const registry = readGrants(logDir, options);
  if (!registry) return null;
  return registry.entries.find(entry => exact(entry, ['id', 'instanceId', 'sessionId', 'workspaceRoot', 'canonicalPath', 'bytes', 'sha256', 'identity', 'createdAt', 'expiresAt']) &&
    DIGEST.test(entry.id || '') && entry.instanceId === instanceId && entry.sessionId === sessionId && entry.workspaceRoot === root && entry.canonicalPath === file &&
    Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_IMAGE_BYTES && DIGEST.test(entry.sha256 || '') &&
    Number.isSafeInteger(entry.createdAt) && Number.isSafeInteger(entry.expiresAt) && entry.createdAt <= now && entry.expiresAt > now && entry.expiresAt - entry.createdAt <= MAX_GRANT_MS &&
    exact(entry.identity, ['dev', 'ino', 'size', 'nlink', 'mtime', 'ctime'])) || null;
}

function grantMatches(grant, snapshot) {
  return grant && grant.bytes === snapshot.bytes && grant.sha256 === snapshot.sha256 &&
    canonicalJson(grant.identity) === canonicalJson(snapshot.identity);
}

// Static program only. Image bytes go through stdin and JPEG bytes through
// stdout; no caller path or text is interpolated into the PowerShell program.
const DRAWING_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$inputStream = [Console]::OpenStandardInput()
$sourceStream = New-Object IO.MemoryStream
$buffer = New-Object byte[] 65536
while (($count = $inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
  if ($sourceStream.Length + $count -gt 8388608) { throw 'image-size-limit' }
  $sourceStream.Write($buffer,0,$count)
}
$sourceStream.Position = 0
$source = $null
try {
  $source = [Drawing.Image]::FromStream($sourceStream,$true,$true)
  if ($source.Width -lt 1 -or $source.Height -lt 1 -or $source.Width -gt 8192 -or $source.Height -gt 8192 -or ([long]$source.Width * $source.Height) -gt 20000000) { throw 'image-dimension-limit' }
  $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'} | Select-Object -First 1
  if (-not $codec) { throw 'jpeg-unavailable' }
  foreach ($edge in @(960,720,480)) {
    $scale = [Math]::Min(1.0,$edge / [double][Math]::Max($source.Width,$source.Height))
    $width = [Math]::Max(1,[int][Math]::Round($source.Width*$scale))
    $height = [Math]::Max(1,[int][Math]::Round($source.Height*$scale))
    $bitmap = New-Object Drawing.Bitmap($width,$height,[Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $output = New-Object IO.MemoryStream
    $parameters = New-Object Drawing.Imaging.EncoderParameters(1)
    try {
      $graphics.Clear([Drawing.Color]::White)
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($source,0,0,$width,$height)
      $parameters.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality,[long]70)
      $bitmap.Save($output,$codec,$parameters)
      if ($output.Length -gt 0 -and $output.Length -le 204800) {
        $stdout = [Console]::OpenStandardOutput()
        $output.Position=0; $output.CopyTo($stdout); $stdout.Flush()
        exit 0
      }
    } finally { $parameters.Dispose(); $output.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
  }
  throw 'thumbnail-size-limit'
} finally { if ($source) {$source.Dispose()}; $sourceStream.Dispose() }
`;

function createThumbnailRenderer(options = {}) {
  const now = options.now || Date.now;
  const cache = new Map(); let cachedBytes = 0;
  const platform = options.platform || process.platform;
  const spawnChild = options.spawn || spawn;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(5000, options.timeoutMs) : 5000;
  const cacheLimit = 6 * MAX_THUMBNAIL_BYTES;
  return async function render(image, { signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    if (signal?.aborted) throw fault(499, 'image-preview-aborted');
    const info = Buffer.isBuffer(image?.data) && inspectRaster(image.data);
    if (!info || info.type !== image.type || image.data.length > MAX_IMAGE_BYTES) throw fault(415, 'raster-image-required');
    const key = sha256(image.data);
    for (const [oldKey, entry] of cache) if (now() - entry.at > 5 * 60 * 1000) { cachedBytes -= entry.data.length; cache.delete(oldKey); }
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return { data: Buffer.from(hit.data), type: 'image/jpeg' }; }
    if (platform !== 'win32') throw fault(501, 'image-thumbnail-unsupported');
    const release = await acquireNative(signal, deadline);
    let childOwnsLease = false;
    try {
      if (signal?.aborted) throw fault(499, 'image-preview-aborted');
      if (Date.now() >= deadline) throw fault(504, 'image-thumbnail-timeout');
      const data = await new Promise((resolve, reject) => {
        let child, settled = false, total = 0; const chunks = [];
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { try { child?.kill(); } catch {} reject(error); } else resolve(value); };
        const abort = () => finish(fault(499, 'image-preview-aborted'));
        const timer = setTimeout(() => finish(fault(504, 'image-thumbnail-timeout')), Math.max(1, deadline - Date.now()));
        signal?.addEventListener('abort', abort, { once: true });
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        try {
          const tempDir = options.tempDir || path.join(process.cwd(), 'logs', 'runtime-temp');
          fs.mkdirSync(tempDir, { recursive: true });
          child = spawnChild(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(DRAWING_PROGRAM, 'utf16le').toString('base64')],
            { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir } });
          childOwnsLease = true;
          child.once('error', () => { release(); finish(fault(501, 'image-thumbnail-unavailable')); });
          child.stdout.on('data', chunk => { total += chunk.length; if (total > MAX_THUMBNAIL_BYTES) finish(fault(413, 'image-thumbnail-too-large')); else chunks.push(Buffer.from(chunk)); });
          child.stderr.resume(); child.stdin.on('error', () => {});
          child.once('close', code => { release(); code === 0 && total > 0 ? finish(null, Buffer.concat(chunks)) : finish(fault(422, 'image-thumbnail-failed')); });
          child.stdin.end(image.data);
        } catch { finish(fault(501, 'image-thumbnail-unavailable')); }
      });
      const result = inspectRaster(data);
      if (!result || result.type !== 'image/jpeg' || result.width > 960 || result.height > 960 || data.length > MAX_THUMBNAIL_BYTES) throw fault(422, 'image-thumbnail-invalid');
      while (cache.size >= 6 || cachedBytes + data.length > cacheLimit) { const first = cache.keys().next().value; cachedBytes -= cache.get(first).data.length; cache.delete(first); }
      cache.set(key, { data: Buffer.from(data), at: now() }); cachedBytes += data.length;
      return { data, type: 'image/jpeg' };
    } finally { if (!childOwnsLease) release(); }
  };
}

async function readRequest(req) {
  if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) throw fault(413, 'image-request-too-large');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_REQUEST_BYTES) throw fault(413, 'image-request-too-large'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault(400, 'invalid-image-preview-request'); }
}

function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(fault(499, 'image-preview-aborted')); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(value).then(result => { signal.removeEventListener('abort', cancel); resolve(result); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

function createDshLiteImagePreview(options = {}) {
  if (!(typeof options.instanceId === 'function' || UUID.test(options.instanceId || '')) || typeof options.logDir !== 'string' || !path.isAbsolute(options.logDir)) throw TypeError('instanceId resolver and absolute logDir required');
  const io = options.fs || fs, paths = options.path || path, now = options.now || Date.now;
  const rootFor = options.workspaceRootFor || (sessionId => workspaceRootFor(sessionId, options));
  const thumbnail = options.thumbnailRenderer || createThumbnailRenderer({ tempDir: path.join(options.logDir, 'runtime-temp') });
  let active = 0;
  return async function imagePreview(req, res) {
    const reply = (status, error) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify({ error })); };
    if (req.method !== 'POST') return reply(405, 'method-not-allowed');
    if (!req.__dshE2eeDecrypted || req.headers?.['x-dsh-e2ee'] !== '1') return reply(403, 'encrypted-request-required');
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) return reply(415, 'json-required');
    if (active >= 2) return reply(429, 'image-preview-busy');
    active++;
    const controller = new AbortController(), abort = () => controller.abort();
    req.once?.('aborted', abort); res.once?.('close', abort);
    const timer = setTimeout(abort, 10_000);
    try {
      if (new URL(req.url, 'http://localhost').search) throw fault(400, 'invalid-image-preview-request');
      const input = await abortable(readRequest(req), controller.signal);
      if (!exact(input, ['sessionId', 'path', 'variant']) || !validSession(input.sessionId) || !validPath(input.path, paths) || !['thumbnail', 'original'].includes(input.variant)) throw fault(400, 'invalid-image-preview-request');
      const instanceId = typeof options.instanceId === 'function' ? options.instanceId() : options.instanceId;
      if (!UUID.test(instanceId || '')) throw fault(503, 'image-context-unavailable');
      if (controller.signal.aborted) throw fault(499, 'image-preview-aborted');
      const resolvedRoot = rootFor(input.sessionId);
      if (!resolvedRoot) throw fault(404, 'session-workspace-unavailable');
      const root = io.realpathSync(resolvedRoot);
      const file = io.realpathSync(paths.resolve(root, input.path));
      const inWorkspace = inside(root, file, paths);
      const readApproval = () => grantFor({ logDir: options.logDir, instanceId, sessionId: input.sessionId, root, file, now: now(), options });
      if (!inWorkspace && !readApproval()) throw fault(403, 'image-local-approval-required');
      const snapshot = readStable(file, MAX_IMAGE_BYTES, options), info = inspectRaster(snapshot.data);
      if (!info) throw fault(415, 'raster-image-required');
      if (!inWorkspace && !grantMatches(readApproval(), snapshot)) throw fault(403, 'image-local-approval-changed');
      const image = input.variant === 'original' ? { data: snapshot.data, type: info.type } : await thumbnail({ data: snapshot.data, type: info.type }, { signal: controller.signal });
      if (controller.signal.aborted) throw fault(499, 'image-preview-aborted');
      const finalInfo = Buffer.isBuffer(image?.data) && inspectRaster(image.data);
      if (!finalInfo || finalInfo.type !== image.type || image.data.length > MAX_IMAGE_BYTES || input.variant === 'thumbnail' && (image.type !== 'image/jpeg' || image.data.length > MAX_THUMBNAIL_BYTES || finalInfo.width > 960 || finalInfo.height > 960)) throw fault(502, 'image-preview-invalid');
      if ((typeof options.instanceId === 'function' ? options.instanceId() : options.instanceId) !== instanceId || rootFor(input.sessionId) !== resolvedRoot || !stillCurrent(snapshot, options)) throw fault(409, 'image-file-changed');
      if (!inWorkspace && !grantMatches(readApproval(), snapshot)) throw fault(403, 'image-local-approval-changed');
      res.writeHead(200, { 'content-type': image.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(image.data);
    } catch (error) { reply(error.status || 404, error.code || 'image-file-unavailable'); }
    finally { clearTimeout(timer); req.off?.('aborted', abort); res.off?.('close', abort); controller.abort(); active--; }
  };
}

function approveImageUnlocked(options = {}) {
  const now = options.now || Date.now, io = options.fs || fs, paths = options.path || path;
  if (!UUID.test(options.instanceId || '') || !validSession(options.sessionId) || !validPath(options.filePath, paths) || !paths.isAbsolute(options.filePath) || !paths.isAbsolute(options.logDir || '')) throw fault(400, 'invalid-local-image-approval');
  const rootFor = options.workspaceRootFor || (sessionId => workspaceRootFor(sessionId, options));
  const root = io.realpathSync(rootFor(options.sessionId));
  const file = io.realpathSync(options.filePath), snapshot = readStable(file, MAX_IMAGE_BYTES, options);
  if (!inspectRaster(snapshot.data)) throw fault(415, 'raster-image-required');
  noLinks(options.logDir, io, paths);
  const files = grantFiles(options.logDir);
  let registry = readGrants(options.logDir, options);
  if (!registry) {
    if (io.existsSync(files.key) || io.existsSync(files.registry)) throw fault(409, 'image-approval-registry-invalid');
    const key = crypto.randomBytes(32);
    io.writeFileSync(files.key, key, { flag: 'wx', mode: 0o600 });
    registry = { key, entries: [] };
  }
  const at = now(), id = sha256(canonicalJson([options.instanceId, options.sessionId, root, file]));
  const entry = { id, instanceId: options.instanceId, sessionId: options.sessionId, workspaceRoot: root, canonicalPath: file,
    bytes: snapshot.bytes, sha256: snapshot.sha256, identity: snapshot.identity, createdAt: at, expiresAt: at + MAX_GRANT_MS };
  const entries = registry.entries.filter(old => old.id !== id && old.expiresAt > at);
  if (!options.revoke) entries.push(entry);
  if (entries.length > 64) throw fault(429, 'image-approval-registry-full');
  const payload = { version: 1, entries }, body = Buffer.from(JSON.stringify({ ...payload, signature: mac(payload, registry.key) }) + '\n');
  if (body.length > MAX_REGISTRY_BYTES) throw fault(429, 'image-approval-registry-full');
  const temporary = files.registry + '.' + crypto.randomUUID() + '.tmp';
  io.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 }); io.renameSync(temporary, files.registry);
  return { approved: !options.revoke, id, bytes: snapshot.bytes, expiresAt: entry.expiresAt };
}

function approveImage(options = {}) {
  const io = options.fs || fs, paths = options.path || path;
  if (!paths.isAbsolute(options.logDir || '')) throw fault(400, 'invalid-local-image-approval');
  noLinks(options.logDir, io, paths);
  const lockFile = paths.join(options.logDir, 'image-preview-grants.lock');
  let fd, held;
  try {
    try { fd = io.openSync(lockFile, 'wx', 0o600); }
    catch (error) { throw fault(error.code === 'EEXIST' ? 409 : 503, error.code === 'EEXIST' ? 'image-approval-busy' : 'image-approval-lock-unavailable'); }
    io.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }));
    held = io.fstatSync(fd, { bigint: true });
    return approveImageUnlocked(options);
  } finally {
    if (fd !== undefined) {
      try {
        noLinks(lockFile, io, paths);
        const current = io.statSync(lockFile, { bigint: true });
        if (!held || !sameIdentity(held, current)) throw fault(409, 'image-approval-lock-changed');
        io.closeSync(fd); fd = undefined; io.unlinkSync(lockFile);
      } finally { if (fd !== undefined) io.closeSync(fd); }
    }
  }
}

module.exports = { createDshLiteImagePreview, createThumbnailRenderer, approveImage, readGrants, readStable, validPath,
  MAX_IMAGE_BYTES, MAX_THUMBNAIL_BYTES, MAX_GRANT_MS };
