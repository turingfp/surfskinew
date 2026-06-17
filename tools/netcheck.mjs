// Multi-session P2P smoke test: boots N headless browser sessions into the same
// room and checks they discover each other and exchange position state.
//   node tools/netcheck.mjs [sessions] [seconds]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { execSync } = require('node:child_process');
function loadPlaywright() { try { return require('playwright'); } catch { /* */ } return require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const { chromium } = loadPlaywright();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] || 3);
const SECS = Number(process.argv[3] || 25);
const ROOM = 'nettest-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.bsp': 'application/octet-stream', '.mdl': 'application/octet-stream', '.wav': 'audio/wav' };

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
console.log(`room=${ROOM}  sessions=${N}  window=${SECS}s`);

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const pages = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } }); // separate context = distinct peer
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[s${i}] PAGEERR`, String(e)));
  await page.goto(`http://localhost:${port}/?room=${ROOM}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__surf && window.__surf.ready, { timeout: 30000 });
  // give each session a distinct spawn so movement is observable
  await page.evaluate((i) => { const s = window.__surf; s.setState([s.spawn.origin[0] + i * 60, s.spawn.origin[1], s.spawn.origin[2] + 8]); }, i);
  pages.push(page);
  console.log(`[s${i}] booted`);
}

// Let signaling + WebRTC settle; nudge session 0 around so others get state updates.
const deadline = Date.now() + SECS * 1000;
let tick = 0;
while (Date.now() < deadline) {
  await pages[0].evaluate((t) => { const s = window.__surf; const o = s.spawn.origin; s.setState([o[0] + Math.sin(t / 3) * 120, o[1] + Math.cos(t / 3) * 120, o[2] + 8]); }, tick++);
  await new Promise((r) => setTimeout(r, 1000));
  const infos = await Promise.all(pages.map((p) => p.evaluate(() => window.__surf.netInfo())));
  const line = infos.map((n, i) => `s${i}:peers=${n.peers.length},remotes=${n.remotes.length}`).join('  ');
  process.stdout.write(`\r[t+${tick}s] ${line}            `);
}
console.log('\n--- result ---');
const infos = await Promise.all(pages.map((p) => p.evaluate(() => window.__surf.netInfo())));
let ok = true;
infos.forEach((n, i) => {
  const seesOthers = n.peers.length >= N - 1;
  const hasState = n.remotes.some((r) => r.o);
  console.log(`s${i}: connected=${n.connected} count=${n.count} peers=${n.peers.length} remotesWithState=${n.remotes.filter((r) => r.o).length}/${n.remotes.length}`);
  if (!seesOthers) ok = false;
});
// did anyone receive a moving remote position from s0?
const movement = infos.slice(1).some((n) => n.remotes.some((r) => r.o));
console.log(`\nPEER DISCOVERY: ${infos.every((n) => n.peers.length >= N - 1) ? 'PASS' : 'FAIL'}`);
console.log(`STATE EXCHANGE: ${movement ? 'PASS' : 'FAIL'}`);

await browser.close();
server.close();
process.exit(ok && movement ? 0 : 1);
