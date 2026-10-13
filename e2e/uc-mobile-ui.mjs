// The release flow on a phone, end to end, with a finger: both people at
// 390 × 844 (isMobile, hasTouch), then again at 768 × 1024 (a portrait tablet).
//
// scenario.mjs proves the release on a desktop with a mouse. This suite walks
// the same use cases the way a person holding a phone does — taps on the bottom
// tabs, the people sheet, the draw menu; touch drags to pan the map, draw a
// circle and an outline, and move, resize and reshape a fence by its handles —
// and judges every screen it passes through with the layout audit in
// lib/touch.mjs: every control at least 44 × 44 px, nothing covering a
// control, no two controls on top of each other, no text cut off or running off
// the screen, no sideways scroll, and the controls that matter (the tabs, Draw,
// zoom, locate, the bell) reachable while a sticky reminder card is up.
//
// Use cases (each PASS/FAIL in results.json, with its evidence):
//   UC0  sign in on a phone; the live map and the bottom tabs
//   UC1  connect: Harsh invites from People, Nishtha accepts, both ways
//   UC2  live tracking: both move; follow from the people sheet; publish
//   UC3  draw a polygon (taps), a circle (drag) and an outline (stroke)
//   UC4  move and resize the circle, reshape the polygon, by touch
//   UC5  a note for both of them, written on the phone
//   UC6  the crossing: sticky reminder cards on both phones, Acknowledge
//   UC7  the notification centre
//   UC8  History: the day's timeline and its map
//   UC9  Settings, and a tour of every screen for both people
//   UC10 Sharing: a link made on the phone, opened on a phone, revoked
//   UC11 the same screens, and a fence edit and a crossing, on a tablet
//   UC12 no page errors, console errors or failed requests
//
// Environment: run.sh's (E2E_SUITE=uc-mobile-ui), plus
//   E2E_UCS=UC1,UC3   run a subset (UC0 always runs; later ones need earlier ones)
//   E2E_TABLET=0      skip UC11
//   E2E_LAYOUT=report list layout problems without failing on them

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, sleep, waitFor } from './lib/browser.mjs';
import { haversineM, lerp, metresPerPixel, pointInPolygon } from './lib/geo.mjs';
import { PHONE, TABLET, TouchPerson, problems } from './lib/touch.mjs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:8098';
const API = process.env.E2E_API ?? BASE;
process.env.E2E_API = API;
const OUT = process.env.E2E_OUT ?? '/tmp/lura-uc-mobile-ui';
const LURASIM = process.env.E2E_LURASIM ?? 'lurasim';
const COOLOFF_MS = Number(process.env.E2E_COOLOFF_MS ?? 16000);
const ONLY = (process.env.E2E_UCS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// E2E_LAYOUT=report lists layout problems without failing on them (to survey a screen).
const LAYOUT_STRICT = process.env.E2E_LAYOUT !== 'report';
const SHOTS = `${OUT}/shots`;
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ geography
// scenario.mjs's Indiranagar, so the two suites read alike.
const HARSH_START = { lat: 12.9786, lon: 77.6398 };
const NISHTHA_START = { lat: 12.9702, lon: 77.6378 };
const NISHTHA_LOOP = [NISHTHA_START, { lat: 12.9702, lon: 77.6352 }, { lat: 12.9688, lon: 77.6352 }, { lat: 12.9688, lon: 77.6378 }];
const GROCERY = { lat: 12.973, lon: 77.642 };
const ROUTE_IN = { lat: 12.9712, lon: 77.6402 };
const ROUTE_OUT = { lat: 12.9752, lon: 77.6442 };
const ROUTE_HOME = { lat: 12.9712, lon: 77.6465 };
const PHARMACY = { lat: 12.9768, lon: 77.6352 };
const PARK = { lat: 12.9762, lon: 77.6468 };

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADED !== '1',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const harsh = new TouchPerson({ name: 'Harsh', email: 'harsh@lura.local', password: 'lura-harsh', start: HARSH_START });
const nishtha = new TouchPerson({ name: 'Nishtha', email: 'nishtha@lura.local', password: 'lura-nishtha', start: NISHTHA_START });
const people = [harsh, nishtha];

const results = [];
const facts = {};
const sims = new Set();
/** Every audit taken, for results.json, and what in them failed. */
const audits = [];

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function uc(id, title, fn) {
  if (ONLY.length && id !== 'UC0' && id !== 'UC12' && !ONLY.includes(id)) {
    results.push({ id, title, pass: true, skipped: true });
    process.stdout.write(`\n[${id}] ${title}\n  SKIPPED\n`);
    return;
  }
  const started = Date.now();
  const auditsBefore = audits.length;
  process.stdout.write(`\n[${id}] ${title}\n`);
  // A use case that failed can leave an editor, a sheet or a place card open;
  // each one starts from a plain screen, as a person who closed it would.
  if (id !== 'UC0') for (const p of people) await tidy(p).catch(() => {});
  try {
    const evidence = await fn();
    // Every screen this use case passed through must have passed its audit.
    const bad = audits.slice(auditsBefore).flatMap((a) => a.problems);
    if (LAYOUT_STRICT) check(bad.length === 0, `layout:\n    ${bad.join('\n    ')}`);
    else if (bad.length) process.stdout.write(`  LAYOUT (not failing, E2E_LAYOUT=report):\n    ${bad.join('\n    ')}\n`);
    results.push({ id, title, pass: true, ms: Date.now() - started, evidence });
    process.stdout.write(`  PASS ${JSON.stringify(evidence)}\n`);
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - started, error: String(err?.stack ?? err) });
    process.stdout.write(`  FAIL ${err?.stack ?? err}\n`);
    for (const p of people) await p.shot(SHOTS, `fail-${id}`).catch(() => {});
    if (id === 'UC0') throw err;
  } finally {
    for (const child of sims) child.kill('SIGINT');
  }
}

async function tidy(p) {
  const page = p.page;
  const dialog = page.locator('[aria-modal="true"]');
  if (await dialog.count()) await p.tap(dialog.last().getByRole('button', { name: 'Close', exact: true }).last(), { timeout: 3000 }).catch(() => {});
  for (const name of ['Cancel', 'Done', 'Deselect place']) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible())) await p.tap(b.first(), { timeout: 3000 }).catch(() => {});
  }
}

