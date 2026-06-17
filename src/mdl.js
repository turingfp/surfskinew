// Minimal GoldSrc StudioModel (.mdl, IDST v10) parser — enough to render a
// weapon view model in its reference (bind) pose with embedded textures.
//
// Parses bones (default pose), bodyparts/models/meshes, triangle commands,
// vertices/normals (skinned to bones), and 8-bit palettized textures. Returns
// per-texture geometry buffers ready to drop into Three.js. Matrix/quaternion
// math is done locally so this stays dependency-free and node-testable.

// ---- tiny 3x4 matrix (row-major: [r0c0,r0c1,r0c2,tx, r1..., r2...]) ---------
function angleQuaternion(rx, ry, rz) {
  // GoldSrc AngleQuaternion(angles[roll,pitch,yaw]) with angles=(rx,ry,rz)
  const sy = Math.sin(rz * 0.5), cy = Math.cos(rz * 0.5);
  const sp = Math.sin(ry * 0.5), cp = Math.cos(ry * 0.5);
  const sr = Math.sin(rx * 0.5), cr = Math.cos(rx * 0.5);
  return [
    sr * cp * cy - cr * sp * sy, // x
    cr * sp * cy + sr * cp * sy, // y
    cr * cp * sy - sr * sp * cy, // z
    cr * cp * cy + sr * sp * sy, // w
  ];
}

function quatMatrix(q, px, py, pz) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y, px,
    2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x, py,
    2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y, pz,
  ];
}

function concat(a, b) {
  // a * b (a is parent), both 3x4
  return [
    a[0] * b[0] + a[1] * b[4] + a[2] * b[8],
    a[0] * b[1] + a[1] * b[5] + a[2] * b[9],
    a[0] * b[2] + a[1] * b[6] + a[2] * b[10],
    a[0] * b[3] + a[1] * b[7] + a[2] * b[11] + a[3],
    a[4] * b[0] + a[5] * b[4] + a[6] * b[8],
    a[4] * b[1] + a[5] * b[5] + a[6] * b[9],
    a[4] * b[2] + a[5] * b[6] + a[6] * b[10],
    a[4] * b[3] + a[5] * b[7] + a[6] * b[11] + a[7],
    a[8] * b[0] + a[9] * b[4] + a[10] * b[8],
    a[8] * b[1] + a[9] * b[5] + a[10] * b[9],
    a[8] * b[2] + a[9] * b[6] + a[10] * b[10],
    a[8] * b[3] + a[9] * b[7] + a[10] * b[11] + a[11],
  ];
}
const xformPoint = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
  m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
  m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
];
const xformDir = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
  m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
];

