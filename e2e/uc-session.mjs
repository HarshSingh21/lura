// Long sessions and a laptop sleep, end to end, in two browsers.
//
// Harsh and Nishtha stay signed in and track each other — both browsers
// publish their own GPS — for longer than their access tokens live, and then
// Harsh's laptop sleeps while Nishtha walks into a fence he watches.
//
//   phase "app"  (lura-app, 15 min tokens)
//     S1  25 min tracking each other (≥ 1.5 token lifetimes), ending in a
//         crossing that notifies both;
//     S3  a silent sleep (no network event, the socket dies) of 3 min timed to
//         straddle Harsh's token expiry.
//   phase "edge" (lura-app-edge, 60 s tokens)
//     S2  6 min of the same;
//     S3a a sleep with the network gone for 3 min;
//     S3b a silent sleep of 3 min.
//
// Every token Keycloak hands out is recorded (expires_in, the token's own
// iat/exp, how far ahead of the previous token's expiry it was fetched), and so
// is the exp of every bearer the app sends Lura and every socket handshake, so
// "renewal works" is shown rather than assumed: no request with an expired
// token, no 401, no sign-out. tokens.json holds the full timeline.
//
// Environment (e2e/run.sh sets the first ones):
//   E2E_BASE / E2E_API / E2E_OUT / E2E_PHASE
//   E2E_UC_LONG_MS     length of S1 / S2 (default 25 min / 6 min)
//   E2E_UC_SLEEP_MS    length of each sleep (default 3 min)
//   E2E_UC_ONLY=S3b    just those scenarios (setup always runs)
//   E2E_HEADED=1

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, Person, sleep, waitFor } from './lib/browser.mjs';
import { haversineM, lerp } from './lib/geo.mjs';
import { HOST_NETWORK, Laptop, NOTICES, TokenLog, decodeJwt, maxGap, setOffline } from './lib/session.mjs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:8097';
const API = process.env.E2E_API ?? BASE;
const OUT = process.env.E2E_OUT ?? '/tmp/lura-uc-session';
const PHASE = process.env.E2E_PHASE ?? 'app';
const EDGE = PHASE === 'edge';
const LIFETIME_S = EDGE ? 60 : 900;
const LONG_MS = Number(process.env.E2E_UC_LONG_MS ?? (EDGE ? 6 * 60_000 : 25 * 60_000));
const SLEEP_MS = Number(process.env.E2E_UC_SLEEP_MS ?? 3 * 60_000);
const ONLY = (process.env.E2E_UC_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// The positions either way must never pause for longer than this.
const MAX_GAP_MS = 10_000;
// An arrive fires once someone has settled inside, or after the server's
// arrive debounce (LURA_ARRIVE_DEBOUNCE, 45 s) if they keep moving. A browser
// whose emulated GPS stops changing sends no slower fix, so allow the debounce.
const ARRIVE_MS = 60_000;
// After waking, the app has this long to renew its token and be live again.
const WAKE_BUDGET_MS = 5_000;
const STEP_MS = 2500;
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ the map
// Indiranagar, Bengaluru, as in the other suites.
const HARSH_A = { lat: 12.9766, lon: 77.6436 };
const HARSH_B = { lat: 12.9795, lon: 77.6398 };
const NISHTHA_A = { lat: 12.9702, lon: 77.6378 };
const NISHTHA_B = { lat: 12.9716, lon: 77.6392 };
const ring = (c, d) => [
  { lat: c.lat - d, lon: c.lon - d }, { lat: c.lat - d, lon: c.lon + d },
  { lat: c.lat + d, lon: c.lon + d }, { lat: c.lat + d, lon: c.lon - d },
];
const FENCES = {
  Grocery: { lat: 12.973, lon: 77.642 }, //  S1/S2: a note for both
  Bakery: { lat: 12.9675, lon: 77.6405 }, // S3a: crossed while Harsh sleeps offline
  Cafe: { lat: 12.9725, lon: 77.6325 }, //   S3b / S3: crossed while Harsh sleeps silently
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADED !== '1',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const harsh = new Person({ name: 'Harsh', email: 'harsh@lura.local', password: 'lura-harsh', start: HARSH_A });
const nishtha = new Person({ name: 'Nishtha', email: 'nishtha@lura.local', password: 'lura-nishtha', start: NISHTHA_A });
const people = [harsh, nishtha];
const results = [];
const facts = { t0: Date.now() };
// What ended the browser, if anything did before the suite closed it: a
// "Target page, context or browser has been closed" mid-scenario is otherwise
// indistinguishable from a bug in the step that tripped over it.
const lifecycle = [];
let closing = false;
function lifecycleEvent(what) {
  const e = { wall: Date.now(), at: new Date().toISOString(), what };
  lifecycle.push(e);
  if (!closing) process.stdout.write(`  !! ${e.at} ${what}\n`);
}
browser.on('disconnected', () => lifecycleEvent('the browser disconnected (Chrome exited or was killed)'));
// Playwright closes Chrome on SIGTERM/SIGHUP and keeps this process alive, so
// a signal from outside shows up as a browser that closed itself mid-scenario.
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => lifecycleEvent(`this run received ${sig}`));
const walkers = new Set();
const observers = [];

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function scenario(id, title, fn, { always = false } = {}) {
  if (ONLY.length && !always && !ONLY.includes(id)) {
    results.push({ id, title, skipped: true });
    process.stdout.write(`\n[${PHASE} ${id}] ${title}\n  SKIPPED (E2E_UC_ONLY)\n`);
    return;
  }
  const started = Date.now();
  process.stdout.write(`\n[${PHASE} ${id}] ${title}  (${new Date().toISOString()})\n`);
  try {
    const evidence = await fn();
    results.push({ id, title, pass: true, ms: Date.now() - started, evidence });
    process.stdout.write(`  PASS ${JSON.stringify(evidence)}\n`);
  } catch (err) {
    const gone = lifecycle.filter((e) => e.wall >= started);
    const cause = gone.length ? `\n  browser lifecycle during this scenario: ${JSON.stringify(gone)}` : '';
    results.push({ id, title, pass: false, ms: Date.now() - started, error: String(err?.stack ?? err) + cause });
    if (cause) process.stdout.write(cause + '\n');
    process.stdout.write(`  FAIL ${err?.stack ?? err}\n`);
    for (const p of people) await p.shot(OUT, `fail-${id}`).catch(() => {});
    if (always) throw err;
  } finally {
    for (const w of [...walkers]) await w.stop();
    await setOffline(harsh, false).catch(() => {});
  }
}

// --------------------------------------------------------------- helpers
async function uc(page) {
  return page.evaluate(() => window.__uc);
}

async function liveStatus(page) {
  return page.evaluate(() => document.querySelector('[data-testid="lura-live-status"]')?.dataset.status ?? null);
}

async function marker(page, id) {
  return page.evaluate((testId) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) return null;
    return { lat: +el.dataset.lat, lon: +el.dataset.lon, label: el.dataset.label, stale: el.dataset.stale === 'true' };
  }, `lura-marker-${id}`);
}

