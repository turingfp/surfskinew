// Local AI opponents. A Bot is a fully client-simulated entity: its own
// physics state (runTick, same as the human player), navmesh-driven
// wandering/pursuit, and hitscan combat against the local player. Bots are
// NOT broadcast over the P2P mesh — they exist only for the client that
// spawned them (see main.js's room-gating). They're rendered and made
// hittable by piggybacking on RemotePlayers, which doesn't care whether an
// entry came from a real peer or a bot.

import { createPlayerState, runTick } from './physics.js';
import { FORWARD_SPEED } from './constants.js';
import { normalize, length, sub } from './vec.js';
import { weaponSpec, WEAPON_LIST } from './weapons.js';

const NAMES = ['Raptor', 'Ghost', 'Viper', 'Reaper', 'Nomad', 'Cobra', 'Blitz', 'Hunter', 'Rhino', 'Falcon', 'Jackal', 'Widow'];
let nameSeq = 0;
export function nextBotName() { return NAMES[nameSeq++ % NAMES.length] + (nameSeq > NAMES.length ? nameSeq : ''); }

const VIEWZ = 17; // matches HULL.STAND.viewZ (constants.js) — bots don't duck
const SIGHT_RANGE = 3000;
const AIM_TURN_RATE = 6; // rad/s, how fast the bot's crosshair tracks a target
const WAYPOINT_RADIUS = 40;
const REPATH_INTERVAL = 1.5;
const STUCK_CHECK_INTERVAL = 1.2;
const STUCK_DIST = 24; // if the bot hasn't moved this far in STUCK_CHECK_INTERVAL, it's stuck
// The full CS 1.6 arsenal — every weapon has a complete spec (weapons.js),
// a first-person viewmodel, and a third-person aim pose (remote.js's
// AIM_CATEGORY), so bots can safely use any of them.
const WEAPON_CHOICES = WEAPON_LIST;

function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * Math.min(1, t);
}

function dirToAngles(dir) {
  return { yaw: Math.atan2(dir[1], dir[0]), pitch: Math.asin(Math.max(-1, Math.min(1, -dir[2]))) };
}

export class Bot {
  constructor(id, origin, yaw, weaponId) {
    this.id = id;
    this.name = nextBotName();
    this.weaponId = weaponId || WEAPON_CHOICES[(Math.random() * WEAPON_CHOICES.length) | 0];
    this.state = createPlayerState(origin);
    this.moveYaw = yaw || 0;
    this.aimYaw = yaw || 0;
    this.aimPitch = 0;
    this.health = 100;
    this.kills = 0;
    this.deaths = 0;
    this.dead = false;
    this.path = null;
    this.pathIdx = 0;
    this.repathAt = 0;
    this.fireCooldown = 0.5 + Math.random() * 0.5; // don't all open fire on the same tick
    // Finite clip, like the player: running dry forces a reload pause, so
    // firefights have openings instead of one uninterrupted hitscan stream.
    this.clip = weaponSpec(this.weaponId).clip;
    this.reloadUntil = 0;
    this._reloading = false;
    this._stuckAt = 0;
    this._stuckOrigin = origin.slice();
    this._wantJump = false;
  }

  get eyeGS() { return [this.state.origin[0], this.state.origin[1], this.state.origin[2] + VIEWZ]; }

  takeDamage(dmg) {
    if (this.dead) return false;
    this.health -= dmg;
    if (this.health <= 0) { this.dead = true; this.deaths++; return true; }
    return false;
  }

  respawn(origin, yaw) {
    this.state = createPlayerState(origin);
    this.moveYaw = this.aimYaw = yaw || 0;
    this.aimPitch = 0;
    this.health = 100;
    this.dead = false;
    this.path = null; this.pathIdx = 0;
    this.clip = weaponSpec(this.weaponId).clip; // fresh life, fresh loadout (matches the player's respawn)
    this.reloadUntil = 0; this._reloading = false;
    this._stuckOrigin = origin.slice(); this._stuckAt = 0;
  }

