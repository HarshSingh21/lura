package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/seed"
	"github.com/coder/websocket"
)

// Drawn geofences, watched people and notes for other people, over the real
// HTTP API and real sockets.

// groceryRing is a ~110 m box well away from every seeded place.
func groceryRing() []map[string]float64 {
	return []map[string]float64{
		{"lat": 12.9000, "lon": 77.6000},
		{"lat": 12.9000, "lon": 77.6010},
		{"lat": 12.9010, "lon": 77.6010},
		{"lat": 12.9010, "lon": 77.6000},
	}
}

var (
	inGrocery   = [2]float64{12.9005, 77.6005}
	nearGrocery = [2]float64{12.9050, 77.6005}
)

// errorCode performs a request expected to fail and returns its status and
// error code.
func (s *stack) errorCode(token, method, path string, body any) (int, string) {
	s.t.Helper()
	previous := s.token
	s.token = token
	defer func() { s.token = previous }()
	resp := s.do(method, path, body, true)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var e struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &e)
	return resp.StatusCode, e.Code
}

func placeOf(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	p, ok := body["place"].(map[string]any)
	if !ok {
		t.Fatalf("no place in %v", body)
	}
	return p
}

func ringOf(t *testing.T, place map[string]any) []map[string]any {
	t.Helper()
	raw, ok := place["polygon"].([]any)
	if !ok {
		t.Fatalf("polygon is %T (%v), want an array", place["polygon"], place["polygon"])
	}
	out := make([]map[string]any, 0, len(raw))
	for _, v := range raw {
		out = append(out, v.(map[string]any))
	}
	return out
}

// ---------------------------------------------------------------- polygons

func TestCreatePolygonPlaceComputesCentreAndRadius(t *testing.T) {
	s := newStack(t)
	body := s.json(http.MethodPost, "/api/v1/places", map[string]any{
		"name": "Grocery", "shape": "polygon", "polygon": groceryRing(), "triggers": []string{"arrive", "leave"},
	}, http.StatusCreated)
	p := placeOf(t, body)
	if p["shape"] != "polygon" {
		t.Errorf("shape = %v", p["shape"])
	}
	if got := ringOf(t, p); len(got) != 4 {
		t.Errorf("polygon has %d vertices, want 4", len(got))
	}
	center := p["center"].(map[string]any)
	if lat := center["lat"].(float64); lat < 12.90049 || lat > 12.90051 {
		t.Errorf("centroid lat = %v, want ≈ 12.9005", lat)
	}
	if r := p["radiusM"].(float64); r < 76 || r > 80 {
		t.Errorf("radiusM = %v, want the bounding radius ≈ 78", r)
	}
	if w, ok := p["watchUserIds"].([]any); !ok || len(w) != 0 {
		t.Errorf("watchUserIds = %v, want []", p["watchUserIds"])
	}

	// A closed ring is accepted and stored open; shape is inferred from the ring.
	closed := append(groceryRing(), groceryRing()[0])
	for i := range closed {
		closed[i] = map[string]float64{"lat": closed[i]["lat"] + 0.01, "lon": closed[i]["lon"]}
	}
	body = s.json(http.MethodPost, "/api/v1/places", map[string]any{"name": "Bakery", "polygon": closed}, http.StatusCreated)
	if p := placeOf(t, body); p["shape"] != "polygon" || len(ringOf(t, p)) != 4 {
		t.Errorf("closed ring stored as shape=%v with %d vertices", p["shape"], len(ringOf(t, p)))
	}
}

