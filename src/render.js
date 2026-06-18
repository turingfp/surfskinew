// Build a Three.js scene from a parsed GoldSrc BSP.
//
// GoldSrc is right-handed, Z-up; Three.js is right-handed, Y-up. We convert
// each vertex (x, y, z) -> (x, z, -y), which preserves handedness. Faces are
// grouped by texture into one merged BufferGeometry per material for speed.
//
// Texture sources, in priority order:
//   1. embedded miptex pixels decoded from the BSP (9 of 64 here)
//   2. a shared prototype/grid texture (Kenney) tinted per surface name
//   3. a flat colour derived from the surface name
// Most of surf_ski_2's textures live in an external WAD we don't ship, so the
// fallbacks carry the look. Tool textures (sky/clip/origin/...) are not drawn.

import * as THREE from '../vendor/three.module.js';
import { dot } from './vec.js';

// Max anisotropy of the active renderer. Set once at boot (setMaxAnisotropy);
// applied to every world texture so floors/ramps don't moiré into "weird
// lines" at grazing viewing angles — anisotropic filtering is what makes a
// high-frequency texture like snow read cleanly when minified toward the
// horizon.
let maxAniso = 1;
export function setMaxAnisotropy(n) { maxAniso = Math.max(1, n | 0); }

// GoldSrc unit -> Three position. Z-up to Y-up.
export const gs2three = (x, y, z) => [x, z, -y];

const SKIP_TEXTURES = new Set([
  'aaatrigger', 'clip', 'clipbevel', 'origin', 'hint', 'skip', 'trigger',
  'bevel', 'nodraw', 'null', 'contentempty', 'contentwater', 'contentsolid',
  'translucent', 'hintskip',
]);

function isSkyName(name) {
  const n = name.toLowerCase();
  return n === 'sky' || n.startsWith('sky');
}

// FNV-1a hash of a name -> uint32 (deterministic surface bucketing).
function nameHash(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic pleasant colour from a texture name (used to tint fallbacks).
function nameColor(name) {
  const hue = (nameHash(name) % 360) / 360;
  const c = new THREE.Color();
  c.setHSL(hue, 0.32, 0.55);
  return c;
}

// Embedded miptex -> texture. GoldSrc textures are usually non-power-of-two
// (e.g. snow is 240x240), and three.js won't reliably build a full mip chain
// for an NPOT DataTexture — without mips, anisotropic filtering has nothing to
// sample and a high-frequency floor texture moirés into "weird lines" toward
// the horizon. Drawing the pixels into a power-of-two canvas guarantees a clean
// mip chain on every GL backend; wrapping repeats it across the surface as
// before.
function embeddedTexture(tex) {
  const w = tex.width, h = tex.height;
  const src = document.createElement('canvas'); src.width = w; src.height = h;
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(w, h); img.data.set(tex.rgba); sctx.putImageData(img, 0, 0);
  return makeWorldTexture(src);
}

// Build a repeat-wrapped, mip-mapped world texture from any image/canvas source.
// Forces power-of-two dimensions and supplies an explicit box-filtered mip chain
// rather than relying on the GPU's glGenerateMipmap: NPOT textures (e.g. an
// 80x64 WAD floor) can't mipmap or repeat on iOS/WebGL1 and otherwise alias into
// "weird lines" at grazing angles, and auto-mip quality varies by backend.
export function makeWorldTexture(img, { srgb = true } = {}) {
  const w = img.width, h = img.height;
  const pw = Math.min(1024, nextPow2(w)), ph = Math.min(1024, nextPow2(h));
  let canvas;
  if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement && pw === w && ph === h) {
    canvas = img; // already a POT canvas — use directly
  } else {
    canvas = document.createElement('canvas'); canvas.width = pw; canvas.height = ph;
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, pw, ph);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter; // crisp GoldSrc look up close
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.mipmaps = buildMipChain(canvas);
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// Downscale a canvas to a full mip chain (level 0 = source, down to 1x1). Each
// level is the previous one redrawn at half size with bilinear smoothing, so
// high-frequency detail (snow, concrete) averages toward a clean colour when
// minified instead of shimmering.
function buildMipChain(base) {
  const mips = [base];
  let prev = base, w = base.width, h = base.height;
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.drawImage(prev, 0, 0, w, h);
    mips.push(c);
    prev = c;
  }
  return mips;
}

