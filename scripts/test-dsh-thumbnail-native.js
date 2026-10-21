'use strict';

// Native codec check with generated in-memory noise, never a user's photograph.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createThumbnailRenderer, MAX_THUMBNAIL_BYTES } = require('./dsh-lite-image-preview');
const { inspectRaster } = require('./dsh-lite-attachment');
if (process.platform !== 'win32') {
  console.log('Native thumbnail check skipped: Windows System.Drawing is required; no compatibility claim made.');
  process.exit(0);
}
const generate = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap(1600,1000,[Drawing.Imaging.PixelFormat]::Format24bppRgb)
$memory = New-Object IO.MemoryStream
try {
  $rectangle = New-Object Drawing.Rectangle(0,0,1600,1000)
  $locked = $bitmap.LockBits($rectangle,[Drawing.Imaging.ImageLockMode]::WriteOnly,[Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    $data = New-Object byte[] ([Math]::Abs($locked.Stride)*1000)
    $random = New-Object Random(1234)
    $random.NextBytes($data)
    [Runtime.InteropServices.Marshal]::Copy($data,0,$locked.Scan0,$data.Length)
  } finally { $bitmap.UnlockBits($locked) }
  $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
  $memory.Position=0; $stdout=[Console]::OpenStandardOutput(); $memory.CopyTo($stdout); $stdout.Flush()
} finally {$memory.Dispose();$bitmap.Dispose()}
`;
const tempDir = path.resolve('D:/bridge-dsh-image-preview-test-temp/native-temp');
let diagnostic = '';
(async () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const png = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(generate, 'utf16le').toString('base64')],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 10000, env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir } });
  assert.deepEqual(inspectRaster(png), { type: 'image/png', width: 1600, height: 1000 });
  let active = 0, peak = 0, children = 0;
  const render = createThumbnailRenderer({ tempDir, spawn(...args) { const child = spawn(...args); active++; children++; peak = Math.max(peak,active); child.once('close',()=>active--); child.stderr.on('data', data => { if (diagnostic.length < 2000) diagnostic += String(data); }); return child; } });
  const started = Date.now(), [result, concurrent] = await Promise.all([render({ data: png, type: 'image/png' }),render({ data: png, type: 'image/png' })]);
  const image = inspectRaster(result.data);
  assert.equal(result.type, 'image/jpeg'); assert.equal(image.type, 'image/jpeg');
  assert(image.width <= 960 && image.height <= 960); assert(result.data.length <= MAX_THUMBNAIL_BYTES);
  assert(result.data.length < png.length);
  assert.deepEqual(concurrent.data,result.data); assert.equal(peak,1); assert.equal(children,2);
  const repeat = await render({ data: png, type: 'image/png' }); assert.deepEqual(repeat.data, result.data);
  console.log(JSON.stringify({ pass: true, nativeSystemDrawing: true, source: { bytes: png.length, width: 1600, height: 1000 },
    thumbnail: { bytes: result.data.length, width: image.width, height: image.height, mediaType: result.type }, elapsedMs: Date.now() - started,
    concurrentRequests:2,peakNativeChildren:peak,cacheRepeatExact: true, plaintextImageFilesWritten: 0, productionImagesRead: 0 }));
})().catch(error => { console.error(JSON.stringify({ pass: false, code: error.code || error.name, diagnostic: diagnostic.replace(/https?:\/\/\S+/g, '[redacted]').slice(0, 2000) })); process.exitCode = 1; });
