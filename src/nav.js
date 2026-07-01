// GoldSrc/Source engine navigation mesh (.nav) parser + a generic area-graph
// pathfinder shared with the runtime-generated navmesh (navgen.js).
//
// Format reverse-engineered from Valve's actual CNavArea::Load /
// CNavMesh::Load (source-sdk-2013, src/game/server/nav_file.cpp) rather than
// from newer (CS:GO/CS:S-era, version 6+) third-party parsers: those add a
// `version < 6` rejection and don't reproduce several *early-return* gates
// (`if (version < 7) return;` etc.) that only matter for the original CS 1.6
// bot nav format (version 4-5), which is what shipped maps like de_dust2 use.
// Validated byte-exact against the real de_dust2.nav (parses to EOF).

const NAV_MAGIC = 0xFEEDFACE;

class ByteReader {
  constructor(buf) { this.dv = new DataView(buf); this.o = 0; }
  u8() { return this.dv.getUint8(this.o++); }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  str(n) { let s = ''; for (let i = 0; i < n; i++) { const c = this.u8(); if (c !== 0) s += String.fromCharCode(c); } return s; }
  eof() { return this.o >= this.dv.byteLength; }
}

// Parse a .nav file into { areas, ladders, places }. Each area:
// { id, flags, min:[x,y,z], max:[x,y,z], center:[x,y,z], conns:[[id]x4] }
// (conns indexed by direction: 0=N,1=E,2=S,3=W, values are connecting area IDs)
export function parseNav(buffer) {
  const r = new ByteReader(buffer);
  const magic = r.u32();
  if (magic !== NAV_MAGIC) throw new Error('not a NAV file');
  const version = r.u32();
  let subVersion = 0;
  if (version >= 10) subVersion = r.u32();
  if (version >= 4) r.u32(); // bsp size (source integrity check; unused here)
  if (version >= 14) r.u8(); // isAnalyzed

  const places = [];
  if (version >= 5) {
    const placeCount = r.u16();
    for (let i = 0; i < placeCount; i++) { const len = r.u16(); places.push(r.str(len)); }
    if (version > 11) r.u8(); // hasUnnamedAreas
  }

  const areaCount = r.u32();
  const areas = new Array(areaCount);
  for (let i = 0; i < areaCount; i++) {
    const id = r.u32();
    let flags;
    if (version <= 8) flags = r.u8();
    else if (version < 13) flags = r.u16();
    else flags = r.u32();
    const x1 = r.f32(), y1 = r.f32(), z1 = r.f32();
    const x2 = r.f32(), y2 = r.f32(), z2 = r.f32();
    r.f32(); r.f32(); // neZ, swZ (implicit corner heights; min/max already give a usable AABB)

    const conns = [[], [], [], []];
    for (let d = 0; d < 4; d++) {
      const cc = r.u32();
      for (let k = 0; k < cc; k++) conns[d].push(r.u32());
    }

    const hidingSpotCount = r.u8();
    for (let h = 0; h < hidingSpotCount; h++) { r.u32(); r.f32(); r.f32(); r.f32(); r.u8(); }

    if (version < 15) {
      const approachCount = r.u8();
      for (let a = 0; a < approachCount; a++) { r.u32(); r.u32(); r.u8(); r.u32(); r.u8(); }
    }

    const encCount = r.u32();
    if (version < 3) {
      for (let e = 0; e < encCount; e++) {
        r.u32(); r.u32(); r.f32(); r.f32(); r.f32(); r.f32(); r.f32(); r.f32();
        const sc = r.u8(); for (let s = 0; s < sc; s++) { r.f32(); r.f32(); r.f32(); r.f32(); }
      }
    } else {
      for (let e = 0; e < encCount; e++) {
        r.u32(); r.u8(); r.u32(); r.u8();
        const spotCount = r.u8();
        for (let s = 0; s < spotCount; s++) { r.u32(); r.u8(); }
      }
    }

    let placeID = 0;
    if (version >= 5) {
      placeID = r.u16();
      // CNavArea::Load returns immediately after the place ID for version < 7 —
      // no ladder connections / occupy times / light data exist in the file.
      if (version >= 7) {
        for (let ld = 0; ld < 2; ld++) { const lc = r.u32(); for (let k = 0; k < lc; k++) r.u32(); }
        if (version >= 8) {
          r.f32(); r.f32(); // earliest occupy time, per team
          if (version >= 11) { r.f32(); r.f32(); r.f32(); r.f32(); } // corner light intensities
        }
      }
    }

    areas[i] = {
      id, flags,
      min: [x1, y1, z1], max: [x2, y2, z2],
      center: [(x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2],
      conns, placeID,
    };
  }

  // CNavMesh::Load only reads a mesh-level ladder array for version >= 6;
  // earlier versions compute ladders at runtime instead (BuildLadders()) and
  // have nothing left in the file — checking here would silently misparse.
  const ladders = [];
  if (version >= 6) {
    const ladderCount = r.u32();
    for (let i = 0; i < ladderCount; i++) {
      const id = r.u32();
      const width = r.f32();
      const top = [r.f32(), r.f32(), r.f32()];
      const bottom = [r.f32(), r.f32(), r.f32()];
      const length = r.f32();
      const direction = r.u32();
      const topForward = r.u32(), topLeft = r.u32(), topRight = r.u32(), topBehind = r.u32(), bottomArea = r.u32();
      ladders.push({ id, width, top, bottom, length, direction, topForward, topLeft, topRight, topBehind, bottomArea });
    }
  }

  return { version, areas, ladders, places };
}

export async function loadNav(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`load ${url}: ${res.status}`);
  return parseNav(await res.arrayBuffer());
}

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

