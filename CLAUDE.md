# CLAUDE.md

Guidance for AI agents working in this repo. Read this before touching `src/viewmodel.js` or pushing to `main`.

## First-person weapon viewmodel (`src/viewmodel.js`)

**This has regressed multiple times.** Every previous "fix" (bbox-centering the
gun, normalizing its size, hand-tuning per-weapon Euler angles, nudging a
corner offset) produced a small floating gun that looked like it was "coming
in from the right edge" instead of being held. Do not re-introduce any of
that pipeline. If the weapon ever looks wrong again, re-derive the fix from
the invariant below — don't reach for another offset tweak.

### The invariant

GoldSrc `v_*.mdl` weapon view models are **authored in eye space**: the
model's origin *is* the player's eyeball, and the original CS artists placed
the gun/hands/arms exactly where they should appear from that eye (grip low
and to the right, barrel foreshortened toward the crosshair, stock near the
face). The real GoldSrc engine renders these with **no transform beyond the
camera/FOV** — that's the entire trick that makes a viewmodel read as "held."

Consequences for our renderer:
- **Do not bbox-center the geometry.** Centering discards the authored
  eye-relative placement and turns a held weapon into a floating prop.
- **Do not per-weapon size-normalize** (e.g. scaling every gun to the same
  bounding-box dimension). That's why a USP used to render as big as an AWP.
  Only a single **shared** unit-conversion scale is allowed (`VM_SCALE`) —
  it's applied uniformly about the eye, so it doesn't change projection, and
  it preserves the models' authored relative sizes.
- **Do not hand-rotate per weapon** (no `VM_EULER` tables). If the pose looks
  wrong, the bug is almost always in the **axis remap** (`remapVM`), not in
  needing a per-weapon fudge rotation on top.
- **The rig sits at the camera origin** (`baseX/baseY/baseZ = 0`). Bob,
  recoil, and reload dip are small excursions *around* that origin, not a
  base offset into some screen corner.
- **Axis remap**: GoldSrc's player frame is forward `+X`, left `+Y`, up `+Z`
  (baked into the sequence bone transforms). Three.js camera space is right
  `+X`, up `+Y`, forward `-Z`. The correct remap is
  `(x, y, z) -> (-y, z, -x)`. Getting the sign/axis wrong here silently
  points the barrel the wrong way and is the single most common cause of
  "the gun is coming from the wrong side."
- **Viewmodel camera FOV** should match CS's `default_fov 90` (horizontal,
  4:3) expressed as three.js's *vertical* FOV (~73.7°). A narrower FOV
  (e.g. 50°) looks telephoto-flat and kills the foreshortening that reads as
  "held forward."

### How to verify a change here (don't eyeball it in your head)

This is a headless-renderable browser app. Boot it with Playwright, jump the
player above the map (open sky, nothing occluding), select each weapon, and
screenshot:

```js
// against sky, avoids world geometry cluttering the shot
const s = window.__surf;
const mn = s.worldMins, mx = s.worldMaxs;
s.setState([(mn[0]+mx[0])/2, (mn[1]+mx[1])/2, mx[2]+2000], [0,0,0]);
s.setLook(0, 0.35);
s.selectWeapon('awp'); // or ak47, m4a1, m3, usp, deagle, ...
```
`window.__surf` exposes `ready`, `vmReady()`, `viewmodel` (test hook),
`setVMEuler`, `selectWeapon`, `worldMins`/`worldMaxs`, `setState`, `setLook`.
Wait for `vmReady()` before selecting weapons (MDL loads are async).
`tools/capture.mjs` has a working Playwright boot sequence to copy from
(local Chromium at `/opt/pw-browsers/chromium-*/chrome-linux/chrome` if
`playwright install` can't reach the network).

Check the actual screenshot pixels, not just "does it render without
errors." The bug class here is entirely about screen-space placement/pose,
which only shows up visually — it will never show up in a unit test.

## Git / branches

- The default branch is `main`. It has genuinely moved forward with real
  work (weapon rendering, AI bots, player animations) — verify with
  `git log --oneline` before assuming a stale local branch or an old PR's
  base is still current. A branch created earlier in a session may already
  be far behind `main` by the time you push.
- Before pushing to `main` or force-pushing anything, diff against what's
  actually there (`git log --oneline HEAD..origin/main` and vice versa).
  If `main` has diverged with unrelated newer commits, do not force-push
  over it — rebase/re-derive the fix on top of current `main` instead.
- Prefer small, focused commits directly documenting *why* (not just what)
  for anything touching `viewmodel.js`, since the reasoning here is easy to
  accidentally re-break.
