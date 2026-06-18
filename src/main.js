// Entry point: load surf_ski_2.bsp, build the scene + collision world, and run
// the fixed-timestep GoldSrc movement with render interpolation.

import * as THREE from '../vendor/three.module.js';
import { loadBSP } from './bsp.js';
import { CollisionWorld } from './hull.js';
import { buildLevel, buildProcLevel, buildWorldModel, buildSky, gs2three, setMaxAnisotropy, makeWorldTexture } from './render.js';
import { generateSurfArena, BrushWorld } from './procmap.js';
import { loadMDL } from './mdl.js';
import { createPlayerState, runTick, speed2d, waterMove, ladderMove } from './physics.js';
import { Entities } from './entities.js';
import { Weapons, WEAPON_LIST } from './weapons.js';
import { Net } from './net.js';
import { RemotePlayers } from './remote.js';
import { Viewmodel } from './viewmodel.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { FIXED_DT, HULL, CONTENTS, CVAR } from './constants.js';
import { angleVectors, copy } from './vec.js';

const statusEl = document.getElementById('status');
const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

// ---- Renderer / scene ------------------------------------------------------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false; // we clear manually to overlay the weapon viewmodel
renderer.info.autoReset = false; // accumulate stats across both passes per frame
// Anisotropic filtering keeps floor/ramp textures crisp at grazing angles
// instead of moiréing into "weird lines"; applied to every world texture.
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();
setMaxAnisotropy(MAX_ANISO);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd2e6);
scene.fog = new THREE.Fog(0xbfd2e6, 6000, 24000);

const camera = new THREE.PerspectiveCamera(80, 1, 1, 60000);
camera.up.set(0, 1, 0);

// Bright, flat-ish lighting so fallback-coloured surfaces stay readable.
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const hemi = new THREE.HemisphereLight(0xdfe9f2, 0x40452f, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(0.5, 1, 0.3);
scene.add(sun);

const skyDome = buildSky(); // gradient fallback; replaced by the cubemap if it loads
scene.add(skyDome);

// Office skybox (converted from the map's TGA sky faces). Three cube order is
// [+X,-X,+Y,-Y,+Z,-Z]; with our Z-up->Y-up transform that maps to ft,bk,up,dn,rt,lf.
function loadSkybox() {
  new THREE.CubeTextureLoader()
    .setPath('assets/skybox/')
    .load(
      ['ft.png', 'bk.png', 'up.png', 'dn.png', 'rt.png', 'lf.png'],
      (cube) => {
        cube.colorSpace = THREE.SRGBColorSpace;
        scene.background = cube;
        scene.remove(skyDome);
      },
      undefined,
      () => { /* keep gradient on failure */ },
    );
}

// ---- Fallback texture (procedural grid; swapped for a Kenney prototype if shipped) ----
function makeGridTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#8a8f96';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 2;
  for (let i = 0; i <= s; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(s, i); g.stroke();
  }
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 4; g.strokeRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = MAX_ANISO;
  t.colorSpace = THREE.SRGBColorSpace;
  // BSP UVs are in pixels/texWidth; a 64px-equivalent repeat reads well.
  t.repeat.set(1, 1);
  return t;
}

// Prefer a shipped prototype texture (e.g. a CC0 Kenney grid) if one exists.
// fetch-based so a missing optional asset doesn't spam the console with 404s.
// Goes through makeWorldTexture so WAD floors get POT dimensions + an explicit
// mip chain — without it, NPOT textures alias into "weird lines" on iOS/WebGL1.
async function tryLoadTexture(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    return makeWorldTexture(bmp);
  } catch {
    return null;
  }
}

// Load the real WAD textures a map needs (decoded to PNGs at build time, see
// tools/extract_wads.mjs). Only fetches names present in the manifest.
async function loadWadTextures(bsp) {
  const map = new Map();
  let manifest;
  try { manifest = new Set(await (await fetch('assets/wadtex/manifest.json')).json()); } catch { return map; }
  const want = new Set();
  for (const t of bsp.textures) {
    const nm = (t.name || '').toLowerCase();
    if (!t.embedded && nm && manifest.has(nm)) want.add(nm);
  }
  await Promise.all([...want].map(async (nm) => {
    const tex = await tryLoadTexture(`assets/wadtex/${encodeURIComponent(nm)}.png`);
    if (tex) map.set(nm, tex);
  }));
  console.log(`[surf] WAD textures: ${map.size}/${want.size}`);
  return map;
}

// ---- World / player state --------------------------------------------------
let world, state, input, hud, viewmodel, entities, weapons;
let net, remotePlayers;
let bounds, killZ, spawn;
let prevOrigin;
let accumulator = 0;
let lastT = performance.now() / 1000;
let runTime = 0;
let runStarted = false;
let netAcc = 0; // throttle state broadcasts to ~20 Hz
let envWater = false, envLadder = false; // last movement environment (for HUD)
let fpsEMA = 60; // smoothed frames-per-second for the HUD
let pickups = []; // weapon pickups in the world {weaponId, origin, mesh, baseY, taken, respawnAt}
const pickupModelCache = new Map(); // weaponId -> THREE template group

// viewmodel sources for lazy loading (pistols skip the floating bodypart)
const WEAPON_VMODELS = {};
for (const id of WEAPON_LIST) {
  WEAPON_VMODELS[id] = { url: `assets/models/cs/v_${id}.mdl`, skip: (id === 'usp' || id === 'deagle' || id === 'glock') ? ['rhand'] : [] };
}
function ensureViewmodel(id) { if (viewmodel && WEAPON_VMODELS[id] && !viewmodel.has(id)) viewmodel.loadOne(id, WEAPON_VMODELS[id]); }
let checkpoint = null; // {origin, yaw} for practice save/load

