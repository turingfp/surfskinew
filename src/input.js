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
    this.cheats = false; // noclip + checkpoint teleport only in a custom room
    this.scoreboard = false;
    this.weapon = 'usp';
    // touch state
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.touchSens = 0.005;
    this._tMove = { id: null, fx: 0, fy: 0 };
    this._tLook = { id: null, x: 0, y: 0 };
    this.tJump = false; this.tDuck = false;
    this._onActive = [];
    this._onRespawn = [];
    this._onReload = [];
    this._onCheckpoint = [];
    this._onUse = [];
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

    // Mouse buttons: left = attack. Also (re)acquire pointer lock if needed.
    document.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      if (e.button === 0) this.attack = true;
      if (e.button === 2) this.attack2 = true;
      if (!this.locked) this._requestLock();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.attack = false;
      if (e.button === 2) this.attack2 = false;
    });
    // Don't pop the context menu on right-click while playing.
    canvas.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); });
    // Releasing the tab/window pauses to avoid stuck keys.
    window.addEventListener('blur', () => { this.keys = Object.create(null); });

    if (this.isTouch) this._setupTouch(canvas);
  }

  // Virtual joystick (left half = move) + drag-to-look (right half) + buttons.
  _setupTouch(canvas) {
    const layer = document.getElementById('touch');
    if (layer) layer.style.display = 'block';
    const half = () => window.innerWidth / 2;

    const onStart = (e) => {
      if (!this.active) this.start();
      for (const t of e.changedTouches) {
        if (t.target && t.target.dataset && t.target.dataset.btn) continue; // buttons handle themselves
        if (t.clientX < half() && this._tMove.id == null) {
          this._tMove.id = t.identifier; this._tMove.ox = t.clientX; this._tMove.oy = t.clientY; this._tMove.fx = 0; this._tMove.fy = 0;
        } else if (this._tLook.id == null) {
          this._tLook.id = t.identifier; this._tLook.x = t.clientX; this._tLook.y = t.clientY;
        }
      }
      e.preventDefault();
    };
    const onMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._tMove.id) {
          const dx = t.clientX - this._tMove.ox, dy = t.clientY - this._tMove.oy;
          this._tMove.fx = Math.max(-1, Math.min(1, dx / 55));
          this._tMove.fy = Math.max(-1, Math.min(1, dy / 55));
        } else if (t.identifier === this._tLook.id) {
          this.yaw -= (t.clientX - this._tLook.x) * this.touchSens;
          this.pitch += (t.clientY - this._tLook.y) * this.touchSens * (this.invertY ? -1 : 1);
          const lim = (89 * Math.PI) / 180;
          this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
          this._tLook.x = t.clientX; this._tLook.y = t.clientY;
        }
      }
      e.preventDefault();
    };
    const onEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._tMove.id) { this._tMove.id = null; this._tMove.fx = 0; this._tMove.fy = 0; }
        if (t.identifier === this._tLook.id) this._tLook.id = null;
      }
    };
    canvas.addEventListener('touchstart', onStart, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onEnd);
    canvas.addEventListener('touchcancel', onEnd);

    // on-screen buttons
    const hold = (id, on, off) => {
      const el = document.getElementById(id); if (!el) return;
      const d = (e) => { e.preventDefault(); e.stopPropagation(); on(); };
      const u = (e) => { e.preventDefault(); e.stopPropagation(); if (off) off(); };
      el.addEventListener('touchstart', d, { passive: false });
      el.addEventListener('touchend', u); el.addEventListener('touchcancel', u);
    };
    hold('t-fire', () => { this.attack = true; }, () => { this.attack = false; });
    hold('t-jump', () => { this.tJump = true; }, () => { this.tJump = false; });
    hold('t-duck', () => { this.tDuck = true; }, () => { this.tDuck = false; });
    hold('t-reload', () => { this._onReload.forEach((f) => f()); });
    hold('t-weapon', () => {
      const order = ['usp', 'deagle', 'm4a1', 'ak47', 'awp', 'm3'];
      this.weapon = order[(order.indexOf(this.weapon) + 1) % order.length];
    });
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
  onReload(fn) { this._onReload.push(fn); }
  onCheckpoint(fn) { this._onCheckpoint.push(fn); }
  onUse(fn) { this._onUse.push(fn); }
  onBlocked(fn) { this._onBlocked = fn; }
  setCheats(on) { this.cheats = on; if (!on) this.noclip = false; }
  _fireActive() { this._onActive.forEach((f) => f(this.active)); }

  _key(e, down) {
    // Ignore game keys while typing in a form field (e.g. the room name).
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    const code = e.code;
    if (code === 'Tab') { this.scoreboard = down; if (this.active) e.preventDefault(); return; }
    if (down && code === 'Escape') { this.stop(); return; }
    // Not playing yet? Any key (Enter/Space/etc.) starts — a reliable path that
    // doesn't depend on the click reaching the canvas or pointer lock working.
    if (down && !this.active && code !== 'Escape') {
      this.start();
      if (code === 'Enter' || code === 'Space') { e.preventDefault(); return; }
    }
    if (down && code === 'KeyB') this.autohop = !this.autohop;
    if (down && code === 'KeyV') { if (this.cheats) this.noclip = !this.noclip; else this._onBlocked?.('noclip'); }
    if (down && code === 'KeyR') this._onReload.forEach((f) => f());
    if (down && code === 'KeyE') this._onUse.forEach((f) => f());
    if (down && (code === 'KeyU' || code === 'Backspace')) this._onRespawn.forEach((f) => f());
    if (down && code === 'KeyC' && this.cheats) this._onCheckpoint.forEach((f) => f('save'));
    if (down && code === 'KeyX') { if (this.cheats) this._onCheckpoint.forEach((f) => f('load')); else this._onBlocked?.('teleport'); }
    const wk = { Digit1: 'usp', Digit2: 'deagle', Digit3: 'm4a1', Digit4: 'ak47', Digit5: 'awp', Digit6: 'm3' };
    if (down && wk[code]) this.weapon = wk[code];
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
    // touch joystick (up = forward)
    if (this._tMove.id != null) { fmove += -this._tMove.fy * FORWARD_SPEED; smove += this._tMove.fx * SIDE_SPEED; }
    return {
      forwardmove: Math.max(-FORWARD_SPEED, Math.min(FORWARD_SPEED, fmove)),
      sidemove: Math.max(-SIDE_SPEED, Math.min(SIDE_SPEED, smove)),
      yaw: this.yaw,
      pitch: this.pitch,
      jump: !!k['Space'] || this.tJump,
      duck: !!(k['ShiftLeft'] || k['ControlLeft']) || this.tDuck,
    };
  }
}
