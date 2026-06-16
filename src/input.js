// Mouse-look + keyboard input, producing a GoldSrc-style usercmd each physics
// tick. View angles update at render rate; movement keys are sampled when the
// physics step runs.
//
// "Active" (playing) state is decoupled from Pointer Lock: clicking starts the
// game and we *try* to grab pointer lock, but mouse-look uses movementX/Y while
// active regardless, so the game still works when pointer lock is unavailable
// (e.g. embedded in an iframe/preview without the pointer-lock permission).

import { FORWARD_SPEED, SIDE_SPEED } from './constants.js';

export class Input {
  constructor() {
    this.keys = Object.create(null);
    this.yaw = 0;       // radians, +yaw turns left (toward +Y)
    this.pitch = 0;     // radians, clamped to +/-89 deg
    this.sensitivity = 0.0022; // radians per mouse pixel
    this.invertY = false;      // mouse-up looks up by default
    this.active = false;       // game is in play (overlay hidden)
    this.locked = false;       // pointer lock is actually held
    this.autohop = false;
    this.noclip = false;
    this.weapon = 'pistol';
    this._onActive = [];
    this._onRespawn = [];
  }

  attach(canvas) {
    this.canvas = canvas;

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      // If the user pressed Esc to release the lock, pause back to the overlay.
      if (!this.locked && this.active && this._wasLocked) this.stop();
      this._wasLocked = this.locked;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      this.yaw -= e.movementX * this.sensitivity;
      // +pitch looks down in our convention, so mouse-up (movementY<0) must
      // increase-toward-up => pitch += movementY for the non-inverted default.
      this.pitch += e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
      const lim = (89 * Math.PI) / 180;
      if (this.pitch > lim) this.pitch = lim;
      if (this.pitch < -lim) this.pitch = -lim;
      const TwoPi = Math.PI * 2;
      if (this.yaw > Math.PI) this.yaw -= TwoPi;
      if (this.yaw < -Math.PI) this.yaw += TwoPi;
    });

    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    // Releasing the tab/window pauses to avoid stuck keys.
    window.addEventListener('blur', () => { this.keys = Object.create(null); });
  }

  // Begin play (or re-grab pointer lock): hide overlay and try to lock.
  start() {
    this.active = true;
    this._fireActive();
    this._requestLock();
  }

  // Pause: release pointer lock and show the overlay again.
  stop() {
    if (!this.active) return;
    this.active = false;
    if (document.exitPointerLock) { try { document.exitPointerLock(); } catch { /* ignore */ } }
    this._fireActive();
  }

  _requestLock() {
    if (!this.canvas || !this.canvas.requestPointerLock) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => { /* lock unavailable; fallback look still works */ });
    } catch { /* lock unavailable */ }
  }

  onActiveChange(fn) { this._onActive.push(fn); }
  onRespawn(fn) { this._onRespawn.push(fn); }
  _fireActive() { this._onActive.forEach((f) => f(this.active)); }

  _key(e, down) {
    const code = e.code;
    if (down && code === 'Escape') { this.stop(); return; }
    // Not playing yet? Any key (Enter/Space/etc.) starts — a reliable path that
    // doesn't depend on the click reaching the canvas or pointer lock working.
    if (down && !this.active && code !== 'Escape') {
      this.start();
      if (code === 'Enter' || code === 'Space') { e.preventDefault(); return; }
    }
    if (down && code === 'KeyB') this.autohop = !this.autohop;
    if (down && code === 'KeyV') this.noclip = !this.noclip;
    if (down && code === 'KeyR') this._onRespawn.forEach((f) => f());
    if (down && code === 'Digit1') this.weapon = 'pistol';
    if (down && code === 'Digit2') this.weapon = 'rifle';
    if (down && code === 'Digit3') this.weapon = 'shotgun';
    this.keys[code] = down;
    if (this.active && (code === 'Space' || code.startsWith('Arrow'))) e.preventDefault();
  }

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
