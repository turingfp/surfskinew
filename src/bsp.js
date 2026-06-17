// GoldSrc BSP v30 parser (Half-Life / Counter-Strike 1.6 map format).
//
// Parses the lumps needed to (a) render the level and (b) collide the player
// against it. Collision uses the precomputed clip-node hulls, which is what
// makes the real surf ramps behave exactly like they do in-engine.
//
// Reference: the 15-lump GoldSrc header and the dplane_t / dface_t /
// dclipnode_t / dmodel_t structures from Valve's bspfile.h.

const LUMP = {
  ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTICES: 3, VISIBILITY: 4,
  NODES: 5, TEXINFO: 6, FACES: 7, LIGHTING: 8, CLIPNODES: 9,
  LEAVES: 10, MARKSURFACES: 11, EDGES: 12, SURFEDGES: 13, MODELS: 14,
};

export class BSP {
  constructor(arrayBuffer) {
    this.buf = arrayBuffer;
    this.view = new DataView(arrayBuffer);
    this.version = this.view.getInt32(0, true);
    if (this.version !== 30) {
      console.warn(`BSP version ${this.version} (expected 30 for GoldSrc)`);
    }
    this.lumps = [];
    for (let i = 0; i < 15; i++) {
      const o = 4 + i * 8;
      this.lumps.push({
        offset: this.view.getInt32(o, true),
        length: this.view.getInt32(o + 4, true),
      });
    }
    this.parse();
  }

  lump(i) { return this.lumps[i]; }

  parse() {
    this.parseEntities();
    this.parsePlanes();
    this.parseVertices();
    this.parseEdges();
    this.parseSurfedges();
    this.parseTexInfo();
    this.parseFaces();
    this.parseTextures();
    this.parseClipNodes();
    this.parseModels();
    this.parseLighting();
    this.parseNodes();
    this.parseLeaves();
  }

