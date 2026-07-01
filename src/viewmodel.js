// Weapon viewmodel — a classic CS touch. Loads CC0 Quaternius gun models
// (poly.pizza) and renders them in a dedicated overlay pass so the close-up
// weapon isn't clipped by the world's near plane or its huge unit scale.

import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/jsm/loaders/GLTFLoader.js';
import { loadMDL } from './mdl.js';
import { buildAnimatedModel } from './render.js';

// v_ model axes -> view-model camera space: (x, y, z) -> (-x, z, y).
function remapVM(src) {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) { out[i] = -src[i]; out[i + 1] = src[i + 2]; out[i + 2] = src[i + 1]; }
  return out;
}

// Resolve a v_ model's standard sequences by name (indices vary per weapon).
function resolveSeqs(seqs) {
  const find = (...names) => { for (const n of names) { const i = seqs.findIndex((s) => s.name === n); if (i >= 0) return i; } return -1; };
  const shoot = seqs.map((s, i) => (/^shoot[0-9]?$/.test(s.name) ? i : -1)).filter((i) => i >= 0);
  return {
    idle: find('idle', 'idle1', 'idle2'),
    shoot: shoot.length ? shoot : [find('shoot1', 'shoot')].filter((i) => i >= 0),
    reload: find('reload', 'start_reload'),
    draw: find('draw', 'deploy'),
    seqs,
  };
}

// Per-weapon nudge [x, y, z] in rig space, on top of the shared base placement.
// The shared base sits low so long guns rise into frame from the bottom-right
// (see the base-placement note below). Pistols are short, so at that same low
// base their whole body drops off the bottom edge — we raise them back up so
// the grip/hand still reads at the bottom-right corner. The M3's pump/stock
// hangs low after centering and needs a similar raise.
const VM_OFFSET = {
  usp: [0, 0.03, 0.02], deagle: [0, 0.04, 0.01], glock: [0, 0.03, 0.02],
  m3: [0, 0.05, 0],
};

// Per-weapon rotation override [pitch, yaw, roll], replacing DEFAULT_EULER.
// Rifles/snipers/shotguns all read well at one shared angle, but pistols are
// short enough relative to their width that the SAME rotation over-rotates
// them (verified visually per weapon, not just by category — even USP and
// Deagle, both one-handed pistols, needed different values here).
const DEFAULT_EULER = [-0.3, 0.1, 0];
const VM_EULER = {
  usp: [0.15, 0.1, 0], deagle: [0.1, 0.08, 0], glock: [0.15, 0.1, 0],
};

// Soft additive muzzle-flash sprite (no asset to ship).
function makeFlashTexture() {
  const s = 64; const c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,250,210,1)');
  grad.addColorStop(0.35, 'rgba(255,200,90,0.75)');
  grad.addColorStop(1, 'rgba(255,150,40,0)');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

