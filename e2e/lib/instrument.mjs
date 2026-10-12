// Code injected into every page before the app loads (page.addInitScript).
//
// It records, on the page's own clock (performance.now), the three things the
// scenario has to measure rather than eyeball:
//
//   - every live WebSocket frame, as the app is about to see it;
//   - every chime: the app synthesises sounds with Web Audio, so each
//     oscillator's first frequency is recorded and the suite groups them into
//     chimes (one chime = a burst of notes scheduled in the same tick);
//   - every live-marker update (the marker's target coordinate is a data-*
//     attribute, see Overlays.tsx) and every toast that appears.
//
// Nothing here changes behaviour: the socket, the audio graph and the DOM work
// exactly as they would without it.

export const INSTRUMENT = `(() => {
  const now = () => performance.now();
  const rec = (window.__lura = { frames: [], notes: [], markers: [], toasts: [], sockets: 0 });

  const NativeWS = window.WebSocket;
  class SpyWebSocket extends NativeWS {
    constructor(...args) {
      super(...args);
      rec.sockets += 1;
      this.addEventListener('message', (ev) => {
        const t = now();
        let f;
        try { f = JSON.parse(ev.data); } catch { return; }
        const r = { t, wall: Date.now(), type: f.type };
        if (f.type === 'position' && f.data) {
          r.deviceId = f.data.deviceId; r.userId = f.data.userId;
          r.lat = f.data.point.lat; r.lon = f.data.point.lon; r.recvTs = f.data.recvTs;
        } else if (f.type !== 'pong') {
          r.data = f.data;
        }
        rec.frames.push(r);
      });
    }
  }
  window.WebSocket = SpyWebSocket;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const create = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () {
      const osc = create.call(this);
      const set = osc.frequency.setValueAtTime.bind(osc.frequency);
      osc.frequency.setValueAtTime = (value, at) => {
        rec.notes.push({ t: now(), freq: value });
        return set(value, at);
      };
      return osc;
    };
  }

  const MARKER = 'lura-marker-';
  const seenToasts = new Set();
  const noteMarker = (el, t, added) => {
    const id = el.getAttribute('data-testid');
    if (!id || !id.startsWith(MARKER)) return;
    rec.markers.push({ t, id: id.slice(MARKER.length), lat: +el.dataset.lat, lon: +el.dataset.lon, added });
  };
  const noteToast = (el, t) => {
    const label = el.getAttribute && el.getAttribute('aria-label');
    if (!label || !label.endsWith('Show on the map.') || label.includes(', unread.')) return;
    if (el.closest && el.closest('[aria-modal="true"]')) return;
    const key = label + '|' + (el.innerText || '');
    if (seenToasts.has(key)) return;
    seenToasts.add(key);
    // The crossing it is about (lura-notice-<id>): a toast and the sticky card
    // that replaces it for a pending reminder are one notice.
    const testId = el.getAttribute('data-testid') || '';
    const notice = testId.startsWith('lura-notice-') ? testId.slice('lura-notice-'.length) : '';
    rec.toasts.push({ t, wall: Date.now(), label, text: el.innerText || '', notice });
  };
  const scan = (node, t) => {
    if (node.nodeType !== 1) return;
    noteMarker(node, t, true);
    noteToast(node, t);
    for (const el of node.querySelectorAll('[data-testid^="lura-marker-"]')) noteMarker(el, t, true);
    for (const el of node.querySelectorAll('[aria-label$="Show on the map."]')) noteToast(el, t);
  };
  const observer = new MutationObserver((mutations) => {
    const t = now();
    for (const m of mutations) {
      if (m.type === 'attributes') {
        noteMarker(m.target, t, false);
        if (m.attributeName === 'aria-label') noteToast(m.target, t);
      } else {
        for (const n of m.addedNodes) scan(n, t);
      }
    }
  });
  const start = () => observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['data-lat', 'data-lon', 'aria-label'],
  });
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);

  // sampleMarker records a marker's on-screen position every animation frame,
  // which is what tells a glide from a jump.
  window.__luraSample = (id, ms) => new Promise((resolve) => {
    const out = [];
    const t0 = now();
    const tick = () => {
      const el = document.querySelector('[data-testid="' + MARKER + id + '"]');
      if (el) { const r = el.getBoundingClientRect(); out.push({ t: now(), x: r.left, y: r.top }); }
      if (now() - t0 < ms) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
  });
})();`;
