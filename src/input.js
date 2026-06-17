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
    this.chatting = false; // chat box open: suppress look + movement
    this.weapon = 'usp';
    // touch state
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (this.isTouch) this.autohop = true; // chaining bhops/surf by tapping is impractical on mobile
    this._tMove = { id: null, ox: 0, oy: 0, fx: 0, fy: 0 };
    // Look pad is rate-based: holding the finger offset from where it landed
    // keeps turning (the sustained smooth turn surfing needs), instead of
    // stopping the instant a delta-drag pauses.
    this._tLook = { id: null, ax: 0, ay: 0, dx: 0, dy: 0 };
    this.tJump = false; this.tDuck = false;
    this._onActive = [];
    this._onRespawn = [];
    this._onReload = [];
    this._onCheckpoint = [];
    this._onUse = [];
    this._onChat = [];
  }

  attach(canvas) {
    this.canvas = canvas;

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      // If the user pressed Esc to release the lock, pause back to the overlay
      // (but not when we released it on purpose to open the chat box).
      if (!this.locked && this.active && this._wasLocked && !this.chatting) this.stop();
      this._wasLocked = this.locked;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.active || this.chatting) return;
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

  // Virtual joystick (left half = move) + rate-based look pad (right half) +
  // buttons. The joystick anchors where the thumb lands and follows it; the
  // look pad turns continuously while held off-centre (so a surf turn can be
  // sustained with one steady thumb rather than repeated swipes).
  _setupTouch(canvas) {
    const layer = document.getElementById('touch');
    if (layer) layer.style.display = 'block';
    const half = () => window.innerWidth / 2;
    const R = 64;          // joystick max throw (px) — larger = finer control
    const stick = document.getElementById('t-stickhint');
    const dot = stick && stick.querySelector('.dot');
    const placeStick = (x, y) => { if (stick) { stick.style.left = (x - 60) + 'px'; stick.style.top = (y - 60) + 'px'; stick.style.bottom = 'auto'; } };
    const moveDot = (dx, dy) => { if (dot) dot.style.transform = `translate(${dx}px,${dy}px)`; };

    const onStart = (e) => {
      if (!this.active) this.start();
      for (const t of e.changedTouches) {
        if (t.target && t.target.dataset && t.target.dataset.btn) continue; // buttons handle themselves
        if (t.clientX < half() && this._tMove.id == null) {
          this._tMove.id = t.identifier; this._tMove.ox = t.clientX; this._tMove.oy = t.clientY; this._tMove.fx = 0; this._tMove.fy = 0;
          placeStick(t.clientX, t.clientY); moveDot(0, 0);
          if (stick) stick.style.opacity = '0.9';
        } else if (this._tLook.id == null) {
          this._tLook.id = t.identifier; this._tLook.ax = t.clientX; this._tLook.ay = t.clientY; this._tLook.dx = 0; this._tLook.dy = 0;
        }
      }
      e.preventDefault();
    };
    const onMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._tMove.id) {
          let dx = t.clientX - this._tMove.ox, dy = t.clientY - this._tMove.oy;
          const len = Math.hypot(dx, dy);
          if (len > R) { dx *= R / len; dy *= R / len; } // clamp thumb to ring
          moveDot(dx, dy);
          let fx = Math.max(-1, Math.min(1, dx / R));
          let fy = Math.max(-1, Math.min(1, dy / R));
          // Surf aid: snap a clearly dominant axis to a pure strafe / pure
          // forward "lane" so air-strafing holds a clean ±side with no drift.
          if (Math.abs(fx) > Math.abs(fy) * 2) fy = 0;
          else if (Math.abs(fy) > Math.abs(fx) * 2) fx = 0;
          this._tMove.fx = fx; this._tMove.fy = fy;
        } else if (t.identifier === this._tLook.id) {
          this._tLook.dx = t.clientX - this._tLook.ax;
          this._tLook.dy = t.clientY - this._tLook.ay;
        }
      }
      e.preventDefault();
    };
    const onEnd = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this._tMove.id) { this._tMove.id = null; this._tMove.fx = 0; this._tMove.fy = 0; moveDot(0, 0); if (stick) stick.style.opacity = '0.5'; }
        if (t.identifier === this._tLook.id) { this._tLook.id = null; this._tLook.dx = 0; this._tLook.dy = 0; }
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

  // Apply the touch look pad's continuous turn rate. Called once per rendered
  // frame with the frame's dt so turning speed is framerate-independent. The
  // further the thumb is held from where it landed, the faster the view turns;
  // a small deadzone keeps a resting thumb from drifting.
  tickLook(dt) {
    if (this._tLook.id == null || !this.active || this.chatting) return;
    const dead = 7; // px
    const rate = this.sensitivity * 16; // rad/sec per px, scaled by the sens slider
    const dx = this._tLook.dx, dy = this._tLook.dy;
    if (Math.abs(dx) > dead) this.yaw -= (dx - Math.sign(dx) * dead) * rate * dt;
    if (Math.abs(dy) > dead) this.pitch += (dy - Math.sign(dy) * dead) * rate * dt * (this.invertY ? -1 : 1);
    const lim = (89 * Math.PI) / 180;
    if (this.pitch > lim) this.pitch = lim;
    if (this.pitch < -lim) this.pitch = -lim;
    const TwoPi = Math.PI * 2;
    if (this.yaw > Math.PI) this.yaw -= TwoPi;
    if (this.yaw < -Math.PI) this.yaw += TwoPi;
  }

  onActiveChange(fn) { this._onActive.push(fn); }
  onRespawn(fn) { this._onRespawn.push(fn); }
  onReload(fn) { this._onReload.push(fn); }
  onCheckpoint(fn) { this._onCheckpoint.push(fn); }
  onUse(fn) { this._onUse.push(fn); }
  onChat(fn) { this._onChat.push(fn); }
  onBlocked(fn) { this._onBlocked = fn; }

  // Open/close the chat box: free the mouse + suppress look/move while typing.
  setChatting(on) {
    this.chatting = on;
    if (on) {
      this.keys = Object.create(null); // drop any held movement keys
      if (document.exitPointerLock) { try { document.exitPointerLock(); } catch { /* ignore */ } }
    } else if (this.active) {
      this._requestLock();
    }
  }
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
    if (down && this.active && (code === 'KeyY' || code === 'KeyT')) { this._onChat.forEach((f) => f()); e.preventDefault(); return; }
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
    // While typing in chat, hold position (no move, no new look this tick).
    if (this.chatting) return { forwardmove: 0, sidemove: 0, yaw: this.yaw, pitch: this.pitch, jump: false, duck: false };
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
