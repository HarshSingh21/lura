# Testing Lura locally

Every command here was run on a clean checkout before it was written down. Start
with §1 — it needs nothing installed but Go.

Prerequisites, by section: Go 1.24+ everywhere; Node 20+ for the client; Docker
for PostgreSQL and the deployment.

---

## 1. The 30-second check (no database, no Docker)

```bash
go run ./cmd/lura
```

The in-memory store seeds a demo workspace on boot:

```
level=INFO msg="seeded demo workspace" user=usr_demo places=6 notes=5 positions=74 shares=2
level=INFO msg="demo workspace ready" device=dev_phone pubToken=ZuAQ…tJhE
level=INFO msg=listening addr=:8080 store=memory
```

In another terminal:

```bash
export T="Authorization: Bearer lura-dev-token"

curl -s localhost:8080/healthz | jq                    # status, store, uptime
curl -s -H "$T" localhost:8080/api/v1/overview | jq    # devices, places, notes, shares
```

`overview` is the whole workspace in one request — 2 devices, 6 places, 5 notes.

### Ask the AI Brain

```bash
curl -s -H "$T" -H 'Content-Type: application/json' \
  -d '{"text":"buy oat milk when I pass the store"}' \
  localhost:8080/api/v1/notes/suggest | jq .suggestion
```

```json
{ "placeName": "Whole Foods", "trigger": "passby", "tags": ["grocery"],
  "confidence": 0.58, "engine": "rules", "onDevice": true }
```

It picked the place from the words, the trigger from the phrasing, and told you
how sure it is and where it ran.

### Send a location and watch it fire

```bash
curl -s -H "$T" -H 'Content-Type: application/json' \
  -d '{"_type":"location","lat":12.9611,"lon":77.6387,"speedMps":0.2}' \
  "localhost:8080/pub?device=dev_phone" | jq

curl -s -H "$T" localhost:8080/api/v1/events | jq '.events[0]'
```

That fix is inside the seeded **Home** fence at walking pace, so the arrive
debounce confirms immediately and the note bound to Home fires.

> **Testing at night?** The demo user has quiet hours 22:30–07:00, so `delivered`
> will show only `["inapp"]` — push is suppressed by design. Clear them with:
> ```bash
> curl -s -X PATCH -H "$T" -H 'Content-Type: application/json' \
>   -d '{"quietFrom":"","quietTo":""}' localhost:8080/api/v1/me | jq .user
> ```
> Then `delivered` becomes `["inapp","log"]` and the reminder appears in the
> server log as `msg=reminder`.

---

## 2. Watch it move: the device simulator

The interesting behaviour only happens when a device is moving. This drives a
virtual phone around the seeded places, exercising every trigger:

```bash
go run ./cmd/lurasim -interval 300ms -scale 40 -loops 1
```

`-scale 40` means 40 simulated seconds per real second, so a 45-second arrive
debounce and a 45-minute dwell are both observable in a short run.

In the server log you will see the whole chain:

```
msg="geofence event" trigger=leave  place=Home         device=dev_phone
msg="geofence event" trigger=passby place="Whole Foods" device=dev_phone
msg="geofence event" trigger=arrive place=Office       device=dev_phone
msg="share revoked"  share=shr_priya reason="arrived at Home"
```

### Watch the live WebSocket

Node 20+ has a built-in WebSocket, so no dependency is needed. Save as `watch.mjs`:

```js
const ws = new WebSocket('ws://localhost:8080/ws?access_token=lura-dev-token');
ws.onmessage = (e) => {
  const f = JSON.parse(e.data);
  if (f.type === 'position')
    console.log(`position ${f.data.deviceId} ${f.data.point.lat.toFixed(4)},${f.data.point.lon.toFixed(4)} ${Math.round(f.data.speedMps * 3.6)} km/h`);
  else if (f.type === 'geo') console.log(`GEO ${f.data.trigger} at ${f.data.placeName}`);
  else if (f.type === 'notify') console.log(`REMINDER ${f.data.title}: ${f.data.body}`);
  else console.log(f.type);
};
```

```bash
node watch.mjs &          # then run the simulator
```

```
hello
snapshot
position dev_phone 12.9623,77.6382 17 km/h
GEO leave at Home
REMINDER Left Home: Pick up dry cleaning
position dev_phone 12.9705,77.6350 15 km/h
GEO passby at Whole Foods
REMINDER Passing Whole Foods: Buy oat milk & eggs
```

That is the full path: ingest → bus → geofence → notify → fan-out, in real time.

---

## 3. The web control centre

```bash
cd client && npm install     # first time only
cd .. && make serve          # builds the web bundle, serves it from the Go binary
```

Open <http://localhost:8080>. App and API are on one origin, so there is nothing
to configure. Run the simulator alongside it and the marker moves on the map,
reminders appear as toasts, and the sharing banner updates live.

For hot reload while working on the client, run the two separately:

```bash
go run ./cmd/lura            # terminal 1 — API on :8080
cd client && npm start       # terminal 2 — press w for web, on :8081
```