async function nav(p, label) {
  await p.page.getByRole('link', { name: new RegExp(`^${label}( \\d+)?$`) }).first().click();
  await sleep(400);
}

async function signedIn(p) {
  return p.page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    return !location.pathname.startsWith('/login') && !text.includes('Continue with email') && !!localStorage.getItem('lura.session.access');
  });
}

/** panelEntries opens the notification centre and lists its entries' labels. */
async function panelEntries(page) {
  await page.locator('[aria-label^="Notifications"]').first().click();
  await sleep(600);
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="lura-notification-panel"] [aria-label$="Show on the map."]')].map((e) => e.getAttribute('aria-label')),
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click().catch(() => page.keyboard.press('Escape'));
  await sleep(300);
  return labels;
}

/**
 * walk moves a person's emulated GPS (their browser is their device) there and
 * back between two points, one step every STEP_MS, until stopped.
 */
function walk(person, from, to, { steps = 30 } = {}) {
  let stopped = false;
  let i = 0;
  const errors = [];
  const done = (async () => {
    while (!stopped) {
      const leg = Math.floor(i / steps) % 2;
      const k = ((i % steps) + 1) / steps;
      const p = leg === 0 ? lerp(from, to, k) : lerp(to, from, k);
      person.at = p;
      try {
        await person.ctx.setGeolocation({ latitude: p.lat, longitude: p.lon, accuracy: 6 });
      } catch (err) {
        // A dead context would otherwise just look like a GPS that stopped.
        errors.push({ wall: Date.now(), error: String(err?.message ?? err) });
        if (/closed/.test(String(err?.message))) break;
      }
      i += 1;
      await sleep(STEP_MS);
    }
  })();
  const w = { errors, stop: async () => { stopped = true; walkers.delete(w); await done; } };
  walkers.add(w);
  return w;
}

