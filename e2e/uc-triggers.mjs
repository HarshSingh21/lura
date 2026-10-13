// Trigger use cases, end to end, in two browsers: what a person standing still,
// leaving, or asking for silence actually gets.
//
//   UC8   Dwell. "Office" with a one-minute dwell and the note "submit
//         timesheet". Leaving before the minute is up: nothing. Staying: exactly
//         one reminder, a sticky card with Acknowledge, never repeated by the
//         fixes that keep arriving from inside.
//   UC9   Leave. "Home" with the note "lock the door". Standing at the edge with
//         GPS noise straddling it: no leave. Walking off: one. Back, settled, off
//         again after the cool-off: a second. Once acknowledged the note is done,
//         so a third departure is only a passing toast.
//   UC11  Quiet hours and mute. Nishtha's quiet hours cover now; Harsh mutes
//         sounds. A crossing still stores both reminders, shows both sticky
//         cards and lands in both Histories; neither chimes (nor do the
//         repeats); Nishtha's push is held, Harsh's (not in quiet hours) is not;
//         Acknowledge works for both, and Harsh hears that Nishtha acknowledged.
//   UC-X  Overlapping fences: a food court inside a mall, both arrive, two
//         cards. One fence with two notes: one card listing both, one
//         acknowledgement finishing both notes.
//
// Harsh's phone is a device the suite registers and drives (lib/phone.mjs);
// every fence and note here is his own, about his own movement, except that
// UC11's notes also notify Nishtha. Judged on the wire (each browser's socket),
// in the store (REST: reminders, notes, activity), in each browser's DOM (cards,
// toasts, History rows), by ear (the AudioContext spy and the repeat log), and
// at the push sink.
//
// Run it with e2e/uc-triggers.sh (its own Lura on :8094, a 5 s cool-off, a
// webhook sink). Environment is run.sh's, plus:
//   E2E_CASES   e.g. "UC8,UC11" to run a subset (setup always runs)

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, Person, chimes, sleep, waitFor } from './lib/browser.mjs';
import { haversineM } from './lib/geo.mjs';
import { Phone, box, offset } from './lib/phone.mjs';
import { startSink } from './lib/webhook.mjs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:8094';
const API = process.env.E2E_API ?? BASE;
process.env.E2E_API = API;
const OUT = process.env.E2E_OUT ?? '/tmp/lura-uc-triggers';
const LURASIM = process.env.E2E_LURASIM ?? 'lurasim';
const COOLOFF_MS = Number(process.env.E2E_COOLOFF_MS ?? 5000);
const ONLY = (process.env.E2E_CASES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SHOTS = `${OUT}/shots`;
mkdirSync(SHOTS, { recursive: true });

// The server's dwell clock: whole minutes, matured timers checked every
// DwellTick (10 s by default).
const DWELL_TICK_MS = 10_000;
// Pending reminders ring again every minute until acknowledged; outside UC11
// (which shortens it to watch the repeats stay silent) the repeats are pushed
// out of every window, so each chime counted is a crossing's own.
const NO_REPEAT_MS = 24 * 3600 * 1000;

// ------------------------------------------------------------------ geography
// Koramangala, Bengaluru: one block per case, ~800 m apart, so no case's fences
// see another's fixes. Harsh's phone waits at PARK between cases.
const HARSH_AT = { lat: 12.9260, lon: 77.6080 }; // his browser (it does not publish)
const NISHTHA_AT = { lat: 12.9265, lon: 77.6090 };
const PARK = { lat: 12.9280, lon: 77.6100 };
const AREA = {
  office: { lat: 12.9350, lon: 77.6200 },
  home: { lat: 12.9350, lon: 77.6300 },
  bookshop: { lat: 12.9420, lon: 77.6200 },
  library: { lat: 12.9420, lon: 77.6300 },
  mall: { lat: 12.9490, lon: 77.6200 },
  pharmacy: { lat: 12.9490, lon: 77.6300 },
};

// ------------------------------------------------------------------ browsers
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADED !== '1',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const harsh = new Person({ name: 'Harsh', email: 'harsh@lura.local', password: 'lura-harsh', start: HARSH_AT });
const nishtha = new Person({ name: 'Nishtha', email: 'nishtha@lura.local', password: 'lura-nishtha', start: NISHTHA_AT });
const people = [harsh, nishtha];
/** Harsh's phone, registered in setup. */
let phone;

const results = [];
/** Undo steps a case registers (mute, quiet hours), run whether it passes or not. */
const restore = [];
const sink = await startSink(Number(process.env.E2E_WEBHOOK_PORT ?? 0));

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function useCase(id, title, fn) {
  if (ONLY.length && id !== 'setup' && !ONLY.includes(id)) {
    results.push({ id, title, pass: true, skipped: true });
    process.stdout.write(`\n[${id}] ${title}\n  SKIPPED\n`);
    return;
  }
  const started = Date.now();
  process.stdout.write(`\n[${id}] ${title}\n`);
  if (id !== 'setup') for (const p of people) await tidy(p).catch(() => {});
  try {
    const evidence = await fn();
    results.push({ id, title, pass: true, ms: Date.now() - started, evidence });
    process.stdout.write(`  PASS ${JSON.stringify(evidence)}\n`);
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - started, error: String(err?.stack ?? err) });
    process.stdout.write(`  FAIL ${err?.stack ?? err}\n`);
    for (const p of people) await p.shot(SHOTS, `fail-${id}`).catch(() => {});
    if (id === 'setup') throw err;
  } finally {
    await phone?.halt();
    for (const undo of restore.splice(0).reverse()) await undo().catch(() => {});
    // Whatever a case left pending would ring into the next one's window.
    if (id !== 'setup') await ackEverything().catch(() => {});
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
}

