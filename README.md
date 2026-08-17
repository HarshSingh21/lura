# Lura

A private, self-hosted, AI-native location companion: live device tracking, places
you draw, reminders that fire when you arrive, leave, linger or pass by, expiring
share links, and a private history — all on infrastructure you control.

Phase 1 of [`lura_hld_v1.1.md`](lura_hld_v1.1.md), implemented end to end: a Go
monolith and one Expo codebase for web, iOS and Android. The design of what was
built is in [`docs/lura_lld_phase1.md`](docs/lura_lld_phase1.md).

Everything in the stack is open source, and nothing phones home:
[`docs/open-source.md`](docs/open-source.md).

---

## Run it

**No infrastructure at all** — in-memory store, demo workspace, live map:

```bash
go run ./cmd/lura                       # http://localhost:8080
```

Then, in another terminal, drive a virtual phone around the seeded places so the
map moves and reminders fire:

```bash
go run ./cmd/lurasim -interval 500ms -scale 30
```

**With the web client** (the control centre in the browser):

```bash
cd client && npm install && npm run build:web && cd ..
go run ./cmd/lura -web ./client/dist    # app and API on one origin
```

**The real Phase 1 deployment** — PostgreSQL + PostGIS, ntfy, one container:

```bash
cd deploy && docker compose up -d --build
docker compose --profile obs up -d      # + OpenTelemetry, OpenSearch, Jaeger, Prometheus, Grafana
```

The default control-plane token is `lura-dev-token`. Change `LURA_API_TOKEN`
before anything but localhost can reach it.

---

## The app

| Screen | What it does |
|---|---|
| **Sign in** | Keycloak's own hosted page — OTP, Google or X — over Authorization Code + PKCE; the app never sees a password |
| **Introduction** | a five-step tour on first sign-in, explaining the map, places, notes, sharing and the privacy switches |
| **Live map** | your devices *and* the people you are connected to, in real time over WebSocket, geofences, draw a place by tapping the map, the always-on "you are sharing" banner |
| **People** | two-way live sharing with another account: invite by email, accept, pause either direction independently, remove for both |
| **Places** | the geofence grid: radius, armed triggers, note and fire counts |
| **Notes** | type free text, the AI Brain suggests the place, tags and trigger, with its confidence and where it ran |
| **Sharing** | expiring/revocable links, a preview of exactly what a recipient sees, one-tap revoke |
| **History** | the day segmented into trips and stops, with GPX and GeoJSON export |
| **Settings** | airgap mode, quiet hours, devices and ingest tokens, channels, retention, which server this app talks to |

Mobile runs the same code. MapLibre Native needs a development build
(`npx expo run:ios` / `run:android`); in Expo Go the app falls back to a locally
drawn basemap and everything else works.

---

## Sending locations

Any OwnTracks client can point at `/pub`:

```bash
curl -X POST http://localhost:8080/pub \
  -H "Authorization: Bearer <device token>" \
  -H "Content-Type: application/json" \
  -d '{"_type":"location","lat":12.9611,"lon":77.6387,"tst":1770000000,"acc":8,"vel":0,"batt":82}'
```

Device tokens are issued in **Settings → Devices** (shown once, rotatable). The
mobile app can also publish its own position from the live map.

---

## API

```
POST   /pub                       OwnTracks-compatible ingest (device credentials)
GET    /ws                        live positions, geofence events, reminders
GET    /s/{token}                 public share view — no account
GET    /s/{token}/ws              public live stream
GET    /healthz /readyz /version /metrics

GET    /api/v1/overview           the whole workspace in one request
GET    /api/v1/me                 PATCH for airgap, quiet hours, timezone
CRUD   /api/v1/places             geofences (circle + radius + triggers)
CRUD   /api/v1/notes              POST returns the AI suggestion; /suggest previews it
CRUD   /api/v1/devices            + POST /{id}/token to rotate an ingest credential
CRUD   /api/v1/shares             DELETE revokes immediately
CRUD   /api/v1/channels           notification channels, tried in priority order
GET    /api/v1/history            trips and stops; /export?format=gpx|geojson

GET    /api/v1/people             every connection, both directions of consent
POST   /api/v1/people/invite      by email; a crossed invitation auto-accepts
POST   /api/v1/people/{id}/accept idempotent
PATCH  /api/v1/people/{id}        pause or resume *my* sharing
DELETE /api/v1/people/{id}        removes both directions
```

Control-plane calls take `Authorization: Bearer <token>` — a Keycloak access token
when `LURA_OIDC_ISSUER` is set, or the static `LURA_API_TOKEN` otherwise. Accounts
are created lazily from the token's claims on first use, so there is no separate
registration step to keep in sync with the realm.

---

## Configuration

Every value is an environment variable; the interesting ones:

| Variable | Default | Meaning |
|---|---|---|
| `LURA_STORE` | `memory` | `postgres` for the real path |
| `LURA_DATABASE_URL` | `postgres://lura:lura@localhost:5432/lura?sslmode=disable` | PostGIS DSN |
| `LURA_API_TOKEN` | `lura-dev-token` | control-plane bearer token |
| `LURA_AIRGAP` | `false` | refuse every outbound call |
| `LURA_FRESH_WINDOW` | `5m` | fixes older than this never fire reminders |
| `LURA_ARRIVE_DEBOUNCE` | `45s` | how long inside a fence confirms an arrival |
| `LURA_ARRIVE_MAX_SPEED_MPS` | `1.5` | …or how slow you must be for it to confirm sooner |
| `LURA_PASSBY_MIN_SPEED_MPS` | `3.0` | enter-while-moving threshold for pass-by |
| `LURA_COOLOFF` | `30m` | suppression window per device/place/trigger |
| `LURA_RETENTION_DAYS` | `90` | history retention; `0` keeps everything |
| `LURA_NTFY_URL` / `LURA_NTFY_TOPIC` | `https://ntfy.sh` / — | push channel |
| `LURA_OTLP_ENDPOINT` | — | OpenTelemetry collector, e.g. `http://localhost:4318` |
| `LURA_OPENSEARCH_URL` | — | ship logs straight to OpenSearch as well |
| `LURA_MAP_STYLE_URL` | OpenFreeMap positron | MapLibre style |

The geofence thresholds are the product defaults HLD §17 leaves open, which is
why they are configuration rather than constants.

---

## Development

```bash
make test          # go test -race ./...
make test-pg       # + the PostgreSQL conformance suite (needs a database)
make run           # server with the in-memory store
make sim           # the device simulator
make web           # build the Expo web bundle
make client        # Expo dev server (web + native)
make lint          # go vet + tsc --noEmit
```

---

## Privacy invariants

These are product-defining, not features (HLD §11), and the code is arranged so
they are hard to break:

- **Nothing leaves your infrastructure by default.** The AI suggester is local
  computation; a sidecar is opt-in and self-hosted.
- **Airgap mode** disables every egress path at once — telemetry exporters, push
  channels, remote basemap, AI sidecar — and says so in a banner you cannot miss.
  A notification channel must *declare* whether it leaves the box, so a new
  channel cannot quietly break the promise.
- **No covert sharing.** Every live share is listed to its owner with its token
  and a one-tap revoke, and a revoke drops the viewer's subscription on the next
  fix rather than at the end of a TTL.
- **Your data is yours.** GPX/GeoJSON export and history deletion are ordinary
  endpoints, and retention runs in-process rather than depending on an operator's
  cron.

---

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE).
