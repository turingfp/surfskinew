// Runtime navmesh generation for maps that ship no .nav waypoint file: sample
// a grid of candidate floor points, keep the ones that are actually walkable
// standing ground, then connect nearby pairs with a clear line-of-movement.
//
// Scope: this only covers *walkable floor* (surface normal.z >= GROUND_NORMAL_Z,
// the same threshold physics.js uses to decide "on ground" vs "surf ramp").
// Surf ramps themselves aren't included — a bot generated this way will path
// around a surf map's flat platforms/starts but won't actually surf the
// ramps, which is a real and, for now, accepted limitation (see nav.js for
// the real-.nav path, which is precise but only available where a map ships
// one, e.g. de_dust2).

import { HULL, CONTENTS } from './constants.js';
import { NavGraph } from './nav.js';

const STEP = 56; // sample grid spacing, GS units
const CONNECT_RADIUS = STEP * 1.6;
const MAX_STEP_HEIGHT = 64; // like sv_stepsize but a bit looser, for ramps/stairs between samples
const EYE_CLEARANCE = 40; // headroom check above a candidate floor point

export function generateNavGraph(bsp, world) {
  const mins = bsp.models[0].mins, maxs = bsp.models[0].maxs;
  const nodes = [];

  for (let x = mins[0]; x <= maxs[0]; x += STEP) {
    for (let y = mins[1]; y <= maxs[1]; y += STEP) {
      const top = maxs[2] + 32;
      const bottom = mins[2] - 32;
      const tr = world.traceHull([x, y, top], [x, y, bottom], HULL.STAND.hullIndex);
      // Note: don't reject on tr.startsolid. The sample column starts at the
      // map's GLOBAL max Z, which for any (x,y) not directly under the map's
      // single tallest point sits inside the "outside the level" solid void
      // (or under a roof/skybox brush) — so startsolid is true almost
      // everywhere despite the sweep still correctly finding a real floor
      // plane on the way down. Only allsolid (no open space anywhere on the
      // ray — a genuinely solid column) should disqualify the sample.
      if (tr.fraction >= 1 || tr.allsolid || !tr.plane) continue;
      if (tr.plane.normal[2] < 0.7) continue; // ramp/wall, not walkable floor
      const floor = tr.endpos;
      const standAt = [floor[0], floor[1], floor[2] + 4];
      if (world.pointContents(standAt, HULL.STAND.hullIndex) === CONTENTS.SOLID) continue;
      // headroom: a short upward trace shouldn't immediately hit solid
      const head = world.traceHull(standAt, [standAt[0], standAt[1], standAt[2] + EYE_CLEARANCE], HULL.STAND.hullIndex);
      if (head.startsolid) continue;
      nodes.push({ pos: [floor[0], floor[1], floor[2] + 2] });
    }
  }

  const edges = new Map();
  for (let i = 0; i < nodes.length; i++) edges.set(i, new Set());
  // Grid-bucket nodes for a fast neighbor search instead of O(n^2).
  const bucket = new Map();
  const key = (x, y) => `${Math.round(x / CONNECT_RADIUS)},${Math.round(y / CONNECT_RADIUS)}`;
  nodes.forEach((n, i) => {
    const k = key(n.pos[0], n.pos[1]);
    (bucket.get(k) || bucket.set(k, []).get(k)).push(i);
  });
  for (let i = 0; i < nodes.length; i++) {
    const [x, y] = nodes[i].pos;
    const candidates = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = key(x + dx * CONNECT_RADIUS, y + dy * CONNECT_RADIUS);
      const b = bucket.get(k); if (b) for (const j of b) candidates.add(j);
    }
    for (const j of candidates) {
      if (j <= i) continue;
      const a = nodes[i].pos, b = nodes[j].pos;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d > CONNECT_RADIUS) continue;
      if (Math.abs(a[2] - b[2]) > MAX_STEP_HEIGHT) continue;
      const tr = world.traceHull(a, b, HULL.STAND.hullIndex);
      if (tr.fraction < 1 || tr.startsolid) continue;
      edges.get(i).add(j); edges.get(j).add(i);
    }
  }

  return new NavGraph(nodes, edges);
}
