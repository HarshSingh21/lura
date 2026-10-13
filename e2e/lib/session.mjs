// Long-session plumbing for e2e/uc-session.mjs: what a browser did with its
// tokens, the notices it showed, and a laptop sleep on demand.
//
// Kept apart from browser.mjs so the long-session suite can grow without
// touching what the other suites stand on.

import { sleep, waitFor } from './browser.mjs';

/** decodeJwt reads a JWT's claims (no verification: only the server decides). */
export function decodeJwt(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * NOTICES records every notice a page shows: one entry per crossing (the
 * lura-notice-<id> it carries), whether it shows as a toast or as the sticky
 * card of a reminder waiting for an acknowledgement. Also the live status pill.
 */
export const NOTICES = `(() => {
  const rec = (window.__uc = { notices: [], status: [] });
  const seen = new WeakSet();
  const ids = new Set();
  const scan = (root) => {
    if (root.nodeType !== 1) return;
    const els = [root, ...root.querySelectorAll('[aria-label$="Show on the map."]')];
    for (const el of els) {
      const label = el.getAttribute && el.getAttribute('aria-label');
      if (!label || !label.endsWith('Show on the map.') || seen.has(el)) continue;
      if (el.closest('[aria-modal="true"]') || label.includes(', unread.') || el.closest('[data-testid="lura-notification-panel"]')) continue;
      seen.add(el);
      const id = el.getAttribute('data-testid') || '';
      const notice = id.startsWith('lura-notice-') ? id.slice('lura-notice-'.length) : '';
      if (notice && ids.has(notice)) continue;
      if (notice) ids.add(notice);
      rec.notices.push({ wall: Date.now(), label, text: el.innerText || '', notice });
    }
  };
  let last;
  const status = () => {
    const el = document.querySelector('[data-testid="lura-live-status"]');
    const s = el ? el.dataset.status : undefined;
    if (s !== last) { last = s; rec.status.push({ wall: Date.now(), status: s }); }
  };
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) scan(n); status(); })
    .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
})();`;

/**
 * HOST_NETWORK keeps this laptop's own Wi-Fi out of the pages. Chrome reports
 * the host's network: when the Wi-Fi drops (macOS logs "Link down because of
 * beacon loss"), every page gets an `offline` event and navigator.onLine turns
 * false, and the app rightly goes offline for a minute — though Lura, Keycloak
 * and the test all talk over loopback and never lost a packet. A session test
 * asserting "live the whole time" cannot pass across such a drop, so outside
 * the network the suite emulates itself (ctx.setOffline, with
 * window.__ucNet.emulated set), the host's `offline` events are recorded in
 * window.__ucNet.host and kept from the app, and navigator.onLine stays true.
 * `online` events always pass: they only ever tell the app to try now.
 */
export const HOST_NETWORK = `(() => {
  const rec = (window.__ucNet = { emulated: false, host: [] });
  const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
  Object.defineProperty(Navigator.prototype, 'onLine', {
    configurable: true,
    enumerable: onLine.enumerable,
    get() { const v = onLine.get.call(this); return v || rec.emulated ? v : true; },
  });
  window.addEventListener('offline', (e) => {
    if (rec.emulated) return;
    rec.host.push({ wall: Date.now(), type: 'offline' });
    e.stopImmediatePropagation();
  }, true);
  window.addEventListener('online', () => { if (!rec.emulated) rec.host.push({ wall: Date.now(), type: 'online' }); }, true);
})();`;

/**
 * setOffline emulates the network going away (or coming back) for one person,
 * marking it as the suite's own so HOST_NETWORK lets the app hear it.
 */
export async function setOffline(person, offline) {
  if (offline) await person.page.evaluate(() => { if (window.__ucNet) window.__ucNet.emulated = true; }).catch(() => {});
  await person.ctx.setOffline(offline);
  // No offline event follows going online, so the mark can go at once.
  if (!offline) await person.page.evaluate(() => { if (window.__ucNet) window.__ucNet.emulated = false; }).catch(() => {});
}

/**
 * TokenLog watches one person's browser context: every token Keycloak hands
 * out (grant, expires_in, the token's own iat/exp), every bearer the app sends
 * to Lura (with the exp it carried at that moment), every socket handshake's
 * token, and every 401 Lura answers.
 *
 * Times are the Node wall clock, which is the real one even while a page runs
 * on a paused fake clock.
 */
export class TokenLog {
  constructor(person, apiOrigin) {
    this.person = person;
    this.api = apiOrigin;
    this.tokens = [];
    this.bearers = [];
    this.sockets = [];
    this.unauthorized = [];
    this.tokenFailures = [];
  }

  attach() {
    const ctx = this.person.ctx;
    ctx.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith(this.api)) return;
      const auth = req.headers().authorization ?? '';
      if (!auth.startsWith('Bearer ')) return;
      const claims = decodeJwt(auth.slice(7));
      if (!claims) return; // a device's ingest token on /pub, not a session token
      const wall = Date.now();
      this.bearers.push({ wall, method: req.method(), path: new URL(url).pathname, iat: claims.iat, exp: claims.exp, expiredByMs: wall - claims.exp * 1000 });
    });
    ctx.on('response', async (res) => {
      const url = res.url();
      if (url.startsWith(this.api) && res.status() === 401) {
        this.unauthorized.push({ wall: Date.now(), url, method: res.request().method() });
      }
      if (!/\/protocol\/openid-connect\/token$/.test(url) || res.request().method() !== 'POST') return;
      const wall = Date.now();
      const grant = /grant_type=([a-z_]+)/.exec(res.request().postData() ?? '')?.[1] ?? '?';
      let body = {};
      try {
        body = await res.json();
      } catch {
        /* an error page */
      }
      const claims = decodeJwt(body.access_token);
      this.tokens.push({
        wall, status: res.status(), grant,
        expiresIn: body.expires_in, refreshExpiresIn: body.refresh_expires_in,
        iat: claims?.iat, exp: claims?.exp, error: body.error,
      });
    });
    ctx.on('requestfailed', (req) => {
      if (/\/protocol\/openid-connect\/token$/.test(req.url())) this.tokenFailures.push({ wall: Date.now(), error: req.failure()?.errorText });
    });
    const watchPage = (page) => page.on('websocket', (ws) => this.noteSocket(ws.url(), 'page'));
    ctx.pages().forEach(watchPage);
    ctx.on('page', watchPage);
    return this;
  }

  noteSocket(url, via) {
    const token = new URL(url).searchParams.get('access_token');
    const claims = decodeJwt(token);
    const wall = Date.now();
    this.sockets.push({ wall, via, since: new URL(url).searchParams.get('since'), iat: claims?.iat, exp: claims?.exp, expiredByMs: claims ? wall - claims.exp * 1000 : null });
  }

  /** refreshes are the renewals (not the sign-in's code exchange) after `wall`. */
  refreshes(from = 0, to = Infinity) {
    return this.tokens.filter((t) => t.grant === 'refresh_token' && t.wall >= from && t.wall <= to);
  }

  /** expiredUses lists bearers and handshakes that carried an already expired token. */
  expiredUses(from = 0, to = Infinity) {
    return [...this.bearers, ...this.sockets].filter((b) => b.wall >= from && b.wall <= to && b.expiredByMs !== null && b.expiredByMs > 0);
  }

  /**
   * timeline is the token history relative to `t0`: for each token, when it
   * arrived, how long it lived, and how far ahead of the previous token's
   * expiry it was fetched (the renewal lead).
   */
  timeline(t0) {
    let prev;
    return this.tokens.map((t) => {
      const row = {
        atS: Math.round((t.wall - t0) / 100) / 10, grant: t.grant, status: t.status,
        expiresIn: t.expiresIn, refreshExpiresIn: t.refreshExpiresIn,
        lifetimeS: t.exp && t.iat ? t.exp - t.iat : null,
        leadBeforePrevExpiryS: prev?.exp ? Math.round((prev.exp * 1000 - t.wall) / 100) / 10 : null,
      };
      if (t.status === 200 && t.exp) prev = t;
      return row;
    });
  }
}

