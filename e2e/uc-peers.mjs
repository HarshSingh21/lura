// Peer use cases, end to end, in two browsers: fences that watch the other
// person, mutual watches at once, and a note written for someone else.
//
//   UC5  Nishtha draws "Gym" on her map watching Harsh; his phone passes
//        through. She is told (toast/card, watch chime, History); he hears
//        nothing about being watched and his History has no trace of her fence.
//   UC6  At the same moment Harsh draws "Bakery" watching Nishtha and she draws
//        "Library" watching him; both walk through the other's fence together.
//        Each gets exactly one correct alert, no cross-talk, no duplicates, and
//        each map keeps showing the other moving smoothly.
//   UC7  Harsh writes "pick up keys" at "Gym2" for Nishtha's movement, telling
//        only her. She passes: she gets the sticky card "pick up keys · from
//        Harsh"; he gets nothing. She acknowledges: he is told, the note is
//        done, and both Histories say so.
//
// Throughout UC5–UC7 both browsers are compared at one instant: each person's
// phone as its owner sees it and as the other person sees it must match the
// server to 1e-6° and read the same freshness.
//
// Run: E2E_SUITE=uc-peers E2E_STORE=postgres E2E_PORT=8093 e2e/run.sh
// Environment is run.sh's (E2E_BASE, E2E_API, E2E_OUT), plus:
//   E2E_UC=5,7    just those use cases (setup always runs)
//   E2E_HEADED=1  watch it happen

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, Person, sleep, waitFor } from './lib/browser.mjs';
import { haversineM, pointInPolygon } from './lib/geo.mjs';
import {
  MIN_JUDGE_FPS, Observer, ageMatches, ageSeconds, bearing, centreOn, drawPolygonFence, glideOf, historyRows, near, offset, pub,
  readMarker, rowAt, sampleOnMap, speedLabel,
} from './lib/live.mjs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:8093';
const API = process.env.E2E_API ?? BASE;
process.env.E2E_API = API;
const OUT = process.env.E2E_OUT ?? '/tmp/lura-uc-peers';
const SHOTS = `${OUT}/shots`;
const ONLY = (process.env.E2E_UC ?? '').split(',').map((s) => s.trim()).filter(Boolean);
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ geography
// Indiranagar, Bengaluru. Each fence has its own block, far enough from every
// route that only the walk meant for it can reach it.
const HARSH_HOME = { lat: 12.9786, lon: 77.6398 };
const NISHTHA_HOME = { lat: 12.9702, lon: 77.6378 };
const GYM = { lat: 12.965, lon: 77.63 }; //       Nishtha's, watches Harsh (UC5)
const LIBRARY = { lat: 12.972, lon: 77.63 }; //   Nishtha's, watches Harsh (UC6)
const BAKERY = { lat: 12.965, lon: 77.646 }; //   Harsh's, watches Nishtha (UC6)
const GYM2 = { lat: 12.979, lon: 77.63 }; //      Harsh's, watches nobody; the note does (UC7)
const HALF_M = 50; // fences are 100 m squares
const SPEED = 8; // m/s, a bicycle: well over pass-by speed (3 m/s)

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADED !== '1',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const harsh = new Person({ name: 'Harsh', email: 'harsh@lura.local', password: 'lura-harsh', start: HARSH_HOME });
const nishtha = new Person({ name: 'Nishtha', email: 'nishtha@lura.local', password: 'lura-nishtha', start: NISHTHA_HOME });
const people = [harsh, nishtha];
const other = (p) => (p === harsh ? nishtha : harsh);

const results = [];
const facts = {};
const instants = []; // every same-instant comparison, for the report

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

async function useCase(id, title, fn) {
  if (ONLY.length && id !== '0' && !ONLY.includes(id)) {
    results.push({ id, title, skipped: true });
    process.stdout.write(`\n[UC${id}] ${title}\n  SKIPPED\n`);
    return;
  }
  const started = Date.now();
  process.stdout.write(`\n[UC${id}] ${title}\n`);
  if (id !== '0') {
    for (const p of people) await tidy(p).catch(() => {});
    // A case that failed before acknowledging leaves its cards; the next case
    // counts cards, so clear them as their owner would.
    for (const p of people) {
      for (const r of await pending(p).catch(() => [])) await p.api('POST', `/api/v1/reminders/${r.id}/ack`, {}).catch(() => {});
    }
  }
  try {
    const evidence = await fn();
    results.push({ id, title, pass: true, ms: Date.now() - started, evidence });
    process.stdout.write(`  PASS ${JSON.stringify(evidence)}\n`);
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - started, error: String(err?.stack ?? err) });
    process.stdout.write(`  FAIL ${err?.stack ?? err}\n`);
    for (const p of people) await p.shot(SHOTS, `fail-uc${id}`).catch(() => {});
    if (id === '0') throw err;
  }
}

async function tidy(p) {
  const page = p.page;
  for (const name of ['Cancel', 'Close']) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible())) await b.first().click({ timeout: 2000 }).catch(() => {});
  }
  await page.keyboard.press('Escape');
  await p.nav('Live map');
  await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 15000 });
}

// ------------------------------------------------------------------ phones
/** line is a walk of `n` fixes along a straight line, one per period. */
function line(from, to, n) {
  return Array.from({ length: n }, (_, i) => ({ lat: from.lat + ((to.lat - from.lat) * i) / (n - 1), lon: from.lon + ((to.lon - from.lon) * i) / (n - 1) }));
}

/** across is a west→east walk through a fence's middle, from 130 m before it to 130 m past it. */
function across(c) {
  const from = offset(c, -130, 0);
  const to = offset(c, 130, 0);
  return line(from, to, Math.round(260 / SPEED) + 1);
}

