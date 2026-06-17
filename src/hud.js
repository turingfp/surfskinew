// HUD: speed/state, ammo, vitals, timer + personal bests, players, dynamic
// crosshair, and toast messages. Pure DOM; updated each render frame.

export class HUD {
  constructor(root = document) {
    this.r = root;
    this.el = {};
    for (const id of ['spd', 'spdbar', 'movestate', 'flags', 'timer', 'best', 'peak', 'pbspeed',
      'peercount', 'pos', 'health', 'armor', 'wname', 'clip', 'reserve', 'reloadmsg',
      'runstate', 'mapname', 'toast', 'hitmarker']) {
      this.el[id] = root.getElementById(id);
    }
    this.peak = 0;
    this._toastT = 0;
    this._hitT = 0;
    this._fireBump = 0;
  }

  setMap(name) { if (this.el.mapname) this.el.mapname.textContent = name; }

  toast(msg, color) {
    const t = this.el.toast; if (!t) return;
    t.textContent = msg;
    if (color) t.style.color = color;
    t.style.opacity = '1';
    this._toastT = 1.8;
  }

  hitMarker() { this._hitT = 0.12; }
  bumpCrosshair() { this._fireBump = 14; }

  update(d) {
    const speed = d.speed || 0;
    if (speed > this.peak) this.peak = speed;
    const set = (id, v) => { const e = this.el[id]; if (e) e.textContent = v; };

    set('spd', Math.round(speed));
    if (this.el.spdbar) {
      const frac = Math.min(speed / 2200, 1);
      this.el.spdbar.style.width = `${frac * 100}%`;
      this.el.spdbar.style.background = `hsl(${220 - frac * 220} 90% 55%)`;
    }
    if (this.el.movestate) {
      const s = d.inWater ? 'WATER' : d.onLadder ? 'LADDER' : d.surfing ? 'SURFING' : d.onground ? 'GROUND' : 'AIR';
      this.el.movestate.textContent = s;
      this.el.movestate.className = s.toLowerCase();
    }
    if (this.el.flags) {
      const f = []; if (d.autohop) f.push('AUTOHOP'); if (d.noclip) f.push('NOCLIP'); if (d.cp) f.push('CP');
      this.el.flags.textContent = f.join('  ');
    }
    set('timer', fmtTime(d.time));
    set('best', d.best != null ? fmtTime(d.best) : '--:--.--');
    set('peak', Math.round(this.peak));
    set('pbspeed', Math.round(d.pbspeed || 0));
    set('peercount', d.players || 1);
    if (this.el.pos && d.origin) set('pos', `${d.origin[0].toFixed(0)} ${d.origin[1].toFixed(0)} ${d.origin[2].toFixed(0)}`);
    set('health', d.health != null ? d.health : 100);
    set('armor', d.armor != null ? d.armor : 100);
    set('runstate', d.runstate || 'ready');

    if (d.ammo) {
      set('wname', d.ammo.label);
      set('clip', d.ammo.clip);
      set('reserve', d.ammo.reserve);
      set('reloadmsg', d.ammo.reloading ? 'RELOADING…' : (d.ammo.clip === 0 ? 'PRESS R' : ''));
    }

    // dynamic crosshair gap from speed + fire bump
    const dt = d.dt || 0.016;
    this._fireBump = Math.max(0, this._fireBump - dt * 80);
    const gap = 5 + Math.min(speed / 90, 26) + this._fireBump;
    document.documentElement.style.setProperty('--xgap', `${gap.toFixed(1)}px`);

    if (this._toastT > 0) { this._toastT -= dt; if (this._toastT <= 0 && this.el.toast) this.el.toast.style.opacity = '0'; }
    if (this._hitT > 0) { this._hitT -= dt; if (this.el.hitmarker) this.el.hitmarker.style.opacity = this._hitT > 0 ? '1' : '0'; }
  }
}

function fmtTime(t) {
  if (t == null) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
