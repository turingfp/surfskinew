# how it works

a little writeup for the curious. it is counter-strike 1.6 surf, running in a
browser tab, no plugins, no install, no game engine. you click play and you are
sliding down ramps.

## the short version

it loads a real goldsrc .bsp map file (the same format half-life and cs 1.6
used), parses it in javascript, rebuilds the geometry for webgl with three.js,
and runs a from-scratch reimplementation of valve's player movement so the surf
feels right. multiplayer is peer to peer over webrtc with no game server.

## the movement is the whole point

surf isn't a feature anyone designed. it falls out of three rules in the old
quake/goldsrc movement code, and if you get those three rules exactly right you
get surf for free:

1. when you hit a surface the engine doesn't stop you, it removes only the part
   of your velocity going into the surface and keeps the rest. on a tilted ramp
   that leftover bit is "downhill", so you slide.
2. the engine refuses to treat anything steeper than about 45 degrees as
   ground, so on a ramp you never get friction and you stay in "air" physics.
3. in the air you can add a little speed each tick, but only up to a hard cap of
   30 units projected onto where you are aiming. because the cap is on the
   projection and not your real speed, holding a strafe key and turning your
   mouse in sync keeps adding speed basically forever.

so i ported those functions (clipvelocity, categorizeposition, airaccelerate,
flymove) straight from pm_shared.c, same constants, same order per tick. the one
change from the original is it runs on a fixed 100hz timestep instead of being
tied to your framerate, because the old engine literally ran physics faster at
higher fps which was a bug people abused. rendering interpolates between physics
steps.

## collision against the real map

goldsrc maps ship precomputed "clip nodes", a bsp tree of planes already
expanded by the player's box size. so to collide you just trace a point through
that tree and it returns the plane you hit. the surf ramps are angled planes in
that tree, the trace hands back the tilted normal, clipvelocity does its thing,
and you surf. this is the actual engine approach, not an approximation. bullets
use the separate point-precise node tree so impact decals land exactly on the
wall.

a lot of community maps build their ramps as brush entities (func_wall) instead
of the main world, so the player gets traced against the world plus every solid
brush model, with an aabb broad-phase so it stays cheap.

## rendering

faces get pulled out of the bsp, uvs computed from the texinfo vectors, grouped
by texture, merged into buffers. the maps also ship baked lightmaps (a big lump
of per-face light data), so those get packed into one atlas and multiplied over
the base textures, which is what gives it the real goldsrc look instead of flat
fullbright. goldsrc is z-up, three.js is y-up, so everything gets remapped on
the way in.

textures are the weak spot: cs maps keep most textures in external .wad files
that aren't redistributable, so for the missing ones it falls back to cc0
kenney prototype textures. the weapon view models are real cs studio (.mdl)
models, parsed in js (bones, the reference pose, triangle command lists,
embedded 8-bit palette textures) and posed in the hand.

## multiplayer with no server

it uses trystero, which does webrtc peer to peer and uses public relays only to
introduce peers to each other, no game server in the middle. everyone in the
same room name shares a session, broadcasts their position about 20 times a
second, and you see each other surf. shooting is shooter-authoritative: your
client decides if a shot hit someone and tells them, they apply the damage to
themselves. great for messing around with friends, not cheat proof, more on
that in the release notes.

## stack

vanilla js, three.js for webgl, trystero for p2p, that's it. no build step, no
framework, no bundler. served as static files. the physics is a plain module
with no rendering dependency so it is unit tested headlessly, and there is a
headless-chromium test that boots the real page and checks it renders and
strafes.