// ---- Map selection (?map=surf_green) ---------------------------------------
const MAPS = {
  surf_ski_2: 'assets/maps/surf_ski_2.bsp',
  surf_green: 'assets/maps/surf_green.bsp',
  surf_nice_fly_3: 'assets/maps/surf_nice_fly_3.bsp',
  surf_sand: 'assets/maps/surf_sand.bsp',
  surf_egypt: 'assets/maps/surf_egypt.bsp',
  fy_pool_day: 'assets/maps/fy_pool_day.bsp',
  surf_arena: 'proc', // procedurally generated (no BSP)
};
const mapParam = new URLSearchParams(location.search).get('map');
const MAP_NAME = MAPS[mapParam] ? mapParam : 'surf_ski_2';

// ---- Persistent settings + personal bests ----------------------------------
function loadJSON(key, fallback) { try { return Object.assign({}, fallback, JSON.parse(localStorage.getItem(key) || '{}')); } catch { return { ...fallback }; } }
const SETTINGS = loadJSON('surf_settings', { sens: 2.2, fov: 90, vol: 60, quality: 100 });
function saveSettings() { try { localStorage.setItem('surf_settings', JSON.stringify(SETTINGS)); } catch { /* ignore */ } }
const PB_TIME_KEY = `surf_pbtime_${MAP_NAME}`;
const PB_SPEED_KEY = `surf_pbspeed_${MAP_NAME}`;
let pbTime = Number(localStorage.getItem(PB_TIME_KEY)) || null;
let pbSpeed = Number(localStorage.getItem(PB_SPEED_KEY)) || 0;

// multiplayer identity + combat stats
let playerName = localStorage.getItem('surf_name') || `Surfer${Math.floor(1000 + Math.random() * 9000)}`;
let health = 100, kills = 0, deaths = 0;
let finishTime = null; // set when a finish zone is crossed (if configured)

// ---- Damage direction indicator + death flash --------------------------------
const dmgDirEl = document.getElementById('dmg-dir');
const dmgArcEl = document.getElementById('dmg-arc');
const deathFlashEl = document.getElementById('death-flash');
let _dmgDirTimer = null;
let _deathFlashTimer = null;

function showDamageDir(attackerGsPos) {
  if (!dmgDirEl || !dmgArcEl || !state) return;
  const dx = attackerGsPos[0] - state.origin[0];
  const dy = attackerGsPos[1] - state.origin[1];
  if (Math.hypot(dx, dy) < 1) return;
  const yaw = input ? input.yaw : 0;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const fwd = dx * cy + dy * sy;
  const rgt = dx * sy - dy * cy;
  const angleDeg = Math.atan2(rgt, fwd) * 180 / Math.PI;
  dmgArcEl.style.transform = `rotate(${angleDeg}deg)`;
  dmgDirEl.classList.add('show');
  clearTimeout(_dmgDirTimer);
  _dmgDirTimer = setTimeout(() => dmgDirEl.classList.remove('show'), 650);
}

function showDeathFlash() {
  if (!deathFlashEl) return;
  deathFlashEl.classList.add('show');
  clearTimeout(_deathFlashTimer);
  _deathFlashTimer = setTimeout(() => deathFlashEl.classList.remove('show'), 1100);
}

// Optional per-map start/finish zones for timed runs. Start auto-derives from
// the spawn; finish is map-specific (left null = freestyle race by top speed).
const MAP_ZONES = {
  // surf_green: { finish: { min: [...], max: [...] } },
};

function applySettings() {
  if (input) input.sensitivity = SETTINGS.sens / 1000;
  if (weapons) weapons.masterVol = SETTINGS.vol / 100;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * (SETTINGS.quality / 100));
  onResize();
}

function parseSpawn(bsp) {
  const list = bsp.entitiesByClass('info_player_start')
    .concat(bsp.entitiesByClass('info_player_deathmatch'));
  const all = [];
  for (const e of list) {
    if (!e.origin) continue;
    const o = e.origin.split(/\s+/).map(Number);
    if (o.length === 3 && o.every(Number.isFinite)) {
      const yaw = e.angles ? (Number(e.angles.split(/\s+/)[1]) || 0) * Math.PI / 180 : 0;
      all.push({ origin: o, yaw });
    }
  }
  if (!all.length) all.push({ origin: [0, 0, 0], yaw: 0 }); // fallback: world centre
  return { ...all[0], all };
}

// Pick a spawn that no remote player is currently standing on, so respawns
// don't stack players on top of each other (spawn clipping). Falls back to a
// random spawn, or jitters the single spawn when a map only has one.
function chooseSpawn() {
  const all = (spawn && spawn.all) || [spawn];
  if (all.length > 1 && remotePlayers) {
    const occupied = [];
    remotePlayers.forEach((id, o) => occupied.push(o));
    const free = all.filter((s) => !occupied.some((o) => Math.hypot(o[0] - s.origin[0], o[1] - s.origin[1], o[2] - s.origin[2]) < 48));
    const pool = free.length ? free : all;
    return pool[(Math.random() * pool.length) | 0];
  }
  if (all.length > 1) return all[(Math.random() * all.length) | 0];
  // single spawn: small horizontal jitter so co-spawned players don't overlap
  const s = all[0];
  return { origin: [s.origin[0] + (Math.random() - 0.5) * 40, s.origin[1] + (Math.random() - 0.5) * 40, s.origin[2]], yaw: s.yaw };
}

