// A phone a suite drives: one registered device, fed fixes exactly where and
// when the suite says (pub), parked on one spot (stand), or driven along a
// route by cmd/lurasim (sim). The edge suites inline the same three for
// Nishtha's phone alone; this is the reusable form, for any person's device.

import { spawn } from 'node:child_process';

import { sleep } from './browser.mjs';

export class Phone {
  /**
   * @param {object} o
   * @param {string} o.api   Lura's base URL
   * @param {string} o.id    device id
   * @param {string} o.token the device's publish token
   * @param {string} [o.lurasim] path to the lurasim binary
   */
  constructor({ api, id, token, lurasim = 'lurasim', name = id }) {
    Object.assign(this, { api, id, token, lurasim, name });
    this.seq = 0;
    this.children = new Set();
    this.stands = new Set();
    /** Every fix this phone sent through pub/stand, with when (wall clock). */
    this.sent = [];
  }

  /** register creates a device for a person (their Person.api) and returns its Phone. */
  static async register(person, { name, kind = 'phone', api, lurasim }) {
    const created = await person.api('POST', '/api/v1/devices', { name, kind });
    return new Phone({ api, id: created.device.id, token: created.pubToken, lurasim, name });
  }

  /** pub posts one fix. */
  async pub(p, { speed = 0, acc = 5 } = {}) {
    this.seq += 1;
    const res = await fetch(`${this.api}/pub?device=${this.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ _type: 'location', lat: p.lat, lon: p.lon, tst: Math.floor(Date.now() / 1000), acc, speedMps: speed, seq: this.seq }),
    });
    if (!res.ok) throw new Error(`${this.name}: pub HTTP ${res.status} ${await res.text()}`);
    this.sent.push({ at: Date.now(), lat: p.lat, lon: p.lon, speed });
  }

  /**
   * stand keeps reporting from one spot (or from pick(), a fresh point each
   * fix, for GPS noise) until the returned stop() is awaited.
   */
  stand(p, { everyMs = 1500, pick } = {}) {
    let on = true;
    const loop = (async () => {
      while (on) {
        await this.pub(pick ? pick() : p, { speed: 0 }).catch(() => {});
        await sleep(everyMs);
      }
    })();
    const stop = async () => {
      on = false;
      this.stands.delete(stop);
      await loop;
    };
    this.stands.add(stop);
    return stop;
  }

  /**
   * sim drives the phone along a route with cmd/lurasim. `scale` is simulated
   * seconds per real second: a waypoint's dwell of 120 s at scale 2 is 60 s of
   * fixes. lurasim closes the loop (its last leg returns to the first point).
   */
  sim(route, { interval = '700ms', scale = 4, loops = 1, jitter = 3 } = {}) {
    const spec = route.map((p) => `${p.lat},${p.lon}${p.dwell ? `,${p.dwell}` : ''}`).join(';');
    const child = spawn(
      this.lurasim,
      ['-url', this.api, '-token', this.token, `-device=${this.id}`, '-route', spec,
        '-interval', interval, '-scale', String(scale), '-jitter', String(jitter), '-loops', String(loops), '-quiet'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.children.add(child);
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const done = new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        this.children.delete(child);
        if (code === 0 || code === null) resolve(log);
        else reject(new Error(`lurasim exited ${code}: ${log}`));
      });
    });
    return { done, stop: () => child.kill('SIGINT') };
  }

  /** halt stops every simulator and stand this phone has running. */
  async halt() {
    for (const child of this.children) child.kill('SIGINT');
    for (const stop of [...this.stands]) await stop();
  }
}

/** offset moves a point by metres east (dx) and north (dy). */
export function offset(p, dx, dy) {
  const dLat = dy / 111_320;
  const dLon = dx / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

/** box is a rectangle w × h metres centred on c, as an open ring. */
export function box(c, w, h) {
  return [offset(c, -w / 2, -h / 2), offset(c, w / 2, -h / 2), offset(c, w / 2, h / 2), offset(c, -w / 2, h / 2)];
}
