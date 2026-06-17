# What it would take to actually release this

An honest, thorough assessment. Today this is a genuinely working browser surf
game with authentic GoldSrc movement, real maps, lightmaps, 6 weapons, and P2P
multiplayer. That is a great demo / "Show HN". It is **not** yet a thing you can
put on Steam or promote broadly without addressing the items below. They are
ordered roughly by how much they block a public launch.

---

## 1. Legal / licensing — the real blocker

This is the one that actually matters for a public release.

- **Counter-Strike assets are Valve's.** The weapon models (`v_*.mdl`), weapon
  sounds (`.wav`), the office skybox (`.tga`), and the `.bsp` maps are
  Counter-Strike / GoldSrc content. Bundling and serving them publicly is
  copyright infringement. Fine for a personal/educational project; not fine for
  a promoted product or anything monetised.
- **Community maps** (`surf_ski_2`, `surf_green`, `surf_egypt`, …) are made by
  individual mappers, usually with no clear redistribution license. Same issue.
- **What's already clean:** three.js (MIT), Trystero (MIT), Kenney prototype
  textures (CC0), Quaternius models (CC0), and all the original code here.

**To ship:** replace CS assets with original or CC0 equivalents (own weapon
models + sounds, CC0 skybox, original or permissively-licensed maps), **or** ship
the engine only and let users bring their own `.bsp`/`.wad` locally (the parser
already does the work; just don't host copyrighted files). A "load your own map"
button is the cleanest legal path and a nice feature.

---

## 2. Multiplayer: authority, anti-cheat, scale, connectivity

- **No authority = trivially cheatable.** Position, speed, and "I hit you" are
  all client-asserted. Fine for friends, unacceptable for ranked/public play.
  Real fix: an authoritative server (or an elected authoritative host) that
  simulates movement and validates hits. The physics is deterministic, which
  helps a lot here (server can re-simulate from inputs).
- **WebRTC mesh is O(n²).** Practical cap is ~8–12 players per room. Beyond that
  you need an SFU or a server relaying state.
- **NAT traversal.** WebRTC needs STUN, and symmetric NATs need **TURN** servers
  (which cost money/bandwidth). Without TURN some players simply can't connect.
- **Relay reliability.** Signaling rides public nostr relays; for production pin
  your own reliable relays (or run signaling yourself) and handle reconnects.
- **Netcode quality.** Add interpolation/extrapolation with a jitter buffer,
  lag compensation for hits, and snapshot rate tuning. Right now remote players
  are smoothed but basic.

---

## 3. Performance & compatibility

- **Use the BSP VIS data.** We render the whole level every frame. GoldSrc ships
  potentially-visible-set data; using it (plus the leaf the camera is in) would
  cut draw calls massively on big maps.
- **Lightmap atlas** can hit 4096²; verify on low-end / mobile GPUs and add a
  toggle. There's already a quality (pixel-ratio) slider; add a real
  low/medium/high preset (shadows, texture size, draw distance).
- **Handle WebGL context loss**, test Safari/iOS quirks, and provide a clear
  "your browser/GPU isn't supported" path.
- **Asset delivery:** lazy-load maps (don't ship all of them up front), show a
  real loading bar with progress, and rely on CDN brotli (Vercel does this).
- **Mobile perf** specifically: the touch build runs but needs profiling and
  probably reduced quality defaults.

---

## 4. Gameplay completeness

- **Timed runs need real start/finish zones** per map (the system is built; the
  zones aren't authored). Either hand-author them, auto-detect from common
  trigger naming, or add an in-game zone editor. Then global leaderboards (needs
  a backend) and ghost/replay racing (the deterministic physics makes this easy).
- **Player models.** Remote players are stylized capsules today (no CS player
  body models were available, and they'd be copyrighted anyway). Ship a CC0
  rigged character with basic run/air animation.
- **Game modes & flow:** surf race, deathmatch, KZ/bhop, with round/timer flow,
  spectate, and team support. Right now it's a freeform sandbox.
- **Spawn handling.** CS maps often spawn you in a holding/jail box that expects
  the map's own teleport flow. Pick spawns smartly per map (or let the player
  choose), and make "restart at start" reliable on every map.
- **Combat polish:** damage falloff, headshot multipliers, hit/kill sounds,
  death cam, scoreboard tab states.

---

## 5. UX / polish

- Keybind remapping, raw mouse input option, audio mix (master/sfx/music),
  viewmodel FOV/offset, sensitivity presets.
- Pause/escape menu, settings while in-game, reconnect UI, error toasts.
- Onboarding: surf is hard for newcomers; a 30-second "hold A + turn left"
  tutorial would dramatically help retention.
- Audio: footsteps, ambient, music, a proper sound mix.

---

## 6. Infrastructure / ops (if it grows past a static demo)

- A backend for: global leaderboards, profiles/auth, matchmaking, TURN,
  server-authoritative play, anti-cheat, telemetry + error reporting (Sentry),
  and analytics.
- "Steam" specifically: Steam wants a desktop build, so you'd wrap it
  (Electron/Tauri) and add achievements/cloud saves, or release as a web game on
  itch.io / Crazygames / Poki instead, which fits this far better.
- Domain, branding, privacy policy, and content moderation for player names /
  rooms.

---

## 7. QA

- Cross-browser/device matrix (Chrome/Firefox/Safari, desktop + iOS + Android).
- Netcode soak tests with real latency/jitter and many peers.
- Surf-feel playtesting with actual surfers (the bar is "does it feel like CS").
- Expand the automated tests (already: deterministic physics suite + a
  headless-WebGL smoke test) with per-map collision/spawn checks.

---

## TL;DR — minimum bar to "release publicly"

1. **Replace or stop hosting copyrighted CS assets** (biggest one), or pivot to
   "bring your own map".
2. **Authoritative netcode + TURN** if multiplayer is a headline feature.
3. **VIS culling + quality presets** so it runs on normal hardware/phones.
4. **One polished game mode** (timed surf race with leaderboards) end to end.
5. **Loading/error/reconnect UX** and onboarding.

Everything else (player models, more modes, replays) is upside on top of that.
