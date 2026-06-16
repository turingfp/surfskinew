// Generates assets/textures/prototype.png — a tileable "dev"/prototype grid
// texture (classic orange-grey look) used as the fallback for the external WAD
// surfaces that surf_ski_2 references but we don't ship. Self-contained PNG
// encoder (zlib only) so there are no asset/network dependencies.
//
//   node tools/gen_texture.mjs
//
// Want the real thing? Drop a CC0 texture from https://kenney.nl (Prototype
// Textures) at assets/textures/prototype.png and it will be used automatically.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 512;

const px = new Uint8Array(SIZE * SIZE * 4);
function set(x, y, r, g, b, a = 255) {
  const o = (y * SIZE + x) * 4;
  px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
}

// base: two-tone checker (64px cells)
const A = [110, 112, 120];   // grey
const B = [96, 98, 106];     // darker grey
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cell = ((x >> 6) + (y >> 6)) & 1;
    const c = cell ? A : B;
    set(x, y, c[0], c[1], c[2]);
  }
}
// grid lines every 64px (tileable: line at 0 wraps with line at SIZE)
const line = [196, 150, 90]; // warm dev-orange
for (let i = 0; i < SIZE; i += 64) {
  for (let k = 0; k < SIZE; k++) {
    set(i, k, line[0], line[1], line[2]);
    set((i + 1) % SIZE, k, line[0], line[1], line[2]);
    set(k, i, line[0], line[1], line[2]);
    set(k, (i + 1) % SIZE, line[0], line[1], line[2]);
  }
}
// subtle finer grid every 16px
for (let i = 0; i < SIZE; i += 16) {
  if (i % 64 === 0) continue;
  for (let k = 0; k < SIZE; k++) {
    const o1 = (k * SIZE + i) * 4; px[o1] = Math.min(255, px[o1] + 18); px[o1 + 1] += 14; px[o1 + 2] += 8;
    const o2 = (i * SIZE + k) * 4; px[o2] = Math.min(255, px[o2] + 18); px[o2 + 1] += 14; px[o2 + 2] += 8;
  }
}

// ---- minimal PNG (RGBA, no interlace) --------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// filter byte 0 per scanline
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    raw[y * (SIZE * 4 + 1) + 1 + i] = v;
  });
}
const idat = deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

mkdirSync(join(ROOT, 'assets', 'textures'), { recursive: true });
const out = join(ROOT, 'assets', 'textures', 'prototype.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
