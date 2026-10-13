// What the server says, seen from outside any browser: a phone posting fixes,
// a raw WebSocket recording every frame, and a search for an id anywhere in a
// JSON body. The privacy suites assert on these, because an app that merely
// hides something the server sent has not kept it private.

import { sleep, waitFor } from './browser.mjs';
import { haversineM, lerp } from './geo.mjs';

const API = () => process.env.E2E_API ?? process.env.E2E_BASE ?? 'http://localhost:8080';

/** pub posts one OwnTracks-style fix with a device's own ingest token, as a phone would. */
export async function pub(device, point, { speedMps = 0, cog, tst = Math.floor(Date.now() / 1000) } = {}) {
  const body = { _type: 'location', lat: point.lat, lon: point.lon, tst, acc: 5, speedMps, batt: 80, ...(cog !== undefined ? { cog } : {}) };
  const t0 = Date.now();
  const res = await fetch(`${API()}/pub`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /pub → ${res.status} ${text}`);
  return { t0, t1: Date.now(), point, position: JSON.parse(text).position };
}

/**
 * drive moves a device along a straight line at `mps`, one fix every
 * `periodMs`, as a phone in a car would report it. Resolves with every post.
 * `onFix` sees each one; returning true from `until` stops early.
 */
export async function drive(device, from, to, { mps = 12, periodMs = 1000, onFix, until } = {}) {
  const dist = haversineM(from, to);
  const steps = Math.max(1, Math.ceil(dist / (mps * (periodMs / 1000))));
  const cog = Math.round(bearing(from, to));
  const posts = [];
  for (let i = 0; i <= steps; i += 1) {
    const p = lerp(from, to, i / steps);
    const r = await pub(device, p, { speedMps: i === steps ? 0 : mps, cog });
    posts.push(r);
    onFix?.(r);
    if (until?.(r)) break;
    if (i < steps) await sleep(periodMs);
  }
  return posts;
}

export function bearing(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const y = Math.sin(r(b.lon - a.lon)) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat)) - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(r(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Wire is a WebSocket opened from Node, recording every frame with the wall
 * clock: a signed-in person's /ws (pass `token`) or a share link's public
 * /s/<token>/ws (pass `path`, no credentials at all).
 */
export class Wire {
  constructor(label, { token, path = '/ws' } = {}) {
    this.label = label;
    this.frames = [];
    this.closed = null;
    const q = token ? `${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : '';
    this.url = `${API().replace(/^http/, 'ws')}${path}${q}`;
  }

  async open({ hello = 'hello' } = {}) {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      try {
        this.frames.push({ wall: Date.now(), ...JSON.parse(ev.data) });
      } catch {
        this.frames.push({ wall: Date.now(), type: '?', raw: String(ev.data) });
      }
    };
    this.ws.onclose = (ev) => {
      this.closed = { wall: Date.now(), code: ev.code, reason: ev.reason };
    };
    await waitFor(`${this.label}: the first frame (${hello})`, () => this.frames.some((f) => f.type === hello), { timeout: 10000 });
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
      this.ws?.close();
    } catch {
      /* already */
    }
  }
}

/** pathsWith lists every JSON path in `value` whose string contains `needle`. */
export function pathsWith(value, needle, path = '$') {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value.includes(needle) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => pathsWith(v, needle, `${path}[${i}]`));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(k.includes(needle) ? [`${path}.${k}`] : []),
      ...pathsWith(v, needle, `${path}.${k}`),
    ]);
  }
  return [];
}

/** mentions says whether any of `needles` appears anywhere in a frame or body. */
export function mentions(value, needles) {
  const text = JSON.stringify(value ?? null);
  return needles.filter((n) => n && text.includes(n));
}