/** ackEverything acknowledges every pending reminder of both people, over the API. */
async function ackEverything() {
  for (const p of people) {
    const { reminders } = await p.api('GET', '/api/v1/reminders?status=pending');
    for (const r of reminders ?? []) await p.api('POST', `/api/v1/reminders/${r.id}/ack`, {});
  }
}

/** park sends Harsh's phone far from every fence and lets the cool-off lapse. */
async function park() {
  await phone.pub(PARK, { speed: 0 });
  await sleep(COOLOFF_MS + 500);
}

// ------------------------------------------------------------------ observing
async function mark() {
  return { h: await harsh.page.evaluate(() => performance.now()), n: await nishtha.page.evaluate(() => performance.now()), wall: Date.now() };
}

function since(list, t0) {
  return list.filter((x) => x.t >= t0);
}

/** seen is what one person's page took in since a mark, about one place. */
async function seen(p, t0, placeId, placeName) {
  const rec = await p.record();
  const after = since(rec.frames, t0);
  const geo = after.filter((f) => f.type === 'geo' && f.data.placeId === placeId);
  const notify = after.filter((f) => f.type === 'notify' && f.data.placeId === placeId);
  // One notice per crossing: a toast and the sticky card that replaces it name
  // the same crossing (lura-notice-<id>, lib/instrument.mjs). History rows and
  // the notification centre also end "Show on the map." but carry no notice id.
  const ids = new Set();
  const notices = [];
  for (const x of since(rec.toasts, t0)) {
    if (!x.notice || ids.has(x.notice)) continue;
    if (!(x.label + x.text).includes(placeName)) continue;
    ids.add(x.notice);
    notices.push(x.label.replace(/\. Show on the map\.$/, ''));
  }
  return { geo, notify, notices, chimes: chimes(since(rec.notes, t0)), positions: after.filter((f) => f.type === 'position' && f.deviceId === phone.id) };
}

/** reminders is the server's record of one person's reminders about one place. */
async function reminders(p, placeId, status = 'all') {
  const { reminders: list } = await p.api('GET', `/api/v1/reminders?status=${status}&limit=200`);
  return (list ?? []).filter((r) => r.placeId === placeId);
}

/**
 * cards reads the sticky reminder cards on a person's screen. The stack shows
 * the newest in full and folds the rest ("+2 more"), so it is unfolded to read
 * them all, then folded back as it was.
 */
async function cards(p) {
  const page = p.page;
  const more = page.getByRole('button', { name: /^Show \d+ more pending reminders$/ });
  const folded = (await more.count()) > 0;
  if (folded) {
    await more.first().click();
    await sleep(300);
  }
  const list = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"]')]
      .filter((el) => (el.getAttribute('aria-label') || '').startsWith('Reminder:'))
      .map((el) => ({ label: el.getAttribute('aria-label'), text: el.innerText })),
  );
  if (folded) await page.getByRole('button', { name: 'Fold pending reminders' }).first().click().catch(() => {});
  return list;
}

/**
 * acknowledge presses a card's Acknowledge button and waits for the card to go
 * and the server to agree. Returns how long the card took to leave the screen.
 */
async function acknowledge(p, reminder) {
  const page = p.page;
  const more = page.getByRole('button', { name: /^Show \d+ more pending reminders$/ });
  if (await more.count()) {
    await more.first().click();
    await sleep(300);
  }
  const button = page.getByRole('button', { name: `Acknowledge ${reminder.title}`, exact: true });
  await button.first().waitFor({ timeout: 5000 });
  const before = (await cards(p)).length;
  // Timed in the page, from the press to the card leaving the DOM, so the
  // figure is the app's, not Playwright's actionability checks or polling.
  await page.evaluate((label) => {
    const alerts = () => document.querySelectorAll('[role="alert"][aria-label^="Reminder:"]').length;
    const start = alerts();
    window.__ucAck = new Promise((resolve) => {
      let pressed = 0;
      const button = [...document.querySelectorAll('[role="button"]')].find((b) => b.getAttribute('aria-label') === label);
      button?.addEventListener('pointerdown', () => { pressed = performance.now(); }, { once: true, capture: true });
      button?.addEventListener('click', () => { pressed ||= performance.now(); }, { once: true, capture: true });
      const mo = new MutationObserver(() => {
        if (pressed && alerts() < start) {
          mo.disconnect();
          resolve(performance.now() - pressed);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    });
  }, `Acknowledge ${reminder.title}`);
  await button.first().click();
  await waitFor(`${p.name}'s card for “${reminder.title}” to go`, async () => (await cards(p)).length === before - 1, { timeout: 5000, every: 50 });
  const goneMs = Math.round(await page.evaluate(() => window.__ucAck));
  const fold = page.getByRole('button', { name: 'Fold pending reminders' });
  if (await fold.count()) await fold.first().click().catch(() => {});
  const stored = await waitFor(`the server to record ${p.name}'s acknowledgement`, async () => {
    const r = (await reminders(p, reminder.placeId)).find((x) => x.id === reminder.id);
    return r?.status === 'acknowledged' ? r : null;
  }, { timeout: 5000 });
  return { goneMs, ackedAt: stored.ackedAt };
}

/** history opens a person's History screen and returns the timeline rows' text. */
async function historyRows(p) {
  await p.nav('History');
  const page = p.page;
  await waitFor(`${p.name}'s History timeline`, async () => (await page.getByRole('button', { name: /\. Show on the map\.$/ }).count()) > 0, { timeout: 15000 });
  await sleep(600);
  // A pending card stays on screen everywhere; on History it must not sit on
  // the timeline's day picker.
  const covered = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const cards = [...document.querySelectorAll('[role="alert"]')].map(box);
    return ['Previous day', 'Next day'].filter((name) => {
      const el = document.querySelector(`[aria-label="${name}"]`);
      return el && cards.some((c) => hit(c, box(el)));
    });
  });
  check(covered.length === 0, `${p.name}'s reminder card covers History's ${covered.join(' and ')} button`);
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="button"][aria-label$=". Show on the map."]')]
      .filter((el) => !el.closest('[aria-modal="true"]') && !el.getAttribute('data-testid'))
      .map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
  );
}

