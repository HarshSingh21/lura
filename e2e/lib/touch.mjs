// A person on a phone or a tablet: a touch screen, a small viewport, and the
// layout audit that says whether what the app draws there is usable one-handed.
//
// TouchPerson is lib/browser.mjs's Person with a mobile browser context
// (isMobile, hasTouch) and gestures made of touch events rather than mouse
// events: taps through Playwright's touchscreen, drags and strokes through the
// DevTools protocol's Input.dispatchTouchEvent, which Chrome turns into the
// same touch and pointer events a finger makes.

import { INSTRUMENT } from './instrument.mjs';
import { Person, sleep } from './browser.mjs';

/** The sizes the suites use: an iPhone-class phone and a portrait iPad mini. */
export const PHONE = { width: 390, height: 844 };
export const TABLET = { width: 768, height: 1024 };

/** The smallest tap target a finger hits reliably (Apple HIG and WCAG 2.5.5: 44 × 44 CSS px). */
export const MIN_TARGET = 44;

export class TouchPerson extends Person {
  async open(browser, base, size = PHONE) {
    this.base = base;
    this.ctx = await browser.newContext({
      viewport: size,
      screen: size,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      geolocation: { latitude: this.start.lat, longitude: this.start.lon, accuracy: 6 },
      permissions: ['geolocation', 'notifications'],
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    await this.ctx.addInitScript(INSTRUMENT);
    this.page = await this.ctx.newPage();
    this.watch(this.page);
  }

  /**
   * signIn is Person's, but submits Keycloak's form with the keyboard's Go key:
   * a mobile popup can sit behind the app page, where a click waits forever for
   * the button to become "stable".
   */
  async signIn() {
    const page = this.page;
    await page.goto(this.base, { waitUntil: 'domcontentloaded' });
    const popup = this.ctx.waitForEvent('page', { timeout: 40000 }).catch(() => null);
    await page.getByText('Continue with email', { exact: true }).tap();
    const inPage = page.waitForSelector('input[name="username"]', { timeout: 40000 }).then(() => page).catch(() => null);
    const kc = (await Promise.race([popup, inPage])) ?? (await popup) ?? page;
    if (kc !== page) this.watch(kc);
    await kc.waitForSelector('input[name="username"]', { timeout: 40000 });
    await kc.fill('input[name="username"]', this.email);
    await kc.fill('input[name="password"]', this.password);
    await kc.press('input[name="password"]', 'Enter');
    for (let i = 0; i < 150; i += 1) {
      if (page.url().includes('/onboarding')) break;
      if ((await page.getByRole('button', { name: 'Draw' }).count()) > 0) break;
      await sleep(200);
    }
    if (page.url().includes('/onboarding')) await page.getByLabel('Skip the introduction').tap();
    await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 20000 });
  }

  async cdp() {
    if (!this._cdp) this._cdp = await this.ctx.newCDPSession(this.page);
    return this._cdp;
  }

  /** tap taps the middle of a locator with a finger (Playwright checks it is visible and not covered). */
  async tap(locator, { timeout = 10000 } = {}) {
    await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
    await locator.tap({ timeout });
  }

  /** tapAt taps one point of the page. */
  async tapAt(p) {
    await this.page.touchscreen.tap(Math.round(p.x), Math.round(p.y));
  }

  /** nav taps a bottom tab (the phone and tablet layouts have no sidebar). */
  async nav(label) {
    const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    await this.tap(this.page.getByRole('link', { name }).first());
    await sleep(400);
  }

  /**
   * touchPath puts one finger down on the first point, slides it through the
   * rest (one touchmove per point, `stepMs` apart) and lifts it.
   */
  async touchPath(points, { hold = 80, stepMs = 16 } = {}) {
    const cdp = await this.cdp();
    const at = (p) => [{ x: p.x, y: p.y, id: 1, radiusX: 6, radiusY: 6, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(points[0]) });
    await sleep(hold);
    for (const p of points.slice(1)) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(p) });
      await sleep(stepMs);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** touchDrag slides a finger from one point to another in small steps, as a hand would. */
  async touchDrag(from, to, { steps = 14, hold = 80, stepMs = 16 } = {}) {
    const pts = [from];
    for (let i = 1; i <= steps; i += 1) pts.push({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
    await this.touchPath(pts, { hold, stepMs });
  }

  /** drag is a touch drag here, so helpers written for Person (centreOn) use the finger. */
  async drag(from, to, opts = {}) {
    await this.touchDrag(from, to, opts);
  }

  /** touchDown/touchMoveTo/touchUp split a drag, to look at the screen mid-gesture. */
  async touchDown(p) {
    const cdp = await this.cdp();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 6, radiusY: 6, force: 1 }] });
  }

  async touchMoveTo(p) {
    const cdp = await this.cdp();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 6, radiusY: 6, force: 1 }] });
  }

  async touchUp() {
    const cdp = await this.cdp();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** audit runs the layout audit on what this person's screen shows now. */
  async audit(where, opts = {}) {
    const report = await this.page.evaluate(AUDIT, { minTarget: MIN_TARGET, ...opts });
    return { where: `${this.name}: ${where}`, ...report };
  }
}