// Unlit base × lightmap, the authentic GoldSrc shading (lightMap uses uv1).
function materialFor(tex, fallbacks, lightMap, wadTex) {
  const masked = tex.masked;
  const common = lightMap ? { lightMap, lightMapIntensity: 1.0 } : {};
  const name = (tex.name || 'world').toLowerCase();
  let mat;
  if (tex.embedded && tex.rgba) { // 1. embedded in the BSP
    mat = new THREE.MeshBasicMaterial({ map: embeddedTexture(tex), transparent: masked, alphaTest: masked ? 0.5 : 0, side: THREE.DoubleSide, ...common });
  } else if (wadTex && wadTex.has(name)) { // 2. from a WAD
    const wm = wadTex.get(name); wm.anisotropy = maxAniso;
    mat = new THREE.MeshBasicMaterial({ map: wm, transparent: masked, alphaTest: masked ? 0.5 : 0, side: THREE.DoubleSide, ...common });
  } else if (fallbacks && fallbacks.length) { // 3. CC0 Kenney fallback
    const map = fallbacks[nameHash(name) % fallbacks.length].clone();
    map.anisotropy = maxAniso;
    map.needsUpdate = true;
    mat = new THREE.MeshBasicMaterial({ map, color: nameColor(name).lerp(new THREE.Color(0xffffff), 0.7), side: THREE.DoubleSide, ...common });
  } else {
    mat = new THREE.MeshBasicMaterial({ color: nameColor(name), side: THREE.DoubleSide, ...common });
  }
  // Water surfaces ('!' textures): translucent, single-sided, no depth write so
  // they don't z-fight / flash when the camera is inside the water. A small
  // negative polygon offset biases the surface consistently toward the camera so
  // it doesn't flicker against the coplanar pool floor as you move.
  if (name.startsWith('!') || name.includes('water')) {
    mat.transparent = true; mat.opacity = 0.7; mat.depthWrite = false; mat.side = THREE.FrontSide;
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1;
  }
  return mat;
}

// Compute a face's lightmap size + texture-space mins from its texinfo + verts.
function faceLightmap(bsp, face, ti, poly) {
  if (face.lightofs < 0 || !bsp.lighting || bsp.lighting.length === 0) return null;
  let minS = Infinity, maxS = -Infinity, minT = Infinity, maxT = -Infinity;
  for (const v of poly) {
    const s = dot(v, [ti.s[0], ti.s[1], ti.s[2]]) + ti.s[3];
    const t = dot(v, [ti.t[0], ti.t[1], ti.t[2]]) + ti.t[3];
    if (s < minS) minS = s; if (s > maxS) maxS = s;
    if (t < minT) minT = t; if (t > maxT) maxT = t;
  }
  const sMin = Math.floor(minS / 16), sMax = Math.ceil(maxS / 16);
  const tMin = Math.floor(minT / 16), tMax = Math.ceil(maxT / 16);
  const w = sMax - sMin + 1, h = tMax - tMin + 1;
  if (w < 1 || h < 1 || w > 256 || h > 256) return null;
  if (face.lightofs + w * h * 3 > bsp.lighting.length) return null;
  return { w, h, sMin, tMin };
}

