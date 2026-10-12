// Edge cases for fences, notifications and the UI, end to end, in two browsers.
//
// The release scenario (scenario.mjs) proves the happy path. This suite pushes
// on the edges a real phone produces — a GPS fix jittering across a fence edge,
// a pass-by too fast for any fix to land inside, a fence moved or deleted under
// someone standing in it, broken geometry, overlapping fences, quiet hours, a
// busy map — and then photographs every screen for both people at desktop and
// phone size, light and dark.
//
// Every scenario is judged three ways where it can be: on the wire (REST and the
// live socket each browser holds), in each browser's DOM (toasts, badges, fence
// labels, chimes via the AudioContext spy), and against each other: Harsh and
// Nishtha must see the same number of crossings, at about the same moment.
//
// Run it with e2e/edge.sh (its own Lura on :8097, a short cool-off so the cool-off
// cannot hide a flapping fence). Environment is run.sh's, plus:
//   E2E_SCENARIOS   e.g. "A,B" to run a subset (setup always runs)
//   E2E_SHOTS=0     skip the screenshot tour (scenario I)

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, Person, chimes, sleep, waitFor } from './lib/browser.mjs';
import { haversineM, metresPerPixel, pointInPolygon, project } from './lib/geo.mjs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:8097';
const API = process.env.E2E_API ?? BASE;
process.env.E2E_API = API;
const OUT = process.env.E2E_OUT ?? '/tmp/lura-edge';
const LURASIM = process.env.E2E_LURASIM ?? 'lurasim';
const COOLOFF_MS = Number(process.env.E2E_COOLOFF_MS ?? 4000);
const ONLY = (process.env.E2E_SCENARIOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SHOTS = `${OUT}/shots`;
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ geography
// Indiranagar, Bengaluru. Each scenario has its own block, ~600 m apart, so no
// scenario's fences can see another's fixes.
const HOME = { lat: 12.9702, lon: 77.6378 }; // Nishtha starts, and returns, here
const HARSH_AT = { lat: 12.9786, lon: 77.6398 };
const AREA = {
  A: { lat: 12.9650, lon: 77.6300 },
  B: { lat: 12.9650, lon: 77.6380 },
  C: { lat: 12.9650, lon: 77.6460 },
  D: { lat: 12.9720, lon: 77.6300 },
  F: { lat: 12.9720, lon: 77.6460 },
  G: { lat: 12.9790, lon: 77.6300 },
  H: { lat: 12.9800, lon: 77.6440 },
  I: { lat: 12.9650, lon: 77.6540 },
};

/** offset moves a point by metres east (dx) and north (dy). */
function offset(p, dx, dy) {
  const dLat = dy / 111_320;
  const dLon = dx / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}
/** box is a rectangle w × h metres centred on c, as an open ring. */
function box(c, w, h) {
  return [offset(c, -w / 2, -h / 2), offset(c, w / 2, -h / 2), offset(c, w / 2, h / 2), offset(c, -w / 2, h / 2)];
}

// ------------------------------------------------------------------ browsers
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADED !== '1',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const harsh = new Person({ name: 'Harsh', email: 'harsh@lura.local', password: 'lura-harsh', start: HARSH_AT });
const nishtha = new Person({ name: 'Nishtha', email: 'nishtha@lura.local', password: 'lura-nishtha', start: HOME });
const people = [harsh, nishtha];

const results = [];
const facts = {};
const sims = new Set();
const stands = new Set();

function check(cond, message) {
  if (!cond) throw new Error(message);
}

function stats(values) {
  if (values.length === 0) return { n: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const r = (v) => Math.round(v * 10) / 10;
  return { n: s.length, min: r(s[0]), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]) };
}

async function scenario(id, title, fn) {
  if (ONLY.length && id !== '0' && !ONLY.includes(id)) {
    results.push({ id, title, pass: true, skipped: true });
    process.stdout.write(`\n[${id}] ${title}\n  SKIPPED\n`);
    return;
  }
  const started = Date.now();
  process.stdout.write(`\n[${id}] ${title}\n`);
  // A failed scenario can leave an editor or a sheet open; start each one on a
  // plain live map, as a person who closed what they were doing would.
  if (id !== '0') for (const p of people) await tidy(p).catch(() => {});
  try {
    const evidence = await fn();
    results.push({ id, title, pass: true, ms: Date.now() - started, evidence });
    process.stdout.write(`  PASS ${JSON.stringify(evidence)}\n`);
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - started, error: String(err?.stack ?? err) });
    process.stdout.write(`  FAIL ${err?.stack ?? err}\n`);
    for (const p of people) await p.shot(SHOTS, `fail-${id}`).catch(() => {});
    if (id === '0') throw err; // nothing else can run without the setup
  } finally {
    // Whatever happened, nothing of this scenario keeps driving her phone.
    for (const child of sims) child.kill('SIGINT');
    for (const stop of [...stands]) await stop();
  }
}

async function tidy(p) {
  const page = p.page;
  for (const name of ['Cancel', 'Done', 'Close', 'Close basemap picker']) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible())) await b.first().click({ timeout: 2000 }).catch(() => {});
  }
  await page.keyboard.press('Escape');
  await p.nav('Live map');
}

