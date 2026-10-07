'use strict';

// 把**电脑屏幕**抓下来给手机看。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────────
//
// 使用者人不在电脑前（在外面临时用手机接管），这时他最缺的不是"再点一个按钮"，
// 而是**看见电脑现在是什么样**：某个窗口是不是弹出来了、进度条卡在哪、
// 桌面上那个报错框写了什么。没有这个能力，很多事只能靠猜，猜错就白折腾一轮。
//
// ── 安全边界 ────────────────────────────────────────────────────────────────
//
// 抓屏**只读、不注入、不抢焦点、不模拟按键**。它不会把任何东西送到错误的窗口里，
// 也不会因为界面改版而"点错地方"。它唯一的风险是**画面本身敏感**，
// 所以：请求必须过两道门（设备令牌 + 挑战应答）且走 E2EE 内容通道
// （E2EE_CONTENT_PATHS），并且**每一次抓屏都写日志** ——
// 使用者事后能查"什么时候被抓过屏"。
//
// ── 为什么是 JPEG 而不是 PNG ──────────────────────────────────────────────────
//
// 隧道实测约 218 KB/s。1920 宽的桌面 PNG 常有 300–500 KB，JPEG(q78) 约 100–200 KB，
// 在手机那块屏幕上肉眼看不出差别。默认还会缩到 1280 宽 —— 再省一半，
// 而文字仍然清楚。要看细节可以传更大的 maxWidth。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_MAX_WIDTH = 1280;
const MAX_MAX_WIDTH = 3840;
const MIN_MAX_WIDTH = 480;
const MAX_BYTES = 4 * 1024 * 1024;      // 单张上限，超过就报错而不是把隧道堵死
const CAPTURE_TIMEOUT_MS = 20000;

/**
 * 抓屏用的 PowerShell。
 *
 * ★ 文件必须写 **UTF-8 带 BOM**（见下面 writeFileSync 的注释）——
 *   PowerShell 5.1 读无 BOM 的文件会按系统 ANSI 解析，中文会把它解析坏。
 *   这份脚本本身不含中文，但保持同一条规矩，免得以后加注释时踩坑。
 */
const PS_SCRIPT = `
param([int]$MaxWidth, [string]$OutFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 整块虚拟桌面（多显示器也一起抓）
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($vs.Width -le 0 -or $vs.Height -le 0) { Write-Output 'RESULT=NO_SCREEN'; exit 0 }

$full = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $full.Size)
$g.Dispose()

# 等比缩到 MaxWidth 以内（手机屏幕看不出更大差别，但隧道带宽差很多）
$scale = 1.0
if ($MaxWidth -gt 0 -and $vs.Width -gt $MaxWidth) { $scale = $MaxWidth / $vs.Width }
$w = [int][Math]::Round($vs.Width * $scale)
$h = [int][Math]::Round($vs.Height * $scale)
if ($w -lt 1) { $w = 1 }
if ($h -lt 1) { $h = 1 }

$out = New-Object System.Drawing.Bitmap($w, $h)
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($full, 0, 0, $w, $h)
$g2.Dispose()
$full.Dispose()

# JPEG 质量 78：手机上看够用，字节数约是 PNG 的三分之一
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
         Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
  [System.Drawing.Imaging.Encoder]::Quality, [int64]78)
$out.Save($OutFile, $codec, $params)
$out.Dispose()

Write-Output ("RESULT=OK {0}x{1}" -f $w, $h)
`;

// A screenshot is an explicit operation. Do not accept another route's
// authenticated JSON merely because it lacks screenshot options.
function normalizeOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'maxWidth' ||
      !Number.isSafeInteger(input.maxWidth) || input.maxWidth < MIN_MAX_WIDTH ||
      input.maxWidth > MAX_MAX_WIDTH) return null;
  return { maxWidth: input.maxWidth };
}

async function readBody(req, limit = 4096) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) throw Object.assign(new Error('too-large'), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * @param {{ log?: (line: string) => void }} options
 *   log 用来记「谁在什么时候抓了一次屏」。抓屏是敏感操作，必须留痕。
 */
function createDshLiteScreen(options = {}) {
  const note = typeof options.log === 'function' ? options.log : () => {};

  return async function handleDshLiteScreen(req, res) {
    function reply(status, value) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(JSON.stringify(value));
    }

    if (req.method !== 'POST') { reply(405, { error: 'method-not-allowed' }); return; }

    // Only e2eeWrap's in-process shim proves successful decryption; the
    // request header alone can be forged by a client.
    if (!req.__dshE2eeDecrypted || !req.headers || req.headers['x-dsh-e2ee'] !== '1') {
      reply(403, { error: 'encrypted-request-required' }); return;
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
      reply(415, { error: 'json-required' }); return;
    }

    let asked;
    try {
      const text = await readBody(req);
      asked = JSON.parse(text);
    } catch (error) {
      reply(error && error.status === 413 ? 413 : 400,
        { error: error && error.status === 413 ? 'request-too-large' : 'invalid-json' });
      return;
    }
    const opts = normalizeOptions(asked);
    if (!opts) { reply(400, { error: 'invalid-screen-request' }); return; }

    const file = path.join(os.tmpdir(), `pb-screen-${process.pid}-${Date.now()}.jpg`);
    const script = path.join(os.tmpdir(), `pb-screen-${process.pid}-${Date.now()}.ps1`);
    try {
      // ★ UTF-8 带 BOM —— PowerShell 5.1 靠这个 BOM 才按 UTF-8 读文件。
      //   去掉它，中文会被当 GBK 解析，脚本直接语法错误（这个坑在
      //   否则会出现难以定位的 PowerShell 语法错误）。
      fs.writeFileSync(script, '\uFEFF' + PS_SCRIPT, 'utf8');

      const out = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
        '-File', script, String(opts.maxWidth), file
      ], { encoding: 'utf8', timeout: CAPTURE_TIMEOUT_MS, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'] });

      if (!/RESULT=OK/.test(String(out))) {
        note('抓屏失败：系统没有可抓的屏幕');
        reply(502, { error: 'no-screen' }); return;
      }
      const size = (() => { try { return fs.statSync(file).size; } catch (err) { return 0; } })();
      if (!size) { reply(502, { error: 'capture-empty' }); return; }
      if (size > MAX_BYTES) {
        note(`抓屏太大（${Math.round(size / 1024)} KB），已拒绝`);
        reply(413, { error: 'capture-too-large', bytes: size }); return;
      }

      const dims = String(out).match(/RESULT=OK (\d+)x(\d+)/);
      note(`抓屏成功：${dims ? dims[1] + 'x' + dims[2] : '?'}，${Math.round(size / 1024)} KB`);
      reply(200, {
        ok: true,
        width: dims ? Number(dims[1]) : 0,
        height: dims ? Number(dims[2]) : 0,
        bytes: size,
        mime: 'image/jpeg',
        image: fs.readFileSync(file).toString('base64'),
        capturedAt: new Date().toISOString()
      });
    } catch (error) {
      note(`抓屏出错：${error && error.message ? error.message : error}`);
      reply(502, { error: 'capture-failed' });
    } finally {
      try { fs.unlinkSync(file); } catch (err) { /* 删不掉就交给系统清 temp */ }
      try { fs.unlinkSync(script); } catch (err) { /* 同上 */ }
    }
  };
}

module.exports = { createDshLiteScreen, DEFAULT_MAX_WIDTH, MAX_BYTES };
