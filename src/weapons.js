// Weapons: firing, ammo (clip + reserve), reload, bullet decals, and the real
// CS 1.6 sounds. Hitscan tracers + impact decals against the world; recoil and
// camera punch; per-weapon fire mode (semi / auto / pump). Designed to feel
// like CS while remaining the surf game's combat layer.

import * as THREE from '../vendor/three.module.js';
import { gs2three } from './render.js';
import { normalize, angleVectors } from './vec.js';

// reload-sound sets shared by category (so we don't ship 50 reload clips)
const RLD = {
  pistol: { out: 'pistol_out', in: 'pistol_in', rack: 'pistol_slide' },
  deagle: { out: 'deagle_out', in: 'deagle_in', rack: 'deagle_in' },
  rifle: { out: 'rifle_out', in: 'rifle_in', rack: 'rifle_bolt' },
  ak: { out: 'ak47_out', in: 'ak47_in', rack: 'ak47_bolt' },
  sniper: { out: 'awp_out', in: 'awp_in', rack: 'awp_bolt' },
  shotgun: { out: 'shotgun_pump', in: 'shotgun_insert', rack: 'shotgun_pump' },
};
function spec(o) { return { vol: 0.55, pellets: 1, tracer: 0xfff0a0, ...o, ...RLD[o.rld] }; }

export const WEAPON_LIST = ['usp', 'glock', 'deagle', 'mp5', 'tmp', 'mac10', 'p90', 'ak47', 'm4a1', 'sg552', 'aug', 'scout', 'awp', 'g3sg1', 'm3', 'xm1014', 'm249'];

const SPECS = {
  // pistols (one-handed, semi)
  usp: spec({ label: 'USP', sound: 'usp', rate: 0.15, auto: false, kick: 0.6, spread: 0.006, dmg: 24, clip: 12, reserve: 120, reload: 2.2, rld: 'pistol', tracer: 0xbfe0ff }),
  glock: spec({ label: 'GLOCK', sound: 'glock', rate: 0.13, auto: false, kick: 0.5, spread: 0.007, dmg: 18, clip: 20, reserve: 120, reload: 2.2, rld: 'pistol', tracer: 0xbfe0ff }),
  deagle: spec({ label: 'DEAGLE', sound: 'deagle', rate: 0.25, auto: false, kick: 0.95, spread: 0.008, dmg: 54, clip: 7, reserve: 35, reload: 2.2, rld: 'deagle', tracer: 0xffe0b0 }),
  // smgs (auto)
  mp5: spec({ label: 'MP5', sound: 'mp5', rate: 0.08, auto: true, kick: 0.4, spread: 0.02, dmg: 26, clip: 30, reserve: 120, reload: 2.6, rld: 'rifle' }),
  tmp: spec({ label: 'TMP', sound: 'tmp', rate: 0.07, auto: true, kick: 0.35, spread: 0.022, dmg: 20, clip: 30, reserve: 120, reload: 2.2, rld: 'rifle' }),
  mac10: spec({ label: 'MAC10', sound: 'mac10', rate: 0.07, auto: true, kick: 0.45, spread: 0.03, dmg: 25, clip: 30, reserve: 100, reload: 2.7, rld: 'rifle' }),
  p90: spec({ label: 'P90', sound: 'p90', rate: 0.07, auto: true, kick: 0.4, spread: 0.024, dmg: 22, clip: 50, reserve: 100, reload: 3.3, rld: 'rifle' }),
  // rifles (auto)
  ak47: spec({ label: 'AK47', sound: 'ak47', rate: 0.1, auto: true, kick: 0.7, spread: 0.03, dmg: 33, clip: 30, reserve: 90, reload: 2.5, rld: 'ak', tracer: 0xffd27f }),
  m4a1: spec({ label: 'M4A1', sound: 'm4a1', rate: 0.09, auto: true, kick: 0.5, spread: 0.022, dmg: 28, clip: 30, reserve: 90, reload: 3.0, rld: 'rifle' }),
  sg552: spec({ label: 'SG552', sound: 'sg552', rate: 0.09, auto: true, kick: 0.6, spread: 0.025, dmg: 30, clip: 30, reserve: 90, reload: 3.0, rld: 'rifle' }),
  aug: spec({ label: 'AUG', sound: 'aug', rate: 0.09, auto: true, kick: 0.5, spread: 0.022, dmg: 28, clip: 30, reserve: 90, reload: 3.3, rld: 'rifle' }),
  // snipers (semi)
  scout: spec({ label: 'SCOUT', sound: 'scout', rate: 1.25, auto: false, kick: 1.2, spread: 0.002, dmg: 75, clip: 10, reserve: 90, reload: 2.0, rld: 'sniper', tracer: 0x9fd0ff, zoom: [40] }),
  awp: spec({ label: 'AWP', sound: 'awp', rate: 1.5, auto: false, kick: 1.5, spread: 0.001, dmg: 115, clip: 10, reserve: 30, reload: 3.0, rld: 'sniper', tracer: 0x9fd0ff, zoom: [40, 10] }),
  g3sg1: spec({ label: 'G3SG1', sound: 'g3sg1', rate: 0.25, auto: false, kick: 0.9, spread: 0.01, dmg: 40, clip: 20, reserve: 90, reload: 3.5, rld: 'sniper', tracer: 0x9fd0ff }),
  // shotguns (pellets)
  m3: spec({ label: 'M3', sound: 'm3', rate: 0.8, auto: false, kick: 1.1, spread: 0.07, pellets: 8, dmg: 11, clip: 8, reserve: 32, reload: 2.6, rld: 'shotgun', tracer: 0xffd890 }),
  xm1014: spec({ label: 'XM1014', sound: 'xm1014', rate: 0.3, auto: false, kick: 0.9, spread: 0.08, pellets: 8, dmg: 9, clip: 7, reserve: 32, reload: 3.2, rld: 'shotgun', tracer: 0xffd890 }),
  // lmg (auto)
  m249: spec({ label: 'M249', sound: 'm249', rate: 0.08, auto: true, kick: 0.6, spread: 0.03, dmg: 32, clip: 100, reserve: 100, reload: 4.5, rld: 'rifle' }),
};