// Build all renderable geometry. `fallbackTextures` is an array of THREE.Texture
// (the shipped Kenney prototype set) used for the external/WAD surfaces.
export function buildLevel(bsp, { fallbackTextures = [], wadTextures = null } = {}) {
  const group = new THREE.Group();
  group.name = 'surf_level';

  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const grow = (x, y, z) => {
    if (x < bounds.min[0]) bounds.min[0] = x; if (x > bounds.max[0]) bounds.max[0] = x;
    if (y < bounds.min[1]) bounds.min[1] = y; if (y > bounds.max[1]) bounds.max[1] = y;
    if (z < bounds.min[2]) bounds.min[2] = z; if (z > bounds.max[2]) bounds.max[2] = z;
  };

  // ---- Pass 1: collect renderable faces (+ lightmap info) ----
  const recs = [];
  let skipped = 0;
  for (const face of bsp.faces) {
    const ti = bsp.texinfo[face.texinfo];
    if (!ti) { skipped++; continue; }
    const tex = bsp.textures[ti.miptex] || { name: '', width: 64, height: 64 };
    const name = (tex.name || '').toLowerCase();
    if (isSkyName(name) || SKIP_TEXTURES.has(name) || (ti.flags & 1)) { skipped++; continue; }

    const poly = [];
    for (let j = 0; j < face.numedges; j++) {
      const se = bsp.surfedges[face.firstedge + j];
      const vi = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
      poly.push([bsp.vertices[vi * 3], bsp.vertices[vi * 3 + 1], bsp.vertices[vi * 3 + 2]]);
    }
    if (poly.length < 3) { skipped++; continue; }
    recs.push({ face, ti, tex, poly, lm: faceLightmap(bsp, face, ti, poly), tile: null });
  }

  // ---- Pack lightmaps into an atlas (shelf packing) ----
  const ATLAS_W = 2048, PAD = 1;
  let atlasH = 0;
  {
    const withLM = recs.filter((r) => r.lm).sort((a, b) => b.lm.h - a.lm.h);
    let x = PAD + 2, y = PAD, shelfH = 0; // reserve a white texel block at (0,0)
    for (const r of withLM) {
      const w = r.lm.w + PAD, h = r.lm.h + PAD;
      if (x + w > ATLAS_W) { x = PAD; y += shelfH; shelfH = 0; }
      if (y + h > 4096) { r.lm = null; continue; } // overflow -> no lightmap
      r.tile = { x, y };
      x += w; if (h > shelfH) shelfH = h;
    }
    atlasH = Math.min(4096, nextPow2(y + shelfH + PAD));
  }

  // ---- Build the atlas texture (white background; copy luxels) ----
  // GoldSrc bakes one small lightmap per face. On big surfaces split into many
  // tiled faces (e.g. surf_ski_2's snow ground) each face is nearly uniform but
  // a step brighter/darker than its neighbour, so the seams read as a harsh
  // patchwork / "weird lines" at grazing angles. Soften each luxel toward white
  // (keep only LM_SHADOW of the shadow depth) so the steps collapse into clean,
  // evenly-lit surfaces while a hint of baked shading remains.
  const LM_SHADOW = 0.2;
  let lightMap = null;
  if (atlasH > 0 && recs.some((r) => r.lm)) {
    const data = new Uint8Array(ATLAS_W * atlasH * 4).fill(255);
    for (const r of recs) {
      if (!r.lm || !r.tile) continue;
      const { w, h } = r.lm; const ofs = r.face.lightofs;
      for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < w; tx++) {
          const src = ofs + (ty * w + tx) * 3;
          const dx = r.tile.x + tx, dy = r.tile.y + ty;
          const d = (dy * ATLAS_W + dx) * 4;
          data[d] = 255 - (255 - bsp.lighting[src]) * LM_SHADOW;
          data[d + 1] = 255 - (255 - bsp.lighting[src + 1]) * LM_SHADOW;
          data[d + 2] = 255 - (255 - bsp.lighting[src + 2]) * LM_SHADOW;
          data[d + 3] = 255;
        }
      }
    }
    lightMap = new THREE.DataTexture(data, ATLAS_W, atlasH, THREE.RGBAFormat);
    lightMap.colorSpace = THREE.SRGBColorSpace;
    lightMap.minFilter = THREE.LinearFilter;
    lightMap.magFilter = THREE.LinearFilter;
    lightMap.needsUpdate = true;
  }

  // ---- Pass 2: build geometry grouped by texture, with base + lightmap UVs ----
  const buckets = new Map();
  let drawn = 0, lit = 0;
  for (const r of recs) {
    const { face, ti, tex, poly, lm, tile } = r;
    const tw = tex.width || 64, th = tex.height || 64;
    const plane = bsp.planes[face.planenum];
    let nx = plane.normal[0], ny = plane.normal[1], nz = plane.normal[2];
    if (face.side) { nx = -nx; ny = -ny; nz = -nz; }
    const tnx = nx, tny = nz, tnz = -ny;

    let bucket = buckets.get(ti.miptex);
    if (!bucket) { bucket = { positions: [], normals: [], uvs: [], uv1: [], indices: [], vbase: 0, tex }; buckets.set(ti.miptex, bucket); }
    const base = bucket.vbase;
    for (const v of poly) {
      const [tx, ty, tz] = gs2three(v[0], v[1], v[2]);
      grow(tx, ty, tz);
      bucket.positions.push(tx, ty, tz);
      bucket.normals.push(tnx, tny, tnz);
      const s = dot(v, [ti.s[0], ti.s[1], ti.s[2]]) + ti.s[3];
      const t = dot(v, [ti.t[0], ti.t[1], ti.t[2]]) + ti.t[3];
      bucket.uvs.push(s / tw, t / th);
      if (lm && tile) {
        const lu = (tile.x + (s / 16 - lm.sMin) + 0.5) / ATLAS_W;
        const lv = (tile.y + (t / 16 - lm.tMin) + 0.5) / atlasH;
        bucket.uv1.push(lu, lv);
      } else {
        bucket.uv1.push(0.5 / ATLAS_W, 0.5 / Math.max(1, atlasH)); // reserved white texel
      }
    }
    for (let j = 1; j < poly.length - 1; j++) bucket.indices.push(base, base + j, base + j + 1);
    bucket.vbase += poly.length;
    drawn++; if (lm) lit++;
  }

  for (const [, bucket] of buckets) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
    if (lightMap) geo.setAttribute('uv1', new THREE.Float32BufferAttribute(bucket.uv1, 2));
    geo.setIndex(bucket.indices);
    const mesh = new THREE.Mesh(geo, materialFor(bucket.tex, fallbackTextures, lightMap, wadTextures));
    mesh.frustumCulled = true;
    mesh.userData.texName = bucket.tex.name || '';
    group.add(mesh);
  }

  return { group, bounds, stats: { drawn, skipped, lit, materials: buckets.size, atlasH } };
}