// A graph of navigable nodes (nav-area centers, or generated sample points)
// with pre-built adjacency, shared by the real .nav loader and the runtime
// navmesh generator (navgen.js). `nodes`: [{pos:[x,y,z]}], `edges`: Map<int,
// Set<int>> (directed; callers add both directions for symmetric traversal).
export class NavGraph {
  constructor(nodes, edges) {
    this.nodes = nodes;
    this.edges = edges; // index -> Set<neighbor index>
  }

  static fromNavAreas(areas) {
    const idToIndex = new Map();
    areas.forEach((a, i) => idToIndex.set(a.id, i));
    const nodes = areas.map((a) => ({ pos: a.center, min: a.min, max: a.max }));
    const edges = new Map();
    areas.forEach((a, i) => {
      const set = edges.get(i) || new Set(); edges.set(i, set);
      for (const dirList of a.conns) {
        for (const cid of dirList) {
          const j = idToIndex.get(cid);
          if (j == null) continue;
          set.add(j);
          const back = edges.get(j) || new Set(); edges.set(j, back); back.add(i); // treat traversable both ways
        }
      }
    });
    return new NavGraph(nodes, edges);
  }

  nearestNode(posGS) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const d = dist(this.nodes[i].pos, posGS);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  randomNodeIndex() { return (Math.random() * this.nodes.length) | 0; }

  // A* over node centers; returns a list of GS positions (excludes the start
  // node, includes the goal) or null if unreachable.
  findPath(fromGS, toGS) {
    const start = this.nearestNode(fromGS);
    const goal = this.nearestNode(toGS);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [this.nodes[goal].pos];

    const open = new Set([start]);
    const cameFrom = new Map();
    const gScore = new Map([[start, 0]]);
    const fScore = new Map([[start, dist(this.nodes[start].pos, this.nodes[goal].pos)]]);

    while (open.size) {
      let current = -1, bestF = Infinity;
      for (const n of open) { const f = fScore.get(n) ?? Infinity; if (f < bestF) { bestF = f; current = n; } }
      if (current === goal) {
        const path = [];
        let c = current;
        while (cameFrom.has(c)) { path.unshift(this.nodes[c].pos); c = cameFrom.get(c); }
        return path;
      }
      open.delete(current);
      const neighbors = this.edges.get(current);
      if (!neighbors) continue;
      for (const n of neighbors) {
        const tentative = (gScore.get(current) ?? Infinity) + dist(this.nodes[current].pos, this.nodes[n].pos);
        if (tentative < (gScore.get(n) ?? Infinity)) {
          cameFrom.set(n, current);
          gScore.set(n, tentative);
          fScore.set(n, tentative + dist(this.nodes[n].pos, this.nodes[goal].pos));
          open.add(n);
        }
      }
    }
    return null; // no path
  }
}