/** look audits a person's screen and photographs it; problems fail the use case. */
async function look(p, name, opts = {}) {
  await sleep(opts.settle ?? 350);
  // A passing toast (one with a Dismiss button) covers whatever is under it for
  // its 5–9 s, as it is meant to; the screen is judged once it has gone, unless
  // the toast is what is being looked at.
  if (!opts.toasts) {
    await waitFor('passing toasts to go', async () => (await p.page.getByRole('button', { name: 'Dismiss', exact: true }).count()) === 0, { timeout: 15000 }).catch(() => {});
  }
  name = name.replace(new RegExp(`^${p.name.toLowerCase()}-`), '');
  const a = await p.audit(name, opts);
  const shot = await p.shot(SHOTS, `${facts.size ?? 'phone'}-${name}`);
  const bad = problems(a);
  audits.push({ ...a, shot, problems: bad });
  if (a.truncated.length) process.stdout.write(`  note: ${a.where}: truncated ${JSON.stringify(a.truncated.map((t) => t.full))}\n`);
  return { shot, controls: a.controls, problems: bad.length };
}

// ------------------------------------------------------------------ devices
function sim(device, route, { interval = '700ms', scale = 4, loops = 1, jitter = 3 } = {}) {
  const spec = route.map((p) => `${p.lat},${p.lon}${p.dwell ? `,${p.dwell}` : ''}`).join(';');
  const child = spawn(
    LURASIM,
    ['-url', API, '-token', device.token, `-device=${device.id}`, '-route', spec,
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

async function gpsWalk(person, path, periodMs = 2300) {
  for (const p of path) {
    await person.ctx.setGeolocation({ latitude: p.lat, longitude: p.lon, accuracy: 6 });
    await sleep(periodMs);
  }
}

const pageNow = (p) => p.page.evaluate(() => performance.now());
const since = (list, t) => list.filter((x) => x.t >= t);
const wholePx = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });

async function placeNamed(person, name) {
  return (await person.api('GET', '/api/v1/places')).places.find((p) => p.name === name);
}

async function pending(person) {
  return (await person.api('GET', '/api/v1/reminders?status=pending&limit=100')).reminders ?? [];
}

async function unreadBadge(person) {
  const label = await person.page.locator('[aria-label^="Notifications"]').first().getAttribute('aria-label');
  const m = /(\d+) unread/.exec(label ?? '');
  return m ? Number(m[1]) : 0;
}

// ------------------------------------------------------------------ the map
/** The live map's controls a person must always be able to reach. */
const MAP_KEYS = ['Draw', 'Share location', 'Zoom in', 'Zoom out', 'Recentre on my device', 'Notifications', 'Live map', 'People', 'Places', 'Notes', 'Sharing', 'History', 'Settings'];

/** zoomTo taps the zoom buttons until the map is within half a level of `zoom`. */
async function zoomTo(p, zoom) {
  for (let i = 0; i < 12; i += 1) {
    const v = await p.stableViewport(400);
    if (Math.abs(v.zoom - zoom) < 0.6) return v;
    await p.tap(p.page.getByRole('button', { name: v.zoom > zoom ? 'Zoom out' : 'Zoom in' }));
  }
  return p.stableViewport(400);
}

/** centreOn pans the map with a finger until a point sits mid-view. */
async function centreOn(p, point, zoom) {
  if (zoom !== undefined) await zoomTo(p, zoom);
  for (let i = 0; i < 4; i += 1) {
    const v = await p.stableViewport(400);
    const at = await p.px(point, v);
    const mid = { x: v.left + v.width / 2, y: v.top + v.height / 2 };
    if (Math.hypot(at.x - mid.x, at.y - mid.y) < 20) break;
    // Grab the map clear of the overlays (left of the control column, below the action row).
    const grab = { x: v.left + v.width * 0.4, y: v.top + v.height * 0.55 };
    const dx = Math.max(-v.width * 0.35, Math.min(v.width * 0.35, mid.x - at.x));
    const dy = Math.max(-v.height * 0.3, Math.min(v.height * 0.3, mid.y - at.y));
    await p.touchDrag(grab, { x: grab.x + dx, y: grab.y + dy }, { steps: 16 });
  }
  return p.stableViewport(500);
}

/** openSheet opens the live map's people sheet on a phone. */
async function openSheet(p) {
  await p.tap(p.page.getByRole('button', { name: /^Show devices, people and reminders/ }));
  await p.page.getByText('MY DEVICES').waitFor({ timeout: 5000 });
  await sleep(500); // the slide-up
}

async function closeSheet(p) {
  const dialog = p.page.locator('[aria-modal="true"]').last();
  await p.tap(dialog.getByRole('button', { name: 'Close', exact: true }).last());
  await sleep(500);
}

/** fillForm fills the new-place sheet with taps and the keyboard. */
async function fillPlaceForm(p, name, { triggers, watch }) {
  const page = p.page;
  const field = page.getByPlaceholder('Whole Foods');
  await p.tap(field);
  await field.fill(name);
  for (const t of ['Arrive', 'Leave', 'Dwell', 'Pass by']) {
    const box = page.getByRole('checkbox', { name: new RegExp(`^${t}`) }).first();
    const on = (await box.getAttribute('aria-checked')) === 'true';
    if (on !== triggers.includes(t)) await p.tap(box);
  }
  if (watch) await p.tap(page.getByRole('checkbox', { name: watch, exact: true }));
  await look(p, `${name.toLowerCase()}-form`);
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/places') && r.request().method() === 'POST');
  await p.tap(page.getByRole('button', { name: 'Create place' }));
  const res = await created;
  check(res.status() === 201 || res.status() === 200, `creating ${name}: HTTP ${res.status()} ${await res.text()}`);
  await sleep(700);
}

/** sameView is true when the camera did not move. */
const sameView = (a, b) => Math.abs(a.zoom - b.zoom) < 1e-6 && haversineM(a.center, b.center) < 0.05;

/** boxOf is a locator's on-screen box, or null. */
async function boxOf(loc) {
  return (await loc.count()) ? loc.first().boundingBox() : null;
}
const intersects = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// ------------------------------------------------------------------ the tour
/**
 * tour visits every screen with a finger and audits each one: the live map
 * (with its sheet, draw menu and basemap picker), People, Places, Notes,
 * Sharing, History, Settings and the notification centre.
 */
async function tour(p, tag) {
  const page = p.page;
  const out = {};
  await p.nav('Live map');
  await p.stableViewport(500);
  out.live = await look(p, `${tag}-live`, { keys: MAP_KEYS });
  await openSheet(p);
  out.sheet = await look(p, `${tag}-live-sheet`);
  await closeSheet(p);
  await p.tap(page.getByRole('button', { name: 'Draw' }));
  await sleep(300);
  out.drawMenu = await look(p, `${tag}-draw-menu`);
  await p.tap(page.getByRole('button', { name: 'Draw' }));
  await p.tap(page.locator('[aria-label^="Change basemap"]'));
  await sleep(400);
  // The open picker sits over the map: the fence labels under it wait until it closes.
  out.basemaps = await look(p, `${tag}-basemap-picker`, { ignore: ['^Place '] });
  await p.tap(page.locator('[aria-label^="Close basemap picker"]'));
  await p.tap(page.locator('[aria-label^="Notifications"]').first());
  await page.getByTestId('lura-notification-panel').waitFor({ timeout: 5000 });
  out.notifications = await look(p, `${tag}-notifications`, { settle: 500 });
  await p.tap(page.getByTestId('lura-notification-panel').getByRole('button', { name: 'Close', exact: true }));
  for (const [label, name] of [['People', 'people'], ['Places', 'places'], ['Notes', 'notes'], ['Sharing', 'sharing'], ['History', 'history'], ['Settings', 'settings']]) {
    await p.nav(label);
    await sleep(700);
    out[name] = await look(p, `${tag}-${name}`, { keys: ['Live map', 'People', 'Places', 'Notes', 'Sharing', 'History', 'Settings'] });
    // A long screen: the bottom of it too.
    const scrolled = await page.evaluate(() => {
      const s = [...document.querySelectorAll('div')].filter((d) => /(auto|scroll)/.test(getComputedStyle(d).overflowY) && d.scrollHeight > d.clientHeight + 40 && d.offsetParent !== null)
        .sort((a, b) => b.clientHeight - a.clientHeight)[0];
      if (!s) return false;
      s.scrollTop = s.scrollHeight;
      return true;
    });
    if (scrolled) out[`${name}End`] = await look(p, `${tag}-${name}-end`, { settle: 500 });
  }
  await p.nav('Live map');
  return out;
}

// ======================================================================
try {
  // ---------------------------------------------------------------- UC0
  await uc('UC0', 'Both sign in on a phone; the live map and its bottom tabs', async () => {
    await Promise.all(people.map((p) => p.open(browser, BASE, PHONE)));
    await Promise.all(people.map((p) => p.signIn()));
    for (const p of people) {
      const { user } = await p.api('GET', '/api/v1/me');
      p.id = user.id;
      p.displayName = user.displayName;
      await p.api('PATCH', '/api/v1/me', { quietFrom: '', quietTo: '', tz: 'Asia/Kolkata' });
    }
    check(harsh.id !== nishtha.id, 'both browsers are the same account');
    const out = {};
    for (const p of people) {
      // A first touch, as a person's would be, so Web Audio may start.
      await p.tapAt({ x: 200, y: 400 });
      const tabs = await p.page.evaluate(() =>
        [...document.querySelectorAll('[role="link"]')].filter((a) => a.offsetParent !== null).map((a) => {
          const r = a.getBoundingClientRect();
          return { name: a.getAttribute('aria-label'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        }),
      );
      check(tabs.length === 7, `${p.name}: ${tabs.length} bottom tabs: ${JSON.stringify(tabs)}`);
      // The tab bar is the bottom of the screen, within a thumb's reach.
      check(tabs.every((t) => t.y + t.h <= PHONE.height && t.y > PHONE.height - 100), `${p.name}: tabs not along the bottom: ${JSON.stringify(tabs)}`);
      out[p.name] = { tabs: tabs.map((t) => `${t.name} ${t.w}×${t.h}`), ...(await look(p, `${p.name.toLowerCase()}-signed-in`, { keys: MAP_KEYS })) };
    }
    return out;
  });

  // ---------------------------------------------------------------- UC1
  await uc('UC1', 'Connect: Harsh invites on People, Nishtha accepts, both share both ways', async () => {
    const page = harsh.page;
    await harsh.nav('People');
    await look(harsh, 'harsh-people-empty');
    const email = page.getByLabel('Email address of the person to invite');
    await harsh.tap(email);
    await email.fill(nishtha.email);
    await harsh.tap(page.getByRole('button', { name: 'Send invite' }));
    await page.getByText(`Invitation sent to ${nishtha.email}`).waitFor({ timeout: 10000 });
    await look(harsh, 'harsh-people-invited');

    await nishtha.nav('People');
    const accept = nishtha.page.getByRole('button', { name: /^Accept the invitation from Harsh/ });
    await waitFor('the invitation on Nishtha’s People screen', async () => {
      if (await accept.count()) return true;
      await nishtha.page.reload({ waitUntil: 'domcontentloaded' });
      return false;
    }, { timeout: 20000, every: 2500 });
    await look(nishtha, 'nishtha-people-invitation');
    await nishtha.tap(accept);
    for (const [me, them] of [[harsh, nishtha], [nishtha, harsh]]) {
      await waitFor(`${me.name} to share with ${them.name} both ways`, async () => {
        const row = (await me.api('GET', '/api/v1/people')).people.find((r) => r.peerId === them.id);
        return row && row.status === 'accepted' && row.sharing && row.sharingWithMe;
      });
      await waitFor(`${me.name}’s People screen to say both ways`, async () => {
        const text = await me.page.innerText('body');
        if (text.includes('Shares with you') && text.includes(`${them.name} can see you`)) return true;
        await me.page.reload({ waitUntil: 'domcontentloaded' });
        return false;
      }, { timeout: 20000, every: 2500 });
    }
    return { harsh: await look(harsh, 'harsh-people-connected'), nishtha: await look(nishtha, 'nishtha-people-connected') };
  });

  // ---------------------------------------------------------------- UC2
  await uc('UC2', 'Live tracking: each sees the other move; follow from the people sheet', async () => {
    await harsh.nav('Live map');
    await nishtha.nav('Live map');
    const created = await nishtha.api('POST', '/api/v1/devices', { name: 'Nishtha’s phone', kind: 'phone' });
    facts.nDevice = { id: created.device.id, token: created.pubToken };
    const nMarker = `peer_${facts.nDevice.id}`;

    // Harsh's phone publishes itself, switched on from the people sheet.
    await openSheet(harsh);
    await look(harsh, 'harsh-sheet-before-publish');
    await harsh.tap(harsh.page.getByRole('button', { name: 'Publish my location' }));
    await harsh.ctx.setGeolocation({ latitude: HARSH_START.lat, longitude: HARSH_START.lon, accuracy: 6 });
    const hDev = await waitFor('Harsh’s phone to register as a device', async () => {
      const { devices } = await harsh.api('GET', '/api/v1/devices');
      return devices.find((d) => d.lastPoint);
    }, { timeout: 20000 });
    facts.hDevice = { id: hDev.id };
    const hMarker = `peer_${facts.hDevice.id}`;

    const loop = sim(facts.nDevice, NISHTHA_LOOP, { interval: '1s', scale: 3, loops: 0 });
    await waitFor('Nishtha on Harsh’s map', () => harsh.marker(nMarker), { timeout: 20000 });
    await sleep(1500);
    // Follow her from the sheet: the sheet closes and the camera rides with her.
    await harsh.page.getByRole('switch', { name: `Follow ${nishtha.displayName} on the map` }).first().waitFor({ timeout: 10000 });
    const sheetShot = await look(harsh, 'harsh-sheet-publishing');
    await harsh.tap(harsh.page.getByRole('switch', { name: `Follow ${nishtha.displayName} on the map` }).first());
    const fromMiddle = async () => {
      const v = await harsh.viewport();
      const m = await harsh.marker(nMarker);
      return v && m ? Math.hypot(m.x - (v.left + v.width / 2), m.y - (v.top + v.height / 2)) : Infinity;
    };
    await waitFor('the camera to reach Nishtha', async () => (await fromMiddle()) <= 40, { timeout: 15000, every: 250 });
    const a = await harsh.marker(nMarker);
    await sleep(3000);
    const b = await harsh.marker(nMarker);
    const off = await fromMiddle();
    const followShot = await look(harsh, 'harsh-following', { keys: [...MAP_KEYS, `Stop following ${nishtha.displayName}`] });
    check(off <= 40, `following: Nishtha is ${Math.round(off)} px from the middle`);
    await harsh.tap(harsh.page.getByRole('button', { name: `Stop following ${nishtha.displayName}` }));
    await waitFor('the follow chip to go', async () => !(await harsh.page.getByRole('button', { name: `Stop following ${nishtha.displayName}` }).count()), { timeout: 5000 });
    loop.stop();
    await loop.done.catch(() => {});
    check(a && b, 'Nishtha’s marker vanished while followed');

    // Harsh walks; Nishtha watches him on her phone.
    const path = Array.from({ length: 6 }, (_, i) => lerp(HARSH_START, { lat: 12.9792, lon: 77.6422 }, (i + 1) / 6));
    const walk = gpsWalk(harsh, path, 2000);
    await waitFor('Harsh on Nishtha’s map', () => nishtha.marker(hMarker), { timeout: 20000 });
    const c = await nishtha.marker(hMarker);
    await walk;
    await sleep(2500);
    const d = await nishtha.marker(hMarker);
    check(c && d && haversineM(c, d) > 30, `Harsh's marker did not move on Nishtha's phone: ${JSON.stringify({ c, d })}`);
    check(haversineM(d, path.at(-1)) < 5, `Harsh's marker is ${haversineM(d, path.at(-1)).toFixed(1)} m from his last fix`);
    const rail = await harsh.page.innerText('body');
    return {
      follow: { offCentrePx: Math.round(off) },
      harshMovedOnNishthaM: Math.round(haversineM(c, d)),
      shots: [sheetShot.shot, followShot.shot, (await look(nishtha, 'nishtha-watching-harsh', { keys: MAP_KEYS })).shot],
      handle: /can see you/.test(rail),
    };
  });

  // ---------------------------------------------------------------- UC3
  await uc('UC3', 'Draw by touch: a polygon by taps, a circle by a drag, an outline by a stroke', async () => {
    const page = harsh.page;
    await harsh.nav('Live map');
    let v = await centreOn(harsh, { lat: (GROCERY.lat + PHARMACY.lat + PARK.lat) / 3, lon: (PHARMACY.lon + PARK.lon) / 2 }, 15);
    // Everything on screen with room for the shapes, clear of the overlays.
    for (let i = 0; i < 3; i += 1) {
      const all = await Promise.all([GROCERY, PHARMACY, PARK].map((p) => harsh.px(p, v)));
      const fits = all.every((p) => p.x > v.left + 60 && p.x < v.left + v.width - 80 && p.y > v.top + 130 && p.y < v.top + v.height - 170);
      if (fits) break;
      await harsh.tap(page.getByRole('button', { name: 'Zoom out' }));
      v = await harsh.stableViewport();
    }
    facts.drawZoom = v.zoom;

    // ---- polygon: four taps, then Done
    await harsh.tap(page.getByRole('button', { name: 'Draw' }));
    await harsh.tap(page.getByRole('menuitem', { name: 'Polygon' }));
    v = await harsh.stableViewport();
    const g = await harsh.px(GROCERY, v);
    const mpp = metresPerPixel(GROCERY.lat, v.zoom);
    const half = Math.max(30, Math.round(75 / mpp));
    const corners = [
      { x: g.x - half, y: g.y - half * 0.9 },
      { x: g.x + half, y: g.y - half },
      { x: g.x + half * 1.05, y: g.y + half * 0.85 },
      { x: g.x - half * 0.9, y: g.y + half },
    ].map(wholePx);
    for (const p of corners) {
      await harsh.tapAt(p);
      await sleep(300);
    }
    await page.getByText('4 corners · tap the first corner or Done to close').waitFor({ timeout: 5000 });
    await look(harsh, 'harsh-polygon-drawing', { exempt: [] });
    await harsh.tap(page.getByRole('button', { name: 'Done', exact: true }));
    await page.getByText('Polygon with 4 corners').waitFor({ timeout: 5000 });
    const expected = await Promise.all(corners.map((p) => harsh.ground(p.x, p.y, v)));
    await fillPlaceForm(harsh, 'Grocery', { triggers: ['Arrive', 'Leave', 'Pass by'], watch: 'Nishtha' });

    // ---- circle: a finger on the centre, dragged out to the radius
    await harsh.tap(page.getByRole('button', { name: 'Draw' }));
    await harsh.tap(page.getByRole('menuitem', { name: 'Circle' }));
    v = await harsh.stableViewport();
    const pc = wholePx(await harsh.px(PHARMACY, v));
    // A finger drags out a radius it can see: at least 48 px, whatever the zoom.
    const radiusPx = Math.max(48, Math.round(70 / metresPerPixel(PHARMACY.lat, v.zoom)));
    await harsh.touchDrag(pc, { x: pc.x + radiusPx, y: pc.y });
    await page.getByText(/^Circle of /).waitFor({ timeout: 5000 });
    const circleCenter = await harsh.ground(pc.x, pc.y, v);
    const circleRadius = haversineM(circleCenter, await harsh.ground(pc.x + radiusPx, pc.y, v));
    await fillPlaceForm(harsh, 'Pharmacy', { triggers: ['Arrive'] });

    // ---- outline: one stroke round the park
    await harsh.tap(page.getByRole('button', { name: 'Draw' }));
    await harsh.tap(page.getByRole('menuitem', { name: 'Freehand' }));
    v = await harsh.stableViewport();
    const pk = await harsh.px(PARK, v);
    const r = Math.round(55 / metresPerPixel(PARK.lat, v.zoom));
    const stroke = Array.from({ length: 41 }, (_, i) => {
      const a = (i / 40) * 2 * Math.PI;
      return { x: pk.x + r * Math.cos(a) * (1 + 0.15 * Math.sin(3 * a)), y: pk.y + r * 0.8 * Math.sin(a) };
    });
    await harsh.touchPath(stroke, { stepMs: 14 });
    await page.getByText(/^Polygon with \d+ corners/).waitFor({ timeout: 5000 });
    await fillPlaceForm(harsh, 'Park', { triggers: ['Arrive', 'Leave'] });
    const fences = await look(harsh, 'harsh-fences', { keys: MAP_KEYS });

    const grocery = await placeNamed(harsh, 'Grocery');
    const pharmacy = await placeNamed(harsh, 'Pharmacy');
    const park = await placeNamed(harsh, 'Park');
    check(grocery?.shape === 'polygon' && grocery.polygon.length === 4, `Grocery: ${JSON.stringify(grocery)}`);
    const pxM = metresPerPixel(GROCERY.lat, facts.drawZoom);
    const vertexErr = Math.max(...grocery.polygon.map((p, i) => haversineM(p, expected[i])));
    check(vertexErr < Math.max(2, pxM * 1.5), `Grocery's corners are up to ${vertexErr.toFixed(1)} m from the taps (1 px = ${pxM.toFixed(1)} m)`);
    check(grocery.watchUserIds.length === 1 && grocery.watchUserIds[0] === nishtha.id, `Grocery watches ${grocery.watchUserIds}`);
    check(['arrive', 'leave', 'passby'].every((t) => grocery.triggers.includes(t)), `Grocery triggers ${grocery.triggers}`);
    check(pharmacy?.shape === 'circle', `Pharmacy: ${JSON.stringify(pharmacy)}`);
    const centreErr = haversineM(pharmacy.center, circleCenter);
    check(centreErr < Math.max(3, pxM * 1.5), `Pharmacy's centre is ${centreErr.toFixed(1)} m from the touch`);
    check(Math.abs(pharmacy.radiusM - circleRadius) <= Math.max(4, circleRadius * 0.06), `Pharmacy radius ${pharmacy.radiusM} vs dragged ${circleRadius.toFixed(0)}`);
    check(park?.shape === 'polygon' && park.polygon.length >= 3 && pointInPolygon(PARK, park.polygon), `Park: ${park?.polygon.length} corners`);
    facts.grocery = grocery;
    facts.pharmacy = pharmacy;
    return {
      grocery: { vertexErrM: Math.round(vertexErr * 10) / 10 },
      pharmacy: { radiusM: pharmacy.radiusM, drawnM: Math.round(circleRadius), centreErrM: Math.round(centreErr * 10) / 10 },
      park: { corners: park.polygon.length },
      shot: fences.shot,
    };
  });

  // ---------------------------------------------------------------- UC4
  /**
   * editByTouch drags one editor handle with a finger and returns what it
   * saved, after checking the map under it held still.
   */
  async function dragHandle(p, placeId, from, to, what) {
    const before = await p.stableViewport(400);
    const patched = p.page.waitForResponse((r) => r.url().includes(`/api/v1/places/${placeId}`) && r.request().method() === 'PATCH', { timeout: 10000 });
    await p.touchDrag(from, to, { steps: 16, hold: 90 });
    const res = await patched.catch(() => null);
    check(res?.ok(), `${what}: no save after the drag (${res?.status()})`);
    const after = await p.stableViewport(400);
    check(sameView(before, after), `${what}: the map panned under the finger: ${JSON.stringify({ before: before.center, after: after.center })}`);
    return after;
  }

  await uc('UC4', 'Move and resize the circle, reshape the polygon, all by touch', async () => {
    const page = harsh.page;
    await harsh.tap(page.getByRole('button', { name: 'Place Pharmacy' }).first());
    await look(harsh, 'harsh-place-card', { keys: MAP_KEYS });
    await harsh.tap(page.getByRole('button', { name: 'Edit shape' }));
    await page.getByText('Drag the circle to move it · drag the edge handle to resize').waitFor();
    let v = await harsh.stableViewport();
    await look(harsh, 'harsh-edit-circle', { extraTargets: ['Move fence', 'Resize fence'], keys: ['Move fence', 'Resize fence', 'Done', 'Zoom in', 'Zoom out'] });

    // Move: grab the grip in the middle.
    const exactFrom = await harsh.px(facts.pharmacy.center, v);
    const grip = await boxOf(page.getByLabel('Move fence', { exact: true }));
    check(grip && Math.hypot(grip.x + grip.width / 2 - exactFrom.x, grip.y + grip.height / 2 - exactFrom.y) < 2, `the grip is not on the centre: ${JSON.stringify({ grip, exactFrom })}`);
    const from = wholePx(exactFrom);
    const delta = { x: 50, y: 40 };
    const expectCenter = await harsh.ground(exactFrom.x + delta.x, exactFrom.y + delta.y, v);
    v = await dragHandle(harsh, facts.pharmacy.id, from, { x: from.x + delta.x, y: from.y + delta.y }, 'moving the circle');

    // Resize: the edge handle, wherever on the rim the editor put it (east,
    // unless that is under the control column), dragged straight outwards.
    // Halfway, the live label says the size.
    const c = await harsh.px(expectCenter, v);
    await look(harsh, 'harsh-edit-circle-moved', { extraTargets: ['Move fence', 'Resize fence'], keys: ['Move fence', 'Resize fence', 'Done', 'Zoom in', 'Zoom out'] });
    const hb = await boxOf(page.getByLabel('Resize fence', { exact: true }));
    check(hb, 'no resize handle on screen');
    const edge = wholePx({ x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 });
    const rPx = Math.hypot(edge.x - c.x, edge.y - c.y);
    const out = { x: (edge.x - c.x) / rPx, y: (edge.y - c.y) / rPx };
    check(Math.abs(rPx - facts.pharmacy.radiusM / metresPerPixel(expectCenter.lat, v.zoom)) < 3, `the resize handle is ${rPx.toFixed(0)} px from the centre, not on the rim`);
    const grow = 30;
    const expectRadius = haversineM(expectCenter, await harsh.ground(edge.x + out.x * grow, edge.y + out.y * grow, v));
    const patched = page.waitForResponse((r) => r.url().includes(`/api/v1/places/${facts.pharmacy.id}`) && r.request().method() === 'PATCH', { timeout: 10000 });
    await harsh.touchDown(edge);
    await sleep(90);
    for (let i = 1; i <= 8; i += 1) {
      await harsh.touchMoveTo({ x: edge.x + out.x * (grow / 2) * (i / 8), y: edge.y + out.y * (grow / 2) * (i / 8) });
      await sleep(16);
    }
    const midLabel = await page.getByTestId('fence-metre-label').first().innerText().catch(() => '');
    const resizing = await look(harsh, 'harsh-resizing', { settle: 50 });
    for (let i = 1; i <= 8; i += 1) {
      await harsh.touchMoveTo({ x: edge.x + out.x * (grow / 2) * (1 + i / 8), y: edge.y + out.y * (grow / 2) * (1 + i / 8) });
      await sleep(16);
    }
    await harsh.touchUp();
    check((await patched.catch(() => null))?.ok(), 'resizing the circle did not save');
    check(/\d+\s*m/.test(midLabel), `no live radius label mid-drag (${midLabel})`);
    await harsh.tap(page.getByRole('button', { name: 'Done', exact: true }));

    // Reshape: the polygon's north-east corner, out by a finger.
    for (let i = 0; i < 4 && !(await page.getByRole('button', { name: 'Place Grocery' }).count()); i += 1) {
      await harsh.tap(page.getByRole('button', { name: 'Zoom out' }));
      await harsh.stableViewport();
    }
    await centreOn(harsh, GROCERY);
    await harsh.tap(page.getByRole('button', { name: 'Place Grocery' }).first());
    await harsh.tap(page.getByRole('button', { name: 'Edit shape' }));
    await page.getByText(/4 corners · up to/).waitFor();
    v = await harsh.stableViewport();
    await look(harsh, 'harsh-edit-polygon', { extraTargets: ['Move fence', 'Fence corner', 'Add a corner'], keys: ['Done', 'Zoom in', 'Zoom out'] });
    const corner = wholePx(await harsh.px(facts.grocery.polygon[1], v));
    const expectCorner = await harsh.ground(corner.x + 26, corner.y - 22, v);
    await dragHandle(harsh, facts.grocery.id, corner, { x: corner.x + 26, y: corner.y - 22 }, 'reshaping the polygon');
    await harsh.tap(page.getByRole('button', { name: 'Done', exact: true }));

    const pharmacy = await placeNamed(harsh, 'Pharmacy');
    const grocery = await placeNamed(harsh, 'Grocery');
    const centreErr = haversineM(pharmacy.center, expectCenter);
    check(haversineM(pharmacy.center, facts.pharmacy.center) > 20, 'the circle did not move');
    check(centreErr < 4, `the circle's centre is ${centreErr.toFixed(1)} m from where the finger left it`);
    check(Math.abs(pharmacy.radiusM - expectRadius) <= Math.max(4, expectRadius * 0.06), `radius ${pharmacy.radiusM} vs dragged ${expectRadius.toFixed(0)}`);
    const cornerErr = haversineM(grocery.polygon[1], expectCorner);
    check(cornerErr < 4, `the dragged corner is ${cornerErr.toFixed(1)} m off`);
    for (const i of [0, 2, 3]) check(haversineM(grocery.polygon[i], facts.grocery.polygon[i]) < 0.5, `corner ${i} moved`);
    facts.grocery = grocery;
    facts.pharmacy = pharmacy;
    const cardGone = page.getByRole('button', { name: 'Deselect place' });
    if (await cardGone.count()) await harsh.tap(cardGone);
    return {
      circle: { centreErrM: Math.round(centreErr * 10) / 10, radiusM: pharmacy.radiusM, expectedM: Math.round(expectRadius), midLabel },
      polygon: { cornerErrM: Math.round(cornerErr * 10) / 10 },
      shot: resizing.shot,
    };
  });

  // ---------------------------------------------------------------- UC5
  await uc('UC5', 'A note for both of them, written on the phone', async () => {
    const page = harsh.page;
    await harsh.nav('Notes');
    await look(harsh, 'harsh-notes-empty');
    const text = page.getByPlaceholder(/^e\.g\. buy oat milk/);
    await harsh.tap(text);
    await text.fill('buy milk');
    await sleep(700);
    await harsh.tap(page.getByRole('radio', { name: /^Grocery/ }));
    await harsh.tap(page.getByRole('radio', { name: /^Arrive/ }));
    await harsh.tap(page.getByRole('radio', { name: 'Nishtha', exact: true }));
    await harsh.tap(page.getByRole('checkbox', { name: 'Nishtha', exact: true }));
    await page.getByText(/Nishtha arrives at Grocery/).first().waitFor({ timeout: 5000 });
    const composer = await look(harsh, 'harsh-note-composer');
    const posted = page.waitForResponse((r) => r.url().endsWith('/api/v1/notes') && r.request().method() === 'POST');
    await harsh.tap(page.getByRole('button', { name: 'Add note' }));
    check((await posted).ok(), 'creating the note failed');
    const note = (await harsh.api('GET', '/api/v1/notes')).notes.find((n) => n.text === 'buy milk');
    check(note && note.placeId === facts.grocery.id && note.trigger === 'arrive' && note.watchUserId === nishtha.id, `note: ${JSON.stringify(note)}`);
    check(note.notifyUserIds.length === 2, `note notifies ${note.notifyUserIds}`);
    facts.note = note;
    const list = await look(harsh, 'harsh-notes');
    await harsh.nav('Live map');
    return { note: note.id, shots: [composer.shot, list.shot] };
  });

  // ---------------------------------------------------------------- UC6
  const crossing = (dwell = 8) => [{ ...ROUTE_IN }, { ...GROCERY, dwell }, { ...ROUTE_OUT }, { ...ROUTE_HOME }];

  /**
   * crossAndAcknowledge sends Nishtha past the grocery, waits for the sticky
   * reminder cards on both screens, checks they leave the map usable, and
   * acknowledges every one of them with a tap.
   */
  async function crossAndAcknowledge(tag, noteText = 'buy milk') {
    const t0 = { h: await pageNow(harsh), n: await pageNow(nishtha) };
    const badge0 = { h: await unreadBadge(harsh), n: await unreadBadge(nishtha) };
    const run = sim(facts.nDevice, crossing(), { interval: '700ms', scale: 4 });
    const card = (p) => p.page.locator('[aria-label^="Reminder: "]');
    for (const p of people) await waitFor(`${p.name}’s sticky reminder card`, async () => (await card(p).count()) > 0, { timeout: 60000 });
    // The moment it fires: card and passing toasts together, and still every map control in reach.
    for (const p of people) await look(p, `${tag}-${p.name.toLowerCase()}-crossing`, { toasts: true, keys: MAP_KEYS, settle: 600 });
    await run.done;
    await sleep(2500);
    const out = {};
    for (const p of people) {
      // The toasts of this crossing have timed out by now (5–9 s); the cards stay.
      await waitFor(`${p.name}’s passing toasts to go`, async () =>
        (await p.page.locator('[aria-label$="Show on the map."]').count()) === (await card(p).count()), { timeout: 15000 }).catch(() => {});
      const shot = await look(p, `${tag}-${p.name.toLowerCase()}-reminder-card`, { keys: MAP_KEYS });
      // The card must not sit on the map's own controls or the sheet handle.
      const cb = await boxOf(card(p));
      for (const name of ['Draw', 'Share location', 'Zoom in', 'Zoom out', 'Recentre on my device']) {
        const b = await boxOf(p.page.getByRole('button', { name, exact: true }));
        check(!intersects(cb, b), `${p.name}: the reminder card covers "${name}" (${JSON.stringify({ card: cb, control: b })})`);
      }
      const handle = await boxOf(p.page.getByRole('button', { name: /^Show devices, people and reminders/ }));
      check(!intersects(cb, handle), `${p.name}: the reminder card covers the people sheet's handle`);
      const vp = p.page.viewportSize();
      check(cb.x >= 0 && cb.x + cb.width <= vp.width && cb.y >= 0, `${p.name}: the card is off screen: ${JSON.stringify(cb)}`);
      const fold = p.page.getByRole('button', { name: /^Show \d+ more pending reminders$/ });
      out[p.name] = { cards: await pending(p).then((r) => r.length), box: cb, folded: await fold.count(), shot: shot.shot };
    }
    // Acknowledge, one tap per card, until none is left.
    for (const p of people) {
      for (let i = 0; i < 6 && (await card(p).count()); i += 1) {
        const ack = p.page.getByRole('button', { name: /^Acknowledge / }).first();
        const ackBox = await boxOf(ack);
        check(ackBox && ackBox.height >= 44 && ackBox.width >= 44, `${p.name}: Acknowledge is ${ackBox?.width}×${ackBox?.height}`);
        const posted = p.page.waitForResponse((r) => /\/api\/v1\/reminders\/[^/]+\/ack$/.test(r.url()), { timeout: 10000 });
        await p.tap(ack);
        check((await posted.catch(() => null))?.ok(), `${p.name}: acknowledging failed`);
        await sleep(500);
      }
      await waitFor(`${p.name}’s cards to go`, async () => (await card(p).count()) === 0, { timeout: 10000 });
      const left = await pending(p);
      check(left.length === 0, `${p.name} still has ${left.length} pending reminders`);
    }
    const rec = { h: await harsh.record(), n: await nishtha.record() };
    const notifyN = since(rec.n.frames, t0.n).filter((f) => f.type === 'notify');
    check(notifyN.some((f) => f.data.kind === 'note' && f.data.title.concat(' ', f.data.body).includes(noteText)), `Nishtha got no "${noteText}" reminder`);
    const geoH = since(rec.h.frames, t0.h).filter((f) => f.type === 'geo' && f.data.placeId === facts.grocery.id).map((f) => f.data.trigger);
    check(geoH.includes('arrive'), `Harsh's crossings: ${geoH}`);
    facts.lastFireWall = Date.now();
    return { crossings: geoH, badgeBefore: badge0, badgeAfter: { h: await unreadBadge(harsh), n: await unreadBadge(nishtha) }, ...out, after: (await look(harsh, `${tag}-harsh-acknowledged`, { keys: MAP_KEYS })).shot };
  }

  await uc('UC6', 'Nishtha passes the grocery: sticky Acknowledge cards on both phones', async () => {
    for (const p of people) {
      await p.nav('Live map');
      const sheet = p.page.locator('[aria-modal="true"]');
      if (await sheet.count()) await closeSheet(p);
    }
    return crossAndAcknowledge('uc6');
  });

  // ---------------------------------------------------------------- UC7
  await uc('UC7', 'The notification centre on a phone', async () => {
    const out = {};
    for (const p of people) {
      const page = p.page;
      await p.tap(page.locator('[aria-label^="Notifications"]').first());
      const panel = page.getByTestId('lura-notification-panel');
      await panel.waitFor({ timeout: 5000 });
      const box = await panel.boundingBox();
      const vp = page.viewportSize();
      check(box.x >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1, `${p.name}: the panel runs off screen: ${JSON.stringify(box)}`);
      const items = await panel.locator('[aria-label*="Show on the map"], [role="button"][aria-label]').count();
      const text = await panel.innerText();
      check(/Grocery/.test(text), `${p.name}: the panel does not list the Grocery crossing: ${text.slice(0, 200)}`);
      out[p.name] = { panel: await look(p, `${p.name.toLowerCase()}-notification-centre`, { settle: 500 }), items };
      const markAll = panel.getByText('Mark all read');
      if (await markAll.count()) {
        await p.tap(markAll.first());
        await sleep(400);
      }
      await p.tap(panel.getByRole('button', { name: 'Close', exact: true }));
      await sleep(300);
      check((await unreadBadge(p)) === 0, `${p.name}: ${await unreadBadge(p)} still unread after Mark all read`);
    }
    return out;
  });

  // ---------------------------------------------------------------- UC8
  await uc('UC8', 'History: the day’s timeline and its map', async () => {
    const out = {};
    for (const p of people) {
      const page = p.page;
      await p.nav('History');
      await sleep(1200);
      const map = await p.viewport();
      const width = page.viewportSize().width;
      check(map && map.width >= width - 2, `${p.name}: the History map is ${map?.width} px wide on a ${width} px screen`);
      const rows = page.locator('[aria-label$=". Show on the map."]');
      await waitFor(`${p.name}’s timeline rows`, async () => (await rows.count()) > 0, { timeout: 10000 });
      out[p.name] = { rows: await rows.count(), first: await look(p, `${p.name.toLowerCase()}-history`) };
      // A row shows its moment on the map.
      await p.tap(rows.first());
      await sleep(800);
      out[p.name].tapped = await look(p, `${p.name.toLowerCase()}-history-row`);
      await p.tap(page.getByRole('button', { name: 'Previous day' }));
      await sleep(900);
      out[p.name].yesterday = await look(p, `${p.name.toLowerCase()}-history-yesterday`);
      await p.tap(page.getByRole('button', { name: 'Next day' }));
      await sleep(600);
    }
    return out;
  });

  // ---------------------------------------------------------------- UC9
  await uc('UC9', 'Settings, and every other screen, on a phone, for both', async () => {
    const out = {};
    for (const p of people) {
      out[p.name] = await tour(p, p.name.toLowerCase());
      await p.nav('Settings');
      check(await p.page.getByRole('button', { name: 'Sign out' }).count(), `${p.name}: no Sign out`);
      await p.nav('Live map');
    }
    return out;
  });

  // ---------------------------------------------------------------- UC10
  await uc('UC10', 'Sharing: a link made on the phone, opened on a phone, revoked', async () => {
    const page = harsh.page;
    await harsh.nav('Sharing');
    await sleep(600);
    await harsh.tap(page.getByRole('radio', { name: /^Until I revoke it/ }));
    const who = page.getByLabel('Who is it for?');
    await harsh.tap(who);
    await who.fill('Priya');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/shares') && r.request().method() === 'POST');
    await harsh.tap(page.getByRole('button', { name: 'Generate link' }));
    const res = await created;
    check(res.ok(), `creating the link: HTTP ${res.status()}`);
    const body = await res.json();
    const link = await waitFor('the link on screen', async () => {
      const t = await page.innerText('body');
      return /https?:\/\/\S+\/share\/\S+/.exec(t)?.[0];
    }, { timeout: 5000 });
    const made = await look(harsh, 'harsh-sharing-link');
    // Priya opens it on her phone, signed out.
    const viewer = new TouchPerson({ name: 'Priya', email: '', password: '', start: GROCERY });
    await viewer.open(browser, BASE, PHONE);
    await viewer.page.goto(link.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
    await viewer.page.locator('[data-testid="lura-map-viewport"], canvas').first().waitFor({ timeout: 20000 });
    await sleep(2500);
    const seen = await look(viewer, 'priya-share-viewer');
    // Revoke on the phone, from the active links list.
    const revoked = page.waitForResponse((r) => /\/api\/v1\/shares\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE');
    await harsh.tap(page.getByRole('button', { name: 'Revoke' }).first());
    check((await revoked).ok(), 'revoking failed');
    await sleep(1500);
    await viewer.page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const gone = await look(viewer, 'priya-share-revoked');
    const ended = await viewer.page.innerText('body');
    await viewer.close();
    viewer.errors.length = 0;
    return { share: body.share?.id ?? body.id, link: link.replace(/\/share\/.*/, '/share/<token>'), shots: [made.shot, seen.shot, gone.shot], viewerSays: ended.replace(/\s+/g, ' ').slice(0, 120) };
  });

  // ---------------------------------------------------------------- UC11
  if (process.env.E2E_TABLET !== '0') {
    await uc('UC11', 'A tablet (768 × 1024): every screen, a fence moved by touch, a crossing acknowledged', async () => {
      facts.size = 'tablet';
      for (const p of people) await p.page.setViewportSize(TABLET);
      await sleep(1200);
      const out = {};
      for (const p of people) out[p.name] = await tour(p, p.name.toLowerCase());
      // A fence moved by touch at this size.
      const page = harsh.page;
      await harsh.nav('Live map');
      await centreOn(harsh, (await placeNamed(harsh, 'Pharmacy')).center, 15);
      if (!(await page.getByRole('button', { name: 'Edit shape' }).count())) await harsh.tap(page.getByRole('button', { name: 'Place Pharmacy' }).first());
      await harsh.tap(page.getByRole('button', { name: 'Edit shape' }));
      const v = await harsh.stableViewport();
      await look(harsh, 'harsh-edit-circle', { extraTargets: ['Move fence', 'Resize fence'], keys: ['Move fence', 'Resize fence', 'Done'] });
      const grip = await boxOf(page.getByLabel('Move fence', { exact: true }));
      const from = wholePx({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 });
      const exact = await harsh.px((await placeNamed(harsh, 'Pharmacy')).center, v);
      const expectCenter = await harsh.ground(exact.x - 40, exact.y + 30, v);
      await dragHandle(harsh, facts.pharmacy.id, from, { x: from.x - 40, y: from.y + 30 }, 'moving the circle on a tablet');
      await harsh.tap(page.getByRole('button', { name: 'Done', exact: true }));
      const moved = await placeNamed(harsh, 'Pharmacy');
      check(haversineM(moved.center, expectCenter) < 4, `tablet: the circle is ${haversineM(moved.center, expectCenter).toFixed(1)} m from the finger`);
      const deselect = page.getByRole('button', { name: 'Deselect place' });
      if (await deselect.count()) await harsh.tap(deselect);
      // And a crossing, once the cool-off since the last has passed.
      const wait = COOLOFF_MS - (Date.now() - (facts.lastFireWall ?? 0));
      if (wait > 0) await sleep(wait);
      // "buy milk" fired in UC6 and is done (a note fires once), so Nishtha
      // gets a new one for this crossing, as Harsh would write it.
      await harsh.api('POST', '/api/v1/notes', { text: 'buy bread', placeId: facts.grocery.id, trigger: 'arrive', watchUserId: nishtha.id, notifyUserIds: [harsh.id, nishtha.id] });
      out.crossing = await crossAndAcknowledge('uc11', 'buy bread');
      return out;
    });
  }

  // ---------------------------------------------------------------- UC12
  await uc('UC12', 'No page errors, console errors or failed requests', async () => {
    const report = {};
    for (const p of people) {
      const bad = p.badResponses.filter((r) => !/\/favicon\.ico$/.test(r.url));
      report[p.name] = { errors: p.errors, badResponses: bad };
    }
    const all = people.flatMap((p) => [...report[p.name].errors, ...report[p.name].badResponses]);
    check(all.length === 0, `problems: ${JSON.stringify(report, null, 1)}`);
    return report;
  });
} catch {
  // UC0 failed; nothing else could run.
} finally {
  for (const child of sims) child.kill('SIGINT');
  const pass = results.length > 0 && results.every((r) => r.pass);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, results, audits }, null, 2));
  process.stdout.write(`\n${pass ? 'ALL MOBILE USE CASES PASSED' : 'FAILED'} — ${OUT}/results.json\n`);
  for (const p of people) await p.close().catch(() => {});
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