function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

// Build Three meshes for a procedural brush map (see procmap.js). Brushes are
// oriented boxes; ramps render as translucent green "glass".
export function buildProcLevel(brushes) {
  const group = new THREE.Group();
  group.name = 'surf_arena';
  for (const b of brushes) {
    const geo = new THREE.BoxGeometry(b.he[0] * 2, b.he[1] * 2, b.he[2] * 2);
    const X = gs2three(b.axes[0][0], b.axes[0][1], b.axes[0][2]);
    const Y = gs2three(b.axes[1][0], b.axes[1][1], b.axes[1][2]);
    const Z = gs2three(b.axes[2][0], b.axes[2][1], b.axes[2][2]);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(X[0], X[1], X[2]), new THREE.Vector3(Y[0], Y[1], Y[2]), new THREE.Vector3(Z[0], Z[1], Z[2]),
    );
    const mat = new THREE.MeshLambertMaterial({
      color: b.color,
      transparent: !!b.glass,
      opacity: b.glass ? 0.55 : 1,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.setFromRotationMatrix(basis);
    const [px, py, pz] = gs2three(b.center[0], b.center[1], b.center[2]);
    mesh.position.set(px, py, pz);
    group.add(mesh);
  }
  return group;
}

// Build a small spinnable world mesh from a parsed MDL (w_ weapon models), in
// world space (GoldSrc -> three), centered at the origin so it spins in place.
export function buildWorldModel(data, { center = true } = {}) {
  const group = new THREE.Group();
  for (const g of data.groups) {
    const n = g.positions.length / 3;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = g.positions[i * 3]; pos[i * 3 + 1] = g.positions[i * 3 + 2]; pos[i * 3 + 2] = -g.positions[i * 3 + 1];
      nrm[i * 3] = g.normals[i * 3]; nrm[i * 3 + 1] = g.normals[i * 3 + 2]; nrm[i * 3 + 2] = -g.normals[i * 3 + 1];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
    let mat;
    if (g.tex) {
      const tex = new THREE.DataTexture(g.tex.rgba, g.tex.w, g.tex.h, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
      mat = new THREE.MeshLambertMaterial({ map: tex, transparent: g.tex.masked, alphaTest: g.tex.masked ? 0.5 : 0, side: THREE.DoubleSide });
    } else {
      mat = new THREE.MeshLambertMaterial({ color: 0x999999 });
    }
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false;
    group.add(m);
  }
  if (center) {
    // centre on the bbox so it rotates about itself (weapon pickups)
    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    group.children.forEach((m) => m.position.sub(c));
    // distance from the (now centred) origin down to the model's lowest point,
    // so callers can rest it on a floor (negative; in unscaled model units).
    group.userData.modelMinY = box.min.y - c.y;
  }
  return group;
}

// A simple vertical-gradient sky dome (the office WAD sky isn't shipped).
export function buildSky(top = 0x9fb8d6, bottom = 0xdfe9f2, radius = 30000) {
  const geo = new THREE.SphereGeometry(radius, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(top) },
      bottomColor: { value: new THREE.Color(bottom) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: `
      uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y * 0.5 + 0.5;
        gl_FragColor = vec4(mix(bottomColor, topColor, clamp(h,0.0,1.0)), 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}
