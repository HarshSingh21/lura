// The commute use case (release spec §6 and §7), end to end: Harsh drives from
// Home to the Office, past the Grocery fence where his note "buy milk" waits.
// The reminder it raises must keep asking for attention until he presses
// Acknowledge — across a reload, a second tab, a second device, a tab behind
// another window, signing out and back in, and a server restart — and History
// must tell the morning as it happened.
//
//   C1  The drive: left Home, passed Grocery, arrived at Office. Exactly one
//       reminder for "buy milk": one frame, one stored row, one sticky card,
//       one first chime, then a repeat every interval; the card never times out.
//   C2  Reload: the same card comes back from the server, once, and repeats.
//   C3  A second tab and a second device (his phone's browser, 390×844, touch):
//       the same one card on each.
//   C4  A tab behind another window: no sound from it, a system notification
//       that stays until dealt with (requireInteraction), re-raised under the
//       reminder's tag; in front again, it chimes.
//   C5  Signing out and back in on the phone: no card while signed out (and
//       the other sessions keep theirs); the card is back after signing in.
//   C6  A server restart: every session reconnects and still holds exactly the
//       one card; the database row is still pending.
//   C7  Acknowledge on the phone: its card goes; both desktop tabs clear within
//       a second; the reminder is acknowledged and "buy milk" is done; nothing
//       chimes again.
//   C8  It stays acknowledged: no card after a reload, a new sign-in or another
//       restart; the database row says acknowledged, by Harsh.
//   C9  History, on the desktop and on the phone, oldest first: Left Home,
//       Passed Grocery — reminder buy milk (acknowledged hh:mm), Arrived at
//       Office, Acknowledged buy milk (he acknowledges after arriving here);
//       tapping the Grocery row shows it on the map.
//   Z   No page errors, console errors or failed requests outside the restarts.
//
// Harsh's phone is a device the suite registers and drives with /pub; his two
// browsers only read. Needs E2E_STORE=postgres (a restart must keep the data):
//
//   E2E_SUITE=uc-commute E2E_STORE=postgres E2E_PORT=8092 caffeinate -ims e2e/run.sh

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { CHROME, Person, chimes, sleep, waitFor } from './lib/browser.mjs';
import { haversineM } from './lib/geo.mjs';
import { box, offset } from './lib/phone.mjs';
import { cardLog, chimeLog, clock, desktopShown, pendingCards, psql, reminderHooks, setHidden, signInAgain, signOut } from './lib/reminders.mjs';
import { canKeepData, duringRestart, restartServer, restarts } from './lib/server.mjs';
import { PHONE, TouchPerson } from './lib/touch.mjs';
import { drive, pub } from './lib/wire.mjs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:8092';
const API = process.env.E2E_API ?? BASE;
process.env.E2E_API = API;
const OUT = process.env.E2E_OUT ?? '/tmp/lura-uc-commute';
const SHOTS = `${OUT}/shots`;
mkdirSync(SHOTS, { recursive: true });
const TZ = 'Asia/Kolkata';

/** How often a pending reminder rings again here (the product's default is a minute). */
const EVERY_MS = 4000;
/** The server's arrive rule: slow (≤ 1.5 m/s) inside for the 45 s debounce. */
const ARRIVE_WAIT_MS = 75_000;

// ------------------------------------------------------------------ geography
// Indiranagar, Bengaluru: Home in the south-west, the Office 1.3 km north-east,
// the Grocery on the road between them.
const HOME = { lat: 12.9700, lon: 77.6380 };
const OFFICE = offset(HOME, 900, 900);
const GROCERY = offset(HOME, 450, 450);
// The browsers' own location, far from every fence (they do not publish).
const DESK = offset(HOME, -3000, -3000);

// ------------------------------------------------------------------ people
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADED !== '1',
  args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const who = { name: 'Harsh', email: 'harsh@lura.local', password: 'lura-harsh', start: DESK };
/** Harsh at his desk: tab A, and later tab B in the same browser. */
const desk = new Person(who);
/** Harsh's phone's browser: another device, another session. */
const mobile = new TouchPerson({ ...who, name: 'Harsh-phone' });
const sessions = [desk, mobile];
/** Tab B, opened in C3: a Person-shaped view onto the second tab of desk's browser. */
let tabB;
let device;
const ids = {};

