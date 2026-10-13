// Live-data helpers for suites that drive phones from Node and compare what two
// browsers show: posting fixes, a person's own WebSocket observer, reading
// markers and rail rows at one instant, telling a glide from a jump, and
// drawing a polygon fence through the map's own editor.

import { sleep, waitFor } from './browser.mjs';
import { metresPerPixel, project } from './geo.mjs';

/** offset moves a point by metres east (dx) and north (dy). */
export function offset(p, dx, dy) {
  const dLat = dy / 111_320;
  const dLon = dx / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

/** bearing is the compass course from a to b, in degrees. */
export function bearing(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const y = Math.sin(r(b.lon - a.lon)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * pub posts one OwnTracks-style fix for a device with its own ingest token,
 * exactly as a phone would, and returns the wall clock around the request.
 */
export async function pub(api, device, point, { speedMps = 0, cog, tst = Math.floor(Date.now() / 1000) } = {}) {
  const body = {
    _type: 'location', lat: point.lat, lon: point.lon, tst, acc: 5, speedMps, batt: 80,
    ...(cog !== undefined ? { cog: Math.round(cog) } : {}),
  };
  const t0 = Date.now();
  const res = await fetch(`${api}/pub`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /pub → ${res.status} ${text}`);
  return { t0, t1: Date.now(), body };
}

/**
 * Observer is a WebSocket opened from Node with a person's token, recording every
 * frame the server pushed to them with the wall clock: "the server told Harsh X"
 * without the app in between.
 */
export class Observer {
  constructor(person, api) {
    this.person = person;
    this.api = api;
    this.frames = [];
  }

  async open() {
    const token = await this.person.token();
    this.ws = new WebSocket(`${this.api.replace(/^http/, 'ws')}/ws?access_token=${encodeURIComponent(token)}`);
    this.ws.onmessage = (ev) => {
      try {
        this.frames.push({ wall: Date.now(), ...JSON.parse(ev.data) });
      } catch {
        /* not a frame */
      }
    };
    await waitFor(`${this.person.name}'s observer socket`, () => this.frames.some((f) => f.type === 'hello'), { timeout: 10000 });
    this.ping = setInterval(() => {
      try {
        this.ws.send('{"type":"ping"}');
      } catch {
        /* closed */
      }
    }, 20000);
    return this;
  }

  since(wall, pred = () => true) {
    return this.frames.filter((f) => f.wall >= wall && pred(f));
  }

  close() {
    clearInterval(this.ping);
    try {
      this.ws.close();
    } catch {
      /* already */
    }
  }
}

/** readMarker is a live marker's target coordinate, label and staleness, as drawn. */
export async function readMarker(page, id) {
  return page.evaluate((testId) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const d = el.dataset;
    return { x: r.left, y: r.top, lat: +d.lat, lon: +d.lon, label: d.label ?? '', heading: d.heading ?? '', stale: d.stale === 'true' };
  }, `lura-marker-${id}`);
}

/** rowAt is a rail row's live line ("Moving · 29 km/h · just now") and the wall clock it was read at. */
export async function rowAt(page, key) {
  return page.evaluate((id) => ({ text: document.querySelector(`[data-testid="lura-rail-${id}"]`)?.innerText ?? null, at: Date.now() }), key);
}

/** ageSeconds parses the app's age wording ("just now", "12s ago", "2 min ago"). */
export function ageSeconds(line) {
  if (!line) return null;
  if (/just now/.test(line)) return 0;
  const s = /(\d+)s ago/.exec(line);
  if (s) return Number(s[1]);
  const m = /(\d+) min ago/.exec(line);
  if (m) return Number(m[1]) * 60;
  return null;
}

/**
 * ageMatches: a row showing "Ns ago" was rendered from floor(age) on a clock
 * that ticks once a second, so the true age is in [N, N + 2); "just now" is < 3 s.
 */
export function ageMatches(line, trueAgeS) {
  const s = ageSeconds(line);
  if (s === null) return false;
  const hi = /just now/.test(line) ? 3 : s + 2.5;
  return trueAgeS >= s - 0.5 && trueAgeS <= hi;
}

/** speedLabel is the "29 km/h" a marker label or rail row carries, or "still". */
export function speedLabel(text) {
  const m = /(\d+) km\/h/.exec(text ?? '');
  return m ? `${m[1]} km/h` : 'still';
}

/** near: two points agree to 1e-6 degrees (about 10 cm). */
export function near(a, b) {
  return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
}

// ------------------------------------------------------------------ glide

const GLIDE_SPEED_SLACK = 3;
/** Below this many frames a second a glide cannot be told from a jump. */
export const MIN_JUDGE_FPS = 8;

/**
 * sampleOnMap records a marker's position every animation frame in map space
 * (the first frame's pixels), so a camera move does not read as the marker
 * jumping. Same rules as scenario.mjs step 3.
 */
export async function sampleOnMap(page, markerId, ms) {
  const raw = await page.evaluate(
    ([id, ms]) =>
      new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
          const el = document.querySelector(`[data-testid="lura-marker-${id}"]`);
          const vp = [...document.querySelectorAll('[data-testid="lura-map-viewport"]')].find((n) => n.offsetParent !== null);
          if (el && vp) {
            const r = el.getBoundingClientRect();
            const vr = vp.getBoundingClientRect();
            const d = vp.dataset;
            out.push({
              t: performance.now(),
              x: r.left - vr.left,
              y: r.top - vr.top,
              view: { center: { lat: +d.lat, lon: +d.lon }, zoom: +d.zoom, width: +d.width, height: +d.height },
            });
          }
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
    [markerId, ms],
  );
  const z0 = raw[0]?.view.zoom ?? 0;
  let cameraMoves = 0;
  const track = raw.map((s, i) => {
    if (i > 0 && JSON.stringify(s.view) !== JSON.stringify(raw[i - 1].view)) cameraMoves += 1;
    const c = project(s.view.center, { center: { lat: 0, lon: 0 }, zoom: s.view.zoom, width: 0, height: 0 });
    const k = 2 ** (z0 - s.view.zoom);
    return { t: s.t, x: (s.x - s.view.width / 2 + c.x) * k, y: (s.y - s.view.height / 2 + c.y) * k };
  });
  const spanMs = Math.max(1, (raw.at(-1)?.t ?? 0) - (raw[0]?.t ?? 0));
  return { track, cameraMoves, fps: (1000 * Math.max(0, raw.length - 1)) / spanMs };
}

/** glideOf tells a glide (many small steps) from a jump (one big one), as scenario.mjs does. */
export function glideOf(samples, fixesDuring) {
  const steps = samples.slice(1).map((s, i) => ({
    d: Math.hypot(s.x - samples[i].x, s.y - samples[i].y),
    dt: s.t - samples[i].t,
    w: s.t - samples[Math.max(0, i - 1)].t,
    at: s.t - samples[0].t,
  }));
  const travelled = steps.reduce((sum, s) => sum + s.d, 0);
  const durationMs = Math.max(1, (samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0));
  const pxPerMs = travelled / durationMs;
  const perFix = travelled / Math.max(1, fixesDuring);
  // Sub-pixel: at zoom 14 a bicycle moves ~0.04 px a frame, and that is still a glide.
  const moving = steps.filter((s) => s.d > 0.005);
  const jumps = steps.slice(1).filter((s) => s.d >= Math.max(2, perFix * 0.25, GLIDE_SPEED_SLACK * pxPerMs * s.w));
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    frames: samples.length,
    fps: Math.round((1000 * (samples.length - 1)) / durationMs),
    movingFrames: moving.length,
    movingMs: Math.round(moving.reduce((sum, s) => sum + s.dt, 0)),
    fixesDuring,
    travelledPx: Math.round(travelled),
    biggestStepPx: r1(Math.max(0, ...steps.map((s) => s.d))),
    jumps: jumps.slice(0, 5).map((s) => `${r1(s.d)}px in ${Math.round(s.w)}ms at +${Math.round(s.at)}ms`),
  };
}

// ------------------------------------------------------------------ the editor

/** centreOn drags a person's map so a point sits mid-view, then sets the zoom with the buttons. */
export async function centreOn(person, point, zoom) {
  const page = person.page;
  for (let i = 0; i < 12 && zoom !== undefined; i += 1) {
    const v = await person.stableViewport(400);
    if (Math.abs(v.zoom - zoom) < 0.6) break;
    await page.getByRole('button', { name: v.zoom > zoom ? 'Zoom out' : 'Zoom in' }).click();
  }
  for (let i = 0; i < 4; i += 1) {
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

/**
 * drawPolygonFence draws a square fence of side 2·halfM around `center` with the
 * Draw → Polygon tool (four taps, Done), fills the place form (name, triggers,
 * watched people) and creates it. Returns the place the server answered with and
 * the ring as tapped.
 */
export async function drawPolygonFence(person, { name, center, halfM = 50, triggers, watch = [], shotDir }) {
  const page = person.page;
  const v = await centreOn(person, center, 16);
  await page.getByRole('button', { name: 'Draw' }).click();
  await page.getByRole('menuitem', { name: 'Polygon' }).click();
  const c = await person.px(center, v);
  const half = Math.round(halfM / metresPerPixel(center.lat, v.zoom));
  const corners = [
    { x: c.x - half, y: c.y - half },
    { x: c.x + half, y: c.y - half },
    { x: c.x + half, y: c.y + half },
    { x: c.x - half, y: c.y + half },
  ].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  for (const p of corners) {
    await page.mouse.click(p.x, p.y);
    await sleep(250);
  }
  await page.getByText('4 corners · tap the first corner or Done to close').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByText('Polygon with 4 corners').waitFor({ timeout: 5000 });
  const ring = await Promise.all(corners.map((p) => person.ground(p.x, p.y, v)));

  await page.getByPlaceholder('Whole Foods').fill(name);
  for (const t of ['Arrive', 'Leave', 'Dwell', 'Pass by']) {
    const box = page.getByRole('checkbox', { name: new RegExp(`^${t}`) }).first();
    const on = (await box.getAttribute('aria-checked')) === 'true';
    if (on !== triggers.includes(t)) await box.click();
  }
  for (const who of watch) {
    const box = page.getByRole('checkbox', { name: who, exact: true });
    if ((await box.getAttribute('aria-checked')) !== 'true') await box.click();
  }
  const formShot = shotDir ? await person.shot(shotDir, `form-${name.toLowerCase()}`) : null;
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/places') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create place' }).click();
  const res = await created;
  const text = await res.text();
  if (res.status() !== 201 && res.status() !== 200) throw new Error(`${person.name} creating ${name}: HTTP ${res.status()} ${text}`);
  const body = JSON.parse(text);
  await page.getByRole('button', { name: 'Draw' }).waitFor({ timeout: 10000 });
  return { place: body.place ?? body, ring, formShot };
}

/**
 * historyRows opens the History screen (today) and returns its timeline rows'
 * accessible labels ("14:02 Harsh passed Gym, … Show on the map."), waiting up
 * to `timeout` for `until(rows)` to hold (the feed loads after the screen).
 */
export async function historyRows(person, until = (rows) => rows.length > 0, { timeout = 15000 } = {}) {
  await person.nav('History');
  await person.page.getByRole('button', { name: 'Previous day' }).waitFor({ timeout: 10000 });
  const read = () =>
    person.page.evaluate(() =>
      [...document.querySelectorAll('[aria-label$="Show on the map."]')]
        .map((e) => e.getAttribute('aria-label'))
        .filter((l) => /^\d\d:\d\d /.test(l)),
    );
  let rows = [];
  await waitFor(`${person.name}'s History`, async () => {
    rows = await read();
    return until(rows);
  }, { timeout, every: 500 }).catch(() => {});
  // Let the screen's map draw its basemap before anyone photographs it.
  await person.stableViewport(800).catch(() => {});
  await sleep(2500);
  return rows;
}