/**
 * AUDIT runs in the page. It looks at what the topmost layer shows (the open
 * dialog if there is one, else the page) and reports:
 *
 *   small     interactive controls under minTarget px in either dimension
 *   covered   controls whose middle another element sits on (a tap there would
 *             not reach them)
 *   overlaps  pairs of unrelated controls whose boxes intersect
 *   offscreen text that runs past the left or right edge of the viewport
 *   clipped   text cut off by an ancestor that hides overflow (not a scroller,
 *             not the map, which crops what lies past its edge on purpose)
 *   truncated text shortened with an ellipsis (reported, not an error: some
 *             truncation is by design — the screenshots say whether it reads)
 *   tinyText  text under 11 px
 *   hscroll   the page itself scrolls sideways
 *   keys      for each named key control: present, box, hittable
 *
 * `exempt` is a list of regexes (as strings) for control names that are
 * allowed to be small, each with a reason in the suite; `ignore` leaves
 * controls out altogether (what an open popover covers on purpose).
 */
export const AUDIT = ({ minTarget, exempt = [], keys = [], extraTargets = [], ignore = [] }) => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const exemptRe = exempt.map((s) => new RegExp(s));
  // What of an element can be seen: its box cut by the viewport and by every
  // ancestor that hides or scrolls its overflow (a list scrolled under the tab
  // bar is clipped by its scroller, not covered by the tabs).
  const clip = (el) => {
    const r = el.getBoundingClientRect();
    let l = Math.max(0, r.left), t = Math.max(0, r.top), rt = Math.min(vw, r.right), b = Math.min(vh, r.bottom);
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = n.getBoundingClientRect();
      l = Math.max(l, c.left); t = Math.max(t, c.top); rt = Math.min(rt, c.right); b = Math.min(b, c.bottom);
    }
    return { left: l, top: t, right: rt, bottom: b, width: Math.max(0, rt - l), height: Math.max(0, b - t) };
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const c = clip(el);
    if (c.width < 1 || c.height < 1) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    }
    return true;
  };
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('data-testid') || el.tagName)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 70);
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });

  // The topmost layer: the last open modal dialog, else the whole page.
  const dialogs = [...document.querySelectorAll('[aria-modal="true"]')].filter(visible);
  const scope = dialogs.at(-1) ?? document.body;
  const sel = [
    '[role="button"]', '[role="link"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]',
    '[role="menuitem"]', '[role="tab"]', 'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select',
    ...extraTargets.map((n) => `[aria-label="${n}"]`),
  ].join(',');
  // A backdrop that closes a dialog is the whole screen behind it, not a control.
  const backdrop = (el) => /^Close/.test(el.getAttribute('aria-label') ?? '') && el.getBoundingClientRect().width >= vw * 0.9 && el.getBoundingClientRect().height >= vh * 0.5;
  const ignoreRe = ignore.map((s) => new RegExp(s));
  const controls = [...scope.querySelectorAll(sel)].filter((el) => visible(el) && !backdrop(el) && !ignoreRe.some((re) => re.test(nameOf(el))));

  const hitTest = (el) => {
    const r = clip(el);
    const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!hit || el.contains(hit)) return null;
    const by = hit.closest('[aria-label],[role],[data-testid]');
    return by ? nameOf(by) : hit.tagName;
  };

  const small = [];
  const covered = [];
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    const name = nameOf(el);
    // Only what is fully on screen: a control half scrolled away is not small.
    const c = clip(el);
    const onScreen = r.left >= c.left - 1 && r.top >= c.top - 1 && r.right <= c.right + 1 && r.bottom <= c.bottom + 1;
    if (onScreen && (r.width < minTarget - 0.5 || r.height < minTarget - 0.5) && !exemptRe.some((re) => re.test(name))) {
      small.push({ name, role: el.getAttribute('role') || el.tagName.toLowerCase(), ...box(r) });
    }
    if (onScreen) {
      const by = hitTest(el);
      if (by) covered.push({ name, by, ...box(r) });
    }
  }

  const overlaps = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const a = controls[i];
      const b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      // Map content (a fence's body or label) lies under whatever floats over the
      // map, and two fences that overlap on the ground overlap on screen: that is
      // geography, not layout. Whether a control stays reachable over it is the
      // covered check's job.
      if (/^Place\b/.test(nameOf(a)) || /^Place\b/.test(nameOf(b))) continue;
      const p = clip(a);
      const q = clip(b);
      const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (w > 2 && h > 2) overlaps.push({ a: nameOf(a), b: nameOf(b), w: Math.round(w), h: Math.round(h) });
    }
  }

  // Text: every element with a text node of its own.
  const texts = [...scope.querySelectorAll('*')].filter(
    (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && visible(el),
  );
  const inMap = (el) => !!el.closest('[data-testid="lura-map-viewport"],[data-testid^="lura-marker-"],[data-testid^="lura-fence-label-"],.maplibregl-map,[id^="lura-mappls-"]');
  const scrollsX = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  };
  const offscreen = [];
  const clipped = [];
  const truncated = [];
  const tinyText = [];
  for (const el of texts) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const text = el.innerText.replace(/\s+/g, ' ').trim().slice(0, 70);
    if (!text) continue;
    if (parseFloat(s.fontSize) < 11) tinyText.push({ text, px: parseFloat(s.fontSize) });
    if ((r.left < -1 || r.right > vw + 1) && !scrollsX(el) && !inMap(el)) offscreen.push({ text, ...box(r) });
    const ellipsis = s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none' && s.webkitLineClamp !== '' && s.webkitLineClamp !== undefined;
    if ((el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2) && ellipsis) {
      truncated.push({ text, full: el.textContent.trim().slice(0, 120) });
      continue;
    }
    if (inMap(el)) continue;
    // Cut off by a box that hides overflow (scrollers scroll it into view).
    for (let n = el.parentElement; n && n !== scope.parentElement && n !== document.body; n = n.parentElement) {
      const ns = getComputedStyle(n);
      if (ns.overflowX === 'visible' && ns.overflowY === 'visible') continue;
      if (/(auto|scroll)/.test(ns.overflowX + ns.overflowY)) break;
      const c = n.getBoundingClientRect();
      if (r.left < c.left - 2 || r.right > c.right + 2 || r.top < c.top - 2 || r.bottom > c.bottom + 2) {
        clipped.push({ text, by: nameOf(n).slice(0, 40), text_box: box(r), clip_box: box(c) });
      }
      break;
    }
  }

  const keyReport = keys.map((k) => {
    const el = [...document.querySelectorAll(`[aria-label="${k}"]`)].find(visible) ??
      [...document.querySelectorAll('[aria-label]')].find((n) => visible(n) && n.getAttribute('aria-label').startsWith(k)) ??
      [...document.querySelectorAll('[role="button"],[role="link"]')].find((n) => visible(n) && n.innerText.trim() === k);
    if (!el) return { name: k, present: false };
    const r = el.getBoundingClientRect();
    const by = hitTest(el);
    return { name: k, present: true, ...box(r), hittable: !by, coveredBy: by ?? undefined };
  });

  const doc = document.scrollingElement ?? document.documentElement;
  return {
    viewport: { w: vw, h: vh },
    dialog: dialogs.length ? nameOf(scope).slice(0, 40) : null,
    controls: controls.length,
    small,
    covered,
    overlaps,
    offscreen,
    clipped,
    truncated,
    tinyText: tinyText.slice(0, 20),
    hscroll: doc.scrollWidth > vw + 1 ? doc.scrollWidth : 0,
    keys: keyReport,
  };
};

