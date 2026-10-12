# Release notes: live tracking between people

This release turns Lura from "where are my devices" into "where are the people I
have chosen to share with". Two people who connect see each other move on the
map, draw fences around the places that matter, and leave notes that fire on
*someone else's* movement. The contract it was built against is
[`release-spec.md`](release-spec.md).

---

## Highlights

- **See each other move, live.** Connected people appear on the live map in
  their own colour, which is the same on every screen and device. Markers glide
  between fixes instead of jumping, and show a heading cone, an accuracy ring, a
  fading trail of recent fixes, a ripple when a new fix lands, and a pulse while
  the last fix is under two minutes old. **Follow** in the rail keeps the camera
  on one person or device.
- **Draw fences by hand.** Draw a circle (press the centre, drag out the
  radius), a polygon (tap the corners; tap the first corner or **Done** to close;
  undo the last one), or a freehand outline, which is simplified to at most 60
  corners. Drag a fence's body to move it, a circle's edge to resize it, a
  polygon's corners to reshape it; tap a midpoint "+" to add a corner, long-press
  or right-click a corner to remove it. Every change is saved when you let go.
  The editor works the same over every map, including airgap mode. **Places →
  Edit on map** opens a fence in it.
- **Watch people on a fence.** A place can list connected people to watch. When
  one of them crosses it, you hear "Nishtha arrived at Grocery".
- **Notes for and about other people.** A note now says *whose movement* fires
  it (you, or a connected person) and *who is notified* (you and/or connected
  people). "Buy milk when Nishtha passes the grocery, tell us both" is one note.
- **A notification centre.** A bell in the top bar collects every crossing and
  reminder once, with an unread badge, mute and mark-all-read; tapping an entry
  opens it on the map. Each trigger has its own short chime — arrive rises,
  leave falls, pass-by flicks, dwell knocks twice, a watched person rings a
  two-tone bell — synthesised in the browser rather than shipped as audio files.
  **Settings** previews each chime, mutes them, and turns on desktop alerts for a
  tab you are not looking at.
- **Basemaps.** Streets, light, dark, satellite, hybrid and terrain, picked on
  the map and remembered per viewer. Satellite and hybrid use Esri World Imagery
  (hybrid adds labels and roads). With Mappls as the provider, Mappls draws the
  styles it has for your key and MapLibre draws the rest. Airgap mode keeps the
  local basemap.
- **More accurate publishing from the browser.** "Publish my location" asks for
  the best fix the device has, never a cached one, drops duplicates and rough
  guesses worse than 100 m (unless nothing better has arrived for 30 s), and sends
  at most one fix every 2 s while moving and one every 30 s while still. It keeps
  publishing on every screen, not only the map. A signed-in browser registers a
  device of its own ("Web browser") on its first fix.
- **Test people and an end-to-end suite.** The Keycloak realm seeds Harsh and
  Nishtha, and `e2e/run.sh` plays the whole scenario in two real browsers
  (README, *End-to-end test*).

---

## How people, fences and notifications fit together

**People.** A connection has two directions, each with its own switch: what *I*
share with you, and what *you* share with me. Either person controls only their
own direction.

**Fences.** A fence belongs to the person who drew it. It can be a circle or a
polygon. It can list people to *watch* — only people you are connected to.

**When does a fence look at someone?** Your own devices are always checked
against your own fences. Someone else's position is checked against your fences
only when you watch them on that fence (or a note of yours on it is about them)
**and** they are sharing with you right now. Their switch decides, never yours.

**Who hears about it?**

- You cross your own fence: you get the toast, as before, plus any of your
  notes on it.
- A person you watch crosses your fence: you get "Nishtha arrived at Grocery".
  If one of your notes covers that crossing, the note is the message, so it is
  still one ping.
- A note goes to everyone it names. A person who is not the note's author sees
  who it is from ("from Harsh"), and their own channels and quiet hours apply,
  not the author's.
- The person being watched is not told about the watch; the event is the fence
  owner's alone — unless a note names them as a recipient.