// Nudge a fresh spawn out of any solid it overlaps, then drop it.
function settleSpawn(origin) {
  const o = copy(origin);
  let tries = 0;
  while (world.pointContents(o, HULL.STAND.hullIndex) === CONTENTS.SOLID && tries < 64) {
    o[2] += 8; tries++;
  }
  return o;
}

function respawn() {
  // bank the best run time when a real run ends
  if (runStarted && runTime > 1 && (pbTime == null || runTime > pbTime)) {
    pbTime = runTime;
    try { localStorage.setItem(PB_TIME_KEY, String(pbTime)); } catch { /* ignore */ }
    if (hud) hud.toast(`LONGEST RUN  ${fmtClock(pbTime)}`, '#7fd1ae');
  }
  const sp = chooseSpawn();
  state = createPlayerState(settleSpawn(sp.origin));
  state.velocity = [0, 0, 0];
  if (input) { input.yaw = sp.yaw; input.pitch = 0; }
  prevOrigin = copy(state.origin);
  runTime = 0; runStarted = false; finishTime = null;
  health = 100;
  if (hud) hud.peak = 0;
}

// Ray vs sphere (GS). Returns distance along (normalized) dir to the hit, or null.
function raySphere(eye, dir, c, r) {
  const ox = c[0] - eye[0], oy = c[1] - eye[1], oz = c[2] - eye[2];
  const t = ox * dir[0] + oy * dir[1] + oz * dir[2];
  if (t < 0) return null;
  const dx = ox - dir[0] * t, dy = oy - dir[1] * t, dz = oz - dir[2] * t;
  return (dx * dx + dy * dy + dz * dz) <= r * r ? t : null;
}

// Closest remote player hit by a shot (body sphere + head sphere).
function playerHitTest(eyeGS, dirGS) {
  if (!remotePlayers) return null;
  let best = null;
  remotePlayers.forEach((id, o) => {
    const body = raySphere(eyeGS, dirGS, o, 22);
    const head = raySphere(eyeGS, dirGS, [o[0], o[1], o[2] + 30], 13);
    let t = null;
    if (body != null) t = body;
    if (head != null && (t == null || head < t)) t = head;
    if (t != null && (!best || t < best.dist)) best = { id, dist: t };
  });
  return best;
}

function applyDamage(dmg, by, attackerPos) {
  if (input && input.noclip) return;
  if (attackerPos) showDamageDir(attackerPos);
  health -= dmg;
  if (health <= 0) {
    deaths++;
    addKill(`<b>${escHtml(by)}</b> ▸ ${escHtml(playerName)}`);
    if (net && net.connected) net.broadcastFrag({ by, victim: playerName });
    if (hud) hud.toast(`Fragged by ${escHtml(by)}`, '#ff6b6b');
    showDeathFlash();
    respawn(); // resets health to 100
  }
}

function inAABB(p, b) {
  return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
}

function fmtClock(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function handleCheckpoint(action) {
  if (!state) return;
  if (action === 'save') {
    checkpoint = { origin: copy(state.origin), yaw: input.yaw };
    if (hud) hud.toast('Checkpoint saved', '#9be08a');
  } else if (action === 'load' && checkpoint) {
    state.origin = copy(checkpoint.origin);
    state.velocity = [0, 0, 0];
    input.yaw = checkpoint.yaw;
    prevOrigin = copy(state.origin);
    if (hud) hud.toast('Checkpoint loaded', '#9be08a');
  }
}

// ---- Fixed-step physics ----------------------------------------------------
function stepPhysics(dt) {
  prevOrigin = copy(state.origin);

  if (input.noclip) {
    const cmd = input.command();
    const { forward, right } = angleVectors(input.pitch, input.yaw);
    const sp = 1500 * dt;
    for (let i = 0; i < 3; i++) {
      state.origin[i] += (forward[i] * (cmd.forwardmove / 400) + right[i] * (cmd.sidemove / 400)) * sp;
    }
    if (cmd.jump) state.origin[2] += sp;
    if (cmd.duck) state.origin[2] -= sp;
    state.velocity = [0, 0, 0];
    return;
  }

  const cmd = input.command();

  // Choose the movement mode based on the volume the player is in. Water is
  // detected via the BSP node tree (CONTENTS_WATER) which is reliable.
  // Underwater = the player point is actually inside a water brush (its node
  // tree reads WATER or SOLID), not merely inside its bounding box. This stops
  // tall/oversized func_water AABBs (e.g. surf_ski_2's centre box) from
  // false-triggering and slowing surfers flying through empty space.
  let inWater = world.pointWaterContents && world.pointWaterContents(state.origin) === CONTENTS.WATER;
  if (!inWater && entities && world.modelContents) {
    const p = state.origin;
    for (const wv of entities.waters) {
      const b = wv.box;
      if (p[0] < b.min[0] || p[0] > b.max[0] || p[1] < b.min[1] || p[1] > b.max[1] || p[2] < b.min[2] || p[2] > b.max[2]) continue;
      const c = world.modelContents(p, wv.mi);
      if (c === CONTENTS.WATER || c === CONTENTS.SOLID) { inWater = true; break; }
    }
  }
  const onLadder = !inWater && entities && entities.onLadder(state.origin);
  envWater = inWater; envLadder = onLadder;
  if (inWater) {
    waterMove(state, cmd, world, dt);
  } else if (onLadder) {
    ladderMove(state, cmd, world, dt);
  } else {
    runTick(state, cmd, world, { autohop: input.autohop }, dt);
  }

  // boosters (trigger_push) + teleports (trigger_teleport) + trigger_hurt
  if (entities) {
    const r = entities.apply(state);
    if (r.hurt) { respawn(); return; } // fell into a kill trigger
    if (r.teleported) {
      if (r.teleported.yaw != null && input) input.yaw = r.teleported.yaw;
      prevOrigin = copy(state.origin); // avoid a long interpolation streak
    }
  }

  // start the run timer on first real movement input
  if (!runStarted && (cmd.forwardmove || cmd.sidemove || cmd.jump)) runStarted = true;
  if (runStarted && finishTime == null) runTime += dt;

  // timed-run finish (only if a finish zone is configured for this map)
  const fz = MAP_ZONES[MAP_NAME] && MAP_ZONES[MAP_NAME].finish;
  if (fz && finishTime == null && runStarted && inAABB(state.origin, fz)) {
    finishTime = runTime;
    const key = `surf_finish_${MAP_NAME}`;
    const prev = Number(localStorage.getItem(key)) || null;
    if (prev == null || finishTime < prev) {
      try { localStorage.setItem(key, String(finishTime)); } catch { /* ignore */ }
      if (hud) hud.toast(`NEW RECORD  ${fmtClock(finishTime)}`, '#ffd166');
    } else if (hud) hud.toast(`FINISH  ${fmtClock(finishTime)}`, '#7fd1ae');
  }

  // Falling off is handled by the map's own trigger_teleport volumes (which we
  // now simulate). killZ is just a last-resort net for maps without them, so
  // normal jumps/landings never reset you.
  if (state.origin[2] < killZ || !Number.isFinite(state.origin[2])) respawn();
}

// ---- Camera ----------------------------------------------------------------
function updateCamera(renderOrigin, pitch) {
  const viewZ = state.ducking ? HULL.DUCK.viewZ : HULL.STAND.viewZ;
  const eye = [renderOrigin[0], renderOrigin[1], renderOrigin[2] + viewZ];
  const [ex, ey, ez] = gs2three(eye[0], eye[1], eye[2]);
  camera.position.set(ex, ey, ez);
  const { forward } = angleVectors(pitch, input.yaw);
  const [fx, fy, fz] = gs2three(forward[0], forward[1], forward[2]);
  camera.lookAt(ex + fx, ey + fy, ez + fz);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  // keep the chosen horizontal FOV regardless of aspect
  const hfov = (SETTINGS.fov * Math.PI) / 180;
  camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180) / Math.PI;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}

