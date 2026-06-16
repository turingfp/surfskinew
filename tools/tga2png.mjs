// Convert the office skybox TGAs (24-bit uncompressed) to PNG cube faces.
//   node tools/tga2png.mjs
// Output: assets/skybox/{ft,bk,up,dn,lf,rt}.png

import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || '/tmp/rp/gfx/env';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function tgaToRGBA(buf) {
  const idlen = buf[0];
  const imgtype = buf[2];
  const w = buf.readUInt16LE(12), h = buf.readUInt16LE(14);
  const bpp = buf[16], desc = buf[17];
  if (imgtype !== 2) throw new Error(`unsupported TGA type ${imgtype}`);
  const bytespp = bpp / 8;
  let o = 18 + idlen;
  const topLeft = (desc & 0x20) !== 0;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = topLeft ? y : (h - 1 - y);
    for (let x = 0; x < w; x++) {
      const b = buf[o], g = buf[o + 1], r = buf[o + 2];
      const a = bytespp === 4 ? buf[o + 3] : 255;
      o += bytespp;
      const d = (row * w + x) * 4;
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    }
  }
  return { w, h, rgba: out };
}

mkdirSync(join(ROOT, 'assets', 'skybox'), { recursive: true });
const faces = { ft: 'officeft', bk: 'officebk', up: 'officeup', dn: 'officedn', lf: 'officelf', rt: 'officert' };
for (const [name, file] of Object.entries(faces)) {
  const { w, h, rgba } = tgaToRGBA(readFileSync(join(SRC, `${file}.tga`)));
  const out = join(ROOT, 'assets', 'skybox', `${name}.png`);
  writeFileSync(out, encodePNG(w, h, rgba));
  console.log(`wrote ${out} (${w}x${h})`);
}