  // ---- NODES (hull 0 / point-trace BSP tree) --------------------------------
  parseNodes() {
    const { offset, length } = this.lump(5);
    const n = length / 24;
    const planenum = new Int32Array(n), child0 = new Int32Array(n), child1 = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const o = offset + i * 24;
      planenum[i] = this.view.getInt32(o, true);
      child0[i] = this.view.getInt16(o + 4, true);
      child1[i] = this.view.getInt16(o + 6, true);
    }
    this.nodes = { planenum, child0, child1, count: n };
  }

  // ---- LEAVES (contents only, for point traces) ----------------------------
  parseLeaves() {
    const { offset, length } = this.lump(10);
    const n = length / 28;
    const contents = new Int32Array(n);
    for (let i = 0; i < n; i++) contents[i] = this.view.getInt32(offset + i * 28, true);
    this.leafContents = contents;
  }

  // ---- LIGHTING (per-face lightmaps, RGB) ----------------------------------
  parseLighting() {
    const { offset, length } = this.lump(8); // LUMP_LIGHTING
    this.lighting = length > 0 ? new Uint8Array(this.buf, offset, length) : new Uint8Array(0);
  }

  // ---- ENTITIES (text) -----------------------------------------------------
  parseEntities() {
    const { offset, length } = this.lump(LUMP.ENTITIES);
    const bytes = new Uint8Array(this.buf, offset, length);
    let text = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0) break;
      text += String.fromCharCode(c);
    }
    this.entityText = text;
    this.entities = [];
    // tokenise the classic { "key" "value" ... } blocks
    const re = /\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const ent = {};
      const kv = /"([^"]*)"\s*"([^"]*)"/g;
      let p;
      while ((p = kv.exec(m[1])) !== null) ent[p[1]] = p[2];
      this.entities.push(ent);
    }
  }

  entitiesByClass(classname) {
    return this.entities.filter((e) => e.classname === classname);
  }

  // ---- PLANES --------------------------------------------------------------
  parsePlanes() {
    const { offset, length } = this.lump(LUMP.PLANES);
    const n = length / 20;
    const planes = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = offset + i * 20;
      planes[i] = {
        normal: [
          this.view.getFloat32(o, true),
          this.view.getFloat32(o + 4, true),
          this.view.getFloat32(o + 8, true),
        ],
        dist: this.view.getFloat32(o + 12, true),
        type: this.view.getInt32(o + 16, true),
      };
    }
    this.planes = planes;
  }

  // ---- VERTICES ------------------------------------------------------------
  parseVertices() {
    const { offset, length } = this.lump(LUMP.VERTICES);
    const n = length / 12;
    const v = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = offset + i * 12;
      v[i * 3] = this.view.getFloat32(o, true);
      v[i * 3 + 1] = this.view.getFloat32(o + 4, true);
      v[i * 3 + 2] = this.view.getFloat32(o + 8, true);
    }
    this.vertices = v;
  }

  // ---- EDGES ---------------------------------------------------------------
  parseEdges() {
    const { offset, length } = this.lump(LUMP.EDGES);
    const n = length / 4;
    const e = new Uint16Array(n * 2);
    for (let i = 0; i < n; i++) {
      const o = offset + i * 4;
      e[i * 2] = this.view.getUint16(o, true);
      e[i * 2 + 1] = this.view.getUint16(o + 2, true);
    }
    this.edges = e;
  }

  // ---- SURFEDGES -----------------------------------------------------------
  parseSurfedges() {
    const { offset, length } = this.lump(LUMP.SURFEDGES);
    const n = length / 4;
    const s = new Int32Array(n);
    for (let i = 0; i < n; i++) s[i] = this.view.getInt32(offset + i * 4, true);
    this.surfedges = s;
  }

  // ---- TEXINFO -------------------------------------------------------------
  parseTexInfo() {
    const { offset, length } = this.lump(LUMP.TEXINFO);
    const n = length / 40;
    const t = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = offset + i * 40;
      t[i] = {
        s: [
          this.view.getFloat32(o, true), this.view.getFloat32(o + 4, true),
          this.view.getFloat32(o + 8, true), this.view.getFloat32(o + 12, true),
        ],
        t: [
          this.view.getFloat32(o + 16, true), this.view.getFloat32(o + 20, true),
          this.view.getFloat32(o + 24, true), this.view.getFloat32(o + 28, true),
        ],
        miptex: this.view.getInt32(o + 32, true),
        flags: this.view.getInt32(o + 36, true),
      };
    }
    this.texinfo = t;
  }

  // ---- FACES ---------------------------------------------------------------
  parseFaces() {
    const { offset, length } = this.lump(LUMP.FACES);
    const n = length / 20;
    const f = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = offset + i * 20;
      f[i] = {
        planenum: this.view.getUint16(o, true),
        side: this.view.getInt16(o + 2, true),
        firstedge: this.view.getInt32(o + 4, true),
        numedges: this.view.getInt16(o + 8, true),
        texinfo: this.view.getInt16(o + 10, true),
        styles: [
          this.view.getUint8(o + 12), this.view.getUint8(o + 13),
          this.view.getUint8(o + 14), this.view.getUint8(o + 15),
        ],
        lightofs: this.view.getInt32(o + 16, true),
      };
    }
    this.faces = f;
  }

  // ---- TEXTURES (miptex with optional embedded pixels + palette) -----------
  parseTextures() {
    const { offset } = this.lump(LUMP.TEXTURES);
    const numtex = this.view.getInt32(offset, true);
    const textures = new Array(numtex);
    for (let i = 0; i < numtex; i++) {
      const dirOff = this.view.getInt32(offset + 4 + i * 4, true);
      if (dirOff < 0) { textures[i] = { name: '', width: 16, height: 16, embedded: false }; continue; }
      const base = offset + dirOff;
      let name = '';
      for (let c = 0; c < 16; c++) {
        const ch = this.view.getUint8(base + c);
        if (ch === 0) break;
        name += String.fromCharCode(ch);
      }
      const width = this.view.getUint32(base + 16, true);
      const height = this.view.getUint32(base + 20, true);
      const mipOffsets = [
        this.view.getUint32(base + 24, true), this.view.getUint32(base + 28, true),
        this.view.getUint32(base + 32, true), this.view.getUint32(base + 36, true),
      ];
      const tex = { name, width, height, embedded: false, rgba: null, masked: name.startsWith('{') };
      if (mipOffsets[0] !== 0 && width > 0 && height > 0) {
        tex.embedded = true;
        tex.rgba = this.decodeMip(base, width, height, mipOffsets);
      }
      textures[i] = tex;
    }
    this.textures = textures;
  }

  decodeMip(base, w, h, mipOffsets) {
    // palette sits after the 4 mips: end of mip3 + 2-byte count, then 256*3 RGB
    const palStart = base + mipOffsets[3] + (w >> 3) * (h >> 3) + 2;
    const idxStart = base + mipOffsets[0];
    const out = new Uint8Array(w * h * 4);
    const masked = this.view.getUint8(base) === 0x7b; // '{' handled by caller too
    for (let p = 0; p < w * h; p++) {
      const idx = this.view.getUint8(idxStart + p);
      const pr = this.view.getUint8(palStart + idx * 3);
      const pg = this.view.getUint8(palStart + idx * 3 + 1);
      const pb = this.view.getUint8(palStart + idx * 3 + 2);
      const o = p * 4;
      out[o] = pr; out[o + 1] = pg; out[o + 2] = pb;
      // index 255 (blue) is the transparent colour key for { textures
      out[o + 3] = (masked && idx === 255) ? 0 : 255;
    }
    return out;
  }

  // ---- CLIPNODES (collision BSP for the sized hulls) -----------------------
  parseClipNodes() {
    const { offset, length } = this.lump(LUMP.CLIPNODES);
    const n = length / 8;
    // Store flat for speed: [planenum, child0, child1] * n
    const planenum = new Int32Array(n);
    const child0 = new Int32Array(n);
    const child1 = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const o = offset + i * 8;
      planenum[i] = this.view.getInt32(o, true);
      child0[i] = this.view.getInt16(o + 4, true);
      child1[i] = this.view.getInt16(o + 6, true);
    }
    this.clipnodes = { planenum, child0, child1, count: n };
  }

  // ---- MODELS --------------------------------------------------------------
  parseModels() {
    const { offset, length } = this.lump(LUMP.MODELS);
    const n = length / 64;
    const models = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = offset + i * 64;
      const f = (k) => this.view.getFloat32(o + k, true);
      const ii = (k) => this.view.getInt32(o + k, true);
      models[i] = {
        mins: [f(0), f(4), f(8)],
        maxs: [f(12), f(16), f(20)],
        origin: [f(24), f(28), f(32)],
        headnode: [ii(36), ii(40), ii(44), ii(48)],
        visleafs: ii(52),
        firstface: ii(56),
        numfaces: ii(60),
      };
    }
    this.models = models;
  }
}

export async function loadBSP(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new BSP(buf);
}