func TestCirclePlaceSerialisesEmptyArrays(t *testing.T) {
	s := newStack(t)
	body := s.json(http.MethodPost, "/api/v1/places", map[string]any{
		"name": "Gym", "center": map[string]float64{"lat": 12.95, "lon": 77.65}, "radiusM": 100,
	}, http.StatusCreated)
	p := placeOf(t, body)
	if p["shape"] != "circle" {
		t.Errorf("shape = %v, want circle", p["shape"])
	}
	if ring := ringOf(t, p); len(ring) != 0 {
		t.Errorf("circle polygon = %v, want []", ring)
	}

	overview := s.json(http.MethodGet, "/api/v1/overview", nil, http.StatusOK)
	for _, raw := range overview["places"].([]any) {
		place := raw.(map[string]any)
		for _, field := range []string{"polygon", "watchUserIds"} {
			if _, ok := place[field].([]any); !ok {
				t.Errorf("overview place %v: %s = %v, want an array", place["id"], field, place[field])
			}
		}
	}
	for _, raw := range overview["notes"].([]any) {
		note := raw.(map[string]any)
		if _, ok := note["notifyUserIds"].([]any); !ok {
			t.Errorf("overview note %v: notifyUserIds = %v, want an array", note["id"], note["notifyUserIds"])
		}
		if _, ok := note["watchUserId"].(string); !ok {
			t.Errorf("overview note %v: watchUserId = %v, want a string", note["id"], note["watchUserId"])
		}
	}
}

func TestPolygonValidation(t *testing.T) {
	s := newStack(t)
	bowTie := []map[string]float64{
		{"lat": 12.9000, "lon": 77.6000}, {"lat": 12.9010, "lon": 77.6010},
		{"lat": 12.9000, "lon": 77.6010}, {"lat": 12.9010, "lon": 77.6000},
	}
	tooMany := make([]map[string]float64, 201)
	for i := range tooMany {
		tooMany[i] = map[string]float64{"lat": 12.9 + float64(i)*1e-6, "lon": 77.6 + float64(i*i)*1e-9}
	}
	cases := []struct {
		name string
		body map[string]any
	}{
		{"self-intersecting", map[string]any{"name": "X", "shape": "polygon", "polygon": bowTie}},
		{"two vertices", map[string]any{"name": "X", "shape": "polygon", "polygon": groceryRing()[:2]}},
		{"no ring at all", map[string]any{"name": "X", "shape": "polygon"}},
		{"too many vertices", map[string]any{"name": "X", "shape": "polygon", "polygon": tooMany}},
		{"bad vertex", map[string]any{"name": "X", "shape": "polygon", "polygon": []map[string]float64{
			{"lat": 12.9, "lon": 77.6}, {"lat": 95, "lon": 77.6}, {"lat": 12.91, "lon": 77.61},
		}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, code := s.errorCode(apiToken, http.MethodPost, "/api/v1/places", tc.body)
			if status != http.StatusBadRequest || code != "invalid_polygon" {
				t.Errorf("= %d %q, want 400 invalid_polygon", status, code)
			}
		})
	}

	if status, code := s.errorCode(apiToken, http.MethodPost, "/api/v1/places",
		map[string]any{"name": "X", "shape": "hexagon"}); status != http.StatusBadRequest || code != "invalid" {
		t.Errorf("unknown shape = %d %q, want 400 invalid", status, code)
	}
}

