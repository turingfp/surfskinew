// Extract the textures our maps need from the provided GoldSrc WAD3 files and
// write them as PNGs (+ a manifest). Only textures actually referenced by a
// shipped .bsp (and present in a WAD) are emitted, so we don't dump whole WADs.
//   node tools/extract_wads.mjs
// WADs are read from /tmp/wads (not committed); PNGs go to assets/wadtex.

import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSP } from '../src/bsp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WAD_DIR = process.argv[2] || '/tmp/wads';
const OUT = join(ROOT, 'assets', 'wadtex');

// ---- PNG encoder ----
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const body = Buffer.concat([Buffer.from(t, 'ascii'), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(body), 0); return Buffer.concat([l, body, cr]); }
function png(w, h, rgba) {
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- WAD3 directory ----
function loadWad(p) {
  const d = readFileSync(p); const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'WAD3') return null;
  const n = dv.getInt32(4, true), off = dv.getInt32(8, true);
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const o = off + i * 32;
    const filepos = dv.getInt32(o, true); const type = dv.getUint8(o + 12);
    let name = ''; for (let c = 0; c < 16; c++) { const ch = dv.getUint8(o + 16 + c); if (!ch) break; name += String.fromCharCode(ch); }
    if (type === 0x43 && !entries.has(name.toLowerCase())) entries.set(name.toLowerCase(), { d, dv, filepos });
  }
  return entries;
}

// decode a miptex lump (8-bit palettized) at `base` into RGBA
function decodeMip(dv, base) {
  let name = ''; for (let c = 0; c < 16; c++) { const ch = dv.getUint8(base + c); if (!ch) break; name += String.fromCharCode(ch); }
  const w = dv.getUint32(base + 16, true), h = dv.getUint32(base + 20, true);
  const o0 = dv.getUint32(base + 24, true), o3 = dv.getUint32(base + 36, true);
  if (!w || !h || !o0) return null;
  const idx = base + o0;
  const pal = base + o3 + (w >> 3) * (h >> 3) + 2;
  const masked = name.startsWith('{');
  const rgba = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const ci = dv.getUint8(idx + p); const po = pal + ci * 3;
    rgba[p * 4] = dv.getUint8(po); rgba[p * 4 + 1] = dv.getUint8(po + 1); rgba[p * 4 + 2] = dv.getUint8(po + 2);
    rgba[p * 4 + 3] = (masked && ci === 255) ? 0 : 255;
  }
  return { w, h, rgba };
}

const SKIP = new Set(['aaatrigger', 'clip', 'clipbevel', 'origin', 'hint', 'skip', 'trigger', 'bevel', 'nodraw', 'null', 'sky']);

const wadFiles = readdirSync(WAD_DIR).filter((f) => /\.wad$/i.test(f));
const wads = wadFiles.map((f) => loadWad(join(WAD_DIR, f))).filter(Boolean);
console.log('loaded WADs:', wadFiles.join(', '));

// collect needed texture names across all maps
const need = new Set();
for (const f of readdirSync(join(ROOT, 'assets', 'maps'))) {
  if (!f.endsWith('.bsp')) continue;
  const b = readFileSync(join(ROOT, 'assets', 'maps', f));
  const bsp = new BSP(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  for (const t of bsp.textures) {
    const nm = (t.name || '').toLowerCase();
    if (!t.embedded && nm && !SKIP.has(nm) && !nm.startsWith('sky')) need.add(nm);
  }
}

// strip animated/random/special prefixes (+0 +a -0 -1 { ! ~) -> base name
const norm = (s) => s.replace(/^[+\-]\w/, '').replace(/^[{!~]/, '');

// index of WAD entries by normalised base name for fuzzy matching
const wadIndex = []; // {base, name, w, e}
for (const w of wads) for (const [name, e] of w) wadIndex.push({ base: norm(name), name, w, e });

function findEntry(nm) {
  for (const w of wads) { const e = w.get(nm); if (e) return e; }       // 1. exact
  const base = norm(nm);
  for (const it of wadIndex) if (it.base === base) return it.e;          // 2. ignore prefix
  const trimmed = base.replace(/[a-z]$/, '');                            // 3. drop trailing variant letter
  if (trimmed !== base) for (const it of wadIndex) if (it.base === trimmed) return it.e;
  // 4. longest common-prefix fuzzy (>= 6 chars), pick the best
  let best = null, bestLen = 5;
  for (const it of wadIndex) {
    let k = 0; const a = it.base, b = base; while (k < a.length && k < b.length && a[k] === b[k]) k++;
    if (k > bestLen) { bestLen = k; best = it.e; }
  }
  return best;
}

mkdirSync(OUT, { recursive: true });
const manifest = [];
let bytes = 0;
for (const nm of need) {
  const e = findEntry(nm);
  if (!e) continue;
  const mip = decodeMip(e.dv, e.filepos);
  if (!mip) continue;
  const buf = png(mip.w, mip.h, mip.rgba);
  writeFileSync(join(OUT, `${nm}.png`), buf);
  manifest.push(nm); bytes += buf.length;
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest));
console.log(`extracted ${manifest.length}/${need.size} needed textures, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