// ------------------------------------------------------------------ devices
let seq = 0;
/** pub posts one fix for Nishtha's phone, exactly where and as fast as asked. */
async function pub(p, { speed = 0, acc = 5 } = {}) {
  seq += 1;
  const res = await fetch(`${API}/pub?device=${facts.nDevice.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${facts.nDevice.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ _type: 'location', lat: p.lat, lon: p.lon, tst: Math.floor(Date.now() / 1000), acc, speedMps: speed, seq }),
  });
  check(res.ok, `pub: HTTP ${res.status} ${await res.text()}`);
}

/** stand keeps Nishtha's phone reporting from one spot, like a phone on a table. */
function stand(p, everyMs = 1500) {
  let on = true;
  const loop = (async () => {
    while (on) {
      await pub(p, { speed: 0 }).catch(() => {});
      await sleep(everyMs);
    }
  })();
  const stop = async () => {
    on = false;
    stands.delete(stop);
    await loop;
  };
  stands.add(stop);
  return stop;
}

/** sim drives Nishtha's phone with cmd/lurasim, as scenario.mjs does. */
function sim(route, { interval = '700ms', scale = 4, loops = 1, jitter = 3 } = {}) {
  const spec = route.map((p) => `${p.lat},${p.lon}${p.dwell ? `,${p.dwell}` : ''}`).join(';');
  const child = spawn(
    LURASIM,
    ['-url', API, '-token', facts.nDevice.token, `-device=${facts.nDevice.id}`, '-route', spec,
      '-interval', interval, '-scale', String(scale), '-jitter', String(jitter), '-loops', String(loops), '-quiet'],
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
  return { done, stop: () => child.kill('SIGINT') };
}

/** goHome parks Nishtha far from every fence, so the next scenario starts clean. */
async function goHome() {
  await pub(HOME, { speed: 0 });
  await sleep(COOLOFF_MS + 500);
}

// ------------------------------------------------------------------ observing
async function mark() {
  return { h: await harsh.page.evaluate(() => performance.now()), n: await nishtha.page.evaluate(() => performance.now()), wall: Date.now() };
}

/**
 * observe collects what each side saw after a mark, about the given places:
 * Harsh's geo frames (he owns the fences), each side's reminders, toasts,
 * chimes and badge.
 */
async function observe(t, placeIds) {
  // Pending reminders stack: the newest card is shown, the rest fold behind it
  // ("+2 more"), so two that arrive together are one card on screen. Unfold
  // the stack for a moment so the spy sees every card, then fold it back.
  for (const p of [harsh, nishtha]) {
    const more = p.page.getByRole('button', { name: /^Show \d+ more pending reminders$/ });
    if (await more.count()) {
      await more.first().click().catch(() => {});
      await sleep(500);
      await p.page.getByRole('button', { name: 'Fold pending reminders' }).first().click().catch(() => {});
    }
  }
  const [recH, recN] = [await harsh.record(), await nishtha.record()];
  const ids = new Set(placeIds);
  const after = (list, t0) => list.filter((x) => x.t >= t0);
  const geo = after(recH.frames, t.h).filter((f) => f.type === 'geo' && ids.has(f.data.placeId));
  const notifyH = after(recH.frames, t.h).filter((f) => f.type === 'notify' && ids.has(f.data.placeId));
  const notifyN = after(recN.frames, t.n).filter((f) => f.type === 'notify' && ids.has(f.data.placeId));
  const geoN = after(recN.frames, t.n).filter((f) => f.type === 'geo' && ids.has(f.data.placeId));
  const names = (await harsh.api('GET', '/api/v1/places')).places.filter((p) => ids.has(p.id)).map((p) => p.name);
  const nameOf = new Map(geo.map((f) => [f.data.placeId, f.data.placeName]));
  for (const n of names) nameOf.set(n, n);
  const about = (toast) => [...ids].some((id) => nameOf.get(id) && toast.label.includes(nameOf.get(id))) || names.some((n) => toast.label.includes(n) || toast.text.includes(n));
  // The spy records one entry per toast element (lib/instrument.mjs), kept up
  // to date when a reminder re-words it. A reminder waiting for an
  // acknowledgement replaces its crossing's toast with a sticky card — another
  // element naming the same crossing (its notice id): one notice, not two.
  const dedupe = (toasts) => {
    const seen = new Set();
    return toasts
      .filter((x) => !x.notice || (seen.has(x.notice) ? false : (seen.add(x.notice), true)))
      .map((x) => ({ ...x, head: x.label.replace(/\. Show on the map\.$/, '') }));
  };
  const toastsH = dedupe(after(recH.toasts, t.h).filter(about));
  const toastsN = dedupe(after(recN.toasts, t.n).filter(about));
  return {
    geo,
    geoN,
    triggers: geo.map((f) => `${f.data.trigger}@${f.data.placeName}`),
    count: (trigger, name) => geo.filter((f) => f.data.trigger === trigger && (!name || f.data.placeName === name)).length,
    notifyH,
    notifyN,
    toastsH,
    toastsN,
    chimesH: chimes(after(recH.notes, t.h)),
    chimesN: chimes(after(recN.notes, t.n)),
    // Server event time → toast on screen, per browser, split into the wire
    // (event → frame on the socket) and the page (frame → toast drawn).
    lag: { h: lags(toastsH, [...geo, ...notifyH]), n: lags(toastsN, notifyN) },
  };
}

function lags(toasts, frames) {
  const total = [];
  const server = [];
  const wire = [];
  const page = [];
  for (const x of toasts) {
    // The frame that drew it: the last one for these places before the toast.
    const f = frames.filter((fr) => fr.t <= x.t + 5).sort((a, b) => a.t - b.t).at(-1);
    if (!f) continue;
    const ts = Date.parse(f.data.ts ?? f.data.event?.ts);
    total.push(x.wall - ts);
    // event → frame built by the hub (server), frame built → handler ran on
    // the page (socket and the page's event loop), handler → toast drawn.
    if (f.sent) server.push(Date.parse(f.sent) - ts);
    wire.push(f.sent ? f.wall - Date.parse(f.sent) : f.wall - ts);
    page.push(x.t - f.t);
  }
  return { total, server, wire, page };
}

function summary(o) {
  return {
    events: o.triggers,
    toasts: { harsh: o.toastsH.map((t) => t.head), nishtha: o.toastsN.map((t) => t.head) },
    chimes: { harsh: o.chimesH.map((c) => c.kind), nishtha: o.chimesN.map((c) => c.kind) },
    toastLagMs: {
      harsh: { total: stats(o.lag.h.total), server: stats(o.lag.h.server), wire: stats(o.lag.h.wire), page: stats(o.lag.h.page) },
      nishtha: { total: stats(o.lag.n.total), server: stats(o.lag.n.server), wire: stats(o.lag.n.wire), page: stats(o.lag.n.page) },
    },
  };
}

/** sameForBoth: one toast per crossing in each browser, and the counts agree. */
function sameForBoth(o, expected) {
  check(o.geoN.length === 0, `Nishtha received ${o.geoN.length} geo frames for Harsh's fences`);
  check(o.toastsH.length === expected, `Harsh saw ${o.toastsH.length} toasts, want ${expected}: ${o.toastsH.map((t) => t.head)}`);
  check(o.toastsN.length === expected, `Nishtha saw ${o.toastsN.length} toasts, want ${expected}: ${o.toastsN.map((t) => t.head)}`);
  check(o.notifyN.length === expected, `Nishtha got ${o.notifyN.length} reminders, want ${expected}`);
  for (const side of ['h', 'n']) {
    const s = stats(o.lag[side].total);
    check(!s.n || s.max < 1500, `toast lag on ${side === "h" ? "Harsh" : "Nishtha"}: ${JSON.stringify(o.lag[side])}`);
  }
}

/** watchedFence creates a fence of Harsh's watching Nishtha, with a note per trigger telling both of them. */
async function watchedFence(body, notes = body.triggers) {
  const { place } = await harsh.api('POST', '/api/v1/places', { watchUserIds: [nishtha.id], ...body });
  for (const trigger of notes) {
    await harsh.api('POST', '/api/v1/notes', {
      text: `${body.name} ${trigger}`, placeId: place.id, trigger, watchUserId: nishtha.id, notifyUserIds: [harsh.id, nishtha.id],
    });
  }
  return place;
}

// ------------------------------------------------------------------ the map
/** centreOn drags Harsh's map so a point sits mid-view, then sets the zoom with the buttons. */
async function centreOn(person, point, zoom) {
  const page = person.page;
  // If the camera will not hold still, say what it is doing.
  const drift = [];
  for (let i = 0; i < 6; i += 1) {
    drift.push(await person.viewport());
    await sleep(250);
  }
  const moving = new Set(drift.map((d) => JSON.stringify(d))).size > 1;
  if (moving) process.stdout.write(`  note: ${person.name}'s camera is moving before centreOn: ${JSON.stringify([drift[0], drift.at(-1)])}\n`);
  for (let i = 0; i < 12 && zoom !== undefined; i += 1) {
    const v = await person.stableViewport(400);
    if (Math.abs(v.zoom - zoom) < 0.6) break;
    await page.getByRole('button', { name: v.zoom > zoom ? 'Zoom out' : 'Zoom in' }).click();
  }
  for (let i = 0; i < 3; i += 1) {
    const v = await person.stableViewport(400);
    const p = await person.px(point, v);
    const mid = { x: v.left + v.width / 2, y: v.top + v.height / 2 };
    if (Math.hypot(p.x - mid.x, p.y - mid.y) < 20) break;
    // Grab a spot clear of the overlays' buttons, drag by the offset.
    const grab = { x: mid.x - 60, y: mid.y + 90 };
    await person.drag(grab, { x: grab.x - (p.x - mid.x), y: grab.y - (p.y - mid.y) }, { steps: 14 });
  }
  return person.stableViewport(500);
}

/** labelBox is the on-screen box of a fence's label pill, or null when it is not drawn. */
async function labelBox(person, name) {
  const loc = person.page.getByRole('button', { name: `Place ${name}`, exact: true });
  if ((await loc.count()) === 0) return null;
  const b = await loc.first().boundingBox();
  return b && b.width > 0 ? b : null;
}

// ======================================================================
const webhook = { hits: [] };
const sink = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    webhook.hits.push({ at: Date.now(), body });
    res.writeHead(204).end();
  });
});
await new Promise((r) => sink.listen(Number(process.env.E2E_WEBHOOK_PORT ?? 0), '127.0.0.1', r));
webhook.url = `http://127.0.0.1:${sink.address().port}/hook`;

