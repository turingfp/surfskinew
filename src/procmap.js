// Procedural surf map ("surf_arena") with analytic brush collision — a third
// map that needs no BSP. Geometry is a set of oriented boxes (brushes); the
// player sweeps against them with a Quake-style box-vs-brush trace, returning
// the tilted ramp normals that make surf work. Pure (no Three) so it's
// node-testable; render.js builds the meshes from the same brush list.

const SOLID = -2, EMPTY = -1, DIST_EPSILON = 0.03125;

function rotAxes(rx, ry, rz) {
  // GS euler -> 3 column axis vectors (roll X, pitch Y, yaw Z), Rz*Ry*Rx
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // columns = images of model X,Y,Z
  const ax = [cy * cz, cy * sz, -sy];
  const ay = [sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy];
  const az = [cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy];
  return [ax, ay, az];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Oriented box brush. Stores its 6 planes (outward normal n, dist d) and the
// axis frame so the renderer can rebuild the 8 corners.
export function makeBrush(center, he, euler = [0, 0, 0], opts = {}) {
  const axes = rotAxes(euler[0], euler[1], euler[2]);
  const planes = [];
  for (let i = 0; i < 3; i++) {
    const a = axes[i];
    const dc = dot(a, center);
    planes.push({ n: a, d: dc + he[i] });                       // +face
    planes.push({ n: [-a[0], -a[1], -a[2]], d: -dc + he[i] });  // -face
  }
  return { center, he, axes, planes, color: opts.color || 0x88c0a0, tex: opts.tex || null, glass: !!opts.glass };
}

export class BrushWorld {
  constructor(brushes) {
    this.brushes = brushes;
    this.hull = { 1: [16, 16, 36], 3: [16, 16, 18] };
    this.solidModels = [0]; // compatibility with callers that read this
  }

  _half(h) { return this.hull[h] || this.hull[1]; }

  pointContents(p, hullIndex = 1) {
    const half = this._half(hullIndex);
    for (const b of this.brushes) {
      let inside = true;
      for (const pl of b.planes) {
        const offset = half[0] * Math.abs(pl.n[0]) + half[1] * Math.abs(pl.n[1]) + half[2] * Math.abs(pl.n[2]);
        if (dot(p, pl.n) - (pl.d + offset) > 0) { inside = false; break; }
      }
      if (inside) return SOLID;
    }
    return EMPTY;
  }

  traceHull(start, end, hullIndex = 1) {
    const half = this._half(hullIndex);
    const trace = { fraction: 1, endpos: [end[0], end[1], end[2]], plane: null, startsolid: false, allsolid: false };
    for (const b of this.brushes) this._clipBrush(start, end, half, b, trace);
    trace.endpos = [
      start[0] + (end[0] - start[0]) * trace.fraction,
      start[1] + (end[1] - start[1]) * trace.fraction,
      start[2] + (end[2] - start[2]) * trace.fraction,
    ];
    return trace;
  }

  // Quake CM_ClipBoxToBrush: swept AABB (player) vs convex brush (planes
  // expanded by the box support distance).
  _clipBrush(start, end, half, brush, trace) {
    let enterFrac = -1, leaveFrac = 1;
    let clip = null, startsolid = true, getout = false;
    for (const pl of brush.planes) {
      const offset = half[0] * Math.abs(pl.n[0]) + half[1] * Math.abs(pl.n[1]) + half[2] * Math.abs(pl.n[2]);
      const dist = pl.d + offset;
      const d1 = dot(start, pl.n) - dist;
      const d2 = dot(end, pl.n) - dist;
      if (d1 > 0) startsolid = false;
      if (d2 > 0) getout = true;
      if (d1 > 0 && d2 >= d1) return;   // start & end outside this plane, moving out -> miss
      if (d1 <= 0 && d2 <= 0) continue; // both inside this plane
      if (d1 > d2) {                    // entering
        const f = (d1 - DIST_EPSILON) / (d1 - d2);
        if (f > enterFrac) { enterFrac = f; clip = pl.n; }
      } else {                          // leaving
        const f = (d1 + DIST_EPSILON) / (d1 - d2);
        if (f < leaveFrac) leaveFrac = f;
      }
    }
    if (startsolid) {
      trace.startsolid = true;
      if (!getout) { trace.allsolid = true; trace.fraction = 0; }
      return;
    }
    if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < trace.fraction) {
      trace.fraction = Math.max(0, enterFrac);
      trace.plane = { normal: clip, dist: 0 };
    }
  }
}

// Build a beginner surf course: start pad, 6 alternating-lean surf ramps that
// descend along +X, an end pad, and a safety floor. Returns brushes + spawn.
export function generateSurfArena() {
  const brushes = [];
  const RAMP_LEN = 1024, THICK = 28, ANGLE = (54 * Math.PI) / 180; // > 45.57 deg => surfs
  const widths = [360, 360, 320, 300, 280, 260];
  const leans = [1, -1, 1, -1, 1, -1]; // roll sign (forces A/D strafing)

  // start platform up high; you drop off it onto ramp 1 and surf down.
  brushes.push(makeBrush([0, 0, 700], [360, 360, 16], [0, 0, 0], { color: 0x6fbf9f }));
  const spawn = { origin: [0, 0, 760], yaw: 0 };

  let x = 360;       // running +X (downrange) position
  let z = 660;       // ramp centre height, descending
  for (let i = 0; i < 6; i++) {
    const w = widths[i];
    const roll = leans[i] * ANGLE;
    const cx = x + RAMP_LEN / 2;
    const cy = -leans[i] * (w * 0.35); // offset so you slide toward the centre line
    brushes.push(makeBrush([cx, cy, z], [RAMP_LEN / 2, w / 2, THICK / 2], [roll, 0, 0],
      { color: i % 2 ? 0x5fae8f : 0x77c8a6, glass: true }));
    x += RAMP_LEN - 120; // slight overlap so transitions connect
    z -= 150;            // descend
  }
  // end platform at the bottom of the run
  const endX = x + 256, endZ = z + 40;
  brushes.push(makeBrush([endX, 0, endZ], [360, 360, 16], [0, 0, 0], { color: 0x6fbf9f }));

  // safety floor spanning the whole course, far below
  brushes.push(makeBrush([endX / 2, 0, endZ - 600], [endX + 1600, 3200, 24], [0, 0, 0],
    { color: 0x39463f, tex: 'floor' }));

  const bounds = { min: [-512, -3400, endZ - 800], max: [endX + 800, 3400, 900] };
  const finish = { min: [endX - 360, -360, endZ + 18], max: [endX + 360, 360, endZ + 260] };
  return { brushes, spawn, bounds, finish, killZ: endZ - 700 };
}
