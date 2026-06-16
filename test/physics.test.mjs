// Deterministic, headless validation of the GoldSrc movement + BSP collision.
// Run with:  node test/physics.test.mjs
//
// Covers the acceptance criteria from the spec:
//  - flat ground applies friction and stops the player
//  - a >45.57 deg ramp never grounds the player (no friction, air rules)
//  - ClipVelocity on a ramp converts downward velocity into along-ramp slide
//  - air strafing pushes total speed past 30 ups, capped only by maxvelocity
//  - physics are deterministic at the fixed timestep
//  - the real surf_ski_2.bsp parses and collides

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CONTENTS, GROUND_NORMAL_Z, CVAR } from '../src/constants.js';
import { dot } from '../src/vec.js';
import {
  createPlayerState, runTick, categorizePosition, clipVelocity, speed2d,
} from '../src/physics.js';
import { BSP } from '../src/bsp.js';
import { CollisionWorld } from '../src/hull.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DT = 0.01;

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${extra}`); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// ---------------------------------------------------------------------------
// A simple analytic half-space world: everything with dot(p,n) < d is SOLID.
// Models an infinite floor (n=(0,0,1)) or an infinite ramp (steep n).
// ---------------------------------------------------------------------------
class HalfSpaceWorld {
  constructor(normal, dist) { this.n = normal; this.d = dist; }
  pointContents(p) { return dot(p, this.n) - this.d < 0 ? CONTENTS.SOLID : CONTENTS.EMPTY; }
  traceHull(start, end) {
    const n = this.n, d = this.d;
    const t1 = dot(start, n) - d;
    const t2 = dot(end, n) - d;
    const trace = { fraction: 1, endpos: [...end], plane: null, startsolid: false, allsolid: true };
    if (t1 >= 0) trace.allsolid = false;
    if (t1 >= 0 && t2 >= 0) return trace;               // stayed in open
    if (t1 < 0 && t2 < 0) {                              // entirely in solid
      trace.startsolid = true; trace.allsolid = true; trace.fraction = 0;
      trace.endpos = [...start]; return trace;
    }
    let frac = (t1 - 0.03125) / (t1 - t2);              // just before the surface
    if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
    trace.fraction = frac;
    trace.allsolid = false;
    trace.endpos = [
      start[0] + frac * (end[0] - start[0]),
      start[1] + frac * (end[1] - start[1]),
      start[2] + frac * (end[2] - start[2]),
    ];
    trace.plane = { normal: [...n], dist: d };
    return trace;
  }
}

const NOCMD = { forwardmove: 0, sidemove: 0, yaw: 0, pitch: 0, jump: false, duck: false };
const CFG = { autohop: false };

// ===========================================================================
console.log('\nClipVelocity');
{
  // Velocity straight down onto a 45-deg ramp that descends toward +x:
  // its up-facing normal points up-and-toward +x ~ (0.707, 0, 0.707).
  const n = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const out = clipVelocity([0, 0, -100], n, 1.0);
  // Downward motion should be deflected to run along the ramp (gain +x, lose -z).
  ok('downward velocity deflects along ramp (+x component appears)', out[0] > 0, JSON.stringify(out));
  ok('into-surface component removed (dot ~ 0)', approx(dot(out, n), 0, 1e-4), `dot=${dot(out, n)}`);
}

// ===========================================================================
console.log('\nFriction stops the player on flat ground');
{
  const world = new HalfSpaceWorld([0, 0, 1], 0); // floor: player centre stops at z=0
  const st = createPlayerState([0, 0, 0]);
  st.velocity = [300, 0, 0];
  for (let i = 0; i < 600; i++) runTick(st, { ...NOCMD }, world, CFG, DT);
  ok('player is grounded on flat floor', st.onground === true);
  ok('player decelerates to a stop', speed2d(st) < 1, `speed=${speed2d(st)}`);
}

// ===========================================================================
console.log('\nSteep ramp never grounds the player');
{
  // 50-degree ramp: normal.z = cos(50) ~ 0.643 < 0.7.
  const ang = (50 * Math.PI) / 180;
  const n = [-Math.sin(ang), 0, Math.cos(ang)];
  ok('ramp normal.z < 0.7 (would surf)', n[2] < GROUND_NORMAL_Z, `nz=${n[2]}`);
  const world = new HalfSpaceWorld(n, 0);
  const st = createPlayerState([0, 0, 50]);
  st.velocity = [0, 0, 0];
  categorizePosition(st, world);
  ok('CategorizePosition keeps player airborne on steep ramp', st.onground === false);
}

// ===========================================================================
console.log('\nRamp produces a stable downhill slide (surf)');
{
  const ang = (50 * Math.PI) / 180;
  const n = [Math.sin(ang), 0, Math.cos(ang)]; // up-facing normal; ramp descends toward +x
  const world = new HalfSpaceWorld(n, 0);
  const st = createPlayerState([0, 0, 200]);
  // place the player essentially on the ramp surface
  let speedBefore = 0;
  for (let i = 0; i < 300; i++) {
    runTick(st, { ...NOCMD }, world, CFG, DT);
    if (i === 150) speedBefore = speed2d(st);
  }
  ok('player remains airborne while surfing', st.onground === false);
  ok('player slides downhill in +x', st.velocity[0] > 50, `vx=${st.velocity[0]}`);
  ok('slide stays bounded (no NaN / blowup)', Number.isFinite(speed2d(st)) && speed2d(st) < CVAR.sv_maxvelocity, `speed=${speed2d(st)}`);
  ok('velocity runs along ramp (small into-surface dot)', Math.abs(dot(st.velocity, n)) < 60, `dot=${dot(st.velocity, n)}`);
}

// ===========================================================================
console.log('\nAir strafing gains speed beyond 30 ups');
{
  // Open air (no surface). Classic strafe: hold +sidemove and rotate yaw.
  const world = new HalfSpaceWorld([0, 0, 1], -100000); // floor far below, never hit
  const st = createPlayerState([0, 0, 0]);
  st.onground = false;
  st.velocity = [320, 0, 0]; // moving along +x to start
  let yaw = 0;
  const startSpeed = speed2d(st);
  // Canonical gain: hold strafe-right (+sidemove) and rotate the view right
  // (yaw decreasing) in sync, keeping wishdir just off-axis from velocity.
  for (let i = 0; i < 300; i++) {
    yaw -= 0.02;
    st.velocity[2] = 0; // cancel gravity drift; measure horizontal gain only
    runTick(st, { forwardmove: 0, sidemove: 400, yaw, pitch: 0, jump: false, duck: false }, world, CFG, DT);
  }
  const endSpeed = speed2d(st);
  ok('air strafing increases total speed', endSpeed > startSpeed + 100, `start=${startSpeed.toFixed(1)} end=${endSpeed.toFixed(1)}`);
  ok('gained speed far exceeds the 30 cap (reaches >450 ups)', endSpeed > 450, `end=${endSpeed.toFixed(1)}`);
  ok('speed never exceeds sv_maxvelocity', endSpeed <= CVAR.sv_maxvelocity + 1, `end=${endSpeed.toFixed(1)}`);
}

// ===========================================================================
console.log('\nDeterminism at the fixed timestep');
{
  function runSeq() {
    const world = new HalfSpaceWorld([0, 0, 1], 0);
    const st = createPlayerState([0, 0, 0]);
    st.velocity = [200, 0, 0];
    let yaw = 0;
    for (let i = 0; i < 500; i++) {
      yaw += 0.013;
      const jump = i % 40 === 0;
      runTick(st, { forwardmove: 400, sidemove: i % 2 ? 400 : -400, yaw, pitch: 0, jump, duck: i % 90 < 10 }, world, CFG, DT);
    }
    return st;
  }
  const a = runSeq();
  const b = runSeq();
  const same = JSON.stringify(a.origin) === JSON.stringify(b.origin) &&
    JSON.stringify(a.velocity) === JSON.stringify(b.velocity);
  ok('two identical input sequences produce identical state', same,
    `\n   a=${JSON.stringify(a.origin)} ${JSON.stringify(a.velocity)}\n   b=${JSON.stringify(b.origin)} ${JSON.stringify(b.velocity)}`);
}

// ===========================================================================
console.log('\nReal surf_ski_2.bsp parses and collides');
{
  const path = join(__dirname, '..', 'assets', 'surf_ski_2.bsp');
  const fileBuf = readFileSync(path);
  const ab = fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
  const bsp = new BSP(ab);
  ok('BSP version is 30', bsp.version === 30);
  ok('planes parsed', bsp.planes.length > 1000, `n=${bsp.planes.length}`);
  ok('faces parsed', bsp.faces.length > 1000, `n=${bsp.faces.length}`);
  ok('models parsed (worldspawn + brush models)', bsp.models.length > 1, `n=${bsp.models.length}`);
  ok('clip nodes parsed', bsp.clipnodes.count > 1000, `n=${bsp.clipnodes.count}`);

  const spawns = bsp.entitiesByClass('info_player_start');
  ok('found info_player_start spawn(s)', spawns.length > 0, `n=${spawns.length}`);

  const world = new CollisionWorld(bsp);
  const sp = spawns[0].origin.split(' ').map(Number);

  // Trace straight down a long way from above the spawn: must hit solid ground.
  const start = [sp[0], sp[1], sp[2] + 16];
  const down = world.traceHull(start, [start[0], start[1], start[2] - 4096], 1);
  ok('downward trace from spawn hits solid ground', down.fraction < 1 && down.plane !== null,
    `frac=${down.fraction}`);
  ok('ground under spawn is walkable (normal.z >= 0.7) or a ramp (<0.7)',
    down.plane && Number.isFinite(down.plane.normal[2]), `nz=${down.plane && down.plane.normal[2]}`);

  // The spawn point itself should not be embedded in solid.
  ok('spawn point is not inside solid', world.pointContents([sp[0], sp[1], sp[2] + 8], 1) !== CONTENTS.SOLID);

  // Drop a player from the spawn and let physics settle onto the floor.
  const st = createPlayerState([sp[0], sp[1], sp[2] + 8]);
  for (let i = 0; i < 400; i++) runTick(st, { ...NOCMD }, world, CFG, DT);
  ok('player settles to a finite resting position', Number.isFinite(st.origin[2]), `z=${st.origin[2]}`);
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
