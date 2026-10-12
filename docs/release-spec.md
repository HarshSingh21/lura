# Release spec: two-way live tracking, drawable geofences, peer reminders

This is the contract the parallel workstreams build against. The TypeScript side is
already in `client/src/api/types.ts` and `client/src/components/map/types.ts`; the
Go side must serialise to exactly those JSON field names.

The reference scenario: **Harsh** and **Nishtha** are connected (People screen),
both share live. Each sees the other moving on the map in real time. Harsh draws
a polygon around a grocery store, watches Nishtha on it, and adds a note
"buy milk" that fires when *Nishtha* passes it and notifies *both* of them. When
her location crosses the fence, both browsers show a toast with a sound.

## 1. Places (geofences)

- `shape`: `"circle"` (default when omitted) or `"polygon"`.
- `polygon`: `[{lat,lon}, ...]`, 3–200 vertices, ring not closed, must not
  self-intersect (reject with 400 `invalid_polygon`). `[]` for circles, never null.
- For polygons the server computes `center` (centroid) and `radiusM` (max
  distance centroid→vertex, rounded up) so indexing, fitting and listing keep
  working. Clients send only `polygon` for a polygon.
- `watchUserIds`: `[]` by default. Every id must be an **accepted** connection of
  the owner (400 `not_connected` otherwise). A watched peer's crossing of this
  fence is only evaluated while that peer's sharing toward the owner is live
  (`Connection.Live()` on the peer's row). Pausing stops it immediately.
- `PATCH /api/v1/places/{id}` accepts any subset of `name, tags, shape, center,
  radiusM, polygon, triggers, dwellMins, watchUserIds`. Moving a fence = PATCH
  with the new geometry. The engine must re-evaluate containment against the new
  geometry on the next fix (no stale inside-state for a moved fence: a device that
  is no longer inside after the move gets a normal `leave`).
- Containment: circle = haversine ≤ radius; polygon = point-in-polygon (memory
  store, ray casting on lat/lon is fine at city scale) / `ST_Covers` on
  `boundary::geometry` (Postgres: the ring is stored in a `geography(Polygon,4326)`
  column from `0003_polygons_peers.sql`, but judged planar in lon/lat like the map
  draws it — `0004_planar_polygons.sql`). On-edge counts as inside.

## 2. Notes for and about other people

- `watchUserId`: `""` = the owner's own devices fire it; otherwise a connected peer
  whose live position (shared toward the owner) fires it.
- `notifyUserIds`: who gets the reminder. `[]` means `[owner]`. Each id = owner or
  an accepted connection. Validate both fields on create and patch (400
  `not_connected`).
- A recipient who is not the owner receives the reminder on their own notify
  subject with `fromUserId`/`fromName` set to the owner. Their channels and quiet
  hours apply to them.

## 3. Live events

- `GeoEvent` gains `subjectUserId` (whose device crossed) and `subjectName`.
  `userId` stays the **place owner**.
- Geo events for a peer crossing an owner's watched fence are published to the
  owner's geo subject (and the owner's notify subject as a `kind:"watch"`
  reminder, title like "Nishtha arrived at Grocery"). The peer does not learn
  that they are being watched beyond what People already shows.
- `Reminder.kind`: `"note"` or `"watch"`.
- Cooloff stays per device/place/trigger.

## 4. Client

- **Map**: basemap switcher (`BasemapId`: streets, satellite, hybrid, light,
  dark, terrain) for MapLibre web + native and Mappls web, persisted per viewer.
  Satellite/hybrid for MapLibre: Esri World Imagery raster
  (`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
  with attribution), hybrid adds a labels layer; airgap keeps the offline style.
- **Live markers**: per-person colour, smooth glide between pings
  (`animateMs`), heading cone, accuracy circle, pulse, a fading trail of recent
  points, a ripple on arrival, follow-person camera mode.
- **Geofence editor** (`FenceEditor.tsx`, a React overlay using
  `projection.ts`, so it works over every renderer): draw circle (press centre,
  drag radius), draw polygon (tap vertices, tap first vertex / "Done" to close,
  undo last), freehand (drag a shape, simplified to ≤ 60 vertices), move any
  fence by dragging its body, resize a circle by its edge handle, reshape a
  polygon by dragging vertices. Persist via PATCH on gesture end.
- **Notifications**: in-app toast + notification centre (unread badge), a short
  synthesised chime (Web Audio on web, expo-audio/haptics on native) distinct for
  arrive/leave/pass-by, browser `Notification` when the tab is hidden and
  permission is granted, a mute toggle.
- **Notes composer**: pick place, trigger, "whose movement" (me / a connected
  person), "notify" (me and/or connected people). Place form: "watch" people.

## 5. Test identities

Keycloak realm `lura` gets `harsh@lura.local` / `lura-harsh` and
`nishtha@lura.local` / `lura-nishtha` (first names Harsh / Nishtha), and the `lura`
client accepts `http://lura.com:8080/*` as well as localhost.

## 6. Reminders that wait for an acknowledgement

The commute case: Harsh drives home → office; the Grocery fence on the way has
an open note "buy milk". When he passes, the reminder must keep demanding
attention until he presses **Acknowledge** — and that must survive reloads,
other tabs/devices, signing out and back in, and a server restart.

- Every delivered reminder is stored per recipient as a `Reminder` record
  (Postgres table `reminders`, migration `0005_reminders_activity.sql`; the
  memory store mirrors it):
  `{id, userId (recipient), ownerId, noteIds[], placeId, placeName, trigger,
  kind, title, body, subjectUserId, subjectName, fromUserId, fromName,
  eventId, createdAt, status: "pending"|"acknowledged", ackedAt?, ackedBy?}`.
  The WS `notify` frame carries this record (adds `id` and `status` to the
  existing `Reminder` JSON; existing fields unchanged).
- `GET /api/v1/reminders?status=pending|acknowledged|all&limit=` (newest first),
  `POST /api/v1/reminders/{id}/ack` (idempotent; only the recipient; 404
  otherwise) → publishes a `reminder_ack` frame `{id, ackedAt}` to all of the
  recipient's sessions, and, when the recipient is not the note owner, a
  `kind:"ack"` notification to the owner ("Nishtha acknowledged buy milk").
  Acknowledging a reminder for a note also marks that note `done` when the
  recipient is the owner, or when every recipient has acknowledged.
- Client: a pending reminder is a **sticky** card (not an auto-dismissing
  toast) with an Acknowledge button. Its chime repeats every
  `REMIND_EVERY_MS` (default 60 s) while pending and the tab is visible, plus a
  desktop notification (`requireInteraction: true`) when hidden. On sign-in,
  page load and WS reconnect the client loads `GET /api/v1/reminders?status=pending`
  and shows them. An ack in any session clears it everywhere within a second.
  Mute silences sound only; the card stays.

## 7. History is the user's activity

- `GET /api/v1/activity?from=&to=&limit=` returns a merged, newest-first
  timeline: `{type: "trip"|"stop"|"geo"|"reminder"|"ack"|"connection"|"share",
  ts, ...}` built from stored positions/trips/stops, trigger events, reminders
  (with ack state) and connection changes (invited, accepted, paused, resumed,
  removed). Everything comes from the store (Postgres in production), so it is
  there after signing in again or a restart.
- History screen: a day picker; the map shows the day's track(s) and stops;
  beside it the activity timeline ("08:42 left Home", "08:51 passed Grocery —
  reminder buy milk", "08:52 acknowledged", "09:05 arrived Office", "Nishtha
  passed Grocery"); tapping an item focuses it on the map. Peers' movements
  appear only as events the user was entitled to (watched fences), never their
  full track.
