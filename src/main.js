// Entry point: load surf_ski_2.bsp, build the scene + collision world, and run
// the fixed-timestep GoldSrc movement with render interpolation.

import * as THREE from '../vendor/three.module.js';
import { loadBSP } from './bsp.js';
import { CollisionWorld } from './hull.js';
import { buildLevel, buildSky, gs2three } from './render.js';
import { createPlayerState, runTick, speed2d } from './physics.js';
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

scene.add(buildSky());

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
  t.colorSpace = THREE.SRGBColorSpace;
  // BSP UVs are in pixels/texWidth; a 64px-equivalent repeat reads well.
  t.repeat.set(1, 1);
  return t;
}

// Prefer a shipped prototype texture (e.g. a CC0 Kenney grid) if one exists.
// fetch-based so a missing optional asset doesn't spam the console with 404s.
async function tryLoadTexture(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const t = new THREE.Texture(bmp);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  } catch {
    return null;
  }
}

// ---- World / player state --------------------------------------------------
let world, state, input, hud, viewmodel;
let bounds, killZ, spawn;
let prevOrigin;
let accumulator = 0;
let lastT = performance.now() / 1000;
let runTime = 0;
let runStarted = false;

function parseSpawn(bsp) {
  const list = bsp.entitiesByClass('info_player_start')
    .concat(bsp.entitiesByClass('info_player_deathmatch'));
  for (const e of list) {
    if (!e.origin) continue;
    const o = e.origin.split(/\s+/).map(Number);
    if (o.length === 3 && o.every(Number.isFinite)) {
      const yaw = e.angles ? (Number(e.angles.split(/\s+/)[1]) || 0) * Math.PI / 180 : 0;
      return { origin: o, yaw };
    }
  }
  // fallback: centre of world, up high
  return { origin: [0, 0, 0], yaw: 0 };
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
  state = createPlayerState(settleSpawn(spawn.origin));
  state.velocity = [0, 0, 0];
  if (input) { input.yaw = spawn.yaw; input.pitch = 0; }
  prevOrigin = copy(state.origin);
  runTime = 0; runStarted = false;
  if (hud) hud.peak = 0;
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
  runTick(state, cmd, world, { autohop: input.autohop }, dt);

  // start the run timer on first real movement input
  if (!runStarted && (cmd.forwardmove || cmd.sidemove || cmd.jump)) runStarted = true;
  if (runStarted) runTime += dt;

  // fell off the map -> respawn at the spawn point
  if (state.origin[2] < killZ || !Number.isFinite(state.origin[2])) respawn();
}

// ---- Camera ----------------------------------------------------------------
function updateCamera(renderOrigin) {
  const viewZ = state.ducking ? HULL.DUCK.viewZ : HULL.STAND.viewZ;
  const eye = [renderOrigin[0], renderOrigin[1], renderOrigin[2] + viewZ];
  const [ex, ey, ez] = gs2three(eye[0], eye[1], eye[2]);
  camera.position.set(ex, ey, ez);
  const { forward } = angleVectors(input.pitch, input.yaw);
  const [fx, fy, fz] = gs2three(forward[0], forward[1], forward[2]);
  camera.lookAt(ex + fx, ey + fy, ez + fz);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  // keep a ~90-degree horizontal FOV regardless of aspect
  const hfov = (90 * Math.PI) / 180;
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
  updateCamera(ro);

  const sp = speed2d(state);
  hud.update({
    speed: sp,
    onground: state.onground,
    surfing: !state.onground && state.velocity[2] < 0 && sp > 150,
    time: runTime,
    origin: state.origin,
    autohop: input.autohop,
    noclip: input.noclip,
  });

  renderer.info.reset();
  renderer.clear();
  renderer.render(scene, camera);

  // overlay pass: the first-person weapon viewmodel
  if (viewmodel && viewmodel.current) {
    if (input) viewmodel.select(input.weapon);
    viewmodel.setAspect(camera.aspect);
    viewmodel.update(dt, sp);
    renderer.clearDepth();
    renderer.render(viewmodel.scene, viewmodel.camera);
  }
}