/**
 * park puts phones at their walks' starts, long enough before that no straight
 * "crossing" is inferred, and frames both maps on the whole neighbourhood: a
 * marker more than a little off screen is not drawn at all (Overlays.tsx), and
 * each browser must draw both phones for the whole walk.
 */
async function park(...legs) {
  await Promise.all(legs.map(([dev, point]) => pub(API, dev, point, { speedMps: 0 })));
  await frameAll();
  await sleep(1500);
}

/** The middle of every fence and walk; at zoom 14 a 1440×900 map shows ~4 km of it. */
const NEIGHBOURHOOD = { lat: 12.972, lon: 77.638 };
async function frameAll() {
  await Promise.all(people.map((p) => centreOn(p, NEIGHBOURHOOD, 14)));
}

/**
 * drive moves the phones together, one fix each per second (each leg's own
 * path; a phone on a table repeats its point at speed 0). Every
 * `sampleEvery`-th tick, after the fixes have landed, both browsers and the
 * server are read at one instant (sameInstant). `glideAt` starts per-frame
 * marker sampling in both browsers at those ticks.
 */
async function drive(legs, { periodMs = 1000, sampleEvery = 4, glideAt = [], glideMarkers = [] } = {}) {
  const n = Math.max(...legs.map((l) => l.path.length));
  const posts = legs.map(() => []);
  const comparisons = [];
  const glides = [];
  for (let i = 0; i < n; i += 1) {
    const tickStart = Date.now();
    const tst = Math.floor(tickStart / 1000);
    await Promise.all(legs.map(async (leg, k) => {
      const p = leg.path[Math.min(i, leg.path.length - 1)];
      const nextP = leg.path[Math.min(i + 1, leg.path.length - 1)];
      const moving = i < leg.path.length - 1;
      const r = await pub(API, leg.dev, p, { speedMps: moving ? SPEED : 0, cog: moving ? bearing(p, nextP) : undefined, tst });
      posts[k].push(r);
    }));
    if (glideAt.includes(i)) {
      for (const g of glideMarkers) {
        glides.push(sampleOnMap(g.person.page, g.marker, 2600).then((s) => ({ ...s, who: g.person.name, marker: g.marker })));
      }
    }
    if (i % sampleEvery === sampleEvery - 1 || i === n - 1) {
      await sleep(500);
      comparisons.push(await sameInstant(legs.map((l, k) => ({ dev: l.dev, posted: posts[k].at(-1).body }))));
    }
    const rest = periodMs - (Date.now() - tickStart);
    if (rest > 0) await sleep(rest);
  }
  return { posts, comparisons, glides: await Promise.all(glides) };
}

// ------------------------------------------------------------------ one instant
/**
 * sameInstant reads, in parallel, each phone as its owner's browser draws it
 * (own marker, own rail row), as the other browser draws it (peer marker, peer
 * row) and as the server stores it, and compares them: the same coordinate to
 * 1e-6°, the same speed, and the same freshness, which must also be the true
 * age of the fix (from the fixTs the socket carried).
 */
async function sameInstant(fixes) {
  const out = { at: new Date().toISOString(), phones: [], problems: [] };
  const reads = await Promise.all(fixes.map(async ({ dev, posted }) => {
    const owner = dev.owner;
    const viewer = other(owner);
    const [ownMarker, ownRow, peerMarker, peerRow, server] = await Promise.all([
      readMarker(owner.page, dev.id), rowAt(owner.page, `device-${dev.id}`),
      readMarker(viewer.page, `peer_${dev.id}`), rowAt(viewer.page, `peer-${owner.id}`),
      owner.api('GET', '/api/v1/devices').then((r) => r.devices.find((d) => d.id === dev.id)),
    ]);
    return { dev, posted, ownMarker, ownRow, peerMarker, peerRow, server };
  }));
  for (const r of reads) {
    const name = r.dev.owner.name;
    const fail = (m) => out.problems.push(`${name}'s phone: ${m}`);
    if (!near(r.server?.lastPoint, r.posted)) fail(`server has ${JSON.stringify(r.server?.lastPoint)}, posted ${JSON.stringify(r.posted)}`);
    if (!near(r.ownMarker, r.posted)) fail(`${name} sees it at ${JSON.stringify(r.ownMarker && { lat: r.ownMarker.lat, lon: r.ownMarker.lon })}`);
    if (!near(r.peerMarker, r.posted)) fail(`${other(r.dev.owner).name} sees it at ${JSON.stringify(r.peerMarker && { lat: r.peerMarker.lat, lon: r.peerMarker.lon })}`);
    if (speedLabel(r.ownMarker?.label) !== speedLabel(r.peerMarker?.label)) fail(`speed differs: "${r.ownMarker?.label}" vs "${r.peerMarker?.label}"`);
    if (r.ownMarker?.heading !== r.peerMarker?.heading) fail(`heading differs: ${r.ownMarker?.heading} vs ${r.peerMarker?.heading}`);
    if (r.ownMarker?.stale || r.peerMarker?.stale) fail('drawn as stale while it is live');
    // When the fix was taken, by the frame the server pushed for it.
    const frame = r.dev.owner.obs.frames.filter((f) => f.type === 'position' && f.data?.deviceId === r.dev.id).at(-1);
    const takenAt = frame?.data.fixTs && near(frame.data.point, r.posted) ? Date.parse(frame.data.fixTs) : Date.parse(r.server?.lastSeen);
    for (const [who, row] of [[name, r.ownRow], [other(r.dev.owner).name, r.peerRow]]) {
      const trueAge = (row.at - takenAt) / 1000;
      if (!ageMatches(row.text, trueAge)) fail(`${who}'s row says "${row.text}", the fix is ${trueAge.toFixed(1)} s old`);
    }
    const skew = Math.abs(ageSeconds(r.ownRow.text) - ageSeconds(r.peerRow.text) - (r.ownRow.at - r.peerRow.at) / 1000);
    if (!(skew <= 1.5 || /just now/.test(r.ownRow.text + r.peerRow.text))) fail(`freshness differs: "${r.ownRow.text}" vs "${r.peerRow.text}"`);
    out.phones.push({
      phone: name, posted: r.posted, server: r.server?.lastPoint,
      owner: { lat: r.ownMarker?.lat, lon: r.ownMarker?.lon, label: r.ownMarker?.label, row: r.ownRow.text },
      viewer: { lat: r.peerMarker?.lat, lon: r.peerMarker?.lon, label: r.peerMarker?.label, row: r.peerRow.text },
    });
  }
  instants.push(out);
  return out;
}