/** walkTo walks a person from where they are to `to`, about 25 m a step. */
async function walkTo(person, to) {
  const from = person.at ?? person.start;
  const n = Math.max(2, Math.ceil(haversineM(from, to) / 25));
  for (let i = 1; i <= n; i += 1) {
    const p = lerp(from, to, i / n);
    person.at = p;
    await person.ctx.setGeolocation({ latitude: p.lat, longitude: p.lon, accuracy: 6 });
    await sleep(STEP_MS);
  }
}

/** Observer is a person's own WebSocket from Node: what the server pushed. */
class Observer {
  constructor(person) {
    this.person = person;
    this.frames = [];
  }

  async open() {
    const token = await this.person.token();
    this.ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws?access_token=${encodeURIComponent(token)}`);
    this.ws.onmessage = (ev) => {
      try {
        this.frames.push({ wall: Date.now(), ...JSON.parse(ev.data) });
      } catch {
        /* not ours to judge */
      }
    };
    await waitFor(`${this.person.name}'s observer socket`, () => this.frames.some((f) => f.type === 'hello'), { timeout: 10000 });
    this.ping = setInterval(() => {
      try { this.ws.send('{"type":"ping"}'); } catch { /* closed */ }
    }, 20000);
    observers.push(this);
    return this;
  }

  since(wall, pred = () => true) {
    return this.frames.filter((f) => f.wall >= wall && pred(f));
  }

  close() {
    clearInterval(this.ping);
    try { this.ws.close(); } catch { /* already */ }
  }
}

async function openPerson(p) {
  await p.open(browser, BASE);
  await p.ctx.addInitScript(HOST_NETWORK);
  await p.ctx.addInitScript(NOTICES);
  p.log = new TokenLog(p, API).attach();
  p.navigations = [];
  p.page.on('crash', () => lifecycleEvent(`${p.name}'s page crashed (renderer gone: out of memory?)`));
  p.page.on('close', () => lifecycleEvent(`${p.name}'s page closed`));
  p.ctx.on('close', () => lifecycleEvent(`${p.name}'s browser context closed`));
  p.page.on('framenavigated', (f) => {
    if (f === p.page.mainFrame()) p.navigations.push({ wall: Date.now(), url: f.url() });
  });
}

/**
 * sampleSession reads, every 5 s, whether each person is still signed in and
 * live, until stopped.
 */
function sampleSession() {
  const samples = [];
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const row = { wall: Date.now() };
      for (const p of people) {
        row[p.name] = {
          signedIn: await signedIn(p).catch(() => null),
          status: await liveStatus(p.page).catch(() => null),
          // How often this laptop's Wi-Fi has dropped so far (HOST_NETWORK
          // keeps it from the app; this keeps it in the record).
          hostDrops: await p.page.evaluate(() => window.__ucNet?.host.filter((e) => e.type === 'offline').length ?? null).catch(() => null),
        };
      }
      samples.push(row);
      await sleep(5000);
    }
  })();
  return { samples, stop: async () => { stopped = true; await done; } };
}

const nPeer = () => `peer_${facts.nDev}`;
const hPeer = () => `peer_${facts.hDev}`;

