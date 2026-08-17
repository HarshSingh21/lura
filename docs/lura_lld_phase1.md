# Lura — Low-Level Design (LLD), Phase 1

**Version:** 1.0 · **Status:** Implemented · **Scope:** the code in this repository.

This document is the level below `lura_hld_v1.1.md`: what was actually built, why
each mechanism is shaped the way it is, and exactly where Phase 2 plugs in. The
HLD stays the source of truth for the target architecture; where this
implementation differs, §11 records the deviation and the reason.

---

## 1. What exists

A single Go binary (`cmd/lura`) that is, internally, the seven Phase 2 services
already separated by interfaces — plus one universal Expo client for web, iOS and
Android.

```
                         ┌──────────────────────── client (Expo) ───────────────────────┐
                         │  web (react-native-web + MapLibre GL JS)                     │
                         │  iOS / Android (React Native + MapLibre Native)              │
                         └──────────────┬──────────────────────────┬────────────────────┘
                              REST /api/v1                WebSocket /ws, /s/{token}/ws
                                        │                          │
┌───────────────────────────────────────▼──────────────────────────▼────────────────────┐
│ cmd/lura                                                                              │
│                                                                                       │
│  httpapi ──── auth ──── ingest ──▶ bus (in-process, NATS-shaped) ──┬──▶ ingest.Writer  │
│     │                                                              ├──▶ geofence      │
│     ├── hub (WebSocket fan-out, ACL re-subscription) ◀── core ─────┤                   │
│     ├── share  ◀────────────── geo.* ──────────────────────────────┤                   │
│     ├── history                                                    └──▶ notify        │
│     └── ai (rules | MiniLM sidecar)                                                    │
│                                                                                       │
│  store.Store ── postgres (PostGIS, optional Timescale) │ memory (tests, demos)         │
│  gate.Gate ──── memory (Valkey in Phase 2)                                             │
│  obs ────────── OpenTelemetry traces/metrics/logs → OTLP; Prometheus; OpenSearch       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Package map (`internal/`):

| Package | Responsibility | HLD section |
|---|---|---|
| `domain` | shared types, sentinel errors, no dependencies | §6 |
| `store` | persistence contract; `postgres`, `memory`, `storetest` conformance suite | §6 |
| `bus` | NATS-shaped in-process bus: core (at-most-once) + durable partitioned | §4 |
| `hub` | per-connection subscriptions, drop-to-latest, ACL re-subscription | §5.1 |
| `ingest` | `/pub` validation, rate limit, `recv_ts`, publish; `Writer` batches to the DB | §5.2, §5.3 |
| `geofence` | freshness gate, enter/exit, fly-by debounce, dwell timers, cool-off | §5.4 |
| `gate` | atomic cool-off claim (`SET NX EX` semantics) | §5.4 |
| `notify` | note resolution, quiet hours, channel failover, trigger events | §5.6 |
| `ai` | `Suggest()` — keyword rules now, MiniLM sidecar client ready | §5.7 |
| `share` | expiring/revocable links, auto-revoke on arrive, ACL events | §5.8 |
| `history` | trip/stop segmentation, GeoJSON/GPX export, retention | §5.9 |
| `httpapi` | REST + WebSocket transport, no business rules | §5.1, §8 |
| `auth` | Keycloak OIDC verification (stdlib only), static bearer, device credentials for `/pub` | §5.10, §16 |
| `connect` | mutual-consent connections; resolves who may watch whom | §5.8 |
| `obs` | OpenTelemetry setup, Prometheus endpoint, OpenSearch log shipper | §12 |
| `seed` | demo workspace matching the design mock | — |

---

## 2. The write path, end to end

```
POST /pub  ──▶ auth.DeviceAuth        credential → device
           ──▶ ingest.Payload.Validate  reject null island, out-of-range, bad accuracy
           ──▶ ratelimit.Allow(device)  token bucket, per device
           ──▶ stamp recv_ts (server clock, µs)
           ──▶ bus.PublishDurable(pos.<user>.<device>)   ← history + reminders
           ──▶ bus.Publish(pos.<user>.<device>)          ← live map
           ──▶ 200
