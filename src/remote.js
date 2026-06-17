// Renders other players in the session as simple avatars (capsule body + head
// + name label), interpolated toward their latest networked state.

import * as THREE from '../vendor/three.module.js';
import { gs2three } from './render.js';

const COLORS = [0xff5d5d, 0x57a6ff, 0x5fd06f, 0xffc24d, 0xc66bff, 0x4de0d0, 0xff8f4d, 0xa0e85a];

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
  }

  _make(id) {
    const color = COLORS[this._ci++ % COLORS.length];
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });
    // body capsule sized to the player hull (32 wide, 72 tall), centred on origin
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(14, 44, 6, 12), mat);
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(9, 12, 10), new THREE.MeshLambertMaterial({ color: 0xffe0bd }));
    head.position.y = 30;
    group.add(head);
    // little gun nub so you can read their facing
    const gun = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 22), new THREE.MeshLambertMaterial({ color: 0x222222 }));
    gun.position.set(10, 16, -14);
    group.add(gun);
    const label = makeLabel(id.slice(0, 6), color);
    label.position.y = 52;
    group.add(label);
    group.position.set(99999, 99999, 99999); // offscreen until first update
    this.scene.add(group);
    const p = { group, color, cur: null, started: false };
    this.players.set(id, p);
    return p;
  }

  update(id, data) {
    const p = this.players.get(id) || this._make(id);
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

  // For hit detection: GS origin (centre) of each peer.
  forEach(cb) { for (const [id, p] of this.players) if (p.cur && p.cur.o) cb(id, p.cur.o, p); }

  get color() { return COLORS; }
  colorFor(id) { const p = this.players.get(id); return p ? p.color : 0xffffff; }

  render() {
    for (const [, p] of this.players) {
      if (!p.cur) continue;
      const o = p.cur.o;
      const [tx, ty, tz] = gs2three(o[0], o[1], o[2]);
      const g = p.group;
      if (!p.started) { g.position.set(tx, ty, tz); p.started = true; }
      else {
        const k = 0.25; // smoothing toward the latest state
        g.position.x += (tx - g.position.x) * k;
        g.position.y += (ty - g.position.y) * k;
        g.position.z += (tz - g.position.z) * k;
      }
      g.rotation.y = -(p.cur.y || 0) + Math.PI / 2;
    }
  }
}