// ---- Main loop -------------------------------------------------------------
function frame(nowMs) {
  requestAnimationFrame(frame);
  const now = nowMs / 1000;
  let dt = now - lastT;
  lastT = now;
  if (dt > 0.25) dt = 0.25; // avoid spiral-of-death after a tab stall
  if (dt > 0) fpsEMA += ((1 / dt) - fpsEMA) * 0.1;
  if (input.tickLook) input.tickLook(dt); // touch look pad: continuous rate-based turn
  accumulator += dt;

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < 8) {
    stepPhysics(FIXED_DT);
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps === 8) accumulator = 0; // shed backlog

  const alpha = accumulator / FIXED_DT;
  const ro = [
    prevOrigin[0] + (state.origin[0] - prevOrigin[0]) * alpha,
    prevOrigin[1] + (state.origin[1] - prevOrigin[1]) * alpha,
    prevOrigin[2] + (state.origin[2] - prevOrigin[2]) * alpha,
  ];
  // camera punch from firing kicks the view up briefly (+pitch looks down)
  const pitchEff = input.pitch - (weapons ? weapons.camPunch : 0);
  updateCamera(ro, pitchEff);

  const sp = speed2d(state);
  // underwater screen tint
  { const uw = document.getElementById('underwater'); if (uw) uw.style.display = envWater ? 'block' : 'none'; }
  const viewZ = state.ducking ? HULL.DUCK.viewZ : HULL.STAND.viewZ;
  const eyeGS = [ro[0], ro[1], ro[2] + viewZ];
  const dirGS = angleVectors(pitchEff, input.yaw).forward;
  updatePickups(dt, eyeGS, dirGS);

  // firing
  if (weapons) {
    weapons.setWeapon(input.weapon);
    weapons.update(dt, {
      attack: !!input.attack && input.active,
      eyeGS,
      yaw: input.yaw,
      pitch: pitchEff,
    });
  }
  // health regen: disabled in active deathmatch, slow otherwise
  if (health < 100) {
    const inDeathmatch = net && net.connected && net.peers.size > 0;
    health = Math.min(100, health + dt * (inDeathmatch ? 0 : 7));
  }

  // track all-time top speed (per map)
  if (hud.peak > pbSpeed) { pbSpeed = hud.peak; try { localStorage.setItem(PB_SPEED_KEY, String(Math.round(pbSpeed))); } catch { /* ignore */ } }

  hud.update({
    speed: sp,
    dt,
    onground: state.onground,
    inWater: envWater,
    onLadder: envLadder,
    surfing: !state.onground && !envWater && !envLadder && state.velocity[2] < 0 && sp > 150,
    time: runStarted ? runTime : 0,
    best: pbTime,
    pbspeed: pbSpeed,
    origin: state.origin,
    autohop: input.autohop,
    noclip: input.noclip,
    cp: !!checkpoint,
    players: net ? net.count : 1,
    fps: fpsEMA,
    health: Math.round(health),
    armor: 100,
    runstate: runStarted ? 'running' : 'ready',
    ammo: weapons ? weapons.ammoState() : null,
  });

  // multiplayer: interpolate remote avatars + broadcast our state at ~20 Hz
  if (remotePlayers) remotePlayers.render();
  if (net && net.connected) {
    netAcc += dt;
    if (netAcc >= 0.05) {
      netAcc = 0;
      net.broadcastState({
        o: [state.origin[0], state.origin[1], state.origin[2]], y: input.yaw, p: pitchEff, w: input.weapon,
        nm: playerName, pk: Math.round(hud.peak), t: runStarted ? runTime : 0, hp: health, k: kills, d: deaths, fin: finishTime,
      });
    }
  }
  updateScoreboard(sp);

  renderer.info.reset();
  renderer.clear();
  renderer.render(scene, camera);

  // overlay pass: the first-person weapon viewmodel
  if (viewmodel && viewmodel.current) {
    if (input) { ensureViewmodel(input.weapon); viewmodel.select(input.weapon); }
    viewmodel.setAspect(camera.aspect);
    viewmodel.update(dt, sp);
    renderer.clearDepth();
    renderer.render(viewmodel.scene, viewmodel.camera);
  }
}

