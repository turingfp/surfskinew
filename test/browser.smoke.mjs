// Headless browser smoke test (Playwright + Chromium / SwiftShader WebGL).
// Boots the actual page, verifies the BSP renders and the in-browser physics
// surfs. Run:  node test/browser.smoke.mjs
//
// This is a real end-to-end check: WebGL context, level geometry built from
// surf_ski_2.bsp, GL draw calls producing triangles, and a strafe sequence
// gaining speed inside the live engine.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { execSync } = require('node:child_process');
const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = require(join(globalRoot, 'playwright'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.bsp': 'application/octet-stream' };

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n} ${e}`); } };

function startServer() {
  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = normalize(join(ROOT, p));
    const info = await stat(fp).catch(() => null);
    if (!info || !info.isFile()) { res.writeHead(404).end(); return; }
    const body = await readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base, { waitUntil: 'load' });

  // Wait for the engine to finish booting.
  await page.waitForFunction(() => window.__surf && window.__surf.ready, { timeout: 30000 });

  const stats = await page.evaluate(() => window.__surf.stats);
  ok('level geometry built (faces drawn > 1000)', stats.drawn > 1000, JSON.stringify(stats));
  ok('multiple materials created', stats.materials > 1, JSON.stringify(stats));

  // Give the render loop a few frames, then check GL actually drew triangles.
  await page.waitForTimeout(400);
  const rinfo = await page.evaluate(() => window.__surf.rendererInfo());
  ok('WebGL renders triangles', rinfo.triangles > 1000, JSON.stringify(rinfo));
  ok('WebGL issues draw calls', rinfo.calls > 0, JSON.stringify(rinfo));

  // Spawn collides onto ground: trace straight down from the spawn.
  const groundHit = await page.evaluate(() => {
    const s = window.__surf;
    const sp = s.spawn.origin;
    const t = s.trace([sp[0], sp[1], sp[2] + 16], [sp[0], sp[1], sp[2] - 4096], 1);
    return { frac: t.fraction, hasPlane: !!t.plane };
  });
  ok('downward trace from spawn hits world geometry', groundHit.frac < 1 && groundHit.hasPlane, JSON.stringify(groundHit));

  // Drive an air-strafe sequence with the shipped physics module, against an
  // open-air world (no level collision) so we measure pure air-accel gain.
  const strafe = await page.evaluate(() => {
    const s = window.__surf;
    const openWorld = {
      // never hits anything: the move always completes fully
      traceHull: (a, b) => ({ fraction: 1, endpos: [...b], plane: null, startsolid: false, allsolid: false }),
      pointContents: () => -1, // CONTENTS_EMPTY
    };
    s.setState([0, 0, 0], [320, 0, 0]);
    s.setAir();
    const start = s.getState().speed;
    let yaw = 0; let end = null;
    // strafe-right + turn right in sync (the canonical speed-gain technique)
    for (let i = 0; i < 300; i++) {
      yaw -= 0.02;
      const st = s.getState();
      s.setState(null, [st.velocity[0], st.velocity[1], 0]); // negate gravity drift; measure horizontal gain
      s.setAir();
      end = s.tickWith({ forwardmove: 0, sidemove: 400, yaw, pitch: 0, jump: false, duck: false }, openWorld, 0.01);
    }
    return { start, end };
  });
  ok('air strafing gains speed in-browser', strafe.end > strafe.start + 100,
    `start=${strafe.start?.toFixed(1)} end=${strafe.end?.toFixed(1)}`);
  ok('strafe speed reaches >450 ups (far beyond the 30 cap)', strafe.end > 450, `end=${strafe.end?.toFixed(1)}`);

  ok('no uncaught console/page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.close();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