function instantsOk(comparisons) {
  const bad = comparisons.filter((c) => c.problems.length);
  check(comparisons.length >= 3, `only ${comparisons.length} same-instant comparisons`);
  check(bad.length === 0, `the browsers disagreed: ${JSON.stringify(bad.slice(0, 3))}`);
  return { comparisons: comparisons.length, last: comparisons.at(-1).phones };
}

// ------------------------------------------------------------------ what each saw
async function mark() {
  const [h, n] = await Promise.all(people.map((p) => p.page.evaluate(() => performance.now())));
  return { h, n, wall: Date.now() };
}
const pageT = (p, t) => (p === harsh ? t.h : t.n);

/** groupChimes groups recorded oscillator notes into chimes, with their frequencies. */
function groupChimes(notes) {
  const out = [];
  for (const n of notes) {
    const last = out.at(-1);
    if (last && n.t - last.end < 40) {
      last.end = n.t;
      last.freqs.push(n.freq);
    } else out.push({ t: n.t, end: n.t, freqs: [n.freq] });
  }
  const KIND = { 1046.5: 'arrive', 784: 'leave', 1318.5: 'passby', 880: 'dwell' };
  return out.map((c) => ({ t: c.t, kind: KIND[c.freqs[0]] ?? `?${c.freqs[0]}`, watched: c.freqs.includes(2650) }));
}

/**
 * seen is what one browser showed after a mark, about the given places (by id
 * and name): live frames, toasts and cards (one per notice id; History rows and
 * the panel are not toasts), chimes, plus what the server pushed to the
 * person's own observer socket.
 */
async function seen(p, t, places) {
  const ids = new Set(places.map((x) => x.id));
  const names = places.map((x) => x.name);
  const rec = await p.record();
  const t0 = pageT(p, t);
  const after = (list) => list.filter((x) => x.t >= t0);
  const about = (txt) => names.some((n) => new RegExp(`\\b${n}\\b`).test(txt ?? ''));
  const frames = after(rec.frames).filter((f) => f.data && (ids.has(f.data.placeId) || ids.has(f.data.event?.placeId)));
  const earlier = new Set(rec.toasts.filter((x) => x.t < t0 && x.notice).map((x) => x.notice));
  const notices = new Set();
  const toasts = after(rec.toasts)
    .filter((x) => !/^\d\d:\d\d /.test(x.label) && (about(x.label) || about(x.text)))
    .filter((x) => !x.notice || (earlier.has(x.notice) || notices.has(x.notice) ? false : (notices.add(x.notice), true)))
    .map((x) => x.label.replace(/\. Show on the map\.$/, ''));
  const wire = p.obs.since(t.wall, (f) => f.data && (ids.has(f.data.placeId) || ids.has(f.data.event?.placeId)));
  return {
    geo: frames.filter((f) => f.type === 'geo').map((f) => `${f.data.trigger}@${f.data.placeName}:${f.data.subjectName}`),
    notify: frames.filter((f) => f.type === 'notify').map((f) => ({ kind: f.data.kind, title: f.data.title, body: f.data.body, fromName: f.data.fromName, id: f.data.id })),
    toasts,
    chimes: groupChimes(after(rec.notes)),
    wire: wire.map((f) => f.type),
  };
}

/** pending is the person's pending reminders, by the API. */
async function pending(p) {
  return (await p.api('GET', '/api/v1/reminders?status=pending')).reminders;
}

/** cardsText is the text of every sticky reminder card on screen (unfolding the stack first). */
async function cardsText(p) {
  const more = p.page.getByRole('button', { name: /^Show \d+ more pending reminders$/ });
  if (await more.count()) {
    await more.first().click().catch(() => {});
    await sleep(400);
  }
  const texts = await p.page.evaluate(() =>
    [...document.querySelectorAll('[aria-label$="Waiting for acknowledgement."]')].map((e) => e.innerText.replace(/\s+/g, ' ')),
  );
  const fold = p.page.getByRole('button', { name: 'Fold pending reminders' });
  if (await fold.count()) await fold.first().click().catch(() => {});
  return texts;
}

/** ackAll presses Acknowledge on every card a person has, so the next case starts clean. */
async function ackAll(p) {
  for (let i = 0; i < 6; i += 1) {
    const b = p.page.getByRole('button', { name: /^Acknowledge / });
    if (!(await b.count())) break;
    await b.first().click();
    await sleep(600);
  }
  await waitFor(`${p.name}'s cards to clear`, async () => (await pending(p)).length === 0, { timeout: 8000 });
}

async function activity(p) {
  const from = new Date(Date.now() - 6 * 3600_000).toISOString();
  return (await p.api('GET', `/api/v1/activity?from=${encodeURIComponent(from)}&limit=500`)).items;
}