// ---- Boot ------------------------------------------------------------------
async function boot() {
  try {
    setStatus('Loading surf_ski_2.bsp …');
    const bsp = await loadBSP('assets/surf_ski_2.bsp');

    setStatus('Loading textures …');
    // Shipped CC0 Kenney "Prototype Textures" set, used for the ~55 surfaces
    // whose textures live in an external WAD we don't bundle.
    const KENNEY = [
      'dark_01', 'dark_08', 'green_01', 'green_06', 'light_01', 'light_05',
      'orange_01', 'orange_09', 'purple_01', 'purple_11', 'red_06', 'red_13',
    ];
    const loaded = await Promise.all(KENNEY.map((n) => tryLoadTexture(`assets/textures/kenney/${n}.png`)));
    let fallbackTextures = loaded.filter(Boolean);
    if (fallbackTextures.length === 0) {
      // last-resort: a single shipped prototype grid, then a procedural one
      const grid = await tryLoadTexture('assets/textures/prototype.png');
      fallbackTextures = [grid || makeGridTexture()];
    }
    console.log(`[surf] fallback textures loaded: ${fallbackTextures.length}/${KENNEY.length}`);

    setStatus('Building level geometry …');
    const level = buildLevel(bsp, { fallbackTextures });
    scene.add(level.group);
    bounds = level.bounds;
    killZ = bsp.models[0].mins[2] - 512;
    console.log(`[surf] faces drawn=${level.stats.drawn} skipped=${level.stats.skipped} materials=${level.stats.materials}`);

    world = new CollisionWorld(bsp);
    spawn = parseSpawn(bsp);

    input = new Input();
    input.attach(canvas);
    input.onRespawn(respawn);
    input.onLockChange((locked) => {
      const overlay = document.getElementById('overlay');
      if (overlay) overlay.style.display = locked ? 'none' : 'flex';
    });

    hud = new HUD(document);
    respawn();

    // First-person weapon viewmodel (CC0 Quaternius guns). Non-blocking:
    // if it fails to load, the game still runs without a weapon.
    viewmodel = new Viewmodel();
    viewmodel.load({
      pistol: 'assets/models/pistol.glb',
      rifle: 'assets/models/rifle.glb',
      shotgun: 'assets/models/shotgun.glb',
    }).then((names) => console.log(`[surf] viewmodels loaded: ${names.join(', ') || 'none'}`));

    window.addEventListener('resize', onResize);
    onResize();

    setStatus('');
    document.getElementById('overlay').style.display = 'flex';

    // Debug / test hook: lets a headless harness introspect and drive the game
    // without pointer lock. Harmless in normal play.
    window.__surf = {
      ready: true,
      stats: level.stats,
      bounds,
      spawn,
      worldMins: bsp.models[0].mins,
      worldMaxs: bsp.models[0].maxs,
      getState: () => ({
        origin: [...state.origin], velocity: [...state.velocity],
        onground: state.onground, ducking: state.ducking, speed: speed2d(state),
      }),
      setState: (o, v) => { if (o) state.origin = [...o]; if (v) state.velocity = [...v]; prevOrigin = copy(state.origin); },
      setAir: () => { state.onground = false; state.groundNormal = null; },
      setLook: (yaw, pitch) => { input.yaw = yaw; input.pitch = pitch; },
      tick: (cmd, dt = FIXED_DT) => { runTick(state, cmd, world, { autohop: false }, dt); return speed2d(state); },
      // Tick against a caller-supplied (e.g. open-air) world — isolates the
      // movement maths from level collision for testing.
      tickWith: (cmd, mockWorld, dt = FIXED_DT) => { runTick(state, cmd, mockWorld, { autohop: false }, dt); return speed2d(state); },
      trace: (a, b, hull = 1) => world.traceHull(a, b, hull),
      rendererInfo: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    };

    requestAnimationFrame(frame);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
}

boot();