/** problems lists what in an audit fails the suite (truncation and tiny text are reported only). */
export function problems(a) {
  const out = [];
  for (const s of a.small) out.push(`${a.where}: "${s.name}" (${s.role}) is ${s.w}×${s.h} px`);
  for (const c of a.covered) out.push(`${a.where}: "${c.name}" is covered by "${c.by}"`);
  for (const o of a.overlaps) out.push(`${a.where}: "${o.a}" overlaps "${o.b}" by ${o.w}×${o.h} px`);
  for (const t of a.offscreen) out.push(`${a.where}: text "${t.text}" runs off screen (${t.x}..${t.x + t.w})`);
  for (const t of a.clipped) out.push(`${a.where}: text "${t.text}" is clipped by "${t.by}"`);
  if (a.hscroll) out.push(`${a.where}: the page scrolls sideways (${a.hscroll} px wide)`);
  for (const k of a.keys) {
    if (!k.present) out.push(`${a.where}: "${k.name}" is not on screen`);
    else if (!k.hittable) out.push(`${a.where}: "${k.name}" is covered by "${k.coveredBy}"`);
    else if (k.y + k.h > a.viewport.h + 1 || k.x + k.w > a.viewport.w + 1 || k.x < -1 || k.y < -1) out.push(`${a.where}: "${k.name}" is partly off screen`);
  }
  return out;
}
