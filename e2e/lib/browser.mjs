// Browser plumbing for the scenario: sign-in, per-person instrumentation, the
// map's viewport, and the few gestures that need raw mouse events.

import { INSTRUMENT } from './instrument.mjs';
import { project, unproject } from './geo.mjs';

export const CHROME = process.env.E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** waitFor polls fn until it returns something truthy, or fails with what it last saw. */
export async function waitFor(what, fn, { timeout = 15000, every = 200 } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out after ${timeout} ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
    }
    await sleep(every);
  }
}

/**
 * Person is one human in the scenario: a browser context of their own (their
 * own storage, their own geolocation), the app's page, and everything that page
 * did wrong.
 */
export class Person {
  constructor({ name, email, password, start }) {
    Object.assign(this, { name, email, password, start });
    this.errors = [];
    this.badResponses = [];
    this.tiles = [];
  }

  async open(browser, base) {
    this.base = base;
    this.ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      geolocation: { latitude: this.start.lat, longitude: this.start.lon, accuracy: 6 },
      permissions: ['geolocation', 'notifications'],
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    await this.ctx.addInitScript(INSTRUMENT);
    this.page = await this.ctx.newPage();
    this.watch(this.page);
  }

  watch(page) {
    page.on('pageerror', (err) => this.errors.push({ kind: 'pageerror', text: err.message }));
    page.on('console', (msg) => {
      if (msg.type() === 'error') this.errors.push({ kind: 'console', text: msg.text(), url: msg.location()?.url });
    });
    page.on('response', (res) => {
      const url = res.url();
      const status = res.status();
      if (/\/(\d+)\/(\d+)\/(\d+)(\.\w+)?(\?|$)|tile|MapServer/i.test(url) && res.request().resourceType() !== 'document') {
        this.tiles.push({ at: Date.now(), url, status });
      }
      if (status >= 400) this.badResponses.push({ url, status, method: res.request().method() });
    });
  }

  /** signIn goes through Keycloak's own page and skips the introduction. */
  async signIn() {
    const page = this.page;
    await page.goto(this.base, { waitUntil: 'domcontentloaded' });
    const popup = this.ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await page.getByText('Continue with email', { exact: true }).click();
    const kc = (await popup) ?? page;
    if (kc !== page) this.watch(kc);
    await kc.waitForSelector('input[name="username"]', { timeout: 20000 });
    await kc.fill('input[name="username"]', this.email);
    await kc.fill('input[name="password"]', this.password);
    await kc.click('[type=submit]');
    await waitFor('the app after sign-in', async () => {
      const url = page.url();
      if (url.includes('/onboarding')) return true;
      return (await page.getByRole('button', { name: 'Draw' }).count()) > 0;
    }, { timeout: 30000 });
    if (page.url().includes('/onboarding')) {
      await page.getByLabel('Skip the introduction').click();
    }
    await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 20000 });
  }

  async token() {
    return this.page.evaluate(() => localStorage.getItem('lura.session.access'));
  }

  /** api calls the server as this person, with the token the app is holding. */
  async api(method, path, body) {
    const token = await this.token();
    const res = await fetch(`${process.env.E2E_API ?? 'http://localhost:8080'}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.name}: ${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async record() {
    return this.page.evaluate(() => window.__lura);
  }

  /** nav uses the sidebar, so the socket and the notification centre survive. */
  async nav(label) {
    await this.page.getByRole('link', { name: label, exact: true }).first().click();
    await sleep(400);
  }

  async shot(dir, name) {
    const path = `${dir}/${this.name.toLowerCase()}-${name}.png`;
    await this.page.screenshot({ path });
    return path;
  }

  // ------------------------------------------------------------ map

  /** viewport reads the live map's projection from the overlay layer. */
  async viewport() {
    return this.page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="lura-map-viewport"]')].find((n) => n.offsetParent !== null);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const d = el.dataset;
      return {
        center: { lat: +d.lat, lon: +d.lon },
        zoom: +d.zoom,
        width: +d.width,
        height: +d.height,
        left: r.left,
        top: r.top,
      };
    });
  }

  /** stableViewport waits for the camera to stop moving. */
  async stableViewport(quietMs = 700) {
    let prev = null;
    let since = Date.now();
    return waitFor('the map to settle', async () => {
      const v = await this.viewport();
      if (!v || v.width === 0) return null;
      const key = JSON.stringify(v);
      if (key !== prev) {
        prev = key;
        since = Date.now();
        return null;
      }
      return Date.now() - since >= quietMs ? v : null;
    }, { timeout: 20000, every: 100 });
  }

  /** px is a point's page coordinate on the current map. */
  async px(point, view) {
    const v = view ?? (await this.stableViewport());
    const p = project(point, v);
    return { x: v.left + p.x, y: v.top + p.y };
  }

  async ground(x, y, view) {
    const v = view ?? (await this.stableViewport());
    return unproject(x - v.left, y - v.top, v);
  }

  async marker(id) {
    return this.page.evaluate((testId) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, lat: +el.dataset.lat, lon: +el.dataset.lon, label: el.dataset.label };
    }, `lura-marker-${id}`);
  }

  /** drag presses, moves in small steps (as a hand would) and releases. */
  async drag(from, to, { steps = 12, hold = 60 } = {}) {
    const m = this.page.mouse;
    await m.move(from.x, from.y);
    await m.down();
    await sleep(hold);
    for (let i = 1; i <= steps; i += 1) {
      await m.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await sleep(16);
    }
    await m.up();
  }

  async close() {
    await this.ctx?.close();
  }
}

/** chimes groups recorded oscillator notes into chimes (one burst per chime). */
export function chimes(notes) {
  const out = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && n.t - last.end < 40) {
      last.end = n.t;
      last.freqs.push(n.freq);
    } else {
      out.push({ t: n.t, end: n.t, freqs: [n.freq] });
    }
  }
  const KIND = { 1046.5: 'arrive', 784: 'leave', 1318.5: 'passby', 880: 'dwell', 987.8: 'watch' };
  return out.map((c) => ({ t: c.t, kind: KIND[c.freqs[0]] ?? `?${c.freqs[0]}`, notes: c.freqs.length }));
}
