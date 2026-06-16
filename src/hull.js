// Collision against the BSP clip-node hulls — authentic GoldSrc tracing.
//
// GoldSrc precomputes, for each sized player hull, a BSP of clip nodes whose
// planes are already offset by the hull dimensions. Tracing the player's CENTRE
// point through these expanded planes is mathematically identical to sweeping
// the player's box through the world. This is PM_RecursiveHullCheck /
// PM_HullPointContents from pm_shared.c.
//
// Because the surf ramp brushes become angled planes in this tree, a downward
// trace on a ramp returns the ramp's angled normal, which ClipVelocity then
// turns into a downhill slide. Surf falls straight out of this — no special case.

import { CONTENTS, DIST_EPSILON } from './constants.js';
import { dot, copy } from './vec.js';

// Brush-entity classes that are solid to the player (so we collide with them).
// Surf ramps are frequently compiled as func_wall, which is why world-only
// collision let players fall through them.
const SOLID_CLASSES = new Set([
  'func_wall', 'func_wall_toggle', 'func_detail', 'func_door', 'func_door_rotating',
  'func_button', 'func_breakable', 'func_pushable', 'func_train', 'func_plat',
  'func_rotating', 'func_conveyor', 'func_tracktrain', 'func_guntarget', 'func_vehicle',
]);

export class CollisionWorld {
  constructor(bsp) {
    this.planes = bsp.planes;
    this.clip = bsp.clipnodes;
    this.models = bsp.models;
    this._head = 0;

    // worldspawn (model 0) plus every solid brush entity model
    this.solidModels = [0];
    if (bsp.entities) {
      for (const e of bsp.entities) {
        if (e.model && e.model[0] === '*' && SOLID_CLASSES.has(e.classname)) {
          const i = parseInt(e.model.slice(1), 10);
          if (this.models[i] && !this.solidModels.includes(i)) this.solidModels.push(i);
        }
      }
    }
  }

  headnode(hullIndex, modelIndex = 0) {
    return this.models[modelIndex].headnode[hullIndex];
  }

  // Walk the clip-node tree to a leaf and return its CONTENTS_* value.
  hullPointContents(num, p) {
    const { planenum, child0, child1 } = this.clip;
    const planes = this.planes;
    while (num >= 0) {
      const plane = planes[planenum[num]];
      let d;
      if (plane.type < 3) d = p[plane.type] - plane.dist;
      else d = dot(plane.normal, p) - plane.dist;
      num = d < 0 ? child1[num] : child0[num];
    }
    return num;
  }

  pointContents(p, hullIndex = 1, modelIndex = 0) {
    return this.hullPointContents(this.headnode(hullIndex, modelIndex), p);
  }

  // Sweep the player point against ONE model. Returns
  // { fraction, endpos, plane:{normal,dist}|null, startsolid, allsolid }.
  _traceModel(start, end, hullIndex, modelIndex) {
    const head = this.headnode(hullIndex, modelIndex);
    this._head = head;
    const trace = {
      fraction: 1,
      endpos: copy(end),
      plane: null,
      startsolid: false,
      allsolid: true,
    };
    this.recursiveHullCheck(head, 0, 1, start, end, trace);
    if (trace.fraction === 1) trace.endpos = copy(end);
    return trace;
  }

  // Sweep the player against worldspawn + all solid brush models, returning the
  // closest impact (so func_wall surf ramps, doors, etc. all collide).
  traceHull(start, end, hullIndex = 1) {
    const combined = { fraction: 1, endpos: copy(end), plane: null, startsolid: false, allsolid: false };
    for (const mi of this.solidModels) {
      const tr = this._traceModel(start, end, hullIndex, mi);
      if (tr.startsolid) combined.startsolid = true;
      if (tr.allsolid) combined.allsolid = true;
      if (tr.fraction < combined.fraction) {
        combined.fraction = tr.fraction;
        combined.endpos = tr.endpos;
        combined.plane = tr.plane;
      }
    }
    return combined;
  }

  recursiveHullCheck(num, p1f, p2f, p1, p2, trace) {
    // Reached a leaf (negative = CONTENTS_*).
    if (num < 0) {
      if (num !== CONTENTS.SOLID) trace.allsolid = false;
      else trace.startsolid = true;
      return true; // this segment is clear of solid
    }

    const { planenum, child0, child1 } = this.clip;
    const plane = this.planes[planenum[num]];
    let t1, t2;
    if (plane.type < 3) {
      t1 = p1[plane.type] - plane.dist;
      t2 = p2[plane.type] - plane.dist;
    } else {
      t1 = dot(plane.normal, p1) - plane.dist;
      t2 = dot(plane.normal, p2) - plane.dist;
    }

    // Both points on the same side: recurse that side only.
    if (t1 >= 0 && t2 >= 0) return this.recursiveHullCheck(child0[num], p1f, p2f, p1, p2, trace);
    if (t1 < 0 && t2 < 0) return this.recursiveHullCheck(child1[num], p1f, p2f, p1, p2, trace);

    // Segment crosses the plane: split at the crossing (with epsilon nudge).
    let frac;
    if (t1 < 0) frac = (t1 + DIST_EPSILON) / (t1 - t2);
    else frac = (t1 - DIST_EPSILON) / (t1 - t2);
    if (frac < 0) frac = 0; else if (frac > 1) frac = 1;

    let midf = p1f + (p2f - p1f) * frac;
    const mid = [
      p1[0] + frac * (p2[0] - p1[0]),
      p1[1] + frac * (p2[1] - p1[1]),
      p1[2] + frac * (p2[2] - p1[2]),
    ];
    const side = t1 < 0 ? 1 : 0;                 // child holding p1 (near side)
    const nearChild = side === 0 ? child0[num] : child1[num];
    const farChild = side === 0 ? child1[num] : child0[num];

    // Walk the near side first.
    if (!this.recursiveHullCheck(nearChild, p1f, midf, p1, mid, trace)) return false;

    // If the far side at the split point is open, continue into it.
    if (this.hullPointContents(farChild, mid) !== CONTENTS.SOLID) {
      return this.recursiveHullCheck(farChild, midf, p2f, mid, p2, trace);
    }

    // Far side is solid: we have an impact (unless we never left solid at all).
    if (trace.allsolid) return false;

    // Record the impacted plane, oriented to face back against the motion.
    if (side === 0) {
      trace.plane = { normal: copy(plane.normal), dist: plane.dist };
    } else {
      trace.plane = {
        normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
        dist: -plane.dist,
      };
    }

    // Back the impact point out of any residual solid.
    while (this.hullPointContents(this._head, mid) === CONTENTS.SOLID) {
      frac -= 0.1;
      if (frac < 0) {
        trace.fraction = midf;
        trace.endpos = copy(mid);
        return false;
      }
      midf = p1f + (p2f - p1f) * frac;
      mid[0] = p1[0] + frac * (p2[0] - p1[0]);
      mid[1] = p1[1] + frac * (p2[1] - p1[1]);
      mid[2] = p1[2] + frac * (p2[2] - p1[2]);
    }

    trace.fraction = midf;
    trace.endpos = copy(mid);
    return false;
  }
}
