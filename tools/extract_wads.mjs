// Extract the textures our maps need from the provided GoldSrc WAD3 files and
// write them as PNGs (+ a manifest). Only textures actually referenced by a
// shipped .bsp (and present in a WAD) are emitted, so we don't dump whole WADs.
//   node tools/extract_wads.mjs
// WADs are read from /tmp/wads (not committed); PNGs go to assets/wadtex.

import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSP } from '../src/bsp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WAD_DIR = process.argv[2] || '/tmp/wads';
// High-fidelity originals: VTF versions of the exact-named GoldSrc textures.
// These are preferred over WAD fuzzy/category matches when present.
const VTF_DIR = process.argv[3] || '/tmp/hltex/goldsrc_textures/materials';
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

// ---- VTF (Valve Texture Format) + DXT decode ------------------------------
// The supplied hl1_textures set stores each texture as a VTF whose name matches
// the .bsp's texture name exactly, so we get the precise original pixels (DXT5)
// instead of a fuzzy WAD stand-in. Mipmaps are stored smallest->largest, so the
// full-resolution image is the last mip in the file (after a low-res thumbnail).
const VTF_FMT = { RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15 };

function rgb565(c, out, o) {
  const r = (c >> 11) & 0x1f, g = (c >> 5) & 0x3f, b = c & 0x1f;
  out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2);
}

// bytes occupied by one mip of the given format at w x h
function fmtSize(fmt, w, h) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  if (fmt === VTF_FMT.DXT1) return bw * bh * 8;
  if (fmt === VTF_FMT.DXT3 || fmt === VTF_FMT.DXT5) return bw * bh * 16;
  if (fmt === VTF_FMT.RGB888 || fmt === VTF_FMT.BGR888) return w * h * 3;
  return w * h * 4; // RGBA8888 / BGRA8888 / ABGR8888
}