```

Publish order is deliberate: durable first. Crashing between the two loses a live
frame (repainted seconds later) rather than a durable record (a lost reminder or
a hole in history).

**Idempotency.** The key is `(device_id, recv_ts µs)` plus an optional client
`seq` — never OwnTracks' `tst`, which has one-second resolution and collides for
two genuine fixes in the same second (HLD §5.2). In SQL this is the primary key
plus `ON CONFLICT DO NOTHING`; redelivery writes zero rows and returns no error.

**Monotonic last position.** One statement, guard in the `WHERE`:

```sql
UPDATE devices SET last_point = …, last_seen = $ts
WHERE id = $device AND (last_seen IS NULL OR $ts > last_seen)
```

An offline phone flushing an hour of queued fixes fills in history without
dragging the live marker backwards. `storetest` asserts this for both stores.

---

## 3. The geofence engine

The pipeline, in order, per fix:

```
freshness gate ──▶ monotonic evaluation ──▶ inside-set diff ──▶ debounce ──▶ cool-off ──▶ emit geo.<user>
```

**Freshness gate.** Fixes older than `FRESH_WINDOW` (default 5 min) are never
evaluated — they still reach the writer, so replayed history is complete, but they
cannot announce an arrival that already happened. The two paths are separate
subscribers precisely so this decoupling is structural rather than conditional.

**Monotonic evaluation.** Inside the fresh window, a fix older than the last one
evaluated for that device is skipped. Without it, an out-of-order fix would
resurrect a fence the device has already left and fire a bogus `leave`.

**Inside-set diff.** `PlacesContaining` is `ST_DWithin` over a GIST index in
PostgreSQL and a bbox pre-filter plus haversine in the memory store; `storetest`
asserts the two agree at the metre level. Phase 2 replaces this with Tile38
`enter`/`exit`/`cross` events — everything downstream is unchanged.

**Debounce (fly-by filter).** `arrive` confirms when the device *slows below*
`ARRIVE_MAX_SPEED_MPS` **or** *stays* for `ARRIVE_DEBOUNCE`. This is why the HLD
measures its < 2 s NFR from the confirming fix, not from first entry.

**Pass-by.** Enter while still moving (`speed ≥ PASSBY_MIN_SPEED_MPS`). Phase 1
applies it to place circles; the corridor geometry of HLD §5.5 changes the fence,
not this rule. The activation policy remains the open question the HLD flags.

**Dwell.** Armed on enter, persisted in the store (not a cache — HLD §17 lists
cache-only dwell timers as a data-loss risk), cancelled on exit, fired by a ticker
that re-checks the device is still inside. After a restart there is no in-memory
state, so the check falls back to the device's last known point and refuses to
fire on a fix older than the freshness window.

**Cool-off.** An atomic claim per `(device, place, trigger)` for `COOLOFF`
(default 30 min). Only the winner emits. Note what is deliberately *absent*: exit
does **not** release the claim. A fix jittering across a fence boundary produces
one reminder rather than twelve — the test `TestCoolOffSuppressesRepeatArrive`
exists because the first implementation got this wrong.

**Ordering.** The durable subscription is partitioned by `device_id`, so all fixes
for one device are evaluated by one goroutine in publish order. This is the same
guarantee HLD §5.4 gets from a partitioned JetStream consumer, and it is why the
per-device state needs no locking beyond a snapshot mutex.

---

## 4. Data model

Schema: `internal/store/postgres/migrations/0001_init.sql`. Highlights:

- `GEOGRAPHY(Point,4326)` everywhere — distances come out in metres without
  projecting, which is what `ST_DWithin` needs for radii.
- `positions` primary key `(device_id, recv_ts)`; GIST on `point`; composite index
  on `(user_id, recv_ts DESC)` for the history window query. Promoted to a
  TimescaleDB hypertable when the extension exists, and left a plain table when it
  does not (HLD §17: managed Postgres offerings do not have it).
- `places.updated_at` is stamped on every mutation because it is part of the AI
  Brain's embedding cache key (HLD §5.7) — a rename can never be answered from a
  stale embedding.
- `notes.place_id` is `ON DELETE SET NULL`: deleting a geofence must not delete
  the user's words.
- `pending_dwells` is a table, not a cache key.
- `connections` (`0002_connections.sql`) stores **two rows per relationship**, one
  per direction, each owned by the user in `user_id`. A single row with a pair of
  booleans would mean one person's `UPDATE` rewrites the other person's consent;
  splitting it makes "am I sharing with you" and "are you sharing with me"
  physically different rows with different owners, so the authorisation check is a
  read of a row the caller cannot write. `UNIQUE (user_id, peer_id)`,
  `CHECK (user_id <> peer_id)`, and a partial index on
  `(user_id) WHERE status='accepted' AND sharing` — the only shape the fan-out
  ever queries.
- `users_email_key` is a unique index on `lower(email) WHERE email <> ''`:
  invitations are addressed by email, and the empty string is what a device-only
  account has.
- `notes.body`, not `notes.text` — `text` is a type name in PostgreSQL and quoting
  it everywhere is a papercut waiting to become a bug.

---

## 5. Bus contract

| Subject | Path | Publisher | Consumers |
|---|---|---|---|
| `pos.<user>.<device>` | core | ingest | hub (live fan-out) |
| `pos.<user>.<device>` | durable, partitioned by device | ingest | writer, geofence |
| `geo.<user>` | durable, partitioned by user | geofence | notify, share |
| `geo.<user>` | core | geofence | hub (live UI) |
| `notify.<user>` | core | notify (in-app channel) | hub |
| `acl.<viewer>` | core | share | hub (re-subscription) |

Core is at-most-once and drops for slow subscribers; durable blocks the publisher
rather than losing a message. Phase 2 replaces `bus.InProcess` with core NATS +
JetStream behind the same interface.

---

## 6. API surface

Root paths kept short because external clients depend on them:

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/pub` | device token, Basic, or API token + `?device=` | OwnTracks-compatible; returns `[]` to OwnTracks clients |
| GET | `/ws` | bearer (header or `?access_token=`) | live positions, geo events, reminders |
| GET | `/s/{token}` | none | public share snapshot, `Cache-Control: no-store` |
| GET | `/s/{token}/ws` | none | public live stream |
| GET | `/healthz` `/readyz` `/version` `/metrics` | none | ops |

