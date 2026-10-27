// Generates the PWA icon set as real PNGs, dependency-free (zlib + hand-rolled PNG chunks).
// Rerun with: npm run icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');

const COBALT = [36, 87, 245];
const WHITE = [255, 255, 255];

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

  fill(0, 0, size, size, COBALT);
  const content = size * (maskable ? 0.58 : 0.72);
  const unit = content / 32;
  const origin = (size - content) / 2;
  const box = (x, y, w, h) => fill(Math.round(origin + x * unit), Math.round(origin + y * unit), Math.round(w * unit), Math.round(h * unit), WHITE);
  const outline = (x, y, side) => {
    const stroke = 2.6;
    box(x, y, side, stroke);
    box(x, y + side - stroke, side, stroke);
    box(x, y, stroke, side);
    box(x + side - stroke, y, stroke, side);
  };
  outline(0, 0, 10);
  outline(22, 0, 10);
  outline(0, 22, 10);
  box(22, 22, 4, 4);
  box(28, 22, 4, 4);
  box(22, 28, 4, 4);
  box(28, 28, 4, 4);
  box(9, 8, 14, 2.6);
  box(8, 9, 2.6, 14);
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