/** centreOn drags a person's map so a point sits mid-view, then sets the zoom with the buttons. */
async function centreOn(person, point, zoom) {
  const page = person.page;
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
    const grab = { x: mid.x - 60, y: mid.y + 90 };
    await person.drag(grab, { x: grab.x - (p.x - mid.x), y: grab.y - (p.y - mid.y) }, { steps: 14 });
  }
  return person.stableViewport(500);
}

/** tilesQuiet waits until the basemap stops fetching, so a shot shows a map. */
async function tilesQuiet(p) {
  await waitFor('the basemap to finish loading', async () => Date.now() - (p.tiles.at(-1)?.at ?? 0) > 900, { timeout: 15000, every: 150 }).catch(() => {});
}

/** fence creates one of Harsh's places with notes on it (his own movement fires them). */
async function fence(body, notes) {
  const { place } = await harsh.api('POST', '/api/v1/places', body);
  const made = [];
  for (const n of notes) {
    const { note } = await harsh.api('POST', '/api/v1/notes', { placeId: place.id, watchUserId: '', notifyUserIds: [], ...n });
    made.push(note);
  }
  return { place, notes: made };
}

async function noteById(id) {
  const { notes } = await harsh.api('GET', '/api/v1/notes');
  return notes.find((n) => n.id === id);
}

async function setRepeat(ms) {
  for (const p of people) await p.page.evaluate((v) => { window.__luraRemindEveryMs = v; window.__luraChimeLog = []; }, ms);
}

async function chimeLog(p) {
  return p.page.evaluate(() => window.__luraChimeLog ?? []);
}

const round = (v) => Math.round(v);