const results = [];
function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function useCase(id, title, fn) {
  const started = Date.now();
  process.stdout.write(`\n[${id}] ${title}\n`);
  try {
    const evidence = await fn();
    results.push({ id, title, pass: true, ms: Date.now() - started, evidence });
    process.stdout.write(`  PASS ${JSON.stringify(evidence)}\n`);
  } catch (err) {
    results.push({ id, title, pass: false, ms: Date.now() - started, error: String(err?.stack ?? err) });
    process.stdout.write(`  FAIL ${err?.stack ?? err}\n`);
    for (const p of pages()) await p.shot(SHOTS, `fail-${id}`).catch(() => {});
    if (id === 'setup' || id === 'C1') throw err;
  }
}

/** pages is every open view of Harsh's: tab A, tab B (once opened) and the phone. */
function pages() {
  return [desk, ...(tabB ? [tabB] : []), mobile].filter((p) => p.page && !p.page.isClosed());
}

// ------------------------------------------------------------------ observing
const wallNow = () => Date.now();

/** frames is what a page's socket carried since `wall` (Date.now()), optionally of one type. */
async function frames(p, wall, type) {
  const rec = await p.record();
  return (rec?.frames ?? []).filter((f) => f.wall >= wall && (!type || f.type === type));
}

async function serverPending() {
  const { reminders } = await desk.api('GET', '/api/v1/reminders?status=pending&limit=50');
  return reminders ?? [];
}

async function serverReminder(id) {
  const { reminders } = await desk.api('GET', '/api/v1/reminders?status=all&limit=100');
  return (reminders ?? []).find((r) => r.id === id);
}

/** oneCard waits for a page to show exactly the one pending card, for `reminderId`'s crossing. */
async function oneCard(p, what, timeout = 20000) {
  return waitFor(`${p.name}: ${what}`, async () => {
    const list = await pendingCards(p.page);
    return list.length === 1 && /buy milk/.test(list[0].text) ? list[0] : null;
  }, { timeout, every: 250 });
}

async function noCard(p, what, timeout = 15000) {
  await waitFor(`${p.name}: ${what}`, async () => (await pendingCards(p.page)).length === 0, { timeout, every: 250 });
}

/** repeats is the app's repeat log for one reminder since `wall`. */
async function repeats(p, reminderId, wall) {
  return (await chimeLog(p.page)).filter((c) => c.id === reminderId && c.at >= wall);
}

/** reconnected waits for a page's socket to say hello after `wall`. */
async function reconnected(p, wall, timeout = 40000) {
  await waitFor(`${p.name}'s socket to reconnect`, async () => (await frames(p, wall, 'hello')).length > 0, { timeout, every: 250 });
  await waitFor(`${p.name}'s live banner to clear`, async () => (await p.page.getByTestId('lura-live-banner').count()) === 0, { timeout: 20000, every: 250 });
}

async function dbRow(id) {
  const rows = await psql(`SELECT status, coalesce(to_char(acked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), ''), acked_by, user_id FROM reminders WHERE id = '${id.replace(/'/g, '')}'`);
  return rows[0] ? { status: rows[0][0], ackedAt: rows[0][1], ackedBy: rows[0][2], userId: rows[0][3] } : null;
}

/** openTab opens a page in an existing browser context, instrumented like the first. */
async function openTab(owner, name) {
  const page = await owner.ctx.newPage();
  const view = Object.create(Object.getPrototypeOf(owner));
  Object.assign(view, owner, { name, page, errors: owner.errors, badResponses: owner.badResponses, tiles: owner.tiles });
  view.watch(page);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 30000 });
  return view;
}

/** historyRows opens History by address and returns the timeline rows' labels, oldest first. */
async function historyRows(p, until) {
  await p.page.goto(`${BASE}/history`, { waitUntil: 'domcontentloaded' });
  let rows = [];
  await waitFor(`${p.name}'s History`, async () => {
    rows = await p.page.evaluate(() =>
      [...document.querySelectorAll('[role="button"][aria-label$="Show on the map."]')]
        .filter((el) => !el.closest('[role="alert"]') && !el.closest('[aria-modal="true"]'))
        .map((el) => el.getAttribute('aria-label'))
        .filter((l) => /^\d\d:\d\d /.test(l)),
    );
    return until(rows);
  }, { timeout: 30000, every: 500 });
  await waitFor('the basemap to finish loading', async () => Date.now() - (p.tiles.at(-1)?.at ?? 0) > 900, { timeout: 15000, every: 150 }).catch(() => {});
  return rows;
}