// ---- Scoreboard / kill feed ------------------------------------------------
const sbEl = () => document.getElementById('scoreboard');
function escHtml(s) { return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
function updateScoreboard() {
  const el = sbEl(); if (!el) return;
  const show = !!(input && input.scoreboard);
  el.classList.toggle('show', show);
  if (!show) return;
  const rows = [{ name: `${playerName} (you)`, peak: Math.round(hud.peak), time: runStarted ? runTime : 0, kills, deaths, me: true }];
  if (remotePlayers) for (const r of remotePlayers.list()) rows.push({ name: r.name, peak: Math.round(r.peak), time: r.time, kills: r.kills, deaths: r.deaths, me: false });
  rows.sort((a, b) => b.peak - a.peak);
  const body = document.getElementById('sb-body');
  if (body) body.innerHTML = rows.map((r, i) => `<tr class="${r.me ? 'me' : ''}"><td>${i + 1}</td><td>${escHtml(r.name)}</td><td>${r.peak}</td><td>${fmtClock(r.time)}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
}
function addKill(html) {
  const kf = document.getElementById('killfeed'); if (!kf) return;
  const d = document.createElement('div'); d.className = 'kf'; d.innerHTML = html;
  kf.appendChild(d);
  setTimeout(() => d.remove(), 4500);
  while (kf.children.length > 5) kf.removeChild(kf.firstChild);
}

// ---- Weapon pickups (from armoury_entity) ----------------------------------
async function buildPickups() {
  for (const p of pickups) if (p.mesh) scene.remove(p.mesh);
  pickups = [];
  if (!entities || !entities.pickups.length) return;
  const ids = [...new Set(entities.pickups.map((p) => p.weaponId))];
  await Promise.all(ids.map(async (id) => {
    if (pickupModelCache.has(id)) return;
    try { pickupModelCache.set(id, buildWorldModel(await loadMDL(`assets/models/cs/w/w_${id}.mdl`))); }
    catch { pickupModelCache.set(id, null); }
  }));
  const SCALE = 1.4;
  for (const p of entities.pickups) {
    const tmpl = pickupModelCache.get(p.weaponId);
    const mesh = tmpl ? tmpl.clone(true)
      : new THREE.Mesh(new THREE.BoxGeometry(20, 8, 28), new THREE.MeshLambertMaterial({ color: 0xffcf6b }));
    mesh.scale.setScalar(SCALE);
    // Drop the pickup to the floor under its armoury spawn so it rests on the
    // ground (the model is centred on its bbox, so offset by its scaled bottom).
    const ox = p.origin[0], oy = p.origin[1], oz = p.origin[2];
    let floorZ = oz;
    if (world && world.traceBullet) {
      const tr = world.traceBullet([ox, oy, oz + 16], [ox, oy, oz - 1024]);
      if (tr.fraction < 1 && !tr.startsolid) floorZ = tr.endpos[2];
    }
    const minY = (mesh.userData && typeof mesh.userData.modelMinY === 'number') ? mesh.userData.modelMinY : -6;
    const centerZ = floorZ + 1 - minY * SCALE; // bottom rests ~1u above the floor
    const o = [ox, oy, centerZ];
    const [x, y, z] = gs2three(o[0], o[1], o[2]);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    pickups.push({ weaponId: p.weaponId, origin: o, mesh, baseY: y, taken: false, respawnAt: 0 });
  }
  console.log(`[surf] weapon pickups: ${pickups.length}`);
}

let targetedPickup = null; // the pickup the player is currently aiming at (in range)

// Spin/bob pickups and pick the one the player is looking at (for the [E] prompt).
function updatePickups(dt, eyeGS, dirGS) {
  targetedPickup = null;
  if (!pickups.length) return;
  const now = performance.now() / 1000;
  let bestDot = 0.9; // require aiming within ~25 deg
  for (const p of pickups) {
    if (p.taken) { if (now >= p.respawnAt) { p.taken = false; p.mesh.visible = true; } continue; }
    p.mesh.rotation.y += dt * 1.6;
    // gentle upward-only hover so the weapon never sinks into the floor
    p.mesh.position.y = p.baseY + (Math.sin(now * 2 + p.origin[0] * 0.01) * 0.5 + 0.5) * 1.5;
    // is the player looking at this pickup, and close enough?
    const dx = p.origin[0] - eyeGS[0], dy = p.origin[1] - eyeGS[1], dz = p.origin[2] - eyeGS[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > 200) continue;
    const dot = (dx * dirGS[0] + dy * dirGS[1] + dz * dirGS[2]) / (d || 1);
    if (dot > bestDot) { bestDot = dot; targetedPickup = p; }
  }
  // update the prompt
  const el = document.getElementById('usePrompt');
  if (el) {
    if (targetedPickup) { el.textContent = `[ E ]  pick up  ${targetedPickup.weaponId.toUpperCase()}`; el.style.display = 'block'; }
    else el.style.display = 'none';
  }
}

function pickUpTargeted() {
  const p = targetedPickup;
  if (!p || p.taken || !weapons) return;
  weapons.give(p.weaponId);
  ensureViewmodel(p.weaponId);
  if (input) input.weapon = p.weaponId;
  if (hud) hud.toast(`picked up ${p.weaponId.toUpperCase()}`, '#ffd166');
  p.taken = true; p.mesh.visible = false; p.respawnAt = performance.now() / 1000 + 12;
}

// ---- Boot ------------------------------------------------------------------
async function boot() {
  try {
    loadSkybox();
    let stats, worldMins, worldMaxs;

    if (MAP_NAME === 'surf_arena') {
      // ---- Procedural map: no BSP, analytic brush collision ----
      setStatus('Generating surf_arena …');
      const arena = generateSurfArena();
      scene.add(buildProcLevel(arena.brushes));
      world = new BrushWorld(arena.brushes);
      spawn = arena.spawn;
      entities = null;
      killZ = arena.killZ;
      bounds = arena.bounds;
      worldMins = arena.bounds.min; worldMaxs = arena.bounds.max;
      stats = { drawn: arena.brushes.length, materials: arena.brushes.length };
      MAP_ZONES.surf_arena = { finish: arena.finish };
      console.log(`[surf] surf_arena: ${arena.brushes.length} brushes`);
    } else {
      setStatus(`Loading ${MAP_NAME}.bsp …`);
      const bsp = await loadBSP(MAPS[MAP_NAME]);

      setStatus('Loading textures …');
      const KENNEY = [
        'dark_01', 'dark_08', 'green_01', 'green_06', 'light_01', 'light_05',
        'orange_01', 'orange_09', 'purple_01', 'purple_11', 'red_06', 'red_13',
      ];
      const loaded = await Promise.all(KENNEY.map((n) => tryLoadTexture(`assets/textures/kenney/${n}.png`)));
      let fallbackTextures = loaded.filter(Boolean);
      if (fallbackTextures.length === 0) {
        const grid = await tryLoadTexture('assets/textures/prototype.png');
        fallbackTextures = [grid || makeGridTexture()];
      }

      setStatus('Loading WAD textures …');
      const wadTextures = await loadWadTextures(bsp);

      setStatus('Building level geometry …');
      const level = buildLevel(bsp, { fallbackTextures, wadTextures });
      scene.add(level.group);
      bounds = level.bounds;
      killZ = bsp.models[0].mins[2] - 512;
      world = new CollisionWorld(bsp);
      spawn = parseSpawn(bsp);
      entities = new Entities(bsp, world);
      stats = level.stats;
      worldMins = bsp.models[0].mins; worldMaxs = bsp.models[0].maxs;
      console.log(`[surf] faces=${level.stats.drawn} lit=${level.stats.lit} solidModels=${world.solidModels.length}`);
    }

    input = new Input();
    input.attach(canvas);
    input.sensitivity = SETTINGS.sens / 1000;
    input.onRespawn(respawn);
    input.onReload(() => { if (weapons) weapons.reload(); });
    input.onCheckpoint(handleCheckpoint);
    input.onUse(pickUpTargeted);
    input.onBlocked((what) => { if (hud) hud.toast(`${what} is off in the public match — start your own room to enable it`, '#ffb86b'); });
    const overlay = document.getElementById('overlay');
    input.onActiveChange((active) => {
      if (overlay) overlay.style.display = active ? 'none' : 'flex';
      canvas.style.cursor = active ? 'none' : 'crosshair';
      if (active && weapons) weapons.resume(); // unlock audio on first play gesture
    });
    // Only the Play button (or Enter/any key, or clicking the canvas) starts the
    // game — so the menu's settings/room controls stay usable.
    const playbtn = document.getElementById('playbtn');
    if (playbtn) playbtn.addEventListener('click', () => input.start());
    canvas.addEventListener('click', () => { if (input.active && !input.locked) input.start(); });

    hud = new HUD(document);
    hud.setMap(MAP_NAME);
    { const sm = document.getElementById('sb-map'); if (sm) sm.textContent = MAP_NAME; }
    const nameInput = document.getElementById('mp-name');
    if (nameInput) {
      nameInput.value = playerName;
      nameInput.addEventListener('input', () => { playerName = nameInput.value.trim() || playerName; try { localStorage.setItem('surf_name', playerName); } catch { /* ignore */ } });
    }
    respawn();

    // First-person weapon viewmodel (CC0 Quaternius guns). Non-blocking:
    // if it fails to load, the game still runs without a weapon.
    viewmodel = new Viewmodel();
    viewmodel.loadMDLWeapons({
      // pistols are one-handed: skip the floating "rhand" bodypart.
      usp: { url: 'assets/models/cs/v_usp.mdl', skip: ['rhand'] },
      deagle: { url: 'assets/models/cs/v_deagle.mdl', skip: ['rhand'] },
      m4a1: 'assets/models/cs/v_m4a1.mdl',
      ak47: 'assets/models/cs/v_ak47.mdl',
      awp: 'assets/models/cs/v_awp.mdl',
      m3: 'assets/models/cs/v_m3.mdl',
    }).then(async (names) => {
      if (!names.length) {
        await viewmodel.load({ usp: 'assets/models/pistol.glb', m4a1: 'assets/models/rifle.glb', m3: 'assets/models/shotgun.glb' });
        console.log('[surf] viewmodels: GLB fallback');
      } else {
        console.log(`[surf] viewmodels (CS .mdl): ${names.join(', ')}`);
      }
    });

    // Firing: real CS 1.6 weapon sounds + hitscan tracers + recoil.
    weapons = new Weapons(scene, viewmodel);
    weapons.setWorld(world);
    weapons.masterVol = SETTINGS.vol / 100;
    weapons.playerHitTest = playerHitTest;
    weapons.onPlayerHit = (id, dmg) => {
      if (net && net.connected) net.sendHitTo(id, { dmg, by: playerName });
      if (hud) hud.hitMarker();
    };
    weapons.loadSounds({
      usp: 'assets/sounds/usp.wav', m4a1: 'assets/sounds/m4a1.wav', m3: 'assets/sounds/m3.wav',
      deagle: 'assets/sounds/deagle.wav', ak47: 'assets/sounds/ak47.wav', awp: 'assets/sounds/awp.wav',
      glock: 'assets/sounds/glock.wav', mp5: 'assets/sounds/mp5.wav', tmp: 'assets/sounds/tmp.wav',
      mac10: 'assets/sounds/mac10.wav', p90: 'assets/sounds/p90.wav', sg552: 'assets/sounds/sg552.wav',
      aug: 'assets/sounds/aug.wav', scout: 'assets/sounds/scout.wav', g3sg1: 'assets/sounds/g3sg1.wav',
      xm1014: 'assets/sounds/xm1014.wav', m249: 'assets/sounds/m249.wav',
      pistol_out: 'assets/sounds/pistol_out.wav', pistol_in: 'assets/sounds/pistol_in.wav', pistol_slide: 'assets/sounds/pistol_slide.wav',
      rifle_out: 'assets/sounds/rifle_out.wav', rifle_in: 'assets/sounds/rifle_in.wav', rifle_bolt: 'assets/sounds/rifle_bolt.wav',
      deagle_out: 'assets/sounds/deagle_out.wav', deagle_in: 'assets/sounds/deagle_in.wav',
      ak47_out: 'assets/sounds/ak47_out.wav', ak47_in: 'assets/sounds/ak47_in.wav', ak47_bolt: 'assets/sounds/ak47_bolt.wav',
      awp_out: 'assets/sounds/awp_out.wav', awp_in: 'assets/sounds/awp_in.wav', awp_bolt: 'assets/sounds/awp_bolt.wav',
      shotgun_pump: 'assets/sounds/shotgun_pump.wav', shotgun_insert: 'assets/sounds/shotgun_insert.wav',
      empty: 'assets/sounds/empty.wav', draw: 'assets/sounds/draw.wav',
    });

    // ---- P2P multiplayer (serverless WebRTC via Trystero) ----
    remotePlayers = new RemotePlayers(scene);
    // posed CS player model (sequence 1 = idle) for remote avatars
    loadMDL('assets/models/cs/player/leet.mdl', { sequence: 1 })
      .then((data) => remotePlayers.setTemplate(buildWorldModel(data, { center: false })))
      .catch((e) => console.warn('[surf] player model load failed:', e.message));
    net = new Net();
    net.on('state', (id, data) => remotePlayers.update(id, data));
    net.on('leave', (id) => remotePlayers.remove(id));
    net.on('shot', (id, data) => { if (weapons) weapons.remoteShot(data); });
    net.on('hit', (id, data) => {
      let attackerPos = null;
      if (remotePlayers) remotePlayers.forEach((pid, o) => { if (pid === id) attackerPos = o; });
      applyDamage(data.dmg || 0, data.by || 'someone', attackerPos);
    });
    net.on('frag', (id, data) => {
      addKill(`<b>${escHtml(data.by)}</b> ▸ ${escHtml(data.victim)}`);
      if (data.by === playerName) kills++;
    });
    net.on('count', (n) => { const el = document.getElementById('peercount'); if (el) el.textContent = n; });
    net.on('chat', (id, data) => { if (data && data.msg) addChat(data.nm || 'player', data.msg); });
    weapons.onShot = (data) => { if (net.connected) net.broadcastShot(data); };

    // ---- Text chat (CS 1.6 style): Y/T to open, Enter sends, Esc cancels ----
    const chatBar = document.getElementById('chatbar');
    const chatInput = document.getElementById('chatinput');
    const chatLog = document.getElementById('chatlog');
    function addChat(name, msg) {
      if (!chatLog) return;
      const line = document.createElement('div');
      line.className = 'cm';
      line.innerHTML = `<b>${escHtml(name)}</b> : ${escHtml(msg)}`;
      chatLog.appendChild(line);
      requestAnimationFrame(() => line.classList.add('show'));
      while (chatLog.children.length > 6) chatLog.removeChild(chatLog.firstChild);
      // fade + remove after a few seconds (messages stay while the box is open)
      const ttl = setTimeout(() => { line.classList.remove('show'); setTimeout(() => line.remove(), 400); }, 9000);
      line._ttl = ttl;
    }
    function openChat() {
      if (!chatBar || !chatInput || (chatBar.style.display === 'flex')) return;
      chatBar.style.display = 'flex';
      if (input) input.setChatting(true);
      chatInput.value = '';
      setTimeout(() => chatInput.focus(), 0);
    }
    function closeChat() {
      if (!chatBar) return;
      chatBar.style.display = 'none';
      chatInput.blur();
      if (input) input.setChatting(false);
    }
    if (input) input.onChat(openChat);
    if (chatInput) {
      chatInput.addEventListener('keydown', (e) => {
        e.stopPropagation(); // don't leak into game key handling
        if (e.key === 'Enter') {
          const msg = chatInput.value.trim().slice(0, 120);
          if (msg) { addChat(`${playerName} (you)`, msg); if (net && net.connected) net.sendChat({ nm: playerName, msg }); }
          closeChat();
        } else if (e.key === 'Escape') {
          closeChat();
        }
      });
    }

    const joinBtn = document.getElementById('mp-join');
    const roomInput = document.getElementById('mp-room');
    const mpStatus = document.getElementById('mp-status');
    // Allow ?room=name to preselect a multiplayer room (handy for sharing a
    // private match link, and for multi-session testing).
    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam && roomInput) roomInput.value = roomParam.slice(0, 24);
    // Fair-play: noclip + checkpoint teleport are disabled in the shared public
    // room; renaming the room to your own match enables everything.
    function applyRoomRules(room) {
      const custom = room && room !== 'public';
      if (input) input.setCheats(custom);
      const note = document.getElementById('mp-note');
      if (note) note.textContent = custom
        ? 'custom match: noclip + checkpoints enabled.'
        : 'public match: no noclip / teleport (fair play). rename the room to start your own match where everything is enabled.';
    }
    async function connectMP(room) {
      if (mpStatus) mpStatus.textContent = 'connecting…';
      applyRoomRules(room);
      try {
        await net.join(room);
        if (joinBtn) joinBtn.textContent = 'Leave';
        if (mpStatus) mpStatus.textContent = `room: ${room}`;
      } catch (err) {
        if (joinBtn) joinBtn.textContent = 'Join';
        if (mpStatus) mpStatus.textContent = `offline (${err.message})`;
      }
    }
    if (joinBtn) {
      joinBtn.addEventListener('click', () => {
        if (net.connected) {
          net.leave(); remotePlayers.clear();
          joinBtn.textContent = 'Join'; if (mpStatus) mpStatus.textContent = 'offline';
          applyRoomRules((roomInput && roomInput.value.trim()) || 'public');
        } else {
          connectMP((roomInput && roomInput.value.trim()) || 'public');
        }
      });
    }
    // Multiplayer ON by default — auto-join the room as soon as we boot.
    connectMP((roomInput && roomInput.value.trim()) || 'public');

    // ---- Settings sliders ----
    function wireSlider(id, key, fmt = (v) => v) {
      const el = document.getElementById(id), valEl = document.getElementById(`${id}-v`);
      if (!el) return;
      el.value = SETTINGS[key];
      if (valEl) valEl.textContent = fmt(SETTINGS[key]);
      el.addEventListener('input', () => {
        SETTINGS[key] = Number(el.value);
        if (valEl) valEl.textContent = fmt(SETTINGS[key]);
        saveSettings();
        applySettings();
      });
    }
    wireSlider('set-sens', 'sens', (v) => Number(v).toFixed(1));
    wireSlider('set-fov', 'fov');
    wireSlider('set-vol', 'vol');
    wireSlider('set-q', 'quality');

    window.addEventListener('resize', onResize);
    applySettings();

    setStatus('');
    document.getElementById('overlay').style.display = 'flex';

    // Debug / test hook: lets a headless harness introspect and drive the game
    // without pointer lock. Harmless in normal play.
    window.__surf = {
      ready: true,
      scene, // test hook: inspect/tweak materials for visual diagnosis
      stats,
      bounds,
      spawn,
      worldMins,
      worldMaxs,
      getState: () => ({
        origin: [...state.origin], velocity: [...state.velocity],
        onground: state.onground, ducking: state.ducking, speed: speed2d(state),
      }),
      setState: (o, v) => { if (o) state.origin = [...o]; if (v) state.velocity = [...v]; prevOrigin = copy(state.origin); },
      setAir: () => { state.onground = false; state.groundNormal = null; },
      setLook: (yaw, pitch) => { input.yaw = yaw; input.pitch = pitch; },
      getLook: () => ({ yaw: input.yaw, pitch: input.pitch }),
      getCommand: () => input.command(),
      setVMEuler: (x, y, z) => viewmodel && viewmodel.setVMEuler(x, y, z),
      vmReady: () => !!(viewmodel && Object.keys(viewmodel.weapons).length),
      selectWeapon: (n) => { if (input) input.weapon = n; if (viewmodel) viewmodel.select(n); },
      addBot: (o, y) => remotePlayers && remotePlayers.update('TESTBOT', { o, y: y || 0, nm: 'BOT' }),
      pickups: () => pickups.map((p) => ({ id: p.weaponId, o: [...p.origin] })),
      netInfo: () => ({
        connected: !!(net && net.connected),
        count: net ? net.count : 1,
        peers: net ? [...net.peers] : [],
        remotes: remotePlayers ? [...remotePlayers.players.keys()].map((id) => ({ id, o: remotePlayers.players.get(id).cur && remotePlayers.players.get(id).cur.o })) : [],
      }),
      tick: (cmd, dt = FIXED_DT) => { runTick(state, cmd, world, { autohop: false }, dt); return speed2d(state); },
      // Tick against a caller-supplied (e.g. open-air) world — isolates the
      // movement maths from level collision for testing.
      tickWith: (cmd, mockWorld, dt = FIXED_DT) => { runTick(state, cmd, mockWorld, { autohop: false }, dt); return speed2d(state); },
      trace: (a, b, hull = 1) => world.traceHull(a, b, hull),
      rendererInfo: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    };

    buildPickups(); // spawn weapon pickups from the map (non-blocking)
    requestAnimationFrame(frame);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
}

boot();