// Moving a fence is a PATCH with the new geometry, in any of the spellings a
// client might send.
func TestPatchMovesAndReshapesFences(t *testing.T) {
	s := newStack(t)
	created := placeOf(t, s.json(http.MethodPost, "/api/v1/places", map[string]any{
		"name": "Grocery", "shape": "polygon", "polygon": groceryRing(),
	}, http.StatusCreated))
	id := created["id"].(string)

	// 1. A whole new ring.
	moved := groceryRing()
	for i := range moved {
		moved[i]["lat"] += 0.002
	}
	p := placeOf(t, s.json(http.MethodPatch, "/api/v1/places/"+id, map[string]any{"polygon": moved}, http.StatusOK))
	if lat := ringOf(t, p)[0]["lat"].(float64); lat < 12.90199 || lat > 12.90201 {
		t.Errorf("vertex 0 lat after move = %v, want 12.902", lat)
	}
	if c := p["center"].(map[string]any)["lat"].(float64); c < 12.90249 || c > 12.90251 {
		t.Errorf("centroid not recomputed: %v", c)
	}

	// 2. Only the centre: the ring moves rigidly with it.
	p = placeOf(t, s.json(http.MethodPatch, "/api/v1/places/"+id, map[string]any{
		"center": map[string]float64{"lat": 12.9105, "lon": 77.6005},
	}, http.StatusOK))
	ring := ringOf(t, p)
	if len(ring) != 4 {
		t.Fatalf("ring lost on centre move: %v", ring)
	}
	if lat := ring[0]["lat"].(float64); lat < 12.90999 || lat > 12.91001 {
		t.Errorf("vertex 0 lat after centre move = %v, want 12.9100", lat)
	}

	// 3. Back to a circle.
	p = placeOf(t, s.json(http.MethodPatch, "/api/v1/places/"+id, map[string]any{
		"shape": "circle", "radiusM": 90,
	}, http.StatusOK))
	if p["shape"] != "circle" || len(ringOf(t, p)) != 0 || p["radiusM"].(float64) != 90 {
		t.Errorf("after reshape to circle: %v", p)
	}

	// 4. A circle cannot become a polygon without a ring.
	if status, code := s.errorCode(apiToken, http.MethodPatch, "/api/v1/places/"+id,
		map[string]any{"shape": "polygon"}); status != http.StatusBadRequest || code != "invalid_polygon" {
		t.Errorf("polygon without a ring = %d %q, want 400 invalid_polygon", status, code)
	}

	// 5. Unrelated fields leave the geometry alone.
	p = placeOf(t, s.json(http.MethodPatch, "/api/v1/places/"+id, map[string]any{"name": "Corner shop"}, http.StatusOK))
	if p["name"] != "Corner shop" || p["radiusM"].(float64) != 90 {
		t.Errorf("rename changed geometry: %v", p)
	}
}

// ---------------------------------------------------------------- connections

func TestWatchAndNotifyRequireAConnection(t *testing.T) {
	s := newStack(t)
	nishtha := s.addPeer(t, "usr_nishtha", "nishtha@lura.local", "Nishtha")
	stranger := s.addPeer(t, "usr_stranger", "stranger@lura.local", "Stranger")
	pending := s.addPeer(t, "usr_pending", "pending@lura.local", "Pending")
	s.connectPeers(t, nishtha)
	s.json(http.MethodPost, "/api/v1/people/invite", map[string]any{"email": pending.email}, http.StatusCreated)

	place := placeOf(t, s.json(http.MethodPost, "/api/v1/places", map[string]any{
		"name": "Grocery", "polygon": groceryRing(), "watchUserIds": []string{nishtha.userID},
	}, http.StatusCreated))
	if w := place["watchUserIds"].([]any); len(w) != 1 || w[0] != nishtha.userID {
		t.Fatalf("watchUserIds = %v", w)
	}
	placeID := place["id"].(string)

	notConnected := []struct {
		name, method, path string
		body               map[string]any
	}{
		{"watch a stranger", http.MethodPost, "/api/v1/places",
			map[string]any{"name": "X", "polygon": groceryRing(), "watchUserIds": []string{stranger.userID}}},
		{"watch a pending invitee", http.MethodPatch, "/api/v1/places/" + placeID,
			map[string]any{"watchUserIds": []string{pending.userID}}},
		{"watch yourself", http.MethodPatch, "/api/v1/places/" + placeID,
			map[string]any{"watchUserIds": []string{seed.DemoUserID}}},
		{"note watching a stranger", http.MethodPost, "/api/v1/notes",
			map[string]any{"text": "x", "placeId": placeID, "watchUserId": stranger.userID, "autoSuggest": false}},
		{"note notifying a stranger", http.MethodPost, "/api/v1/notes",
			map[string]any{"text": "x", "placeId": placeID, "notifyUserIds": []string{seed.DemoUserID, stranger.userID}, "autoSuggest": false}},
	}
	for _, tc := range notConnected {
		t.Run(tc.name, func(t *testing.T) {
			status, code := s.errorCode(apiToken, tc.method, tc.path, tc.body)
			if status != http.StatusBadRequest || code != "not_connected" {
				t.Errorf("= %d %q, want 400 not_connected", status, code)
			}
		})
	}

	// The happy path, and the same checks on PATCH.
	note := s.json(http.MethodPost, "/api/v1/notes", map[string]any{
		"text": "buy milk", "placeId": placeID, "trigger": "passby",
		"watchUserId": nishtha.userID, "notifyUserIds": []string{seed.DemoUserID, nishtha.userID},
		"autoSuggest": false,
	}, http.StatusCreated)["note"].(map[string]any)
	if note["watchUserId"] != nishtha.userID || len(note["notifyUserIds"].([]any)) != 2 {
		t.Fatalf("note = %v", note)
	}
	noteID := note["id"].(string)
	if status, code := s.errorCode(apiToken, http.MethodPatch, "/api/v1/notes/"+noteID,
		map[string]any{"notifyUserIds": []string{stranger.userID}}); status != http.StatusBadRequest || code != "not_connected" {
		t.Errorf("patch notify to a stranger = %d %q", status, code)
	}
	if status, code := s.errorCode(apiToken, http.MethodPatch, "/api/v1/notes/"+noteID,
		map[string]any{"watchUserId": pending.userID}); status != http.StatusBadRequest || code != "not_connected" {
		t.Errorf("patch watch to a pending invitee = %d %q", status, code)
	}
	// Naming yourself as the watched person means your own devices.
	patched := s.json(http.MethodPatch, "/api/v1/notes/"+noteID,
		map[string]any{"watchUserId": seed.DemoUserID}, http.StatusOK)["note"].(map[string]any)
	if patched["watchUserId"] != "" {
		t.Errorf("watchUserId = %v, want \"\"", patched["watchUserId"])
	}

	// A stranger cannot see, let alone patch, the place that watches Nishtha.
	if got := s.statusAs(stranger.token, http.MethodPatch, "/api/v1/places/"+placeID,
		map[string]any{"watchUserIds": []string{}}); got != http.StatusNotFound {
		t.Errorf("stranger patching the place = %d, want 404", got)
	}
}