Control plane under `/api/v1` (bearer): `me`, `overview`, `events`, `devices`
(+ `/{id}/token` rotation), `places`, `notes` (+ `/suggest`), `shares`,
`channels`, `history` (+ `/export`, DELETE), `people`.

`/api/v1/overview` returns the whole workspace in one round trip — the control
centre's first paint is one request, which matters on the 2G/3G-class connections
HLD §2.2 targets.

### 6.1 Identity (`internal/auth`, `internal/httpapi/provision.go`)

Sign-in is Keycloak's problem; Lura's problem is deciding whether to believe the
token that comes back.

`auth.OIDC` verifies it against the realm's JWKS **with the standard library
only** — no OIDC dependency was added, because the whole verification is a
signature check plus five claim comparisons, and a library here would be a supply
chain for the one component whose compromise is total. The rejections that matter:
`alg: none` and any `HS*` (an attacker who knows the public key must not be able
to sign with it), a token with no `kid`, a JWKS key whose `use` is not `sig`, an
RSA key under 2048 bits, an EC key that is not P-256, and anything whose `typ` is
`Refresh`. Keys are cached with a TTL and re-fetched on an unknown `kid`, so a
realm rotation heals without a restart.

`auth.Chain` allows the static development token *alongside* OIDC, off by default
and loud in the logs when on, so `make dev` still works with `curl`.

**Provisioning is lazy.** With an external IdP a person exists before their
workspace does: the first authenticated request carries a `sub` with no row behind
it. `provisioner.ensure` creates the account from the claims on that request,
memoising the subject so the steady state is a map lookup. The alternative — a
registration webhook from Keycloak — has a failure mode where the two systems
drift apart, and cannot cope with a realm restored from backup or a user created
in the admin console.

### 6.2 Mutual sharing (`internal/connect`)

A share link (§6) is one-directional and anonymous. Connections are the other
half: two accounts that can each see the other on the live map.

| Method | Path | Effect |
|---|---|---|
| GET | `/api/v1/people` | each peer, both directions of consent, and their devices |
| POST | `/api/v1/people/invite` | by email; a crossed invitation auto-accepts |
| POST | `/api/v1/people/{peerId}/accept` | idempotent |
| PATCH | `/api/v1/people/{peerId}` | pause or resume *my* sharing |
| DELETE | `/api/v1/people/{peerId}` | removes both directions |

The authorisation rule is one function, `connect.Service.Subjects`, and it is
worth stating precisely because everything else depends on it:

> To decide whether **A** may watch **B**, read **B's** row. Never A's.

A row says "I am sharing with this person"; it is written only by its owner. So
the set of bus subjects A is allowed to receive is A's own positions plus
`pos.<B>.*` for every B whose own row says `accepted AND sharing`. Writing a row
into your own table claiming a view of someone else grants nothing, which is what
`TestCannotGrantYourselfAView` asserts by doing exactly that through the store,
below the service, and confirming the subject list does not change.

