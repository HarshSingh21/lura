// The release scenario (docs/release-spec.md), end to end, in two browsers.
//
// Harsh and Nishtha sign in through Keycloak, connect on People, watch each
// other move, and Harsh draws fences — a polygon around a grocery store on
// Nishtha's way, a circle, a freehand outline — then moves and reshapes them.
// Nishtha's route crosses the grocery and both browsers must say so: a toast, a
// badge, one chime per crossing. Then the basemaps, then the privacy switches.
//
// Every step is asserted twice where it can be: in the UI (DOM and
// screenshots) and on the wire (the REST API and the live socket). The run
// stops at the first failed step, because every later step builds on it.
//
// Environment (e2e/run.sh sets all of it):
//   E2E_BASE      the app's origin as the browsers see it
//   E2E_API       the API origin for direct calls (default http://localhost:8080)
//   E2E_PROVIDER  maplibre | mappls, for the report
//   E2E_OUT       where screenshots and results.json go
//   E2E_LURASIM   a built cmd/lurasim
//   E2E_STORE     memory | postgres; on postgres step 5 also restarts Lura
//   E2E_RESTART   the restart script (lib/server.mjs)
//   E2E_HEADED=1  watch it happen

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, Person, chimes, sleep, waitFor } from './lib/browser.mjs';
import { haversineM, lerp, metresPerPixel, pointInPolygon, project } from './lib/geo.mjs';
import { canKeepData, duringRestart, restartServer } from './lib/server.mjs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:8080';
const PROVIDER = process.env.E2E_PROVIDER ?? 'maplibre';
const OUT = process.env.E2E_OUT ?? '/tmp/lura-e2e';
const LURASIM = process.env.E2E_LURASIM ?? 'lurasim';
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ the map
// Indiranagar, Bengaluru. Everything happens inside a kilometre so one view at
// zoom ~15.5 holds it all.
const HARSH_START = { lat: 12.9786, lon: 77.6398 };
const NISHTHA_START = { lat: 12.9702, lon: 77.6378 };
// Nishtha's warm-up loop for step 3, well clear of every fence.
const NISHTHA_LOOP = [NISHTHA_START, { lat: 12.9702, lon: 77.6352 }, { lat: 12.9688, lon: 77.6352 }, { lat: 12.9688, lon: 77.6378 }];
// The grocery store, and Nishtha's way past it: in from the south-west, a stop
// at the shop, out to the north-east, then back round the south — a triangle,
// so the loop home never re-enters the fence.
const GROCERY = { lat: 12.973, lon: 77.642 };
const ROUTE_IN = { lat: 12.9712, lon: 77.6402 };
const ROUTE_OUT = { lat: 12.9752, lon: 77.6442 };
const ROUTE_HOME = { lat: 12.9712, lon: 77.6465 };
const PHARMACY = { lat: 12.9768, lon: 77.6352 };
const PARK = { lat: 12.9762, lon: 77.6468 };

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADED !== '1',
  args: [
    `--host-resolver-rules=MAP lura.com 127.0.0.1:${process.env.E2E_PORT ?? 8080}`,
    // http://lura.com is not a secure context, so without this sign-in has no
    // WebCrypto (PKCE) and the page no geolocation; a real lura.com is https.
    `--unsafely-treat-insecure-origin-as-secure=http://lura.com:${process.env.E2E_PORT ?? 8080}`,
    '--autoplay-policy=no-user-gesture-required',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});

const harsh = new Person({ name: 'Harsh', email: 'harsh@lura.local', password: 'lura-harsh', start: HARSH_START });
const nishtha = new Person({ name: 'Nishtha', email: 'nishtha@lura.local', password: 'lura-nishtha', start: NISHTHA_START });
const people = [harsh, nishtha];

const results = [];
const facts = {}; // ids and measurements later steps build on
const sims = new Set();

function check(cond, message) {
  if (!cond) throw new Error(message);
}

function stats(values) {
  if (values.length === 0) return { n: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const round = (v) => Math.round(v * 10) / 10;
  return { n: s.length, min: round(s[0]), p50: round(q(0.5)), p95: round(q(0.95)), max: round(s[s.length - 1]) };
}

// E2E_STEPS=4,5 runs only those steps (1–3 always run: they sign in, connect
// and start the devices every later step needs). E2E_SEED=1 creates step 4's
// fences and note through the API instead of drawing them, so steps 6–8 can be
// exercised without depending on the editor.
const ONLY = (process.env.E2E_STEPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SEED = process.env.E2E_SEED === '1';

async function step(id, title, fn) {
  if (ONLY.length && !['1', '2', '3'].includes(id) && !ONLY.includes(id) && !(id === '4' && SEED)) {
    results.push({ id, title, pass: true, skipped: true, ms: 0 });
    process.stdout.write(`\n[${id}] ${title}\n  SKIPPED (E2E_STEPS)\n`);
    return;
  }
  if (id === '4' && SEED && !ONLY.includes('4')) fn = seedStep4;
  const started = Date.now();
  process.stdout.write(`\n[${id}] ${title}\n`);
  try {
    const evidence = await fn();
    results.push({ id, title, pass: true, ms: Date.now() - started, evidence });
    process.stdout.write(`  PASS ${JSON.stringify(evidence)}\n`);
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - started, error: String(err?.stack ?? err) });
    process.stdout.write(`  FAIL ${err?.stack ?? err}\n`);
    for (const p of people) await p.shot(OUT, `fail-${id}`).catch(() => {});
    throw err;
  }
}

/**
 * sim drives one device along a route with cmd/lurasim. Resolves when the route
 * is done (loops=1), or returns a stop function for an endless loop.
 */
function sim(device, route, { interval = '700ms', scale = 4, loops = 1, jitter = 3 } = {}) {
  const spec = route.map((p) => `${p.lat},${p.lon}${p.dwell ? `,${p.dwell}` : ''}`).join(';');
  const child = spawn(
    LURASIM,
    [
      '-url', process.env.E2E_API ?? 'http://localhost:8080',
      '-token', device.token,
      `-device=${device.id}`,
      '-route', spec,
      '-interval', interval,
      '-scale', String(scale),
      '-jitter', String(jitter),
      '-loops', String(loops),
      '-quiet',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  sims.add(child);
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const done = new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      sims.delete(child);
      if (code === 0 || code === null) resolve(log);
      else reject(new Error(`lurasim exited ${code}: ${log}`));
    });
  });
  return { done, stop: () => child.kill('SIGINT'), log: () => log };
}

/** gpsWalk moves a browser's emulated GPS along a path, one fix per period. */
async function gpsWalk(person, path, periodMs = 2300) {
  for (const p of path) {
    await person.ctx.setGeolocation({ latitude: p.lat, longitude: p.lon, accuracy: 6 });
    await sleep(periodMs);
  }
}

function since(list, t) {
  return list.filter((x) => x.t >= t);
}

async function pageNow(person) {
  return person.page.evaluate(() => performance.now());
}

/** markerAt is the pixel distance between a marker and where a coordinate projects. */
async function markerOffset(person, markerId, point) {
  const v = await person.viewport();
  const m = await person.marker(markerId);
  if (!v || !m) return null;
  const p = project(point, v);
  return Math.hypot(m.x - (v.left + p.x), m.y - (v.top + p.y));
}

/**
 * latencyFor matches each position frame for a device to the first marker
 * update carrying that exact coordinate: socket → DOM, on the page's clock.
 */
function latencyFor(rec, deviceId, markerId, from) {
  const frames = since(rec.frames, from).filter((f) => f.type === 'position' && f.deviceId === deviceId);
  const marks = rec.markers.filter((m) => m.id === markerId);
  const render = [];
  const server = [];
  for (const f of frames) {
    const m = marks.find((x) => x.t >= f.t && Math.abs(x.lat - f.lat) < 1e-9 && Math.abs(x.lon - f.lon) < 1e-9);
    if (m) render.push(m.t - f.t);
    if (f.recvTs) server.push(f.wall - new Date(f.recvTs).getTime());
  }
  return { frames: frames.length, rendered: render.length, render: stats(render), ingestToSocket: stats(server) };
}

/** toastsSince returns the toasts a person's page showed after page-time t. */
async function toastsSince(person, t) {
  const rec = await person.record();
  return since(rec.toasts, t);
}

async function unreadBadge(person) {
  const label = await person.page
    .locator('[aria-label^="Notifications"]')
    .first()
    .getAttribute('aria-label');
  const m = /(\d+) unread/.exec(label ?? '');
  return m ? Number(m[1]) : 0;
}

/** placesOf reads a person's places straight from the API. */
async function placeNamed(person, name) {
  const { places } = await person.api('GET', '/api/v1/places');
  return places.find((p) => p.name === name);
}

// ---------------------------------------------------------------- pixels
/**
 * edgeColour samples a screenshot along a fence's edge for the fence colour. The
 * fence outline is a GL layer on MapLibre, so the DOM cannot say whether it is
 * still drawn after a style swap — the pixels can.
 */
async function edgeHasFenceColour(person, ring) {
  const v = await person.stableViewport(500);
  const png = await person.page.screenshot();
  const pts = ring.map((p) => {
    const q = project(p, v);
    return { x: v.left + q.x, y: v.top + q.y };
  });
  return person.page.evaluate(
    async ({ b64, pts }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      let hits = 0;
      let probes = 0;
      for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        for (let k = 1; k < 10; k += 1) {
          const x = Math.round(a.x + ((b.x - a.x) * k) / 10);
          const y = Math.round(a.y + ((b.y - a.y) * k) / 10);
          probes += 1;
          const d = g.getImageData(x - 2, y - 2, 5, 5).data;
          for (let j = 0; j < d.length; j += 4) {
            // The accent green (#20a07b) or the pass-by amber, as drawn over any basemap.
            const [r, gg, bb] = [d[j], d[j + 1], d[j + 2]];
            const green = Math.hypot(r - 32, gg - 160, bb - 123) < 60;
            const amber = r > 180 && gg > 110 && gg < 200 && bb < 90;
            if (green || amber) {
              hits += 1;
              break;
            }
          }
        }
      }
      return { hits, probes };
    },
    { b64: png.toString('base64'), pts },
  );
}