/** tokenChecks are the token assertions over a window, for both people. */
function tokenChecks(from, to, { minRefreshes }) {
  const out = {};
  for (const p of people) {
    const refreshes = p.log.refreshes(from, to);
    const failed = refreshes.filter((r) => r.status !== 200);
    const expired = p.log.expiredUses(from, to);
    const unauthorized = p.log.unauthorized.filter((u) => u.wall >= from && u.wall <= to);
    check(failed.length === 0, `${p.name}: refused renewals ${JSON.stringify(failed)}`);
    check(refreshes.length >= minRefreshes, `${p.name}: ${refreshes.length} renewals, expected ≥ ${minRefreshes}`);
    check(expired.length === 0, `${p.name}: sent an expired token ${expired.length}× ${JSON.stringify(expired.slice(0, 5))}`);
    check(unauthorized.length === 0, `${p.name}: 401s ${JSON.stringify(unauthorized)}`);
    // Each renewal lands ahead of the expiry of the token it replaces, by about
    // the margin refresh.ts sets (min(60 s, lifetime / 4)), not in a loop.
    const margin = Math.min(60, LIFETIME_S / 4);
    const leads = [];
    const all = p.log.tokens.filter((t) => t.status === 200);
    for (const r of refreshes) {
      const prev = all.filter((t) => t.wall < r.wall).at(-1);
      if (prev?.exp) leads.push(Math.round((prev.exp * 1000 - r.wall) / 1000));
    }
    check(leads.every((l) => l > 0 && l <= margin + 5), `${p.name}: renewal leads ${leads} s (margin ${margin} s)`);
    out[p.name] = {
      renewals: refreshes.length, leadsS: leads, lifetimesS: [...new Set(refreshes.map((r) => r.exp - r.iat))],
      bearersChecked: p.log.bearers.filter((b) => b.wall >= from && b.wall <= to).length,
      handshakesChecked: p.log.sockets.filter((b) => b.wall >= from && b.wall <= to).length,
      expiredUses: expired.length, unauthorized: unauthorized.length,
    };
  }
  return out;
}