// Read-only accessor so other systems (bots.js) can fire with real weapon
// balance (damage/rate/spread/sound) without duplicating the table.
export function weaponSpec(name) { return SPECS[name]; }

function makeFlashTexture() {
  const s = 64; const c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,245,200,1)');
  grad.addColorStop(0.4, 'rgba(255,200,90,0.7)');
  grad.addColorStop(1, 'rgba(255,170,40,0)');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

function makeDecalTexture() {
  const s = 64; const c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  g.clearRect(0, 0, s, s);
  const grad = g.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(10,10,10,0.95)');
  grad.addColorStop(0.5, 'rgba(20,20,20,0.7)');
  grad.addColorStop(1, 'rgba(30,30,30,0)');
  g.fillStyle = grad; g.beginPath(); g.arc(s / 2, s / 2, s / 2, 0, 7); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1.5;
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * 7, r = 6 + Math.random() * 22;
    g.beginPath(); g.moveTo(s / 2, s / 2); g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r); g.stroke();
  }
  return new THREE.CanvasTexture(c);
}

function spreadDir(dir, spread) {
  if (spread <= 0) return dir.slice();
  return normalize([
    dir[0] + (Math.random() - 0.5) * 2 * spread,
    dir[1] + (Math.random() - 0.5) * 2 * spread,
    dir[2] + (Math.random() - 0.5) * 2 * spread,
  ]);
}