// decode one mip into RGBA, given the raw file buffer + byte offset
function decodeVTFmip(d, off, w, h, fmt) {
  const rgba = Buffer.alloc(w * h * 4);
  const blocksX = Math.max(1, (w + 3) >> 2);
  const put = (px, py, r, g, b, a) => {
    if (px >= w || py >= h) return;
    const o = (py * w + px) * 4; rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
  };
  if (fmt === VTF_FMT.DXT1 || fmt === VTF_FMT.DXT3 || fmt === VTF_FMT.DXT5) {
    const blocksY = Math.max(1, (h + 3) >> 2);
    const blockBytes = fmt === VTF_FMT.DXT1 ? 8 : 16;
    const col = Buffer.alloc(16); // 4 colours * RGB(A)
    for (let by = 0; by < blocksY; by++) for (let bx = 0; bx < blocksX; bx++) {
      let p = off + (by * blocksX + bx) * blockBytes;
      const alpha = new Uint8Array(16).fill(255);
      if (fmt === VTF_FMT.DXT5) {
        const a0 = d[p], a1 = d[p + 1];
        const at = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) for (let i = 1; i <= 6; i++) at[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
        else { for (let i = 1; i <= 4; i++) at[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0; at[6] = 0; at[7] = 255; }
        let bits = 0n; for (let i = 0; i < 6; i++) bits |= BigInt(d[p + 2 + i]) << BigInt(8 * i);
        for (let i = 0; i < 16; i++) alpha[i] = at[Number((bits >> BigInt(3 * i)) & 7n)];
        p += 8;
      } else if (fmt === VTF_FMT.DXT3) {
        for (let i = 0; i < 8; i++) { const byte = d[p + i]; alpha[i * 2] = (byte & 0x0f) * 17; alpha[i * 2 + 1] = (byte >> 4) * 17; }
        p += 8;
      }
      const c0 = d[p] | (d[p + 1] << 8), c1 = d[p + 2] | (d[p + 3] << 8);
      rgb565(c0, col, 0); rgb565(c1, col, 4);
      const dxt1Punch = fmt === VTF_FMT.DXT1 && c0 <= c1;
      if (dxt1Punch) {
        for (let k = 0; k < 3; k++) { col[8 + k] = (col[k] + col[4 + k]) >> 1; col[12 + k] = 0; }
      } else {
        for (let k = 0; k < 3; k++) { col[8 + k] = (2 * col[k] + col[4 + k]) / 3 | 0; col[12 + k] = (col[k] + 2 * col[4 + k]) / 3 | 0; }
      }
      const idx = d[p + 4] | (d[p + 5] << 8) | (d[p + 6] << 16) | (d[p + 7] << 24);
      for (let i = 0; i < 16; i++) {
        const ci = (idx >>> (2 * i)) & 3;
        let a = alpha[i];
        if (fmt === VTF_FMT.DXT1 && dxt1Punch && ci === 3) a = 0; // 1-bit punch-through
        put(bx * 4 + (i & 3), by * 4 + (i >> 2), col[ci * 4], col[ci * 4 + 1], col[ci * 4 + 2], a);
      }
    }
    return rgba;
  }
  // uncompressed
  for (let i = 0; i < w * h; i++) {
    if (fmt === VTF_FMT.RGBA8888) { rgba[i * 4] = d[off + i * 4]; rgba[i * 4 + 1] = d[off + i * 4 + 1]; rgba[i * 4 + 2] = d[off + i * 4 + 2]; rgba[i * 4 + 3] = d[off + i * 4 + 3]; }
    else if (fmt === VTF_FMT.BGRA8888) { rgba[i * 4] = d[off + i * 4 + 2]; rgba[i * 4 + 1] = d[off + i * 4 + 1]; rgba[i * 4 + 2] = d[off + i * 4]; rgba[i * 4 + 3] = d[off + i * 4 + 3]; }
    else if (fmt === VTF_FMT.RGB888) { rgba[i * 4] = d[off + i * 3]; rgba[i * 4 + 1] = d[off + i * 3 + 1]; rgba[i * 4 + 2] = d[off + i * 3 + 2]; rgba[i * 4 + 3] = 255; }
    else if (fmt === VTF_FMT.BGR888) { rgba[i * 4] = d[off + i * 3 + 2]; rgba[i * 4 + 1] = d[off + i * 3 + 1]; rgba[i * 4 + 2] = d[off + i * 3]; rgba[i * 4 + 3] = 255; }
  }
  return rgba;
}

function decodeVTF(path, name) {
  const d = readFileSync(path);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (String.fromCharCode(d[0], d[1], d[2], d[3]) !== 'VTF\0') return null;
  const headerSize = dv.getInt32(12, true);
  const w = dv.getUint16(16, true), h = dv.getUint16(18, true);
  const hiFmt = dv.getInt32(52, true);
  const mipCount = dv.getUint8(56);
  const loFmt = dv.getInt32(57, true);
  const loW = dv.getUint8(61), loH = dv.getUint8(62);
  if (!w || !h) return null;
  // image data: low-res thumbnail, then mips smallest->largest (mip0 last)
  let off = headerSize;
  if (loW && loH && loFmt >= 0) off += fmtSize(loFmt, loW, loH);
  for (let m = mipCount - 1; m >= 1; m--) {
    off += fmtSize(hiFmt, Math.max(1, w >> m), Math.max(1, h >> m));
  }
  const rgba = decodeVTFmip(d, off, w, h, hiFmt);
  // masked '{' textures: GoldSrc keys the brightest-blue palette index out. The
  // VTF keeps the original blue pixels, so re-derive the mask from blue dominance.
  if (name.startsWith('{')) {
    for (let i = 0; i < w * h; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      if (b > 100 && b > r * 1.6 && b > g * 1.6) rgba[i * 4 + 3] = 0;
    }
  }
  return { w, h, rgba };
}

// index of available VTFs by lowercase basename (halflife + decals + liquids)
function loadVtfIndex(baseDir) {
  const idx = new Map();
  if (!existsSync(baseDir)) return idx;
  for (const sub of ['halflife', 'decals', 'liquids']) {
    const dir = join(baseDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.vtf$/i.test(f)) continue;
      const key = f.slice(0, -4).toLowerCase();
      if (!idx.has(key)) idx.set(key, join(dir, f));
    }
  }
  return idx;
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

// average colour stats for a miptex (sampled) -> saturation + luminance + size
function stats(dv, base) {
  const w = dv.getUint32(base + 16, true), h = dv.getUint32(base + 20, true);
  const o0 = dv.getUint32(base + 24, true), o3 = dv.getUint32(base + 36, true);
  if (!w || !h || !o0) return { w: 0, sat: 1, lum: 0 };
  const pal = base + o3 + (w >> 3) * (h >> 3) + 2;
  const idxBase = base + o0; const n = w * h; const step = Math.max(1, (n / 256) | 0);
  let r = 0, g = 0, b = 0, cnt = 0;
  for (let p = 0; p < n; p += step) {
    const ci = dv.getUint8(idxBase + p); const po = pal + ci * 3;
    r += dv.getUint8(po); g += dv.getUint8(po + 1); b += dv.getUint8(po + 2); cnt++;
  }
  r /= cnt; g /= cnt; b /= cnt;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return { w, sat: mx ? (mx - mn) / mx : 0, lum: 0.3 * r + 0.59 * g + 0.11 * b };
}

// index of WAD entries by normalised base name for fuzzy matching (+ colour stats)
const wadIndex = []; // {base, name, w, e, sat, lum}
for (const w of wads) for (const [name, e] of w) {
  const s = stats(e.dv, e.filepos);
  wadIndex.push({ base: norm(name), name, w, e, sat: s.sat, lum: s.lum, size: s.w });
}
const clean = (it) => it.sat < 0.32 && it.lum > 55 && it.lum < 225 && it.size >= 64 && !/^[+~]/.test(it.name);
// a neutral, light-ish stand-in used when nothing else fits (avoids busy/garish textures)
const DEFAULT = wadIndex.filter((it) => clean(it) && /wall|crete|generic|out_|tile|cliff|rock/.test(it.name))
  .sort((a, b) => Math.abs(150 - a.lum) - Math.abs(150 - b.lum))[0] || wadIndex[0];

// category -> WAD-name search terms, used to pick a "good enough" real texture
// when there's no exact/fuzzy match (so we never show a flat placeholder).
const CATEGORY = [
  [/(^!)|water|wave|liquid/, ['water', 'wave', 'blue']],
  [/ladder|grate|bars|rail|fence|vent|grid|grill/, ['ladder', 'grate', 'bars', 'fence', 'grid']],
  [/glass|window|mirror/, ['glass', 'window']],
  [/crate|box|crat|barrel/, ['crate', 'box', 'barrel']],
  [/door|gate|hatch/, ['door', 'gate']],
  [/floor|flr|_f0|grnd|ground|sand|dirt|grass|carpet/, ['floor', 'flr', 'ground', 'grnd', 'sand']],
  [/button|btn|switch|panel/, ['button', 'switch', 'panel']],
  [/metal|mtl|vat|tank|pipe|duct|steel|vent/, ['metal', 'mtl', 'pipe', 'vent', 'tank']],
  [/wall|brick|crete|concrete|cinder|stone|tile|lab|fifties|generic/, ['wall', 'crete', 'brick', 'tile', 'generic']],
];

function searchWad(terms, maskedPref) {
  for (const wantMasked of (maskedPref ? [true, false] : [false, true])) {
    let best = null, bestSat = 2;
    for (const t of terms) {
      for (const it of wadIndex) {
        if (it.name.startsWith('{') !== wantMasked) continue;
        if (!it.name.includes(t)) continue;
        // prefer clean (low-saturation, mid-bright) textures
        if (clean(it) && it.sat < bestSat) { best = it; bestSat = it.sat; }
        else if (!best) best = it;
      }
    }
    if (best) return best.e;
  }
  return null;
}

function findEntry(nm) {
  for (const w of wads) { const e = w.get(nm); if (e) return e; }       // 1. exact
  const base = norm(nm);
  for (const it of wadIndex) if (it.base === base) return it.e;          // 2. ignore prefix
  const trimmed = base.replace(/[a-z]$/, '');                            // 3. drop trailing variant letter
  if (trimmed !== base) for (const it of wadIndex) if (it.base === trimmed) return it.e;
  let best = null, bestLen = 5;                                          // 4. longest common prefix
  for (const it of wadIndex) {
    let k = 0; const a = it.base, b = base; while (k < a.length && k < b.length && a[k] === b[k]) k++;
    if (k > bestLen) { bestLen = k; best = it.e; }
  }
  if (best) return best;
  // 5. category-based clean "good enough" texture (never a placeholder)
  const masked = nm.startsWith('{');
  for (const [re, terms] of CATEGORY) if (re.test(nm)) { const e = searchWad(terms, masked); if (e) return e; }
  return searchWad(['wall', 'crete', 'generic', 'tile'], masked) || (DEFAULT && DEFAULT.e) || wadIndex[0]?.e || null;
}

const vtfIndex = loadVtfIndex(VTF_DIR);
console.log(`VTF originals available: ${vtfIndex.size}`);

mkdirSync(OUT, { recursive: true });
const manifest = [];
let bytes = 0;
let viaVtf = 0, viaWad = 0;
for (const nm of need) {
  let mip = null;
  // 1. prefer the exact-named VTF original (precise pixels)
  const vtfPath = vtfIndex.get(nm);
  if (vtfPath) { try { mip = decodeVTF(vtfPath, nm); if (mip) viaVtf++; } catch { mip = null; } }
  // 2. fall back to WAD (exact -> fuzzy -> category -> default)
  if (!mip) {
    const e = findEntry(nm);
    if (!e) continue;
    mip = decodeMip(e.dv, e.filepos);
    if (mip) viaWad++;
  }
  if (!mip) continue;
  const buf = png(mip.w, mip.h, mip.rgba);
  writeFileSync(join(OUT, `${nm}.png`), buf);
  manifest.push(nm); bytes += buf.length;
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest));
console.log(`extracted ${manifest.length}/${need.size} needed textures (${viaVtf} VTF originals, ${viaWad} WAD), ${(bytes / 1024 / 1024).toFixed(1)} MB`);