Pausing is `sharing = false` on the pauser's row, which drops the peer's subject
on their next resolve and, for an open socket, is pushed as an `acl` frame — the
peer's map stops updating within a frame rather than at the next reconnect.

Fan-out latency, measured in `internal/httpapi/latency_test.go` (p99 gate at
250 ms, actual on this hardware): **p50 110 µs / p99 320 µs** for your own device,
**p50 90 µs** for a peer's — publish-to-socket-write inside the server. Measured
from outside, over real HTTP and a real WebSocket on one machine, a peer's fix
lands in the watcher's socket in **p50 1.6 ms / p95 2.3 ms**, the difference being
the HTTP round trip. What a person experiences adds the phone's radio and the
internet, which no architecture on this side can shorten below the RTT.

**Empty is a shape too.** Go marshals a nil slice as `null`, so the first request
a brand-new account makes returns `null` for every collection — the one shape a
client is least likely to have been written against. `httpapi.list` wraps every
collection response, and `TestOverviewOfAnEmptyWorkspaceIsAllArrays` pins it.
This is not hypothetical: it took the People screen down to a white page for
anyone who had not created anything yet.

---

## 7. Client architecture (`client/`)

One Expo codebase, Expo Router, three surfaces.

| Concern | Choice | Notes |
|---|---|---|
| Server state | TanStack Query | mutations invalidate; no mirrored copies |
| Local state | Zustand | live positions, toasts, connection, UI flags only |
| Maps | MapLibre GL JS (web), MapLibre Native (iOS/Android), SVG canvas (fallback) | one `MapViewProps` contract for all three |
| Forms | React Hook Form + Zod | client rules mirror the server's validation |
| Fonts | Space Grotesk + JetBrains Mono, bundled | airgap applies to typography too |

**The map fallback is a product surface, not a stub.** It renders when airgap mode
is on (a remote basemap is an outbound call), in Expo Go (no native module), and
on any browser without WebGL2. Fences and markers are screen-space React views
projected with the same Web Mercator maths MapLibre uses, so the mock's marker
design survives on every renderer.

**Layout.** One shell, two shapes: sidebar + content + rail above 1080 px, top bar
+ content + tab bar below 840 px. The decision is width-based, not platform-based
— a small browser window and a phone deserve the same layout.

**The front door.** `app/_layout.tsx` holds one `Gate` component that answers, per
navigation, in this order: still reading the persisted session → splash; signed
out → `/login`; signed in but never introduced → `/onboarding`; otherwise render.
The order is not cosmetic — treating "not read yet" as "signed out" flashes the
login screen on every cold start, which is the single most common bug in this
pattern. `useRequireAuth` deliberately returns facts and does *not* navigate: a
hook that calls `router.replace` during a layout's render fights whatever else
that layout is doing and hides the routing decision from anyone reading the
routes. Two routes opt out — the share viewer, which is public by definition, and
the login screen, which is where the redirect points.

**Framing.** A live map centred on you at a fixed zoom will happily put the person
you are watching two screens away: the marker exists, the socket works, and the
product still fails, because "where are they" was the question. So when the *set*
of markers changes — a peer accepts, a second phone comes online — `features/live/fit.ts`
computes the zoom at which everyone fits and the map widens to it. It only ever
zooms out, and it keys on the marker set rather than on positions, so it cannot
yank someone who has deliberately zoomed in, and ordinary movement does not
re-frame the map under a person reading it. Every map renderer reports its pixel
size back through `onViewportChange`, because this is a question about pixels that
a zoom level alone cannot answer.

**Tokens.** The session stores access/refresh/ID tokens per key (SecureStore on
Android warns past 2 KB per entry) and renews a minute before expiry, because a
15-minute token and an app that sits open for a whole drive would otherwise stop
moving mid-journey. `api/client.ts` asks a *provider* for the bearer on every
request rather than capturing one — the dependency points auth → api, never back,
which is what keeps the refresh (itself an HTTP call) out of an import cycle. The
WebSocket and the history export use the awaiting variant: both carry the token in
a query string and neither can retry a 401.

---

## 8. Observability

- **Traces, metrics and logs** all leave over OTLP/HTTP to a collector; the
  collector routes logs → OpenSearch, traces → Jaeger, metrics → Prometheus.
- **Prometheus endpoint** on `/metrics` from the same instruments, so a collector
  outage does not blind the operator.
- **OpenSearch shipper** in-process as a second path, batching to `_bulk` with
  retry, dropping (and counting) rather than blocking a request path.
