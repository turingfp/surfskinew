// GoldSrc / Counter-Strike 1.6 movement constants.
// Values taken from Valve's pm_shared.c and the Quake QW pmove lineage,
// as restated in the project spec (assets/surf_clone_prompt.json).
//
// Everything here is in GoldSrc units (1 unit ~= 1 inch) and seconds.
// The course / collision geometry comes from surf_ski_2.bsp, which is a
// real GoldSrc v30 BSP, so all numbers below are the authentic engine values.

export const CVAR = {
  sv_gravity: 800,
  sv_friction: 4,
  sv_stopspeed: 100,
  sv_accelerate: 5, // ground accel
  // Surf servers run a high airaccelerate; the spec's map tuning uses 100.
  sv_airaccelerate: 100,
  sv_maxspeed: 320,
  // Raised velocity cap so good strafes are not clipped (surf tuning).
  sv_maxvelocity: 3500,
  sv_stepsize: 18,
  sv_bounce: 1.0,
};

// Hardcoded clamp on wishspeed inside AirAccelerate. Source names this
// sv_air_max_wishspeed = 30. THE single most important number for strafe gain.
export const AIR_WISHSPEED_CAP = 30;

// If a surface normal.z is below this the surface is too steep to stand on:
// the player stays airborne (air physics, no friction). acos(0.7) ~= 45.57 deg.
// Surf ramps must exceed this angle. This is what makes ramps "surf".
export const GROUND_NORMAL_Z = 0.7;

// After clipping, any velocity axis below this magnitude is zeroed.
export const STOP_EPSILON = 0.1;

// overbounce = 1 + sv_bounce*(1 - surface_friction); friction 1 => 1.0 (clean slide)
export const OVERBOUNCE = 1.0;

export const MAX_CLIP_PLANES = 5;
export const NUM_BUMPS = 4;

// Player hulls. Standing maps to BSP clip hull 1, ducking to clip hull 3.
export const HULL = {
  STAND: { mins: [-16, -16, -36], maxs: [16, 16, 36], hullIndex: 1, viewZ: 17 },
  DUCK: { mins: [-16, -16, -18], maxs: [16, 16, 18], hullIndex: 3, viewZ: 12 },
};

// Jump impulse: sqrt(2*g*h) for a 45-unit jump ~= 268.3 ups.
export const JUMP_HEIGHT = 45;

// Fixed physics timestep (decoupled from render). 100 Hz => dt = 0.01.
export const PHYSICS_HZ = 100;
export const FIXED_DT = 1 / PHYSICS_HZ;

// Player movement key speeds before wishspeed is clamped to sv_maxspeed.
// CS uses cl_forwardspeed/cl_sidespeed = 400; PM clamps the result to maxspeed.
export const FORWARD_SPEED = 400;
export const SIDE_SPEED = 400;

// BSP leaf contents values (negative children in clip nodes).
export const CONTENTS = {
  EMPTY: -1,
  SOLID: -2,
  WATER: -3,
  SLIME: -4,
  LAVA: -5,
  SKY: -6,
  TRANSLUCENT: -15,
  LADDER: -16,
};

// Epsilon used while walking the clip-node BSP (Quake's 1/32 unit).
export const DIST_EPSILON = 0.03125;
