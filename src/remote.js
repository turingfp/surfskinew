// Renders other players in the session as animated avatars (a posed CS player
// model that plays idle / walk / run from their networked movement) with a name
// label, interpolated toward their latest networked state.

import * as THREE from '../vendor/three.module.js';
import { gs2three, buildAnimatedModel } from './render.js';

const COLORS = [0xff5d5d, 0x57a6ff, 0x5fd06f, 0xffc24d, 0xc66bff, 0x4de0d0, 0xff8f4d, 0xa0e85a];

// Weapon id -> the CS player model's third-person "aim" animation category
// (arms/upper body pose while holding that weapon). The leet/urban rigs only
// ship a handful of these categories, shared across similarly-held weapons.
const AIM_CATEGORY = {
  usp: 'onehanded', glock: 'onehanded', deagle: 'onehanded',
  ak47: 'ak47',
  m4a1: 'carbine',
  mp5: 'mp5', tmp: 'mp5', mac10: 'mp5', p90: 'mp5',
  sg552: 'rifle', aug: 'rifle', scout: 'rifle', awp: 'rifle', g3sg1: 'rifle',
  m3: 'shotgun', xm1014: 'shotgun',
  m249: 'm249',
};

function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.strokeText(text, 128, 32);
  g.fillStyle = '#' + new THREE.Color(color).getHexString();
  g.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(64, 16, 1);
  return spr;
}

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map();
    this._ci = 0;
    this.templateData = null; // parsed CS player MDL (with .anim), built per peer
    this.seq = null;          // resolved sequence indices for idle/walk/run
  }

  // Store the parsed player MDL (from loadMDL) and resolve movement sequences
  // (legs) + per-weapon-category aim sequences (arms/upper body — see
  // AIM_CATEGORY). Standing aim poses are "ref_aim_*"; ducking isn't tracked
  // for remote avatars today so "crouch_aim_*" is unused.
  setTemplate(data) {
    this.templateData = data;
    const seqs = (data.anim && data.anim.sequences) || [];
    const find = (...names) => { for (const n of names) { const i = seqs.findIndex((s) => s.name === n); if (i >= 0) return i; } return -1; };
    this.seq = {
      idle: find('idle1', 'idle', 'ref_aim_rifle'),
      walk: find('walk'),
      run: find('run'),
    };
    this.aimSeq = {};
    this.shootSeq = {};
    for (const cat of new Set(Object.values(AIM_CATEGORY))) {
      this.aimSeq[cat] = find(`ref_aim_${cat}`);
      this.shootSeq[cat] = find(`ref_shoot_${cat}`);
    }
    // Death sequences (played once, corpse holds the final frame). The rig
    // ships generic deaths plus directional/hit-location variants — pick
    // randomly for variety.
    this.deathSeqs = ['death1', 'death2', 'death3', 'head', 'gutshot', 'left', 'back', 'right', 'forward']
      .map((n) => find(n)).filter((i) => i >= 0);
  }

  // Flash the third-person fire animation (upper body) on an avatar. Called
  // when a remote peer's shot arrives or a local bot fires — without this the
  // arms hold a frozen aim pose no matter how much shooting is going on.
  notifyShot(id) {
    const p = this.players.get(id);
    if (!p || !p.anim || p.dying || !this.seq) return;
    const cat = p.cur && AIM_CATEGORY[p.cur.w];
    const seq = cat != null ? this.shootSeq[cat] : -1;
    if (seq != null && seq >= 0) p.upper = { seq, phase: 0 };
  }

  // Start a one-shot death animation; the avatar becomes a corpse (no longer
  // hit-testable via forEach) until the next update() with hp > 0 revives it.
  die(id) {
    const p = this.players.get(id);
    if (!p || p.dying) return;
    if (!p.anim || !this.deathSeqs || this.deathSeqs.length === 0) { this.remove(id); return; }
    const seq = this.deathSeqs[(Math.random() * this.deathSeqs.length) | 0];
    p.dying = { seq, phase: 0 };
    p.upper = null;
  }

  _make(id) {
    const color = COLORS[this._ci++ % COLORS.length];
    const group = new THREE.Group();
    let body, anim = null;
    if (this.templateData) {
      const am = buildAnimatedModel(this.templateData);
      body = am.group; anim = am;
      // rest feet on the hull bottom (36u below the player centre)
      body.position.y = -36 - am.modelMinY;
    } else {
      // fallback avatar (capsule + head) until the model loads
      body = new THREE.Group();
      const cap = new THREE.Mesh(new THREE.CapsuleGeometry(14, 44, 6, 12), new THREE.MeshLambertMaterial({ color }));
      const head = new THREE.Mesh(new THREE.SphereGeometry(9, 12, 10), new THREE.MeshLambertMaterial({ color: 0xffe0bd }));
      head.position.y = 30; body.add(cap, head);
    }
    group.add(body);
    const label = makeLabel(id.slice(0, 6), color);
    label.position.y = 52;
    group.add(label);
    group.position.set(99999, 99999, 99999); // offscreen until first update
    this.scene.add(group);
    const p = { group, body, anim, color, cur: null, started: false, phase: 0, seqCur: -1, speed: 0, prev: null };
    this.players.set(id, p);
    return p;
  }

  update(id, data) {
    const p = this.players.get(id) || this._make(id);
    // A live update for a corpse means it respawned: clear the death pose and
    // snap (don't smooth) to the new spawn point.
    if (p.dying && data && data.hp > 0) { p.dying = null; p.seqCur = -1; p.started = false; }
    p.cur = data;
  }

  remove(id) {
    const p = this.players.get(id);
    if (p) { this.scene.remove(p.group); this.players.delete(id); }
  }

  clear() { for (const id of [...this.players.keys()]) this.remove(id); }

  // Scoreboard rows for connected peers.
  list() {
    const out = [];
    for (const [id, p] of this.players) {
      const d = p.cur || {};
      out.push({ id, name: d.nm || id.slice(0, 6), peak: d.pk || 0, time: d.t || 0, kills: d.k || 0, deaths: d.d || 0, hp: d.hp != null ? d.hp : 100, color: p.color });
    }
    return out;
  }

  // For hit detection + spawn avoidance: GS origin (centre) of each LIVING
  // peer. Corpses (p.dying) are skipped so bullets pass through them to live
  // targets behind, and spawns aren't blocked by a body.
  forEach(cb) { for (const [id, p] of this.players) if (p.cur && p.cur.o && !p.dying) cb(id, p.cur.o, p); }

  get color() { return COLORS; }
  colorFor(id) { const p = this.players.get(id); return p ? p.color : 0xffffff; }

  render(dt = 0.016) {
    for (const [, p] of this.players) {
      if (!p.cur) continue;
      const o = p.cur.o;
      const [tx, ty, tz] = gs2three(o[0], o[1], o[2]);
      const g = p.group;
      if (!p.started) { g.position.set(tx, ty, tz); p.started = true; p.prev = { x: tx, y: ty, z: tz }; }
      else {
        const k = 0.25; // smoothing toward the latest state
        g.position.x += (tx - g.position.x) * k;
        g.position.y += (ty - g.position.y) * k;
        g.position.z += (tz - g.position.z) * k;
      }
      if (p.body && !p.dying) p.body.rotation.y = (p.cur.y || 0); // face their yaw

      // Death: play the one-shot sequence full-body and hold the last frame
      // (the corpse lingers until the respawn update clears p.dying).
      if (p.dying) {
        if (p.anim) {
          const sq = this.templateData.anim.sequences[p.dying.seq];
          const nf = Math.max(1, (sq && sq.numframes) || 1);
          p.dying.phase = Math.min(p.dying.phase + dt * ((sq && sq.fps) || 30), nf - 1);
          p.anim.apply(p.dying.seq, p.dying.phase);
        }
        continue;
      }

      if (p.anim && this.seq) {
        // on-screen horizontal speed (three: X/Z are the ground plane)
        const gp = g.position;
        if (p.prev) {
          const inst = Math.hypot(gp.x - p.prev.x, gp.z - p.prev.z) / Math.max(dt, 1e-3);
          p.speed = p.speed * 0.7 + inst * 0.3;
        }
        p.prev = { x: gp.x, y: gp.y, z: gp.z };

        let seq = this.seq.idle, rate = 1;
        if (p.speed > 140 && this.seq.run >= 0) { seq = this.seq.run; }
        else if (p.speed > 12 && this.seq.walk >= 0) { seq = this.seq.walk; }
        if (seq < 0) seq = this.seq.idle;
        if (seq !== p.seqCur) { p.seqCur = seq; p.phase = 0; }
        const sq = this.templateData.anim.sequences[seq];
        const fps = (sq && sq.fps) || 15;
        p.phase += dt * fps * rate;
        // Blend the movement sequence (legs) with an upper-body pose: the
        // one-shot fire animation while it plays (see notifyShot), otherwise
        // the held weapon's static aim pose — without which the arms stay at
        // bind pose (T-pose), since walk/run/idle don't pose the arms.
        let aimSeq = -1, aimFrame = 0;
        if (p.upper) {
          const usq = this.templateData.anim.sequences[p.upper.seq];
          p.upper.phase += dt * ((usq && usq.fps) || 30);
          if (!usq || p.upper.phase >= usq.numframes - 1) p.upper = null;
          else { aimSeq = p.upper.seq; aimFrame = p.upper.phase; }
        }
        if (aimSeq < 0) {
          const cat = AIM_CATEGORY[p.cur.w];
          const a = cat != null ? this.aimSeq[cat] : -1;
          if (a != null) aimSeq = a;
        }
        p.anim.applyBlend(seq, p.phase, aimSeq, aimFrame);
      }
    }
  }
}
