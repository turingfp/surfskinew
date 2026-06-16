// Firing: plays the real CS 1.6 weapon sounds (WebAudio), kicks the viewmodel,
// punches the camera, flashes a muzzle sprite, and traces a hitscan tracer into
// the world. Hitscan uses the hull-1 trace (good enough for visual tracers).

import * as THREE from '../vendor/three.module.js';
import { gs2three } from './render.js';
import { normalize, angleVectors } from './vec.js';

const SPECS = {
  pistol: { sound: 'pistol', rate: 0.16, auto: false, kick: 0.6, spread: 0.006, pellets: 1, tracer: 0xbfe0ff, vol: 0.5 },
  rifle: { sound: 'rifle', rate: 0.095, auto: true, kick: 0.5, spread: 0.02, pellets: 1, tracer: 0xfff0a0, vol: 0.5 },
  shotgun: { sound: 'shotgun', rate: 0.85, auto: false, kick: 1.1, spread: 0.07, pellets: 8, tracer: 0xffd890, vol: 0.6 },
};

function makeFlashTexture() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,245,200,1)');
  grad.addColorStop(0.4, 'rgba(255,200,90,0.7)');
  grad.addColorStop(1, 'rgba(255,170,40,0)');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

// jitter a GS direction by up to `spread` radians
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
    this.camPunch = 0; // upward camera kick (radians), decays
    this.ctx = null;
    this.buffers = {};
    this.tracers = [];

    this._flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeFlashTexture(), color: 0xffe2a0, blending: THREE.AdditiveBlending,
      depthTest: false, transparent: true, opacity: 0,
    }));
    this._flash.scale.set(48, 48, 48);
    this._flash.renderOrder = 999;
    scene.add(this._flash);
    this._flashTtl = 0;
  }

  setWorld(w) { this.world = w; }
  setWeapon(n) { if (SPECS[n]) this.current = n; }

  async loadSounds(map) {
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
    for (const [k, url] of Object.entries(map)) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        this.buffers[k] = await this.ctx.decodeAudioData(await r.arrayBuffer());
      } catch { /* skip missing sound */ }
    }
  }

  _playRaw(name, vol) {
    if (!this.ctx || !this.buffers[name]) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffers[name];
    const g = this.ctx.createGain();
    g.gain.value = vol;
    s.connect(g).connect(this.ctx.destination);
    s.start();
  }

  // opts: { attack:bool, eyeGS:[x,y,z], yaw, pitch }
  update(dt, opts) {
    this.t += dt;
    this.camPunch = Math.max(0, this.camPunch - dt * 5);

    if (this._flashTtl > 0) {
      this._flashTtl -= dt;
      this._flash.material.opacity = Math.max(0, this._flashTtl / 0.04);
    } else {
      this._flash.material.opacity = 0;
    }
    for (const tr of this.tracers) {
      tr.ttl -= dt;
      tr.line.material.opacity = Math.max(0, tr.ttl / tr.life);
      if (tr.ttl <= 0) { this.scene.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose(); }
    }
    this.tracers = this.tracers.filter((t) => t.ttl > 0);

    if (opts.attack) {
      const spec = SPECS[this.current];
      if (this.t - this.lastFire >= spec.rate && (spec.auto || !this._wasAttack)) {
        this._fire(spec, opts);
        this.lastFire = this.t;
      }
    }
    this._wasAttack = opts.attack;
  }

  _fire(spec, opts) {
    this._playRaw(spec.sound, spec.vol);
    if (this.vm) this.vm.kick(spec.kick);
    this.camPunch += spec.kick * 0.012;

    const dirGS = angleVectors(opts.pitch, opts.yaw).forward;
    const e3 = gs2three(opts.eyeGS[0], opts.eyeGS[1], opts.eyeGS[2]);
    const d3 = gs2three(dirGS[0], dirGS[1], dirGS[2]);
    this._flash.position.set(e3[0] + d3[0] * 36, e3[1] + d3[1] * 36, e3[2] + d3[2] * 36);
    this._flashTtl = 0.04;

    for (let i = 0; i < (spec.pellets || 1); i++) {
      const dir = spreadDir(dirGS, spec.spread);
      const end = [
        opts.eyeGS[0] + dir[0] * 8192,
        opts.eyeGS[1] + dir[1] * 8192,
        opts.eyeGS[2] + dir[2] * 8192,
      ];
      let hit = end;
      if (this.world) {
        const tr = this.world.traceHull(opts.eyeGS, end, 1);
        if (tr.fraction < 1) hit = tr.endpos;
      }
      this._tracer(opts.eyeGS, hit, spec.tracer);
    }
  }

  _tracer(aGS, bGS, color) {
    const a = gs2three(aGS[0], aGS[1], aGS[2]);
    const b = gs2three(bGS[0], bGS[1], bGS[2]);
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(b[0], b[1], b[2]),
    ]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(g, mat);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, ttl: 0.06, life: 0.06 });
  }
}
