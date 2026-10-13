// Use cases UC10 (share links) and UC12 (removing a connection), end to end:
// two signed-in browsers, anonymous browsers that only hold a link, and raw
// WebSockets and REST calls from Node, so "private" means the server never
// sent it, not that the app chose not to draw it.
//
//   UC10  Harsh shares "until I arrive at Office". A stranger's browser (no
//         account, no storage) opens the link: Harsh moving live, a countdown
//         or ending, nothing else — no places, notes or Nishtha. Arriving ends
//         the link for the viewer within seconds; revoking a duration link ends
//         it at once; an expired or garbage link is a clean page, never a 5xx.
//   UC12  After crossings both ways, Nishtha removes Harsh: from then on
//         neither receives the other's positions, geo events, reminders or
//         acknowledgements (both UIs, raw WS, API); notes about the other go
//         "on hold"; History keeps only each person's own records; a peer who
//         has not accepted cannot be watched (API 400 not_connected, UI hides
//         them); re-inviting works and starts clean.
//   P     Throughout: one person's History never holds the other's raw track.
//
// Environment (run.sh sets it): E2E_BASE, E2E_API, E2E_OUT, E2E_COOLOFF_MS
// (the server's cool-off, 15 s by default), E2E_ONLY=UC10,UC12 for a subset.

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, Person, sleep, waitFor } from './lib/browser.mjs';
import { INSTRUMENT } from './lib/instrument.mjs';
import { haversineM } from './lib/geo.mjs';
import { Wire, drive, mentions, pathsWith, pub } from './lib/wire.mjs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:8095';
const API = process.env.E2E_API ?? BASE;
const OUT = process.env.E2E_OUT ?? '/tmp/lura-uc-share-privacy';
const COOLOFF_MS = Number(process.env.E2E_COOLOFF_MS ?? 15000);
const ONLY = (process.env.E2E_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ the map
// Indiranagar, Bengaluru. Every route is a short straight drive at 12 m/s:
// driving through a fence is a pass-by (an arrival needs the device to settle,
// LURA_ARRIVE_MAX_SPEED), so the watched fences and their notes fire on passby.
const HARSH_START = { lat: 12.9794, lon: 77.6431 }; // 200 m south of Office
const NISHTHA_START = { lat: 12.9712, lon: 77.642 }; // 200 m south of Grocery
const OFFICE = { lat: 12.9812, lon: 77.6431 }; //    Harsh's, circle 80 m: the share ends here
const GROCERY = { lat: 12.973, lon: 77.642 }; //     Harsh's, polygon, watches Nishtha, "buy milk"
const GYM = { lat: 12.9812, lon: 77.6398 }; //       Nishtha's, circle, watches Harsh
const NORTH_OF_GROCERY = { lat: 12.9748, lon: 77.642 };
const WEST_OF_GYM = { lat: 12.9812, lon: 77.6381 };
const ring = (c, d) => [
  { lat: c.lat - d, lon: c.lon - d }, { lat: c.lat - d, lon: c.lon + d },
  { lat: c.lat + d, lon: c.lon + d }, { lat: c.lat + d, lon: c.lon - d },
];

// Words the share viewer must never show or be sent.
const SECRET_TEXT = ['buy milk', 'call the bank', 'ask Harsh about dinner', 'Grocery', 'Gym', 'Nishtha', 'nishtha@lura.local', 'harsh@lura.local', 'Priya', 'Ravi', 'Timer'];

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADED !== '1',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const harsh = new Person({ name: 'Harsh', email: 'harsh@lura.local', password: 'lura-harsh', start: HARSH_START });
const nishtha = new Person({ name: 'Nishtha', email: 'nishtha@lura.local', password: 'lura-nishtha', start: NISHTHA_START });
const people = [harsh, nishtha];
const viewers = [];
const wires = [];
const results = [];
const facts = {};

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function step(id, title, fn, { always = false } = {}) {
  const group = id.split('.')[0];
  if (ONLY.length && !always && !ONLY.includes(group) && !ONLY.includes(id)) {
    results.push({ id, title, skipped: true });
    return;
  }
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
    if (id.startsWith('UC10')) for (const v of viewers) await v.shot(`fail-${id}`).catch(() => {});
    if (always) throw err;
  }
}

/** apiStatus calls the API expecting it may refuse: { status, body }. */
async function apiStatus(person, method, path, body) {
  try {
    return { status: 200, body: await person.api(method, path, body) };
  } catch (err) {
    const m = /→ (\d{3}) (.*)$/s.exec(String(err.message));
    if (!m) throw err;
    let parsed = m[2];
    try { parsed = JSON.parse(m[2]); } catch { /* text */ }
    return { status: Number(m[1]), body: parsed };
  }
}

async function nav(p, label) {
  await p.page.getByRole('link', { name: new RegExp(`^${label}( \\d+)?$`) }).first().click();
  await sleep(500);
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function marker(page, id) {
  return page.evaluate((testId) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, lat: +el.dataset.lat, lon: +el.dataset.lon, label: el.dataset.label };
  }, `lura-marker-${id}`);
}

// ------------------------------------------------------------------ viewers
/**
 * Viewer is a stranger with a link: a fresh browser context — no Keycloak
 * session, no stored token, no geolocation — that opens /share/<token>.
 */
class Viewer {
  constructor(name, { phone = false } = {}) {
    this.name = name;
    this.phone = phone;
    this.errors = [];
    this.requests = [];
    this.bad = [];
  }

  async open(link) {
    this.ctx = await browser.newContext({
      viewport: this.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      isMobile: this.phone,
      hasTouch: this.phone,
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    await this.ctx.addInitScript(INSTRUMENT);
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', (err) => this.errors.push({ kind: 'pageerror', text: err.message, at: Date.now() }));
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') this.errors.push({ kind: 'console', text: msg.text(), url: msg.location()?.url, at: Date.now() });
    });
    this.page.on('request', (req) => this.requests.push({ url: req.url(), method: req.method(), at: Date.now() }));
    this.tiles = [];
    this.page.on('response', (res) => {
      if (res.status() >= 400) this.bad.push({ url: res.url(), status: res.status(), at: Date.now() });
      if (/tiles\.|\.pbf|\/\d+\/\d+\/\d+/.test(res.url()) && res.status() < 400) this.tiles.push(Date.now());
    });
    viewers.push(this);
    await this.page.goto(link, { waitUntil: 'domcontentloaded' });
    return this;
  }

  async text() {
    return bodyText(this.page);
  }

  async record() {
    return this.page.evaluate(() => window.__lura);
  }

  async ended() {
    return this.page.evaluate(() => {
      const el = document.querySelector('[data-testid="lura-share-ended"]');
      return el ? el.innerText : null;
    });
  }