export function parseMDL(arrayBuffer, opts = {}) {
  const skip = new Set(opts.skipBodyparts || []);
  const dv = new DataView(arrayBuffer);
  const i32 = (o) => dv.getInt32(o, true);
  const f32 = (o) => dv.getFloat32(o, true);
  const u8 = (o) => dv.getUint8(o);
  const i16 = (o) => dv.getInt16(o, true);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = u8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };

  if (dv.getUint32(0, true) !== 0x54534449) throw new Error('not an IDST mdl'); // "IDST"

  const numbones = i32(140), boneindex = i32(144);
  const numtextures = i32(180), textureindex = i32(184);
  const numskinref = i32(192), skinindex = i32(200);
  const numbodyparts = i32(204), bodypartindex = i32(208);

  // ---- bones -> world matrices (reference pose) ----
  const world = new Array(numbones);
  for (let b = 0; b < numbones; b++) {
    // mstudiobone_t: name[32], parent@32, flags@36, bonecontroller[6]@40,
    // value[6]@64 (pos xyz + rot xyz), scale[6]@88.
    const o = boneindex + b * 112;
    const parent = i32(o + 32);
    const vx = f32(o + 64), vy = f32(o + 68), vz = f32(o + 72);
    const rx = f32(o + 76), ry = f32(o + 80), rz = f32(o + 84);
    const local = quatMatrix(angleQuaternion(rx, ry, rz), vx, vy, vz);
    world[b] = parent >= 0 ? concat(world[parent], local) : local;
  }

  // ---- textures (8-bit palettized) ----
  const textures = [];
  for (let t = 0; t < numtextures; t++) {
    const o = textureindex + t * 80;
    const flags = i32(o + 64);
    const w = i32(o + 68), h = i32(o + 72), idx = i32(o + 76);
    const pal = idx + w * h;
    const masked = (flags & 0x40) !== 0;
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const ci = u8(idx + p);
      const po = pal + ci * 3;
      rgba[p * 4] = u8(po); rgba[p * 4 + 1] = u8(po + 1); rgba[p * 4 + 2] = u8(po + 2);
      rgba[p * 4 + 3] = (masked && ci === 255) ? 0 : 255;
    }
    textures.push({ w, h, rgba, masked });
  }
  // skin table (family 0): skinref -> texture index
  const skin = [];
  for (let s = 0; s < numskinref; s++) skin.push(i16(skinindex + s * 2));

  // ---- geometry, grouped by texture ----
  const buckets = new Map(); // texIndex -> {pos:[], nrm:[], uv:[]}
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  const grow = (p) => { for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; } };

  for (let bp = 0; bp < numbodyparts; bp++) {
    const o = bodypartindex + bp * 76;
    if (skip.has(str(o, 64).toLowerCase())) continue; // e.g. skip the unused "lhand"
    const modelindex = i32(o + 72);
    // use base submodel (index 0)
    const mo = modelindex;
    const nummesh = i32(mo + 64 + 8);
    const meshindex = i32(mo + 64 + 12);
    const numverts = i32(mo + 64 + 16);
    const vertinfoindex = i32(mo + 64 + 20);
    const vertindex = i32(mo + 64 + 24);
    const numnorms = i32(mo + 64 + 28);
    const norminfoindex = i32(mo + 64 + 32);
    const normindex = i32(mo + 64 + 36);

    // transform verts & normals by their bone
    const verts = new Array(numverts);
    for (let v = 0; v < numverts; v++) {
      const bone = u8(vertinfoindex + v);
      const vo = vertindex + v * 12;
      verts[v] = xformPoint(world[bone], [f32(vo), f32(vo + 4), f32(vo + 8)]);
    }
    const norms = new Array(numnorms);
    for (let n = 0; n < numnorms; n++) {
      const bone = u8(norminfoindex + n);
      const no = normindex + n * 12;
      norms[n] = xformDir(world[bone], [f32(no), f32(no + 4), f32(no + 8)]);
    }

    for (let m = 0; m < nummesh; m++) {
      const meo = meshindex + m * 20;
      let tri = i32(meo + 4);
      const skinref = i32(meo + 8);
      const texIdx = skin[skinref] ?? skinref;
      const tex = textures[texIdx] || { w: 64, h: 64 };
      let bucket = buckets.get(texIdx);
      if (!bucket) { bucket = { pos: [], nrm: [], uv: [] }; buckets.set(texIdx, bucket); }

      // triangle command stream
      while (true) {
        let count = i16(tri); tri += 2;
        if (count === 0) break;
        const fan = count < 0;
        const n = Math.abs(count);
        const strip = [];
        for (let k = 0; k < n; k++) {
          const vi = i16(tri), ni = i16(tri + 2), s = i16(tri + 4), tt = i16(tri + 6);
          tri += 8;
          strip.push({ p: verts[vi], nv: norms[ni] || [0, 0, 1], u: s / tex.w, v: tt / tex.h });
        }
        const emit = (a, c, d) => {
          for (const vert of [a, c, d]) {
            bucket.pos.push(vert.p[0], vert.p[1], vert.p[2]);
            bucket.nrm.push(vert.nv[0], vert.nv[1], vert.nv[2]);
            bucket.uv.push(vert.u, vert.v);
            grow(vert.p);
          }
        };
        if (fan) {
          for (let k = 1; k < n - 1; k++) emit(strip[0], strip[k], strip[k + 1]);
        } else {
          for (let k = 0; k < n - 2; k++) {
            if (k & 1) emit(strip[k + 1], strip[k], strip[k + 2]);
            else emit(strip[k], strip[k + 1], strip[k + 2]);
          }
        }
      }
    }
  }

  const groups = [];
  for (const [texIdx, b] of buckets) {
    groups.push({
      tex: textures[texIdx] || null,
      positions: new Float32Array(b.pos),
      normals: new Float32Array(b.nrm),
      uvs: new Float32Array(b.uv),
    });
  }
  return { groups, textures, min, max };
}

export async function loadMDL(url, opts = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`load ${url}: ${res.status}`);
  return parseMDL(await res.arrayBuffer(), opts);
}