/** wholePx rounds a page point to the pixel a real pointer would land on. */
function wholePx(p) {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** sameView is true when the camera has not moved (to a hundredth of a pixel at this zoom). */
function sameView(a, b) {
  return a.zoom === b.zoom && haversineM(a.center, b.center) < 0.05;
}

/** revealPlace zooms Harsh's map out until a fence's label is on screen. */
async function revealPlace(name) {
  const label = harsh.page.getByRole('button', { name: `Place ${name}` });
  for (let i = 0; i < 4; i += 1) {
    await harsh.stableViewport();
    if (await label.count()) return;
    await harsh.page.getByRole('button', { name: 'Zoom out' }).click();
  }
  await harsh.stableViewport();
}

/**
 * basemapsReady puts Harsh on the live map with the Grocery fence and Nishtha's
 * marker drawn. Fences seeded through the API (E2E_SEED) reach a page that is
 * already open only when it re-reads the overview, so the page is reloaded once
 * if the fence is not there yet.
 */
async function basemapsReady(person) {
  const page = person.page;
  if (!(await page.getByRole('button', { name: 'Draw' }).count())) {
    // The row's name carries its badge ("Live map 1"), so match the start.
    await page.getByRole('link', { name: /^Live map\b/ }).first().click();
    await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 20000 });
  }
  const grocery = page.getByRole('button', { name: 'Place Grocery' });
  const drawn = async () => (await grocery.count()) > 0 && Boolean(await person.marker(`peer_${facts.nDevice.id}`));
  try {
    await waitFor('the Grocery fence and Nishtha’s marker on Harsh’s map', drawn, { timeout: 5000 });
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 20000 });
    await waitFor('the Grocery fence and Nishtha’s marker after a reload', drawn, { timeout: 20000 });
  }
  await person.stableViewport(600);
}

const isMapplsTile = (url) => /(^|\.)mappls\.com$/.test(new URL(url).host);
/** redactKey keeps the Mappls key out of failure messages and results.json. */
const redactKey = (url) => url.replace(/access_token=[^&]*/g, 'access_token=<key>');

/**
 * drawnBy says which renderer is drawing Harsh's basemap — the Mappls SDK's
 * container or MapLibre's canvas — and what the credit line under it says.
 */
async function drawnBy(person) {
  return person.page.evaluate(() => {
    const visible = (el) => el && el.offsetParent !== null;
    const renderer = [...document.querySelectorAll('[id^="lura-mappls-"]')].some(visible)
      ? 'mappls'
      : [...document.querySelectorAll('.maplibregl-canvas')].some(visible)
        ? 'maplibre'
        : 'canvas';
    const credit = document.querySelector('[data-testid="lura-map-credit"]')?.textContent ?? '';
    // The Mappls SDK credits itself inside its own container.
    const sdkCredit = [...document.querySelectorAll('[id^="lura-mappls-"]')].filter(visible).map((el) => el.textContent ?? '').join(' ');
    return { renderer, credit, sdkCredit };
  });
}

/** seedStep4 builds what step 4 draws, over the API, with the same facts. */
async function seedStep4() {
  const ring = (c, dLat, dLon) => [
    { lat: c.lat - dLat, lon: c.lon - dLon }, { lat: c.lat - dLat, lon: c.lon + dLon },
    { lat: c.lat + dLat, lon: c.lon + dLon }, { lat: c.lat + dLat, lon: c.lon - dLon },
  ];
  const mk = (body) => harsh.api('POST', '/api/v1/places', body);
  const g = await mk({ name: 'Grocery', shape: 'polygon', polygon: ring(GROCERY, 0.0012, 0.0012), triggers: ['arrive', 'leave', 'passby'], watchUserIds: [nishtha.id] });
  const ph = await mk({ name: 'Pharmacy', shape: 'circle', center: PHARMACY, radiusM: 120, triggers: ['arrive'] });
  await mk({ name: 'Park', shape: 'polygon', polygon: ring(PARK, 0.001, 0.0015), triggers: ['arrive'] });
  const n = await harsh.api('POST', '/api/v1/notes', { text: 'buy milk', placeId: (g.place ?? g).id, trigger: 'arrive', watchUserId: nishtha.id, notifyUserIds: [harsh.id, nishtha.id] });
  facts.grocery = g.place ?? g;
  facts.pharmacy = ph.place ?? ph;
  facts.note = n.note ?? n;
  check(facts.grocery?.id && facts.pharmacy?.id && facts.note?.id, `seeding failed: ${JSON.stringify({ g, ph, n })}`);
  return { seeded: true, grocery: facts.grocery.id, note: facts.note.id };
}

