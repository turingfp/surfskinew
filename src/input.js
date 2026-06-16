// Mouse-look (pointer lock) + keyboard input, producing a GoldSrc-style
// usercmd each physics tick. View angles update at render rate; movement keys
// are sampled when the physics step runs.

import { FORWARD_SPEED, SIDE_SPEED } from './constants.js';

export class Input {
  constructor() {
    this.keys = Object.create(null);
    this.yaw = 0;       // radians, +yaw turns left (toward +Y)
    this.pitch = 0;     // radians, clamped to +/-89 deg
    this.sensitivity = 0.0022; // radians per mouse pixel
    this.locked = false;
    this.autohop = false;
    this.noclip = false;
    this.weapon = 'pistol';
    this._onLockChange = [];
    this._onRespawn = [];
  }

  attach(canvas) {
    this.canvas = canvas;
    canvas.addEventListener('click', () => {
      if (!this.locked) canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this._onLockChange.forEach((f) => f(this.locked));
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      const lim = (89 * Math.PI) / 180;
      if (this.pitch > lim) this.pitch = lim;
      if (this.pitch < -lim) this.pitch = -lim;
      // keep yaw in a sane range
      const TwoPi = Math.PI * 2;
      if (this.yaw > Math.PI) this.yaw -= TwoPi;
      if (this.yaw < -Math.PI) this.yaw += TwoPi;
    });
    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
  }

  onLockChange(fn) { this._onLockChange.push(fn); }
  onRespawn(fn) { this._onRespawn.push(fn); }

  _key(e, down) {
    const code = e.code;
    // toggles fire on keydown only
    if (down && code === 'KeyB') this.autohop = !this.autohop;
    if (down && code === 'KeyV') this.noclip = !this.noclip;
    if (down && code === 'KeyR') this._onRespawn.forEach((f) => f());
    if (down && code === 'Digit1') this.weapon = 'pistol';
    if (down && code === 'Digit2') this.weapon = 'rifle';
    if (down && code === 'Digit3') this.weapon = 'shotgun';
    this.keys[code] = down;
    // prevent the page from scrolling on space / arrows while playing
    if (this.locked && (code === 'Space' || code.startsWith('Arrow'))) e.preventDefault();
  }

  // Build the per-tick command from current key + look state.
  command() {
    const k = this.keys;
    let fmove = 0, smove = 0;
    if (k['KeyW'] || k['ArrowUp']) fmove += FORWARD_SPEED;
    if (k['KeyS'] || k['ArrowDown']) fmove -= FORWARD_SPEED;
    if (k['KeyD'] || k['ArrowRight']) smove += SIDE_SPEED;
    if (k['KeyA'] || k['ArrowLeft']) smove -= SIDE_SPEED;
    return {
      forwardmove: fmove,
      sidemove: smove,
      yaw: this.yaw,
      pitch: this.pitch,
      jump: !!k['Space'],
      duck: !!(k['ShiftLeft'] || k['ControlLeft'] || k['KeyC']),
    };
  }
}
