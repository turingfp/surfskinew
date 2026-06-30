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
  const u16 = (o) => dv.getUint16(o, true);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = u8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };

  if (dv.getUint32(0, true) !== 0x54534449) throw new Error('not an IDST mdl'); // "IDST"

  const numbones = i32(140), boneindex = i32(144);
  const numseq = i32(164), seqindex = i32(168);
  const numtextures = i32(180), textureindex = i32(184);
  const numskinref = i32(192), skinindex = i32(200);
  const numbodyparts = i32(204), bodypartindex = i32(208);

  // ---- bones: default pos/rot + per-channel animation scale + parent ----
  const boneParent = new Int32Array(numbones);
  const boneDef = []; // [b] -> [px,py,pz, rx,ry,rz]
  const boneScale = []; // [b] -> [6]
  for (let b = 0; b < numbones; b++) {
    const o = boneindex + b * 112; // name[32], parent@32, flags@36, ctrl[6]@40, value[6]@64, scale[6]@88
    boneParent[b] = i32(o + 32);
    boneDef.push([f32(o + 64), f32(o + 68), f32(o + 72), f32(o + 76), f32(o + 80), f32(o + 84)]);
    boneScale.push([f32(o + 88), f32(o + 92), f32(o + 96), f32(o + 100), f32(o + 104), f32(o + 108)]);
  }

  // RLE-decoded mstudioanim value for bone channel ch at an arbitrary frame.
  // animBase points at the sequence's mstudioanim_t array (blend 0).
  function animValue(animBase, bone, ch, frame) {
    const recOff = u16(animBase + bone * 12 + ch * 2);
    if (recOff === 0) return 0;
    let p = animBase + bone * 12 + recOff; // mstudioanimvalue_t spans (2 bytes each)
    let k = frame;
    let valid = u8(p), total = u8(p + 1);
    while (total <= k) {
      k -= total;
      p += (valid + 1) * 2;
      valid = u8(p); total = u8(p + 1);
    }
    return (valid > k) ? i16(p + (k + 1) * 2) : i16(p + valid * 2);
  }

  // Bone -> world matrices for a given sequence frame (animBase<0 => bind pose).
  function computeWorld(animBase, frame) {
    const world = new Array(numbones);
    for (let b = 0; b < numbones; b++) {
      const d = boneDef[b], s = boneScale[b];
      const v = [d[0], d[1], d[2], d[3], d[4], d[5]];
      if (animBase >= 0) for (let j = 0; j < 6; j++) v[j] += animValue(animBase, b, j, frame) * s[j];
      const local = quatMatrix(angleQuaternion(v[3], v[4], v[5]), v[0], v[1], v[2]);
      const par = boneParent[b];
      world[b] = par >= 0 ? concat(world[par], local) : local;
    }
    return world;
  }

  // ---- sequences (for the animator) ----
  const sequences = [];
  for (let s = 0; s < numseq; s++) {
    const sd = seqindex + s * 176; // label[32], fps@32, ..., numframes@56, ..., animindex@124
    sequences.push({ name: str(sd, 32).toLowerCase(), fps: f32(sd + 32), numframes: i32(sd + 56), animindex: i32(sd + 124) });
  }
  // Resolve a sequence's anim base + clamp a frame to its length.
  function seqAnim(seqIndex) {
    if (seqIndex == null || seqIndex < 0 || seqIndex >= numseq) return null;
    return sequences[seqIndex];
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

  // ---- geometry topology, grouped by texture ----
  // The triangle stream is pose-independent, so we walk it once and record, per
  // emitted vertex, its LOCAL position + bone and LOCAL normal + bone. Any frame
  // is then baked by re-transforming these locals through that frame's bones.
  const buckets = new Map(); // texIndex -> { lp:[], vb:[], ln:[], nb:[], uv:[] }

  for (let bp = 0; bp < numbodyparts; bp++) {
    const o = bodypartindex + bp * 76;
    if (skip.has(str(o, 64).toLowerCase())) continue; // e.g. skip the unused "lhand"
    const mo = i32(o + 72); // base submodel (index 0)
    const nummesh = i32(mo + 64 + 8);
    const meshindex = i32(mo + 64 + 12);
    const numverts = i32(mo + 64 + 16);
    const vertinfoindex = i32(mo + 64 + 20);
    const vertindex = i32(mo + 64 + 24);
    const numnorms = i32(mo + 64 + 28);
    const norminfoindex = i32(mo + 64 + 32);
    const normindex = i32(mo + 64 + 36);

    // local (un-posed) verts/normals + their bone bindings
    const lverts = new Array(numverts), vbones = new Uint8Array(numverts);
    for (let v = 0; v < numverts; v++) { vbones[v] = u8(vertinfoindex + v); const vo = vertindex + v * 12; lverts[v] = [f32(vo), f32(vo + 4), f32(vo + 8)]; }
    const lnorms = new Array(numnorms), nbones = new Uint8Array(numnorms);
    for (let n = 0; n < numnorms; n++) { nbones[n] = u8(norminfoindex + n); const no = normindex + n * 12; lnorms[n] = [f32(no), f32(no + 4), f32(no + 8)]; }

    for (let m = 0; m < nummesh; m++) {
      const meo = meshindex + m * 20;
      let tri = i32(meo + 4);
      const skinref = i32(meo + 8);
      const texIdx = skin[skinref] ?? skinref;
      const tex = textures[texIdx] || { w: 64, h: 64 };
      let bucket = buckets.get(texIdx);
      if (!bucket) { bucket = { lp: [], vb: [], ln: [], nb: [], uv: [] }; buckets.set(texIdx, bucket); }

      while (true) { // triangle command stream
        let count = i16(tri); tri += 2;
        if (count === 0) break;
        const fan = count < 0;
        const n = Math.abs(count);
        const strip = [];
        for (let k = 0; k < n; k++) {
          const vi = i16(tri), ni = i16(tri + 2), s = i16(tri + 4), tt = i16(tri + 6);
          tri += 8;
          strip.push({ vi, ni, u: s / tex.w, v: tt / tex.h });
        }
        const emit = (a, c, d) => {
          for (const vert of [a, c, d]) {
            const lp = lverts[vert.vi], ln = lnorms[vert.ni] || [0, 0, 1];
            bucket.lp.push(lp[0], lp[1], lp[2]); bucket.vb.push(vbones[vert.vi]);
            bucket.ln.push(ln[0], ln[1], ln[2]); bucket.nb.push(nbones[vert.ni] || 0);
            bucket.uv.push(vert.u, vert.v);
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

  // finalize per-group topology
  const topo = [];
  for (const [texIdx, b] of buckets) {
    topo.push({
      tex: textures[texIdx] || null,
      lp: new Float32Array(b.lp), vb: Uint8Array.from(b.vb),
      ln: new Float32Array(b.ln), nb: Uint8Array.from(b.nb),
      uvs: new Float32Array(b.uv),
      count: b.vb.length,
    });
  }

  // Bake a sequence frame -> per-group {positions, normals} in MODEL space.
  function bake(seqIndex, frame) {
    const sq = seqAnim(seqIndex);
    let animBase = -1;
    if (sq) { frame = Math.max(0, Math.min(sq.numframes - 1, frame | 0)); animBase = sq.animindex; }
    const world = computeWorld(animBase, frame);
    return topo.map((g) => {
      const n = g.count;
      const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const wp = world[g.vb[i]], wn = world[g.nb[i]];
        const li = i * 3;
        const px = g.lp[li], py = g.lp[li + 1], pz = g.lp[li + 2];
        positions[li] = wp[0] * px + wp[1] * py + wp[2] * pz + wp[3];
        positions[li + 1] = wp[4] * px + wp[5] * py + wp[6] * pz + wp[7];
        positions[li + 2] = wp[8] * px + wp[9] * py + wp[10] * pz + wp[11];
        const nx = g.ln[li], ny = g.ln[li + 1], nz = g.ln[li + 2];
        normals[li] = wn[0] * nx + wn[1] * ny + wn[2] * nz;
        normals[li + 1] = wn[4] * nx + wn[5] * ny + wn[6] * nz;
        normals[li + 2] = wn[8] * nx + wn[9] * ny + wn[10] * nz;
      }
      return { positions, normals };
    });
  }

  // initial pose: opts.sequence frame 0 (e.g. idle), else bind pose
  const initSeq = (opts.sequence != null && opts.sequence < numseq) ? opts.sequence : -1;
  const baked = bake(initSeq, 0);
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  const groups = topo.map((g, gi) => {
    const positions = baked[gi].positions;
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) { const c = positions[i + k]; if (c < min[k]) min[k] = c; if (c > max[k]) max[k] = c; }
    }
    return { tex: g.tex, positions, normals: baked[gi].normals, uvs: g.uvs };
  });

  return { groups, textures, min, max, anim: { sequences, bake, numbones } };
}

export async function loadMDL(url, opts = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`load ${url}: ${res.status}`);
  return parseMDL(await res.arrayBuffer(), opts);
}