  async shot(name) {
    // A software-GL basemap paints seconds after the page: wait for tiles to
    // arrive and go quiet, so the picture shows what a person would see.
    await waitFor(`${this.name}: the basemap`, () => {
      const last = this.tiles.at(-1);
      return last && Date.now() - last > 1500;
    }, { timeout: 20000, every: 250 }).catch(() => {});
    const path = `${OUT}/viewer-${this.name}-${name}.png`;
    await this.page.screenshot({ path, timeout: 90000 });
    return path;
  }

  async close() {
    await this.ctx?.close();
  }
}

/** shareTokenOf pulls the token out of a /share/<token> link. */
const tokenOf = (link) => new URL(link).pathname.split('/').pop();

/** pathsLeaking lists where any secret id or word appears in a value. */
function leaks(value) {
  const ids = [nishtha.id, facts.nDev?.id, facts.grocery?.id, facts.gym?.id, facts.milk?.id, facts.bank?.id, facts.dinner?.id].filter(Boolean);
  return [...ids.flatMap((id) => pathsWith(value, id)), ...mentions(value, SECRET_TEXT).map((w) => `text:${w}`)];
}

/**
 * historyHolds checks one person's History (API) against the other's raw
 * track: no point of the other's device in /history, its export, or a trip or
 * stop of the activity feed. Naming their phone in ?deviceId= is a 404
 * not_found, the same answer as a phone that does not exist (every store).
 */
async function historyHolds(me, them, theirDev) {
  const [all, theirRes, exp, feed] = await Promise.all([
    me.api('GET', '/api/v1/history?limit=20000'),
    fetch(`${API}/api/v1/history?deviceId=${theirDev.id}`, { headers: { Authorization: `Bearer ${await me.token()}` } })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
    fetch(`${API}/api/v1/history/export?format=geojson`, { headers: { Authorization: `Bearer ${await me.token()}` } }).then((r) => r.text()),
    me.api('GET', '/api/v1/activity?limit=1000'),
  ]);
  const theirs = theirRes.body ?? {};
  const theirPoints = (theirs.points ?? 0) + (theirs.track?.length ?? 0) + (theirs.segments?.length ?? 0);
  check(theirRes.status === 404 && theirs.code === 'not_found',
    `${me.name}'s /history?deviceId=<${them.name}'s phone> → ${theirRes.status} ${JSON.stringify(theirs).slice(0, 200)}; want 404 not_found`);
  const allLeak = pathsWith(all, theirDev.id);
  const expLeak = exp.includes(theirDev.id);
  const trips = feed.items.filter((i) => i.type === 'trip' || i.type === 'stop');
  const tripLeak = trips.filter((i) => i.deviceId !== me.dev.id);
  // A track point of theirs anywhere in my track: every point of mine must be one my device posted.
  check(theirPoints === 0, `${me.name}'s /history?deviceId=<${them.name}'s phone> returned ${theirPoints} points/segments`);
  check(allLeak.length === 0, `${me.name}'s /history names ${them.name}'s phone at ${allLeak.slice(0, 4)}`);
  check(!expLeak, `${me.name}'s history export names ${them.name}'s phone`);
  check(tripLeak.length === 0, `${me.name}'s activity has trips/stops of another device: ${JSON.stringify(tripLeak.slice(0, 2))}`);
  return { myPoints: all.points ?? all.track?.length ?? 0, myTrips: trips.length, theirPoints };
}

