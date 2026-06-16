// GoldSrc (Half-Life / CS 1.6) player movement.
//
// This is a faithful re-implementation of Valve's pm_shared.c movement,
// in the exact per-tick order given by the spec:
//
//   1. read input -> build wishdir / wishspeed
//   2. clamp wishspeed to sv_maxspeed
//   3. CategorizePosition (onground vs airborne via normal.z >= 0.7)
//   4. jump
//   5. onground: Friction + ground Accelerate ; airborne: AirAccelerate
//   6. gravity split (half before move, half after) when airborne
//   7. FlyMove: slide along surfaces, ClipVelocity on each plane hit
//   8. CategorizePosition again
//   9. clamp every velocity axis to +/- sv_maxvelocity
//
// The trace against the real BSP geometry is injected via `world`
// (see hull.js). Everything here is pure given (state, cmd, world, cfg),
// which makes it deterministic and unit-testable without a renderer.

import {
  CVAR, AIR_WISHSPEED_CAP, GROUND_NORMAL_Z, STOP_EPSILON, OVERBOUNCE,
  MAX_CLIP_PLANES, NUM_BUMPS, HULL, JUMP_HEIGHT, CONTENTS,
} from './constants.js';
import { dot, cross, normalize, mad, copy, length } from './vec.js';

export function createPlayerState(origin, angles = { yaw: 0, pitch: 0 }) {
  return {
    origin: copy(origin),
    velocity: [0, 0, 0],
    onground: false,
    groundNormal: null,
    ducking: false,
    jumpHeld: false,
    // bookkeeping for HUD / debug
    blocked: 0,
  };
}

// ---- ClipVelocity: the core of surf. ---------------------------------------
// Remove the component of velocity pointing into the surface, keep tangential.
export function clipVelocity(vel, normal, overbounce = OVERBOUNCE) {
  const backoff = dot(vel, normal) * overbounce;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const change = normal[i] * backoff;
    out[i] = vel[i] - change;
    if (out[i] > -STOP_EPSILON && out[i] < STOP_EPSILON) out[i] = 0;
  }
  return out;
}

// Horizontal forward/right basis from yaw (z component zeroed for movement).
function horizontalBasis(yaw) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return { forward: [cy, sy, 0], right: [sy, -cy, 0] };
}

function currentHull(state) {
  return state.ducking ? HULL.DUCK : HULL.STAND;
}

// ---- CategorizePosition ----------------------------------------------------
// Decide onground vs airborne. A surface steeper than acos(0.7) ~= 45.57 deg
// fails the normal.z test, so the player never grounds on a surf ramp -> no
// friction, air rules apply, speed can build.
export function categorizePosition(state, world) {
  // Moving up fast => definitely airborne (e.g. just jumped / launched).
  if (state.velocity[2] > 180) {
    state.onground = false;
    state.groundNormal = null;
    return;
  }
  const hull = currentHull(state);
  const start = state.origin;
  const end = [start[0], start[1], start[2] - 2];
  const tr = world.traceHull(start, end, hull.hullIndex);

  if (tr.fraction === 1 || !tr.plane) {
    state.onground = false;
    state.groundNormal = null;
  } else if (tr.plane.normal[2] < GROUND_NORMAL_Z) {
    // Too steep to stand on: this is a surf ramp. Stay airborne.
    state.onground = false;
    state.groundNormal = null;
  } else {
    state.onground = true;
    state.groundNormal = tr.plane.normal;
    if (!tr.startsolid && !tr.allsolid) state.origin = tr.endpos; // snap to ground
  }
}

// ---- Friction (only when grounded) -----------------------------------------
export function friction(state, dt) {
  const speed = length(state.velocity);
  if (speed < 0.1) return;
  const control = speed < CVAR.sv_stopspeed ? CVAR.sv_stopspeed : speed;
  const drop = control * CVAR.sv_friction * dt;
  const newspeed = Math.max(speed - drop, 0);
  const scaleBy = newspeed / speed;
  state.velocity[0] *= scaleBy;
  state.velocity[1] *= scaleBy;
  state.velocity[2] *= scaleBy;
}