/** maxGap is the longest pause between updates of marker `id` in a page record (page clock). */
export function maxGap(rec, id, fromT, toT = Infinity) {
  const ts = rec.markers.filter((m) => m.id === id && m.t >= fromT && m.t <= toT).map((m) => m.t);
  let max = 0;
  let at = null;
  for (let i = 1; i < ts.length; i += 1) {
    if (ts[i] - ts[i - 1] > max) {
      max = ts[i] - ts[i - 1];
      at = ts[i - 1];
    }
  }
  // The edges count too: from the window's start to the first update.
  if (ts.length && ts[0] - fromT > max) {
    max = ts[0] - fromT;
    at = fromT;
  }
  return { updates: ts.length, maxGapMs: Math.round(max), atT: at === null ? null : Math.round(at) };
}

/**
 * Laptop puts one person's browser through a laptop sleep.
 *
 * A Mac asleep runs no code: timers stop (Chrome's timers and performance.now
 * run on a monotonic clock that does not advance during sleep), the wall clock
 * keeps going, and the server drops a socket that stopped answering its pings.
 * On waking, every timer resumes with whatever it had left, while Date.now()
 * has jumped by the length of the sleep.
 *
 * That is modelled with Playwright's clock: pauseAt() stops every timer, rAF
 * and performance.now; setSystemTime() then moves Date.now() to the real time
 * without firing anything, and resume() lets the timers carry on from where
 * they stopped. The network goes one of two ways:
 *
 *   - 'offline': the network is gone for the sleep (the browser says so) and
 *     comes back a moment after waking, as Wi-Fi rejoins;
 *   - 'silent':  no network event at all; the server-side end of the live
 *     socket is closed and nothing the page sends or is sent arrives, so the
 *     page holds a socket it believes is open — what a NAT or proxy that
 *     forgot the connection during the sleep leaves behind.
 *
 * The socket is routed through Node (page.routeWebSocket) for that, which is
 * also where its frames are recorded: `conns` holds one entry per socket.
 */
