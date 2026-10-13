// Helpers for suites that follow a reminder from the crossing that fires it to
// the Acknowledge that ends it (release spec §6): the page hooks that make its
// repeats observable, the sticky cards as a person sees them, a tab that is
// behind another window, signing out and in again, and the database row.

import { execFile } from 'node:child_process';

import { sleep, waitFor } from './browser.mjs';

/**
 * reminderHooks is an init script (context.addInitScript) for every page of a
 * person whose reminders the suite follows:
 *
 *   - window.__luraRemindEveryMs makes a pending reminder repeat every
 *     `everyMs` instead of every minute (useReminders reads it on every tick);
 *   - window.__luraChimeLog = [] turns on the app's own trace of each repeat
 *     ({id, how: sound|desktop|muted|quiet, at});
 *   - window.Notification is wrapped so every system notification the page
 *     raises is recorded with the options it asked for in window.__luraDesktop;
 *   - window.__ucHidden(true|false) makes the page report itself behind another
 *     window (document.hidden, visibilityState, a visibilitychange event), as a
 *     background tab does; headless Chrome never hides a page on its own;
 *   - window.__ucCards() counts the pending cards on screen, and
 *     window.__ucCardLog records each change of that count with the wall clock,
 *     so "cleared within a second" is measured in the page, not by polling.
 *
 * Nothing changes behaviour: the notification is still raised.
 */
export function reminderHooks(everyMs) {
  return `(() => {
    window.__luraRemindEveryMs = ${Number(everyMs)};
    window.__luraChimeLog = [];
    const shown = (window.__luraDesktop = []);
    const Native = window.Notification;
    if (Native) {
      class Recorded extends Native {
        constructor(title, options) {
          super(title, options);
          shown.push({
            wall: Date.now(), title, body: (options && options.body) || '',
            tag: (options && options.tag) || '', requireInteraction: !!(options && options.requireInteraction),
            renotify: !!(options && options.renotify), silent: !!(options && options.silent),
          });
        }
      }
      Object.defineProperty(Recorded, 'permission', { get: () => Native.permission });
      Recorded.requestPermission = Native.requestPermission.bind(Native);
      window.Notification = Recorded;
    }
    let hidden = false;
    const proto = Document.prototype;
    const nativeHidden = Object.getOwnPropertyDescriptor(proto, 'hidden');
    const nativeState = Object.getOwnPropertyDescriptor(proto, 'visibilityState');
    Object.defineProperty(proto, 'hidden', { configurable: true, get() { return hidden || nativeHidden.get.call(this); } });
    Object.defineProperty(proto, 'visibilityState', { configurable: true, get() { return hidden ? 'hidden' : nativeState.get.call(this); } });
    window.__ucHidden = (h) => { hidden = !!h; document.dispatchEvent(new Event('visibilitychange')); return Date.now(); };
    const count = () => document.querySelectorAll('[role="alert"][aria-label$="Waiting for acknowledgement."]').length;
    window.__ucCards = count;
    const log = (window.__ucCardLog = []);
    let last = -1;
    const note = () => { const n = count(); if (n !== last) { last = n; log.push({ wall: Date.now(), n }); } };
    const start = () => new MutationObserver(note).observe(document.documentElement, { subtree: true, childList: true });
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  })();`;
}

/** pendingCards lists the sticky reminder cards on screen (unfolding the stack to read them all). */
export async function pendingCards(page) {
  const more = page.getByRole('button', { name: /^Show \d+ more pending reminders$/ });
  const folded = (await more.count()) > 0;
  if (folded) {
    await more.first().click();
    await sleep(300);
  }
  const list = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"][aria-label$="Waiting for acknowledgement."]')].map((el) => {
      const notice = el.querySelector('[data-testid^="lura-notice-"]');
      const r = el.getBoundingClientRect();
      return {
        label: el.getAttribute('aria-label'),
        text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
        notice: notice ? notice.getAttribute('data-testid').slice('lura-notice-'.length) : '',
        box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      };
    }),
  );
  if (folded) await page.getByRole('button', { name: 'Fold pending reminders' }).first().click().catch(() => {});
  return list;
}

/** chimeLog is the app's trace of a page's reminder repeats (reminderHooks). */
export function chimeLog(page) {
  return page.evaluate(() => (window.__luraChimeLog ?? []).slice());
}

/** desktopShown is every system notification the page raised (reminderHooks). */
export function desktopShown(page) {
  return page.evaluate(() => (window.__luraDesktop ?? []).slice());
}

/**
 * setHidden makes a page report itself behind another window, or in front
 * again, and returns the page's clock (Date.now()) at the moment it took
 * effect: a repeat logged before then belongs to the old state.
 */
export function setHidden(page, hidden) {
  return page.evaluate((h) => window.__ucHidden(h), hidden);
}

/** cardLog is each change in a page's count of pending cards, with the wall clock (reminderHooks). */
export function cardLog(page) {
  return page.evaluate(() => (window.__ucCardLog ?? []).slice());
}

/**
 * signOut presses Sign out in Settings (reached by address, which works on any
 * layout) and waits for the sign-in screen.
 */
export async function signOut(person) {
  const page = person.page;
  await page.goto(`${person.base}/settings`, { waitUntil: 'domcontentloaded' });
  const button = page.getByRole('button', { name: 'Sign out', exact: true });
  await button.waitFor({ timeout: 20000 });
  await button.click();
  await page.getByText('Continue with email', { exact: true }).waitFor({ timeout: 20000 });
}

/**
 * signInAgain goes back through Keycloak, which may remember the browser and
 * skip its form, and waits for the signed-in app.
 */
export async function signInAgain(person) {
  const { page, ctx } = person;
  const popup = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await page.getByText('Continue with email', { exact: true }).click();
  const signedIn = async () => {
    if (page.url().includes('/onboarding')) {
      await page.getByLabel('Skip the introduction').click().catch(() => {});
      return false;
    }
    return (await page.getByRole('button', { name: 'Draw' }).count()) > 0;
  };
  const form = async (p) => {
    if (!p || p.isClosed()) return false;
    const field = p.locator('input[name="username"]');
    if (!(await field.count())) return false;
    await p.fill('input[name="username"]', person.email);
    await p.fill('input[name="password"]', person.password);
    await p.press('input[name="password"]', 'Enter');
    return true;
  };
  let filled = false;
  const kc = await Promise.race([popup, sleep(4000).then(() => null)]);
  if (kc) person.watch(kc);
  await waitFor(`${person.name} signed in again`, async () => {
    if (!filled) filled = (await form(kc).catch(() => false)) || (await form(page).catch(() => false));
    return signedIn();
  }, { timeout: 45000, every: 300 });
}

/** psql runs one query in this run's PostGIS container and returns its rows as arrays. */
export function psql(sql) {
  const container = process.env.E2E_PG_CONTAINER ?? `lura-e2e-pg-${process.env.E2E_PORT ?? 8080}`;
  const db = process.env.E2E_PG_DB ?? `lura_${process.env.E2E_PHASE ?? process.env.E2E_PROVIDER ?? 'maplibre'}`;
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', container, 'psql', '-U', 'lura', '-d', db, '-tA', '-F', '\t', '-c', sql], (err, stdout, stderr) => {
      if (err) reject(new Error(`psql: ${stderr || err.message}`));
      else resolve(stdout.split('\n').filter(Boolean).map((line) => line.split('\t')));
    });
  });
}

/** clock is "08:52" for an instant in an IANA zone, as History prints it. */
export function clock(iso, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
