// Gameplay entities pulled from the BSP entity lump:
//  - trigger_push    -> booster volumes (surf speed pads / launchers)
//  - trigger_teleport -> teleport volumes targeting a destination entity
//  - func_ladder     -> climbable volumes
//  - func_water      -> swimmable volumes
//
// Brush entities reference a model "*N"; we use that model's AABB
// (bsp.models[N].mins/maxs) as the trigger volume. That's a close-enough
// approximation of these (usually box-shaped) brush volumes for gameplay.

function parseVec(s, d = [0, 0, 0]) {
  if (!s) return d;
  const p = s.split(/\s+/).map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? p : d;
}

export class Entities {
  constructor(bsp) {
    this.bsp = bsp;
    this.pushes = [];
    this.teleports = [];
    this.ladders = [];
    this.waters = [];
    this._index();
  }

  _modelAABB(ent) {
    const m = ent.model;
    if (!m || m[0] !== '*') return null;
    const mdl = this.bsp.models[parseInt(m.slice(1), 10)];
    if (!mdl) return null;
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
      const box = this._modelAABB(e);
      switch (e.classname) {
        case 'trigger_push': {
          if (!box) break;
          const ang = parseVec(e.angles, [0, 0, 0]); // pitch yaw roll (deg)
          const pitch = ang[0] * Math.PI / 180, yaw = ang[1] * Math.PI / 180;
          // GoldSrc movedir from angles (pitch -90 => straight up, etc.)
          const dir = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch)];
          this.pushes.push({ ...box, dir, speed: Number(e.speed) || 0 });
          break;
        }
        case 'trigger_teleport':
          if (box) this.teleports.push({ ...box, dest: this._findTarget(e.target) });
          break;
        case 'func_ladder':
          if (box) this.ladders.push(box);
          break;
        case 'func_water':
        case 'func_conveyor_water':
          if (box) this.waters.push(box);
          break;
        default:
          break;
      }
    }
  }

  _inside(b, p) {
    return p[0] >= b.min[0] && p[0] <= b.max[0]
      && p[1] >= b.min[1] && p[1] <= b.max[1]
      && p[2] >= b.min[2] && p[2] <= b.max[2];
  }

  inWater(p) { for (const w of this.waters) if (this._inside(w, p)) return true; return false; }
  onLadder(p) { for (const l of this.ladders) if (this._inside(l, p)) return true; return false; }

  // Apply teleport + push triggers to a player state. Returns the teleport
  // destination if one fired (so the caller can also realign the view).
  apply(state) {
    for (const t of this.teleports) {
      if (t.dest && this._inside(t, state.origin)) {
        state.origin = t.dest.origin.slice();
        state.velocity = [0, 0, 0];
        return { teleported: t.dest };
      }
    }
    for (const pu of this.pushes) {
      if (pu.speed > 0 && this._inside(pu, state.origin)) {
        // Booster: bring velocity up to `speed` along the push direction.
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
