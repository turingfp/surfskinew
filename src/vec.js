// Minimal 3-vector helpers (arrays [x,y,z]) used by the physics and trace code.
// Kept allocation-light where it matters; clarity first.

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const mad = (a, s, b) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]]; // a + s*b
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const length2d = (a) => Math.hypot(a[0], a[1]);
export const copy = (a) => [a[0], a[1], a[2]];

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function normalize(a) {
  const len = length(a);
  if (len < 1e-9) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

// GoldSrc AngleVectors with roll = 0. angles in radians: pitch (x), yaw (z).
// Returns forward / right / up basis. Z-up, right-handed.
export function angleVectors(pitch, yaw) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const forward = [cp * cy, cp * sy, -sp];
  const right = [sy, -cy, 0];          // roll=0 simplification
  const up = [sp * cy, sp * sy, cp];
  return { forward, right, up };
}
