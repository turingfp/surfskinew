// Boots the game headlessly and saves screenshots, for visual verification.
//   node tools/capture.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { execSync } = require('node:child_process');
const { chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.bsp': 'application/octet-stream' };

const server = await new Promise((res) => {
  const s = createServer(async (req, rsp) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const fp = normalize(join(ROOT, p)); const info = await stat(fp).catch(() => null);
    if (!info || !info.isFile()) { rsp.writeHead(404).end(); return; }
    rsp.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
    rsp.end(await readFile(fp));
  });
  s.listen(0, () => res(s));
});
const port = server.address().port;

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
await page.goto(`http://localhost:${port}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__surf && window.__surf.ready, { timeout: 30000 });
await page.evaluate(() => { document.getElementById('overlay').style.display = 'none'; });

async function shot(name, fn) {
  await page.evaluate(fn);
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(ROOT, 'docs', name) });
  console.log('wrote docs/' + name);
}

// 0) weapon viewmodel against open sky (look up), for tuning
await page.waitForTimeout(600); // let GLB viewmodels finish loading
await shot('shot_weapon.png', () => {
  const s = window.__surf;
  const mn = s.worldMins, mx = s.worldMaxs;
  s.setState([(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mx[2] + 2000], [0, 0, 0]);
  s.setLook(0, 0.55); // look up at the sky
});
// 1) from the spawn, looking forward (reset position after the weapon shot)
await shot('shot_spawn.png', () => {
  const s = window.__surf;
  s.setState([s.spawn.origin[0], s.spawn.origin[1], s.spawn.origin[2] + 8], [0, 0, 0]);
  s.setLook(s.spawn.yaw, 0);
});
// 2) high overview looking down across the course
await shot('shot_overview.png', () => {
  const s = window.__surf;
  const mn = s.worldMins, mx = s.worldMaxs;
  s.setState([mn[0] + (mx[0] - mn[0]) * 0.25, (mn[1] + mx[1]) / 2, mx[2] + 600], [0, 0, 0]);
  s.setLook(0.4, -0.7); // look forward and down
});
// 3) a mid-map angle
await shot('shot_mid.png', () => {
  const s = window.__surf;
  const mn = s.worldMins, mx = s.worldMaxs;
  s.setState([(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2 + 100], [0, 0, 0]);
  s.setLook(1.2, -0.15);
});

await browser.close();
server.close();
console.log('done');
