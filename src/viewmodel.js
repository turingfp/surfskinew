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
    // bottom-right placement in view space (camera looks down -Z)
    this.baseX = 0.2; this.baseY = -0.2;
    this.rig.position.set(this.baseX, this.baseY, -0.46);
    this.scene.add(this.rig);

    this.weapons = {};
    this.current = null;
    this.bobT = 0;
    this.recoil = 0; // 0..1, decays; kicks the gun back + up when firing
    this._vmEuler = [-Math.PI / 2, 0.5, 0]; // orientation for MDL view models (tuned)
  }

  // Re-orient all loaded MDL weapons (used to tune the view-model orientation).
  setVMEuler(x, y, z) {
    this._vmEuler = [x, y, z];
    for (const w of Object.values(this.weapons)) if (w.rotation) w.rotation.set(x, y, z);
  }

  kick(amount = 0.6) { this.recoil = Math.min(1.4, this.recoil + amount); }

  // Load real CS 1.6 StudioModel (.mdl) view models.
  async loadMDLWeapons(map) {
    for (const [name, url] of Object.entries(map)) {
      try {
        const data = await loadMDL(url);
        const weapon = this._makeMDLWeapon(data);
        weapon.visible = false;
        this.rig.add(weapon);
        this.weapons[name] = weapon;
      } catch (e) {
        console.warn(`[viewmodel] MDL load failed ${name}:`, e.message || e);
      }
    }
    const first = Object.keys(this.weapons)[0];
    if (first) this.select(first);
    return Object.keys(this.weapons);
  }

  _makeMDLWeapon(data) {
    const inner = new THREE.Group();
    for (const g of data.groups) {
      // Build in raw model coords; orientation is applied via the wrap group
      // rotation below (see _vmEuler), tuned to the GoldSrc view-model axes.
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
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
    wrap.scale.setScalar(0.5 / maxDim);
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
    this.rig.position.y = this.baseY + Math.sin(this.bobT) * amp - this.recoil * 0.01;
    this.rig.position.x = this.baseX + Math.cos(this.bobT * 0.5) * amp * 0.6;
    this.rig.position.z = -0.46 + this.recoil * 0.05;     // kick toward the camera
    this.rig.rotation.x = -this.recoil * 0.18;            // muzzle rises
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