// ======================================================================
let reminder;
try {
  await useCase('setup', 'Harsh signs in at his desk and on his phone; Home, Grocery and Office; "buy milk"', async () => {
    check(canKeepData(), 'uc-commute needs E2E_STORE=postgres (it restarts the server and expects the reminder to survive)');
    await desk.open(browser, BASE);
    await mobile.open(browser, BASE, PHONE);
    for (const p of sessions) await p.ctx.addInitScript(reminderHooks(EVERY_MS));
    await desk.signIn();
    await mobile.signIn();
    const iat = JSON.parse(Buffer.from((await desk.token()).split('.')[1], 'base64url').toString()).iat * 1000;
    check(Math.abs(Date.now() - iat) < 30_000, `Keycloak's clock is ${Math.round((Date.now() - iat) / 1000)} s off this machine's: fix the Docker clock first`);
    const { user } = await desk.api('GET', '/api/v1/me');
    ids.harsh = user.id;
    await desk.api('PATCH', '/api/v1/me', { quietFrom: '', quietTo: '', tz: TZ });
    const created = await desk.api('POST', '/api/v1/devices', { name: 'Harsh’s phone', kind: 'phone' });
    device = { id: created.device.id, token: created.pubToken };
    const home = (await desk.api('POST', '/api/v1/places', { name: 'Home', shape: 'circle', center: HOME, radiusM: 120, triggers: ['leave'] })).place;
    const grocery = (await desk.api('POST', '/api/v1/places', { name: 'Grocery', shape: 'polygon', polygon: box(GROCERY, 140, 100), triggers: ['passby'] })).place;
    const office = (await desk.api('POST', '/api/v1/places', { name: 'Office', shape: 'circle', center: OFFICE, radiusM: 120, triggers: ['arrive'] })).place;
    const { note } = await desk.api('POST', '/api/v1/notes', { placeId: grocery.id, text: 'buy milk', trigger: 'passby', watchUserId: '', notifyUserIds: [] });
    Object.assign(ids, { home: home.id, grocery: grocery.id, office: office.id, note: note.id, device: device.id });
    check((await serverPending()).length === 0, 'Harsh starts with reminders already pending');
    // The places only reach an open map with the next overview: reload both.
    for (const p of sessions) {
      await p.page.reload({ waitUntil: 'domcontentloaded' });
      await p.page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 30000 });
    }
    // A gesture so Web Audio may start, as a person's first click would.
    await desk.page.mouse.click(5, 450);
    await mobile.page.touchscreen.tap(195, 300).catch(() => {});
    return ids;
  });

  await useCase('C1', 'The drive: left Home, passed Grocery, arrived at Office; one reminder that keeps asking', async () => {
    // Parked at home for a few fixes, so leaving it is a real leave.
    for (let i = 0; i < 3; i += 1) {
      await pub(device, HOME, { speedMps: 0 });
      await sleep(1000);
    }
    const t0 = wallNow();
    const tPage = await desk.page.evaluate(() => performance.now());
    const posts = await drive(device, HOME, OFFICE, { mps: 15, periodMs: 1000 });
    // Standing at the desk: slow fixes inside the Office until the arrive is confirmed.
    let arrive;
    const standStart = wallNow();
    while (!arrive && wallNow() - standStart < ARRIVE_WAIT_MS) {
      await pub(device, offset(OFFICE, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6), { speedMps: 0.2 });
      await sleep(2000);
      arrive = (await frames(desk, t0, 'geo')).find((f) => f.data.placeId === ids.office && f.data.trigger === 'arrive');
    }
    const geo = await frames(desk, t0, 'geo');
    const said = geo.map((f) => `${f.data.trigger}@${f.data.placeName}`);
    check(said.filter((s) => s === 'leave@Home').length === 1, `leaving Home: ${said}`);
    check(said.filter((s) => s === 'passby@Grocery').length === 1, `passing Grocery: ${said}`);
    check(said.filter((s) => s === 'arrive@Office').length === 1, `arriving at Office: ${said}`);
    check(said.length === 3, `crossings: ${said}`);
    const notify = (await frames(desk, t0, 'notify')).filter((f) => f.data.placeId === ids.grocery);
    check(notify.length === 1, `${notify.length} reminder frames for Grocery`);
    const pending = await serverPending();
    check(pending.length === 1 && pending[0].placeId === ids.grocery && pending[0].noteIds[0] === ids.note, `pending on the server: ${JSON.stringify(pending)}`);
    reminder = pending[0];
    check(reminder.body === 'buy milk' && reminder.status === 'pending', `the reminder: ${JSON.stringify(reminder)}`);
    const card = await oneCard(desk, 'the buy milk card');
    // One first chime, the pass-by's; then the repeats.
    const firstChimes = chimes((await desk.record()).notes.filter((n) => n.t >= tPage));
    const grocery = posts.find((r) => haversineM(r.point, GROCERY) < 60);
    check(firstChimes.length >= 1 && firstChimes.some((c) => c.kind === 'passby'), `chimes after the crossing: ${JSON.stringify(firstChimes)}`);
    // Still there a while later — a sticky card has no timer — and repeating.
    const tRepeat = wallNow();
    await sleep(EVERY_MS * 3 + 1500);
    const rep = await repeats(desk, reminder.id, tRepeat);
    check((await pendingCards(desk.page)).length === 1, 'the card went away on its own');
    check(rep.length >= 2 && rep.every((r) => r.how === 'sound'), `repeats in ${EVERY_MS * 3 + 1500} ms: ${JSON.stringify(rep)}`);
    const gaps = rep.slice(1).map((r, i) => r.at - rep[i].at);
    check(gaps.every((g) => g >= EVERY_MS - 1200), `repeats closer than the interval: ${gaps}`);
    // The phone's session saw the same reminder.
    await oneCard(mobile, 'the buy milk card on the phone');
    const shots = [await desk.shot(SHOTS, 'C1-card'), await mobile.shot(SHOTS, 'C1-card')];
    return {
      crossings: said,
      fixes: posts.length,
      passbyAtS: grocery ? Math.round((grocery.t1 - t0) / 1000) : null,
      arriveAfterStandS: arrive ? Math.round((arrive.wall - standStart) / 1000) : null,
      reminder: { id: reminder.id, title: reminder.title, body: reminder.body },
      card: card.label,
      firstChimes: firstChimes.map((c) => c.kind),
      repeats: rep.length,
      repeatGapsMs: gaps,
      shots,
    };
  });

  await useCase('C2', 'Reload: the same card comes back from the server, once, and keeps repeating', async () => {
    const t0 = wallNow();
    await desk.page.reload({ waitUntil: 'domcontentloaded' });
    await desk.page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 30000 });
    const card = await oneCard(desk, 'the card after a reload');
    const pendingReads = desk.badResponses.filter((r) => r.at >= t0 && /\/reminders/.test(r.url));
    check(pendingReads.length === 0, `reading the pending list failed: ${JSON.stringify(pendingReads)}`);
    // Not re-announced as a new crossing: no notify frame, one notice.
    check((await frames(desk, t0, 'notify')).length === 0, 'a reload replayed the reminder frame');
    const rec = await desk.record();
    const notices = new Set(rec.toasts.filter((x) => x.notice).map((x) => x.notice));
    check(notices.size <= 1, `the reload showed ${notices.size} notices: ${[...notices]}`);
    const tRep = wallNow();
    await sleep(EVERY_MS * 2 + 1500);
    const rep = await repeats(desk, reminder.id, tRep);
    check(rep.length >= 1 && rep.every((r) => r.how === 'sound'), `repeats after the reload: ${JSON.stringify(rep)}`);
    check((await pendingCards(desk.page)).length === 1, 'more than one card after the reload');
    return { card: card.label, repeats: rep.length, shot: await desk.shot(SHOTS, 'C2-after-reload') };
  });

  await useCase('C3', 'A second tab and a second device show the same one card', async () => {
    tabB = await openTab(desk, 'Harsh-tabB');
    const b = await oneCard(tabB, 'the card in a second tab');
    const a = await oneCard(desk, 'the card in the first tab');
    const m = await oneCard(mobile, 'the card on the phone');
    check(a.notice === b.notice && b.notice === m.notice, `three sessions, different notices: ${[a.notice, b.notice, m.notice]}`);
    // On the phone the card must sit clear of the tab bar and inside the screen.
    const tabs = await mobile.page.evaluate(() => {
      const bar = [...document.querySelectorAll('[role="tablist"], [role="tab"]')].map((el) => el.getBoundingClientRect());
      return bar.length ? Math.min(...bar.map((r) => r.top)) : null;
    });
    check(m.box.x >= 0 && m.box.x + m.box.w <= PHONE.width, `the phone's card is off screen: ${JSON.stringify(m.box)}`);
    if (tabs !== null) check(m.box.y + m.box.h <= tabs + 1, `the phone's card runs under the tab bar (${JSON.stringify(m.box)}, tabs at ${tabs})`);
    // Nor over the map's credit, which the tiles' licence says must stay readable.
    const credit = await mobile.page.evaluate(() => {
      const el = document.querySelector('[data-testid="lura-map-credit"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    check(!credit || !overlaps(m.box, credit), `the phone's card covers the map credit (${JSON.stringify(m.box)} over ${JSON.stringify(credit)})`);
    return { notice: a.notice, phoneCard: m.box, credit, shots: [await tabB.shot(SHOTS, 'C3-tab-b'), await mobile.shot(SHOTS, 'C3-phone')] };
  });

  await useCase('C4', 'A tab behind another window: silent, a system notification that stays; in front, it rings again', async () => {
    const t0 = wallNow();
    // Counted from when the page took the change, not from before asking it:
    // a repeat in between was the visible tab's, and rang as it should.
    const hiddenAt = await setHidden(tabB.page, true);
    await sleep(EVERY_MS * 2 + 1500);
    const rep = await repeats(tabB, reminder.id, hiddenAt);
    const shown = (await desktopShown(tabB.page)).filter((d) => d.wall >= hiddenAt);
    check(rep.length >= 1 && rep.every((r) => r.how === 'desktop'), `the hidden tab's repeats: ${JSON.stringify(rep)}`);
    check(shown.length >= 1, 'the hidden tab raised no system notification');
    check(shown.every((d) => d.requireInteraction && d.tag === `reminder:${reminder.id}`), `system notifications: ${JSON.stringify(shown)}`);
    check(shown.every((d) => /buy milk|Grocery/.test(`${d.title} ${d.body}`)), `the system notification does not say what: ${JSON.stringify(shown[0])}`);
    // Tab A, in front, kept ringing meanwhile.
    const front = await repeats(desk, reminder.id, t0);
    check(front.length >= 1 && front.every((r) => r.how === 'sound'), `the visible tab's repeats: ${JSON.stringify(front)}`);
    const t1 = await setHidden(tabB.page, false);
    await sleep(EVERY_MS + 1500);
    const back = await repeats(tabB, reminder.id, t1);
    check(back.length >= 1 && back.every((r) => r.how === 'sound'), `in front again: ${JSON.stringify(back)}`);
    check((await pendingCards(tabB.page)).length === 1, 'the card left the hidden tab');
    return { hiddenRepeats: rep.length, systemNotifications: shown.length, requireInteraction: shown.every((d) => d.requireInteraction), tag: shown[0].tag, title: shown[0].title, body: shown[0].body, frontRepeats: front.length };
  });

  await useCase('C5', 'Signing out and back in on the phone: no card signed out, the card back after', async () => {
    await signOut(mobile);
    await sleep(1000);
    check((await pendingCards(mobile.page)).length === 0, 'a card is showing on the sign-in screen');
    const out = await mobile.shot(SHOTS, 'C5-signed-out');
    // The desktop sessions are not signed out by it.
    check((await pendingCards(desk.page)).length === 1 && (await pendingCards(tabB.page)).length === 1, 'signing out the phone cleared the desktop');
    await signInAgain(mobile);
    const card = await oneCard(mobile, 'the card after signing in again', 30000);
    check((await serverPending()).length === 1, 'signing out changed the pending list');
    return { card: card.label, shots: [out, await mobile.shot(SHOTS, 'C5-signed-in-again')] };
  });

  await useCase('C6', 'A server restart: every session reconnects with exactly the one card; the row is still pending', async () => {
    const before = await dbRow(reminder.id);
    check(before?.status === 'pending', `the row before: ${JSON.stringify(before)}`);
    const r = await restartServer({ downMs: 2000 });
    for (const p of pages()) await reconnected(p, r.stoppedAt);
    for (const p of pages()) await oneCard(p, 'the card after the restart');
    await sleep(EVERY_MS + 1500);
    for (const p of pages()) check((await pendingCards(p.page)).length === 1, `${p.name} has more than one card after the restart`);
    const after = await dbRow(reminder.id);
    check(after?.status === 'pending' && after.userId === ids.harsh, `the row after: ${JSON.stringify(after)}`);
    const pending = await serverPending();
    check(pending.length === 1 && pending[0].id === reminder.id, `pending after the restart: ${JSON.stringify(pending.map((x) => x.id))}`);
    const rep = await repeats(desk, reminder.id, r.readyAt);
    check(rep.length >= 1, 'no repeat after the restart');
    return { downMs: r.readyAt - r.stoppedAt, row: after, repeatsAfter: rep.length, shot: await desk.shot(SHOTS, 'C6-after-restart') };
  });

  let ackAt;
  await useCase('C7', 'Acknowledge on the phone: everywhere clears within a second; the note is done; no more chimes', async () => {
    const t0 = wallNow();
    const button = mobile.page.getByRole('button', { name: /^Acknowledge / });
    await button.first().waitFor({ timeout: 10000 });
    const tapAt = wallNow();
    await mobile.tap(button.first());
    await noCard(mobile, 'the card gone from the phone', 5000);
    const cleared = {};
    for (const p of [desk, tabB]) {
      await noCard(p, 'the card gone after the phone acknowledged', 5000);
      const log = (await cardLog(p.page)).filter((e) => e.wall >= tapAt);
      const zero = log.find((e) => e.n === 0);
      cleared[p.name] = zero ? zero.wall - tapAt : null;
      check(zero && zero.wall - tapAt <= 1000, `${p.name} cleared ${zero ? zero.wall - tapAt : '?'} ms after the tap`);
      const acks = (await frames(p, t0, 'reminder_ack')).filter((f) => f.data?.id === reminder.id);
      check(acks.length >= 1, `${p.name} got no reminder_ack frame`);
    }
    const stored = await waitFor('the server to record the acknowledgement', async () => {
      const x = await serverReminder(reminder.id);
      return x?.status === 'acknowledged' ? x : null;
    }, { timeout: 5000 });
    ackAt = stored.ackedAt;
    const { notes } = await desk.api('GET', '/api/v1/notes');
    const note = notes.find((n) => n.id === ids.note);
    check(note?.done, `"buy milk" is not done: ${JSON.stringify(note)}`);
    check((await serverPending()).length === 0, 'still pending on the server');
    // No more repeats anywhere.
    const tQuiet = wallNow();
    await sleep(EVERY_MS * 2 + 1500);
    for (const p of pages()) {
      const rep = await repeats(p, reminder.id, tQuiet);
      check(rep.length === 0, `${p.name} still chimes after the acknowledgement: ${JSON.stringify(rep)}`);
    }
    return { clearedMs: cleared, ackedAt: stored.ackedAt, ackedBy: stored.ackedBy, noteDone: note.done, shots: [await desk.shot(SHOTS, 'C7-desk-after-ack'), await mobile.shot(SHOTS, 'C7-phone-after-ack')] };
  });

  await useCase('C8', 'It stays acknowledged: reload, signing in again and another restart bring no card back', async () => {
    await desk.page.reload({ waitUntil: 'domcontentloaded' });
    await desk.page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 30000 });
    await sleep(3000);
    check((await pendingCards(desk.page)).length === 0, 'the card came back after a reload');
    await signOut(mobile);
    await signInAgain(mobile);
    await sleep(3000);
    check((await pendingCards(mobile.page)).length === 0, 'the card came back after signing in again');
    const r = await restartServer({ downMs: 1000 });
    for (const p of pages()) await reconnected(p, r.stoppedAt);
    await sleep(3000);
    for (const p of pages()) check((await pendingCards(p.page)).length === 0, `${p.name}: the card came back after the restart`);
    const row = await dbRow(reminder.id);
    check(row?.status === 'acknowledged' && row.ackedBy === ids.harsh && row.ackedAt, `the row: ${JSON.stringify(row)}`);
    return { row };
  });

  await useCase('C9', 'History tells the morning in order, on the desktop and the phone; a row shows its place', async () => {
    // The order things happened in: he acknowledged at his desk, after arriving.
    const want = [/^\d\d:\d\d Left Home/, /^\d\d:\d\d Passed Grocery — reminder buy milk/, /^\d\d:\d\d Arrived at Office/, /^\d\d:\d\d Acknowledged buy milk/];
    const ordered = (rows) => {
      // The day's timeline reads oldest first, as a day is lived.
      const asc = rows;
      let at = 0;
      for (const re of want) {
        const i = asc.findIndex((r, k) => k >= at && re.test(r));
        if (i < 0) return false;
        at = i + 1;
      }
      return true;
    };
    const rows = await historyRows(desk, ordered);
    const passed = rows.find((r) => want[1].test(r));
    check(passed.includes(`acknowledged ${clock(ackAt, TZ)}`), `the Grocery row does not say when it was acknowledged: ${passed}`);
    check(!/pending/i.test(passed), `the Grocery row still says pending: ${passed}`);
    const deskShot = await desk.shot(SHOTS, 'C9-history');
    // Tapping the Grocery row puts it in the middle of the History map.
    await desk.page.getByRole('button', { name: passed, exact: true }).first().click();
    const v = await waitFor('the History map to centre on Grocery', async () => {
      const view = await desk.stableViewport(600);
      return haversineM(view.center, GROCERY) < 150 ? view : null;
    }, { timeout: 15000 });
    const focusShot = await desk.shot(SHOTS, 'C9-history-focused');
    const phoneRows = await historyRows(mobile, ordered);
    // The phone's map band opens on the whole day: both ends of the drive in view.
    const pv = await mobile.stableViewport(600);
    const ends = [];
    for (const [name, at] of [['Home', HOME], ['Office', OFFICE]]) {
      const q = await mobile.px(at, pv);
      ends.push({ name, x: Math.round(q.x - pv.left), y: Math.round(q.y - pv.top) });
    }
    // Clear of the band's edges and of what is printed over it (the day's
    // summary at the top, the credit at the foot), not merely on the canvas.
    const covers = await mobile.page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="lura-map-viewport"]')].filter((n) => n.offsetParent !== null).flatMap((vp) => {
        const m = vp.getBoundingClientRect();
        const wrap = vp.parentElement?.parentElement ?? vp;
        return [...wrap.querySelectorAll('div')]
          .filter((el) => /Today ·|OpenStreetMap|Private history/.test(el.innerText || '') && el.children.length <= 3)
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width < m.width + 1 && r.height < m.height / 2)
          .map((r) => ({ x: r.left - m.left, y: r.top - m.top, w: r.width, h: r.height }));
      }),
    );
    const INSET = 24;
    const hidden = (e) =>
      e.x < INSET || e.y < INSET || e.x > pv.width - INSET || e.y > pv.height - INSET ||
      covers.some((r) => e.x >= r.x && e.x <= r.x + r.w && e.y >= r.y && e.y <= r.y + r.h);
    const out = ends.filter(hidden);
    check(out.length === 0, `the phone's History map cuts off the drive: ${JSON.stringify({ ends, map: { w: pv.width, h: pv.height }, covers })}`);
    const phoneShot = await mobile.shot(SHOTS, 'C9-history-phone');
    // Nothing on the phone's History may run off the side of the screen.
    const wide = await mobile.page.evaluate(() => document.documentElement.scrollWidth);
    check(wide <= PHONE.width, `the phone's History scrolls sideways (${wide} px)`);
    return {
      rows: rows.filter((r) => want.some((re) => re.test(r))).map((r) => r.replace(/\. Show on the map\.$/, '')),
      focusedM: Math.round(haversineM(v.center, GROCERY)),
      phoneRows: phoneRows.length,
      phoneMapEnds: ends,
      shots: [deskShot, focusShot, phoneShot],
    };
  });

  await useCase('Z', 'No page errors, console errors or failed requests outside the restarts', async () => {
    const report = {};
    for (const p of sessions) {
      // The restarts' own outage is expected to show as failed requests and
      // socket errors; anything else is the app's.
      const errors = p.errors.filter((e) => !duringRestart(e.at));
      const bad = p.badResponses.filter((r) => !duringRestart(r.at) && !/\/favicon\.ico$/.test(r.url));
      report[p.name] = { errors, badResponses: bad };
    }
    const problems = sessions.flatMap((p) => [...report[p.name].errors, ...report[p.name].badResponses]);
    check(problems.length === 0, `problems: ${JSON.stringify(report, null, 1)}`);
    return { restarts: restarts.length, ...report };
  });
} catch {
  // setup or C1 failed: the rest depends on them.
} finally {
  const pass = results.length > 0 && results.every((r) => r.pass);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, results }, null, 2));
  process.stdout.write(`\n${pass ? 'ALL COMMUTE USE CASES PASSED' : 'FAILED'} — ${OUT}/results.json\n`);
  for (const p of sessions) await p.close().catch(() => {});
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