// ======================================================================
try {
  // ---------------------------------------------------------------- setup
  await useCase('setup', 'Both sign in and connect; Harsh gets a phone; both add a push channel', async () => {
    await Promise.all(people.map((p) => p.open(browser, BASE)));
    await Promise.all(people.map((p) => p.ctx.addInitScript((ms) => { window.__luraRemindEveryMs = ms; }, NO_REPEAT_MS)));
    await Promise.all(people.map((p) => p.page.evaluate((ms) => { window.__luraRemindEveryMs = ms; }, NO_REPEAT_MS)));
    await Promise.all(people.map((p) => p.signIn()));
    // A Docker VM that slept keeps its old clock for a while, and Keycloak then
    // issues tokens that expire early (or late) by the drift: every failure
    // after that is the clock's, not the app's. Say so up front.
    const iat = JSON.parse(Buffer.from((await harsh.token()).split('.')[1], 'base64url').toString()).iat * 1000;
    check(Math.abs(Date.now() - iat) < 30_000, `Keycloak's clock is ${Math.round((Date.now() - iat) / 1000)} s off this machine's: fix the Docker clock first`);
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
    phone = await Phone.register(harsh, { name: 'Harsh’s phone', api: API, lurasim: LURASIM });
    // The deployment's webhook notifier (LURA_WEBHOOK_URL, set by
    // uc-triggers.sh) is the push channel; each of them turns it on.
    check(process.env.E2E_WEBHOOK_PORT, 'E2E_WEBHOOK_PORT is not set: run this suite with e2e/uc-triggers.sh');
    for (const p of people) await p.api('POST', '/api/v1/channels', { type: 'webhook', config: {}, priority: 1 });
    const t = await mark();
    await phone.pub(PARK);
    await waitFor('Harsh’s phone on his own socket', async () => (await seen(harsh, t.h, '-', '-')).positions.length > 0, { timeout: 15000 });
    // A gesture so Web Audio may start, as a person's first click would.
    for (const p of people) await p.page.mouse.click(5, 450);
    return { harsh: harsh.id, nishtha: nishtha.id, phone: phone.id, webhook: sink.url };
  });

  // ---------------------------------------------------------------- UC8
  await useCase('UC8', 'Dwell: one reminder for staying, none for leaving early, none repeated', async () => {
    const O = AREA.office;
    const { place, notes } = await fence(
      { name: 'Office', shape: 'circle', center: O, radiusM: 80, triggers: ['dwell'], dwellMins: 1 },
      [{ text: 'submit timesheet', trigger: 'dwell' }],
    );
    const west = offset(O, -300, 0);
    const back = offset(O, -300, 160); // lurasim closes the loop: this keeps the last leg outside
    await centreOn(harsh, O, 15.5);

    // ---- leaving early: ~30 s inside (scale 2: a 50 s simulated stop is 25 s of fixes).
    let t = await mark();
    await phone.sim([west, { ...O, dwell: 50 }, back], { interval: '1s', scale: 2, jitter: 3 }).done;
    const early = await seen(harsh, t.h, place.id, 'Office');
    const insideEarly = early.positions.filter((f) => haversineM(f, O) <= 80);
    check(insideEarly.length >= 10, `the early visit barely went inside: ${insideEarly.length} fixes`);
    const enteredAt = insideEarly[0].wall;
    const leftAt = insideEarly.at(-1).wall;
    // Past the minute, plus a dwell tick, plus slack, from the first fix inside.
    await sleep(Math.max(0, enteredAt + 60_000 + DWELL_TICK_MS + 8000 - Date.now()));
    const afterEarly = await seen(harsh, t.h, place.id, 'Office');
    const storedEarly = await reminders(harsh, place.id);
    check(afterEarly.geo.length === 0, `leaving early fired: ${afterEarly.geo.map((f) => f.data.trigger)}`);
    check(storedEarly.length === 0, `leaving early stored ${storedEarly.length} reminders`);
    check(afterEarly.notices.length === 0 && (await cards(harsh)).length === 0, `leaving early showed ${afterEarly.notices}`);
    check(afterEarly.chimes.length === 0, `leaving early chimed ${afterEarly.chimes.length} times`);
    const earlyEvidence = { insideS: round((leftAt - enteredAt) / 1000), waitedAfterEntryS: round((Date.now() - enteredAt) / 1000), events: 0 };

    // ---- staying: 130 s inside (a 260 s simulated stop at scale 2).
    await park();
    t = await mark();
    const tWall = Date.now();
    const stay = phone.sim([west, { ...O, dwell: 260 }, back], { interval: '1s', scale: 2, jitter: 3 });
    const fired = await waitFor('the dwell reminder', async () => {
      const s = await seen(harsh, t.h, place.id, 'Office');
      return s.notify.length > 0 ? s : null;
    }, { timeout: 120_000, every: 500 });
    const firstIn = fired.positions.find((f) => haversineM(f, O) <= 80);
    const dwellAfterS = (fired.geo[0].wall - firstIn.wall) / 1000;
    await waitFor('Harsh’s reminder card', async () => (await cards(harsh)).length === 1, { timeout: 5000 });
    await sleep(800);
    const cardShot = await harsh.shot(SHOTS, 'UC8-dwell-card');
    await stay.done;
    await sleep(DWELL_TICK_MS + 3000); // a tick after the last fix: nothing more may mature
    const o = await seen(harsh, t.h, place.id, 'Office');
    const insideAfter = o.positions.filter((f) => haversineM(f, O) <= 80 && f.wall > fired.geo[0].wall);
    const stored = await reminders(harsh, place.id);
    const shown = await cards(harsh);
    check(o.geo.length === 1 && o.geo[0].data.trigger === 'dwell', `staying fired ${o.geo.map((f) => f.data.trigger)}`);
    check(dwellAfterS >= 59 && dwellAfterS <= 60 + DWELL_TICK_MS / 1000 + 5, `the dwell fired ${dwellAfterS.toFixed(1)} s after entering`);
    check(insideAfter.length >= 30, `only ${insideAfter.length} fixes inside after the dwell fired: "not repeated" is untested`);
    check(o.notify.length === 1, `${o.notify.length} reminder frames`);
    check(stored.length === 1 && stored[0].status === 'pending', `stored: ${JSON.stringify(stored.map((r) => r.status))}`);
    check(stored[0].noteIds.length === 1 && stored[0].noteIds[0] === notes[0].id && stored[0].body === 'submit timesheet', `the reminder: ${JSON.stringify(stored[0])}`);
    check(o.notices.length === 1, `notices: ${o.notices}`);
    check(shown.length === 1 && shown[0].text.includes('submit timesheet'), `cards: ${JSON.stringify(shown)}`);
    check(o.chimes.length === 1 && o.chimes[0].kind === 'dwell', `chimes: ${JSON.stringify(o.chimes)}`);
    // Still there, a minute later, still waiting: a sticky card does not time out.
    check((await cards(harsh)).length === 1, 'the card went away on its own');

    // ---- acknowledge
    const ack = await acknowledge(harsh, stored[0]);
    check(ack.goneMs < 1500, `the card took ${ack.goneMs} ms to go`);
    check((await noteById(notes[0].id)).done, 'acknowledging did not finish the note');
    await sleep(500);
    const ackShot = await harsh.shot(SHOTS, 'UC8-after-ack');
    await park();
    return {
      leftEarly: earlyEvidence,
      stayed: {
        dwellFiredAfterS: Math.round(dwellAfterS * 10) / 10,
        fixesInsideAfterFiring: insideAfter.length,
        geoEvents: o.geo.length,
        storedReminders: stored.length,
        cards: shown.length,
        chimes: o.chimes.map((c) => c.kind),
        title: stored[0].title,
        body: stored[0].body,
        stayS: round((Date.now() - tWall) / 1000),
      },
      ack: { cardGoneMs: ack.goneMs, noteDone: true },
      shots: [cardShot, ackShot],
    };
  });

  // ---------------------------------------------------------------- UC9
  await useCase('UC9', 'Leave: one per departure, none from jitter at the edge, a second after the cool-off', async () => {
    const H = AREA.home;
    const R = 60;
    const { place, notes } = await fence(
      { name: 'Home', shape: 'circle', center: H, radiusM: R, triggers: ['leave'] },
      [{ text: 'lock the door', trigger: 'leave' }],
    );
    const nw = offset(H, -250, 250);
    const ne = offset(H, 300, 250); // the closing leg ne → nw runs 250 m north: outside
    const edge = offset(H, 56, 0); // 4 m inside the east edge
    await centreOn(harsh, H, 16);

    // ---- in, settle, out to the east edge and stand there 60 s with ±10 m of noise, then off.
    let t = await mark();
    await phone.sim([nw, { ...H, dwell: 20 }, { ...edge, dwell: 120 }, ne], { interval: '1s', scale: 2, jitter: 10 }).done;
    await sleep(2500);
    const first = await seen(harsh, t.h, place.id, 'Home');
    const nearEdge = first.positions.filter((f) => haversineM(f, edge) <= 12);
    const outside = nearEdge.filter((f) => haversineM(f, H) > R).length;
    const inside = nearEdge.length - outside;
    check(inside >= 3 && outside >= 3, `the noise did not straddle the edge: ${inside} in, ${outside} out of ${nearEdge.length}`);
    check(first.geo.length === 1 && first.geo[0].data.trigger === 'leave', `the first departure fired ${first.geo.map((f) => f.data.trigger)}`);
    const leaveAt = first.geo[0].data.point;
    const leaveDistM = haversineM(leaveAt, H);
    // The leave is judged on a fix clear of the hysteresis (20 m), i.e. on the walk off, not the noise.
    check(leaveDistM >= R + 20, `the leave fired ${leaveDistM.toFixed(1)} m from the centre: from the noise at the edge`);
    check(first.notify.length === 1 && first.notices.length === 1, `first departure: ${first.notify.length} frames, notices ${first.notices}`);
    check(first.chimes.length === 1 && first.chimes[0].kind === 'leave', `chimes: ${JSON.stringify(first.chimes)}`);
    const cardShot = await harsh.shot(SHOTS, 'UC9-leave-card');

    // ---- the cool-off lapses; back home, settle, off again.
    await sleep(COOLOFF_MS + 1000);
    t = await mark();
    await phone.sim([nw, { ...H, dwell: 20 }, ne], { interval: '1s', scale: 2, jitter: 3 }).done;
    await sleep(2500);
    const second = await seen(harsh, t.h, place.id, 'Home');
    check(second.geo.length === 1 && second.geo[0].data.trigger === 'leave', `the second departure fired ${second.geo.map((f) => f.data.trigger)}`);
    check(second.notices.length === 1 && second.chimes.length === 1, `second departure: notices ${second.notices}, chimes ${second.chimes.length}`);
    const stored = await reminders(harsh, place.id, 'pending');
    check(stored.length === 2 && stored.every((r) => r.body === 'lock the door' && r.noteIds[0] === notes[0].id), `pending: ${JSON.stringify(stored.map((r) => r.body))}`);
    const shown = await cards(harsh);
    check(shown.length === 2, `cards: ${shown.length}`);
    await sleep(500);
    const stackShot = await harsh.shot(SHOTS, 'UC9-two-pending');

    // ---- acknowledge both; the note is done, so a third departure is a passing toast.
    const acks = [];
    for (const r of stored) acks.push(await acknowledge(harsh, r));
    check((await noteById(notes[0].id)).done, 'the note is not done after acknowledging');
    await sleep(COOLOFF_MS + 1000);
    t = await mark();
    await phone.sim([nw, { ...H, dwell: 20 }, ne], { interval: '1s', scale: 2, jitter: 3 }).done;
    await sleep(2500);
    const third = await seen(harsh, t.h, place.id, 'Home');
    const after = await reminders(harsh, place.id);
    check(third.geo.length === 1, `the third departure fired ${third.geo.length} events`);
    check(after.length === 2, `a done note stored another reminder (${after.length})`);
    check((await cards(harsh)).length === 0, 'a done note raised a card');
    await park();
    return {
      edge: { fixesNearEdge: nearEdge.length, inside, outside },
      first: { leaveDistanceM: round(leaveDistM), notices: first.notices, chimes: first.chimes.map((c) => c.kind) },
      second: { notices: second.notices, pendingAfter: stored.length, cards: shown.length },
      acks: acks.map((a) => a.goneMs),
      afterDone: { geoEvents: third.geo.length, notices: third.notices, storedReminders: after.length },
      shots: [cardShot, stackShot],
    };
  });

  // ---------------------------------------------------------------- UC11
  await useCase('UC11', 'Quiet hours (Nishtha) and mute (Harsh): stored, carded, in History, silent; push held', async () => {
    const note = { trigger: 'arrive', notifyUserIds: [harsh.id, nishtha.id] };
    const visit = async (c) => {
      await phone.pub(offset(c, -250, 0), { speed: 1 });
      await sleep(1200);
      await phone.pub(c, { speed: 0 });
      await sleep(3000);
      await phone.pub(offset(c, -250, 0), { speed: 1 });
      await sleep(2000);
    };

    // ---- control: no quiet hours, sound on. Both chime, both are pushed.
    const shop = await fence({ name: 'Bookshop', shape: 'circle', center: AREA.bookshop, radiusM: 50, triggers: ['arrive'] }, [{ text: 'collect the order', ...note }]);
    let t = await mark();
    await visit(AREA.bookshop);
    const loud = { h: await seen(harsh, t.h, shop.place.id, 'Bookshop'), n: await seen(nishtha, t.n, shop.place.id, 'Bookshop') };
    const loudPush = { h: sink.since(t.wall, harsh.id).length, n: sink.since(t.wall, nishtha.id).length };
    check(loud.h.chimes.length === 1 && loud.n.chimes.length === 1, `control chimes: ${loud.h.chimes.length}/${loud.n.chimes.length}`);
    check(loudPush.h === 1 && loudPush.n === 1, `control pushes: ${JSON.stringify(loudPush)}`);
    await ackEverything();
    await park();

    // ---- Harsh mutes from the notification centre.
    const hp = harsh.page;
    await hp.locator('[aria-label^="Notifications"]').first().click();
    const muteSwitch = hp.getByRole('switch', { name: 'Sounds on. Mute notification sounds' });
    await muteSwitch.waitFor({ timeout: 5000 });
    await muteSwitch.click();
    restore.push(async () => {
      await tidy(harsh);
      await hp.locator('[aria-label^="Notifications"]').first().click();
      const on = hp.getByRole('switch', { name: 'Sounds off. Turn notification sounds on' });
      if (await on.count()) await on.click();
      await hp.getByRole('button', { name: 'Close', exact: true }).click();
    });
    await hp.getByRole('switch', { name: 'Sounds off. Turn notification sounds on' }).waitFor({ timeout: 3000 });
    await sleep(700); // the panel's fade-in
    const muteShot = await harsh.shot(SHOTS, 'UC11-muted');
    await hp.getByRole('button', { name: 'Close', exact: true }).click();
    // ---- Nishtha sets quiet hours around now, in Settings.
    const hm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    const from = hm(new Date(Date.now() - 3600_000));
    const to = hm(new Date(Date.now() + 3600_000));
    restore.push(() => nishtha.api('PATCH', '/api/v1/me', { quietFrom: '', quietTo: '' }));
    await nishtha.nav('Settings');
    await nishtha.page.getByLabel('From', { exact: true }).fill(from);
    await nishtha.page.getByLabel('To', { exact: true }).fill(to);
    await nishtha.page.getByLabel('Timezone', { exact: true }).fill('Asia/Kolkata');
    await nishtha.page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await nishtha.page.getByText('Settings saved').waitFor({ timeout: 5000 });
    const quietShot = await nishtha.shot(SHOTS, 'UC11-quiet-hours');
    const { user } = await nishtha.api('GET', '/api/v1/me');
    check(user.quietFrom === from && user.quietTo === to, `quiet hours saved as ${user.quietFrom}–${user.quietTo}`);
    await nishtha.nav('Live map');

    // ---- the crossing. Repeats every 4 s, so the window also holds repeats.
    const lib = await fence({ name: 'Library', shape: 'circle', center: AREA.library, radiusM: 50, triggers: ['arrive'] }, [{ text: 'return the books', ...note }]);
    await setRepeat(4000);
    t = await mark();
    await visit(AREA.library);
    await sleep(10_000);
    const h = await seen(harsh, t.h, lib.place.id, 'Library');
    const n = await seen(nishtha, t.n, lib.place.id, 'Library');
    const push = { h: sink.since(t.wall, harsh.id).length, n: sink.since(t.wall, nishtha.id).length };
    const repeats = { h: await chimeLog(harsh), n: await chimeLog(nishtha) };
    const storedH = await reminders(harsh, lib.place.id, 'pending');
    const storedN = await reminders(nishtha, lib.place.id, 'pending');
    await setRepeat(NO_REPEAT_MS);
    check(storedH.length === 1 && storedN.length === 1, `stored: Harsh ${storedH.length}, Nishtha ${storedN.length}`);
    check(storedN[0].fromName === 'Harsh' || storedN[0].fromUserId === harsh.id, `Nishtha's reminder does not say it is from Harsh: ${JSON.stringify(storedN[0])}`);
    check(h.notify.length === 1 && n.notify.length === 1, `frames: ${h.notify.length}/${n.notify.length}`);
    const cardsH = await cards(harsh);
    const cardsN = await cards(nishtha);
    check(cardsH.length === 1 && cardsH[0].text.includes('return the books'), `Harsh's cards: ${JSON.stringify(cardsH)}`);
    check(cardsN.length === 1 && cardsN[0].text.includes('return the books'), `Nishtha's cards: ${JSON.stringify(cardsN)}`);
    // Each card says why it is silent.
    check(/muted/i.test(cardsH[0].text) && /quiet hours/i.test(cardsN[0].text), `silent cards do not say why: ${JSON.stringify([cardsH[0].text, cardsN[0].text])}`);
    check(h.chimes.length === 0, `muted Harsh heard ${h.chimes.length} chimes: ${JSON.stringify(h.chimes)}`);
    check(n.chimes.length === 0, `Nishtha heard ${n.chimes.length} chimes in her quiet hours`);
    check(repeats.h.length >= 1 && repeats.h.every((r) => r.how === 'muted'), `Harsh's repeats: ${JSON.stringify(repeats.h)}`);
    check(repeats.n.length >= 1 && repeats.n.every((r) => r.how === 'quiet'), `Nishtha's repeats: ${JSON.stringify(repeats.n)}`);
    check(push.n === 0, `Nishtha was pushed ${push.n} times in her quiet hours`);
    // Mute is this screen's sound, not the account's push (release spec §4, §6).
    check(push.h === 1, `Harsh (muted, not in quiet hours) was pushed ${push.h} times`);
    const cardShots = [await harsh.shot(SHOTS, 'UC11-muted-card'), await nishtha.shot(SHOTS, 'UC11-quiet-card')];

    // ---- History, before and after acknowledging.
    const pendingRows = { h: await historyRows(harsh), n: await historyRows(nishtha) };
    const pendingRow = (rows) => rows.find((r) => r.includes('return the books') && /pending/i.test(r));
    check(pendingRow(pendingRows.h), `Harsh's History has no pending Library reminder: ${JSON.stringify(pendingRows.h)}`);
    check(pendingRow(pendingRows.n), `Nishtha's History has no pending Library reminder: ${JSON.stringify(pendingRows.n)}`);
    const historyShots = [await harsh.shot(SHOTS, 'UC11-history-pending'), await nishtha.shot(SHOTS, 'UC11-history-pending')];
    for (const p of people) await p.nav('Live map');
    const ackN = await acknowledge(nishtha, storedN[0]);
    // Harsh hears that she did, without a sound (muted) and without a card (it is news, not a reminder).
    await waitFor('Harsh to hear Nishtha acknowledged', async () => (await reminders(harsh, lib.place.id)).some((r) => r.kind === 'ack'), { timeout: 5000 });
    const ackH = await acknowledge(harsh, storedH[0]);
    check(ackN.goneMs < 1500 && ackH.goneMs < 1500, `cards took ${ackN.goneMs}/${ackH.goneMs} ms to go`);
    check((await noteById(lib.notes[0].id)).done, 'the Library note is not done after both acknowledged');
    const ackedRows = { h: await historyRows(harsh), n: await historyRows(nishtha) };
    const ackedRow = (rows) => rows.find((r) => r.includes('return the books') && /acknowledged \d\d:\d\d/.test(r));
    check(ackedRow(ackedRows.h) && ackedRow(ackedRows.n), `History after acknowledging: ${JSON.stringify(ackedRows)}`);
    check(ackedRows.h.some((r) => /Nishtha( \w+)? acknowledged return the books/.test(r)), `Harsh's History does not say Nishtha acknowledged: ${JSON.stringify(ackedRows.h)}`);
    const historyAckShots = [await harsh.shot(SHOTS, 'UC11-history-acked'), await nishtha.shot(SHOTS, 'UC11-history-acked')];

    // ---- back to normal (the restore steps: unmute, quiet hours off)
    for (const p of people) await p.nav('Live map');
    await park();
    return {
      control: { chimes: { harsh: loud.h.chimes.length, nishtha: loud.n.chimes.length }, pushes: loudPush },
      quiet: {
        window: `${from}–${to} Asia/Kolkata`,
        stored: { harsh: storedH.length, nishtha: storedN.length },
        cards: { harsh: cardsH.length, nishtha: cardsN.length },
        chimes: { harsh: h.chimes.length, nishtha: n.chimes.length },
        repeats: { harsh: repeats.h.map((r) => r.how), nishtha: repeats.n.map((r) => r.how) },
        pushes: push,
        nishthaTitle: storedN[0].title,
      },
      history: { harshPending: pendingRow(pendingRows.h), nishthaAcked: ackedRow(ackedRows.n), harshAckNotice: ackedRows.h.find((r) => /Nishtha acknowledged/.test(r)) },
      ackMs: { nishtha: ackN.goneMs, harsh: ackH.goneMs },
      shots: [muteShot, quietShot, ...cardShots, ...historyShots, ...historyAckShots],
    };
  });

  // ---------------------------------------------------------------- UC-X
  await useCase('UC-X', 'Overlapping fences arrive both; a fence with two notes is one card listing both', async () => {
    // ---- a food court inside a mall
    const M = AREA.mall;
    const mall = await fence({ name: 'Forum Mall', shape: 'polygon', polygon: box(M, 300, 300), triggers: ['arrive'] }, [{ text: 'buy a phone charger', trigger: 'arrive' }]);
    const court = await fence({ name: 'Food Court', shape: 'circle', center: offset(M, 40, 30), radiusM: 40, triggers: ['arrive'] }, [{ text: 'grab lunch', trigger: 'arrive' }]);
    await centreOn(harsh, M, 15.5);
    let t = await mark();
    await phone.pub(offset(M, -400, 30), { speed: 1 });
    await sleep(1200);
    await phone.pub(offset(M, 40, 30), { speed: 0 });
    await sleep(3500);
    const sm = await seen(harsh, t.h, mall.place.id, 'Forum Mall');
    const sc = await seen(harsh, t.h, court.place.id, 'Food Court');
    check(sm.geo.length === 1 && sc.geo.length === 1, `arrivals: mall ${sm.geo.length}, food court ${sc.geo.length}`);
    const both = [...(await reminders(harsh, mall.place.id, 'pending')), ...(await reminders(harsh, court.place.id, 'pending'))];
    check(both.length === 2, `pending: ${both.length}`);
    const overlapCards = await cards(harsh);
    check(overlapCards.length === 2, `cards: ${JSON.stringify(overlapCards)}`);
    const allChimes = chimes(since((await harsh.record()).notes, t.h));
    const overlapShot = await harsh.shot(SHOTS, 'UCX-overlap-folded');
    await harsh.page.getByRole('button', { name: /^Show \d+ more pending reminders$/ }).first().click();
    await sleep(400);
    const overlapOpenShot = await harsh.shot(SHOTS, 'UCX-overlap-unfolded');
    await harsh.page.getByRole('button', { name: 'Fold pending reminders' }).first().click();
    for (const r of both) await acknowledge(harsh, r);
    check((await noteById(mall.notes[0].id)).done && (await noteById(court.notes[0].id)).done, 'an overlapping fence’s note is not done');
    await park();

    // ---- one fence, two notes
    const P = AREA.pharmacy;
    const ph = await fence({ name: 'Pharmacy', shape: 'circle', center: P, radiusM: 50, triggers: ['arrive'] }, [
      { text: 'buy aspirin', trigger: 'arrive' },
      { text: 'pick up the prescription', trigger: 'arrive' },
    ]);
    await centreOn(harsh, P, 16);
    t = await mark();
    await phone.pub(offset(P, -300, 0), { speed: 1 });
    await sleep(1200);
    await phone.pub(P, { speed: 0 });
    await sleep(3500);
    const sp = await seen(harsh, t.h, ph.place.id, 'Pharmacy');
    const stored = await reminders(harsh, ph.place.id);
    check(sp.geo.length === 1 && sp.notify.length === 1, `pharmacy: ${sp.geo.length} events, ${sp.notify.length} reminder frames`);
    check(stored.length === 1 && stored[0].noteIds.length === 2, `stored: ${JSON.stringify(stored.map((r) => r.noteIds))}`);
    const card = await cards(harsh);
    check(card.length === 1 && card[0].text.includes('buy aspirin') && card[0].text.includes('pick up the prescription'), `card: ${JSON.stringify(card)}`);
    check(sp.notices.length === 1 && sp.chimes.length === 1, `notices ${sp.notices}, chimes ${sp.chimes.length}`);
    await sleep(400);
    const twoShot = await harsh.shot(SHOTS, 'UCX-two-notes-card');
    await acknowledge(harsh, stored[0]);
    const done = [await noteById(ph.notes[0].id), await noteById(ph.notes[1].id)];
    check(done.every((x) => x.done), `notes after one acknowledgement: ${JSON.stringify(done.map((x) => x.done))}`);
    const rows = await historyRows(harsh);
    const row = rows.find((r) => r.includes('Pharmacy') && r.includes('buy aspirin'));
    check(row && row.includes('pick up the prescription') && !row.includes('•'), `History row for two notes: ${JSON.stringify(row)}`);
    const ackRow = rows.find((r) => /\d\d:\d\d Acknowledged buy aspirin/.test(r));
    check(ackRow && ackRow.includes('pick up the prescription') && !ackRow.includes('•'), `History's acknowledgement row for two notes: ${JSON.stringify(ackRow)}`);
    const historyShot = await harsh.shot(SHOTS, 'UCX-two-notes-history');
    await harsh.nav('Live map');
    await park();
    return {
      overlap: { events: [...sm.geo, ...sc.geo].map((f) => `${f.data.trigger}@${f.data.placeName}`), cards: overlapCards.map((c) => c.label), chimes: allChimes.map((c) => `${c.kind}×${c.notes}`) },
      twoNotes: { reminders: stored.length, noteIds: stored[0].noteIds.length, body: stored[0].body, card: card[0].text.replace(/\s+/g, ' '), notesDone: done.length, historyRow: row, ackRow },
      shots: [overlapShot, overlapOpenShot, twoShot, historyShot],
    };
  });

  // ---------------------------------------------------------------- Z
  await useCase('Z', 'No page errors, console errors or failed requests in either browser', async () => {
    const report = {};
    for (const p of people) {
      const bad = p.badResponses.filter((r) => !/\/favicon\.ico$/.test(r.url));
      report[p.name] = { errors: p.errors, badResponses: bad };
    }
    const problems = people.flatMap((p) => [...report[p.name].errors, ...report[p.name].badResponses]);
    check(problems.length === 0, `problems: ${JSON.stringify(report, null, 1)}`);
    return report;
  });
} catch {
  // The setup failed; everything else was skipped.
} finally {
  await phone?.halt();
  await sink.close();
  const pass = results.length > 0 && results.every((r) => r.pass);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, results }, null, 2));
  process.stdout.write(`\n${pass ? 'ALL TRIGGER USE CASES PASSED' : 'FAILED'} — ${OUT}/results.json\n`);
  for (const p of people) await p.close().catch(() => {});
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