- Golden signals from HLD §12 are declared once in `internal/metrics`:
  ingest ack latency, positions written/stale, geofence eval latency,
  dropped-stale, cool-off suppressions, debounce holds, delivery latency, WS
  connections/drops, bus queue depth, store latency.
- Every log record carries `trace_id`/`span_id`, so a line in OpenSearch pivots to
  the trace that produced it.

**Airgap disables every exporter** and keeps stdout logs plus the inbound
`/metrics` endpoint.

---

## 9. Testing

| Suite | What it protects |
|---|---|
| `store/storetest` | one conformance suite run against both stores — it already caught a divergence in dwell re-arm semantics |
| `geofence` | freshness gate, out-of-order fixes, fly-by debounce, pass-by, cool-off (incl. jitter), dwell arm/cancel/restart |
| `ingest` | payload validation, km/h → m/s, server-clock authority, per-device rate limit, writer batching and idempotency |
| `notify` | note resolution, quiet hours across midnight and timezones, retry vs failover, airgap egress ban |
| `history` | segmentation, absorbed traffic-light stops, mode classification, impossible-jump rejection, GeoJSON axis order, GPX schema |
| `bus`, `hub`, `gate`, `ratelimit` | ordering, drop-to-latest, ACL revoke, single-winner claims, bucket refill |
| `auth` | JWKS verification: `alg: none`, `HS*` with the public key, missing `kid`, `use != sig`, undersized RSA, non-P-256 EC, a refresh token used as an access token |
| `connect` | consent in both directions, crossed invitations, idempotent accept, symmetric removal, and that writing your own row grants you nothing |
| `httpapi` | the whole stack over real HTTP + WebSocket: auth, CRUD, `/pub` → geo event → reminder, share lifecycle, exports |
| `httpapi` (two-person) | both sides publish from their own device credentials and each sees the other; pausing cuts the peer off on the open socket; removal revokes both ways; every People route is scoped to its caller |
| `httpapi` (latency) | publish-to-socket p99 under 250 ms, for your own device and for a peer's |

`go test -race ./...` is green. The PostgreSQL conformance run is skipped unless
`LURA_TEST_DATABASE_URL` is set (see `make test-pg`).

---

## 10. Deployment

`deploy/docker-compose.yml`, two profiles: `core` (PostGIS + ntfy + Lura) and
`obs` (collector, OpenSearch + Dashboards, Jaeger, Prometheus, Grafana). The
image builds the web bundle and the Go binary and serves both from one origin, so
Phase 1 is one container plus a database.

---

## 11. Deviations from the HLD, and why

1. **Control-plane paths are under `/api/v1`**, not at the root. The same origin
   serves the web client, and the wire contract needs to version independently.
   `/pub`, `/ws` and `/s/{token}` keep their short root paths because OwnTracks
   clients and shared links depend on them.
2. **Pass-by is place-level**, not corridor-level. HLD §5.5 flags corridors as an
   unsolved design item; the trigger condition (enter while moving) is implemented
   and the geometry swap is additive.
3. **Dwell timers live in the store, not a cache**, closing the risk in HLD §17
   rather than inheriting it.
4. **The client is Expo for all three surfaces**, as HLD §14 requires; the design
   mock's desktop layout is reproduced with react-native-web rather than a
   separate web codebase.
5. **Timescale is optional.** The hypertable is created when the extension is
   present and skipped otherwise, so the same build runs on managed Postgres.
6. **Shares are not seeded into a real database** — only into the throwaway memory
   store — because a share is a live grant of location data.

---

## 12. What Phase 2 changes

| Component | Change | Blast radius |
|---|---|---|
| Bus | `bus.InProcess` → core NATS + JetStream | one constructor in `main` |
| Geofence | inside-set diff → Tile38 enter/exit/cross | `Evaluate`'s first half |
| Cool-off / dwell | `gate.Memory` → Valkey `SET NX EX` | one constructor |
| Auth | static bearer → Zitadel JWT | `auth.Authenticator` implementation |
| AI | rules → MiniLM sidecar | already implemented behind `ai.Suggester` |
| Push | ntfy → + UnifiedPush/WebPush/FCM/APNs | new `notify.Notifier`s |
| Maps | OpenFreeMap → self-hosted PMTiles + Photon | one config value |
| Topology | one container → Kubernetes with HPA | compose → manifests |

The interfaces that make each of these a swap rather than a rewrite are the
deliverable of Phase 1 as much as the running product is.
