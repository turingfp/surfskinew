// Weapon viewmodel — a classic CS touch. Loads CC0 Quaternius gun models
// (poly.pizza) and renders them in a dedicated overlay pass so the close-up
// weapon isn't clipped by the world's near plane or its huge unit scale.

import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/jsm/loaders/GLTFLoader.js';
import { loadMDL } from './mdl.js';

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
    // Held-weapon placement in view space (camera looks down -Z). The gun sits
    // in the lower portion, slightly right of center, and is pushed a full unit
    // into the scene so it reads as emerging from the player's view pointing
    // forward — not flung off the right edge. Keeping baseZ well away from the
    // camera also stops perspective from magnifying the offset off-screen.
    this.baseX = 0.2; this.baseY = -0.4; this.baseZ = -1.2;
    this.rig.position.set(this.baseX, this.baseY, this.baseZ);
    this.scene.add(this.rig);

    this.weapons = {};
    this.current = null;
    this.bobT = 0;
    this.recoil = 0; // 0..1, decays; kicks the gun back + up when firing
    this.reloadT = 0; this.reloadDur = 0; // reload dip animation
    this._vmEuler = [0, 0, 0]; // fine-tune on top of the baked axis remap
  }

  // Re-orient all loaded MDL weapons (used to tune the view-model orientation).
  setVMEuler(x, y, z) {
    this._vmEuler = [x, y, z];
    for (const w of Object.values(this.weapons)) if (w.rotation) w.rotation.set(x, y, z);
  }

  kick(amount = 0.6) { this.recoil = Math.min(1.4, this.recoil + amount); }

  startReload(dur) { this.reloadDur = dur; this.reloadT = dur; }

  // Load real CS 1.6 StudioModel (.mdl) view models.
  has(name) { return !!this.weapons[name]; }

  async loadOne(name, def) {
    if (this.weapons[name] || this._loading?.[name]) return;
    (this._loading ||= {})[name] = true;
    const url = typeof def === 'string' ? def : def.url;
    const skipBodyparts = (typeof def === 'object' && def.skip) ? def.skip : [];
    try {
      const data = await loadMDL(url, { skipBodyparts });
      const weapon = this._makeMDLWeapon(data);
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

  _makeMDLWeapon(data) {
    const inner = new THREE.Group();
    for (const g of data.groups) {
      // The CS v_ models' long axis (barrel/arm) is model Y, up is model Z.
      // Map to the view-model camera (looks -Z, +Y up): forward(-Y)->-Z,
      // up(Z)->+Y, so three = (-X, Z, Y). A small wrap euler then fine-tunes.
      const n = g.positions.length / 3;
      const pos = new Float32Array(n * 3);
      const nrm = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const mx = g.positions[i * 3], my = g.positions[i * 3 + 1], mz = g.positions[i * 3 + 2];
        pos[i * 3] = -mx; pos[i * 3 + 1] = mz; pos[i * 3 + 2] = my;
        const ax = g.normals[i * 3], ay = g.normals[i * 3 + 1], az = g.normals[i * 3 + 2];
        nrm[i * 3] = -ax; nrm[i * 3 + 1] = az; nrm[i * 3 + 2] = ay;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
      let mat;
      if (g.tex) {
        const tex = new THREE.DataTexture(g.tex.rgba, g.tex.w, g.tex.h, THREE.RGBAFormat);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        mat = new THREE.MeshLambertMaterial({
          map: tex, transparent: g.tex.masked, alphaTest: g.tex.masked ? 0.5 : 0, side: THREE.DoubleSide,
        });
      } else {
        mat = new THREE.MeshLambertMaterial({ color: 0x888888 });
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      inner.add(mesh);
    }
    // center + scale + orient like a held first-person weapon
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    inner.position.sub(center);
    const wrap = new THREE.Group();
    wrap.add(inner);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    wrap.scale.setScalar(0.8 / maxDim);
    wrap.rotation.set(this._vmEuler[0], this._vmEuler[1], this._vmEuler[2]);
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
    return inner;
  }

  select(name) {
    if (!this.weapons[name] || this.current === name) return;
    for (const k of Object.keys(this.weapons)) this.weapons[k].visible = (k === name);
    this.current = name;
  }

  // Subtle weapon bob proportional to movement speed.
  update(dt, speed) {
    this.bobT += dt * (4 + Math.min(speed, 1500) / 180);
    const amp = 0.006 + Math.min(speed, 1500) / 1500 * 0.012;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    // reload dip: lower + tilt the gun, peaking mid-reload
    let dip = 0;
    if (this.reloadT > 0) {
      this.reloadT = Math.max(0, this.reloadT - dt);
      dip = Math.sin(Math.PI * (1 - this.reloadT / this.reloadDur));
    }
    this.rig.position.y = this.baseY + Math.sin(this.bobT) * amp - this.recoil * 0.01 - dip * 0.14;
    this.rig.position.x = this.baseX + Math.cos(this.bobT * 0.5) * amp * 0.6;
    this.rig.position.z = this.baseZ + this.recoil * 0.05;
    this.rig.rotation.x = -this.recoil * 0.18 + dip * 0.5;
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