// ---------------------------------------------------------------- end to end

// The reference scenario from docs/release-spec.md, end to end: Aravind (the
// seeded workspace, standing in for Harsh) draws a polygon, watches Nishtha on
// it and leaves a note that fires on her movement and notifies both of them.
// Her crossing reaches his socket as a geo event about her, both sockets get
// the reminder, and she never sees his geofence events.
func TestPeerCrossingEndToEnd(t *testing.T) {
	s := newStack(t)
	nishtha := s.addPeer(t, "usr_nishtha", "nishtha@lura.local", "Nishtha")
	s.connectPeers(t, nishtha)

	place := placeOf(t, s.json(http.MethodPost, "/api/v1/places", map[string]any{
		"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"arrive", "leave"},
		"watchUserIds": []string{nishtha.userID},
	}, http.StatusCreated))
	placeID := place["id"].(string)
	s.json(http.MethodPost, "/api/v1/notes", map[string]any{
		"text": "buy milk", "placeId": placeID, "trigger": "arrive",
		"watchUserId": nishtha.userID, "notifyUserIds": []string{seed.DemoUserID, nishtha.userID},
		"autoSuggest": false,
	}, http.StatusCreated)

	harshSocket := s.dialWS(t, "/ws?access_token="+apiToken)
	nishthaSocket := s.dialWS(t, "/ws?access_token="+nishtha.token)
	nextFrame(t, harshSocket, hub.FrameHello, 3*time.Second)
	nextFrame(t, nishthaSocket, hub.FrameHello, 3*time.Second)

	// She walks up to the shop and in.
	s.pubAs(t, nishtha, nearGrocery[0], nearGrocery[1], 1)
	s.pubAs(t, nishtha, inGrocery[0], inGrocery[1], 0.5)

	geo := nextFrame(t, harshSocket, hub.FrameGeo, 5*time.Second)
	var ev domain.GeoEvent
	if err := json.Unmarshal(geo.Data, &ev); err != nil {
		t.Fatalf("geo frame: %v", err)
	}
	if ev.Trigger != domain.TriggerArrive || ev.PlaceID != placeID || ev.UserID != seed.DemoUserID ||
		ev.SubjectUserID != nishtha.userID || ev.SubjectName != "Nishtha" || ev.DeviceID != nishtha.deviceID {
		t.Fatalf("geo event = %+v, want Nishtha arriving at Aravind's Grocery", ev)
	}

	harshReminder := nextReminder(t, harshSocket)
	if harshReminder.Title != "Nishtha arrived at Grocery" || harshReminder.Body != "buy milk" || harshReminder.Kind != "note" {
		t.Errorf("Aravind's reminder = %q / %q / %q", harshReminder.Title, harshReminder.Body, harshReminder.Kind)
	}
	nishthaReminder := nextReminderWithoutGeo(t, nishthaSocket)
	if nishthaReminder.UserID != nishtha.userID || nishthaReminder.Body != "buy milk" ||
		nishthaReminder.FromUserID != seed.DemoUserID || nishthaReminder.FromName != "Aravind" {
		t.Errorf("Nishtha's reminder = %+v, want Aravind's note from Aravind", nishthaReminder)
	}

	// She leaves: the place watches her, so Aravind hears it as a watch reminder.
	s.pubAs(t, nishtha, nearGrocery[0], nearGrocery[1], 1)
	leave := nextReminder(t, harshSocket)
	if leave.Kind != "watch" || leave.Title != "Nishtha left Grocery" {
		t.Errorf("leave reminder = %q / %q, want a watch reminder", leave.Kind, leave.Title)
	}

	// Her socket never carried his geofence events, and her overview does not
	// list his fence as one she is inside.
	for _, f := range drainFor(t, nishthaSocket, 500*time.Millisecond) {
		if f.Type == hub.FrameGeo {
			t.Fatalf("the watched person received the watcher's geo event: %s", f.Data)
		}
	}
	overview := s.jsonAs(nishtha.token, http.MethodGet, "/api/v1/overview", nil, http.StatusOK)
	for _, raw := range overview["places"].([]any) {
		if raw.(map[string]any)["id"] == placeID {
			t.Fatal("the watched person can list the watcher's place")
		}
	}

	// She pauses: her next crossings are not evaluated at all.
	s.jsonAs(nishtha.token, http.MethodPatch, "/api/v1/people/"+seed.DemoUserID, map[string]any{"sharing": false}, http.StatusOK)
	nextFrame(t, harshSocket, hub.FrameACL, 5*time.Second)
	s.pubAs(t, nishtha, inGrocery[0], inGrocery[1], 0.5)
	s.pubAs(t, nishtha, nearGrocery[0], nearGrocery[1], 1)
	for _, f := range drainFor(t, harshSocket, 800*time.Millisecond) {
		if f.Type == hub.FrameGeo || f.Type == hub.FrameNotify {
			t.Fatalf("a crossing was evaluated after sharing was paused: %s %s", f.Type, f.Data)
		}
	}
}

// nextReminderWithoutGeo reads up to the next notify frame and fails if a geo
// frame comes first: the watched person's socket must never carry one.
func nextReminderWithoutGeo(t *testing.T, conn *websocket.Conn) notify.Message {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for a reminder: %v", err)
		}
		var f hub.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			t.Fatalf("undecodable frame: %v", err)
		}
		switch f.Type {
		case hub.FrameGeo:
			t.Fatalf("the watched person received a geo event: %s", f.Data)
		case hub.FrameNotify:
			var msg notify.Message
			if err := json.Unmarshal(f.Data, &msg); err != nil {
				t.Fatalf("notify frame: %v", err)
			}
			return msg
		}
	}
}

// nextReminder reads the next notify frame.
func nextReminder(t *testing.T, conn *websocket.Conn) notify.Message {
	t.Helper()
	frame := nextFrame(t, conn, hub.FrameNotify, 5*time.Second)
	var msg notify.Message
	if err := json.Unmarshal(frame.Data, &msg); err != nil {
		t.Fatalf("notify frame: %v", err)
	}
	return msg
}