One crossing is one toast, one notification-centre entry and one chime, even
when it arrives as both a crossing and a reminder.

---

## Privacy

- **Pause** (your switch toward a person on People) stops your position reaching
  them on your next fix, without either of you reloading. It also stops their
  fences and notes from evaluating you from that same fix, and anything that
  was mid-way — being inside one of their fences, a dwell timer running — is
  dropped silently: no "left" event is raised that they could read anything
  into. A dwell timer that matures while you are paused does not fire. Resume
  and evaluation starts again from your next fix.
- **Remove for both** deletes both directions. You come off their watch lists
  and recipient lists, and they come off yours. A note that was *about* the
  removed person is kept as written but never fires again unless you reconnect —
  turning it into a note about your own movement would be a silent change of
  meaning.
- Notes reach a recipient only while they are still connected to the author:
  removing someone stops your notes reaching them, including notes written
  before.
- A watched person's crossing never ends the fence owner's "until I arrive"
  share link; only the sharer's own arrival does.
- Places you are inside are only listed on your own overview for your own
  fences, so nobody learns which of someone else's fences they are in.

Everything else in the README's *Privacy invariants* still holds.

---

## Upgrading

- **Database.** PostgreSQL deployments get migration
  `0003_polygons_peers.sql`. It runs automatically on boot — migrations are
  embedded in the binary and applied in order under an advisory lock while
  `LURA_MIGRATE` is on, which is the default. If you run with
  `LURA_MIGRATE=false`, apply it yourself before starting the new version. It is
  additive: it adds the polygon, watch-list and note-people columns with
  defaults, so every existing place becomes a circle and every existing note
  stays "my movement, notify me". The in-memory store needs nothing.
- **Keycloak.** The realm file is only imported when the realm does not exist.
  A Keycloak started before this release has neither Harsh and Nishtha nor the
  `http://lura.com:8080` redirect;
  [`deploy/keycloak/README.md`](../deploy/keycloak/README.md#changing-a-running-realm)
  has the `kcadm` commands to add them to a running realm.
- **Web client.** Rebuild it (`npm run build:web`, or `make serve`).
- **Configuration.** No new environment variables.
- **API clients.** All new fields have defaults (`shape: "circle"`,
  `polygon: []`, `watchUserIds: []`, `watchUserId: ""`, `notifyUserIds: []`), so
  existing requests behave as before. A `geo` event's `userId` is still the
  place owner; read `subjectUserId` to tell a watched person's crossing from
  your own. New 400 codes: `invalid_polygon` and `not_connected`.

---

## Known limitations

- **Native iOS and Android have not been exercised end to end on a device.** The
  map, markers, editor and notifications share code with the web build, and the
  end-to-end suite runs in desktop Chrome only.
- **Tracking is foreground only.** Publishing stops when the app is
  backgrounded; background tracking needs the mobile build with OS-granted
  background location, which this release does not include.
- **No chime on a phone.** The native app has no audio module, so a phone
  vibrates with a per-trigger pattern instead. Desktop alerts are web only, and
  only fire while the tab is hidden and permission has been granted from
  Settings or the notification panel.
- **The notification centre lives in the tab.** It lists what arrived while the
  app was open; a reload empties it. Fired events stay in the server's history.
- **Geolocation needs a secure origin.** Browsers offer location to `https://`
  pages and `http://localhost`, not to `http://lura.com:8080`; publish from a
  `localhost` window, or drive that person with `lurasim`.
- **Mappls draws only the styles your key has.** Satellite, hybrid and terrain
  (and any style missing from the key) are drawn by MapLibre from Esri tiles.
  Mappls also only serves tiles to whitelisted domains, hence `lura.com`
  ([`mappls.md`](mappls.md)).
- **Fence limits.** A polygon has 3–200 corners and reaches at most 5 km from
  its centre; a circle is 20 m–5 km.
- **The realm only accepts redirects on port 8080.** Serving the web app on
  another port (including `E2E_PORT`) needs that origin added to the `lura-app`
  client first.