export class Viewmodel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(0.6, 1.0, 0.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc0ff, 0.6);
    fill.position.set(-0.8, 0.2, 0.4);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(0.2, 0.4, -1.0);
    this.scene.add(rim);

    this.rig = new THREE.Group();
    // Bottom-right placement in view space (camera looks down -Z). Depth (-0.85)
    // keeps the near face at -0.6, comfortably inside the 50deg FOV's near cone
    // for every MDL weapon (pistol grips through the AWP's long barrel) — at
    // -0.46 the near face sat at -0.21 and clipped the gun out of frame.
    // baseY is low (-0.14, not near-centered) on purpose: a first-person
    // weapon is held by hands *below* the camera, so it must rise into frame
    // from the bottom-right corner. With baseY near 0 the gun floated at eye
    // level and read as sliding in from the right edge rather than being held.
    // baseX (0.42) pulls it off the right edge so the forearm enters from the
    // corner, not the side. Per-weapon VM_OFFSET raises the short pistols back
    // up from this low base. Verified visually per weapon (Vector3.project +
    // rendered pixels) for AK/M4/AWP/M3 and the USP/Deagle/Glock pistols.
    this.baseX = 0.42; this.baseY = -0.14;
    this.rig.position.set(this.baseX, this.baseY, -0.85);
    this.scene.add(this.rig);

    this.weapons = {};
    this.current = null;
    this.bobT = 0;
    this.recoil = 0; // 0..1, decays; kicks the gun back + up when firing
    this.reloadT = 0; this.reloadDur = 0; // reload dip animation
    // Manual test-only override (see setVMEuler) — null means "use each
    // weapon's own VM_EULER entry (or DEFAULT_EULER)", which is what
    // _makeMDLWeapon actually applies per weapon at load time.
    this._vmEuler = null;
    // skeletal weapon animation state (current weapon): idle loop, or a one-shot
    // shoot / reload / draw that returns to idle when it finishes.
    this.anim = { mode: 'idle', seq: -1, frame: 0, fps: 16, loop: true, dur: 0 };
    this.hasSkeletal = false;
    this._pendingDur = 0;

    // Muzzle flash, rendered in this overlay at the current weapon's barrel tip
    // (so it appears at the gun, not at screen centre like a world-space flash).
    this._flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeFlashTexture(), transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0,
    }));
    this._flash.scale.set(0.12, 0.12, 0.12);
    this._flash.renderOrder = 1000;
    this._flash.position.set(0, 0, -0.32);
    this.rig.add(this._flash);
    this._flashTtl = 0;
  }

  // Fire flash at the current weapon's muzzle (barrel tip in rig space).
  flash() {
    const w = this.weapons[this.current];
    const mz = w && w.userData.muzzle;
    if (mz) this._flash.position.set(mz.x, mz.y, mz.z);
    this._flash.material.rotation = Math.random() * Math.PI;
    const s = 0.1 + Math.random() * 0.06;
    this._flash.scale.set(s, s, s);
    this._flashTtl = 0.045;
  }

  // Test-only: force EVERY loaded weapon to the same rotation, overriding
  // their individual VM_EULER entries. Used for comparing candidate values
  // while tuning; normal gameplay never calls this.
  setVMEuler(x, y, z) {
    this._vmEuler = [x, y, z];
    for (const w of Object.values(this.weapons)) if (w.rotation) w.rotation.set(x, y, z);
  }

  // Positional recoil nudge only (used for the small "punch" on weapon switch
  // / pickup too). shoot() additionally plays the skeletal fire animation —
  // switching weapons should never trigger a shoot pose.
  kick(amount = 0.6) { this.recoil = Math.min(1.4, this.recoil + amount); }

  shoot(amount = 0.6) { this.kick(amount); this._startAnim('shoot'); }

  startReload(dur) { this.reloadDur = dur; this.reloadT = dur; this._pendingDur = dur; this._startAnim('reload'); }

  // Start a skeletal sequence on the current weapon. shoot/reload/draw play once
  // and return to the idle loop; missing sequences fall back to idle.
  _startAnim(mode) {
    const sx = this.weapons[this.current]?.userData.seqs;
    if (!sx) { this.anim.seq = -1; return; }
    let seq = -1, loop = false;
    if (mode === 'shoot') seq = sx.shoot.length ? sx.shoot[(Math.random() * sx.shoot.length) | 0] : -1;
    else if (mode === 'reload') seq = sx.reload;
    else if (mode === 'draw') seq = sx.draw;
    if (seq < 0) { seq = sx.idle; loop = true; mode = 'idle'; }
    if (seq < 0) { this.anim.seq = -1; return; }
    const sd = sx.seqs[seq];
    this.anim = { mode, seq, frame: 0, fps: (sd && sd.fps) || 16, loop, dur: mode === 'reload' ? this._pendingDur : 0 };
    this._pendingDur = 0;
  }

  // Load real CS 1.6 StudioModel (.mdl) view models.
  has(name) { return !!this.weapons[name]; }

  async loadOne(name, def) {
    if (this.weapons[name] || this._loading?.[name]) return;
    (this._loading ||= {})[name] = true;
    const url = typeof def === 'string' ? def : def.url;
    const skipBodyparts = (typeof def === 'object' && def.skip) ? def.skip : [];
    try {
      const data = await loadMDL(url, { skipBodyparts });
      const weapon = this._makeMDLWeapon(data, name);
      weapon.visible = false;
      this.rig.add(weapon);
      this.weapons[name] = weapon;
    } catch (e) {
      console.warn(`[viewmodel] MDL load failed ${name}:`, e.message || e);
    }
    this._loading[name] = false;
  }

  async loadMDLWeapons(map) {
    for (const [name, def] of Object.entries(map)) await this.loadOne(name, def);
    const first = Object.keys(this.weapons)[0];
    if (first) this.select(first);
    return Object.keys(this.weapons);
  }

  _makeMDLWeapon(data, name) {
    // Animated geometry: the CS v_ models' long axis (barrel/arm) is model Y, up
    // is model Z. Map to the view-model camera (looks -Z, +Y up): three = (-X,
    // Z, Y). A small wrap euler then fine-tunes. buildAnimatedModel drives the
    // idle / shoot / reload / draw sequences by deforming this geometry.
    const am = buildAnimatedModel(data, { remap: remapVM });
    const inner = am.group;
    inner.traverse((m) => { if (m.isMesh) m.frustumCulled = false; });
    // center + scale + orient like a held first-person weapon (from the idle pose)
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    inner.position.sub(center);
    const wrap = new THREE.Group();
    wrap.add(inner);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    wrap.scale.setScalar(0.5 / maxDim);
    const euler = this._vmEuler || VM_EULER[name] || DEFAULT_EULER;
    wrap.rotation.set(euler[0], euler[1], euler[2]);
    const off = VM_OFFSET[name];
    if (off) wrap.position.set(off[0], off[1], off[2]);
    wrap.userData.anim = am;
    wrap.userData.seqs = resolveSeqs(data.anim.sequences);
    wrap.userData.muzzle = computeMuzzle(wrap);
    return wrap;
  }

  async load(map) {
    const loader = new GLTFLoader();
    for (const [name, url] of Object.entries(map)) {
      try {
        const gltf = await loader.loadAsync(url);
        const weapon = this._makeWeapon(gltf.scene);
        weapon.visible = false;
        this.rig.add(weapon);
        this.weapons[name] = weapon;
      } catch (e) {
        console.warn(`[viewmodel] failed to load ${name}:`, e.message || e);
      }
    }
    const first = Object.keys(this.weapons)[0];
    if (first) this.select(first);
    return Object.keys(this.weapons);
  }

  // Wrap the model so it is centered (in model units) inside an inner group,
  // then scale/orient the wrapper. Centering on the object's own position would
  // apply a model-unit offset in rig space and fling the gun off-screen.
  _makeWeapon(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    obj.position.sub(center); // center geometry at the wrapper's origin

    const inner = new THREE.Group();
    inner.add(obj);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    inner.scale.setScalar(0.32 / maxDim);
    // Orient like a held weapon: barrel into the screen, slight inward yaw,
    // a touch of downward pitch and roll so it reads as held, not floating.
    inner.rotation.set(-0.05, Math.PI + 0.18, 0.04);
    obj.traverse((m) => { if (m.isMesh) m.frustumCulled = false; });
    inner.userData.muzzle = computeMuzzle(inner);
    return inner;
  }

  select(name) {
    if (!this.weapons[name] || this.current === name) return;
    for (const k of Object.keys(this.weapons)) this.weapons[k].visible = (k === name);
    this.current = name;
    this._startAnim('draw'); // deploy animation on switch
  }

  // Subtle weapon bob proportional to movement speed.
  update(dt, speed) {
    this.bobT += dt * (4 + Math.min(speed, 1500) / 180);
    const amp = 0.006 + Math.min(speed, 1500) / 1500 * 0.012;
    this.recoil = Math.max(0, this.recoil - dt * 6);

    // Skeletal weapon animation (idle loop + one-shot shoot/reload/draw).
    const w = this.weapons[this.current];
    const sx = w && w.userData.seqs;
    this.hasSkeletal = !!(sx && w.userData.anim);
    if (this.hasSkeletal) {
      let a = this.anim;
      if (a.seq < 0) { this._startAnim('idle'); a = this.anim; }
      const sd = sx.seqs[a.seq];
      const nf = sd ? Math.max(1, sd.numframes) : 1;
      const fps = (a.mode === 'reload' && a.dur > 0) ? nf / a.dur : a.fps; // span the reload time
      a.frame += dt * fps;
      if (a.frame >= nf - 1) {
        if (a.loop) a.frame %= nf;
        else { this._startAnim('idle'); a = this.anim; }
      }
      w.userData.anim.apply(a.seq, a.frame);
    }

    // reload dip: only when the model can't reload itself (GLB fallback)
    let dip = 0;
    if (this.reloadT > 0) {
      this.reloadT = Math.max(0, this.reloadT - dt);
      if (!this.hasSkeletal) dip = Math.sin(Math.PI * (1 - this.reloadT / this.reloadDur));
    }
    this.rig.position.y = this.baseY + Math.sin(this.bobT) * amp - this.recoil * 0.01 - dip * 0.14;
    this.rig.position.x = this.baseX + Math.cos(this.bobT * 0.5) * amp * 0.6;
    this.rig.position.z = -0.85 + this.recoil * 0.05;
    this.rig.rotation.x = -this.recoil * 0.18 + dip * 0.5;

    // Show at full opacity the frame it fires, then fade — set opacity from the
    // current TTL *before* decaying, so a single low-fps frame still shows it.
    this._flash.material.opacity = this._flashTtl > 0 ? Math.min(1, this._flashTtl / 0.045) : 0;
    if (this._flashTtl > 0) this._flashTtl -= dt;
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

// Barrel tip of a built weapon group, in rig space: front-centre of its bbox.
// The view models are oriented so the barrel points -Z, so the muzzle is the
// most-forward (min Z) point at the bbox centre in X/Y.
function computeMuzzle(group) {
  group.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(group);
  if (!isFinite(b.min.z)) return { x: 0, y: 0, z: -0.32 };
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.min.z - 0.02 };
}
