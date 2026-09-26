// Pocket Bridge desktop icons. Every variant uses the same product artwork;
// tray variants add a small status dot without changing the main symbol.
// The PNG/ICO codec is local so source builds need no image dependencies.
//
// Tray status colors:
//   green  一切正常
//   amber  部分可用（比如隧道没起来，但内网能连）
//   red    服务没在跑
//   grey   未知 / 正在检查
//
// 用法: node desktop/make-icons.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, 'icons');

const COLORS = {
  green: [0x58, 0xc8, 0x9a],
  amber: [0xef, 0xb8, 0x60],
  red: [0xe6, 0x73, 0x73],
  grey: [0x91, 0xa8, 0xad]
};

// ── PNG 编码 ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Buffer(width*height*4) → PNG 文件字节 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Decode the checked-in 8-bit RGBA brand artwork ───────────────────────────

function decodePng(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('Brand image is not PNG');
  let width = 0;
  let height = 0;
  let offset = 8;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error('Truncated brand PNG');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0 ||
          width < 1 || height < 1 || width > 1024 || height > 1024) {
        throw new Error('Brand PNG must be non-interlaced 8-bit RGBA, at most 1024px');
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  if (!width || !height || !idat.length) throw new Error('Incomplete brand PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid brand PNG size');
  const rgba = Buffer.alloc(stride * height);
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[source++];
    if (filter > 4) throw new Error('Unsupported brand PNG filter');
    for (let x = 0; x < stride; x++) {
      const value = raw[source++];
      const here = y * stride + x;
      const left = x >= 4 ? rgba[here - 4] : 0;
      const up = y ? rgba[here - stride] : 0;
      const upperLeft = y && x >= 4 ? rgba[here - stride - 4] : 0;
      let predict = 0;
      if (filter === 1) predict = left;
      else if (filter === 2) predict = up;
      else if (filter === 3) predict = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const a = Math.abs(p - left);
        const b = Math.abs(p - up);
        const c = Math.abs(p - upperLeft);
        predict = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      }
      rgba[here] = (value + predict) & 0xff;
    }
  }
  return { width, height, rgba };
}

function resize(source, size) {
  const output = Buffer.alloc(size * size * 4);
  const { width, height, rgba } = source;
  for (let y = 0; y < size; y++) {
    const top = y * height / size;
    const bottom = (y + 1) * height / size;
    for (let x = 0; x < size; x++) {
      const left = x * width / size;
      const right = (x + 1) * width / size;
      let total = 0, alpha = 0, red = 0, green = 0, blue = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
        const wy = Math.min(bottom, sy + 1) - Math.max(top, sy);
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const weight = wy * (Math.min(right, sx + 1) - Math.max(left, sx));
          const input = (sy * width + sx) * 4;
          const a = rgba[input + 3] / 255;
          total += weight;
          alpha += weight * a;
          red += weight * a * rgba[input];
          green += weight * a * rgba[input + 1];
          blue += weight * a * rgba[input + 2];
        }
      }
      const out = (y * size + x) * 4;
      if (alpha > 0) {
        output[out] = Math.round(red / alpha);
        output[out + 1] = Math.round(green / alpha);
        output[out + 2] = Math.round(blue / alpha);
        output[out + 3] = Math.round(255 * alpha / total);
      }
    }
  }
  return output;
}

function addStatusDot(rgba, size, color) {
  const cx = size * 0.79;
  const cy = size * 0.79;
  const radius = size * 0.145;
  const outline = Math.max(1, size * 0.035);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (distance >= radius + 0.5) continue;
      const coverage = Math.min(1, Math.max(0, radius + 0.5 - distance));
      const dot = distance < radius - outline ? color : [0x0b, 0x1b, 0x21];
      const at = (y * size + x) * 4;
      const oldAlpha = rgba[at + 3] / 255;
      const newAlpha = coverage + oldAlpha * (1 - coverage);
      for (let channel = 0; channel < 3; channel++) {
        rgba[at + channel] = Math.round((dot[channel] * coverage +
          rgba[at + channel] * oldAlpha * (1 - coverage)) / newAlpha);
      }
      rgba[at + 3] = Math.round(newAlpha * 255);
    }
  }
  return rgba;
}

// ── ICO 封装 ─────────────────────────────────────────────────────────────────

/** 把若干 PNG 打成一个 .ico（Vista 以后支持 PNG 负载，Windows 10/11 没问题） */
function encodeIco(images) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);              // reserved
  dir.writeUInt16LE(1, 2);              // type: icon
  dir.writeUInt16LE(images.length, 4);  // count

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;  // 0 表示 256
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;                                // 调色板数
    e[3] = 0;                                // reserved
    e.writeUInt16LE(1, 4);                   // color planes
    e.writeUInt16LE(32, 6);                  // bits per pixel
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.png.length;
  }

  return Buffer.concat([dir, ...entries, ...images.map((i) => i.png)]);
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const BRAND_PNG = path.join(OUT_DIR, 'pocket-bridge-256.png');
const brand = decodePng(fs.readFileSync(BRAND_PNG));
const baseImages = SIZES.map((size) => ({ size, rgba: resize(brand, size) }));

fs.mkdirSync(OUT_DIR, { recursive: true });

const made = [];
for (const [name, color] of Object.entries(COLORS)) {
  const images = baseImages.map(({ size, rgba }) => ({
    size,
    png: encodePng(size, size, addStatusDot(Buffer.from(rgba), size, color))
  }));
  const ico = encodeIco(images);
  const file = path.join(OUT_DIR, `${name}.ico`);
  fs.writeFileSync(file, ico);
  made.push({ file: path.basename(file), bytes: ico.length });

  // 同时留一张 PNG 预览：.ico 在编辑器里看不到，出问题时没法核对画得对不对
  fs.writeFileSync(path.join(OUT_DIR, `preview-${name}.png`),
    images[images.length - 1].png);
}

// The desktop/start-menu icon has no status badge, at every Windows DPI size.
fs.writeFileSync(path.join(OUT_DIR, 'app.ico'), encodeIco(baseImages.map(({ size, rgba }) => ({
  size,
  png: encodePng(size, size, rgba)
}))));

// 顺带校验一遍自己写的 ICO 头，避免生成一堆坏文件还不知道
function verify(file) {
  const b = fs.readFileSync(file);
  const type = b.readUInt16LE(2);
  const count = b.readUInt16LE(4);
  const firstOff = b.readUInt32LE(6 + 12);
  const pngSig = b.slice(firstOff, firstOff + 8);
  const isPng = pngSig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { type, count, isPng, total: b.length, inBounds: firstOff < b.length };
}

console.log('\n生成图标：');
let ok = true;
for (const m of [...made, { file: 'app.ico', bytes: fs.statSync(path.join(OUT_DIR, 'app.ico')).size }]) {
  const v = verify(path.join(OUT_DIR, m.file));
  const good = v.type === 1 && v.count >= 1 && v.isPng && v.inBounds;
  if (!good) ok = false;
  console.log(`  ${good ? '✓' : '✗'} ${m.file.padEnd(12)} ${String(m.bytes).padStart(6)} 字节  ` +
    `内含 ${v.count} 种尺寸, PNG 负载=${v.isPng}`);
}
console.log(`\n输出目录: ${OUT_DIR}`);
console.log(ok ? '全部校验通过\n' : '有文件不合法\n');
process.exitCode = ok ? 0 : 1;