  // Pick a new goal — chase the target's last position most of the time,
  // otherwise wander to a random navmesh node so idle bots don't stand still.
  _updateGoal(navGraph, now, targetOriginGS) {
    if (!navGraph || navGraph.nodes.length === 0) return;
    const needNew = !this.path || this.pathIdx >= this.path.length || now > this.repathAt;
    if (!needNew) return;
    this.repathAt = now + REPATH_INTERVAL + Math.random() * 0.5;
    const goalPos = (targetOriginGS && Math.random() < 0.75)
      ? targetOriginGS
      : navGraph.nodes[navGraph.randomNodeIndex()].pos;
    const path = navGraph.findPath(this.state.origin, goalPos);
    if (path && path.length) { this.path = path; this.pathIdx = 0; }
  }

  _followPath(dt, now) {
    // stuck detection: no meaningful progress despite having a path -> jump + repath
    if (now - this._stuckAt > STUCK_CHECK_INTERVAL) {
      const moved = Math.hypot(this.state.origin[0] - this._stuckOrigin[0], this.state.origin[1] - this._stuckOrigin[1]);
      if (this.path && moved < STUCK_DIST) { this._wantJump = true; this.repathAt = now; }
      this._stuckAt = now; this._stuckOrigin = this.state.origin.slice();
    }
    while (this.path && this.pathIdx < this.path.length) {
      const wp = this.path[this.pathIdx];
      const dx = wp[0] - this.state.origin[0], dy = wp[1] - this.state.origin[1];
      if (Math.hypot(dx, dy) < WAYPOINT_RADIUS) { this.pathIdx++; continue; }
      this.moveYaw = Math.atan2(dy, dx);
      const jump = this._wantJump || ((wp[2] - this.state.origin[2]) > 18 && this.state.onground);
      this._wantJump = false;
      return { forwardmove: FORWARD_SPEED, sidemove: 0, jump };
    }
    return { forwardmove: 0, sidemove: 0, jump: false };
  }

  // ctx: { world, navGraph, dt, now, target: { originGS, eyeGS } | null }
  // Returns a fired-shot descriptor ({ eyeGS, aimYaw, aimPitch, dmg, spec }) or null.
  think(ctx) {
    if (this.dead) return null;
    const { world, navGraph, dt, now, target } = ctx;
    const eye = this.eyeGS;

    let canSee = false, distToTarget = Infinity;
    if (target) {
      const d = sub(target.eyeGS, eye);
      distToTarget = length(d);
      if (distToTarget < SIGHT_RANGE) {
        const tr = world.traceBullet(eye, target.eyeGS);
        if (tr.fraction > 0.97) canSee = true;
      }
    }

    if (canSee) {
      const { yaw, pitch } = dirToAngles(normalize(sub(target.eyeGS, eye)));
      this.aimYaw = angleLerp(this.aimYaw, yaw, AIM_TURN_RATE * dt);
      this.aimPitch = angleLerp(this.aimPitch, pitch, AIM_TURN_RATE * dt);
    }

    let fired = null;
    this.fireCooldown -= dt;
    this._reloading = now < this.reloadUntil;
    if (!this._reloading && canSee && this.fireCooldown <= 0) {
      const spec = weaponSpec(this.weaponId);
      if (this.clip <= 0) {
        // dry: hold fire for the weapon's reload time. Refill immediately —
        // the reloadUntil gate above is what actually keeps the gun silent.
        this.reloadUntil = now + spec.reload;
        this.clip = spec.clip;
        this._reloading = true;
      } else {
        this.clip--;
        this.fireCooldown = spec.rate * (1 + Math.random() * 0.4); // a little human irregularity
        fired = { eyeGS: eye, aimYaw: this.aimYaw, aimPitch: this.aimPitch, dmg: spec.dmg, spec };
      }
    }

    this._updateGoal(navGraph, now, target ? target.originGS : null);
    const move = this._followPath(dt, now);
    const cmd = { forwardmove: move.forwardmove, sidemove: move.sidemove, yaw: this.moveYaw, pitch: 0, jump: move.jump, duck: false };
    runTick(this.state, cmd, world, { autohop: false }, dt);

    this._canSee = canSee;
    return fired;
  }

  // Avatar-facing yaw for rendering: look at the target while engaging, else
  // face the direction of travel.
  get facingYaw() { return this._canSee ? this.aimYaw : this.moveYaw; }
}