// ======================================================================
try {
  // ---------------------------------------------------------------- setup
  await step('0', 'Setup: both sign in; connected both ways; phones, places, notes; raw sockets', async () => {
    await Promise.all(people.map((p) => p.open(browser, BASE)));
    await Promise.all(people.map((p) => p.signIn()));
    for (const p of people) {
      const { user } = await p.api('GET', '/api/v1/me');
      p.id = user.id;
      p.displayName = user.displayName;
      await p.api('PATCH', '/api/v1/me', { quietFrom: '', quietTo: '' });
    }
    // Connected: Harsh invites over the API, Nishtha accepts on her People screen.
    await harsh.api('POST', '/api/v1/people/invite', { email: nishtha.email });
    await nav(nishtha, 'People');
    await nishtha.page.getByRole('button', { name: /^Accept the invitation from Harsh/ }).click();
    for (const [me, them] of [[harsh, nishtha], [nishtha, harsh]]) {
      await waitFor(`${me.name} connected to ${them.name} both ways`, async () => {
        const { people: rows } = await me.api('GET', '/api/v1/people');
        return rows.length === 1 && rows[0].peerId === them.id && rows[0].status === 'accepted' && rows[0].sharing && rows[0].sharingWithMe;
      });
    }
    // Phones: each posts with its own ingest token, as OwnTracks would.
    for (const [p, start] of [[harsh, HARSH_START], [nishtha, NISHTHA_START]]) {
      const created = await p.api('POST', '/api/v1/devices', { name: `${p.name}’s phone`, kind: 'phone' });
      p.dev = { id: created.device.id, token: created.pubToken };
      await pub(p.dev, start);
    }
    facts.hDev = harsh.dev;
    facts.nDev = nishtha.dev;
    const place = async (who, body) => { const r = await who.api('POST', '/api/v1/places', body); return r.place ?? r; };
    const note = async (who, body) => { const r = await who.api('POST', '/api/v1/notes', body); return r.note ?? r; };
    facts.office = await place(harsh, { name: 'Office', shape: 'circle', center: OFFICE, radiusM: 80, triggers: ['arrive', 'leave'] });
    facts.grocery = await place(harsh, { name: 'Grocery', shape: 'polygon', polygon: ring(GROCERY, 0.0007), triggers: ['arrive', 'passby'], watchUserIds: [nishtha.id] });
    facts.milk = await note(harsh, { text: 'buy milk', placeId: facts.grocery.id, trigger: 'passby', watchUserId: nishtha.id, notifyUserIds: [harsh.id, nishtha.id] });
    facts.bank = await note(harsh, { text: 'call the bank', placeId: facts.office.id, trigger: 'leave' });
    facts.gym = await place(nishtha, { name: 'Gym', shape: 'circle', center: GYM, radiusM: 70, triggers: ['arrive', 'passby'], watchUserIds: [harsh.id] });
    facts.dinner = await note(nishtha, { text: 'ask Harsh about dinner', placeId: facts.gym.id, trigger: 'passby', watchUserId: harsh.id, notifyUserIds: [nishtha.id, harsh.id] });
    for (const p of people) {
      p.wire = await new Wire(`${p.name}'s raw socket`, { token: await p.token() }).open();
      wires.push(p.wire);
    }
    for (const p of people) await nav(p, 'Live map');
    await waitFor('Nishtha on Harsh’s map', () => marker(harsh.page, `peer_${facts.nDev.id}`), { timeout: 20000 });
    await waitFor('Harsh on Nishtha’s map', () => marker(nishtha.page, `peer_${facts.hDev.id}`), { timeout: 20000 });
    return { harsh: harsh.id, nishtha: nishtha.id, hDev: facts.hDev.id, nDev: facts.nDev.id };
  }, { always: true });

  // ================================================================ UC10
  await step('UC10.1', 'Harsh creates an "until I arrive at Office" link (and a 30 min one) on the Sharing screen', async () => {
    const page = harsh.page;
    await nav(harsh, 'Sharing');
    const make = async ({ mode, label, place, minutes }) => {
      await page.getByRole('radio', { name: mode }).click();
      if (place) await page.getByRole('radio', { name: place, exact: true }).click();
      if (minutes) await page.getByLabel('Duration (minutes)').fill(String(minutes));
      await page.getByLabel('Who is it for?').fill(label);
      const res = page.waitForResponse((r) => r.url().endsWith('/api/v1/shares') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Generate link' }).click();
      const r = await res;
      check(r.status() === 201, `creating the ${label} link → ${r.status()}`);
      const { share } = await r.json();
      await waitFor(`the ${label} link on screen`, async () => (await bodyText(page)).includes(share.link), { timeout: 8000 });
      return share;
    };
    facts.arrive = await make({ mode: /^Until I arrive at a place/, label: 'Priya', place: 'Office' });
    const arriveShot = await harsh.shot(OUT, 'uc10-1-link-created');
    facts.ravi = await make({ mode: /^For a set duration/, label: 'Ravi', minutes: 30 });
    check(facts.arrive.mode === 'until_arrive' && facts.arrive.arrivePlaceId === facts.office.id, `the arrive link: ${JSON.stringify(facts.arrive)}`);
    check(new URL(facts.arrive.link).pathname.startsWith('/share/'), `the link is ${facts.arrive.link}, not the viewer page`);
    // The active list refetches after each create: wait for all three rows.
    for (const who of ['Priya', 'Ravi']) {
      await waitFor(`one Revoke button for ${who}`, async () => (await page.getByRole('button', { name: `Revoke the link for ${who}`, exact: true }).count()) === 1, { timeout: 8000 });
    }
    const text = await bodyText(page);
    check(text.includes('Until I arrive at Office'), 'the active list does not say "Until I arrive at Office"');
    check(/Timed · expires/.test(text), 'the active list does not show the timed link');
    return { arrive: facts.arrive.link, ravi: facts.ravi.link, shots: [arriveShot, await harsh.shot(OUT, 'uc10-1-two-links')] };
  });

  await step('UC10.2', 'A stranger opens the link: Harsh live with how it ends, nothing else; the same on a phone', async () => {
    const v = await new Viewer('stranger').open(facts.arrive.link);
    facts.stranger = v;
    await v.page.getByText('Harsh Singh').first().waitFor({ timeout: 30000 });
    await v.page.getByText('Sharing until they arrive at Office').waitFor({ timeout: 10000 });
    await waitFor('Harsh’s dot on the stranger’s map', () => marker(v.page, facts.hDev.id), { timeout: 20000 });
    // The raw view of the same link, from Node, with no credentials.
    const token = tokenOf(facts.arrive.link);
    const res = await fetch(`${API}/s/${token}`);
    const json = await res.json();
    check(res.status === 200 && res.headers.get('cache-control') === 'no-store', `GET /s/<token> → ${res.status} ${res.headers.get('cache-control')}`);
    const keys = Object.keys(json).sort();
    const allowed = ['arrivePlaceName', 'devices', 'expiresAt', 'map', 'mode', 'serverTime', 'sharerName'];
    check(keys.every((k) => allowed.includes(k)), `the public view has extra fields: ${keys}`);
    check(json.devices.length === 1 && json.devices[0].id === facts.hDev.id, `public devices: ${JSON.stringify(json.devices)}`);
    check(leaks(json).length === 0, `the public view leaks ${leaks(json)}`);
    facts.anonWire = await new Wire('the link’s raw socket', { path: `/s/${token}/ws` }).open();
    wires.push(facts.anonWire);
    const snap = facts.anonWire.frames.find((f) => f.type === 'snapshot');
    check(snap && leaks(snap).length === 0, `the link's snapshot frame leaks ${snap ? leaks(snap) : 'nothing (no snapshot)'}`);

    const text = await v.text();
    const shown = mentions(text, SECRET_TEXT);
    check(shown.length === 0, `the stranger's page shows ${shown}`);
    // No account, and acting like it: no control-plane call, no stored session.
    const control = v.requests.filter((r) => /\/api\/v1\//.test(r.url));
    check(control.length === 0, `the share page called the control plane: ${JSON.stringify(control.slice(0, 3))}`);
    const stored = await v.page.evaluate(() => Object.keys(localStorage).filter((k) => /session|token/i.test(k)));
    check(stored.length === 0, `the share page stored ${stored}`);
    const desktopShot = await v.shot('uc10-2-live');

    const phone = await new Viewer('phone', { phone: true }).open(facts.arrive.link);
    facts.phone = phone;
    await phone.page.getByText('Sharing until they arrive at Office').waitFor({ timeout: 30000 });
    await waitFor('Harsh’s dot on the phone', () => marker(phone.page, facts.hDev.id), { timeout: 20000 });
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `the phone page scrolls sideways by ${overflow}px`);
    return { keys, devices: json.devices.length, controlPlaneCalls: control.length, shots: [desktopShot, await phone.shot('uc10-2-live')] };
  });

  await step('UC10.3', 'Harsh drives toward Office while Nishtha crosses Grocery: the stranger sees only Harsh moving, framed', async () => {
    const v = facts.stranger;
    const t0 = Date.now();
    const recBefore = (await v.record()).frames.length;
    // Both at once: his drive stops 30 m short of the fence, hers runs through his watched fence.
    const stop = { lat: OFFICE.lat - 0.0010, lon: OFFICE.lon };
    const [hPosts] = await Promise.all([
      drive(facts.hDev, HARSH_START, stop, { mps: 10 }),
      drive(facts.nDev, NISHTHA_START, NORTH_OF_GROCERY, { mps: 12 }),
    ]);
    facts.nishthaCrossedAt = Date.now();
    await sleep(2500);
    const rec = await v.record();
    const frames = rec.frames.slice(recBefore);
    const positions = frames.filter((f) => f.type === 'position');
    const foreign = frames.filter((f) => f.type === 'position' && (f.deviceId !== facts.hDev.id || f.userId !== harsh.id));
    const other = frames.filter((f) => !['position', 'pong', 'hello', 'snapshot'].includes(f.type));
    const wireFrames = facts.anonWire.since(t0);
    const wireLeaks = wireFrames.flatMap((f) => leaks(f));
    const wireTypes = [...new Set(wireFrames.map((f) => f.type))];
    check(positions.length >= hPosts.length - 2, `the stranger's page got ${positions.length} of ${hPosts.length} fixes`);
    check(foreign.length === 0, `the stranger got someone else's positions: ${JSON.stringify(foreign.slice(0, 2))}`);
    check(other.length === 0, `the stranger got ${other.map((f) => f.type)}`);
    check(wireLeaks.length === 0 && wireTypes.every((t) => ['position', 'pong'].includes(t)), `the link's socket carried ${wireTypes} / ${wireLeaks.slice(0, 4)}`);
    // The dot is where the last fix put it, and inside the map, clear of the panel.
    const m = await marker(v.page, facts.hDev.id);
    const last = hPosts.at(-1).point;
    const off = haversineM({ lat: m.lat, lon: m.lon }, last);
    check(off < 2, `the stranger's dot is ${off.toFixed(1)} m from Harsh's last fix`);
    const frame = await v.page.evaluate(() => {
      const name = [...document.querySelectorAll('div')].find((d) => d.textContent === 'Harsh Singh');
      let el = name;
      while (el && getComputedStyle(el).position !== 'absolute') el = el.parentElement;
      const r = el?.getBoundingClientRect();
      return { panel: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null, w: innerWidth, h: innerHeight };
    });
    const inPanel = frame.panel && m.x >= frame.panel.left && m.x <= frame.panel.right && m.y >= frame.panel.top && m.y <= frame.panel.bottom;
    check(m.x > 0 && m.y > 60 && m.x < frame.w && m.y < frame.h && !inPanel, `the dot is out of frame or under the panel: ${JSON.stringify({ m, frame })}`);
    const moving = await v.text();
    check(/moving \d+ km\/h/.test(moving) || /just now/.test(moving), `the panel does not say Harsh is live: ${moving.slice(0, 200)}`);
    // Meanwhile the people who are entitled did hear about Nishtha (proves the leak check meant something).
    await waitFor('Harsh told that Nishtha arrived at Grocery', () =>
      harsh.wire.since(t0).some((f) => f.type === 'geo' && f.data?.placeId === facts.grocery.id && f.data?.subjectUserId === nishtha.id), { timeout: 10000 });
    return { fixes: hPosts.length, framesToStranger: positions.length, offM: Math.round(off * 10) / 10, wireTypes, shots: [await v.shot('uc10-3-moving'), await facts.phone.shot('uc10-3-moving')] };
  });

  await step('UC10.4', 'Harsh arrives at Office: the link ends for the viewer within seconds, and stays ended', async () => {
    const v = facts.stranger;
    const tWire = Date.now();
    // He has arrived when he stops inside: the last fix, at 0 m/s.
    const posts = await drive(facts.hDev, { lat: OFFICE.lat - 0.0010, lon: OFFICE.lon }, OFFICE, { mps: 10 });
    const arrivedAt = posts.at(-1).t1;
    const endedAt = await waitFor('the stranger’s page to say the share ended', async () => ((await v.ended()) ? Date.now() : null), { timeout: 15000, every: 100 });
    const phoneEndedAt = await waitFor('the phone to say so too', async () => ((await facts.phone.ended()) ? Date.now() : null), { timeout: 15000, every: 100 });
    const notice = await v.ended();
    check(/This share has ended/.test(notice) && /arrived at Office/.test(notice), `the notice reads "${notice}"`);
    const acl = facts.anonWire.since(tWire).find((f) => f.type === 'acl');
    check(acl?.data?.action === 'revoke' && /Office/.test(acl.data.reason) && leaks(acl).length === 0, `the link's socket revoke frame: ${JSON.stringify(acl)}`);
    check(!(await marker(v.page, facts.hDev.id)), 'Harsh’s dot is still on the ended page');
    check(!/\blive\b/.test(await v.text()), 'the ended page still says live');
    const endedShot = [await v.shot('uc10-4-ended'), await facts.phone.shot('uc10-4-ended')];

    // Positions after the end reach no one holding the link.
    const tAfter = Date.now();
    const recN = (await v.record()).frames.length;
    await drive(facts.hDev, OFFICE, { lat: OFFICE.lat + 0.0002, lon: OFFICE.lon }, { mps: 5 });
    await sleep(2000);
    const late = facts.anonWire.since(tAfter, (f) => f.type === 'position').length + (await v.record()).frames.slice(recN).filter((f) => f.type === 'position').length;
    check(late === 0, `${late} positions reached the link after it ended`);
    const res = await fetch(`${API}/s/${tokenOf(facts.arrive.link)}`);
    check(res.status === 403, `GET /s/<ended> → ${res.status}`);
    const wsRes = await fetch(`${API}/s/${tokenOf(facts.arrive.link)}/ws`);
    check(wsRes.status === 403, `GET /s/<ended>/ws → ${wsRes.status}`);
    // Reopening the link later: the same clean page, and no socket retry loop.
    await v.page.reload({ waitUntil: 'domcontentloaded' });
    await v.page.getByText('This share has ended').waitFor({ timeout: 20000 });
    await sleep(6000);
    const r2 = await v.record();
    check(r2.sockets <= 1, `the reopened ended link opened ${r2.sockets} sockets in 6 s`);
    check(!(await marker(v.page, facts.hDev.id)), 'the reopened ended link shows a dot');
    const reloadShot = await v.shot('uc10-4-reopened');
    // Harsh's own side: gone from the active list; History says why.
    await nav(harsh, 'Sharing');
    await waitFor('the Priya link to leave Harsh’s active list', async () => !(await bodyText(harsh.page)).includes('Until I arrive at Office'), { timeout: 8000 });
    check(endedAt - arrivedAt < 5000, `the link ended ${endedAt - arrivedAt} ms after Harsh arrived`);
    const feed = await harsh.api('GET', '/api/v1/activity?limit=200');
    const revoked = feed.items.find((i) => i.type === 'share' && i.action === 'revoked' && i.shareId === facts.arrive.id);
    check(revoked && /arrived at Office/.test(revoked.reason), `Harsh's activity has no "stopped sharing … arrived at Office": ${JSON.stringify(revoked)}`);
    return {
      endedAfterArrivalMs: endedAt - arrivedAt,
      phoneEndedAfterArrivalMs: phoneEndedAt - arrivedAt,
      notice,
      positionsAfterEnd: late,
      // The instrument restarts its count on reload: this is the reopened page's own.
      socketsAfterReopen: r2.sockets,
      shots: [...endedShot, reloadShot, await harsh.shot(OUT, 'uc10-4-sharing-after')],
    };
  });

  await step('UC10.5', 'Revoking the 30 min link on the Sharing screen ends it for its viewer at once', async () => {
    const v = await new Viewer('ravi').open(facts.ravi.link);
    await v.page.getByText(/Ends in (29|30) min · /).waitFor({ timeout: 30000 });
    await waitFor('Harsh’s dot on Ravi’s map', () => marker(v.page, facts.hDev.id), { timeout: 20000 });
    const countdown = (await v.text()).match(/Ends in [^\n]+/)?.[0];
    const liveShot = await v.shot('uc10-5-countdown');
    const res = harsh.page.waitForResponse((r) => r.url().includes(`/api/v1/shares/${facts.ravi.id}`) && r.request().method() === 'DELETE');
    await harsh.page.getByRole('button', { name: 'Revoke the link for Ravi' }).click();
    const t = Date.now();
    check((await res).ok(), 'revoking failed');
    const at = await waitFor('Ravi’s page to end', async () => ((await v.ended()) ? Date.now() : null), { timeout: 10000, every: 100 });
    const notice = await v.ended();
    check(/stopped sharing/.test(notice), `the notice reads "${notice}"`);
    check(!(await marker(v.page, facts.hDev.id)), 'the dot stayed after revoking');
    check(at - t < 3000, `ended ${at - t} ms after the revoke`);
    const r = await fetch(`${API}/s/${tokenOf(facts.ravi.link)}`);
    check(r.status === 403, `GET /s/<revoked> → ${r.status}`);
    await waitFor('the Ravi row to go', async () => (await harsh.page.getByRole('button', { name: 'Revoke the link for Ravi' }).count()) === 0, { timeout: 8000 });
    return { countdown, endedAfterRevokeMs: at - t, notice, shots: [liveShot, await v.shot('uc10-5-revoked'), await harsh.shot(OUT, 'uc10-5-revoked')] };
  });

  await step('UC10.6', 'A one-minute link counts down, expires for its open viewer, and reopens as a clean page', async () => {
    const timer = await harsh.api('POST', '/api/v1/shares', { label: 'Timer', mode: 'duration', durationMins: 1 });
    facts.timer = timer.share;
    const v = await new Viewer('timer').open(facts.timer.link);
    const expiresAt = Date.parse(facts.timer.expiresAt);
    // Under a minute from the first second: the countdown rounds up, never promising a minute that is not there.
    await v.page.getByText(/Ends in (1 min|under a minute)/).waitFor({ timeout: 30000 });
    await v.page.getByText(/Ends in under a minute/).waitFor({ timeout: 40000 });
    const before = await v.shot('uc10-6-counting');
    const at = await waitFor('the one-minute link to end on screen', async () => ((await v.ended()) ? Date.now() : null), { timeout: Math.max(5000, expiresAt - Date.now()) + 30000, every: 250 });
    const notice = await v.ended();
    check(/time ran out|expired/i.test(notice), `the notice reads "${notice}"`);
    check(at - expiresAt < 3000, `ended ${at - expiresAt} ms after it expired`);
    const r = await fetch(`${API}/s/${tokenOf(facts.timer.link)}`);
    check(r.status === 403, `GET /s/<expired> → ${r.status}`);
    await v.page.reload({ waitUntil: 'domcontentloaded' });
    await v.page.getByText('This share has ended').waitFor({ timeout: 20000 });
    return { endedAfterExpiryMs: at - expiresAt, notice, shots: [before, await v.shot('uc10-6-expired')] };
  });

  await step('UC10.7', 'Garbage tokens: a clean "does not work" page and 404s, never a 5xx', async () => {
    const tokens = ['not-a-real-token', 'A'.repeat(300), '%27%22%3E%3Cscript%3E', '..%2F..%2Fapi%2Fv1%2Fme', 'shr_' + facts.arrive.id.slice(4)];
    const statuses = [];
    for (const t of tokens) {
      const a = await fetch(`${API}/s/${t}`);
      const b = await fetch(`${API}/s/${t}/ws`);
      statuses.push([t.slice(0, 24), a.status, b.status]);
      check(a.status < 500 && b.status < 500, `/s/${t.slice(0, 30)} → ${a.status}/${b.status}`);
      check(a.status === 404 || a.status === 400, `/s/${t.slice(0, 30)} → ${a.status}, want 404`);
    }
    const v = await new Viewer('garbage').open(`${BASE}/share/not-a-real-token`);
    await v.page.getByText('This link does not work').waitFor({ timeout: 30000 });
    const text = await v.text();
    check(/no share at this address/.test(text), `the garbage page reads ${text.slice(0, 200)}`);
    const shot = await v.shot('uc10-7-garbage');
    await v.page.goto(`${BASE}/share/${'A'.repeat(300)}`, { waitUntil: 'domcontentloaded' });
    await v.page.getByText('This link does not work').waitFor({ timeout: 30000 });
    const fiveXX = viewers.flatMap((x) => x.bad.filter((b) => b.status >= 500));
    check(fiveXX.length === 0, `5xx: ${JSON.stringify(fiveXX)}`);
    return { statuses, shots: [shot] };
  });

  // ================================================================ UC12
  await step('P.1', 'While connected: neither History holds the other’s raw track (API and UI)', async () => {
    // Harsh drives through Nishtha's Gym (she watches him): she is told, as she is entitled to.
    const t0 = Date.now();
    await drive(facts.hDev, OFFICE, WEST_OF_GYM, { mps: 12 });
    await waitFor('Nishtha told Harsh arrived at Gym', () =>
      nishtha.wire.since(t0).some((f) => f.type === 'geo' && f.data?.placeId === facts.gym.id && f.data?.subjectUserId === harsh.id), { timeout: 10000 });
    await waitFor('Harsh got the "ask Harsh about dinner" reminder from Nishtha', () =>
      harsh.wire.since(t0).some((f) => f.type === 'notify' && /dinner/.test(f.data?.body ?? '')), { timeout: 10000 });
    const h = await historyHolds(harsh, nishtha, facts.nDev);
    const n = await historyHolds(nishtha, harsh, facts.hDev);
    // The UI: each History screen draws only its own track and names the other only in events.
    const ui = {};
    for (const [me, them] of [[harsh, nishtha], [nishtha, harsh]]) {
      await nav(me, 'History');
      await sleep(1500);
      const text = await bodyText(me.page);
      ui[me.name] = { mentionsTheirPhone: text.includes(`${them.name}’s phone`) };
      check(!ui[me.name].mentionsTheirPhone, `${me.name}'s History names ${them.name}'s phone`);
      ui[me.name].shot = await me.shot(OUT, 'p1-history-connected');
    }
    return { harsh: h, nishtha: n, ui };
  });

  await step('UC12.1', 'Nishtha removes Harsh on her People screen', async () => {
    // What each held before: kept afterwards as their own records.
    for (const p of people) {
      p.before = {
        feed: (await p.api('GET', '/api/v1/activity?limit=1000')).items,
        reminders: (await p.api('GET', '/api/v1/reminders?status=all&limit=500')).reminders ?? [],
        events: (await p.api('GET', '/api/v1/events?limit=500')).events,
      };
    }
    facts.peerGeoBefore = harsh.before.feed.filter((i) => i.type === 'geo' && i.subjectUserId === nishtha.id).length;
    check(facts.peerGeoBefore >= 1, 'Harsh had no record of Nishtha’s Grocery crossing before the removal');
    check(nishtha.before.reminders.some((r) => r.status === 'pending' && /buy milk/.test(r.body)), 'Nishtha holds no pending "buy milk" from Harsh to acknowledge later');
    await nav(nishtha, 'People');
    await nishtha.page.getByRole('button', { name: /^Remove Harsh/ }).click();
    const confirmShot = await nishtha.shot(OUT, 'uc12-1-confirm');
    const del = nishtha.page.waitForResponse((r) => r.url().includes('/api/v1/people/') && r.request().method() === 'DELETE');
    await nishtha.page.getByRole('button', { name: /^Remove Harsh .* for both of you/ }).click();
    check((await del).ok(), 'removing failed');
    facts.removedAt = Date.now();
    for (const p of people) {
      await waitFor(`${p.name}’s connections to be empty`, async () => (await p.api('GET', '/api/v1/people')).people.length === 0);
    }
    return { peerGeoBefore: facts.peerGeoBefore, shots: [confirmShot] };
  });

  await step('UC12.2', 'Both UIs drop the other; notes about the other go on hold; the watch on Grocery is gone', async () => {
    await nav(harsh, 'People');
    await waitFor('both People screens to say nothing flows', async () => {
      const [h, n] = [await bodyText(harsh.page), await bodyText(nishtha.page)];
      return [h, n].every((t) => t.includes('Your live position is not going to anyone.') && t.includes('No one is sending you their live position.'));
    }, { timeout: 10000 });
    const peopleShots = [await harsh.shot(OUT, 'uc12-2-people'), await nishtha.shot(OUT, 'uc12-2-people')];
    for (const p of people) await nav(p, 'Live map');
    await waitFor('both markers gone', async () => !(await marker(harsh.page, `peer_${facts.nDev.id}`)) && !(await marker(nishtha.page, `peer_${facts.hDev.id}`)), { timeout: 10000 });
    for (const p of people) {
      await waitFor(`${p.name}’s rail to put the note about the other on hold`, async () =>
        (await bodyText(p.page)).includes('On hold · the person it watches is no longer connected'), { timeout: 10000 });
    }
    const grocery = await harsh.api('GET', `/api/v1/places/${facts.grocery.id}`);
    const g = grocery.place ?? grocery;
    check(g.watchUserIds.length === 0, `Grocery still watches ${g.watchUserIds}`);
    const gym = await nishtha.api('GET', `/api/v1/places/${facts.gym.id}`);
    check((gym.place ?? gym).watchUserIds.length === 0, 'Gym still watches Harsh');
    const milk = await harsh.api('GET', `/api/v1/notes/${facts.milk.id}`);
    const m = milk.note ?? milk;
    check(m.watchUserId === nishtha.id && !m.done, `buy milk is ${JSON.stringify(m)}`);
    return { shots: [...peopleShots, await harsh.shot(OUT, 'uc12-2-on-hold'), await nishtha.shot(OUT, 'uc12-2-on-hold')] };
  });

  await step('UC12.3', 'After removal, crossings both ways reach no one (both UIs, raw WS, API)', async () => {
    await sleep(Math.max(0, COOLOFF_MS + 1000 - (Date.now() - facts.nishthaCrossedAt)));
    const t0 = Date.now();
    const rec0 = { h: (await harsh.record()).frames.length, n: (await nishtha.record()).frames.length, ht: (await harsh.record()).toasts.length, nt: (await nishtha.record()).toasts.length };
    await Promise.all([
      drive(facts.nDev, NORTH_OF_GROCERY, NISHTHA_START, { mps: 12 }),
      drive(facts.hDev, WEST_OF_GYM, OFFICE, { mps: 12 }),
    ]);
    await sleep(3000);
    const about = (frames, dev, user, myPlaces) => frames.filter((f) =>
      f.type !== 'pong' && (mentions(f, [dev, user]).length > 0 || (f.type === 'geo' && !myPlaces.includes(f.data?.placeId))));
    const hWire = about(harsh.wire.since(t0), facts.nDev.id, nishtha.id, [facts.office.id, facts.grocery.id]);
    const nWire = about(nishtha.wire.since(t0), facts.hDev.id, harsh.id, [facts.gym.id]);
    const nOwn = nishtha.wire.since(t0, (f) => f.type === 'position' && f.data?.deviceId === facts.nDev.id).length;
    const hOwn = harsh.wire.since(t0, (f) => f.type === 'position' && f.data?.deviceId === facts.hDev.id).length;
    check(nOwn > 5 && hOwn > 5, `the wire saw too few of their own fixes (${hOwn}, ${nOwn}) to prove anything`);
    check(hWire.length === 0 && nWire.length === 0, `after removal Harsh's socket got ${hWire.length} and Nishtha's ${nWire.length} frames about the other: ${JSON.stringify([...hWire, ...nWire].slice(0, 2))}`);
    const recH = await harsh.record();
    const recN = await nishtha.record();
    // Their own crossings (Harsh stops at his Office) still reach them; nothing naming the other may.
    const appH = recH.frames.slice(rec0.h).filter((f) => f.deviceId === facts.nDev.id || mentions(f, [nishtha.id, facts.nDev.id, 'Nishtha']).length > 0);
    const appN = recN.frames.slice(rec0.n).filter((f) => f.deviceId === facts.hDev.id || mentions(f, [harsh.id, facts.hDev.id, 'Harsh']).length > 0);
    check(appH.length === 0 && appN.length === 0, `the apps got ${appH.length} / ${appN.length} frames about the other: ${JSON.stringify([...appH, ...appN].slice(0, 2))}`);
    // Harsh's own arrival at Office toasts, as it should; nothing about the other may.
    const toastH = recH.toasts.slice(rec0.ht).filter((t) => /Nishtha/.test(`${t.label} ${t.text}`));
    const toastN = recN.toasts.slice(rec0.nt).filter((t) => /Harsh/.test(`${t.label} ${t.text}`));
    check(toastH.length === 0 && toastN.length === 0, `a toast about the other appeared after the removal: ${JSON.stringify([...toastH, ...toastN])}`);
    check(!(await marker(harsh.page, `peer_${facts.nDev.id}`)) && !(await marker(nishtha.page, `peer_${facts.hDev.id}`)), 'a marker came back');
    const api = {};
    for (const [me, them] of [[harsh, nishtha], [nishtha, harsh]]) {
      const reminders = (await me.api('GET', '/api/v1/reminders?status=all&limit=500')).reminders ?? [];
      const fresh = reminders.filter((r) => Date.parse(r.createdAt) >= facts.removedAt && (r.subjectUserId === them.id || r.fromUserId === them.id || r.ownerId === them.id));
      const events = (await me.api('GET', '/api/v1/events?limit=500')).events;
      const feed = (await me.api('GET', '/api/v1/activity?limit=1000')).items;
      const laterGeo = feed.filter((i) => i.type === 'geo' && i.subjectUserId === them.id && Date.parse(i.ts) >= facts.removedAt);
      api[me.name] = { newReminders: fresh.length, laterGeo: laterGeo.length };
      check(fresh.length === 0, `${me.name} got reminders after the removal: ${JSON.stringify(fresh.slice(0, 2))}`);
      // Their own crossings (Harsh stopping at Office) are recorded as ever; none of the other's.
      const theirs = (list) => list.filter((e) => e.subjectUserId === them.id || e.deviceId === them.dev.id).length;
      api[me.name].events = [theirs(me.before.events), theirs(events)];
      check(theirs(events) === theirs(me.before.events), `${me.name}'s trigger history of ${them.name} grew from ${theirs(me.before.events)} to ${theirs(events)}`);
      check(laterGeo.length === 0, `${me.name}'s activity shows ${them.name} moving after the removal`);
    }
    return { ownFixesSeen: { harsh: hOwn, nishtha: nOwn }, api };
  });

  await step('UC12.4', 'Acknowledging the other’s old reminder after removal stays private', async () => {
    const t0 = Date.now();
    const hers = (await nishtha.api('GET', '/api/v1/reminders?status=pending')).reminders.find((r) => /buy milk/.test(r.body));
    check(hers, 'Nishtha has no pending "buy milk"');
    // It is her own record, so she can still clear it; what must not happen is
    // Harsh hearing about it. (The ack goes over the API: which card the
    // "+N more" fold shows first is not what this checks.)
    await nishtha.api('POST', `/api/v1/reminders/${hers.id}/ack`);
    const his = (await harsh.api('GET', '/api/v1/reminders?status=pending')).reminders.find((r) => /dinner/.test(r.body));
    check(his, 'Harsh has no pending "ask Harsh about dinner"');
    await harsh.api('POST', `/api/v1/reminders/${his.id}/ack`);
    await sleep(2500);
    const toH = harsh.wire.since(t0, (f) => f.type === 'notify');
    const toN = nishtha.wire.since(t0, (f) => f.type === 'notify');
    check(toH.length === 0 && toN.length === 0, `acks after removal reached the other: ${JSON.stringify([...toH, ...toN].slice(0, 2))}`);
    const hAll = (await harsh.api('GET', '/api/v1/reminders?status=all&limit=500')).reminders;
    const nAll = (await nishtha.api('GET', '/api/v1/reminders?status=all&limit=500')).reminders;
    check(!hAll.some((r) => r.kind === 'ack' && r.fromUserId === nishtha.id), 'Harsh holds an "acknowledged" notice from Nishtha');
    check(!nAll.some((r) => r.kind === 'ack' && r.fromUserId === harsh.id), 'Nishtha holds an "acknowledged" notice from Harsh');
    const milk = await harsh.api('GET', `/api/v1/notes/${facts.milk.id}`);
    const dinner = await nishtha.api('GET', `/api/v1/notes/${facts.dinner.id}`);
    check(!(milk.note ?? milk).done && !(dinner.note ?? dinner).done, 'an ack after the removal ticked off the other person’s note');
    // Her own record does say she acknowledged it.
    const mine = nAll.find((r) => r.id === hers.id);
    check(mine?.status === 'acknowledged', `her reminder is ${mine?.status}`);
    return { notifyFramesToOther: toH.length + toN.length };
  });

  await step('UC12.5', 'History after removal: earlier entries stay as each person’s own; nothing later; no raw track', async () => {
    const out = {};
    for (const [me, them, myPlaces] of [[harsh, nishtha, [facts.office.id, facts.grocery.id]], [nishtha, harsh, [facts.gym.id]]]) {
      const feed = (await me.api('GET', '/api/v1/activity?limit=1000')).items;
      const geo = feed.filter((i) => i.type === 'geo');
      const foreignPlace = geo.filter((i) => !myPlaces.includes(i.placeId));
      const peerGeo = geo.filter((i) => i.subjectUserId === them.id);
      const removed = feed.find((i) => i.type === 'connection' && i.action === 'removed');
      check(foreignPlace.length === 0, `${me.name}'s activity has crossings of someone else's fences: ${JSON.stringify(foreignPlace.slice(0, 2))}`);
      check(peerGeo.every((i) => Date.parse(i.ts) < facts.removedAt), `${me.name}'s activity has ${them.name} moving after the removal`);
      check(removed && removed.byMe === (me === nishtha), `${me.name}'s activity: removal entry ${JSON.stringify(removed)}`);
      const keptBefore = me.before.feed.filter((i) => i.type === 'geo' && i.subjectUserId === them.id).length;
      check(peerGeo.length === keptBefore, `${me.name}'s earlier records of ${them.name} went from ${keptBefore} to ${peerGeo.length}`);
      out[me.name] = { ...(await historyHolds(me, them, them.dev)), peerCrossingsKept: peerGeo.length };
      await nav(me, 'History');
      const want = me === harsh ? 'Nishtha Dev removed the connection' : 'Removed Harsh Singh';
      await waitFor(`${me.name}'s History to show "${want}"`, async () => (await bodyText(me.page)).includes(want), { timeout: 10000 });
      out[me.name].shot = await me.shot(OUT, 'uc12-5-history');
    }
    const h = await bodyText(harsh.page);
    check(/Nishtha Dev passed Grocery/.test(h), 'Harsh’s History lost his earlier record of Nishtha passing Grocery');
    return out;
  });

  await step('UC12.6', 'Someone who has not accepted cannot be watched or notified (API 400 not_connected; UI hides them)', async () => {
    await nav(harsh, 'People');
    await harsh.page.getByLabel('Email address of the person to invite').fill(nishtha.email);
    await harsh.page.getByRole('button', { name: 'Send invite' }).click();
    await waitFor('the pending invitation', async () => (await harsh.api('GET', '/api/v1/people')).people[0]?.status === 'pending_out');
    const tries = {
      createWatch: await apiStatus(harsh, 'POST', '/api/v1/places', { name: 'Park', shape: 'circle', center: GYM, radiusM: 50, triggers: ['arrive'], watchUserIds: [nishtha.id] }),
      patchWatch: await apiStatus(harsh, 'PATCH', `/api/v1/places/${facts.grocery.id}`, { watchUserIds: [nishtha.id] }),
      noteNotify: await apiStatus(harsh, 'POST', '/api/v1/notes', { text: 'leak?', placeId: facts.grocery.id, trigger: 'arrive', notifyUserIds: [nishtha.id] }),
      noteWatch: await apiStatus(harsh, 'POST', '/api/v1/notes', { text: 'leak?', placeId: facts.grocery.id, trigger: 'arrive', watchUserId: nishtha.id }),
      herWatch: await apiStatus(nishtha, 'PATCH', `/api/v1/places/${facts.gym.id}`, { watchUserIds: [harsh.id] }),
    };
    for (const [k, r] of Object.entries(tries)) {
      check(r.status === 400 && JSON.stringify(r.body).includes('not_connected'), `${k} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    // The place form offers nobody to watch.
    await nav(harsh, 'Places');
    await harsh.page.getByText('Grocery', { exact: true }).first().click();
    await harsh.page.getByText('Edit Grocery').waitFor({ timeout: 10000 });
    await harsh.page.getByText('Watch people').waitFor({ timeout: 10000 });
    const form = await bodyText(harsh.page);
    check(form.includes('Connect with someone under People'), 'the place form does not explain that nobody can be watched');
    check((await harsh.page.getByRole('checkbox', { name: 'Nishtha', exact: true }).count()) === 0, 'the place form offers Nishtha, who has not accepted');
    await sleep(900); // the sheet slides in: let it land before the picture
    const shot = await harsh.shot(OUT, 'uc12-6-place-form-pending');
    await harsh.page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    await harsh.page.getByText('Edit Grocery').waitFor({ state: 'hidden', timeout: 5000 });
    return { statuses: Object.fromEntries(Object.entries(tries).map(([k, r]) => [k, r.status])), shots: [shot] };
  });

  await step('UC12.7', 'Nishtha accepts the new invitation: a clean start, and alerts flow again', async () => {
    const tAccept = Date.now();
    await nav(nishtha, 'People');
    await nishtha.page.getByRole('button', { name: /^Accept the invitation from Harsh/ }).click();
    for (const [me, them] of [[harsh, nishtha], [nishtha, harsh]]) {
      await waitFor(`${me.name} connected again`, async () => {
        const { people: rows } = await me.api('GET', '/api/v1/people');
        return rows.length === 1 && rows[0].peerId === them.id && rows[0].status === 'accepted' && rows[0].sharing && rows[0].sharingWithMe;
      });
    }
    await sleep(2500);
    // Nothing from the gap is replayed.
    const replay = [...harsh.wire.since(tAccept), ...nishtha.wire.since(tAccept)].filter((f) => f.type === 'geo' || f.type === 'notify');
    check(replay.length === 0, `the reconnection replayed ${JSON.stringify(replay.slice(0, 2))}`);
    const g = await harsh.api('GET', `/api/v1/places/${facts.grocery.id}`);
    check((g.place ?? g).watchUserIds.length === 0, 'the old Grocery watch came back on its own');
    for (const p of people) await nav(p, 'Live map');
    await waitFor('the On hold line to clear', async () => !(await bodyText(harsh.page)).includes('On hold · the person it watches is no longer connected'), { timeout: 10000 });
    await pub(facts.nDev, NISHTHA_START);
    await waitFor('Nishtha back on Harsh’s map', () => marker(harsh.page, `peer_${facts.nDev.id}`), { timeout: 15000 });
    await pub(facts.hDev, OFFICE);
    await waitFor('Harsh back on Nishtha’s map', () => marker(nishtha.page, `peer_${facts.hDev.id}`), { timeout: 15000 });
    // Alerts flow again: "buy milk" still watches her and is still open.
    const t0 = Date.now();
    await drive(facts.nDev, NISHTHA_START, NORTH_OF_GROCERY, { mps: 12 });
    await waitFor('Harsh told about Nishtha at Grocery again', () =>
      harsh.wire.since(t0).some((f) => f.type === 'notify' && /buy milk/.test(f.data?.body ?? '')), { timeout: 12000 });
    const feed = (await harsh.api('GET', '/api/v1/activity?limit=1000')).items;
    const gap = feed.filter((i) => i.type === 'geo' && i.subjectUserId === nishtha.id && Date.parse(i.ts) >= facts.removedAt && Date.parse(i.ts) < tAccept);
    check(gap.length === 0, `Harsh's activity holds ${gap.length} crossings from the gap`);
    const h = await historyHolds(harsh, nishtha, facts.nDev);
    const n = await historyHolds(nishtha, harsh, facts.hDev);
    return { gapCrossings: gap.length, history: { harsh: h, nishtha: n }, shots: [await harsh.shot(OUT, 'uc12-7-reconnected'), await nishtha.shot(OUT, 'uc12-7-reconnected')] };
  });

  await step('Z', 'No page errors, console errors or 5xx in any browser; only the expected refusals', async () => {
    const report = {};
    for (const p of people) {
      const bad = p.badResponses.filter((r) => !/favicon/.test(r.url) && !/:8085\//.test(r.url));
      report[p.name] = { errors: p.errors, bad };
    }
    for (const v of viewers) {
      // A viewer of an ended, expired or unknown link is refused on purpose
      // (403/404 on /s/…), and Chrome logs each refusal as a console error.
      const bad = v.bad.filter((r) => !(/\/s\/[^/]+(\/ws)?(\?|$)/.test(r.url) && [403, 404].includes(r.status)) && !/favicon/.test(r.url));
      const errors = v.errors.filter((e) => !/status of 40[34]|WebSocket connection to .*\/s\/.* failed/.test(e.text));
      report[`viewer-${v.name}`] = { errors, bad };
    }
    const problems = Object.values(report).flatMap((r) => [...r.errors, ...r.bad]);
    check(problems.length === 0, `problems: ${JSON.stringify(report, null, 1)}`);
    return Object.fromEntries(Object.entries(report).map(([k, r]) => [k, r.errors.length + r.bad.length]));
  }, { always: true });
} catch {
  // A setup step failed and has been recorded.
} finally {
  for (const w of wires) w.close();
  const ran = results.filter((r) => !r.skipped);
  const summary = { base: BASE, at: new Date().toISOString(), pass: ran.length > 0 && ran.every((r) => r.pass), partial: ONLY.length > 0, results };
  writeFileSync(`${OUT}/results.json`, JSON.stringify(summary, null, 2));
  process.stdout.write(`\n${summary.pass ? 'ALL UC STEPS PASSED' : 'FAILED'} — ${OUT}/results.json\n`);
  for (const r of ran) process.stdout.write(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(7)} ${r.title}\n`);
  for (const v of viewers) await v.close().catch(() => {});
  for (const p of people) await p.close().catch(() => {});
  await browser.close();
  process.exit(summary.pass ? 0 : 1);
}