// ======================================================================
try {
  // ---------------------------------------------------------------- 1
  await step('1', 'Harsh and Nishtha sign in through Keycloak in two browsers', async () => {
    await Promise.all(people.map((p) => p.open(browser, BASE)));
    await Promise.all(people.map((p) => p.signIn()));
    for (const p of people) {
      const { user } = await p.api('GET', '/api/v1/me');
      p.id = user.id;
      p.displayName = user.displayName;
      // Quiet hours would hold back push channels; the in-app channel never waits.
      await p.api('PATCH', '/api/v1/me', { quietFrom: '', quietTo: '' });
      check((await p.page.getByRole('button', { name: 'Draw' }).count()) > 0, `${p.name} is not on the live map`);
    }
    check(harsh.id !== nishtha.id, 'both browsers are the same account');
    const shots = [await harsh.shot(OUT, '01-signed-in'), await nishtha.shot(OUT, '01-signed-in')];
    return { harsh: { id: harsh.id, name: harsh.displayName }, nishtha: { id: nishtha.id, name: nishtha.displayName }, shots };
  });

  // ---------------------------------------------------------------- 2
  await step('2', 'Harsh invites Nishtha; she accepts; both share both ways', async () => {
    await harsh.nav('People');
    await harsh.page.getByLabel('Email address of the person to invite').fill(nishtha.email);
    await harsh.page.getByRole('button', { name: 'Send invite' }).click();
    await harsh.page.getByText(`Invitation sent to ${nishtha.email}`).waitFor({ timeout: 10000 });
    await harsh.page.getByText('INVITATIONS YOU SENT').waitFor();

    await nishtha.nav('People');
    const accept = nishtha.page.getByRole('button', { name: /^Accept the invitation from Harsh/ });
    await waitFor('the invitation on Nishtha’s People screen', async () => {
      if (await accept.count()) return true;
      await nishtha.page.reload({ waitUntil: 'domcontentloaded' });
      return false;
    }, { timeout: 20000, every: 2500 });
    const pending = await nishtha.shot(OUT, '02-invite-pending');
    await accept.click();

    for (const [me, them] of [[harsh, nishtha], [nishtha, harsh]]) {
      await waitFor(`${me.name} to see the connection live both ways`, async () => {
        const { people: rows } = await me.api('GET', '/api/v1/people');
        const row = rows.find((r) => r.peerId === them.id);
        return row && row.status === 'accepted' && row.sharing && row.sharingWithMe;
      });
      await waitFor(`${me.name}’s People screen to show "can see you" and "Shares with you"`, async () => {
        const text = await me.page.innerText('body');
        if (text.includes('Shares with you') && text.includes(`${them.name} can see you`)) return true;
        await me.page.reload({ waitUntil: 'domcontentloaded' });
        return false;
      }, { timeout: 20000, every: 2500 });
    }
    return { pending, shots: [await harsh.shot(OUT, '02-connected'), await nishtha.shot(OUT, '02-connected')] };
  });

  // ---------------------------------------------------------------- 3
  /**
   * glideOf tells a glide from a jump in per-frame marker samples, on the
   * frame clock rather than by counting frames: a loaded machine (several
   * headless Chromes on SwiftShader) can drop to ~10 fps, and a perfectly linear
   * glide then moves several pixels per frame — 26 of 27 frames moving, 9.5 px in
   * one 700 ms stall — which a frame count reads as a jump. A jump is a step far
   * bigger than the glide's own speed explains over the time it covered; at
   * 60 fps both rules are the original ones (≥ 10 moving frames per fix, no step
   * of a quarter of a fix's distance).
   */
  const FRAME_MS = 1000 / 60;
  /**
   * Below this the page is too starved of frames to tell a glide from a jump.
   * A jump of one fix's distance is caught while a two-frame window is shorter
   * than a third of the 1 s fix interval (the bound is three times the glide's
   * mean speed over the window), i.e. above 6 fps; 8 leaves a margin.
   */
  const MIN_JUDGE_FPS = 8;
  /**
   * How much faster than its mean a glide may legitimately move over a window:
   * each leg runs one fix's distance (jittered ±3 m) in the previous fix gap,
   * so legs differ — at 23 fps one leg moved 6.7 px in 156 ms against a
   * twice-the-mean bound of 6.5.
   */
  const GLIDE_SPEED_SLACK = 3;
  /**
   * sampleOnMap records, every animation frame, where a marker is on screen and
   * the viewport it was drawn through, and returns its track in map space (the
   * first frame's pixels): a glide is the marker moving over the map, so a camera
   * move — a re-fit, a resize — must not read as the marker jumping. Frames where
   * the camera moved are counted separately.
   */
  const sampleOnMap = async (person, markerId, ms) => {
    const raw = await person.page.evaluate(
      ([id, ms]) =>
        new Promise((resolve) => {
          const out = [];
          const t0 = performance.now();
          const tick = () => {
            const el = document.querySelector(`[data-testid="lura-marker-${id}"]`);
            const vp = [...document.querySelectorAll('[data-testid="lura-map-viewport"]')].find((n) => n.offsetParent !== null);
            if (el && vp) {
              const r = el.getBoundingClientRect();
              const vr = vp.getBoundingClientRect();
              const d = vp.dataset;
              out.push({
                t: performance.now(),
                x: r.left - vr.left,
                y: r.top - vr.top,
                view: { center: { lat: +d.lat, lon: +d.lon }, zoom: +d.zoom, width: +d.width, height: +d.height },
              });
            }
            if (performance.now() - t0 < ms) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
        }),
      [markerId, ms],
    );
    const z0 = raw[0]?.view.zoom ?? 0;
    let cameraMoves = 0;
    const track = raw.map((s, i) => {
      if (i > 0 && JSON.stringify(s.view) !== JSON.stringify(raw[i - 1].view)) cameraMoves += 1;
      // The viewport centre in world pixels at this frame's zoom, then scaled to the first frame's.
      const c = project(s.view.center, { center: { lat: 0, lon: 0 }, zoom: s.view.zoom, width: 0, height: 0 });
      const k = 2 ** (z0 - s.view.zoom);
      return { t: s.t, x: (s.x - s.view.width / 2 + c.x) * k, y: (s.y - s.view.height / 2 + c.y) * k };
    });
    const spanMs = Math.max(1, (raw.at(-1)?.t ?? 0) - (raw[0]?.t ?? 0));
    return { track, cameraMoves, fps: (1000 * Math.max(0, raw.length - 1)) / spanMs };
  };

  /** closeUp screenshots the map around one marker: its label, cone, ring and wake. */
  const closeUp = async (person, markerId, name) => {
    const m = await person.marker(markerId);
    const v = await person.viewport();
    if (!m || !v) return null;
    const w = 420;
    const h = 260;
    const x = Math.round(Math.min(Math.max(m.x - w / 2, v.left), v.left + v.width - w));
    const y = Math.round(Math.min(Math.max(m.y - h / 2, v.top), v.top + v.height - h));
    const path = `${OUT}/${person.name.toLowerCase()}-${name}.png`;
    await person.page.screenshot({ path, clip: { x, y, width: w, height: h } });
    return path;
  };
  const glideOf = (samples, fixesDuring) => {
    // The sampler's rAF can run before Animated's in the same frame, so a stalled
    // frame's catch-up shows one sample late: each step is judged over its own
    // interval and the one before it. The very first step has no "before": the
    // first sample can carry a stall from before sampling began (the screenshot
    // just taken holds the page's frames), so it is measured but not judged — at
    // 17 fps it once moved 5.1 px in 13 ms for that reason alone.
    const steps = samples.slice(1).map((s, i) => ({
      d: Math.hypot(s.x - samples[i].x, s.y - samples[i].y),
      dt: s.t - samples[i].t,
      w: s.t - samples[Math.max(0, i - 1)].t,
      at: s.t - samples[0].t,
    }));
    const travelled = steps.reduce((sum, s) => sum + s.d, 0);
    const durationMs = Math.max(1, (samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0));
    const pxPerMs = travelled / durationMs;
    const perFix = travelled / Math.max(1, fixesDuring);
    const moving = steps.filter((s) => s.d > 0.05);
    const jumps = steps.slice(1).filter((s) => s.d >= Math.max(2, perFix * 0.25, GLIDE_SPEED_SLACK * pxPerMs * s.w));
    const round1 = (v) => Math.round(v * 10) / 10;
    return {
      frames: samples.length,
      fps: Math.round((1000 * (samples.length - 1)) / durationMs),
      movingFrames: moving.length,
      movingMs: Math.round(moving.reduce((sum, s) => sum + s.dt, 0)),
      fixesDuring,
      travelledPx: Math.round(travelled),
      biggestStepPx: round1(Math.max(0, ...steps.map((s) => s.d))),
      jumps: jumps.slice(0, 5).map((s) => `${round1(s.d)}px in ${Math.round(s.w)}ms at +${Math.round(s.at)}ms`),
    };
  };

  await step('3', 'Both publish; each sees the other move, live and accurately', async () => {
    await harsh.nav('Live map');
    await nishtha.nav('Live map');

    // Nishtha: a phone registered in Settings' API, driven by the simulator.
    const created = await nishtha.api('POST', '/api/v1/devices', { name: 'Nishtha’s phone', kind: 'phone' });
    facts.nDevice = { id: created.device.id, token: created.pubToken };
    // Harsh: this browser itself publishes, from its (emulated) GPS.
    await harsh.page.getByRole('button', { name: 'Publish my location' }).click();
    await harsh.ctx.setGeolocation({ latitude: HARSH_START.lat, longitude: HARSH_START.lon, accuracy: 6 });
    const hDev = await waitFor('Harsh’s browser to register as a device', async () => {
      const { devices } = await harsh.api('GET', '/api/v1/devices');
      return devices.find((d) => d.lastPoint);
    }, { timeout: 20000 });
    facts.hDevice = { id: hDev.id };

    const nMarker = `peer_${facts.nDevice.id}`;
    const hMarker = `peer_${facts.hDevice.id}`;
    const t0h = await pageNow(harsh);
    const t0n = await pageNow(nishtha);

    // ---- Nishtha moves (simulator), Harsh watches
    const loop = sim(facts.nDevice, NISHTHA_LOOP, { interval: '1s', scale: 2.5, loops: 0 });
    await waitFor('Nishtha’s marker on Harsh’s map', () => harsh.marker(nMarker), { timeout: 20000 });
    await sleep(2500);
    const a = await harsh.marker(nMarker);
    const shotA = await harsh.shot(OUT, '03-nishtha-moving-a');
    // Between two pings the marker must glide, not jump: sample its screen
    // position every frame across ~2.5 pings.
    // A page starved of frames (a loaded machine) cannot show a glide either
    // way, so sample again (up to eight times) rather than judge two frames a second.
    let sampled = await sampleOnMap(harsh, nMarker, 2600);
    const sampleTries = [Math.round(sampled.fps)];
    while (sampled.fps < MIN_JUDGE_FPS && sampleTries.length < 8) {
      sampled = await sampleOnMap(harsh, nMarker, 2600);
      sampleTries.push(Math.round(sampled.fps));
    }
    const { track: samples, cameraMoves } = sampled;
    await sleep(1500);
    const b = await harsh.marker(nMarker);
    const shotB = await harsh.shot(OUT, '03-nishtha-moving-b');
    const closeB = await closeUp(harsh, nMarker, '03-nishtha-closeup');
    const railText = await harsh.page.innerText('body');

    // Follow mode: the camera rides with Nishtha, so she stays put on screen
    // while the city slides under her; stopping hands the camera back.
    await harsh.page.getByRole('switch', { name: `Follow ${nishtha.displayName} on the map` }).first().click();
    const fromMiddle = ({ v, m }) => (v && m ? Math.hypot(m.x - (v.left + v.width / 2), m.y - (v.top + v.height / 2)) : Infinity);
    const followFrame = async () => ({ v: await harsh.viewport(), m: await harsh.marker(nMarker) });
    // The camera first flies from the framed pair to her (a few hundred metres;
    // slower when the machine is starved of frames), then rides along.
    const followStart = Date.now();
    const followA = await waitFor('the camera to reach Nishtha', async () => {
      const f = await followFrame();
      return fromMiddle(f) <= 40 ? f : null;
    }, { timeout: 15000, every: 250 });
    const followArriveMs = Date.now() - followStart;
    await sleep(2000);
    const followB = await followFrame();
    const followShot = await harsh.shot(OUT, '03-following-nishtha');
    await harsh.page.getByRole('switch', { name: `Stop following ${nishtha.displayName}` }).first().click();
    const follow = {
      offCentrePx: [fromMiddle(followA), fromMiddle(followB)].map((d) => Math.round(d)),
      cameraMovedM: followA.v && followB.v ? Math.round(haversineM(followA.v.center, followB.v.center)) : 0,
      arriveMs: followArriveMs,
    };
    check(follow.offCentrePx.every((d) => d <= 40) && follow.cameraMovedM > 3, `follow mode did not keep Nishtha centred: ${JSON.stringify(follow)}`);
    loop.stop();
    await loop.done.catch(() => {});

    const recH = await harsh.record();
    const lastFix = since(recH.frames, t0h).filter((f) => f.type === 'position' && f.deviceId === facts.nDevice.id).at(-1);
    check(lastFix, 'Harsh received no position frames for Nishtha');
    // Settled: the glide to the last fix has finished.
    await sleep(2200);
    const offN = await markerOffset(harsh, nMarker, { lat: lastFix.lat, lon: lastFix.lon });
    // A glide moves a little on many frames; a jump moves the whole way on one.
    const fixesDuring = since(recH.frames, samples[0]?.t ?? 0).filter(
      (f) => f.type === 'position' && f.deviceId === facts.nDevice.id && f.t <= (samples.at(-1)?.t ?? 0),
    ).length;
    const fixesAtMs = since(recH.frames, samples[0]?.t ?? 0)
      .filter((f) => f.type === 'position' && f.deviceId === facts.nDevice.id && f.t <= (samples.at(-1)?.t ?? 0))
      .map((f) => Math.round(f.t - samples[0].t));
    const glide = { ...glideOf(samples, fixesDuring), cameraMoves, fixesAtMs, sampleTries };
    const latN = latencyFor(recH, facts.nDevice.id, nMarker, t0h);

    check(a && b && (Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2), `Nishtha's marker did not move: ${JSON.stringify({ a, b })}`);
    check(
      sampled.fps >= MIN_JUDGE_FPS,
      `the page rendered ${sampleTries.join(', ')} fps over ${sampleTries.length} samples — too few frames to judge the glide (is the machine overloaded?): ${JSON.stringify(glide)}`,
    );
    check(
      fixesDuring >= 2 && glide.movingMs >= fixesDuring * 10 * FRAME_MS && glide.jumps.length === 0,
      `marker jumped instead of gliding: ${JSON.stringify(glide)}`,
    );
    check(offN !== null && offN <= 3, `Nishtha's marker is ${offN?.toFixed(1)} px from her last fix`);
    check(latN.rendered >= latN.frames - 1 && latN.render.p95 < 250, `render latency: ${JSON.stringify(latN)}`);
    check(/Nishtha[\s\S]{0,200}?(\d+s ago|now)/.test(railText), 'the rail does not show Nishtha’s last-ping age');

    // ---- Harsh moves (browser GPS), Nishtha watches
    const path = Array.from({ length: 8 }, (_, i) => lerp(HARSH_START, { lat: 12.9792, lon: 77.6422 }, (i + 1) / 8));
    const walk = gpsWalk(harsh, path, 2300);
    await waitFor('Harsh’s marker on Nishtha’s map', () => nishtha.marker(hMarker), { timeout: 20000 });
    const c = await nishtha.marker(hMarker);
    await sleep(5000);
    const d = await nishtha.marker(hMarker);
    const shotC = await nishtha.shot(OUT, '03-harsh-moving');
    const closeC = await closeUp(nishtha, hMarker, '03-harsh-closeup');
    await walk;
    await sleep(3000);
    const recN = await nishtha.record();
    const lastH = since(recN.frames, t0n).filter((f) => f.type === 'position' && f.deviceId === facts.hDevice.id).at(-1);
    check(lastH, 'Nishtha received no position frames for Harsh');
    const offH = await markerOffset(nishtha, hMarker, { lat: lastH.lat, lon: lastH.lon });
    const latH = latencyFor(recN, facts.hDevice.id, hMarker, t0n);
    check(c && d && (Math.abs(c.x - d.x) > 2 || Math.abs(c.y - d.y) > 2), `Harsh's marker did not move: ${JSON.stringify({ c, d })}`);
    check(offH !== null && offH <= 3, `Harsh's marker is ${offH?.toFixed(1)} px from his last fix`);
    check(haversineM({ lat: lastH.lat, lon: lastH.lon }, path.at(-1)) < 1, 'Harsh’s last published fix is not where his GPS was');
    check(latH.render.p95 < 250, `render latency: ${JSON.stringify(latH)}`);
    const settled = [await harsh.shot(OUT, '03-settled'), await nishtha.shot(OUT, '03-settled')];

    return {
      nishthaOnHarsh: { latency: latN, glide, offsetPx: Math.round(offN * 10) / 10, follow },
      harshOnNishtha: { latency: latH, offsetPx: Math.round(offH * 10) / 10 },
      shots: [shotA, shotB, closeB, followShot, shotC, closeC, ...settled].filter(Boolean),
    };
  });

  // ---------------------------------------------------------------- 4
  await step('4', 'Harsh draws a polygon, a circle and a freehand fence, and a note for Nishtha', async () => {
    const page = harsh.page;
    // Take the camera: one drag, so the map stops easing to each new fix, and
    // the grocery store in the middle of the view.
    let v = await harsh.stableViewport();
    const mapMid = { x: v.left + v.width / 2, y: v.top + v.height / 2 };
    let g = await harsh.px(GROCERY, v);
    await harsh.drag({ x: mapMid.x + 40, y: mapMid.y + 60 }, { x: mapMid.x + 40 - (g.x - mapMid.x), y: mapMid.y + 60 - (g.y - mapMid.y) });
    v = await harsh.stableViewport();
    // Everything has to be on screen with room for the shapes.
    for (let i = 0; i < 3; i += 1) {
      const all = await Promise.all([GROCERY, PHARMACY, PARK, ROUTE_IN, ROUTE_OUT].map((p) => harsh.px(p, v)));
      const fits = all.every((p) => p.x > v.left + 90 && p.x < v.left + v.width - 90 && p.y > v.top + 110 && p.y < v.top + v.height - 110);
      if (fits) break;
      await page.getByRole('button', { name: 'Zoom out' }).click();
      v = await harsh.stableViewport();
    }
    facts.drawZoom = v.zoom;

    // ---- polygon: tap four corners, then Done
    await page.getByRole('button', { name: 'Draw' }).click();
    await page.getByRole('menuitem', { name: 'Polygon' }).click();
    g = await harsh.px(GROCERY, v);
    const mpp = metresPerPixel(GROCERY.lat, v.zoom);
    const half = Math.max(35, Math.round(75 / mpp)); // ~75 m either side
    const corners = [
      { x: g.x - half, y: g.y - half * 0.9 },
      { x: g.x + half, y: g.y - half },
      { x: g.x + half * 1.05, y: g.y + half * 0.85 },
      { x: g.x - half * 0.9, y: g.y + half },
    ].map(wholePx);
    for (const p of corners) {
      await page.mouse.click(p.x, p.y);
      await sleep(250);
    }
    await page.getByText('4 corners · tap the first corner or Done to close').waitFor({ timeout: 5000 });
    await harsh.shot(OUT, '04-polygon-drawing');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByText('Polygon with 4 corners').waitFor({ timeout: 5000 });
    const expected = await Promise.all(corners.map((p) => harsh.ground(p.x, p.y, v)));

    const fillForm = async (name, { triggers, watch }) => {
      await page.getByPlaceholder('Whole Foods').fill(name);
      for (const t of ['Arrive', 'Leave', 'Dwell', 'Pass by']) {
        const box = page.getByRole('checkbox', { name: new RegExp(`^${t}`) }).first();
        const on = (await box.getAttribute('aria-checked')) === 'true';
        if (on !== triggers.includes(t)) await box.click();
      }
      if (watch) await page.getByRole('checkbox', { name: watch, exact: true }).click();
      const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/places') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Create place' }).click();
      const res = await created;
      check(res.status() === 201 || res.status() === 200, `creating ${name}: HTTP ${res.status()} ${await res.text()}`);
      await sleep(600);
    };
    await harsh.shot(OUT, '04-polygon-form');
    await fillForm('Grocery', { triggers: ['Arrive', 'Leave', 'Pass by'], watch: 'Nishtha' });

    // ---- circle: press the centre, drag out the radius
    await page.getByRole('button', { name: 'Draw' }).click();
    await page.getByRole('menuitem', { name: 'Circle' }).click();
    v = await harsh.stableViewport();
    const pc = wholePx(await harsh.px(PHARMACY, v));
    const radiusPx = Math.round(70 / metresPerPixel(PHARMACY.lat, v.zoom));
    await harsh.drag(pc, { x: pc.x + radiusPx, y: pc.y });
    await page.getByText(/^Circle of /).waitFor({ timeout: 5000 });
    const circleCenter = await harsh.ground(pc.x, pc.y, v);
    const circleRadius = haversineM(circleCenter, await harsh.ground(pc.x + radiusPx, pc.y, v));
    await fillForm('Pharmacy', { triggers: ['Arrive'] });

    // ---- freehand: one stroke around the park
    await page.getByRole('button', { name: 'Draw' }).click();
    await page.getByRole('menuitem', { name: 'Freehand' }).click();
    v = await harsh.stableViewport();
    const pk = await harsh.px(PARK, v);
    const r = Math.round(60 / metresPerPixel(PARK.lat, v.zoom));
    const stroke = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * 2 * Math.PI;
      return { x: pk.x + r * Math.cos(a) * (1 + 0.15 * Math.sin(3 * a)), y: pk.y + r * 0.8 * Math.sin(a) };
    });
    await page.mouse.move(stroke[0].x, stroke[0].y);
    await page.mouse.down();
    for (const p of stroke.slice(1)) {
      await page.mouse.move(p.x, p.y);
      await sleep(12);
    }
    await page.mouse.up();
    await page.getByText(/^Polygon with \d+ corners/).waitFor({ timeout: 5000 });
    await fillForm('Park', { triggers: ['Arrive', 'Leave'] });
    const fencesShot = await harsh.shot(OUT, '04-fences');

    // ---- the API agrees, to the metre
    const grocery = await placeNamed(harsh, 'Grocery');
    const pharmacy = await placeNamed(harsh, 'Pharmacy');
    const park = await placeNamed(harsh, 'Park');
    check(grocery?.shape === 'polygon' && grocery.polygon.length === 4, `Grocery: ${JSON.stringify(grocery)}`);
    const vertexErr = Math.max(...grocery.polygon.map((p, i) => haversineM(p, expected[i])));
    // A click lands on a whole pixel, so "to the metre" means within a pixel.
    const pxM = metresPerPixel(GROCERY.lat, facts.drawZoom);
    check(vertexErr < Math.max(2, pxM), `Grocery's corners are up to ${vertexErr.toFixed(1)} m from where they were clicked (1 px = ${pxM.toFixed(1)} m)`);
    check(['arrive', 'leave', 'passby'].every((t) => grocery.triggers.includes(t)), `Grocery triggers: ${grocery.triggers}`);
    check(grocery.watchUserIds.length === 1 && grocery.watchUserIds[0] === nishtha.id, `Grocery watches ${grocery.watchUserIds}`);
    check(pointInPolygon(GROCERY, grocery.polygon), 'the store is not inside its own fence');
    check(pharmacy?.shape === 'circle' && pharmacy.polygon.length === 0, `Pharmacy: ${JSON.stringify(pharmacy)}`);
    const centreErr = haversineM(pharmacy.center, circleCenter);
    check(centreErr < Math.max(2, pxM), `Pharmacy centre is ${centreErr.toFixed(1)} m off`);
    check(Math.abs(pharmacy.radiusM - circleRadius) <= Math.max(3, circleRadius * 0.05), `Pharmacy radius ${pharmacy.radiusM} vs drawn ${circleRadius.toFixed(0)}`);
    check(park?.shape === 'polygon' && park.polygon.length >= 3 && park.polygon.length <= 60, `Park: ${park?.polygon.length} vertices`);
    check(pointInPolygon(PARK, park.polygon), 'the park is not inside its freehand outline');
    facts.grocery = grocery;
    facts.pharmacy = pharmacy;

    // ---- the note: when Nishtha arrives at Grocery, tell both of us
    await harsh.nav('Notes');
    await page.getByPlaceholder(/^e\.g\. buy oat milk/).fill('buy milk');
    await sleep(700);
    await page.getByRole('radio', { name: /^Grocery/ }).click();
    await page.getByRole('radio', { name: /^Arrive/ }).click();
    await page.getByRole('radio', { name: 'Nishtha', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Nishtha', exact: true }).click();
    await page.getByText(/Nishtha arrives at Grocery/).first().waitFor({ timeout: 5000 });
    const noteShot = await harsh.shot(OUT, '04-note-composer');
    const posted = page.waitForResponse((res) => res.url().endsWith('/api/v1/notes') && res.request().method() === 'POST');
    await page.getByRole('button', { name: 'Add note' }).click();
    check((await posted).ok(), 'creating the note failed');
    const { notes } = await harsh.api('GET', '/api/v1/notes');
    const note = notes.find((n) => n.text === 'buy milk');
    check(note, 'the note is not in the API');
    check(note.placeId === grocery.id && note.trigger === 'arrive', `note place/trigger: ${note.placeId} ${note.trigger}`);
    check(note.watchUserId === nishtha.id, `note watches ${note.watchUserId}`);
    check(note.notifyUserIds.length === 2 && note.notifyUserIds.includes(harsh.id) && note.notifyUserIds.includes(nishtha.id), `note notifies ${note.notifyUserIds}`);
    facts.note = note;
    await harsh.nav('Live map');
    return {
      grocery: { vertices: grocery.polygon.length, vertexErrM: Math.round(vertexErr * 100) / 100, watch: grocery.watchUserIds },
      pharmacy: { radiusM: pharmacy.radiusM, drawnM: Math.round(circleRadius) },
      park: { vertices: park.polygon.length },
      note: { watchUserId: note.watchUserId, notifyUserIds: note.notifyUserIds },
      shots: [fencesShot, noteShot],
    };
  });

  // ---------------------------------------------------------------- 5
  /**
   * survivesRestart restarts Lura (E2E_STORE=postgres, lib/server.mjs) with both
   * browsers open, then checks that nothing was lost — the edited fences, the
   * note, the connection, the devices — and that both apps reconnect on their
   * own: the live banner clears and a fix Nishtha sends after the restart
   * reaches Harsh's map.
   */
  async function survivesRestart({ pharmacy, grocery }) {
    const before = {
      people: await Promise.all(people.map(async (p) => (await p.api('GET', '/api/v1/people')).people.map((r) => [r.peerId, r.status, r.sharing]))),
      notes: (await harsh.api('GET', '/api/v1/notes')).notes.map((n) => n.id).sort(),
      devices: (await nishtha.api('GET', '/api/v1/devices')).devices.map((d) => d.id).sort(),
    };
    const r = await restartServer({ downMs: 1500 });
    const back = Date.now();
    // Both apps notice and reconnect without a reload.
    for (const p of people) {
      await waitFor(`${p.name}’s live banner to clear after the restart`, async () =>
        (await p.page.getByTestId('lura-live-banner').count()) === 0, { timeout: 30000, every: 250 });
    }
    const reconnectMs = Date.now() - back;
    const after = {
      people: await Promise.all(people.map(async (p) => (await p.api('GET', '/api/v1/people')).people.map((x) => [x.peerId, x.status, x.sharing]))),
      notes: (await harsh.api('GET', '/api/v1/notes')).notes.map((n) => n.id).sort(),
      devices: (await nishtha.api('GET', '/api/v1/devices')).devices.map((d) => d.id).sort(),
    };
    check(JSON.stringify(after) === JSON.stringify(before), `the restart lost data: ${JSON.stringify({ before, after })}`);
    const p2 = await placeNamed(harsh, 'Pharmacy');
    const g2 = await placeNamed(harsh, 'Grocery');
    check(p2 && haversineM(p2.center, pharmacy.center) < 0.01 && p2.radiusM === pharmacy.radiusM, `the circle changed across the restart: ${JSON.stringify(p2)}`);
    check(g2 && g2.polygon.length === grocery.polygon.length && g2.polygon.every((q, i) => haversineM(q, grocery.polygon[i]) < 0.01), 'the polygon changed across the restart');
    // Fixes sent after the restart go all the way to the other browser: out to
    // a turning point and back (lurasim closes its route), drawn as they come.
    const nMarker = `peer_${facts.nDevice.id}`;
    const turn = NISHTHA_LOOP[1];
    const tSim = await pageNow(harsh);
    const run = sim(facts.nDevice, [NISHTHA_START, turn], { interval: '700ms', scale: 2 });
    await run.done;
    const seen = await waitFor('Nishtha’s post-restart fixes on Harsh’s map', async () => {
      const m = await harsh.marker(nMarker);
      return m && haversineM(m, NISHTHA_START) < 10 ? m : null;
    }, { timeout: 20000 });
    const frames = since((await harsh.record()).frames, tSim).filter((f) => f.type === 'position' && f.deviceId === facts.nDevice.id);
    check(frames.some((f) => haversineM(f, turn) < 10), `Harsh's app never got the turning-point fix after the restart (${frames.length} frames)`);
    const shots = [await harsh.shot(OUT, '05-after-restart'), await nishtha.shot(OUT, '05-after-restart')];
    return { downMs: r.readyAt - r.stoppedAt, reconnectMs, kept: { people: after.people.map((x) => x.length), notes: after.notes.length, devices: after.devices.length }, framesAfter: frames.length, markerErrM: Math.round(haversineM(seen, NISHTHA_START) * 10) / 10, shots };
  }

  await step('5', 'Harsh moves and resizes the circle, reshapes the polygon; both persist', async () => {
    const page = harsh.page;
    await harsh.stableViewport();

    // ---- circle: move by its body, resize by its edge handle
    await page.getByRole('button', { name: 'Place Pharmacy' }).first().click();
    await page.getByRole('button', { name: 'Edit shape' }).click();
    await page.getByText('Drag the circle to move it · drag the edge handle to resize').waitFor();
    let v = await harsh.stableViewport();
    // The editor moves the shape by the pointer's travel, so the expectation is
    // the exact centre plus that travel; the pointer itself lands on whole pixels.
    const exactFrom = await harsh.px(facts.pharmacy.center, v);
    const from = wholePx(exactFrom);
    const delta = { x: 70, y: 45 };
    const moveTo = { x: from.x + delta.x, y: from.y + delta.y };
    const expectCenter = await harsh.ground(exactFrom.x + delta.x, exactFrom.y + delta.y, v);
    let patched = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${facts.pharmacy.id}`) && r.request().method() === 'PATCH');
    await harsh.drag(from, moveTo);
    check((await patched).ok(), 'moving the circle failed to save');
    // Grabbing the fence must move the fence, not the map under it.
    let after = await harsh.stableViewport();
    check(sameView(v, after), `the map panned while the circle was dragged: ${JSON.stringify({ before: v.center, after: after.center })}`);

    v = after;
    const centerPx = await harsh.px(expectCenter, v);
    const exactEdge = { x: centerPx.x + facts.pharmacy.radiusM / metresPerPixel(expectCenter.lat, v.zoom), y: centerPx.y };
    const edge = wholePx(exactEdge);
    const expectRadius = haversineM(expectCenter, await harsh.ground(exactEdge.x + 40, exactEdge.y, v));
    patched = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${facts.pharmacy.id}`) && r.request().method() === 'PATCH');
    // Halfway through the drag the radius label already says the new size.
    const m = page.mouse;
    await m.move(edge.x, edge.y);
    await m.down();
    await sleep(60);
    for (let i = 1; i <= 6; i += 1) {
      await m.move(edge.x + (20 * i) / 6, edge.y);
      await sleep(16);
    }
    const midRadius = haversineM(expectCenter, await harsh.ground(exactEdge.x + 20, exactEdge.y, v));
    const midLabel = await waitFor('the live radius label mid-drag', async () => {
      const text = await page.getByTestId('fence-metre-label').first().innerText().catch(() => '');
      const n = Number(/(\d+)\s*m/.exec(text)?.[1]);
      return Math.abs(n - midRadius) <= 2 ? text : null;
    }, { timeout: 3000, every: 50 });
    const resizingShot = await harsh.shot(OUT, '05-circle-resizing');
    for (let i = 1; i <= 6; i += 1) {
      await m.move(edge.x + 20 + (20 * i) / 6, edge.y);
      await sleep(16);
    }
    await m.up();
    check((await patched).ok(), 'resizing the circle failed to save');
    after = await harsh.stableViewport();
    check(sameView(v, after), 'the map panned while the edge handle was dragged');
    const editShot = await harsh.shot(OUT, '05-circle-edited');
    await page.getByRole('button', { name: 'Done', exact: true }).click();

    // ---- polygon: drag the north-east corner out. Editing the circle zoomed in
    // on it, so first zoom out until the grocery is back on screen, as a person would.
    await revealPlace('Grocery');
    await page.getByRole('button', { name: 'Place Grocery' }).first().click();
    await page.getByRole('button', { name: 'Edit shape' }).click();
    await page.getByText(/4 corners · up to/).waitFor();
    v = await harsh.stableViewport();
    const exactCorner = await harsh.px(facts.grocery.polygon[1], v);
    const corner = wholePx(exactCorner);
    const cornerTo = { x: corner.x + 30, y: corner.y - 25 };
    const expectCorner = await harsh.ground(exactCorner.x + 30, exactCorner.y - 25, v);
    patched = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${facts.grocery.id}`) && r.request().method() === 'PATCH');
    await harsh.drag(corner, cornerTo, { hold: 30 });
    check((await patched).ok(), 'reshaping the polygon failed to save');
    after = await harsh.stableViewport();
    check(sameView(v, after), 'the map panned while a corner was dragged');
    const reshapeShot = await harsh.shot(OUT, '05-polygon-reshaped');
    await page.getByRole('button', { name: 'Done', exact: true }).click();

    // ---- reload: what the server kept is what comes back
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 20000 });
    const pharmacy = await placeNamed(harsh, 'Pharmacy');
    const grocery = await placeNamed(harsh, 'Grocery');
    const centerErr = haversineM(pharmacy.center, expectCenter);
    const moved = haversineM(pharmacy.center, facts.pharmacy.center);
    check(moved > 30, `the circle only moved ${moved.toFixed(1)} m`);
    check(centerErr < 3, `the circle's centre is ${centerErr.toFixed(1)} m from where it was dropped`);
    check(Math.abs(pharmacy.radiusM - expectRadius) <= Math.max(3, expectRadius * 0.05), `radius ${pharmacy.radiusM} vs dragged ${expectRadius.toFixed(0)}`);
    check(pharmacy.radiusM > facts.pharmacy.radiusM + 10, 'the circle did not grow');
    const cornerErr = haversineM(grocery.polygon[1], expectCorner);
    check(grocery.polygon.length === 4 && cornerErr < 3, `the moved corner is ${cornerErr.toFixed(1)} m off`);
    for (const i of [0, 2, 3]) {
      check(haversineM(grocery.polygon[i], facts.grocery.polygon[i]) < 0.5, `corner ${i} moved but should not have`);
    }
    check(pointInPolygon(GROCERY, grocery.polygon), 'the store fell out of its fence');
    await waitFor('the Pharmacy badge to show the new radius after reload', async () =>
      (await page.innerText('body')).includes(`${pharmacy.radiusM}m`),
    );
    // The reshaped outline is what the map draws again, not only what the API
    // says: a click just beyond where the old corner was, inside the new one,
    // lands on the Grocery fence and selects it.
    const oldCorner = facts.grocery.polygon[1];
    const probe = {
      lat: oldCorner.lat + (grocery.polygon[1].lat - oldCorner.lat) * 0.6,
      lon: oldCorner.lon + (grocery.polygon[1].lon - oldCorner.lon) * 0.6,
    };
    check(pointInPolygon(probe, grocery.polygon) && !pointInPolygon(probe, facts.grocery.polygon), 'probe point is not in the reshaped area');
    await revealPlace('Grocery');
    const redrawn = await waitFor('a click in the reshaped corner to select Grocery', async () => {
      const at = wholePx(await harsh.px(probe));
      await page.mouse.click(at.x, at.y);
      await sleep(400);
      const card = await page.getByRole('button', { name: 'Deselect place' }).count();
      const text = await page.innerText('body');
      return card && /Grocery[\s\S]{0,40}polygon · 4 corners/.test(text) ? at : null;
    }, { timeout: 20000, every: 800 });
    await page.getByRole('button', { name: 'Deselect place' }).click();
    facts.grocery = grocery;
    facts.pharmacy = pharmacy;
    const afterReloadShot = await harsh.shot(OUT, '05-after-reload');
    // On Postgres, the edits must outlive the server too, and both open apps
    // must come back to life without a reload.
    const restart = canKeepData() ? await survivesRestart({ pharmacy, grocery }) : undefined;
    return {
      circle: { movedM: Math.round(moved), centreErrM: Math.round(centerErr * 100) / 100, radiusM: pharmacy.radiusM, expectedRadiusM: Math.round(expectRadius) },
      polygon: { cornerErrM: Math.round(cornerErr * 100) / 100 },
      liveRadiusLabel: midLabel,
      reshapedCornerClick: redrawn,
      restart,
      shots: [resizingShot, editShot, reshapeShot, afterReloadShot, ...(restart?.shots ?? [])],
    };
  });

  // ---------------------------------------------------------------- 6
  /**
   * toastOnScreen returns the text of a live toast whose label matches, once its
   * text matches too: what the person can read right now.
   */
  const toastOnScreen = (person, label, text) =>
    person.page.evaluate(
      ({ l, t }) => {
        const el = [...document.querySelectorAll('[aria-label$="Show on the map."]')].find(
          (n) => !n.closest('[aria-modal="true"]') && new RegExp(l).test(n.getAttribute('aria-label')),
        );
        return el && new RegExp(t).test(el.innerText) ? el.innerText.replace(/\s+/g, ' ') : null;
      },
      { l: label.source, t: text.source },
    );

  /** toastsSettled waits for every toast's entrance to finish, so a screenshot shows it as people see it. */
  const toastsSettled = (person) =>
    waitFor(`${person.name}’s toasts to finish appearing`, () =>
      person.page.evaluate(() =>
        [...document.querySelectorAll('[aria-label$="Show on the map."]')]
          .filter((n) => !n.closest('[aria-modal="true"]'))
          .every((n) => Number(getComputedStyle(n.parentElement).opacity) > 0.99),
      ),
    { timeout: 3000, every: 50 });

  /**
   * hideTab makes a page report itself hidden (another window in front), and
   * records the system notifications it raises from then on, after the browser
   * accepted them.
   */
  const hideTab = (person) =>
    person.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      const Native = window.Notification;
      const shown = (window.__luraDesktop = []);
      class Recorded extends Native {
        constructor(title, options) {
          super(title, options);
          shown.push({ t: performance.now(), title, body: options?.body ?? '', tag: options?.tag ?? '' });
        }
      }
      Object.defineProperty(Recorded, 'permission', { get: () => Native.permission });
      Recorded.requestPermission = Native.requestPermission.bind(Native);
      window.Notification = Recorded;
    });
  const showTab = (person) =>
    person.page.evaluate(() => {
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      return window.__luraDesktop ?? [];
    });

  const crossing = (dwell = 8) => [
    { ...ROUTE_IN },
    { ...GROCERY, dwell },
    { ...ROUTE_OUT },
    { ...ROUTE_HOME },
  ];

  await step('6', 'Nishtha passes the grocery: toasts, badges and one chime per crossing, both browsers', async () => {
    const t0h = await pageNow(harsh);
    const t0n = await pageNow(nishtha);
    const badge0 = { h: await unreadBadge(harsh), n: await unreadBadge(nishtha) };
    // Nishtha's Lura tab is behind another window this time: her reminder must
    // also reach the desktop. Harsh is looking at his, so his stays in the app.
    await hideTab(nishtha);
    await harsh.page.evaluate(() => {
      const Native = window.Notification;
      const shown = (window.__luraDesktop = []);
      window.Notification = class extends Native {
        constructor(title, options) {
          super(title, options);
          shown.push({ title });
        }
      };
    });
    const run = sim(facts.nDevice, crossing(), { interval: '700ms', scale: 4 });
    // Screenshots while she is at the shop: the arrival ripple and the toasts.
    await waitFor('Harsh’s arrive toast', async () => (await toastsSince(harsh, t0h)).some((t) => /arrived at Grocery|buy milk/i.test(t.label + t.text)), { timeout: 60000 });
    // The geo frame raises the toast and the reminder frame for the same
    // crossing fills in the note a moment later, so the note is asserted on
    // the toast as it is on screen, not on its first paint.
    const arriveOnScreen = {
      harsh: await waitFor('the note on Harsh’s arrive toast', () => toastOnScreen(harsh, /arrived at Grocery/, /buy milk/), { timeout: 5000, every: 50 }),
      nishtha: await waitFor('Nishtha’s "buy milk" toast', () => toastOnScreen(nishtha, /Grocery/, /buy milk[\s\S]*from Harsh/), { timeout: 15000, every: 50 }),
    };
    await Promise.all([toastsSettled(harsh), toastsSettled(nishtha)]);
    const atShop = [await harsh.shot(OUT, '06-arrive-harsh'), await nishtha.shot(OUT, '06-arrive-nishtha')];
    await run.done;
    await sleep(2500);
    const desktop = { nishtha: await showTab(nishtha), harsh: await harsh.page.evaluate(() => window.__luraDesktop ?? []) };

    const recH = await harsh.record();
    const recN = await nishtha.record();
    const geoH = since(recH.frames, t0h).filter((f) => f.type === 'geo' && f.data.placeId === facts.grocery.id);
    const notifyH = since(recH.frames, t0h).filter((f) => f.type === 'notify');
    const notifyN = since(recN.frames, t0n).filter((f) => f.type === 'notify');
    const geoN = since(recN.frames, t0n).filter((f) => f.type === 'geo');
    const triggers = geoH.map((f) => f.data.trigger);
    for (const t of ['passby', 'arrive', 'leave']) check(triggers.includes(t), `Harsh got no ${t} event; got ${triggers}`);
    check(geoH.every((f) => f.data.subjectUserId === nishtha.id && f.data.userId === harsh.id), 'geo events name the wrong owner/subject');
    check(new Set(geoH.map((f) => f.data.id)).size === geoH.length, 'a crossing was published twice');
    check(notifyH.some((f) => f.data.kind === 'watch'), 'Harsh got no watch reminder');
    check(notifyH.some((f) => f.data.kind === 'note' && /buy milk/.test(`${f.data.title} ${f.data.body}`)), 'Harsh got no "buy milk" reminder');
    check(notifyN.length === 1 && notifyN[0].data.kind === 'note', `Nishtha got ${notifyN.length} reminders: ${JSON.stringify(notifyN.map((f) => f.data))}`);
    check(/buy milk/.test(`${notifyN[0].data.title} ${notifyN[0].data.body}`) && /Harsh/.test(notifyN[0].data.fromName ?? ''), 'Nishtha’s reminder is not "buy milk" from Harsh');
    check(geoN.length === 0, 'Nishtha was told about a fence she does not own');

    // UI: one notice per crossing, the badge counts them, one chime each. A
    // pending reminder is a sticky card that replaces its crossing's toast, so
    // a toast and its card are one notice (both name the crossing).
    const oneEach = (list) => {
      const first = new Map();
      for (const x of list) {
        const key = x.notice || `${x.label}|${x.text}`;
        if (!first.has(key)) first.set(key, x);
      }
      return [...first.values()];
    };
    const toastsH = oneEach(since(recH.toasts, t0h));
    const toastsN = oneEach(since(recN.toasts, t0n));
    const crossings = new Set(geoH.map((f) => f.data.id)).size;
    const chimesH = chimes(since(recH.notes, t0h));
    const chimesN = chimes(since(recN.notes, t0n));
    const badge = { h: await unreadBadge(harsh), n: await unreadBadge(nishtha) };
    check(toastsH.length === crossings, `Harsh saw ${toastsH.length} notices for ${crossings} crossings: ${toastsH.map((t) => t.label)}`);
    check(toastsH.some((t) => /passed by Grocery/.test(t.label)), 'no pass-by toast for Harsh');
    check(toastsH.some((t) => /left Grocery/.test(t.label)), 'no leave toast for Harsh');
    check(toastsH.some((t) => /arrived at Grocery/.test(t.label)) && arriveOnScreen.harsh, 'the arrive toast for Harsh does not carry the note');
    check(toastsN.length === 1 && /buy milk/.test(toastsN[0].label + toastsN[0].text) && /from Harsh/.test(toastsN[0].text), `Nishtha's toasts: ${JSON.stringify(toastsN)}`);
    check(badge.h - badge0.h === crossings, `Harsh's badge went ${badge0.h} → ${badge.h} for ${crossings} crossings`);
    check(badge.n - badge0.n === 1, `Nishtha's badge went ${badge0.n} → ${badge.n}`);
    check(chimesH.length === crossings, `Harsh heard ${chimesH.length} chimes for ${crossings} crossings: ${JSON.stringify(chimesH)}`);
    check(chimesN.length === 1, `Nishtha heard ${chimesN.length} chimes: ${JSON.stringify(chimesN)}`);
    // Each trigger has its own chime, watched person or not (release spec §4).
    check(JSON.stringify(chimesH.map((c) => c.kind)) === JSON.stringify(triggers), `Harsh's chimes ${chimesH.map((c) => c.kind)} do not follow the crossings ${triggers}`);
    check(chimesN[0].kind === 'arrive', `Nishtha's chime is ${chimesN[0].kind}, not arrive`);
    // Hidden tab: one system notification, the note, from Harsh. It is a
    // pending reminder, so it is tagged with the stored reminder (a repeat
    // replaces it in place rather than stacking another).
    const reminderTag = `reminder:${notifyN[0].data.id}`;
    check(
      desktop.nishtha.length >= 1 &&
        desktop.nishtha.every((d) => d.tag === reminderTag) &&
        /Grocery/.test(desktop.nishtha[0].title) && /buy milk/.test(desktop.nishtha[0].body) && /from Harsh/.test(desktop.nishtha[0].body),
      `Nishtha's hidden tab raised ${JSON.stringify(desktop.nishtha)} (reminder ${reminderTag})`,
    );
    check(desktop.harsh.length === 0, `Harsh's visible tab raised system notifications: ${JSON.stringify(desktop.harsh)}`);
    // The toast follows the frame within a frame or two.
    const lagH = toastsH.map((t) => {
      const f = recH.frames.filter((x) => (x.type === 'geo' || x.type === 'notify') && x.t <= t.t).at(-1);
      return f ? t.t - f.t : NaN;
    });

    // The notification centre lists what happened.
    const panels = [];
    for (const p of [harsh, nishtha]) {
      await p.page.locator('[aria-label^="Notifications"]').first().click();
      await sleep(600);
      panels.push(await p.shot(OUT, '06-notification-centre'));
      await p.page.getByRole('button', { name: 'Close', exact: true }).click().catch(() => p.page.keyboard.press('Escape'));
    }
    facts.lastFireWall = Date.now();
    return {
      events: triggers,
      toasts: { harsh: toastsH.map((t) => t.label.replace(/\. Show on the map\.$/, '')), nishtha: toastsN.map((t) => t.label.replace(/\. Show on the map\.$/, '')) },
      chimes: { harsh: chimesH.map((c) => c.kind), nishtha: chimesN.map((c) => c.kind) },
      badges: { before: badge0, after: badge },
      toastLagMs: stats(lagH.filter(Number.isFinite)),
      onScreen: arriveOnScreen,
      desktop: { nishtha: desktop.nishtha.map((d) => `${d.title} — ${d.body}`), harsh: desktop.harsh.length },
      shots: [...atShop, ...panels],
    };
  });

  // ---------------------------------------------------------------- 7
  await step('7', `Basemaps on ${PROVIDER}: every style loads tiles and keeps fences and markers`, async () => {
    const page = harsh.page;
    await basemapsReady(harsh);
    const all = [
      ['streets', 'Streets'],
      ['satellite', 'Satellite'],
      ['hybrid', 'Hybrid'],
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['terrain', 'Terrain'],
    ];
    // Choosing the basemap that is already showing changes nothing and loads
    // no tile, so the current one is visited last, coming back from another.
    const current = (await page.locator('[aria-label^="Change basemap"]').getAttribute('aria-label')) ?? '';
    const at = Math.max(0, all.findIndex(([, label]) => current.endsWith(label)));
    const ids = [...all.slice(at + 1), ...all.slice(0, at + 1)];
    const out = {};
    const shots = [];
    for (const [id, label] of ids) {
      const t = Date.now();
      await page.locator('[aria-label^="Change basemap"]').click();
      await page.getByRole('radio', { name: `${label} map` }).click();
      await sleep(2500);
      await harsh.stableViewport(600);
      const tiles = harsh.tiles.filter((x) => x.at >= t);
      const ok = tiles.filter((x) => x.status === 200);
      const hosts = [...new Set(ok.map((x) => new URL(x.url).host))];
      const failed = tiles.filter((x) => x.status >= 400);
      const label0 = await page.locator('[aria-label^="Change basemap"]').getAttribute('aria-label');
      check(label0?.includes(label), `the picker says ${label0} after choosing ${label}`);
      check(ok.length > 0, `${label}: no tile loaded (${tiles.length} requests)`);
      // Mappls' tile CDN answers a few tiles of every load with 412 (base,
      // label, indoor) or 408 (the "sea" world tiles) — 2 to 5 of ~20 in every
      // run on this key — and draws the map regardless. That is theirs, not
      // Lura's: it is reported, and only fails the step if it stops being a
      // few. Every other tile server must answer every tile.
      const ours = failed.filter((f) => !isMapplsTile(f.url));
      const theirs = failed.length - ours.length;
      check(ours.length === 0, `${label}: ${ours.length} tiles failed: ${ours.slice(0, 3).map((f) => `${f.status} ${redactKey(f.url)}`)}`);
      check(theirs <= Math.max(5, ok.length * 0.35), `${label}: ${theirs} of ${tiles.length} Mappls tiles failed`);
      const drawn = await drawnBy(harsh);
      const mapplsOk = ok.filter((x) => isMapplsTile(x.url)).length;
      // The credit follows whoever draws: Mappls credits itself (and Lura's
      // chip must not cover its logo); anything else is credited by Lura.
      check(
        drawn.renderer === 'mappls'
          ? drawn.credit === '' && /MapmyIndia/.test(drawn.sdkCredit)
          : drawn.credit !== '' && !/Mappls/.test(drawn.credit),
        `${label}: drawn by ${drawn.renderer} but credited "${drawn.credit}" (SDK: "${drawn.sdkCredit.slice(0, 80)}")`,
      );
      if (drawn.renderer === 'mappls') check(mapplsOk > 0, `${label}: the Mappls map loaded no Mappls tile`);
      check(await page.getByRole('button', { name: 'Place Grocery' }).count(), `${label}: the Grocery label is gone`);
      check(await harsh.marker(`peer_${facts.nDevice.id}`), `${label}: Nishtha's marker is gone`);
      const edge = await edgeHasFenceColour(harsh, facts.grocery.polygon);
      check(edge.hits >= edge.probes * 0.5, `${label}: the Grocery outline is not drawn (${edge.hits}/${edge.probes} edge probes)`);
      shots.push(await harsh.shot(OUT, `07-basemap-${id}`));
      out[id] = {
        renderer: drawn.renderer,
        tiles: ok.length,
        hosts,
        ...(theirs ? { mapplsTileRetries: theirs } : {}),
        edge: `${edge.hits}/${edge.probes}`,
      };
    }
    if (PROVIDER === 'mappls') {
      // Mappls must actually draw what it has a style for. If it handed every
      // basemap to MapLibre, say why rather than passing on MapLibre's tiles.
      const byMappls = Object.entries(out).filter(([, r]) => r.renderer === 'mappls').map(([id]) => id);
      const statuses = {};
      for (const x of harsh.tiles.filter((x) => isMapplsTile(x.url))) statuses[x.status] = (statuses[x.status] ?? 0) + 1;
      check(byMappls.length > 0, `Mappls drew no basemap (Mappls tile statuses ${JSON.stringify(statuses)}); MapLibre drew them all`);
      out.mappls = { drew: byMappls, tileStatuses: statuses };
    }
    // Back to streets for the rest of the run.
    await page.locator('[aria-label^="Change basemap"]').click();
    await page.getByRole('radio', { name: 'Streets map' }).click();
    // The choice is per viewer and survives a reload.
    await page.locator('[aria-label^="Change basemap"]').click();
    await page.getByRole('radio', { name: 'Satellite map' }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 20000 });
    const persisted = await page.locator('[aria-label^="Change basemap"]').getAttribute('aria-label');
    check(persisted?.includes('Satellite'), `basemap not persisted: ${persisted}`);
    await page.locator('[aria-label^="Change basemap"]').click();
    await page.getByRole('radio', { name: 'Streets map' }).click();
    return { ...out, persisted, shots };
  });

  // ---------------------------------------------------------------- 8
  // The cool-off the engine applies between two firings of one fence (run.sh
  // shortens it to 15 s). A privacy check that crosses a fence inside it would
  // pass even if the gate leaked, so each crossing below waits it out first.
  const COOLOFF_MS = Number(process.env.E2E_COOLOFF_MS ?? 16000);
  const waitCooloff = async (since) => {
    const wait = COOLOFF_MS - (Date.now() - (since ?? 0));
    if (wait > 0) await sleep(wait);
  };

  /**
   * wireSocket opens the live socket as a person straight from Node, outside the
   * browser, so what the server is willing to send is checked on its own rather
   * than through whatever the app chooses to draw.
   */
  async function wireSocket(person) {
    const base = (process.env.E2E_API ?? 'http://localhost:8080').replace(/^http/, 'ws');
    const ws = new WebSocket(`${base}/ws?access_token=${encodeURIComponent(await person.token())}`);
    const frames = [];
    ws.addEventListener('message', (ev) => {
      try {
        const f = JSON.parse(ev.data);
        frames.push({ wall: Date.now(), type: f.type, data: f.data });
      } catch {
        // not a frame
      }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`${person.name}: the live socket did not open`)), { once: true });
    });
    return { frames, since: (t) => frames.filter((f) => f.wall >= t), close: () => ws.close() };
  }

  /** aboutPeer is what in a set of wire frames concerns this peer's device or a fence watching them. */
  const aboutPeer = (frames, deviceId, peerId) =>
    frames.filter(
      (f) =>
        (f.type === 'position' && f.data?.deviceId === deviceId) ||
        (f.type === 'geo' && f.data?.subjectUserId === peerId) ||
        f.type === 'notify',
    );

  /** pathsWith lists the JSON paths in a value whose string contains needle. */
  const pathsWith = (v, needle, at = '$') => {
    if (typeof v === 'string') return v.includes(needle) ? [at] : [];
    if (Array.isArray(v)) return v.flatMap((x, i) => pathsWith(x, needle, `${at}[${i}]`));
    if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => pathsWith(x, needle, `${at}.${k}`));
    return [];
  };

  const eventCount = async (person) => (await person.api('GET', '/api/v1/events?limit=500')).events.length;

  await step('8', 'Pause stops positions and the watched fence; resume restores; remove ends it', async () => {
    const nMarker = `peer_${facts.nDevice.id}`;
    const hMarker = `peer_${facts.hDevice.id}`;
    // A second crossing of Grocery is only allowed to fire once the cool-off
    // since step 6's has passed (no wait when step 6 did not run).
    await waitCooloff(facts.lastFireWall);

    // ---- pause
    await nishtha.nav('People');
    const toggle = nishtha.page.getByRole('switch', { name: /^Share my live location with Harsh/ });
    check((await toggle.getAttribute('aria-checked')) === 'true', 'Nishtha’s switch is not on');
    const paused = nishtha.page.waitForResponse((r) => r.url().includes('/api/v1/people/') && r.request().method() === 'PATCH');
    await toggle.click();
    check((await paused).ok(), 'pausing failed');
    const tPause = await pageNow(harsh);
    await waitFor('Nishtha’s switch to read off', async () => (await toggle.getAttribute('aria-checked')) === 'false', { timeout: 5000 });
    await waitFor('Harsh’s People row to say Nishtha stopped sharing', async () => {
      const { people: rows } = await harsh.api('GET', '/api/v1/people');
      return rows.find((r) => r.peerId === nishtha.id)?.sharingWithMe === false;
    });
    await waitFor('Nishtha’s marker to leave Harsh’s map', async () => !(await harsh.marker(nMarker)), { timeout: 8000 });
    const tGone = await pageNow(harsh);
    const wireP = await wireSocket(harsh);
    const eventsP = await eventCount(harsh);
    const pausedRun = sim(facts.nDevice, crossing(4), { interval: '700ms', scale: 4 });
    await pausedRun.done;
    await sleep(2000);
    let recH = await harsh.record();
    const leaked = since(recH.frames, tPause + 1500).filter(
      (f) => (f.type === 'position' && f.deviceId === facts.nDevice.id) || f.type === 'geo' || f.type === 'notify',
    );
    check(leaked.length === 0, `Harsh still received ${leaked.length} frames about Nishtha while paused: ${JSON.stringify(leaked.slice(0, 3))}`);
    check(since(recH.toasts, tPause).length === 0, 'Harsh got a toast while Nishtha was paused');
    const wireLeakP = aboutPeer(wireP.frames, facts.nDevice.id, nishtha.id);
    wireP.close();
    check(wireLeakP.length === 0, `the server sent Harsh ${wireLeakP.length} frames about Nishtha while paused: ${JSON.stringify(wireLeakP.slice(0, 3))}`);
    check((await eventCount(harsh)) === eventsP, 'a Grocery event was recorded for Harsh while Nishtha was paused');
    const rowP = (await harsh.api('GET', '/api/v1/people')).people.find((r) => r.peerId === nishtha.id);
    check(rowP && (rowP.devices ?? []).length === 0, `Harsh's People row still carries Nishtha's devices while paused: ${JSON.stringify(rowP)}`);
    // His "buy milk" note watches her, so it cannot fire now, and the rail says so.
    await waitFor('Harsh’s rail to put the "buy milk" note on hold', async () =>
      (await harsh.page.innerText('body')).includes('On hold · Nishtha paused sharing with you'), { timeout: 8000 });
    const pausedShot = [await harsh.shot(OUT, '08-paused-harsh'), await nishtha.shot(OUT, '08-paused-nishtha')];

    // ---- resume
    const resumed = nishtha.page.waitForResponse((r) => r.url().includes('/api/v1/people/') && r.request().method() === 'PATCH');
    await toggle.click();
    check((await resumed).ok(), 'resuming failed');
    await waitFor('Nishtha’s switch to read on', async () => (await toggle.getAttribute('aria-checked')) === 'true', { timeout: 5000 });
    const tResume = await pageNow(harsh);
    // The paused crossing fired nothing, so there is no cool-off to wait out;
    // this only keeps the resumed crossing apart from the paused one.
    await sleep(Math.max(0, COOLOFF_MS - 9000));
    const resumedRun = sim(facts.nDevice, crossing(4), { interval: '700ms', scale: 4 });
    await waitFor('Nishtha’s marker back on Harsh’s map', () => harsh.marker(nMarker), { timeout: 15000 });
    await resumedRun.done;
    const wResumedFire = Date.now();
    await sleep(2500);
    recH = await harsh.record();
    const back = since(recH.frames, tResume);
    const resumedGeo = back.filter((f) => f.type === 'geo' && f.data.placeId === facts.grocery.id).map((f) => f.data.trigger);
    check(back.some((f) => f.type === 'position' && f.deviceId === facts.nDevice.id), 'positions did not resume');
    check(resumedGeo.includes('arrive') || resumedGeo.includes('passby'), `the watched fence did not fire after resume: ${resumedGeo}`);
    check(since(recH.toasts, tResume).length >= 1, 'no toast after resume');
    const resumedShot = await harsh.shot(OUT, '08-resumed');

    // ---- remove, for both
    await harsh.nav('People');
    await harsh.page.getByRole('button', { name: /^Remove Nishtha/ }).click();
    const removed = harsh.page.waitForResponse((r) => r.url().includes('/api/v1/people/') && r.request().method() === 'DELETE');
    await harsh.page.getByRole('button', { name: /^Remove Nishtha .* for both of you/ }).click();
    check((await removed).ok(), 'removing failed');
    const wRemove = Date.now();
    for (const p of people) {
      await waitFor(`${p.name}’s people list to be empty`, async () => (await p.api('GET', '/api/v1/people')).people.length === 0);
    }
    await nishtha.nav('People');
    await waitFor('Nishtha’s People screen to drop Harsh', async () => !(await nishtha.page.innerText('body')).includes('harsh@lura.local'), { timeout: 10000 });
    await waitFor('the People screens to say nothing flows either way', async () => {
      const [h, n] = [await harsh.page.innerText('body'), await nishtha.page.innerText('body')];
      return [h, n].every((t) => t.includes('Your live position is not going to anyone.') && t.includes('No one is sending you their live position.'));
    }, { timeout: 8000 });
    const peopleShot = [await harsh.shot(OUT, '08-removed-people-harsh'), await nishtha.shot(OUT, '08-removed-people-nishtha')];
    await harsh.nav('Live map');
    await nishtha.nav('Live map');
    const tRemoved = { h: await pageNow(harsh), n: await pageNow(nishtha) };
    await waitFor('Harsh’s rail to say the note’s person is gone', async () =>
      (await harsh.page.innerText('body')).includes('On hold · the person it watches is no longer connected'), { timeout: 8000 });
    await waitFor('both markers to be gone', async () => !(await harsh.marker(nMarker)) && !(await nishtha.marker(hMarker)), { timeout: 10000 });
    // Harsh's Grocery still lists Nishtha as watched and his "buy milk" note is
    // still bound to her: crossing it again must reach no one, once the cool-off
    // that would hide a leak has passed.
    await waitCooloff(wResumedFire);
    const wireH = await wireSocket(harsh);
    const wireN = await wireSocket(nishtha);
    const wRemoved = Date.now();
    const eventsR = await eventCount(harsh);
    const afterRun = sim(facts.nDevice, crossing(4), { interval: '700ms', scale: 4 });
    const harshWalk = gpsWalk(harsh, [{ lat: 12.9795, lon: 77.6425 }, { lat: 12.9798, lon: 77.643 }, { lat: 12.98, lon: 77.6436 }], 2300);
    await Promise.all([afterRun.done, harshWalk]);
    await sleep(2500);
    recH = await harsh.record();
    const recN = await nishtha.record();
    const toH = since(recH.frames, tRemoved.h + 1000).filter((f) => f.type === 'position' && f.deviceId === facts.nDevice.id);
    const toN = since(recN.frames, tRemoved.n + 1000).filter((f) => f.type === 'position' && f.deviceId === facts.hDevice.id);
    const alertsH = since(recH.frames, tRemoved.h).filter((f) => f.type === 'geo' || f.type === 'notify');
    const alertsN = since(recN.frames, tRemoved.n).filter((f) => f.type === 'geo' || f.type === 'notify');
    check(toH.length === 0 && toN.length === 0, `after removal Harsh got ${toH.length} and Nishtha ${toN.length} of the other's positions`);
    check(alertsH.length === 0 && alertsN.length === 0, `after removal Harsh got ${alertsH.length} and Nishtha ${alertsN.length} alerts: ${JSON.stringify([...alertsH, ...alertsN].slice(0, 3))}`);
    check(since(recH.toasts, tRemoved.h).length === 0 && since(recN.toasts, tRemoved.n).length === 0, 'a toast appeared after removal');
    check(!(await harsh.marker(nMarker)) && !(await nishtha.marker(hMarker)), 'a marker came back after removal');
    // On the wire, outside either app.
    const wireToH = aboutPeer(wireH.since(wRemoved), facts.nDevice.id, nishtha.id);
    const wireToN = aboutPeer(wireN.since(wRemoved), facts.hDevice.id, harsh.id);
    const ownN = wireN.since(wRemoved).filter((f) => f.type === 'position' && f.data?.deviceId === facts.nDevice.id).length;
    wireH.close();
    wireN.close();
    check(ownN > 0, 'the wire check saw none of Nishtha’s own fixes, so it proves nothing');
    check(wireToH.length === 0 && wireToN.length === 0, `after removal the server sent Harsh ${wireToH.length} and Nishtha ${wireToN.length} frames about the other: ${JSON.stringify([...wireToH, ...wireToN].slice(0, 3))}`);
    check((await eventCount(harsh)) === eventsR, 'a Grocery event was recorded for Harsh after removal');
    // And over REST: none of her devices or history are his to read.
    const ov = await harsh.api('GET', '/api/v1/overview');
    // His own log of the alerts he was sent while she shared stays his (each
    // names her device by id, nothing more); anything else naming her device —
    // a device, a peer row, a pending dwell, a newer event — is a leak.
    const ovHits = pathsWith(ov, facts.nDevice.id);
    const historic = ovHits.filter((h) => {
      const m = /^\$\.events\[(\d+)\]\.deviceId$/.exec(h);
      return m && new Date(ov.events[Number(m[1])].ts).getTime() < wRemove;
    });
    const ovLeak = ovHits.filter((h) => !historic.includes(h));
    check(ovLeak.length === 0, `Harsh’s overview still mentions Nishtha’s device at ${ovLeak.slice(0, 5).join(', ')}`);
    const rest = [];
    for (const path of [`/api/v1/devices/${facts.nDevice.id}`, `/api/v1/history?deviceId=${facts.nDevice.id}`]) {
      const res = await harsh.api('GET', path).then((body) => ({ ok: true, body }), (err) => ({ ok: false, err: String(err.message) }));
      const leak = res.ok && JSON.stringify(res.body).includes(facts.nDevice.id) && /"lat"/.test(JSON.stringify(res.body));
      rest.push({ path: path.replace(facts.nDevice.id, '<her device>'), status: res.ok ? 'ok' : res.err.replace(/^.*→ /, '').slice(0, 40), leak });
      check(!leak, `Harsh can still read Nishtha's data at ${path}: ${JSON.stringify(res.body ?? null).slice(0, 300)}`);
    }
    return {
      pausedMarkerGoneMs: Math.round(tGone - tPause),
      leakedWhilePaused: { app: leaked.length, wire: wireLeakP.length },
      resumedEvents: resumedGeo,
      afterRemoval: { toHarsh: toH.length, toNishtha: toN.length, alerts: alertsH.length + alertsN.length, wire: wireToH.length + wireToN.length, nishthaOwnFixes: ownN, overviewHistoricEvents: historic.length, rest },
      shots: [...pausedShot, resumedShot, ...peopleShot, await harsh.shot(OUT, '08-removed-harsh'), await nishtha.shot(OUT, '08-removed-nishtha')],
    };
  });

  // ---------------------------------------------------------------- 9
  await step('9', 'No page errors, console errors or failed requests in either browser', async () => {
    const report = {};
    // The outage a deliberate restart causes (step 5 on Postgres) is the
    // browser reporting a server that is not there — a refused socket or
    // request — not the app failing; anything else in that window still counts.
    const outage = (e) => duringRestart(e.at) && /WebSocket|ERR_CONNECTION_REFUSED|Failed to fetch|NetworkError|net::ERR_/i.test(`${e.text ?? ''} ${e.status ?? ''}`);
    const restartNoise = {};
    const mapplsTileRetries = {};
    for (const p of people) {
      // A 401 from Keycloak's token endpoint during sign-in is not the app's.
      const bad = p.badResponses
        .filter((r) => !/\/favicon\.ico$/.test(r.url) && !(duringRestart(r.at) && r.status >= 502))
        .map((r) => ({ ...r, url: redactKey(r.url) }));
      // Mappls' tile CDN answers a few tiles with 412 or 408 and the SDK draws
      // the map regardless (step 7 says why). That is theirs, so it is counted
      // here as step 7 counts it, and fails only if it stops being a few.
      const cdn = bad.filter((r) => isMapplsTile(r.url) && (r.status === 408 || r.status === 412));
      const mapplsOk = p.tiles.filter((x) => isMapplsTile(x.url) && x.status === 200).length;
      check(cdn.length <= Math.max(5, mapplsOk * 0.35), `${p.name}: ${cdn.length} Mappls tiles failed against ${mapplsOk} that loaded`);
      if (cdn.length) mapplsTileRetries[p.name] = { failed: cdn.length, loaded: mapplsOk };
      const errors = p.errors.filter((e) => !outage(e));
      restartNoise[p.name] = p.errors.length - errors.length;
      report[p.name] = { errors, badResponses: bad.filter((r) => !cdn.includes(r)) };
    }
    const problems = people.flatMap((p) => [...report[p.name].errors, ...report[p.name].badResponses]);
    check(problems.length === 0, `problems: ${JSON.stringify(report, null, 1)}`);
    return { ...report, restartNoise, mapplsTileRetries };
  });
} catch {
  // The failing step has been recorded; the rest are skipped.
} finally {
  for (const child of sims) child.kill('SIGINT');
  const summary = {
    provider: PROVIDER,
    base: BASE,
    at: new Date().toISOString(),
    pass: results.length === 9 && results.every((r) => r.pass),
    partial: ONLY.length > 0 || SEED,
    results,
    errors: Object.fromEntries(people.map((p) => [p.name, { errors: p.errors, badResponses: p.badResponses.map((r) => ({ ...r, url: redactKey(r.url) })) }])),
  };
  writeFileSync(`${OUT}/results.json`, JSON.stringify(summary, null, 2));
  process.stdout.write(`\n${summary.pass ? 'ALL STEPS PASSED' : 'FAILED'} (${PROVIDER}) — ${OUT}/results.json\n`);
  for (const p of people) await p.close().catch(() => {});
  await browser.close();
  process.exitCode = summary.pass ? 0 : 1;
}