The client defaults to `http://localhost:8080` for its API; **Settings →
Connection** changes it at runtime.

### What to try in the UI

| Where | What |
|---|---|
| Live map | **Draw a place** → tap the map → fill the form. The new fence arms immediately. |
| Notes | Type "return the library books on the way" and watch the suggestion row resolve to City Library / errands / pass-by. |
| Sharing | Generate a link, open it in a private window, then **Revoke** — the viewer's map stops updating on the next fix and says the share ended. |
| History | Range chips, then **GPX** / **GeoJSON** to download the day. |
| Settings | Toggle **Airgap mode**: the banner appears, the basemap switches to the local canvas, and egress channels stop being used. |

---

## 4. Mobile (iOS / Android)

```bash
cd client
EXPO_PUBLIC_LURA_API_URL=http://192.168.31.134:8080 npm start
```

Use **your machine's LAN address**, not `localhost` — on a phone, localhost is the
phone. Find it with `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).
The server already listens on all interfaces.

- **Expo Go** (scan the QR): everything works except the native GL map, which
  falls back to the locally drawn basemap.
- **Development build** (`npx expo run:ios` / `npx expo run:android`): real
  MapLibre Native, and "Publish my location" on the live map turns the phone into
  a tracked device.

---

## 5. The test suite

```bash
make test        # go test -race ./...
```

Covers the guards that are easy to get wrong: freshness gate, out-of-order fixes,
fly-by debounce, cool-off under GPS jitter, dwell arm/cancel/restart, quiet hours
across midnight and timezones, channel failover, trip segmentation, and a full
HTTP + WebSocket integration pass.

### Against a real PostgreSQL

```bash
cd deploy && docker compose up -d postgres && cd ..
make test-pg
```

This runs the same store conformance suite against PostGIS that the in-memory
store passes. It is worth running: it is what caught two real divergences between
the two implementations during development.

---

## 6. The real Phase 1 deployment

```bash
cd deploy
docker compose up -d --build          # PostGIS + ntfy + Lura (web bundle baked in)
```

<http://localhost:8080> — same app, now on PostgreSQL with `ST_DWithin` doing the
geofence queries. Check it took the real path:

```bash
curl -s localhost:8080/healthz | jq .store     # "postgres+postgis"
docker compose logs lura | head -20            # migrations, seeding, listening
```

Point the simulator at it exactly as before:

```bash
go run ./cmd/lurasim -interval 300ms -scale 40 -loops 1
```

### With the observability stack

```bash
LURA_OTLP_ENDPOINT=http://otel-collector:4318 \
LURA_OPENSEARCH_URL=http://opensearch:9200 \
docker compose --profile obs up -d
```

Give OpenSearch ~30 s, then:

| What | Where | Check |
|---|---|---|
| Metrics | <http://localhost:9090> | `lura_ingest_accepted_total`, `lura_geofence_events_total`, `lura_ws_connections` |
| Traces | <http://localhost:16686> | service `lura`, spans `ingest.accept` → `geofence.evaluate` → `notify.handle` |
| Logs | <http://localhost:5601> | index `lura-logs-*`; every record carries `trace_id` |
| Raw | `curl -s localhost:8080/metrics` | the same instruments, Prometheus format |

```bash
curl -s 'localhost:9090/api/v1/query?query=lura_ingest_accepted_total' | jq '.data.result[0].value[1]'
curl -s 'localhost:9200/lura-logs-*/_count' | jq .count
curl -s localhost:16686/api/services | jq .data
```

Tear down with `docker compose --profile obs down` (add `-v` to drop the data).

---

## 7. Common friction

| Symptom | Cause |
|---|---|
| `delivered: ["inapp"]` and no push | quiet hours — see §1 |
| A trigger fires once, then not again | cool-off is 30 min per device/place/trigger. `LURA_COOLOFF=10s` for testing. |
| Fixes accepted but no reminders | fixes older than `LURA_FRESH_WINDOW` (5 min) never fire, by design |
| Phone cannot reach the server | `localhost` on a phone is the phone — use the LAN IP (§4) |
| `docker compose up` cannot pull PostGIS | the official image is amd64-only; the compose default is the multi-arch build, override with `POSTGIS_IMAGE` |
| Map is a drawn grid, not streets | airgap mode, no WebGL2, or Expo Go — all three fall back deliberately |
| Data vanished after restart | the default store is in-memory; use `LURA_STORE=postgres` |
| `listen tcp :8080: bind: address already in use` | an earlier `go run ./cmd/lura` or the compose container is still holding the port: `lsof -ti:8080 \| xargs kill` |

Useful knobs while testing:

```bash
LURA_COOLOFF=10s LURA_ARRIVE_DEBOUNCE=5s LURA_FRESH_WINDOW=30s \
LURA_LOG_LEVEL=debug go run ./cmd/lura
```

At `debug` the engine narrates itself — `geofence: enter`, `geofence: exit`,
`geofence: dwell armed`, `geofence: suppressed by cool-off`, `geofence: dropped
stale fix` — which is usually the fastest way to answer "why did that not fire?".
