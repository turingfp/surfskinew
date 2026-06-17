// Gameplay entities pulled from the BSP entity lump:
//  - trigger_push     -> booster volumes (surf speed pads / launchers)
//  - trigger_teleport -> teleport volumes targeting a destination entity
//  - func_ladder      -> climbable volumes
//  - func_water       -> swimmable volumes
//
// Containment is tested against each brush model's actual clip-node hull (not
// its bounding box), so an irregular/large brush no longer false-triggers over
// the surf path. We use the player hull (hull 1) so a trigger fires when the
// player's box touches the brush — matching how GoldSrc triggers behave.

import { CONTENTS } from './constants.js';

function parseVec(s, d = [0, 0, 0]) {
  if (!s) return d;
  const p = s.split(/\s+/).map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? p : d;
}

export class Entities {
  constructor(bsp, world) {
    this.bsp = bsp;
    this.world = world; // CollisionWorld, for precise point-in-brush tests
    this.pushes = [];
    this.teleports = [];
    this.ladders = [];
    this.waters = [];
    this.hurts = []; // trigger_hurt volumes (touch -> respawn)
    this._index();
  }

  _modelIndex(ent) {
    const m = ent.model;
    if (!m || m[0] !== '*') return -1;
    const idx = parseInt(m.slice(1), 10);
    return (this.bsp.models[idx]) ? idx : -1;
  }

  // AABB of a brush model, used only as a cheap broad-phase reject.
  _aabb(idx) {
    const mdl = this.bsp.models[idx];
    return { min: mdl.mins.slice(), max: mdl.maxs.slice() };
  }

  _findTarget(name) {
    if (!name) return null;
    for (const e of this.bsp.entities) {
      if (e.targetname === name && e.origin) {
        const yaw = e.angles ? (Number(e.angles.split(/\s+/)[1]) || 0) * Math.PI / 180 : null;
        return { origin: parseVec(e.origin), yaw };
      }
    }
    return null;
  }

  _index() {
    for (const e of this.bsp.entities) {
      const mi = this._modelIndex(e);
      if (mi < 0) continue;
      const box = this._aabb(mi);
      switch (e.classname) {
        case 'trigger_push': {
          const ang = parseVec(e.angles, [0, 0, 0]); // pitch yaw roll (deg)
          const pitch = ang[0] * Math.PI / 180, yaw = ang[1] * Math.PI / 180;
          const dir = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch)];
          this.pushes.push({ mi, box, dir, speed: Number(e.speed) || 0 });
          break;
        }
        case 'trigger_teleport':
          this.teleports.push({ mi, box, dest: this._findTarget(e.target) });
          break;
        case 'func_ladder':
          this.ladders.push({ mi, box });
          break;
        case 'func_water':
        case 'func_conveyor_water':
          this.waters.push({ mi, box });
          break;
        case 'trigger_hurt':
          this.hurts.push({ mi, box });
          break;
        default:
          break;
      }
    }
  }

  _aabbHit(b, p) {
    // generous margin so the broad-phase never rejects a real hit (hull-1 trace
    // can register slightly outside the raw box)
    const m = 40;
    return p[0] >= b.min[0] - m && p[0] <= b.max[0] + m
      && p[1] >= b.min[1] - m && p[1] <= b.max[1] + m
      && p[2] >= b.min[2] - m && p[2] <= b.max[2] + m;
  }

  // Precise: is point p inside this brush model's volume?
  _inside(ent, p) {
    if (!this._aabbHit(ent.box, p)) return false;
    if (!this.world) return true; // no collision world -> fall back to AABB
    return this.world.pointContents(p, 1, ent.mi) === CONTENTS.SOLID;
  }

  inWater(p) { for (const w of this.waters) if (this._inside(w, p)) return true; return false; }
  onLadder(p) { for (const l of this.ladders) if (this._inside(l, p)) return true; return false; }

  apply(state) {
    // trigger_hurt at the bottom of a run = fell off, reset to spawn
    for (const h of this.hurts) {
      if (this._inside(h, state.origin)) return { hurt: true };
    }
    for (const t of this.teleports) {
      if (t.dest && this._inside(t, state.origin)) {
        state.origin = t.dest.origin.slice();
        state.velocity = [0, 0, 0];
        return { teleported: t.dest };
      }
    }
    for (const pu of this.pushes) {
      if (pu.speed > 0 && this._inside(pu, state.origin)) {
        const cur = state.velocity[0] * pu.dir[0] + state.velocity[1] * pu.dir[1] + state.velocity[2] * pu.dir[2];
        if (cur < pu.speed) {
          const add = pu.speed - cur;
          state.velocity[0] += pu.dir[0] * add;
          state.velocity[1] += pu.dir[1] * add;
          state.velocity[2] += pu.dir[2] * add;
        }
      }
    }
    return {};
  }
}
