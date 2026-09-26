# =============================================================================
# DSH 移动端网关 — 生成 PWA 资源
#
# 生成三样东西到 <项目>\pwa\ ：
#   icon-192.png / icon-512.png / apple-touch-icon.png
#   manifest.webmanifest
#   sw.js                        （Service Worker，Web Push 的接收端）
#
# 为什么需要这一步：DSH 自带的 manifest 里图标只有 favicon.svg，而 iOS
# 不接受 SVG 作为主屏幕图标 —— 不加 PNG 图标，iPhone 加到主屏幕会显示成
# 网页截图占位图，而且 Web Push 的图标/角标也无从取用。
#
# 可重复执行，会覆盖旧文件。
# =============================================================================

$ErrorActionPreference = 'Stop'

$Base    = Split-Path -Parent $PSScriptRoot
$PwaDir  = Join-Path $Base 'pwa'
New-Item -ItemType Directory -Force -Path $PwaDir | Out-Null

Add-Type -AssemblyName System.Drawing

# DeepSeek 的品牌蓝；DSH 自带 favicon 是纯黑鲸鱼，这里做成蓝底白字更醒目
$BrandBlue = [System.Drawing.Color]::FromArgb(255, 77, 107, 254)

function New-DshIcon {
    param([int]$Size, [string]$OutPath)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear($BrandBlue)

    # 图标中央的 "DSH" 字样。iOS 会自动裁圆角，所以这里画满幅方形。
    $fontSize = [float]($Size * 0.30)
    $font  = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt   = New-Object System.Drawing.StringFormat
    $fmt.Alignment     = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect  = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $g.DrawString('DSH', $font, [System.Drawing.Brushes]::White, $rect, $fmt)

    $g.Dispose()
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $font.Dispose()
}

foreach ($spec in @(
    @{ Size = 192; Name = 'icon-192.png' },
    @{ Size = 512; Name = 'icon-512.png' },
    @{ Size = 180; Name = 'apple-touch-icon.png' }
)) {
    $path = Join-Path $PwaDir $spec.Name
    New-DshIcon -Size $spec.Size -OutPath $path
    Write-Host ("生成 {0} ({1}x{1}, {2} 字节)" -f $spec.Name, $spec.Size, (Get-Item $path).Length)
}

# ── manifest ──────────────────────────────────────────────────────────────────
# display 用 standalone 而非 fullscreen：iOS 对 fullscreen 支持不佳，
# standalone 在两端表现都正常。
$manifest = @'
{
  "id": "/",
  "name": "DeepSeek Harness",
  "short_name": "DSH",
  "description": "手机端 DSH 工作台",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#0b0b0c",
  "theme_color": "#4d6bfe",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
'@
# 注意：必须确保无 BOM。带 BOM 的 JSON 会让浏览器的 manifest 解析直接失败
# （Node 的 JSON.parse 同样拒绝），iPhone 那边就认不出图标。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $PwaDir 'manifest.webmanifest'), $manifest, $utf8NoBom)
Write-Host '生成 manifest.webmanifest'

# ── service worker ────────────────────────────────────────────────────────────
# 只做两件事：接收 Web Push 并弹通知；点通知时聚焦/打开 DSH。
# 刻意不做任何资源缓存 —— 缓存 DSH 的前端产物会带来版本错配的麻烦。
$sw = @'
// DSH 移动端网关 — Service Worker
// 职责：接收电脑端发来的 Web Push 并弹通知；点通知时聚焦或打开 DSH。
// 刻意不缓存任何资源：DSH 前端是带 hash 的构建产物，缓存只会带来版本错配。

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'DSH', body: '有新的进展' };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (err) {
    try { payload.body = event.data ? event.data.text() : payload.body; } catch (e) {}
  }

  const options = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.url || '/' },
    requireInteraction: false
  };
  if (payload.tag) {
    options.tag = payload.tag;
    options.renotify = true;
  }

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});

// 页面侧可以通过 postMessage 让 SW 自己弹一条本地通知，用于验证链路是否打通
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'dsh-test-notification') {
    self.registration.showNotification(data.title || 'DSH 测试通知', {
      body: data.body || '如果你看到这条，说明通知链路是通的。',
      icon: '/icon-192.png',
      badge: '/icon-192.png'
    });
  }
});
'@
[System.IO.File]::WriteAllText((Join-Path $PwaDir 'sw.js'), $sw, $utf8NoBom)
Write-Host '生成 sw.js'

Write-Host ''
Write-Host "PWA 资源目录: $PwaDir"
Get-ChildItem $PwaDir | Select-Object Length, Name | Format-Table -AutoSize