export class Laptop {
  constructor(person, tokenLog) {
    this.person = person;
    this.log = tokenLog;
    this.conns = [];
  }

  /** install fakes the clock and routes the live socket; the page must be reloaded after. */
  async install() {
    await this.person.ctx.clock.install();
    await this.person.page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const conn = { opened: Date.now(), url: ws.url(), black: false, frames: [], sent: [], closed: null };
      this.conns.push(conn);
      this.log?.noteSocket(ws.url(), 'route');
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        conn.sent.push({ wall: Date.now(), black: conn.black });
        if (!conn.black) server.send(m);
      });
      server.onMessage((m) => {
        let f = {};
        try {
          f = JSON.parse(m);
        } catch {
          /* not JSON */
        }
        conn.frames.push({ wall: Date.now(), type: f.type, data: f.data, black: conn.black });
        if (!conn.black) ws.send(m);
      });
      ws.onClose((code, reason) => {
        conn.closed ??= { wall: Date.now(), by: 'page', code, reason };
        server.close({ code: code === 1005 || !code ? 1000 : code, reason }).catch?.(() => {});
      });
      server.onClose((code, reason) => {
        conn.closed ??= { wall: Date.now(), by: 'server', code, reason };
        if (!conn.black) ws.close({ code: code === 1005 || !code ? 1000 : code, reason }).catch?.(() => {});
      });
      conn.cut = () => {
        conn.black = true;
        server.close({ code: 1001, reason: 'client asleep' }).catch?.(() => {});
      };
    });
  }

  /** live is the newest routed socket that has said hello and has not closed. */
  live() {
    return this.conns.filter((c) => !c.closed && !c.black && c.frames.some((f) => f.type === 'hello')).at(-1) ?? null;
  }

  /**
   * sleep puts the laptop to sleep for `ms` (real time), running `during()`
   * meanwhile, and wakes it. Returns the wall clock of both edges.
   */
  async sleep(ms, { network = 'offline', during, rejoinMs = 1000 } = {}) {
    const { ctx, page } = this.person;
    // A moment ahead of both clocks: pauseAt cannot go back, and the page's
    // clock moves on while this call travels.
    const fakeNow = await page.evaluate(() => Date.now());
    const asleepAt = Date.now();
    await ctx.clock.pauseAt(Math.max(fakeNow, asleepAt) + 500);
    if (network === 'offline') await setOffline(this.person, true);
    else for (const c of this.conns.filter((x) => !x.closed && !x.black)) c.cut();
    const work = during ? during() : Promise.resolve();
    await sleep(Math.max(0, asleepAt + ms - Date.now()));
    await work;
    const wokeAt = Date.now();
    await ctx.clock.setSystemTime(Date.now());
    await ctx.clock.resume();
    let onlineAt = null;
    if (network === 'offline') {
      await sleep(rejoinMs);
      await setOffline(this.person, false);
      onlineAt = Date.now();
    }
    return { asleepAt, wokeAt, onlineAt, sleptMs: wokeAt - asleepAt };
  }

  /** helloAfter waits for a socket opened after `wall` to say hello; returns its wall clock. */
  async helloAfter(wall, timeout) {
    return waitFor('a new live socket', () => {
      for (const c of this.conns) {
        if (c.opened < wall || c.black) continue;
        const h = c.frames.find((f) => f.type === 'hello');
        if (h) return { at: h.wall, conn: c };
      }
      return null;
    }, { timeout, every: 50 });
  }
}