/** fenceIs: the place as the server stores it is the ring drawn, watching exactly `watch`. */
function fenceIs(place, ring, centre, watch) {
  check(place.shape === 'polygon' && place.polygon.length === 4, `${place.name}: ${JSON.stringify(place)}`);
  check(pointInPolygon(centre, place.polygon), `${place.name}'s centre is outside it`);
  // A tap lands on a whole pixel (~1.2 m at zoom 16).
  const err = Math.max(...place.polygon.map((v, i) => haversineM(v, ring[i])));
  check(err < 2, `${place.name}'s corners are up to ${err.toFixed(1)} m from where they were tapped`);
  check(JSON.stringify(place.watchUserIds) === JSON.stringify(watch), `${place.name} watches ${place.watchUserIds}, want ${watch}`);
  check(JSON.stringify(place.triggers) === JSON.stringify(['passby']), `${place.name} triggers ${place.triggers}`);
}

/** glidesOk judges the per-frame samples that had enough frames to judge. */
function glidesOk(glides, recs) {
  const judged = [];
  for (const g of glides) {
    const rec = recs[g.who];
    const dev = g.marker.replace(/^peer_/, '');
    const t0 = g.track[0]?.t ?? 0;
    const t1 = g.track.at(-1)?.t ?? 0;
    const fixes = rec.frames.filter((f) => f.type === 'position' && f.deviceId === dev && f.t >= t0 && f.t <= t1).length;
    const verdict = { who: g.who, fps: Math.round(g.fps), cameraMoves: g.cameraMoves, ...glideOf(g.track, fixes) };
    judged.push(verdict);
  }
  for (const who of [...new Set(judged.map((j) => j.who))]) {
    const mine = judged.filter((j) => j.who === who && j.fps >= MIN_JUDGE_FPS);
    check(mine.length > 0, `${who}'s page rendered too few frames to judge a glide: ${JSON.stringify(judged.filter((j) => j.who === who))}`);
    for (const j of mine) {
      check(j.fixesDuring >= 2 && j.movingMs >= j.fixesDuring * 10 * (1000 / 60) && j.jumps.length === 0, `${who}'s view of the other jumped: ${JSON.stringify(j)}`);
    }
  }
  return judged;
}

/** everyFixDrawn: each position frame for the other's phone moved its marker to exactly that point. */
function everyFixDrawn(rec, dev, t0) {
  const frames = rec.frames.filter((f) => f.t >= t0 && f.type === 'position' && f.deviceId === dev);
  const marks = rec.markers.filter((m) => m.id === `peer_${dev}` && m.t >= t0);
  const lag = [];
  for (const f of frames) {
    const m = marks.find((x) => x.t >= f.t && Math.abs(x.lat - f.lat) < 1e-9 && Math.abs(x.lon - f.lon) < 1e-9);
    if (m) lag.push(m.t - f.t);
  }
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t);
  return { frames: frames.length, drawn: lag.length, renderMs: stats(lag), frameGapMs: stats(gaps) };
}