// ---- Ground acceleration ---------------------------------------------------
export function groundAccelerate(state, wishdir, wishspeed, dt) {
  const currentspeed = dot(state.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = CVAR.sv_accelerate * dt * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;
  state.velocity = mad(state.velocity, accelspeed, wishdir);
}

// ---- Air acceleration ------------------------------------------------------
// The 30-cap is on the *projection* of velocity onto wishdir, not on total
// speed. Holding a strafe key while turning the mouse keeps wishdir slightly
// off-axis so the projection stays under 30, addspeed stays positive, and a
// small off-axis velocity is added every tick -> velocity rotates and lengthens.
export function airAccelerate(state, wishdir, wishspeed, dt) {
  let wishspd = wishspeed;
  if (wishspd > AIR_WISHSPEED_CAP) wishspd = AIR_WISHSPEED_CAP;
  const currentspeed = dot(state.velocity, wishdir);
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;
  // NOTE: full (uncapped) wishspeed is used for accelspeed, per GoldSrc.
  let accelspeed = CVAR.sv_airaccelerate * wishspeed * dt;
  if (accelspeed > addspeed) accelspeed = addspeed;
  state.velocity = mad(state.velocity, accelspeed, wishdir);
}

// ---- FlyMove: move & slide, clipping against each plane hit ----------------
export function flyMove(state, dt, world) {
  const hull = currentHull(state);
  let timeLeft = dt;
  const primal = copy(state.velocity);
  let original = copy(state.velocity);
  const planes = [];
  let blocked = 0;

  for (let bump = 0; bump < NUM_BUMPS; bump++) {
    const v = state.velocity;
    if (v[0] === 0 && v[1] === 0 && v[2] === 0) break;

    const end = mad(state.origin, timeLeft, v);
    const tr = world.traceHull(state.origin, end, hull.hullIndex);

    if (tr.allsolid) {
      // Trapped completely inside solid: kill velocity.
      state.velocity = [0, 0, 0];
      return blocked | 0x04;
    }
    if (tr.fraction > 0) {
      state.origin = tr.endpos;
      original = copy(state.velocity);
      planes.length = 0;
    }
    if (tr.fraction === 1) break; // moved the whole way

    const n = tr.plane.normal;
    if (n[2] > GROUND_NORMAL_Z) blocked |= 0x01; // hit a floor
    if (n[2] === 0) blocked |= 0x02;             // hit a vertical wall

    timeLeft -= timeLeft * tr.fraction;

    if (planes.length >= MAX_CLIP_PLANES) {
      state.velocity = [0, 0, 0];
      break;
    }
    planes.push(n);

    // Find a velocity that doesn't drive into any plane we've hit.
    let i, newVel;
    for (i = 0; i < planes.length; i++) {
      newVel = clipVelocity(original, planes[i], OVERBOUNCE);
      let j;
      for (j = 0; j < planes.length; j++) {
        if (j !== i && dot(newVel, planes[j]) < 0) break;
      }
      if (j === planes.length) break; // newVel clears all other planes
    }

    if (i < planes.length) {
      state.velocity = newVel;
    } else {
      // Caught in a crease between exactly two planes: slide along the seam.
      if (planes.length !== 2) {
        state.velocity = [0, 0, 0];
        break;
      }
      const dir = normalize(cross(planes[0], planes[1]));
      const d = dot(dir, state.velocity);
      state.velocity = [dir[0] * d, dir[1] * d, dir[2] * d];
    }

    // Anti-jitter: if we reversed back into the original direction, stop.
    if (dot(state.velocity, primal) <= 0) {
      state.velocity = [0, 0, 0];
      break;
    }
  }
  return blocked;
}

// ---- WalkMove (grounded): slide move + stair stepping (PM_StepMove) ---------
function walkMove(state, dt, world) {
  const hull = currentHull(state);
  const startOrigin = copy(state.origin);
  const startVel = copy(state.velocity);

  // (a) plain slide move
  flyMove(state, dt, world);
  const downOrigin = copy(state.origin);
  const downVel = copy(state.velocity);

  // (b) stepped move from the start: up sv_stepsize, slide, then back down
  state.origin = copy(startOrigin);
  state.velocity = copy(startVel);

  let tr = world.traceHull(
    state.origin,
    [state.origin[0], state.origin[1], state.origin[2] + CVAR.sv_stepsize],
    hull.hullIndex,
  );
  if (!tr.startsolid && !tr.allsolid) state.origin = tr.endpos;

  flyMove(state, dt, world);

  tr = world.traceHull(
    state.origin,
    [state.origin[0], state.origin[1], state.origin[2] - CVAR.sv_stepsize],
    hull.hullIndex,
  );
  const steppedOntoFloor =
    tr.fraction < 1 && tr.plane && tr.plane.normal[2] >= GROUND_NORMAL_Z && !tr.startsolid;
  if (steppedOntoFloor) state.origin = tr.endpos;

  const upOrigin = copy(state.origin);
  const upVel = copy(state.velocity);

  const downDist =
    (downOrigin[0] - startOrigin[0]) ** 2 + (downOrigin[1] - startOrigin[1]) ** 2;
  const upDist = (upOrigin[0] - startOrigin[0]) ** 2 + (upOrigin[1] - startOrigin[1]) ** 2;

  if (!steppedOntoFloor || downDist >= upDist) {
    state.origin = downOrigin;
    state.velocity = downVel;
  } else {
    state.origin = upOrigin;
    state.velocity = upVel;
    state.velocity[2] = downVel[2]; // keep vertical velocity from the flat move
  }
}

// ---- Jump ------------------------------------------------------------------
function handleJump(state, cmd, cfg) {
  const canJump = state.onground && cmd.jump && (cfg.autohop || !state.jumpHeld);
  if (canJump) {
    state.velocity[2] = Math.sqrt(2 * CVAR.sv_gravity * JUMP_HEIGHT);
    state.onground = false;
    state.groundNormal = null;
  }
  state.jumpHeld = cmd.jump;
}

// ---- Duck / unduck ---------------------------------------------------------
// Hull is centered on origin. Standing half-height 36, ducking 18. To keep the
// feet planted on the ground, lower the origin by 18 when ducking, raise when
// standing. Standing back up requires headroom (point test with the stand hull).
function handleDuck(state, cmd, world) {
  if (cmd.duck && !state.ducking) {
    state.ducking = true;
    if (state.onground) state.origin[2] -= 18;
  } else if (!cmd.duck && state.ducking) {
    const target = state.onground
      ? [state.origin[0], state.origin[1], state.origin[2] + 18]
      : copy(state.origin);
    if (world.pointContents(target, HULL.STAND.hullIndex) !== CONTENTS.SOLID) {
      state.ducking = false;
      if (state.onground) state.origin[2] += 18;
    }
  }
}

export function clampVelocity(state) {
  const m = CVAR.sv_maxvelocity;
  for (let i = 0; i < 3; i++) {
    if (state.velocity[i] > m) state.velocity[i] = m;
    else if (state.velocity[i] < -m) state.velocity[i] = -m;
  }
  // guard against NaN from any degenerate trace
  for (let i = 0; i < 3; i++) if (!Number.isFinite(state.velocity[i])) state.velocity[i] = 0;
}

// ---- One physics tick ------------------------------------------------------
// cmd = { forwardmove, sidemove, yaw, pitch, jump, duck }
export function runTick(state, cmd, world, cfg = { autohop: false }, dt = 0.01) {
  // 1-2: build wishdir / wishspeed and clamp to maxspeed
  const { forward, right } = horizontalBasis(cmd.yaw);
  const wishvel = [
    forward[0] * cmd.forwardmove + right[0] * cmd.sidemove,
    forward[1] * cmd.forwardmove + right[1] * cmd.sidemove,
    0,
  ];
  let wishspeed = Math.hypot(wishvel[0], wishvel[1]);
  const wishdir = wishspeed > 1e-6 ? [wishvel[0] / wishspeed, wishvel[1] / wishspeed, 0] : [0, 0, 0];
  if (wishspeed > CVAR.sv_maxspeed) wishspeed = CVAR.sv_maxspeed;

  // duck state transition (affects which hull is used below)
  handleDuck(state, cmd, world);

  // 3: categorize
  categorizePosition(state, world);

  // 4: jump (clears onground)
  handleJump(state, cmd, cfg);

  if (state.onground) {
    // 5: friction then ground acceleration; no gravity while walking
    friction(state, dt);
    groundAccelerate(state, wishdir, wishspeed, dt);
    // 7: move along the ground with stair stepping
    walkMove(state, dt, world);
  } else {
    // 6: gravity split + air acceleration around the move
    state.velocity[2] -= 0.5 * CVAR.sv_gravity * dt;
    airAccelerate(state, wishdir, wishspeed, dt);
    state.blocked = flyMove(state, dt, world); // 7
    state.velocity[2] -= 0.5 * CVAR.sv_gravity * dt;
  }

  // 8: recategorize after moving
  categorizePosition(state, world);
  // 9: clamp velocity
  clampVelocity(state);

  return state;
}

export const speed2d = (state) => Math.hypot(state.velocity[0], state.velocity[1]);
