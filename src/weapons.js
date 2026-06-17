// Weapons: firing, ammo (clip + reserve), reload, bullet decals, and the real
// CS 1.6 sounds. Hitscan tracers + impact decals against the world; recoil and
// camera punch; per-weapon fire mode (semi / auto / pump). Designed to feel
// like CS while remaining the surf game's combat layer.

import * as THREE from '../vendor/three.module.js';
import { gs2three } from './render.js';
import { normalize, angleVectors } from './vec.js';

const SPECS = {
  pistol: {
    label: 'USP', sound: 'pistol', rate: 0.15, auto: false, kick: 0.6, spread: 0.006, pellets: 1, dmg: 24,
    tracer: 0xbfe0ff, vol: 0.5, clip: 12, reserve: 120, reload: 2.2,
    out: 'pistol_out', in: 'pistol_in', rack: 'pistol_slide',
  },
  rifle: {
    label: 'M4A1', sound: 'rifle', rate: 0.09, auto: true, kick: 0.5, spread: 0.022, pellets: 1, dmg: 28,
    tracer: 0xfff0a0, vol: 0.5, clip: 30, reserve: 90, reload: 3.0,
    out: 'rifle_out', in: 'rifle_in', rack: 'rifle_bolt',
  },
  shotgun: {
    label: 'M3', sound: 'shotgun', rate: 0.8, auto: false, kick: 1.1, spread: 0.07, pellets: 8, dmg: 11,
    tracer: 0xffd890, vol: 0.6, clip: 8, reserve: 32, reload: 2.6,
    out: 'shotgun_pump', in: 'shotgun_insert', rack: 'shotgun_pump',
  },
};

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
    this.current = 'pistol';
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
  setWeapon(n) {
    if (!SPECS[n] || n === this.current) return;
    this.current = n;
    this.reloading = false;
    this._playRaw('draw', 0.4);
    if (this.vm) this.vm.kick(0.3);
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
    if (this.vm) this.vm.kick(spec.kick);
    this.camPunch += spec.kick * 0.012;
    if (this.onShot) this.onShot({ o: opts.eyeGS.slice(), y: opts.yaw, p: opts.pitch, w: this.current });

    const dirGS = angleVectors(opts.pitch, opts.yaw).forward;
    const e3 = gs2three(opts.eyeGS[0], opts.eyeGS[1], opts.eyeGS[2]);
    const d3 = gs2three(dirGS[0], dirGS[1], dirGS[2]);
    this._flash.position.set(e3[0] + d3[0] * 36, e3[1] + d3[1] * 36, e3[2] + d3[2] * 36);
    this._flashTtl = 0.04;

    for (let i = 0; i < (spec.pellets || 1); i++) {
      const dir = spreadDir(dirGS, spec.spread);
      const end = [opts.eyeGS[0] + dir[0] * 8192, opts.eyeGS[1] + dir[1] * 8192, opts.eyeGS[2] + dir[2] * 8192];
      let hit = end; let normal = null; let worldDist = 8192;
      if (this.world) {
        const tr = this.world.traceHull(opts.eyeGS, end, 1);
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
    const spec = SPECS[data.w] || SPECS.pistol;
    this._playRaw(spec.sound, spec.vol * 0.4);
    const dirGS = angleVectors(data.p || 0, data.y || 0).forward;
    const end = [data.o[0] + dirGS[0] * 8192, data.o[1] + dirGS[1] * 8192, data.o[2] + dirGS[2] * 8192];
    let hit = end; let normal = null;
    if (this.world) { const tr = this.world.traceHull(data.o, end, 1); if (tr.fraction < 1) { hit = tr.endpos; normal = tr.plane ? tr.plane.normal : null; } }
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
