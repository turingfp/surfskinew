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

export class CollisionWorld {
  constructor(bsp) {
    this.planes = bsp.planes;
    this.clip = bsp.clipnodes;
    this.models = bsp.models;
    this._head = 0;
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

  // Sweep the player point from start to end. Returns
  // { fraction, endpos, plane:{normal,dist}|null, startsolid, allsolid }.
  traceHull(start, end, hullIndex = 1, modelIndex = 0) {
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
