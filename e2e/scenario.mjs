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
//   E2E_HEADED=1  watch it happen

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, Person, chimes, sleep, waitFor } from './lib/browser.mjs';
import { haversineM, lerp, metresPerPixel, pointInPolygon, project } from './lib/geo.mjs';

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
    // Sign-in needs WebCrypto (PKCE), which Chrome only offers a secure origin;
    // the Mappls phase serves the whitelisted name over plain http.
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
    ];
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
    const pc = await harsh.px(PHARMACY, v);
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
    check(vertexErr < 2, `Grocery's corners are up to ${vertexErr.toFixed(1)} m from where they were clicked`);
    check(['arrive', 'leave', 'passby'].every((t) => grocery.triggers.includes(t)), `Grocery triggers: ${grocery.triggers}`);
    check(grocery.watchUserIds.length === 1 && grocery.watchUserIds[0] === nishtha.id, `Grocery watches ${grocery.watchUserIds}`);
    check(pointInPolygon(GROCERY, grocery.polygon), 'the store is not inside its own fence');
    check(pharmacy?.shape === 'circle' && pharmacy.polygon.length === 0, `Pharmacy: ${JSON.stringify(pharmacy)}`);
    check(haversineM(pharmacy.center, circleCenter) < 2, 'Pharmacy centre is off');
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
  await step('5', 'Harsh moves and resizes the circle, reshapes the polygon; both persist', async () => {
    const page = harsh.page;
    await harsh.stableViewport();

    // ---- circle: move by its body, resize by its edge handle
    await page.getByRole('button', { name: 'Place Pharmacy' }).first().click();
    await page.getByRole('button', { name: 'Edit shape' }).click();
    await page.getByText('Drag the circle to move it · drag the edge handle to resize').waitFor();
    let v = await harsh.stableViewport();
    const from = await harsh.px(facts.pharmacy.center, v);
    const delta = { x: 70, y: 45 };
    const moveTo = { x: from.x + delta.x, y: from.y + delta.y };
    const expectCenter = await harsh.ground(moveTo.x, moveTo.y, v);
    let patched = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${facts.pharmacy.id}`) && r.request().method() === 'PATCH');
    await harsh.drag(from, moveTo);
    check((await patched).ok(), 'moving the circle failed to save');

    v = await harsh.stableViewport();
    const centerPx = await harsh.px(expectCenter, v);
    const edge = { x: centerPx.x + facts.pharmacy.radiusM / metresPerPixel(expectCenter.lat, v.zoom), y: centerPx.y };
    const edgeTo = { x: edge.x + 40, y: edge.y };
    const expectRadius = haversineM(expectCenter, await harsh.ground(edgeTo.x, edgeTo.y, v));
    patched = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${facts.pharmacy.id}`) && r.request().method() === 'PATCH');
    await harsh.drag(edge, edgeTo);
    check((await patched).ok(), 'resizing the circle failed to save');
    const editShot = await harsh.shot(OUT, '05-circle-edited');
    await page.getByRole('button', { name: 'Done', exact: true }).click();

    // ---- polygon: drag the north-east corner out
    await harsh.stableViewport();
    await page.getByRole('button', { name: 'Place Grocery' }).first().click();
    await page.getByRole('button', { name: 'Edit shape' }).click();
    await page.getByText(/4 corners · up to/).waitFor();
    v = await harsh.stableViewport();
    const corner = await harsh.px(facts.grocery.polygon[1], v);
    const cornerTo = { x: corner.x + 30, y: corner.y - 25 };
    const expectCorner = await harsh.ground(cornerTo.x, cornerTo.y, v);
    patched = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${facts.grocery.id}`) && r.request().method() === 'PATCH');
    await harsh.drag(corner, cornerTo, { hold: 30 });
    check((await patched).ok(), 'reshaping the polygon failed to save');
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
    facts.grocery = grocery;
    facts.pharmacy = pharmacy;
    return {
      circle: { movedM: Math.round(moved), centreErrM: Math.round(centerErr * 100) / 100, radiusM: pharmacy.radiusM, expectedRadiusM: Math.round(expectRadius) },
      polygon: { cornerErrM: Math.round(cornerErr * 100) / 100 },
      shots: [editShot, reshapeShot, await harsh.shot(OUT, '05-after-reload')],
    };
  });

  // ---------------------------------------------------------------- 6
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
    const run = sim(facts.nDevice, crossing(), { interval: '700ms', scale: 4 });
    // Screenshots while she is at the shop: the arrival ripple and the toasts.
    await waitFor('Harsh’s arrive toast', async () => (await toastsSince(harsh, t0h)).some((t) => /arrived at Grocery|buy milk/i.test(t.label + t.text)), { timeout: 60000 });
    const atShop = [await harsh.shot(OUT, '06-arrive-harsh'), await nishtha.shot(OUT, '06-arrive-nishtha')];
    await run.done;
    await sleep(2500);

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

    // UI: one toast per crossing, the badge counts them, one chime each.
    const toastsH = since(recH.toasts, t0h);
    const toastsN = since(recN.toasts, t0n);
    const crossings = new Set(geoH.map((f) => f.data.id)).size;
    const chimesH = chimes(since(recH.notes, t0h));
    const chimesN = chimes(since(recN.notes, t0n));
    const badge = { h: await unreadBadge(harsh), n: await unreadBadge(nishtha) };
    check(toastsH.length === crossings, `Harsh saw ${toastsH.length} toasts for ${crossings} crossings: ${toastsH.map((t) => t.label)}`);
    check(toastsH.some((t) => /passed by Grocery/.test(t.label)), 'no pass-by toast for Harsh');
    check(toastsH.some((t) => /left Grocery/.test(t.label)), 'no leave toast for Harsh');
    check(toastsH.some((t) => /buy milk/.test(t.label + t.text)), 'the arrive toast for Harsh does not carry the note');
    check(toastsN.length === 1 && /buy milk/.test(toastsN[0].label + toastsN[0].text) && /from Harsh/.test(toastsN[0].text), `Nishtha's toasts: ${JSON.stringify(toastsN)}`);
    check(badge.h - badge0.h === crossings, `Harsh's badge went ${badge0.h} → ${badge.h} for ${crossings} crossings`);
    check(badge.n - badge0.n === 1, `Nishtha's badge went ${badge0.n} → ${badge.n}`);
    check(chimesH.length === crossings, `Harsh heard ${chimesH.length} chimes for ${crossings} crossings: ${JSON.stringify(chimesH)}`);
    check(chimesN.length === 1, `Nishtha heard ${chimesN.length} chimes: ${JSON.stringify(chimesN)}`);
    // The toast follows the frame within a frame or two.
    const lagH = toastsH.map((t) => {
      const f = recH.frames.filter((x) => (x.type === 'geo' || x.type === 'notify') && x.t <= t.t).at(-1);
      return f ? t.t - f.t : NaN;
    });

    // The notification centre lists what happened.
    await harsh.page.locator('[aria-label^="Notifications"]').first().click();
    await sleep(600);
    const panel = await harsh.shot(OUT, '06-notification-centre');
    await harsh.page.getByRole('button', { name: 'Close', exact: true }).click().catch(() => harsh.page.keyboard.press('Escape'));
    facts.lastFireWall = Date.now();
    return {
      events: triggers,
      toasts: { harsh: toastsH.map((t) => t.label.replace(/\. Show on the map\.$/, '')), nishtha: toastsN.map((t) => t.label.replace(/\. Show on the map\.$/, '')) },
      chimes: { harsh: chimesH.map((c) => c.kind), nishtha: chimesN.map((c) => c.kind) },
      badges: { before: badge0, after: badge },
      toastLagMs: stats(lagH.filter(Number.isFinite)),
      shots: [...atShop, panel],
    };
  });

  // ---------------------------------------------------------------- 7
  await step('7', `Basemaps on ${PROVIDER}: every style loads tiles and keeps fences and markers`, async () => {
    const page = harsh.page;
    const ids = [
      ['streets', 'Streets'],
      ['satellite', 'Satellite'],
      ['hybrid', 'Hybrid'],
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['terrain', 'Terrain'],
    ];
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
      check(failed.length === 0, `${label}: ${failed.length} tiles failed: ${failed.slice(0, 3).map((f) => `${f.status} ${f.url}`)}`);
      check(await page.getByRole('button', { name: 'Place Grocery' }).count(), `${label}: the Grocery label is gone`);
      check(await harsh.marker(`peer_${facts.nDevice.id}`), `${label}: Nishtha's marker is gone`);
      const edge = await edgeHasFenceColour(harsh, facts.grocery.polygon);
      check(edge.hits >= edge.probes * 0.5, `${label}: the Grocery outline is not drawn (${edge.hits}/${edge.probes} edge probes)`);
      shots.push(await harsh.shot(OUT, `07-basemap-${id}`));
      out[id] = { tiles: ok.length, hosts, edge: `${edge.hits}/${edge.probes}` };
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
  await step('8', 'Pause stops positions and the watched fence; resume restores; remove ends it', async () => {
    const nMarker = `peer_${facts.nDevice.id}`;
    const hMarker = `peer_${facts.hDevice.id}`;
    // The engine's cool-off (shortened for this run) must have passed so a
    // second crossing is allowed to fire at all.
    const wait = Number(process.env.E2E_COOLOFF_MS ?? 16000) - (Date.now() - facts.lastFireWall);
    if (wait > 0) await sleep(wait);

    // ---- pause
    await nishtha.nav('People');
    const toggle = nishtha.page.getByRole('switch', { name: /^Share my live location with Harsh/ });
    check((await toggle.getAttribute('aria-checked')) === 'true', 'Nishtha’s switch is not on');
    const paused = nishtha.page.waitForResponse((r) => r.url().includes('/api/v1/people/') && r.request().method() === 'PATCH');
    await toggle.click();
    check((await paused).ok(), 'pausing failed');
    const tPause = await pageNow(harsh);
    await waitFor('Harsh’s People row to say Nishtha stopped sharing', async () => {
      const { people: rows } = await harsh.api('GET', '/api/v1/people');
      return rows.find((r) => r.peerId === nishtha.id)?.sharingWithMe === false;
    });
    await waitFor('Nishtha’s marker to leave Harsh’s map', async () => !(await harsh.marker(nMarker)), { timeout: 8000 });
    const tGone = await pageNow(harsh);
    const pausedRun = sim(facts.nDevice, crossing(4), { interval: '700ms', scale: 4 });
    await pausedRun.done;
    await sleep(2000);
    let recH = await harsh.record();
    const leaked = since(recH.frames, tPause + 1500).filter(
      (f) => (f.type === 'position' && f.deviceId === facts.nDevice.id) || f.type === 'geo' || f.type === 'notify',
    );
    check(leaked.length === 0, `Harsh still received ${leaked.length} frames about Nishtha while paused: ${JSON.stringify(leaked.slice(0, 3))}`);
    check(since(recH.toasts, tPause).length === 0, 'Harsh got a toast while Nishtha was paused');
    const pausedShot = [await harsh.shot(OUT, '08-paused-harsh'), await nishtha.shot(OUT, '08-paused-nishtha')];

    // ---- resume
    const resumed = nishtha.page.waitForResponse((r) => r.url().includes('/api/v1/people/') && r.request().method() === 'PATCH');
    await toggle.click();
    check((await resumed).ok(), 'resuming failed');
    const tResume = await pageNow(harsh);
    await sleep(Math.max(0, Number(process.env.E2E_COOLOFF_MS ?? 16000) - 9000));
    const resumedRun = sim(facts.nDevice, crossing(4), { interval: '700ms', scale: 4 });
    await waitFor('Nishtha’s marker back on Harsh’s map', () => harsh.marker(nMarker), { timeout: 15000 });
    await resumedRun.done;
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
    for (const p of people) {
      await waitFor(`${p.name}’s people list to be empty`, async () => (await p.api('GET', '/api/v1/people')).people.length === 0);
    }
    await harsh.nav('Live map');
    await nishtha.nav('Live map');
    const tRemoved = { h: await pageNow(harsh), n: await pageNow(nishtha) };
    await waitFor('both markers to be gone', async () => !(await harsh.marker(nMarker)) && !(await nishtha.marker(hMarker)), { timeout: 10000 });
    const afterRun = sim(facts.nDevice, [NISHTHA_START, { lat: 12.9695, lon: 77.6365 }], { interval: '500ms', scale: 4 });
    const harshWalk = gpsWalk(harsh, [{ lat: 12.9795, lon: 77.6425 }, { lat: 12.9798, lon: 77.643 }, { lat: 12.98, lon: 77.6436 }], 2300);
    await Promise.all([afterRun.done, harshWalk]);
    await sleep(1500);
    recH = await harsh.record();
    const recN = await nishtha.record();
    const toH = since(recH.frames, tRemoved.h + 1000).filter((f) => f.type === 'position' && f.deviceId === facts.nDevice.id);
    const toN = since(recN.frames, tRemoved.n + 1000).filter((f) => f.type === 'position' && f.deviceId === facts.hDevice.id);
    check(toH.length === 0 && toN.length === 0, `after removal Harsh got ${toH.length} and Nishtha ${toN.length} of the other's positions`);
    check(!(await harsh.marker(nMarker)) && !(await nishtha.marker(hMarker)), 'a marker came back after removal');
    return {
      pausedMarkerGoneMs: Math.round(tGone - tPause),
      leakedWhilePaused: leaked.length,
      resumedEvents: resumedGeo,
      afterRemoval: { toHarsh: toH.length, toNishtha: toN.length },
      shots: [...pausedShot, resumedShot, await harsh.shot(OUT, '08-removed-harsh'), await nishtha.shot(OUT, '08-removed-nishtha')],
    };
  });

  // ---------------------------------------------------------------- 9
  await step('9', 'No page errors, console errors or failed requests in either browser', async () => {
    const report = {};
    for (const p of people) {
      // A 401 from Keycloak's token endpoint during sign-in is not the app's.
      const bad = p.badResponses.filter((r) => !/\/favicon\.ico$/.test(r.url));
      report[p.name] = { errors: p.errors, badResponses: bad };
    }
    const problems = people.flatMap((p) => [...report[p.name].errors, ...report[p.name].badResponses]);
    check(problems.length === 0, `problems: ${JSON.stringify(report, null, 1)}`);
    return report;
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
    errors: Object.fromEntries(people.map((p) => [p.name, { errors: p.errors, badResponses: p.badResponses }])),
  };
  writeFileSync(`${OUT}/results.json`, JSON.stringify(summary, null, 2));
  process.stdout.write(`\n${summary.pass ? 'ALL STEPS PASSED' : 'FAILED'} (${PROVIDER}) — ${OUT}/results.json\n`);
  for (const p of people) await p.close().catch(() => {});
  await browser.close();
  process.exitCode = summary.pass ? 0 : 1;
}
