// Weapon viewmodel — a classic CS touch. Loads CC0 Quaternius gun models
// (poly.pizza) and renders them in a dedicated overlay pass so the close-up
// weapon isn't clipped by the world's near plane or its huge unit scale.

import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/jsm/loaders/GLTFLoader.js';

export class Viewmodel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(0.6, 1.0, 0.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x99bbff, 0.5);
    fill.position.set(-0.8, 0.2, 0.4);
    this.scene.add(fill);

    this.rig = new THREE.Group();
    // bottom-right placement in view space (camera looks down -Z)
    this.baseX = 0.2; this.baseY = -0.2;
    this.rig.position.set(this.baseX, this.baseY, -0.46);
    this.scene.add(this.rig);

    this.weapons = {};
    this.current = null;
    this.bobT = 0;
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
    inner.scale.setScalar(0.34 / maxDim);
    // Orient like a held weapon: aim into the screen with a slight inward yaw.
    inner.rotation.set(0, Math.PI + 0.28, 0);
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
    this.rig.position.y = this.baseY + Math.sin(this.bobT) * amp;
    this.rig.position.x = this.baseX + Math.cos(this.bobT * 0.5) * amp * 0.6;
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
