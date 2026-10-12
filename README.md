# Lura

A private, self-hosted, AI-native location companion: live device tracking, places
you draw, reminders that fire when you arrive, leave, linger or pass by, expiring
share links, and a private history — all on infrastructure you control.

Two people who connect see each other move on the live map, and either can draw a
fence — a circle, a polygon or a freehand outline — watch the other on it, and
write a note such as "buy milk" that fires when *the other person* passes the shop
and reaches both of them. Every crossing arrives once, as a toast, an entry in the
notification centre and a short chime. What changed in this release is in
[`docs/release-notes.md`](docs/release-notes.md).

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
| **Live map** | your devices *and* the people you are connected to, in real time over WebSocket: each person in their own colour, gliding between fixes with a heading cone, an accuracy ring and a fading trail, a pulse while their last fix is under two minutes old, and **Follow** to keep the camera on one of them. **Draw** a circle (press the centre, drag the radius), a polygon (tap corners, tap the first or **Done**) or a freehand outline; drag any fence to move it, its edge to resize, its corners to reshape. A basemap picker (streets, light, dark, satellite, hybrid, terrain) remembered per viewer. **Publish my location** turns this browser or phone into a tracked device, and keeps publishing on every screen |
| **Top bar** | the notification centre: every crossing and reminder of the session, once each, with an unread badge, mute and mark-all-read; tap an entry to open it on the map. A pending reminder stays on screen as a card with **Acknowledge** until it is acknowledged, in any session |
| **People** | two-way live sharing with another account: invite by email, accept, pause either direction independently, remove for both; each person shows whether they share with you, with a shortcut to a note about them |
| **Places** | the geofence grid: shape, armed triggers, note and fire counts, and **Edit on map** for the outline; the place form picks connected people to *watch* on the fence |
| **Notes** | type free text, the AI Brain suggests the place, tags and trigger, with its confidence and where it ran; then choose *whose movement* fires it (me or a connected person) and *who is notified* (me and/or connected people) |
| **Sharing** | expiring/revocable links, a preview of exactly what a recipient sees, one-tap revoke |
| **History** | the day's activity: a day picker, the day's track and stops on the map, and a timeline beside it — trips and stops, crossings (yours and watched people's), reminders and their acknowledgements, connection and share-link changes; tap an entry to focus it on the map. GPX and GeoJSON export |
| **Settings** | airgap mode, quiet hours, notification sounds (mute, and a preview of each chime), desktop alerts, devices and ingest tokens, channels, retention, which server this app talks to |

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
GET    /ws                        live positions, geofence events, reminders, reminder_ack
GET    /s/{token}                 public share view — no account
GET    /s/{token}/ws              public live stream
GET    /healthz /readyz /version /metrics

GET    /api/v1/overview           the whole workspace in one request
GET    /api/v1/me                 PATCH for airgap, quiet hours, timezone
CRUD   /api/v1/places             geofences (circle or polygon + triggers + watched people)
CRUD   /api/v1/notes              POST returns the AI suggestion; /suggest previews it
                                  PATCH on a place (or PUT) or a note changes only the fields sent
CRUD   /api/v1/devices            + POST /{id}/token to rotate an ingest credential
CRUD   /api/v1/shares             DELETE revokes immediately
CRUD   /api/v1/channels           notification channels, tried in priority order
GET    /api/v1/history            trips and stops; /export?format=gpx|geojson
GET    /api/v1/reminders          ?status=pending|acknowledged|all&limit= (default 100, max 500), newest first
POST   /api/v1/reminders/{id}/ack idempotent; only the recipient (404 for anyone else)
GET    /api/v1/activity           ?from=&to=&limit= (default the last 24 h, 200 items, max 1000), newest first

GET    /api/v1/people             every connection, both directions of consent
POST   /api/v1/people/invite      by email; a crossed invitation auto-accepts
POST   /api/v1/people/{id}/accept idempotent
PATCH  /api/v1/people/{id}        pause or resume *my* sharing
DELETE /api/v1/people/{id}        removes both directions
```

### Fences, watches and notes for other people

A place is a circle or a polygon:

```jsonc
{ "name": "Grocery", "shape": "circle", "center": {"lat":12.973,"lon":77.642}, "radiusM": 80,
  "triggers": ["arrive","passby"], "watchUserIds": [] }

{ "name": "Grocery", "polygon": [{"lat":12.9734,"lon":77.6414}, {"lat":12.9734,"lon":77.6426}, {"lat":12.9726,"lon":77.6422}],
  "triggers": ["passby"], "watchUserIds": ["usr_…nishtha"] }
```

- `shape` is `"circle"` (the default) or `"polygon"`; a request with a non-empty
  `polygon` and no `shape` is a polygon. `polygon` is an open ring of 3–200
  vertices that must not cross itself (`400 invalid_polygon`), and is `[]` for a
  circle, never `null`. For a polygon the server computes `center` (the centroid)
  and `radiusM` (centroid to the furthest vertex, at most 5000 m) and ignores what
  the client sent for them. A circle's `radiusM` is 20–5000.
- `watchUserIds` are connected people whose crossings of this fence notify you.
  Each must be an accepted connection (`400 not_connected`). A watch is only
  evaluated while *that person* shares live with you: pausing stops it on their
  next fix.
- **Moving a fence** is a `PATCH /api/v1/places/{id}` with the new geometry — any
  subset of `name, tags, shape, center, radiusM, polygon, triggers, dwellMins,
  watchUserIds`. A new `center` alone moves a polygon rigidly; a new `polygon`
  reshapes it; a `shape` change converts between the two. The engine reads the
  geometry on every fix, so a device the move left outside gets a normal `leave`.

A note can be about someone else's movement and reach more than you:

- `watchUserId` — whose movement fires it: `""` (your own devices, the default)
  or an accepted connection, whose live position shared with you fires it.
- `notifyUserIds` — who receives it: `[]` means just you; otherwise you and/or
  accepted connections. Both fields are checked on create and on update
  (`400 not_connected`).

On the live socket, a `geo` event's `userId` is always the **place owner**;
`subjectUserId` / `subjectName` say whose device crossed. A `notify` reminder
carries `kind` — `"note"` (notes fired, or your own crossing) or `"watch"` (a
person you watch crossed your fence and no note covered it, titled like
"Nishtha arrived at Grocery") — and `fromUserId` / `fromName` when the note or
fence belongs to someone else. Each recipient's own channels and quiet hours
apply. The watched person is not told about a watch — the event goes out on the
owner's subject only — unless a note names them as a recipient.

### Reminders and acknowledgements

Every delivered reminder is stored per recipient *before* it is published, so a
pending one is still there after a reload, on another device, after signing out
and in, and after a restart. `GET /api/v1/reminders` returns
`{"reminders": [...]}` of records:

```jsonc
{ "id": "rem_…", "userId": "<recipient>", "ownerId": "<note or place owner>", "noteIds": ["nte_…"],
  "placeId": "plc_…", "placeName": "Grocery", "trigger": "passby", "kind": "note",   // note | watch | ack
  "title": "Passing Grocery", "body": "buy milk", "subjectUserId": "usr_…", "subjectName": "Nishtha",
  "fromUserId": "usr_…", "fromName": "Harsh",          // only when someone else's note or fence
  "eventId": "geo_…",                                  // the crossing's GeoEvent id; "" for kind "ack"
  "createdAt": "…", "status": "pending",               // pending | acknowledged
  "ackedAt": "…", "ackedBy": "usr_…" }                 // once acknowledged
```

The live `notify` frame carries the same fields (its `id`, `status`, `ownerId`,
`eventId`, `createdAt`, … are the stored record's) alongside the crossing in
`event`. An owner's own crossing with no note is a live toast only: it has no
`id` and nothing to acknowledge, and a redelivered crossing never stores a
second record for the same person.

`POST /api/v1/reminders/{id}/ack` returns `{"reminder": {...}, "notesDone":
["nte_…"]}` and publishes a `reminder_ack` frame `{"id", "ackedAt"}` to every
session of the recipient, which clears the card everywhere. Acknowledging again
changes nothing. The first acknowledgement also:

- when the recipient is not the note's owner, stores and sends the owner a
  `kind: "ack"` reminder, already acknowledged ("Nishtha acknowledged buy milk");
- marks the note `done` when the recipient is its owner, or when every
  recipient's reminder for it has been acknowledged (`notesDone` lists them).

### Activity

`GET /api/v1/activity` is the History screen's timeline: `{"items": [...],
"from", "to"}`, newest first, every item with `type`, `id` and `ts`, read from
the store so it survives a restart. `from` after `to` is `400`.

| `type` | what it is | fields beyond `type`, `id`, `ts` |
|---|---|---|
| `trip` | a movement of one of your devices (`ts` is its start) | `deviceId, deviceName, mode, startTs, endTs, distanceM, fromPlace?, toPlace?, path` |
| `stop` | a stay of one of your devices | `deviceId, deviceName, startTs, endTs, atPlace?, point?` |
| `geo` | a crossing of one of your fences, by you or a person you watch | `eventId` (the GeoEvent id, as in the reminder's `eventId`), `triggerEventId` (the trigger-history row), `placeId, placeName, trigger, deviceId, subjectUserId, subjectName, noteIds, delivered` |
| `reminder` | a reminder you received | `reminder` (the record above, with its current status) |
| `ack` | an acknowledgement: yours, or someone acknowledging your note | `reminderId, title, body, placeName, noteIds, ackedBy, ackedByName, byMe` |
| `connection` | a connection invited, accepted, paused, resumed or removed | `action, peerId, peerName, byMe` |
| `share` | a share link created or revoked | `action` (`created`/`revoked`), `shareId, label, mode, reason?` |

Trips and stops are only ever your own devices; a connected person's movement
appears only as the crossings of your fences you watch them on, never as a
track. A `geo` item recorded before 0.2.0 has its trigger-history id as
`eventId`, so a client joining reminders to crossings should fall back to the
fence, trigger and time.

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
| `LURA_MAP_PROVIDER` | `maplibre` | `mappls` to draw Mappls maps instead ([`docs/mappls.md`](docs/mappls.md)); airgap overrides it |
| `LURA_MAPPLS_WEB_KEY` | — | Mappls Web SDK access token (a domain-restricted browser key) |

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

`e2e/run.sh` is the two-browser suite — see [End-to-end test](#end-to-end-test).

---

## End-to-end test

`e2e/` plays the release scenario in two real browsers: Harsh and Nishtha sign
in through Keycloak, connect, watch each other move, Harsh draws, moves and
reshapes fences, Nishtha's route crosses the grocery and both browsers must show
the toast, the badge and one chime — then every basemap, then pause, resume and
remove. Nine steps, each asserted in the UI and on the wire; the run stops at the
first failure.

Needs Docker with Keycloak running as `lura-keycloak` on :8085
([`deploy/keycloak/README.md`](deploy/keycloak/README.md)), Go, Node 20+ and
Google Chrome (`E2E_CHROME` if it is not in `/Applications`). The script adds the
two test users to the running realm if they are missing, builds the web bundle,
server and simulator, installs `playwright-core`, and starts its own server.

```bash
e2e/run.sh                                  # MapLibre on localhost, then Mappls on lura.com if a key is set
E2E_PHASES=maplibre e2e/run.sh              # one phase only
E2E_STEPS=6,8 E2E_SEED=1 e2e/run.sh         # steps 1–3 plus these; step 4's fences come from the API
E2E_KEEP_RUNNING=1 e2e/run.sh               # leave Lura serving the build afterwards
E2E_STORE=postgres E2E_PORT=8091 e2e/run.sh # on a throwaway PostGIS, with a restart in step 5
e2e/edge.sh sync                            # the sync edge cases, on :8096
e2e/edge.sh fences-ui                       # fences, notifications and every screen, on :8097
```

| Switch | Meaning |
|---|---|
| `E2E_PORT` | server port (default `8080`). Whatever already listens there is stopped. |
| `E2E_PHASES` | `maplibre`, `mappls` or both (default). Mappls is skipped without `LURA_MAPPLS_WEB_KEY`. |
| `E2E_STEPS` | comma-separated steps to run; 1–3 (sign in, connect, publish) always run |
| `E2E_SEED` | `1` creates step 4's fences and note through the API instead of drawing them |
| `E2E_KEEP_RUNNING` | `1` leaves Lura running on `E2E_PORT` when the run ends |
| `E2E_OUT` | where results go (default a fresh temp dir) |
| `E2E_SUITE` | `scenario` (default), `edge-sync` or `edge-fences-ui` — what `e2e/edge.sh` sets |
| `E2E_STORE` | `memory` (default) or `postgres`: a PostGIS container of the run's own (below) |
| `E2E_KEEP_DB` | `1` leaves the PostGIS container running after the run |
| `E2E_WEB_DIR` | where the web build goes (default `$E2E_OUT/web`, so parallel runs never share one) |
| `E2E_SKIP_BUILD` / `E2E_COOLOFF` / `E2E_HEADED` | reuse the build in `E2E_WEB_DIR` / the cool-off for the run (`15s`) / show the browsers |

**On Postgres.** `E2E_STORE=postgres` starts `lura-e2e-pg-<port>`
(`ghcr.io/baosystems/postgis:17-3.5`, or `E2E_PG_IMAGE`) on
`127.0.0.1:5<port>` — 58091 for port 8091 — waits until PostGIS answers over
TCP, and gives each phase a fresh database (`lura_maplibre`, `lura_mappls`) that
Lura migrates on boot. A container left by an earlier run on the same port is
replaced; the container is removed at the end unless `E2E_KEEP_DB=1`. It works
for the edge suites too (`E2E_STORE=postgres e2e/edge.sh sync`).

**Restarting Lura mid-run.** Each phase writes `$E2E_OUT/<phase>/restart.sh`
and passes its path to the suite as `E2E_RESTART`; it is also what starts the
server the first time, so a restart is the same launch. Suites call it through
[`e2e/lib/server.mjs`](e2e/lib/server.mjs):

```js
import { canKeepData, duringRestart, restartServer } from './lib/server.mjs';

if (canKeepData()) {                      // E2E_STORE=postgres and run through run.sh
  const { stoppedAt, readyAt } = await restartServer({ downMs: 1500 });
  // SIGTERM (Lura says "closing" on every socket), 1.5 s down, same env and
  // database, resolved once /readyz answers.
}
duringRestart(errorWallClockMs);          // was this console error the outage we caused?
```

On Postgres, step 5 restarts Lura with both browsers open and checks that the
fences, note, connection and devices survive and that both apps reconnect on
their own.

Each phase writes `results.json`, screenshots and `server.log` to
`$E2E_OUT/<phase>/`; nothing is written inside the repository. The exit status
is non-zero if any phase failed.

The Mappls phase serves the app as `http://lura.com:<port>`, because a Mappls
web key is checked against the page's domain ([`docs/mappls.md`](docs/mappls.md)).
Chrome is pointed at 127.0.0.1 for that name, so the run needs no hosts entry;
to open the same build yourself, add one:

```bash
echo '127.0.0.1 lura.com' | sudo tee -a /etc/hosts     # then http://lura.com:8080
```

The imported realm accepts redirects on port 8080 only (`localhost` and
`lura.com`). `run.sh` adds the run's port to the `lura-app` client (and to
`lura-app-edge`, the edge-sync suite's 60 s-token twin) before it starts, so any
`E2E_PORT` signs in; to do it by hand, see
[`deploy/keycloak/README.md`](deploy/keycloak/README.md#changing-a-running-realm).

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
- **Being watched rides on your own switch.** A connected person's fences and
  notes evaluate your position only while *your* sharing toward them is on —
  their side cannot opt in for you. Pausing stops it on your next fix, without a
  "left" event they could read anything into; removing ends both directions and
  takes you off their watch and recipient lists.
- **Your data is yours.** GPX/GeoJSON export and history deletion are ordinary
  endpoints, and retention runs in-process rather than depending on an operator's
  cron.

---

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE).