try {
  // ---------------------------------------------------------------- 0
  await scenario('0', 'Setup: both sign in, connect over the API, Nishtha gets a phone', async () => {
    await Promise.all(people.map((p) => p.open(browser, BASE)));
    // Reminders waiting for an acknowledgement ring again every minute until
    // acknowledged (release spec §6; the scenario and the alerts checks cover
    // that). This suite counts the chimes each crossing makes, so the repeats
    // of earlier scenarios' cards are pushed out of its window.
    await Promise.all(people.map((p) => p.ctx.addInitScript(() => { window.__luraRemindEveryMs = 24 * 3600 * 1000; })));
    await Promise.all(people.map((p) => p.page.evaluate(() => { window.__luraRemindEveryMs = 24 * 3600 * 1000; })));
    await Promise.all(people.map((p) => p.signIn()));
    for (const p of people) {
      const { user } = await p.api('GET', '/api/v1/me');
      p.id = user.id;
      await p.api('PATCH', '/api/v1/me', { quietFrom: '', quietTo: '', tz: 'Asia/Kolkata' });
    }
    await harsh.api('POST', '/api/v1/people/invite', { email: nishtha.email });
    await nishtha.api('POST', `/api/v1/people/${harsh.id}/accept`, {});
    for (const [me, them] of [[harsh, nishtha], [nishtha, harsh]]) {
      await waitFor(`${me.name} to share with ${them.name} both ways`, async () => {
        const row = (await me.api('GET', '/api/v1/people')).people.find((r) => r.peerId === them.id);
        return row && row.status === 'accepted' && row.sharing && row.sharingWithMe;
      });
    }
    const created = await nishtha.api('POST', '/api/v1/devices', { name: 'Nishtha’s phone', kind: 'phone' });
    facts.nDevice = { id: created.device.id, token: created.pubToken };
    facts.nMarker = `peer_${facts.nDevice.id}`;
    await pub(HOME);
    await waitFor('Nishtha on Harsh’s map', () => harsh.marker(facts.nMarker), { timeout: 20000 });
    // A gesture so Web Audio may start, as a person's first click would.
    for (const p of people) await p.page.mouse.click(5, 450);
    return { harsh: harsh.id, nishtha: nishtha.id, device: facts.nDevice.id, webhook: webhook.url };
  });

  // ---------------------------------------------------------------- A
  await scenario('A', 'Boundary jitter: two minutes on a fence edge with ±8 m GPS noise', async () => {
    const c = AREA.A;
    const ring = box(c, 120, 120);
    const fence = await watchedFence({ name: 'Edge Shop', shape: 'polygon', polygon: ring, triggers: ['arrive', 'leave'] });
    const westEdge = offset(c, -60, 0);
    await pub(offset(c, -200, 0));
    await centreOn(harsh, c, 16);
    const t = await mark();
    // In from the west, parked on the west edge for 120 s of simulated time
    // (scale 6: ~20 s real, one fix every 700 ms), then away again.
    await sim([offset(c, -200, 0), { ...westEdge, dwell: 120 }, offset(c, -220, 0)], { interval: '700ms', scale: 6, jitter: 8 }).done;
    await sleep(2500);
    const o = await observe(t, [fence.id]);
    // The fixes really did straddle the edge.
    const fixes = (await harsh.record()).frames.filter((f) => f.t >= t.h && f.type === 'position' && f.deviceId === facts.nDevice.id);
    const nearEdge = fixes.filter((f) => haversineM(f, westEdge) < 12);
    const outside = nearEdge.filter((f) => !pointInPolygon(f, ring)).length;
    const inside = nearEdge.length - outside;
    check(inside >= 3 && outside >= 3, `the jitter did not straddle the edge: ${inside} in, ${outside} out of ${nearEdge.length}`);
    check(o.count('arrive') === 1, `arrive fired ${o.count('arrive')} times: ${o.triggers}`);
    check(o.count('leave') === 1, `leave fired ${o.count('leave')} times: ${o.triggers}`);
    sameForBoth(o, 2);
    check(o.chimesH.length === 2 && o.chimesN.length === 2, `chimes: ${JSON.stringify({ h: o.chimesH, n: o.chimesN })}`);
    const shots = [await harsh.shot(SHOTS, 'A-edge'), await nishtha.shot(SHOTS, 'A-edge')];
    await goHome();
    return { fixesNearEdge: nearEdge.length, inside, outside, ...summary(o), shots };
  });

  // ---------------------------------------------------------------- B
  await scenario('B', 'Fast pass-by at 15 m/s: one fix inside, then none inside', async () => {
    const c = AREA.B;
    const ring = box(c, 50, 120); // a 50 m shop front, crossed west → east
    const fence = await watchedFence({ name: 'Kiosk', shape: 'polygon', polygon: ring, triggers: ['arrive', 'leave', 'passby'] }, ['passby', 'arrive', 'leave']);
    await centreOn(harsh, c, 16);
    const drive = async (xs, gapMs) => {
      for (const [i, x] of xs.entries()) {
        await pub(offset(c, x, 0), { speed: 15 });
        if (i < xs.length - 1) await sleep(gapMs);
      }
    };
    // One fix inside: 60 m between fixes at 15 m/s is 4 s.
    await pub(offset(c, -300, 0), { speed: 15 });
    await sleep(COOLOFF_MS);
    let t = await mark();
    await drive([-125, -65, -5, 55, 115], 4000);
    await sleep(2500);
    const one = await observe(t, [fence.id]);
    check(one.count('passby') === 1, `one fix inside: passby fired ${one.count('passby')} times: ${one.triggers}`);
    check(one.count('arrive') === 0 && one.count('leave') === 0, `one fix inside: a pass-by is not a visit: ${one.triggers}`);
    sameForBoth(one, 1);
    check(one.chimesN.length === 1 && one.chimesH.length === 1, `chimes: ${JSON.stringify({ h: one.chimesH, n: one.chimesN })}`);
    const passShot = [await harsh.shot(SHOTS, 'B-passby'), await nishtha.shot(SHOTS, 'B-passby')];

    // Back to the west side without crossing the front: round its north end.
    await pub(offset(c, 115, 300), { speed: 15 });
    await sleep(COOLOFF_MS);
    await pub(offset(c, -135, 300), { speed: 15 });
    await sleep(COOLOFF_MS);
    // Zero fixes inside: 90 m apart (6 s at 15 m/s) straddle the 50 m front.
    t = await mark();
    await drive([-135, -45, 45, 135], 6000);
    await sleep(2500);
    const none = await observe(t, [fence.id]);
    const insideFixes = [-135, -45, 45, 135].filter((x) => pointInPolygon(offset(c, x, 0), ring)).length;
    check(insideFixes === 0, 'the zero-inside drive has a fix inside');
    check(none.count('passby') === 1, `zero fixes inside: passby fired ${none.count('passby')} times: ${none.triggers}`);
    check(none.count('arrive') === 0 && none.count('leave') === 0, `zero inside: ${none.triggers}`);
    sameForBoth(none, 1);
    const crossing = none.geo[0]?.data.point;
    check(crossing && pointInPolygon(crossing, box(c, 52, 122)), `the crossing is reported at ${JSON.stringify(crossing)}, not on the fence`);
    await goHome();
    return { oneInside: summary(one), zeroInside: { ...summary(none), reportedAt: crossing }, shots: passShot };
  });

  // ---------------------------------------------------------------- C
  await scenario('C', 'Move a fence off her, then grow a circle over her', async () => {
    const c = AREA.C;
    const fence = await watchedFence({ name: 'Bakery', shape: 'circle', center: c, radiusM: 60, triggers: ['arrive', 'leave'] });
    let v = await centreOn(harsh, offset(c, 120, 0), 15.5);
    const before = await waitFor('the Bakery label on Harsh’s map', () => labelBox(harsh, 'Bakery'));
    const tIn = await mark();
    const stop = stand(c);
    await waitFor('the arrival', async () => (await observe(tIn, [fence.id])).count('arrive') === 1, { timeout: 15000 });
    await sleep(1500);
    const arrived = await observe(tIn, [fence.id]);
    sameForBoth(arrived, 1);

    // ---- move it 250 m east, as Harsh's phone would: the desktop map must follow at once.
    const moved = offset(c, 250, 0);
    const t = await mark();
    const tPatch = Date.now();
    await harsh.api('PATCH', `/api/v1/places/${fence.id}`, { center: moved });
    const expectDx = project(moved, v).x - project(c, v).x;
    const after = await waitFor('the Bakery label to move on Harsh’s map', async () => {
      const b = await labelBox(harsh, 'Bakery');
      return b && Math.abs(b.x - before.x - expectDx) < 6 ? b : null;
    }, { timeout: 5000, every: 50 });
    const followMs = Date.now() - tPatch;
    await waitFor('the leave', async () => (await observe(t, [fence.id])).count('leave') >= 1, { timeout: 10000 });
    await sleep(8000); // she keeps reporting from the same spot: nothing more may fire
    const left = await observe(t, [fence.id]);
    check(left.count('leave') === 1 && left.count('arrive') === 0, `after the move: ${left.triggers}`);
    sameForBoth(left, 1);
    check(followMs < 1500, `Harsh's map took ${followMs} ms to show the moved fence`);
    // Nishtha is watched, not shown Harsh's fences (release spec §3).
    check(!(await labelBox(nishtha, 'Bakery')), 'Nishtha’s map shows Harsh’s watched fence');
    const movedShot = [await harsh.shot(SHOTS, 'C-moved'), await nishtha.shot(SHOTS, 'C-moved')];

    // ---- grow it over her, with the editor's edge handle.
    await sleep(COOLOFF_MS);
    const page = harsh.page;
    await page.getByRole('button', { name: 'Place Bakery' }).first().click();
    await page.getByRole('button', { name: 'Edit shape' }).click();
    await page.getByText('Drag the circle to move it · drag the edge handle to resize').waitFor();
    v = await harsh.stableViewport();
    const centrePx = await harsh.px(moved, v);
    const mpp = metresPerPixel(moved.lat, v.zoom);
    const edge = { x: centrePx.x + 60 / mpp, y: centrePx.y };
    const target = 300; // she is 250 m from the centre
    const edgeTo = { x: centrePx.x + target / mpp, y: centrePx.y };
    check(edgeTo.x < v.left + v.width - 10, 'the resize target is off screen');
    const t2 = await mark();
    const patched = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${fence.id}`) && r.request().method() === 'PATCH');
    await harsh.drag(edge, edgeTo, { steps: 20 });
    check((await patched).ok(), 'resizing failed to save');
    await waitFor('the arrival after the resize', async () => (await observe(t2, [fence.id])).count('arrive') === 1, { timeout: 10000 });
    await sleep(2000);
    const grown = await observe(t2, [fence.id]);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await stop();
    const place = (await harsh.api('GET', `/api/v1/places/${fence.id}`)).place;
    check(Math.abs(place.radiusM - target) < 15, `radius ${place.radiusM}, dragged to ${target}`);
    check(grown.count('arrive') === 1 && grown.count('leave') === 0, `after the resize: ${grown.triggers}`);
    sameForBoth(grown, 1);
    const grownShot = await harsh.shot(SHOTS, 'C-grown');
    await goHome();
    return {
      arrive: summary(arrived),
      move: { ...summary(left), harshMapFollowedMs: followMs, labelShiftPx: Math.round(after.x - before.x), expectedPx: Math.round(expectDx) },
      resize: { ...summary(grown), radiusM: place.radiusM },
      shots: [...movedShot, grownShot],
    };
  });

  // ---------------------------------------------------------------- D
  await scenario('D', 'Delete a fence that has a note and a pending dwell', async () => {
    const c = AREA.D;
    const fence = await watchedFence({ name: 'Gym', shape: 'circle', center: c, radiusM: 70, triggers: ['arrive', 'dwell', 'leave'], dwellMins: 1 }, ['arrive', 'dwell']);
    const t = await mark();
    const stop = stand(c);
    await waitFor('the arrival at Gym', async () => (await observe(t, [fence.id])).count('arrive') === 1, { timeout: 15000 });
    // The dwell timer is armed and owned by Harsh.
    const page = harsh.page;
    await harsh.nav('Places');
    await page.getByText('Gym', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirm = page.getByRole('button', { name: /^Delete Gym/ });
    const confirmShot = await harsh.shot(SHOTS, 'D-confirm');
    const deleted = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${fence.id}`) && r.request().method() === 'DELETE');
    await confirm.click();
    check((await deleted).status() === 204, 'delete failed');
    const tDel = await mark();
    // The arrival toast still names Gym; the grid is everything outside it.
    await waitFor('Gym to leave the Places grid', () => page.evaluate(() => ![...document.querySelectorAll('div')].some(
      (el) => el.childElementCount === 0 && el.textContent === 'Gym' && !el.closest('[aria-label$="Show on the map."]'),
    )), { timeout: 5000 });
    // Past the dwell's minute and a dwell tick, still standing there, then walking off.
    await sleep(75_000);
    await stop();
    await pub(offset(c, 300, 0), { speed: 1 });
    await sleep(2000);
    const o = await observe(tDel, [fence.id]);
    check(o.geo.length === 0 && o.notifyN.length === 0 && o.notifyH.length === 0, `a deleted fence fired: ${o.triggers}`);
    check(o.toastsH.length === 0 && o.toastsN.length === 0, 'a deleted fence toasted');
    const { notes } = await harsh.api('GET', '/api/v1/notes');
    const kept = notes.filter((n) => n.text.startsWith('Gym '));
    check(kept.length === 2 && kept.every((n) => n.placeId === ''), `the Gym notes: ${JSON.stringify(kept)}`);
    check((await fetch(`${API}/readyz`)).ok, 'the server is not ready after the delete');
    await harsh.nav('Notes');
    await page.getByText('Gym arrive').first().waitFor({ timeout: 5000 });
    const notesShot = await harsh.shot(SHOTS, 'D-notes-after-delete');
    await harsh.nav('Live map');
    check(!(await labelBox(harsh, 'Gym')), 'the Gym label is still on Harsh’s map');
    await goHome();
    return { afterDelete: o.triggers, notesKept: kept.map((n) => ({ text: n.text, placeId: n.placeId })), shots: [confirmShot, notesShot] };
  });

  // ---------------------------------------------------------------- E
  await scenario('E', 'Invalid geometry, in the editor and over the API', async () => {
    const page = harsh.page;
    const c = AREA.I;
    const v = await centreOn(harsh, c, 16);
    const mid = await harsh.px(c, v);
    const hint = async (text) => {
      const loc = page.getByText(text);
      await loc.first().waitFor({ timeout: 3000 });
      return loc.count();
    };
    const out = {};
    // ---- a bow tie, tapped in: the fourth corner would cross the first edge.
    await page.getByRole('button', { name: 'Draw' }).click();
    await page.getByRole('menuitem', { name: 'Polygon' }).click();
    const corner = (dx, dy) => ({ x: mid.x + dx, y: mid.y + dy });
    for (const p of [corner(-80, -80), corner(80, 80), corner(80, -80)]) {
      await page.mouse.click(p.x, p.y);
      await sleep(200);
    }
    await page.mouse.click(mid.x - 80, mid.y + 80);
    out.crossingHint = await hint('That edge would cross another one');
    await page.getByText('3 corners · tap the first corner or Done to close').waitFor();
    out.shotCross = await harsh.shot(SHOTS, 'E-editor-crossing');
    // ---- closing a ring whose last edge crosses: refused at Done, with the reason.
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    for (const p of [corner(-80, -80), corner(80, -80), corner(-80, 80), corner(80, 80)]) {
      await page.mouse.click(p.x, p.y);
      await sleep(200);
    }
    const four = await page.getByText('4 corners · tap the first corner or Done to close').count();
    if (four) {
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      out.closeHint = await hint('Edges cannot cross each other');
    } else {
      out.closeHint = await hint('That edge would cross another one');
    }
    // ---- two corners: Done is not offered.
    for (let i = 0; i < 4; i += 1) await page.getByRole('button', { name: 'Undo' }).click().catch(() => {});
    for (const p of [corner(-80, -80), corner(80, -80)]) {
      await page.mouse.click(p.x, p.y);
      await sleep(200);
    }
    const done = page.getByRole('button', { name: 'Done', exact: true });
    out.twoCornersDoneDisabled = (await done.getAttribute('aria-disabled')) === 'true' || (await done.isDisabled());
    check(out.twoCornersDoneDisabled, 'Done is enabled with two corners');
    out.shotTwo = await harsh.shot(SHOTS, 'E-editor-two-corners');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Cancel' }).first().click().catch(() => {});
    await sleep(400);

    // ---- freehand: a 300-point scribble becomes at most 60 corners.
    await page.getByRole('button', { name: 'Draw' }).click();
    await page.getByRole('menuitem', { name: 'Freehand' }).click();
    const stroke = Array.from({ length: 300 }, (_, i) => {
      const a = (i / 300) * 2 * Math.PI;
      const r = 110 + 12 * Math.sin(17 * a) + 6 * Math.sin(41 * a);
      return { x: mid.x + r * Math.cos(a), y: mid.y + r * 0.8 * Math.sin(a) };
    });
    await page.mouse.move(stroke[0].x, stroke[0].y);
    await page.mouse.down();
    for (const p of stroke.slice(1)) await page.mouse.move(p.x, p.y);
    await page.mouse.up();
    const label = await page.getByText(/^Polygon with \d+ corners/).first().innerText({ timeout: 5000 });
    out.freehandCorners = Number(/(\d+) corners/.exec(label)[1]);
    check(out.freehandCorners >= 3 && out.freehandCorners <= 60, `freehand kept ${out.freehandCorners} corners`);
    out.shotFreehand = await harsh.shot(SHOTS, 'E-freehand-form');
    await page.getByPlaceholder('Whole Foods').fill('Scribble');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/places') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create place' }).click();
    const res = await created;
    check(res.status() === 201, `creating the freehand fence: HTTP ${res.status()}`);
    out.freehandSaved = (await res.json()).place.polygon.length;

    // ---- the API says no, with the right code.
    const status = async (body) => {
      const token = await harsh.token();
      const r = await fetch(`${API}/api/v1/places`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      return `${r.status} ${j.code ?? j.error ?? ''}`.trim();
    };
    const [a, b2, cc, d] = box(c, 100, 100);
    const many = Array.from({ length: 201 }, (_, i) => offset(c, 200 * Math.cos((i / 201) * 2 * Math.PI), 200 * Math.sin((i / 201) * 2 * Math.PI)));
    out.api = {
      bowTie: await status({ name: 'Bow', polygon: [a, cc, b2, d] }),
      twoVertices: await status({ name: 'Two', polygon: [a, b2] }),
      vertices201: await status({ name: 'Many', polygon: many }),
      radius0: await status({ name: 'Zero', center: c, radiusM: 0 }),
      radius100km: await status({ name: 'Huge', center: c, radiusM: 100_000 }),
    };
    for (const k of ['bowTie', 'twoVertices', 'vertices201']) check(out.api[k] === '400 invalid_polygon', `${k}: ${out.api[k]}`);
    for (const k of ['radius0', 'radius100km']) check(out.api[k].startsWith('400'), `${k}: ${out.api[k]}`);
    return out;
  });

  // ---------------------------------------------------------------- F
  await scenario('F', 'Overlapping fences: a pharmacy inside a park', async () => {
    const c = AREA.F;
    const park = await watchedFence({ name: 'Cubbon Park', shape: 'polygon', polygon: box(c, 300, 300), triggers: ['arrive'] });
    const pharmacy = await watchedFence({ name: 'Pharmacy', shape: 'circle', center: offset(c, 30, 20), radiusM: 40, triggers: ['arrive'] });
    await centreOn(harsh, c, 15.5);
    const t = await mark();
    await sim([offset(c, -320, 20), { ...offset(c, 30, 20), dwell: 20 }], { interval: '700ms', scale: 4, jitter: 2 }).done;
    await sleep(2500);
    const o = await observe(t, [park.id, pharmacy.id]);
    check(o.count('arrive', 'Cubbon Park') === 1 && o.count('arrive', 'Pharmacy') === 1, `arrivals: ${o.triggers}`);
    check(o.geo.length === 2, `events: ${o.triggers}`);
    sameForBoth(o, 2);
    for (const name of ['Cubbon Park', 'Pharmacy']) {
      check(o.toastsH.some((x) => x.label.includes(`arrived at ${name}`) || x.label.includes(`${name} arrive`)), `no ${name} toast for Harsh: ${o.toastsH.map((x) => x.label)}`);
      check(o.toastsN.some((x) => (x.label + x.text).includes(`${name} arrive`)), `no ${name} toast for Nishtha: ${o.toastsN.map((x) => x.label)}`);
    }
    const shots = [await harsh.shot(SHOTS, 'F-overlap-toasts'), await nishtha.shot(SHOTS, 'F-overlap-toasts')];
    await goHome();
    return { ...summary(o), shots };
  });

  // ---------------------------------------------------------------- G
  await scenario('G', 'Quiet hours for Nishtha: the toast still shows, silently; push is held', async () => {
    const c = AREA.G;
    const fence = await watchedFence({ name: 'Cafe', shape: 'circle', center: c, radiusM: 50, triggers: ['arrive'] });
    // The deployment's webhook notifier (LURA_WEBHOOK_URL, set by edge.sh) is
    // the push channel; Nishtha turns it on for herself.
    check(process.env.E2E_WEBHOOK_PORT, 'E2E_WEBHOOK_PORT is not set: run this suite with e2e/edge.sh');
    await nishtha.api('POST', '/api/v1/channels', { type: 'webhook', config: {}, priority: 1 });
    const visit = async () => {
      await pub(offset(c, -200, 0), { speed: 1 });
      await sleep(1200);
      await pub(c, { speed: 0 });
      await sleep(2500);
      await pub(offset(c, -200, 0), { speed: 1 });
      await sleep(COOLOFF_MS + 500);
    };
    // ---- control: outside quiet hours the push goes out and both chime.
    let hits = webhook.hits.length;
    let t = await mark();
    await visit();
    const loud = await observe(t, [fence.id]);
    const pushedLoud = webhook.hits.length - hits;
    sameForBoth(loud, 1);
    check(pushedLoud === 1, `outside quiet hours the webhook got ${pushedLoud} pushes`);
    check(loud.chimesN.length === 1, `Nishtha heard ${loud.chimesN.length} chimes outside quiet hours`);

    // ---- set quiet hours in Settings, around now in her timezone.
    const hm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    const from = hm(new Date(Date.now() - 3600_000));
    const to = hm(new Date(Date.now() + 3600_000));
    await nishtha.nav('Settings');
    await nishtha.page.getByLabel('From', { exact: true }).fill(from);
    await nishtha.page.getByLabel('To', { exact: true }).fill(to);
    await nishtha.page.getByLabel('Timezone', { exact: true }).fill('Asia/Kolkata');
    await nishtha.page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await nishtha.page.getByText('Settings saved').waitFor({ timeout: 5000 });
    const settingsShot = await nishtha.shot(SHOTS, 'G-quiet-hours');
    const { user } = await nishtha.api('GET', '/api/v1/me');
    check(user.quietFrom === from && user.quietTo === to, `quiet hours saved as ${user.quietFrom}–${user.quietTo}`);
    await nishtha.nav('Live map');
    // Back on the map: let it finish loading before the crossing, as it would
    // have long before anyone walked anywhere.
    await nishtha.stableViewport();
    await waitFor('Nishtha’s basemap to finish loading', async () => Date.now() - (nishtha.tiles.at(-1)?.at ?? 0) > 1500, { timeout: 20000, every: 200 });

    hits = webhook.hits.length;
    t = await mark();
    await visit();
    const quiet = await observe(t, [fence.id]);
    const pushedQuiet = webhook.hits.length - hits;
    sameForBoth(quiet, 1);
    check(pushedQuiet === 0, `during quiet hours the webhook got ${pushedQuiet} pushes`);
    check(quiet.chimesN.length === 0, `Nishtha heard ${quiet.chimesN.length} chimes during her quiet hours`);
    check(quiet.chimesH.length === 1, `Harsh (not in quiet hours) heard ${quiet.chimesH.length} chimes`);
    const shots = [settingsShot, await nishtha.shot(SHOTS, 'G-quiet-toast')];
    await nishtha.api('PATCH', '/api/v1/me', { quietFrom: '', quietTo: '' });
    await goHome();
    return { outside: { pushes: pushedLoud, ...summary(loud) }, quiet: { window: `${from}–${to}`, pushes: pushedQuiet, ...summary(quiet) }, shots };
  });

  // ---------------------------------------------------------------- H
  await scenario('H', 'Thirty fences and a long trail: frame time while gliding, label legibility', async () => {
    const c = AREA.H;
    // Main-thread cost per second of wall time, from Chrome's own counters:
    // unlike frame time, it does not depend on how busy the machine's GPU is.
    const cdp = await harsh.ctx.newCDPSession(harsh.page);
    await cdp.send('Performance.enable');
    const counters = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const measure = async () => {
      const a = await counters();
      const frames = await frameTimes();
      const b = await counters();
      const per = (k) => Math.round(((b[k] - a[k]) / (b.Timestamp - a.Timestamp)) * 1000);
      return { frameMs: stats(frames.slice(1)), longFrames: frames.filter((f) => f > 50).length, mainThreadMsPerS: { task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration') } };
    };
    const frameTimes = () => harsh.page.evaluate(() => new Promise((resolve) => {
      const out = [];
      let last = performance.now();
      const t0 = last;
      const tick = (now) => {
        out.push(now - last);
        last = now;
        if (now - t0 < 5000) requestAnimationFrame(tick); else resolve(out);
      };
      requestAnimationFrame(tick);
    }));
    // Nishtha drives a loop round the block the whole time: her marker glides
    // and her trail grows across every fence.
    const loop = [offset(c, -330, -250), offset(c, 330, -250), offset(c, 330, 250), offset(c, -330, 250)];
    const run = sim(loop, { interval: '500ms', scale: 3, loops: 0, jitter: 2 });
    // Control: the same view, the same glide, no fences. Headless Chrome draws
    // the map in software, so frame time is judged against this, not an absolute.
    await centreOn(harsh, c, 16);
    await sleep(4000);
    const control = await measure();

    const names = [];
    for (let i = 0; i < 30; i += 1) {
      const col = i % 6;
      const row = Math.floor(i / 6);
      const name = `Stop ${String(i + 1).padStart(2, '0')}`;
      names.push(name);
      const at = offset(c, (col - 2.5) * 110, (row - 2) * 110);
      const body = i % 3 === 0
        ? { name, shape: 'polygon', polygon: box(at, 60, 50), triggers: ['arrive'] }
        : { name, shape: 'circle', center: at, radiusM: 35, triggers: i % 3 === 1 ? ['passby'] : ['arrive'] };
      await harsh.api('POST', '/api/v1/places', body);
    }
    await waitFor('the thirty fences on Harsh’s map', async () => (await harsh.page.getByRole('button', { name: /^Place Stop / }).count()) >= 10, { timeout: 5000 });
    const out = { control };
    for (const zoom of [16, 15]) {
      await centreOn(harsh, c, zoom);
      await sleep(4000); // let the trail build up and the camera settle
      const perf = await measure();
      // The name pills as drawn (Overlays.tsx tags each one), not the fences.
      const boxes = await harsh.page.evaluate(() => [...document.querySelectorAll('[data-testid^="lura-fence-label-"]')].flatMap((el) => {
        let pill = el;
        while (pill.firstElementChild && pill.getBoundingClientRect().width >= 179) pill = pill.firstElementChild;
        const r = pill.getBoundingClientRect();
        const n = (el.innerText || '').split('\n')[0];
        return r.width > 0 && el.offsetParent !== null ? [{ n, x: r.left, y: r.top, width: r.width, height: r.height }] : [];
      }));
      let overlaps = 0;
      const pairs = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          if (w > 2 && h > 2) {
            overlaps += 1;
            if (pairs.length < 5) pairs.push(`${a.n}/${b.n}`);
          }
        }
      }
      out[`z${zoom}`] = {
        ...perf,
        labelsDrawn: boxes.length,
        labelOverlaps: overlaps,
        overlapping: pairs,
        shot: await harsh.shot(SHOTS, `H-thirty-fences-z${zoom}`),
      };
    }
    run.stop();
    await run.done.catch(() => {});
    for (const z of ['z16', 'z15']) {
      const r = out[z];
      // Thirty fences may cost the main thread a little, not a lot: at most
      // 150 ms of work per second more than the same glide without them.
      const extra = r.mainThreadMsPerS.task - control.mainThreadMsPerS.task;
      check(extra <= 150, `${z}: thirty fences add ${extra} ms of main-thread work per second (${JSON.stringify(r.mainThreadMsPerS)} vs ${JSON.stringify(control.mainThreadMsPerS)})`);
      check(r.labelOverlaps === 0, `${z}: ${r.labelOverlaps} fence labels overlap (${r.overlapping})`);
    }
    check(out.z16.labelsDrawn >= 8, `only ${out.z16.labelsDrawn} labels drawn at z16`);
    await goHome();
    return out;
  });

  // ---------------------------------------------------------------- I
  if (process.env.E2E_SHOTS !== '0') {
    await scenario('I', 'Every screen, both people, desktop and phone, light and dark', async () => {
      const c = AREA.I;
      const corner = await watchedFence({ name: 'Corner Store', shape: 'circle', center: offset(c, 0, -400), radiusM: 40, triggers: ['passby'] });
      const shots = [];
      const a11y = {};
      const layoutIssues = [];
      const rect = async (loc) => ((await loc.count()) ? loc.first().boundingBox() : null);
      const intersects = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      /** tilesQuiet waits until the basemap has stopped fetching tiles, so a shot shows a map, not a beige box. */
      const tilesQuiet = (p) => waitFor('the basemap to finish loading', async () => {
        const last = p.tiles.at(-1)?.at ?? 0;
        return Date.now() - last > 900;
      }, { timeout: 15000, every: 150 }).catch(() => {});
      const tourFor = async (p, tag) => {
        const page = p.page;
        const snap = async (name) => shots.push(await p.shot(SHOTS, `I-${tag}-${name}`));
        await p.nav('Live map');
        // Corner Store and Nishtha's pass-by line in the middle of the view.
        await centreOn(p, offset(c, 0, -400), 16);
        await tilesQuiet(p);
        await snap('live');
        // A toast, from a real crossing.
        await sleep(COOLOFF_MS);
        await pub(offset(c, -150, -400), { speed: 14 });
        await sleep(6000);
        await pub(offset(c, 150, -400), { speed: 14 });
        await page.locator('[aria-label$="Show on the map."]').first().waitFor({ timeout: 8000 }).catch(() => {});
        await sleep(600);
        await snap('toast');
        // The toast must never sit on the map's own controls.
        const toastBox = await rect(page.locator('[aria-label$="Show on the map."]'));
        for (const control of ['Zoom in', 'Zoom out', 'Recentre on my device']) {
          const box = await rect(page.getByRole('button', { name: control, exact: true }));
          if (intersects(toastBox, box)) layoutIssues.push(`${tag}: the toast covers "${control}"`);
        }
        const bell = page.locator('[aria-label^="Notifications"]').first();
        for (let i = 0; i < 2; i += 1) {
          await bell.click();
          if (await page.getByText('Mark all read').first().isVisible().catch(() => false)) break;
          await sleep(500);
          if (await page.getByText('Mark all read').first().isVisible().catch(() => false)) break;
        }
        await sleep(400);
        await snap('notifications');
        await page.getByRole('button', { name: 'Close', exact: true }).click().catch(() => page.keyboard.press('Escape'));
        await sleep(300);
        await page.locator('[aria-label^="Change basemap"]').click();
        await sleep(400);
        await snap('basemap-picker');
        // Six basemaps in a three-by-two grid: the first three share a row.
        const tops = [];
        for (const name of ['Streets map', 'Light map', 'Dark map']) tops.push((await rect(page.getByRole('radio', { name })))?.y);
        if (!tops.every((y) => y !== undefined && Math.abs(y - tops[0]) < 2)) layoutIssues.push(`${tag}: the basemap grid is not three wide (${tops})`);
        await page.locator('[aria-label^="Close basemap picker"]').click().catch(() => page.keyboard.press('Escape'));
        if (p === harsh) {
          for (const mode of ['Circle', 'Polygon', 'Freehand']) {
            await page.getByRole('button', { name: 'Draw' }).click();
            await sleep(250);
            if (mode === 'Circle') await snap('draw-menu');
            await page.getByRole('menuitem', { name: mode }).click();
            await sleep(400);
            const v = await p.stableViewport(300);
            const mid = { x: v.left + v.width / 2, y: v.top + v.height / 2 };
            if (mode === 'Polygon') {
              for (const [dx, dy] of [[-60, -40], [50, -50], [60, 40]]) {
                await page.mouse.click(mid.x + dx, mid.y + dy);
                await sleep(150);
              }
            }
            await snap(`editor-${mode.toLowerCase()}`);
            await page.getByRole('button', { name: 'Cancel' }).first().click().catch(() => {});
            await sleep(300);
          }
          await page.getByRole('button', { name: 'Place Corner Store' }).first().click();
          await page.getByRole('button', { name: 'Edit shape' }).click();
          await page.getByText('Drag the circle to move it · drag the edge handle to resize').waitFor({ timeout: 5000 });
          await sleep(400);
          await snap('editor-edit');
          await page.getByRole('button', { name: 'Done', exact: true }).click().catch(() => {});
          await page.getByRole('button', { name: 'Deselect place' }).click().catch(() => {});
        }
        for (const [label, name] of [['People', 'people'], ['Places', 'places'], ['Notes', 'notes'], ['Sharing', 'sharing'], ['History', 'history'], ['Settings', 'settings']]) {
          await p.nav(label);
          await sleep(900);
          if (name === 'history') {
            await tilesQuiet(p);
            // The map is a band across the top on a phone, never a sliver at the side.
            const map = await p.viewport();
            const width = page.viewportSize().width;
            if (!map || map.width < (width < 840 ? width - 2 : 300)) layoutIssues.push(`${tag}: the History map is ${map?.width} px wide`);
          }
          await snap(name);
        }
        await p.nav('Live map');
      };
      for (const scheme of ['light', 'dark']) {
        for (const [vp, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
          for (const p of people) {
            await p.page.setViewportSize(size);
            await p.page.emulateMedia({ colorScheme: scheme });
          }
          await sleep(800);
          for (const p of people) await tourFor(p, `${p.name.toLowerCase()}-${vp}-${scheme}`);
        }
      }
      // ---- keyboard: every focusable control on the live map has a name.
      for (const p of people) {
        await p.page.setViewportSize({ width: 1440, height: 900 });
        await p.page.emulateMedia({ colorScheme: 'light' });
        await p.nav('Live map');
        await p.page.mouse.click(5, 450);
        const seen = [];
        for (let i = 0; i < 40; i += 1) {
          await p.page.keyboard.press('Tab');
          const el = await p.page.evaluate(() => {
            const a = document.activeElement;
            if (!a || a === document.body) return null;
            const r = a.getBoundingClientRect();
            const style = getComputedStyle(a);
            return {
              name: (a.getAttribute('aria-label') || a.innerText || a.getAttribute('placeholder') || '').trim().slice(0, 60),
              role: a.getAttribute('role') || a.tagName.toLowerCase(),
              visible: r.width > 0 && r.height > 0,
              ring: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
            };
          });
          if (el) seen.push(el);
        }
        const unnamed = seen.filter((e) => !e.name);
        const names = [...new Set(seen.map((e) => e.name))];
        a11y[p.name] = { stops: seen.length, unnamed: unnamed.length, noRing: seen.filter((e) => !e.ring).map((e) => e.name), names };
        check(unnamed.length === 0, `${p.name}: ${unnamed.length} focusable controls without a name: ${JSON.stringify(unnamed)}`);
        for (const want of ['Draw', 'Notifications', 'Zoom in', 'Zoom out']) {
          check(names.some((n) => n.startsWith(want)), `${p.name}: "${want}" is not reachable by Tab (${names.join(' | ')})`);
        }
        await p.page.keyboard.press('Shift+Tab');
        shots.push(await p.shot(SHOTS, 'I-focus-ring'));
      }
      check(corner.id, 'no Corner Store');
      check(layoutIssues.length === 0, `layout: ${layoutIssues.join('; ')}`);
      return { screenshots: shots.length, a11y, dir: SHOTS };
    });
  }

  // ---------------------------------------------------------------- Z
  await scenario('Z', 'No page errors, console errors or failed requests in either browser', async () => {
    const report = {};
    for (const p of people) {
      // The suite's own deliberate 400s (scenario E) are not the app's.
      const bad = p.badResponses.filter((r) => !/\/favicon\.ico$/.test(r.url) && !(r.method === 'POST' && r.status === 400 && r.url.endsWith('/api/v1/places')));
      report[p.name] = { errors: p.errors, badResponses: bad };
    }
    const problems = people.flatMap((p) => [...report[p.name].errors, ...report[p.name].badResponses]);
    check(problems.length === 0, `problems: ${JSON.stringify(report, null, 1)}`);
    return report;
  });
} catch {
  // The setup failed; everything else was skipped.
} finally {
  for (const child of sims) child.kill('SIGINT');
  sink.close();
  const pass = results.length > 0 && results.every((r) => r.pass);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, results }, null, 2));
  process.stdout.write(`\n${pass ? 'ALL EDGE SCENARIOS PASSED' : 'FAILED'} — ${OUT}/results.json\n`);
  for (const p of people) await p.close().catch(() => {});
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
