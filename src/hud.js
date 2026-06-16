// Lightweight DOM HUD: speedometer, run timer, movement state, and a speed
// graph. All updates are pushed from the render loop; no per-frame allocation
// of DOM nodes.

export class HUD {
  constructor(root = document) {
    this.speedEl = root.getElementById('speed');
    this.stateEl = root.getElementById('movestate');
    this.timerEl = root.getElementById('timer');
    this.peakEl = root.getElementById('peak');
    this.posEl = root.getElementById('pos');
    this.flagsEl = root.getElementById('flags');
    this.bar = root.getElementById('speedbar');
    this.peak = 0;
  }

  update({ speed, onground, surfing, time, origin, autohop, noclip }) {
    if (speed > this.peak) this.peak = speed;
    if (this.speedEl) this.speedEl.textContent = Math.round(speed);
    if (this.bar) {
      // colour the speed bar: blue (slow) -> green -> yellow -> red (fast)
      const frac = Math.min(speed / 2000, 1);
      this.bar.style.width = `${frac * 100}%`;
      const hue = 220 - frac * 220; // 220 (blue) down to 0 (red)
      this.bar.style.background = `hsl(${hue} 90% 55%)`;
    }
    if (this.stateEl) {
      this.stateEl.textContent = surfing ? 'SURFING' : onground ? 'GROUND' : 'AIR';
      this.stateEl.className = surfing ? 'surf' : onground ? 'ground' : 'air';
    }
    if (this.timerEl) this.timerEl.textContent = fmtTime(time);
    if (this.peakEl) this.peakEl.textContent = Math.round(this.peak);
    if (this.posEl && origin) {
      this.posEl.textContent = `${origin[0].toFixed(0)} ${origin[1].toFixed(0)} ${origin[2].toFixed(0)}`;
    }
    if (this.flagsEl) {
      const f = [];
      if (autohop) f.push('AUTOHOP');
      if (noclip) f.push('NOCLIP');
      this.flagsEl.textContent = f.join('  ');
    }
  }
}

function fmtTime(t) {
  if (t == null) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
