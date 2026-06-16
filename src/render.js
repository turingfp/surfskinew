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

function embeddedTexture(tex) {
  const data = new Uint8Array(tex.rgba); // already RGBA
  const t = new THREE.DataTexture(data, tex.width, tex.height, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function materialFor(tex, fallbacks) {
  const masked = tex.masked;
  if (tex.embedded && tex.rgba) {
    return new THREE.MeshLambertMaterial({
      map: embeddedTexture(tex),
      transparent: masked,
      alphaTest: masked ? 0.5 : 0,
      side: THREE.DoubleSide,
    });
  }
  const name = tex.name || 'world';
  // Pick one of the shipped CC0 Kenney prototype textures by name hash so the
  // many external/WAD surfaces get stable, varied looks. A faint name tint
  // keeps adjacent surfaces distinguishable without hiding the texture.
  if (fallbacks && fallbacks.length) {
    const map = fallbacks[nameHash(name) % fallbacks.length].clone();
    map.needsUpdate = true;
    const tint = nameColor(name).lerp(new THREE.Color(0xffffff), 0.7);
    return new THREE.MeshLambertMaterial({ map, color: tint, side: THREE.DoubleSide });
  }
  return new THREE.MeshLambertMaterial({ color: nameColor(name), side: THREE.DoubleSide });
}

// Build all renderable geometry. `fallbackTextures` is an array of THREE.Texture
// (the shipped Kenney prototype set) used for the external/WAD surfaces.
export function buildLevel(bsp, { fallbackTextures = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'surf_ski_2';

  // Bucket faces by miptex so we can merge them into one mesh per texture.
  const buckets = new Map(); // miptex -> { positions, normals, uvs, indices, vbase }

  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  const grow = (x, y, z) => {
    if (x < bounds.min[0]) bounds.min[0] = x; if (x > bounds.max[0]) bounds.max[0] = x;
    if (y < bounds.min[1]) bounds.min[1] = y; if (y > bounds.max[1]) bounds.max[1] = y;
    if (z < bounds.min[2]) bounds.min[2] = z; if (z > bounds.max[2]) bounds.max[2] = z;
  };

  let drawn = 0, skipped = 0;

  for (const face of bsp.faces) {
    const ti = bsp.texinfo[face.texinfo];
    if (!ti) { skipped++; continue; }
    const tex = bsp.textures[ti.miptex] || { name: '', width: 64, height: 64 };
    const name = (tex.name || '').toLowerCase();
    if (isSkyName(name) || SKIP_TEXTURES.has(name) || (ti.flags & 1)) { skipped++; continue; }

    const plane = bsp.planes[face.planenum];
    let nx = plane.normal[0], ny = plane.normal[1], nz = plane.normal[2];
    if (face.side) { nx = -nx; ny = -ny; nz = -nz; }
    // normal transformed to three space (no translation)
    const tnx = nx, tny = nz, tnz = -ny;

    const tw = tex.width || 64, th = tex.height || 64;

    // collect polygon vertices (GS coords) in winding order
    const poly = [];
    for (let j = 0; j < face.numedges; j++) {
      const se = bsp.surfedges[face.firstedge + j];
      let vi;
      if (se >= 0) vi = bsp.edges[se * 2];
      else vi = bsp.edges[-se * 2 + 1];
      poly.push([
        bsp.vertices[vi * 3],
        bsp.vertices[vi * 3 + 1],
        bsp.vertices[vi * 3 + 2],
      ]);
    }
    if (poly.length < 3) { skipped++; continue; }

    let bucket = buckets.get(ti.miptex);
    if (!bucket) {
      bucket = { positions: [], normals: [], uvs: [], indices: [], vbase: 0, tex };
      buckets.set(ti.miptex, bucket);
    }

    const base = bucket.vbase;
    for (const v of poly) {
      const [tx, ty, tz] = gs2three(v[0], v[1], v[2]);
      grow(tx, ty, tz);
      bucket.positions.push(tx, ty, tz);
      bucket.normals.push(tnx, tny, tnz);
      const u = (dot(v, [ti.s[0], ti.s[1], ti.s[2]]) + ti.s[3]) / tw;
      const vv = (dot(v, [ti.t[0], ti.t[1], ti.t[2]]) + ti.t[3]) / th;
      bucket.uvs.push(u, vv);
    }
    // triangle fan
    for (let j = 1; j < poly.length - 1; j++) {
      bucket.indices.push(base, base + j, base + j + 1);
    }
    bucket.vbase += poly.length;
    drawn++;
  }

  for (const [, bucket] of buckets) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
    geo.setIndex(bucket.indices);
    const mat = materialFor(bucket.tex, fallbackTextures);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true;
    group.add(mesh);
  }

  return { group, bounds, stats: { drawn, skipped, materials: buckets.size } };
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