// ======================================================================
try {
  await useCase('0', 'Setup: both sign in, connect both ways, each gets a phone sharing live', async () => {
    await Promise.all(people.map((p) => p.open(browser, BASE)));
    // A pending reminder rings again every minute (release spec §6); this suite
    // counts the chime each crossing makes, so the repeats are pushed out.
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
    for (const [p, home] of [[harsh, HARSH_HOME], [nishtha, NISHTHA_HOME]]) {
      const created = await p.api('POST', '/api/v1/devices', { name: `${p.name}’s phone`, kind: 'phone' });
      p.dev = { id: created.device.id, token: created.pubToken, owner: p };
      await pub(API, p.dev, home);
    }
    for (const p of people) p.obs = await new Observer(p, API).open();
    await frameAll();
    for (const p of people) {
      await waitFor(`${p.name}'s map to show both phones`, async () => {
        const [mine, theirs] = await Promise.all([readMarker(p.page, p.dev.id), readMarker(p.page, `peer_${other(p).dev.id}`)]);
        if (mine && theirs) return true;
        await pub(API, other(p).dev, other(p) === harsh ? HARSH_HOME : NISHTHA_HOME);
        return false;
      }, { timeout: 30000, every: 2000 });
    }
    // A gesture so Web Audio may start, as a person's first click would.
    for (const p of people) await p.page.mouse.click(5, 450);
    const shots = [await harsh.shot(SHOTS, '0-connected'), await nishtha.shot(SHOTS, '0-connected')];
    return { harsh: harsh.id, nishtha: nishtha.id, phones: { harsh: harsh.dev.id, nishtha: nishtha.dev.id }, shots };
  });

  // ---------------------------------------------------------------- UC5
  await useCase('5', 'Nishtha watches Harsh at Gym; he passes; only she is told', async () => {
    const { place: gym, ring, formShot } = await drawPolygonFence(nishtha, {
      name: 'Gym', center: GYM, halfM: HALF_M, triggers: ['Pass by'], watch: ['Harsh'], shotDir: SHOTS,
    });
    fenceIs(gym, ring, GYM, [harsh.id]);
    facts.gym = gym;
    check(!(await harsh.api('GET', '/api/v1/places')).places.some((p) => p.id === gym.id), 'Harsh can list Nishtha’s Gym');
    const drawnShot = await nishtha.shot(SHOTS, 'uc5-gym-drawn');

    const path = across(GYM);
    await park([harsh.dev, path[0]], [nishtha.dev, NISHTHA_HOME]);
    const t = await mark();
    const run = await drive([
      { dev: harsh.dev, path },
      { dev: nishtha.dev, path: Array(path.length).fill(NISHTHA_HOME) },
    ], { glideAt: [8, 14], glideMarkers: [{ person: nishtha, marker: `peer_${harsh.dev.id}` }] });
    const inside = path.filter((p) => pointInPolygon(p, gym.polygon)).length;
    check(inside >= 5, `the walk had only ${inside} fixes inside Gym`);

    // ---- Nishtha: one watch alert, with its chime
    const alertAt = await waitFor('Nishtha’s watch alert', async () => {
      const s = await seen(nishtha, t, [gym]);
      return s.notify.length ? s : null;
    }, { timeout: 8000 });
    await sleep(2500);
    const n = await seen(nishtha, t, [gym]);
    const h = await seen(harsh, t, [gym]);
    check(n.geo.length === 1 && /^passby@Gym:Harsh/.test(n.geo[0]), `Nishtha's geo frames: ${n.geo}`);
    check(n.notify.length === 1 && n.notify[0].kind === 'watch' && /^Harsh( Singh)? passed( by)? Gym$/.test(n.notify[0].title), `Nishtha's reminders: ${JSON.stringify(n.notify)}`);
    check(n.toasts.length === 1 && /^Harsh( Singh)? passed( by)? Gym$/.test(n.toasts[0]), `Nishtha's toasts: ${JSON.stringify(n.toasts)}`);
    check(n.chimes.length === 1 && n.chimes[0].kind === 'passby' && n.chimes[0].watched, `Nishtha's chimes: ${JSON.stringify(n.chimes)}`);
    check(n.wire.filter((x) => x === 'notify').length === 1, `the server pushed Nishtha ${JSON.stringify(n.wire)}`);
    const nCards = await cardsText(nishtha);
    check(nCards.some((c) => /Harsh( Singh)? passed( by)? Gym\b/.test(c)), `Nishtha's cards: ${JSON.stringify(nCards)}`);
    const alertShot = await nishtha.shot(SHOTS, 'uc5-nishtha-alert');

    // ---- Harsh: nothing about being watched
    check(h.geo.length === 0 && h.notify.length === 0 && h.wire.length === 0, `Harsh was told about Gym: ${JSON.stringify(h)}`);
    check(h.toasts.length === 0, `Harsh's toasts: ${JSON.stringify(h.toasts)}`);
    check(h.chimes.length === 0, `Harsh heard chimes: ${JSON.stringify(h.chimes)}`);
    check((await pending(harsh)).length === 0, 'Harsh has a pending reminder');
    const hBody = await harsh.page.innerText('body');
    check(!/\bGym\b/.test(hBody), 'Harsh’s screen names Gym');
    const harshShot = await harsh.shot(SHOTS, 'uc5-harsh-nothing');

    const recs = { Harsh: await harsh.record(), Nishtha: await nishtha.record() };
    const drawn = everyFixDrawn(recs.Nishtha, harsh.dev.id, t.n);
    check(drawn.frames >= path.length - 1 && drawn.drawn >= drawn.frames - 1, `Nishtha's map did not draw every fix of Harsh's: ${JSON.stringify(drawn)}`);
    const glides = glidesOk(run.glides, recs);
    const same = instantsOk(run.comparisons);

    // ---- History
    const nFeed = await activity(nishtha);
    const hFeed = await activity(harsh);
    check(nFeed.some((i) => i.type === 'geo' && i.placeId === gym.id && i.subjectUserId === harsh.id && i.trigger === 'passby'), 'Nishtha’s activity lacks the crossing');
    check(nFeed.some((i) => i.type === 'reminder' && i.reminder.placeId === gym.id && i.reminder.kind === 'watch'), 'Nishtha’s activity lacks the watch reminder');
    const leak = hFeed.filter((i) => i.placeId === gym.id || i.reminder?.placeId === gym.id || /\bGym\b/.test(JSON.stringify(i)));
    check(leak.length === 0, `Harsh's activity shows Nishtha's fence: ${JSON.stringify(leak)}`);
    await ackAll(nishtha);
    const nRows = await historyRows(nishtha, (rows) => rows.some((r) => /Harsh( Singh)? passed Gym\b/.test(r)));
    check(nRows.some((r) => /Harsh( Singh)? passed Gym\b/.test(r)), `Nishtha's History: ${JSON.stringify(nRows)}`);
    const nHistShot = await nishtha.shot(SHOTS, 'uc5-nishtha-history');
    const hRows = await historyRows(harsh);
    check(!hRows.some((r) => /\bGym\b/.test(r)), `Harsh's History shows Gym: ${JSON.stringify(hRows)}`);
    const hHistShot = await harsh.shot(SHOTS, 'uc5-harsh-history');
    for (const p of people) await p.nav('Live map');
    return {
      fixes: path.length, inside, nishtha: { geo: n.geo, notify: n.notify.map((x) => `${x.kind}:${x.title}`), toasts: n.toasts, chimes: n.chimes.map((c) => `${c.kind}${c.watched ? '+watch' : ''}`), cards: nCards },
      harsh: { frames: h.wire.length, toasts: h.toasts.length, chimes: h.chimes.length },
      alertAfterWalkStartMs: alertAt ? 'seen' : null, nishthaDrewHarsh: drawn, glides, same,
      history: { nishtha: nRows.filter((r) => /Gym/.test(r)), harshRows: hRows.length },
      shots: [formShot, drawnShot, alertShot, harshShot, nHistShot, hHistShot],
    };
  });

  // ---------------------------------------------------------------- UC6
  await useCase('6', 'Mutual: Bakery and Library drawn at once; both walk through the other’s fence together', async () => {
    const [bakery, library] = await Promise.all([
      drawPolygonFence(harsh, { name: 'Bakery', center: BAKERY, halfM: HALF_M, triggers: ['Pass by'], watch: ['Nishtha'], shotDir: SHOTS }),
      drawPolygonFence(nishtha, { name: 'Library', center: LIBRARY, halfM: HALF_M, triggers: ['Pass by'], watch: ['Harsh'], shotDir: SHOTS }),
    ]);
    fenceIs(bakery.place, bakery.ring, BAKERY, [nishtha.id]);
    fenceIs(library.place, library.ring, LIBRARY, [harsh.id]);
    const B = bakery.place;
    const L = library.place;
    facts.bakery = B;
    const hPath = across(LIBRARY);
    const nPath = across(BAKERY);
    await park([harsh.dev, hPath[0]], [nishtha.dev, nPath[0]]);
    const t = await mark();
    const run = await drive([{ dev: harsh.dev, path: hPath }, { dev: nishtha.dev, path: nPath }], {
      glideAt: [6, 12, 20],
      glideMarkers: [{ person: harsh, marker: `peer_${nishtha.dev.id}` }, { person: nishtha, marker: `peer_${harsh.dev.id}` }],
    });
    await sleep(3000);
    const h = await seen(harsh, t, [B, L]);
    const n = await seen(nishtha, t, [B, L]);
    // Harsh: exactly "Nishtha passed by Bakery"; nothing about Library.
    check(h.geo.length === 1 && /^passby@Bakery:Nishtha/.test(h.geo[0]), `Harsh's geo frames: ${h.geo}`);
    check(h.notify.length === 1 && h.notify[0].kind === 'watch' && /^Nishtha( Dev)? passed( by)? Bakery$/.test(h.notify[0].title), `Harsh's reminders: ${JSON.stringify(h.notify)}`);
    check(h.toasts.length === 1 && /^Nishtha( Dev)? passed( by)? Bakery$/.test(h.toasts[0]), `Harsh's toasts: ${JSON.stringify(h.toasts)}`);
    check(h.chimes.length === 1 && h.chimes[0].kind === 'passby' && h.chimes[0].watched, `Harsh's chimes: ${JSON.stringify(h.chimes)}`);
    // Nishtha: exactly "Harsh passed by Library"; nothing about Bakery.
    check(n.geo.length === 1 && /^passby@Library:Harsh/.test(n.geo[0]), `Nishtha's geo frames: ${n.geo}`);
    check(n.notify.length === 1 && n.notify[0].kind === 'watch' && /^Harsh( Singh)? passed( by)? Library$/.test(n.notify[0].title), `Nishtha's reminders: ${JSON.stringify(n.notify)}`);
    check(n.toasts.length === 1 && /^Harsh( Singh)? passed( by)? Library$/.test(n.toasts[0]), `Nishtha's toasts: ${JSON.stringify(n.toasts)}`);
    check(n.chimes.length === 1 && n.chimes[0].kind === 'passby' && n.chimes[0].watched, `Nishtha's chimes: ${JSON.stringify(n.chimes)}`);
    check(h.wire.filter((x) => x === 'notify').length === 1 && n.wire.filter((x) => x === 'notify').length === 1, `wire: ${JSON.stringify({ h: h.wire, n: n.wire })}`);
    const [hp, np] = [await pending(harsh), await pending(nishtha)];
    check(hp.length === 1 && hp[0].placeId === B.id && np.length === 1 && np[0].placeId === L.id, `pending: ${JSON.stringify({ hp, np })}`);
    const shots = [await harsh.shot(SHOTS, 'uc6-harsh-alert'), await nishtha.shot(SHOTS, 'uc6-nishtha-alert')];

    const recs = { Harsh: await harsh.record(), Nishtha: await nishtha.record() };
    const drawnH = everyFixDrawn(recs.Harsh, nishtha.dev.id, t.h);
    const drawnN = everyFixDrawn(recs.Nishtha, harsh.dev.id, t.n);
    for (const [who, d] of [['Harsh', drawnH], ['Nishtha', drawnN]]) {
      check(d.frames >= hPath.length - 1 && d.drawn >= d.frames - 1 && d.frameGapMs.max < 2500, `${who}'s map did not keep up with the other: ${JSON.stringify(d)}`);
    }
    const glides = glidesOk(run.glides, recs);
    const same = instantsOk(run.comparisons);

    // History: each has their own fence's crossing, never the other's.
    const [hFeed, nFeed] = [await activity(harsh), await activity(nishtha)];
    check(hFeed.some((i) => i.type === 'geo' && i.placeId === B.id && i.subjectUserId === nishtha.id), 'Harsh’s activity lacks Nishtha passing Bakery');
    check(nFeed.some((i) => i.type === 'geo' && i.placeId === L.id && i.subjectUserId === harsh.id), 'Nishtha’s activity lacks Harsh passing Library');
    check(!hFeed.some((i) => /Library/.test(JSON.stringify(i))) && !nFeed.some((i) => /Bakery/.test(JSON.stringify(i))), 'a History shows the other person’s fence');
    await Promise.all([ackAll(harsh), ackAll(nishtha)]);
    const hRows = await historyRows(harsh, (rows) => rows.some((r) => /Nishtha( Dev)? passed Bakery\b/.test(r)));
    const nRows = await historyRows(nishtha, (rows) => rows.some((r) => /Harsh( Singh)? passed Library\b/.test(r)));
    check(hRows.some((r) => /Nishtha( Dev)? passed Bakery\b/.test(r)) && !hRows.some((r) => /Library/.test(r)), `Harsh's History: ${JSON.stringify(hRows)}`);
    check(nRows.some((r) => /Harsh( Singh)? passed Library\b/.test(r)) && !nRows.some((r) => /Bakery/.test(r)), `Nishtha's History: ${JSON.stringify(nRows)}`);
    shots.push(await harsh.shot(SHOTS, 'uc6-harsh-history'), await nishtha.shot(SHOTS, 'uc6-nishtha-history'));
    for (const p of people) await p.nav('Live map');
    return {
      harsh: { geo: h.geo, notify: h.notify.map((x) => x.title), toasts: h.toasts, chimes: h.chimes.length },
      nishtha: { geo: n.geo, notify: n.notify.map((x) => x.title), toasts: n.toasts, chimes: n.chimes.length },
      harshDrewNishtha: drawnH, nishthaDrewHarsh: drawnN, glides, same,
      history: { harsh: hRows.filter((r) => /Bakery/.test(r)), nishtha: nRows.filter((r) => /Library/.test(r)) },
      shots: [bakery.formShot, library.formShot, ...shots],
    };
  });

  // ---------------------------------------------------------------- UC7
  await useCase('7', 'A note for Nishtha: “pick up keys” at Gym2, only she is told; she acknowledges; Harsh hears', async () => {
    const { place: gym2, ring } = await drawPolygonFence(harsh, { name: 'Gym2', center: GYM2, halfM: HALF_M, triggers: ['Pass by'], watch: [], shotDir: SHOTS });
    fenceIs(gym2, ring, GYM2, []);

    // ---- the note, in Harsh's composer
    const page = harsh.page;
    await harsh.nav('Notes');
    await page.getByPlaceholder(/^e\.g\. buy oat milk/).fill('pick up keys');
    await sleep(900);
    const pick = async (role, name) => {
      const el = page.getByRole(role, { name, exact: typeof name === 'string' }).first();
      if ((await el.getAttribute('aria-checked')) !== 'true') await el.click();
    };
    await pick('radio', /^Gym2(, suggested)?$/);
    await pick('radio', /^Pass-by(, suggested)?$/);
    await pick('radio', 'Nishtha');
    await pick('checkbox', 'Nishtha');
    const me = page.getByRole('checkbox', { name: 'Me', exact: true });
    if ((await me.getAttribute('aria-checked')) === 'true') await me.click();
    check((await me.getAttribute('aria-checked')) !== 'true', 'Harsh is still notified');
    const composerShot = await harsh.shot(SHOTS, 'uc7-note-composer');
    const posted = page.waitForResponse((r) => r.url().endsWith('/api/v1/notes') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Add note' }).click();
    check((await posted).ok(), 'creating the note failed');
    const note = (await harsh.api('GET', '/api/v1/notes')).notes.find((x) => x.text === 'pick up keys');
    check(note && note.placeId === gym2.id && note.trigger === 'passby' && note.watchUserId === nishtha.id
      && JSON.stringify(note.notifyUserIds) === JSON.stringify([nishtha.id]) && !note.done, `the note: ${JSON.stringify(note)}`);
    await harsh.nav('Live map');
    await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 10000 });

    // ---- she passes
    const path = across(GYM2);
    await park([nishtha.dev, path[0]], [harsh.dev, HARSH_HOME]);
    const t = await mark();
    const run = await drive([{ dev: nishtha.dev, path }, { dev: harsh.dev, path: Array(path.length).fill(HARSH_HOME) }], {
      glideAt: [8, 14], glideMarkers: [{ person: harsh, marker: `peer_${nishtha.dev.id}` }],
    });
    await waitFor('Nishtha’s card', async () => (await pending(nishtha)).some((r) => r.placeId === gym2.id), { timeout: 8000 });
    await sleep(2500);
    const n = await seen(nishtha, t, [gym2]);
    const h = await seen(harsh, t, [gym2]);
    check(n.notify.length === 1 && n.notify[0].kind === 'note' && n.notify[0].body === 'pick up keys' && /^Harsh( Singh)?$/.test(n.notify[0].fromName), `Nishtha's reminders: ${JSON.stringify(n.notify)}`);
    check(n.toasts.length === 1, `Nishtha's notices: ${JSON.stringify(n.toasts)}`);
    check(n.chimes.length === 1, `Nishtha's chimes: ${JSON.stringify(n.chimes)}`);
    const cards = await cardsText(nishtha);
    check(cards.length === 1 && /pick up keys/.test(cards[0]) && /from Harsh/.test(cards[0]) && /Acknowledge/.test(cards[0]), `Nishtha's cards: ${JSON.stringify(cards)}`);
    const cardShot = await nishtha.shot(SHOTS, 'uc7-nishtha-card');
    // Harsh: no card, no toast, no chime, nothing pending.
    check(h.notify.length === 0 && h.geo.length === 0 && h.wire.length === 0, `Harsh was told of her crossing: ${JSON.stringify(h)}`);
    check(h.toasts.length === 0, `Harsh's toasts: ${JSON.stringify(h.toasts)}`);
    check(h.chimes.length === 0, `Harsh's chimes: ${JSON.stringify(h.chimes)}`);
    check((await pending(harsh)).length === 0 && (await cardsText(harsh)).length === 0, 'Harsh has a card');
    const harshQuietShot = await harsh.shot(SHOTS, 'uc7-harsh-no-card');
    const same = instantsOk(run.comparisons);

    // ---- she acknowledges
    const t2 = await mark();
    await nishtha.page.getByRole('button', { name: /^Acknowledge / }).first().click();
    const ackAt = Date.now();
    const notice = await waitFor('Harsh’s acknowledgement notice', async () => {
      const s = await seen(harsh, t2, [gym2]);
      return s.toasts.length ? s : null;
    }, { timeout: 5000, every: 100 });
    const noticeMs = Date.now() - ackAt;
    await sleep(1500);
    const h2 = await seen(harsh, t2, [gym2]);
    const n2 = await seen(nishtha, t2, [gym2]);
    check(h2.notify.length === 1 && h2.notify[0].kind === 'ack' && /^Nishtha( Dev)? acknowledged pick up keys$/.test(h2.notify[0].title), `Harsh's notice: ${JSON.stringify(h2.notify)}`);
    check(h2.toasts.length === 1 && /^Nishtha( Dev)? acknowledged pick up keys$/.test(h2.toasts[0]), `Harsh's toasts: ${JSON.stringify(h2.toasts)}`);
    check(h2.chimes.length <= 1, `Harsh's chimes: ${JSON.stringify(h2.chimes)}`);
    check((await pending(harsh)).length === 0 && (await cardsText(harsh)).length === 0, 'the notice became a card for Harsh');
    check(n2.notify.length === 0 && n2.toasts.length === 0, `Nishtha was told of her own ack: ${JSON.stringify(n2)}`);
    check((await cardsText(nishtha)).length === 0 && (await pending(nishtha)).length === 0, 'Nishtha’s card stayed');
    const ackShot = await harsh.shot(SHOTS, 'uc7-harsh-ack-notice');
    const done = await waitFor('the note to be done', async () => {
      const x = (await harsh.api('GET', '/api/v1/notes')).notes.find((y) => y.id === note.id);
      return x?.done ? x : null;
    }, { timeout: 5000 });
    await harsh.nav('Notes');
    await page.getByText('pick up keys').first().waitFor({ timeout: 5000 });
    const notesShot = await harsh.shot(SHOTS, 'uc7-harsh-notes-done');

    // ---- Histories
    const [hFeed, nFeed] = [await activity(harsh), await activity(nishtha)];
    const nRem = nFeed.find((i) => i.type === 'reminder' && i.reminder.noteIds.includes(note.id));
    const nAck = nFeed.find((i) => i.type === 'ack' && i.byMe && i.noteIds.includes(note.id));
    const hAck = hFeed.find((i) => i.type === 'ack' && !i.byMe && i.noteIds.includes(note.id));
    check(nRem && nRem.reminder.status === 'acknowledged' && nAck, `Nishtha's activity: ${JSON.stringify({ nRem, nAck })}`);
    check(hAck && hAck.ackedBy === nishtha.id, `Harsh's activity lacks the acknowledgement: ${JSON.stringify(hFeed.filter((i) => i.type === 'ack'))}`);
    check(!hFeed.some((i) => i.type === 'reminder' && i.reminder.noteIds.includes(note.id)), 'Harsh’s activity has a reminder for the note he did not ask to hear');
    const hGeo = hFeed.filter((i) => i.type === 'geo' && i.placeId === gym2.id);
    check(hGeo.length === 0, `Harsh's activity records where Nishtha went though the note tells only her: ${JSON.stringify(hGeo)}`);
    const nRows = await historyRows(nishtha, (rows) => rows.some((r) => /pick up keys/.test(r) && /acknowledged/.test(r)) && rows.some((r) => /Acknowledged pick up keys/.test(r)));
    check(nRows.some((r) => /Reminder: pick up keys — acknowledged/.test(r) && /from Harsh/.test(r)), `Nishtha's History lacks the reminder: ${JSON.stringify(nRows)}`);
    check(nRows.some((r) => /Acknowledged pick up keys/.test(r)), `Nishtha's History lacks her acknowledgement: ${JSON.stringify(nRows)}`);
    const nHistShot = await nishtha.shot(SHOTS, 'uc7-nishtha-history');
    const hRows = await historyRows(harsh, (rows) => rows.some((r) => /Nishtha( Dev)? acknowledged pick up keys/.test(r)));
    check(hRows.some((r) => /Nishtha( Dev)? acknowledged pick up keys/.test(r)), `Harsh's History lacks the acknowledgement: ${JSON.stringify(hRows)}`);
    check(!hRows.some((r) => /passed Gym2/.test(r)), `Harsh's History shows where Nishtha went: ${JSON.stringify(hRows)}`);
    check(!hRows.some((r) => /Reminder: pick up keys/.test(r)),`Harsh's History shows a reminder he never got: ${JSON.stringify(hRows)}`);
    const hHistShot = await harsh.shot(SHOTS, 'uc7-harsh-history');
    for (const p of people) await p.nav('Live map');
    return {
      note: { watchUserId: note.watchUserId, notifyUserIds: note.notifyUserIds, doneAfterAck: done.done },
      nishtha: { notify: n.notify.map((x) => `${x.kind}:${x.title}/${x.body}/from ${x.fromName}`), toasts: n.toasts, chimes: n.chimes.length, cards },
      harshAtCrossing: { geo: h.geo, notify: h.notify.length, toasts: h.toasts.length, chimes: h.chimes.length },
      ack: { harshNotice: notice.toasts[0], noticeMs, harshChimes: h2.chimes.map((c) => c.kind) },
      history: { nishtha: nRows.filter((r) => /keys/.test(r)), harsh: hRows.filter((r) => /keys|Gym2/.test(r)), harshGeoItems: hGeo.length },
      same,
      shots: [composerShot, cardShot, harshQuietShot, ackShot, notesShot, nHistShot, hHistShot],
    };
  });

  // ---------------------------------------------------------------- hygiene
  await useCase('Z', 'No page errors, console errors or failed requests in either browser', async () => {
    const out = {};
    for (const p of people) {
      const errors = p.errors.filter((e) => !/favicon/.test(e.text ?? ''));
      const bad = p.badResponses.filter((r) => !/favicon/.test(r.url));
      out[p.name] = { errors: errors.length, bad: bad.length };
      check(errors.length === 0, `${p.name}: ${JSON.stringify(errors.slice(0, 5))}`);
      check(bad.length === 0, `${p.name}: ${JSON.stringify(bad.slice(0, 5))}`);
    }
    return out;
  });
} finally {
  for (const p of people) p.obs?.close();
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, instants }, null, 2));
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => r.pass === false);
process.stdout.write(`\n${results.filter((r) => r.pass).length} passed, ${failed.length} failed → ${OUT}/results.json\n`);
process.exit(failed.length ? 1 : 0);
