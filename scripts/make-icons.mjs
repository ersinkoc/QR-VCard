// Generates the PWA icon set as real PNGs, dependency-free (zlib + hand-rolled PNG chunks).
// Rerun with: npm run icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');

const BG = [25, 25, 33]; // dark ink (oklch 18% 0.01 260 approximation)
const FG = [111, 122, 247]; // accent indigo (oklch 58% 0.16 264 approximation)
const WHITE = [251, 251, 253];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  const flat = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length);
  for (let y = 0; y < height; y++) {
    flat.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawIcon(size, { maskable = false } = {}) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const fill = (x, y, w, h, c, a = 255) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c, a);
  };

  fill(0, 0, size, size, maskable ? BG : FG);

  const inset = maskable ? Math.round(size * 0.18) : 0;
  const inner = size - inset * 2;
  const grid = maskable ? 0 : Math.round(size * 0.06); // code area padding on colored bg

  // QR-style finder squares (top-left, top-right, bottom-left)
  const fs = Math.round(inner * 0.30);
  const positions = maskable
    ? [[inset, inset], [size - inset - fs, inset], [inset, size - inset - fs]]
    : [[grid, grid], [size - grid - fs, grid], [grid, size - grid - fs]];
  for (const [fx, fy] of positions) {
    fill(fx, fy, fs, fs, maskable ? FG : WHITE);
    const bar = Math.round(fs * 0.22);
    fill(fx + bar, fy + bar, fs - bar * 2, fs - bar * 2, BG);
    const dot = Math.round(fs * 0.42);
    const off = Math.round((fs - dot) / 2);
    fill(fx + off, fy + off, dot, dot, maskable ? FG : WHITE);
  }

  // deterministic data dots in the remaining area
  const rng = mulberry32(42);
  const cell = Math.max(2, Math.round(inner / 22));
  const field = maskable ? { x: inset, y: inset, s: inner } : { x: grid, y: grid, s: size - grid * 2 };
  for (let gy = field.y; gy < field.y + field.s - cell; gy += cell) {
    for (let gx = field.x; gx < field.x + field.s - cell; gx += cell) {
      const inFinder = positions.some(([fx, fy]) => gx < fx + fs + cell && gy < fy + fs + cell && gx + cell > fx - cell && gy + cell > fy - cell);
      if (!inFinder && rng() > 0.55) fill(gx + 1, gy + 1, cell - 2, cell - 2, maskable ? FG : WHITE, 235);
    }
  }
  return px;
}

mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of [
  ['pwa-192.png', 192, {}],
  ['pwa-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true }],
]) {
  writeFileSync(join(OUT, name), encodePng(size, size, drawIcon(size, opts)));
  console.log(`wrote public/${name}`);
}
