// Entry point: load surf_ski_2.bsp, build the scene + collision world, and run
// the fixed-timestep GoldSrc movement with render interpolation.

import * as THREE from '../vendor/three.module.js';
import { loadBSP } from './bsp.js';
import { CollisionWorld } from './hull.js';
import { buildLevel, buildSky, gs2three } from './render.js';
import { createPlayerState, runTick, speed2d, waterMove, ladderMove } from './physics.js';
import { Entities } from './entities.js';
import { Weapons } from './weapons.js';
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
let checkpoint = null; // {origin, yaw} for practice save/load

// ---- Map selection (?map=surf_green) ---------------------------------------
const MAPS = {
  surf_ski_2: 'assets/maps/surf_ski_2.bsp',
  surf_green: 'assets/maps/surf_green.bsp',
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

function applySettings() {
  if (input) input.sensitivity = SETTINGS.sens / 1000;
  if (weapons) weapons.masterVol = SETTINGS.vol / 100;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * (SETTINGS.quality / 100));
  onResize();
}

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
  // bank the best run time when a real run ends
  if (runStarted && runTime > 1 && (pbTime == null || runTime > pbTime)) {
    pbTime = runTime;
    try { localStorage.setItem(PB_TIME_KEY, String(pbTime)); } catch { /* ignore */ }
    if (hud) hud.toast(`LONGEST RUN  ${fmtClock(pbTime)}`, '#7fd1ae');
  }
  state = createPlayerState(settleSpawn(spawn.origin));
  state.velocity = [0, 0, 0];
  if (input) { input.yaw = spawn.yaw; input.pitch = 0; }
  prevOrigin = copy(state.origin);
  runTime = 0; runStarted = false;
  if (hud) hud.peak = 0;
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

  // Choose the movement mode based on the volume the player is in.
  const inWater = entities && entities.inWater(state.origin);
  const onLadder = !inWater && entities && entities.onLadder(state.origin);
  envWater = inWater; envLadder = onLadder;
  if (inWater) {
    waterMove(state, cmd, world, dt);
  } else if (onLadder) {
    ladderMove(state, cmd, world, dt);
  } else {
    runTick(state, cmd, world, { autohop: input.autohop }, dt);
  }

  // boosters (trigger_push) + teleports (trigger_teleport)
  if (entities) {
    const r = entities.apply(state);
    if (r.teleported) {
      if (r.teleported.yaw != null && input) input.yaw = r.teleported.yaw;
      prevOrigin = copy(state.origin); // avoid a long interpolation streak
    }
  }

  // start the run timer on first real movement input
  if (!runStarted && (cmd.forwardmove || cmd.sidemove || cmd.jump)) runStarted = true;
  if (runStarted) runTime += dt;

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

  // firing
  if (weapons) {
    weapons.setWeapon(input.weapon);
    const viewZ = state.ducking ? HULL.DUCK.viewZ : HULL.STAND.viewZ;
    weapons.update(dt, {
      attack: !!input.attack && input.active,
      eyeGS: [ro[0], ro[1], ro[2] + viewZ],
      yaw: input.yaw,
      pitch: pitchEff,
    });
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
    health: 100,
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
      net.broadcastState({ o: [state.origin[0], state.origin[1], state.origin[2]], y: input.yaw, p: pitchEff, w: input.weapon });
    }
  }

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
    loadSkybox();
    setStatus(`Loading ${MAP_NAME}.bsp …`);
    const bsp = await loadBSP(MAPS[MAP_NAME]);

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
    entities = new Entities(bsp, world);
    console.log(`[surf] solid models=${world.solidModels.length} entities: pushes=${entities.pushes.length} teleports=${entities.teleports.length} ladders=${entities.ladders.length} waters=${entities.waters.length}`);

    input = new Input();
    input.attach(canvas);
    input.sensitivity = SETTINGS.sens / 1000;
    input.onRespawn(respawn);
    input.onReload(() => { if (weapons) weapons.reload(); });
    input.onCheckpoint(handleCheckpoint);
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
    respawn();

    // First-person weapon viewmodel (CC0 Quaternius guns). Non-blocking:
    // if it fails to load, the game still runs without a weapon.
    viewmodel = new Viewmodel();
    viewmodel.loadMDLWeapons({
      pistol: 'assets/models/cs/v_usp.mdl',
      rifle: 'assets/models/cs/v_m4a1.mdl',
      shotgun: 'assets/models/cs/v_m3.mdl',
    }).then(async (names) => {
      if (!names.length) {
        await viewmodel.load({
          pistol: 'assets/models/pistol.glb', rifle: 'assets/models/rifle.glb', shotgun: 'assets/models/shotgun.glb',
        });
        console.log('[surf] viewmodels: GLB fallback');
      } else {
        console.log(`[surf] viewmodels (CS .mdl): ${names.join(', ')}`);
      }
    });

    // Firing: real CS 1.6 weapon sounds + hitscan tracers + recoil.
    weapons = new Weapons(scene, viewmodel);
    weapons.setWorld(world);
    weapons.masterVol = SETTINGS.vol / 100;
    weapons.loadSounds({
      pistol: 'assets/sounds/pistol.wav', rifle: 'assets/sounds/rifle.wav', shotgun: 'assets/sounds/shotgun.wav',
      pistol_out: 'assets/sounds/pistol_out.wav', pistol_in: 'assets/sounds/pistol_in.wav', pistol_slide: 'assets/sounds/pistol_slide.wav',
      rifle_out: 'assets/sounds/rifle_out.wav', rifle_in: 'assets/sounds/rifle_in.wav', rifle_bolt: 'assets/sounds/rifle_bolt.wav',
      shotgun_pump: 'assets/sounds/shotgun_pump.wav', shotgun_insert: 'assets/sounds/shotgun_insert.wav',
      empty: 'assets/sounds/empty.wav', draw: 'assets/sounds/draw.wav',
    });

    // ---- P2P multiplayer (serverless WebRTC via Trystero) ----
    remotePlayers = new RemotePlayers(scene);
    net = new Net();
    net.on('state', (id, data) => remotePlayers.update(id, data));
    net.on('leave', (id) => remotePlayers.remove(id));
    net.on('shot', (id, data) => { if (weapons) weapons.remoteShot(data); });
    net.on('count', (n) => { const el = document.getElementById('peercount'); if (el) el.textContent = n; });
    weapons.onShot = (data) => { if (net.connected) net.broadcastShot(data); };

    const joinBtn = document.getElementById('mp-join');
    const roomInput = document.getElementById('mp-room');
    const mpStatus = document.getElementById('mp-status');
    async function connectMP(room) {
      if (mpStatus) mpStatus.textContent = 'connecting…';
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
      setVMEuler: (x, y, z) => viewmodel && viewmodel.setVMEuler(x, y, z),
      vmReady: () => !!(viewmodel && Object.keys(viewmodel.weapons).length),
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