export class Weapons {
  constructor(scene, viewmodel) {
    this.scene = scene;
    this.vm = viewmodel;
    this.world = null;
    this.current = 'usp';
    this.t = 0;
    this.lastFire = -10;
    this._wasAttack = false;
    this.camPunch = 0;
    this.ctx = null;
    this.buffers = {};
    this.masterVol = 0.6;
    this.tracers = [];

    // ammo per weapon
    this.ammo = {};
    for (const [k, s] of Object.entries(SPECS)) this.ammo[k] = { clip: s.clip, reserve: s.reserve };
    this.reloading = false;
    this._reloadEnd = 0; this._reloadMid = 0; this._reloadName = null;

    this._flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeFlashTexture(), color: 0xffe2a0, blending: THREE.AdditiveBlending,
      depthTest: false, transparent: true, opacity: 0,
    }));
    this._flash.scale.set(48, 48, 48);
    this._flash.renderOrder = 999;
    scene.add(this._flash);
    this._flashTtl = 0;

    // decal pool
    this._decalTex = makeDecalTexture();
    this._decals = [];
    this._decalIdx = 0;
    this._maxDecals = 96;

    this.onShot = null; // (data) => broadcast
    this.playerHitTest = null; // (eyeGS, dirGS) => {id, dist} | null
    this.onPlayerHit = null; // (peerId, dmg, label) => void
  }

  setWorld(w) { this.world = w; }
  has(n) { return !!SPECS[n]; }
  setWeapon(n) {
    if (!SPECS[n] || n === this.current) return;
    this.current = n;
    this.reloading = false;
    this._playRaw('draw', 0.4);
    if (this.vm) this.vm.kick(0.3);
  }
  // pick up / equip a weapon and top up its ammo
  give(n) {
    if (!SPECS[n]) return;
    this.ammo[n] = { clip: SPECS[n].clip, reserve: SPECS[n].reserve };
    this.current = n;
    this.reloading = false;
    this._playRaw('draw', 0.5);
    if (this.vm) this.vm.kick(0.3);
  }
  // Full ammo refill on respawn — dying and coming back with yesterday's
  // empty clip (and no way to reload without a pickup) isn't the intent;
  // a fresh life gets a fresh loadout, same as picking up every weapon.
  resetAmmo() {
    for (const [k, s] of Object.entries(SPECS)) this.ammo[k] = { clip: s.clip, reserve: s.reserve };
    this.reloading = false;
  }
  spec() { return SPECS[this.current]; }
  ammoState() {
    const a = this.ammo[this.current];
    return { clip: a.clip, reserve: a.reserve, label: SPECS[this.current].label, reloading: this.reloading };
  }

  async loadSounds(map) {
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
    for (const [k, url] of Object.entries(map)) {
      try { this.buffers[k] = await this.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()); } catch { /* skip */ }
    }
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // Zoomed-in horizontal FOVs for the current weapon (snipers), or null. Each
  // right-click cycles through these and back to unzoomed.
  getZoomFovs() { return SPECS[this.current] && SPECS[this.current].zoom ? SPECS[this.current].zoom : null; }

  // Real CS scope-toggle "zoom" sample; falls back to a synthesized blip only
  // if the asset failed to load.
  playZoom() {
    if (this.buffers.zoom) { this._playRaw('zoom', 0.7); return; }
    if (!this.ctx) return;
    this.resume();
    const ctx = this.ctx, t0 = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(820, t0);
    o.frequency.exponentialRampToValueAtTime(1500, t0 + 0.05);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22 * this.masterVol + 0.0001, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    o.connect(g).connect(ctx.destination);
    o.start(t0); o.stop(t0 + 0.08);
  }

  _playRaw(name, vol) {
    if (!this.ctx || !this.buffers[name]) return;
    this.resume();
    const s = this.ctx.createBufferSource(); s.buffer = this.buffers[name];
    const g = this.ctx.createGain(); g.gain.value = vol * this.masterVol;
    s.connect(g).connect(this.ctx.destination); s.start();
  }

  reload() {
    const a = this.ammo[this.current];
    const s = SPECS[this.current];
    if (this.reloading || a.clip >= s.clip || a.reserve <= 0) return;
    this.reloading = true;
    this._reloadName = this.current;
    this._reloadEnd = this.t + s.reload;
    this._reloadMid = this.t + s.reload * 0.55;
    this._reloadMidDone = false;
    this._playRaw(s.out, 0.5);
    if (this.vm) this.vm.startReload(s.reload);
  }

  _finishReload() {
    const a = this.ammo[this._reloadName];
    const s = SPECS[this._reloadName];
    const need = s.clip - a.clip;
    const take = Math.min(need, a.reserve);
    a.clip += take; a.reserve -= take;
    this.reloading = false;
  }

  update(dt, opts) {
    this.t += dt;
    this.camPunch = Math.max(0, this.camPunch - dt * 5);

    // reload sound staging + completion
    if (this.reloading) {
      if (!this._reloadMidDone && this.t >= this._reloadMid) {
        this._reloadMidDone = true;
        this._playRaw(SPECS[this._reloadName].in, 0.5);
      }
      if (this.t >= this._reloadEnd) {
        this._playRaw(SPECS[this._reloadName].rack, 0.5);
        this._finishReload();
      }
    }

    if (this._flashTtl > 0) { this._flashTtl -= dt; this._flash.material.opacity = Math.max(0, this._flashTtl / 0.04); }
    else this._flash.material.opacity = 0;

    for (const tr of this.tracers) {
      tr.ttl -= dt; tr.line.material.opacity = Math.max(0, tr.ttl / tr.life);
      if (tr.ttl <= 0) { this.scene.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose(); }
    }
    this.tracers = this.tracers.filter((t) => t.ttl > 0);

    if (opts.attack) {
      const spec = SPECS[this.current];
      const a = this.ammo[this.current];
      if (this.t - this.lastFire >= spec.rate && (spec.auto || !this._wasAttack)) {
        if (this.reloading) { /* busy */ }
        else if (a.clip <= 0) {
          if (!this._wasAttack) { this._playRaw('empty', 0.5); this.lastFire = this.t; }
          if (a.reserve > 0) this.reload();
        } else {
          a.clip -= 1;
          this._fire(spec, opts);
          this.lastFire = this.t;
        }
      }
    }
    this._wasAttack = opts.attack;
  }

  _fire(spec, opts) {
    this._playRaw(spec.sound, spec.vol);
    if (this.vm) this.vm.shoot(spec.kick);
    this.camPunch += spec.kick * 0.012;
    if (this.onShot) this.onShot({ o: opts.eyeGS.slice(), y: opts.yaw, p: opts.pitch, w: this.current });

    const dirGS = angleVectors(opts.pitch, opts.yaw).forward;
    // muzzle flash at the gun barrel, drawn in the first-person overlay
    if (this.vm) this.vm.flash();

    for (let i = 0; i < (spec.pellets || 1); i++) {
      const dir = spreadDir(dirGS, spec.spread);
      const end = [opts.eyeGS[0] + dir[0] * 8192, opts.eyeGS[1] + dir[1] * 8192, opts.eyeGS[2] + dir[2] * 8192];
      let hit = end; let normal = null; let worldDist = 8192;
      if (this.world) {
        // point trace so decals land exactly on the surface (not a hull-width out)
        const tr = this.world.traceBullet ? this.world.traceBullet(opts.eyeGS, end) : this.world.traceHull(opts.eyeGS, end, 1);
        if (tr.fraction < 1) { hit = tr.endpos; normal = tr.plane ? tr.plane.normal : null; worldDist = 8192 * tr.fraction; }
      }
      // player hit-detection (closer than the world hit = a hit on a player)
      const ph = this.playerHitTest ? this.playerHitTest(opts.eyeGS, dir) : null;
      if (ph && ph.dist < worldDist) {
        const p = [opts.eyeGS[0] + dir[0] * ph.dist, opts.eyeGS[1] + dir[1] * ph.dist, opts.eyeGS[2] + dir[2] * ph.dist];
        this._tracer(opts.eyeGS, p, 0xff5555);
        if (this.onPlayerHit) this.onPlayerHit(ph.id, spec.dmg, spec.label);
      } else {
        this._tracer(opts.eyeGS, hit, spec.tracer);
        if (normal) this._decal(hit, normal);
      }
    }
  }

  remoteShot(data) {
    if (!data || !data.o) return;
    const spec = SPECS[data.w] || SPECS.usp;
    this._playRaw(spec.sound, spec.vol * 0.4);
    const dirGS = angleVectors(data.p || 0, data.y || 0).forward;
    // muzzle flash in the world at the remote shooter's barrel
    const f3 = gs2three(data.o[0] + dirGS[0] * 20, data.o[1] + dirGS[1] * 20, data.o[2] + dirGS[2] * 20 - 6);
    this._flash.position.set(f3[0], f3[1], f3[2]);
    this._flashTtl = 0.04;
    const end = [data.o[0] + dirGS[0] * 8192, data.o[1] + dirGS[1] * 8192, data.o[2] + dirGS[2] * 8192];
    let hit = end; let normal = null;
    if (this.world) { const tr = this.world.traceBullet ? this.world.traceBullet(data.o, end) : this.world.traceHull(data.o, end, 1); if (tr.fraction < 1) { hit = tr.endpos; normal = tr.plane ? tr.plane.normal : null; } }
    this._tracer(data.o, hit, spec.tracer);
    if (normal) this._decal(hit, normal);
  }

  _tracer(aGS, bGS, color) {
    const a = gs2three(aGS[0], aGS[1], aGS[2]);
    const b = gs2three(bGS[0], bGS[1], bGS[2]);
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(g, mat); line.frustumCulled = false;
    this.scene.add(line); this.tracers.push({ line, ttl: 0.05, life: 0.05 });
  }

  _decal(hitGS, normalGS) {
    const p = gs2three(hitGS[0], hitGS[1], hitGS[2]);
    const n = normalize(gs2three(normalGS[0], normalGS[1], normalGS[2]));
    let mesh = this._decals[this._decalIdx];
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: this._decalTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
      );
      mesh.scale.setScalar(7);
      this.scene.add(mesh);
      this._decals[this._decalIdx] = mesh;
    }
    mesh.position.set(p[0] + n[0] * 0.6, p[1] + n[1] * 0.6, p[2] + n[2] * 0.6);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(n[0], n[1], n[2]));
    mesh.visible = true;
    this._decalIdx = (this._decalIdx + 1) % this._maxDecals;
  }
}
