'use strict';

// Original Pocket Bridge artwork. All coordinates are authored here; no
// third-party logo, font, remote image, or copied brand asset is used.
// The same bridge geometry is also checked in as pwa/pocket-bridge.svg.
function distanceToLine(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function bridgeContains(x, y) {
  const radius = 1.1;
  if (y <= 16 && Math.abs(Math.hypot(x - 16, y - 16) - 8) <= radius) return true;
  return [[8, 16, 8, 23], [24, 16, 24, 23], [5, 20, 27, 20],
    [12, 20, 12, 24], [20, 20, 20, 24]].some(line => distanceToLine(x, y, ...line) <= radius);
}

function roundedSquareContains(x, y) {
  const cx = Math.max(10, Math.min(22, x));
  const cy = Math.max(10, Math.min(22, y));
  return Math.hypot(x - cx, y - cy) <= 9;
}

function renderIcon(size, maskable = false) {
  if (!Number.isInteger(size) || size < 16 || size > 1024) throw new Error('Invalid icon size');
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 32 / size;
  const samples = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let coverage = 0, white = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const px = (x + (sx + .5) / 2) * scale;
      const py = (y + (sy + .5) / 2) * scale;
      if (maskable || roundedSquareContains(px, py)) {
        coverage++;
        if (bridgeContains(px, py)) white++;
      }
    }
    const offset = (y * size + x) * 4;
    const blend = coverage ? white / coverage : 0;
    rgba[offset] = Math.round(36 + (255 - 36) * blend);
    rgba[offset + 1] = Math.round(86 + (255 - 86) * blend);
    rgba[offset + 2] = Math.round(217 + (255 - 217) * blend);
    rgba[offset + 3] = Math.round(255 * coverage / samples);
  }
  return rgba;
}

module.exports = { renderIcon };