// ======================================================================
try {
  await scenario('0', `Setup: both sign in through ${EDGE ? 'lura-app-edge (60 s tokens)' : 'lura-app (15 min tokens)'}, connect, publish`, async () => {
    await Promise.all(people.map(openPerson));
    await Promise.all(people.map((p) => p.signIn()));
    for (const p of people) {
      const first = await waitFor(`${p.name}'s first token`, () => p.log.tokens.find((t) => t.status === 200), { timeout: 10000 });
      check(first.exp - first.iat === LIFETIME_S, `${p.name}'s tokens live ${first.exp - first.iat} s, not ${LIFETIME_S} s — wrong client in the build?`);
      const { user } = await p.api('GET', '/api/v1/me');
      p.id = user.id;
      await p.api('PATCH', '/api/v1/me', { quietFrom: '', quietTo: '' });
    }
    // Crossed invitations accept each other.
    await Promise.all([
      harsh.api('POST', '/api/v1/people/invite', { email: nishtha.email }),
      nishtha.api('POST', '/api/v1/people/invite', { email: harsh.email }),
    ]);
    for (const [me, them] of [[harsh, nishtha], [nishtha, harsh]]) {
      await waitFor(`${me.name} connected both ways`, async () => {
        const { people: rows } = await me.api('GET', '/api/v1/people');
        return rows.length === 1 && rows[0].peerId === them.id && rows[0].status === 'accepted' && rows[0].sharing && rows[0].sharingWithMe;
      });
    }
    facts.places = {};
    for (const [name, c] of Object.entries(FENCES)) {
      const res = await harsh.api('POST', '/api/v1/places', { name, shape: 'polygon', polygon: ring(c, 0.0009), triggers: ['arrive'], watchUserIds: [nishtha.id] });
      facts.places[name] = res.place ?? res;
    }
    await harsh.api('POST', '/api/v1/notes', {
      text: 'buy milk', placeId: facts.places.Grocery.id, trigger: 'arrive', watchUserId: nishtha.id, notifyUserIds: [harsh.id, nishtha.id],
    });
    for (const p of people) {
      await nav(p, 'Live map');
      await p.page.getByRole('button', { name: 'Publish my location' }).click();
      await p.ctx.setGeolocation({ latitude: p.start.lat, longitude: p.start.lon, accuracy: 6 });
    }
    for (const p of people) {
      const dev = await waitFor(`${p.name}'s browser to register as a device`, async () => {
        const { devices } = await p.api('GET', '/api/v1/devices');
        return devices.find((d) => d.lastPoint);
      }, { timeout: 20000 });
      p.dev = dev.id;
    }
    facts.hDev = harsh.dev;
    facts.nDev = nishtha.dev;
    for (const p of people) p.obs = await new Observer(p).open();
    await waitFor('Nishtha on Harsh’s map', () => marker(harsh.page, nPeer()), { timeout: 20000 });
    await waitFor('Harsh on Nishtha’s map', () => marker(nishtha.page, hPeer()), { timeout: 20000 });
    const shots = [await harsh.shot(OUT, '00-setup'), await nishtha.shot(OUT, '00-setup')];
    return { harsh: harsh.id, nishtha: nishtha.id, devices: [facts.hDev, facts.nDev], tokenLifetimeS: LIFETIME_S, shots };
  }, { always: true });

  // ---------------------------------------------------------------- S1 / S2
  const longId = EDGE ? 'S2' : 'S1';
  await scenario(longId, `${Math.round(LONG_MS / 60000)} min tracking each other on ${LIFETIME_S} s tokens: no gap > 10 s, no 401, no sign-out; a crossing notifies both`, async () => {
    const t0 = Date.now();
    const pageT0 = await Promise.all(people.map((p) => p.page.evaluate(() => performance.now())));
    const tokens0 = await Promise.all(people.map((p) => p.token()));
    const sampler = sampleSession();
    const hWalk = walk(harsh, HARSH_A, HARSH_B, { steps: 40 });
    const nWalk = walk(nishtha, NISHTHA_A, NISHTHA_B, { steps: 20 });
    let midShots = [];
    while (Date.now() - t0 < LONG_MS) {
      await sleep(Math.min(30_000, LONG_MS - (Date.now() - t0)));
      if (!midShots.length && Date.now() - t0 >= LONG_MS / 2) {
        midShots = [await harsh.shot(OUT, `${longId}-midway`), await nishtha.shot(OUT, `${longId}-midway`)];
      }
    }
    await hWalk.stop();
    await nWalk.stop();
    check(!hWalk.errors.length && !nWalk.errors.length, `GPS updates failed: ${JSON.stringify({ harsh: hWalk.errors.slice(0, 3), nishtha: nWalk.errors.slice(0, 3) })}`);
    await sleep(1500);
    const t1 = Date.now();
    const [recH, recN] = await Promise.all(people.map((p) => p.record()));
    const pageT1 = await Promise.all(people.map((p) => p.page.evaluate(() => performance.now())));
    const nOnH = maxGap(recH, nPeer(), pageT0[0], pageT1[0] - 1500);
    const hOnN = maxGap(recN, hPeer(), pageT0[1], pageT1[1] - 1500);

    // ---- the finish: Nishtha walks into the Grocery; the note tells both.
    const tc = Date.now();
    await walkTo(nishtha, FENCES.Grocery);
    const notice = (p, re) => waitFor(`${p.name}'s Grocery notice`, async () => (await uc(p.page)).notices.find((t) => t.wall >= tc && re.test(t.label + t.text)), { timeout: ARRIVE_MS });
    const [th, tn] = await Promise.all([notice(harsh, /Grocery|buy milk/), notice(nishtha, /buy milk/)]);
    const crossShots = [await harsh.shot(OUT, `${longId}-crossing`), await nishtha.shot(OUT, `${longId}-crossing`)];
    await sleep(3000);
    const geo = harsh.obs.since(tc, (f) => f.type === 'geo' && f.data.placeId === facts.places.Grocery.id);
    const notify = people.map((p) => p.obs.since(tc, (f) => f.type === 'notify').length);
    const nH = (await uc(harsh.page)).notices.filter((t) => t.wall >= tc && /Grocery|buy milk/.test(t.label + t.text));
    const nN = (await uc(nishtha.page)).notices.filter((t) => t.wall >= tc && /buy milk/.test(t.label + t.text));
    // Back out, so the sleeps start outside every fence.
    await walkTo(nishtha, NISHTHA_A);
    await sampler.stop();

    const minutes = (t1 - t0) / 60000;
    const notSignedIn = sampler.samples.filter((s) => people.some((p) => s[p.name].signedIn === false));
    const notLive = sampler.samples.filter((s) => people.some((p) => s[p.name].status !== 'open'));
    const loginNavs = people.flatMap((p) => p.navigations.filter((n) => n.wall >= t0 && /\/login/.test(n.url)));
    const tokens1 = await Promise.all(people.map((p) => p.token()));
    const minRefreshes = Math.max(1, Math.floor((t1 - t0) / 1000 / (LIFETIME_S - Math.min(60, LIFETIME_S / 4))) - 1);
    const tokensOk = tokenChecks(t0, Date.now(), { minRefreshes });
    check(minutes >= LONG_MS / 60000 - 0.1, `ran ${minutes.toFixed(1)} min`);
    check(notSignedIn.length === 0 && loginNavs.length === 0, `signed out: ${JSON.stringify({ notSignedIn, loginNavs })}`);
    check(notLive.length === 0, `not live at ${notLive.length} samples: ${JSON.stringify(notLive.slice(0, 3))}`);
    check(tokens1.every((tk, i) => tk && tk !== tokens0[i]), 'an access token never changed');
    const expected = LONG_MS / STEP_MS / 2; // the gate sends one fix a step; allow for half
    check(nOnH.updates >= expected && nOnH.maxGapMs <= MAX_GAP_MS, `Nishtha on Harsh's map: ${JSON.stringify(nOnH)}`);
    check(hOnN.updates >= expected && hOnN.maxGapMs <= MAX_GAP_MS, `Harsh on Nishtha's map: ${JSON.stringify(hOnN)}`);
    check(geo.length === 1, `${geo.length} Grocery geo frames for one crossing`);
    check(nH.length === 1 && nN.length === 1, `notices: Harsh ${nH.length}, Nishtha ${nN.length}`);
    return {
      minutes: Math.round(minutes * 10) / 10, samples: sampler.samples.length,
      nishthaOnHarsh: nOnH, harshOnNishtha: hOnN, tokens: tokensOk,
      crossing: { geoFrames: geo.length, notifyFrames: notify, noticeMs: { harsh: th.wall - tc, nishtha: tn.wall - tc }, harsh: th.label, nishtha: tn.label },
      hostWifiDrops: Object.fromEntries(people.map((p) => [p.name, sampler.samples.at(-1)?.[p.name].hostDrops ?? null])),
      shots: [...midShots, ...crossShots],
    };
  });

  // ---------------------------------------------------------------- S3
  const laptop = new Laptop(harsh, harsh.log);
  let laptopReady = false;
  async function prepareLaptop() {
    if (laptopReady) return;
    await laptop.install();
    // The fake clock and the socket route take hold on a fresh page.
    await harsh.page.reload({ waitUntil: 'domcontentloaded' });
    await harsh.page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 30000 });
    await waitFor('Harsh live through the route', () => laptop.live(), { timeout: 20000 });
    await waitFor('Nishtha on Harsh’s map after the reload', () => marker(harsh.page, nPeer()), { timeout: 20000 });
    laptopReady = true;
  }

  /**
   * sleepCase sleeps Harsh's laptop while Nishtha walks into `fence`, wakes it
   * and checks that within WAKE_BUDGET_MS he holds a live token and a live
   * socket, and that the crossing he slept through shows exactly once.
   */
  async function sleepCase(id, fence, network) {
    await prepareLaptop();
    const exp = decodeJwt(await harsh.token())?.exp;
    if (!EDGE) {
      // Asleep across the expiry: down 75 s before it (before the renewal
      // timer, 60 s before), up well after it.
      const wait = exp * 1000 - 75_000 - Date.now();
      process.stdout.write(`  waiting ${Math.round(wait / 1000)} s so the sleep straddles the token's expiry\n`);
      if (wait > 0) await sleep(wait);
    }
    const expAtSleep = decodeJwt(await harsh.token())?.exp;
    const noticesBefore = (await uc(harsh.page)).notices.length;
    const panelBefore = (await panelEntries(harsh.page)).filter((l) => l.includes(fence)).length;
    let tCross;
    let asleepShot;
    const tAsleep = Date.now();
    const s = await laptop.sleep(SLEEP_MS, {
      network,
      during: async () => {
        await sleep(20_000);
        tCross = Date.now();
        await walkTo(nishtha, FENCES[fence]);
        // Inside, and the arrive has fired, well before he wakes.
        await sleep(Math.min(ARRIVE_MS, Math.max(5000, tAsleep + SLEEP_MS - 20_000 - Date.now())));
        asleepShot = await nishtha.shot(OUT, `${id}-nishtha-while-harsh-sleeps`);
        if (network === 'offline') await harsh.shot(OUT, `${id}-harsh-asleep-offline`).catch(() => null);
      },
    });
    const noticesAsleep = (await uc(harsh.page)).notices.slice(noticesBefore).filter((t) => t.wall < s.wokeAt && t.label.includes(fence));
    const tokenExpiredAtWake = expAtSleep * 1000 < s.wokeAt;
    const hello = await laptop.helloAfter(s.wokeAt, 15_000).catch(() => null);
    const renewal = await waitFor('a renewed token', () => harsh.log.refreshes(s.wokeAt).find((r) => r.status === 200), { timeout: 15_000, every: 50 }).catch(() => null);
    await waitFor('Harsh live again', async () => (await liveStatus(harsh.page)) === 'open', { timeout: 15_000 }).catch(() => null);
    const notice = await waitFor(`the ${fence} notice`, async () => (await uc(harsh.page)).notices.slice(noticesBefore).find((t) => t.label.includes(fence)), { timeout: 15_000 }).catch(() => null);
    const wakeShot = await harsh.shot(OUT, `${id}-harsh-awake`);
    await sleep(4000);
    const notices = (await uc(harsh.page)).notices.slice(noticesBefore).filter((t) => t.label.includes(fence));
    const panel = (await panelEntries(harsh.page)).filter((l) => l.includes(fence)).length - panelBefore;
    const geo = nishtha.obs.since(tCross, (f) => f.type === 'geo' && f.data.placeId === facts.places[fence].id).length
      + harsh.obs.since(tCross, (f) => f.type === 'geo' && f.data.placeId === facts.places[fence].id).length;
    const newConn = hello?.conn;
    const handshakeExp = newConn ? decodeJwt(new URL(newConn.url).searchParams.get('access_token'))?.exp : null;
    const replayed = newConn ? newConn.frames.filter((f) => f.type === 'geo' && f.data?.placeId === facts.places[fence].id).length : 0;
    const expired = harsh.log.expiredUses(s.wokeAt);
    const unauthorized = harsh.log.unauthorized.filter((u) => u.wall >= s.wokeAt);
    const ev = {
      network, sleptS: Math.round(s.sleptMs / 1000), tokenExpiredAtWake,
      tokenExpiredForS: Math.round((s.wokeAt - expAtSleep * 1000) / 1000),
      renewedAfterWakeMs: renewal ? renewal.wall - s.wokeAt : null,
      liveSocketAfterWakeMs: hello ? hello.at - s.wokeAt : null,
      handshakeTokenFresh: handshakeExp ? handshakeExp * 1000 > (hello?.at ?? 0) : null,
      since: newConn ? new URL(newConn.url).searchParams.get('since') : null,
      replayedGeoFrames: replayed, noticesWhileAsleep: noticesAsleep.length, notices: notices.length,
      noticeAfterWakeMs: notice ? notice.wall - s.wokeAt : null, panelEntries: panel, geoFramesToObservers: geo,
      expiredUses: expired.length, unauthorized: unauthorized.length,
      shots: [asleepShot, wakeShot],
    };
    process.stdout.write(`  ${JSON.stringify(ev)}\n`);
    check(!tokenExpiredAtWake || (renewal && renewal.wall - s.wokeAt <= WAKE_BUDGET_MS), `token not renewed within ${WAKE_BUDGET_MS} ms of waking: ${JSON.stringify(ev)}`);
    check(hello && hello.at - s.wokeAt <= WAKE_BUDGET_MS, `no live socket within ${WAKE_BUDGET_MS} ms of waking: ${JSON.stringify(ev)}`);
    check(ev.handshakeTokenFresh, `the new socket's token had expired: ${JSON.stringify(ev)}`);
    check(noticesAsleep.length === 0, `the crossing reached a sleeping laptop: ${JSON.stringify(ev)}`);
    check(notices.length === 1 && panel === 1, `the missed crossing showed ${notices.length}× (panel ${panel}): ${JSON.stringify(ev)}`);
    check(expired.length === 0 && unauthorized.length === 0, `expired tokens or 401s after waking: ${JSON.stringify({ expired, unauthorized })}`);
    await walkTo(nishtha, NISHTHA_A);
    return ev;
  }

  if (EDGE) {
    await scenario('S3a', `Laptop sleep, network gone: ${Math.round(SLEEP_MS / 1000)} s with timers frozen; renewed and live within 5 s, the missed crossing once`, () => sleepCase('S3a', 'Bakery', 'offline'));
    await scenario('S3b', `Laptop sleep, no network event (the socket dies silently): ${Math.round(SLEEP_MS / 1000)} s; renewed and live within 5 s, the missed crossing once`, () => sleepCase('S3b', 'Cafe', 'silent'));
  } else {
    await scenario('S3', `Laptop sleep across the 15 min token's expiry, no network event: ${Math.round(SLEEP_MS / 1000)} s; renewed and live within 5 s, the missed crossing once`, () => sleepCase('S3', 'Cafe', 'silent'));
  }

  // ---------------------------------------------------------------- errors
  await scenario('E', 'No page errors, console errors, 5xx or unexpected 4xx in either browser', async () => {
    const report = {};
    for (const p of people) {
      const bad = p.badResponses.filter((r) => !/:8085\//.test(r.url) && !/favicon/.test(r.url));
      // Requests the sleep's offline network refused are the network, not the app.
      const errors = p.errors.filter((e) => !/net::ERR_INTERNET_DISCONNECTED|Failed to load resource: net::ERR_/.test(e.text));
      report[p.name] = { errors, bad };
    }
    const problems = people.flatMap((p) => [...report[p.name].errors, ...report[p.name].bad]);
    check(problems.length === 0, `problems: ${JSON.stringify(report, null, 1)}`);
    return report;
  }, { always: true });
} catch {
  // A setup step failed and has been recorded; nothing after it can run.
} finally {
  for (const w of [...walkers]) await w.stop().catch(() => {});
  for (const o of observers) o.close();
  const tokens = {};
  for (const p of people) {
    if (!p.log) continue;
    tokens[p.name] = {
      timeline: p.log.timeline(facts.t0),
      bearers: p.log.bearers.length, handshakes: p.log.sockets,
      expiredUses: p.log.expiredUses(), unauthorized: p.log.unauthorized, tokenFailures: p.log.tokenFailures,
    };
  }
  writeFileSync(`${OUT}/tokens.json`, JSON.stringify({ phase: PHASE, t0: new Date(facts.t0).toISOString(), tokens }, null, 2));
  const ran = results.filter((r) => !r.skipped);
  const summary = { base: BASE, phase: PHASE, at: new Date().toISOString(), pass: ran.every((r) => r.pass), partial: ONLY.length > 0, results, lifecycle };
  writeFileSync(`${OUT}/results.json`, JSON.stringify(summary, null, 2));
  process.stdout.write(`\n${summary.pass ? 'ALL SESSION SCENARIOS PASSED' : 'FAILED'} (${PHASE}) — ${OUT}/results.json, ${OUT}/tokens.json\n`);
  for (const r of ran) process.stdout.write(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.title}\n`);
  closing = true;
  for (const p of people) await p.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(summary.pass ? 0 : 1);
}
