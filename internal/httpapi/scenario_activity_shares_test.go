package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/coder/websocket"
)

// Share links (HLD §5.8, release spec §7 "share" items): a link shows what it
// allows and nothing else, ends on revoke, expiry or arrival, shows nothing
// after it ends, and its life is part of its owner's history only.

// shareDialStatus dials a share's live stream expecting a refusal and returns
// the HTTP status.
func (s *actStack) shareDialStatus(token string) int {
	s.t.Helper()
	u := "ws" + strings.TrimPrefix(s.server.URL, "http") + "/s/" + token + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, u, nil)
	if err == nil {
		_ = conn.CloseNow()
		return http.StatusSwitchingProtocols
	}
	if resp == nil {
		s.t.Fatalf("dial %s: %v", u, err)
	}
	return resp.StatusCode
}

// createShare creates a link as p and returns its id and token.
func (s *actStack) createShare(p actPerson, body map[string]any) (string, string) {
	s.t.Helper()
	sh := s.call(p, http.MethodPost, "/api/v1/shares", body, http.StatusCreated)["share"].(map[string]any)
	return sh["id"].(string), sh["token"].(string)
}

// assertLinkEnded checks that nothing about the sharer comes back once a link
// has ended.
func (s *actStack) assertLinkEnded(token, sharer string) {
	s.t.Helper()
	code, body, _ := s.raw("", http.MethodGet, "/s/"+token, nil)
	if code != http.StatusForbidden {
		s.t.Errorf("ended link GET /s/%s = %d, want 403: %s", token, code, body)
	}
	for _, leak := range []string{sharer, "lat", "devices"} {
		if strings.Contains(string(body), leak) {
			s.t.Errorf("an ended link still says %q: %s", leak, body)
		}
	}
	if code := s.shareDialStatus(token); code != http.StatusForbidden {
		s.t.Errorf("ended link live stream = %d, want 403", code)
	}
}

func shareLines(items []map[string]any) []string {
	var out []string
	for _, it := range chronological(items) {
		if it["type"] == "share" {
			out = append(out, itemLine(it))
		}
	}
	return out
}

func positionDevices(frames []hub.Frame) map[string]bool {
	out := map[string]bool{}
	for _, f := range frames {
		if f.Type != hub.FramePosition {
			continue
		}
		var p domain.Position
		if err := json.Unmarshal(f.Data, &p); err == nil {
			out[p.DeviceID] = true
		}
	}
	return out
}

func TestShareLinkShowsOnlyWhatItAllows(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		st := be.open(t)
		s := newActStack(t, st, actOptions{})
		harsh, nishtha := s.harshAndNishtha()
		s.connect(harsh, nishtha)
		if err := st.UpsertDevice(context.Background(), domain.Device{
			ID: "usr_harsh_watch", UserID: harsh.id, Name: "Harsh's Watch", Kind: "watch", Token: "harsh-watch-token",
		}); err != nil {
			t.Fatal(err)
		}
		watch := actPerson{id: harsh.id, name: "Harsh", deviceID: "usr_harsh_watch", devToken: "harsh-watch-token"}
		grocery := s.place(harsh, circle("Grocery", actGrocery, "arrive"))
		s.note(harsh, map[string]any{"text": "buy milk", "placeId": grocery, "trigger": "arrive"})
		s.pub(harsh, 12.9411, 77.6011, 3)
		s.pub(watch, 12.9422, 77.6022, 3)
		time.Sleep(100 * time.Millisecond) // last points written

		// Someone else's device cannot be put on a link.
		if code, body, _ := s.raw(harsh.token, http.MethodPost, "/api/v1/shares", map[string]any{
			"label": "x", "mode": "until_revoke", "deviceIds": []string{nishtha.deviceID},
		}); code != http.StatusNotFound {
			t.Errorf("sharing Nishtha's phone = %d, want 404: %s", code, body)
		}

		id, token := s.createShare(harsh, map[string]any{
			"label": "Mum", "mode": "until_revoke", "deviceIds": []string{harsh.deviceID},
		})

		// The public view: his name, his phone, nothing else.
		code, body, _ := s.raw("", http.MethodGet, "/s/"+token, nil)
		if code != http.StatusOK {
			t.Fatalf("public view = %d: %s", code, body)
		}
		var view struct {
			SharerName string `json:"sharerName"`
			Devices    []struct {
				ID    string        `json:"id"`
				Point *domain.Point `json:"point"`
			} `json:"devices"`
		}
		if err := json.Unmarshal(body, &view); err != nil {
			t.Fatal(err)
		}
		if view.SharerName != "Harsh" || len(view.Devices) != 1 || view.Devices[0].ID != harsh.deviceID ||
			view.Devices[0].Point == nil || view.Devices[0].Point.Lat != 12.9411 {
			t.Errorf("public view = %s, want Harsh's phone at its last point and nothing else", body)
		}
		for _, leak := range []string{"Mum", "buy milk", "Grocery", "usr_harsh_watch", "12.9422", "Nishtha", "token\""} {
			if strings.Contains(string(body), leak) {
				t.Errorf("public view carries %q: %s", leak, body)
			}
		}

		// The live stream: the phone moves, the watch is not on the link.
		viewer := s.wsPath("/s/" + token + "/ws")
		snap := nextFrame(t, viewer, "snapshot", 3*time.Second)
		if strings.Contains(string(snap.Data), "usr_harsh_watch") || strings.Contains(string(snap.Data), "Mum") {
			t.Errorf("viewer snapshot = %s", snap.Data)
		}
		// (A read that times out closes the socket, so the stream is read up to
		// the phone's fix rather than drained.)
		s.pub(watch, 12.9433, 77.6033, 3)
		s.pub(harsh, 12.9444, 77.6044, 3)
		first := positionDevices([]hub.Frame{nextFrame(t, viewer, hub.FramePosition, 3*time.Second)})
		if !first[harsh.deviceID] || len(first) != 1 {
			t.Errorf("viewer's first position is from %v, want only the phone (the watch is not on the link)", first)
		}

		// Nishtha can neither see nor end his links, and they are not her history.
		if list := s.call(nishtha, http.MethodGet, "/api/v1/shares?includeInactive=true", nil, http.StatusOK)["shares"].([]any); len(list) != 0 {
			t.Errorf("Nishtha lists Harsh's links: %v", list)
		}
		if code, _, _ := s.raw(nishtha.token, http.MethodDelete, "/api/v1/shares/"+id, nil); code != http.StatusNotFound {
			t.Errorf("Nishtha revoking Harsh's link = %d, want 404", code)
		}
		if code, _, _ := s.raw("", http.MethodDelete, "/api/v1/shares/"+id, nil); code != http.StatusUnauthorized {
			t.Errorf("anonymous revoke = %d, want 401", code)
		}

		// Harsh revokes: the viewer is told and then gets nothing.
		s.call(harsh, http.MethodDelete, "/api/v1/shares/"+id, nil, http.StatusOK)
		acl := nextFrame(t, viewer, hub.FrameACL, 3*time.Second)
		if !strings.Contains(string(acl.Data), "revoke") || strings.Contains(string(acl.Data), "Mum") {
			t.Errorf("viewer's revoke frame = %s", acl.Data)
		}
		s.pub(harsh, 12.9455, 77.6055, 3)
		if got := positionDevices(drainFor(t, viewer, 400*time.Millisecond)); len(got) != 0 {
			t.Errorf("a revoked viewer received positions of %v", got)
		}
		s.assertLinkEnded(token, "Harsh")

		if active := s.call(harsh, http.MethodGet, "/api/v1/shares", nil, http.StatusOK)["shares"].([]any); len(active) != 0 {
			t.Errorf("active shares after revoke = %v", active)
		}
		if all := s.call(harsh, http.MethodGet, "/api/v1/shares?includeInactive=true", nil, http.StatusOK)["shares"].([]any); len(all) != 1 {
			t.Errorf("all shares = %d, want the revoked one listed", len(all))
		}

		mine := s.activity(harsh, "?from=-1h")
		if got := strings.Join(shareLines(mine), " | "); got != "share created <nil> | share revoked revoked by owner" {
			t.Errorf("Harsh's share history = %q:%s", got, describeItems(mine))
		}
		for _, it := range s.activity(nishtha, "?from=-1h") {
			if it["type"] == "share" {
				t.Errorf("Nishtha's feed has Harsh's link: %v", it)
			}
		}
	})
}

// A one-minute link ends at its minute, live, for a viewer who is watching.
func TestShareLinkExpiresOnTime(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		// The share service's clock runs 59 s behind, so a one-minute link
		// created now expires a second from now on the wall clock.
		s := newActStack(t, be.open(t), actOptions{shareClock: func() time.Time { return time.Now().Add(-59 * time.Second) }})
		harsh, _ := s.harshAndNishtha()
		s.pub(harsh, 12.9411, 77.6011, 3)

		_, token := s.createShare(harsh, map[string]any{"label": "Cab", "mode": "duration", "durationMins": 1})
		if code, body, _ := s.raw("", http.MethodGet, "/s/"+token, nil); code != http.StatusOK {
			t.Fatalf("fresh link = %d: %s", code, body)
		}
		viewer := s.wsPath("/s/" + token + "/ws")
		acl := nextFrame(t, viewer, hub.FrameACL, 5*time.Second)
		if !strings.Contains(string(acl.Data), "expired") {
			t.Errorf("viewer's end frame = %s, want an expiry", acl.Data)
		}
		s.pub(harsh, 12.9455, 77.6055, 3)
		if got := positionDevices(drainFor(t, viewer, 400*time.Millisecond)); len(got) != 0 {
			t.Errorf("an expired viewer received positions of %v", got)
		}
		s.assertLinkEnded(token, "Harsh")

		mine := s.activity(harsh, "?from=-1h")
		if got := strings.Join(shareLines(mine), " | "); got != "share created <nil> | share revoked expired" {
			t.Errorf("Harsh's share history = %q", got)
		}
	})
}

// A link that ran out while no server was running to end it (or before a
// restart dropped its timer) is still over — and its history says so.
func TestShareLinkThatExpiredWhileTheServerWasDown(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		st := be.open(t)
		s := newActStack(t, st, actOptions{})
		harsh, _ := s.harshAndNishtha()
		created := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Millisecond)
		expired := created.Add(time.Hour)
		sh, err := st.CreateShare(context.Background(), domain.Share{
			UserID: harsh.id, Token: "tok_expired_while_down", Label: "Cab", Mode: domain.ShareDuration,
			CreatedAt: created, ExpiresAt: &expired,
		})
		if err != nil {
			t.Fatal(err)
		}
		if be.durable {
			// The process that created it is gone; a new one serves the link.
			s.stop()
			s = newActStack(t, be.open(t), actOptions{})
			harsh, _ = s.harshAndNishtha()
		}

		s.assertLinkEnded(sh.Token, "Harsh")
		if active := s.call(harsh, http.MethodGet, "/api/v1/shares", nil, http.StatusOK)["shares"].([]any); len(active) != 0 {
			t.Errorf("an expired link is listed as active: %v", active)
		}

		mine := s.activity(harsh, "?from=-3h")
		if got := strings.Join(shareLines(mine), " | "); got != "share created <nil> | share revoked expired" {
			t.Errorf("Harsh's share history = %q, want the link's creation and its expiry:%s", got, describeItems(mine))
		}
		for _, it := range mine {
			if it["type"] == "share" && it["action"] == "revoked" {
				if ts, _ := time.Parse(time.RFC3339Nano, it["ts"].(string)); !ts.Equal(expired) {
					t.Errorf("the link ended at %s, want its expiry %s", ts, expired)
				}
			}
		}
		// A window that ends before the expiry does not know about it yet.
		before := s.activity(harsh, "?from=-3h&to=-90m")
		if got := strings.Join(shareLines(before), " | "); got != "share created <nil>" {
			t.Errorf("history before the expiry = %q", got)
		}
	})
}

// "Until I arrive" ends on the sharer's own arrival — not when someone he
// watches reaches the same place.
func TestShareLinkUntilIArrive(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		s := newActStack(t, be.open(t), actOptions{})
		harsh, nishtha := s.harshAndNishtha()
		s.connect(harsh, nishtha)
		office := circle("Office", actOffice, "arrive")
		office["watchUserIds"] = []string{nishtha.id}
		officeID := s.place(harsh, office)

		_, token := s.createShare(harsh, map[string]any{"label": "Boss", "mode": "until_arrive", "arrivePlaceId": officeID})
		code, body, _ := s.raw("", http.MethodGet, "/s/"+token, nil)
		if code != http.StatusOK || !strings.Contains(string(body), `"arrivePlaceName":"Office"`) {
			t.Fatalf("until-arrive link = %d: %s", code, body)
		}
		viewer := s.wsPath("/s/" + token + "/ws")

		harshWS := s.ws(harsh)
		s.pub(nishtha, actOffice.Lat-0.004, actOffice.Lon, 1)
		s.pub(nishtha, actOffice.Lat, actOffice.Lon, 0.4)
		nextFrame(t, harshWS, hub.FrameGeo, 5*time.Second) // her arrival, on his fence
		time.Sleep(100 * time.Millisecond)
		if code, body, _ := s.raw("", http.MethodGet, "/s/"+token, nil); code != http.StatusOK {
			t.Fatalf("Nishtha's arrival ended Harsh's link: %d %s", code, body)
		}

		s.pub(harsh, actOffice.Lat-0.004, actOffice.Lon, 1)
		s.pub(harsh, actOffice.Lat, actOffice.Lon, 0.4)
		acl := nextFrame(t, viewer, hub.FrameACL, 5*time.Second)
		if !strings.Contains(string(acl.Data), "arrived at Office") {
			t.Errorf("viewer's end frame = %s", acl.Data)
		}
		s.assertLinkEnded(token, "Harsh")

		mine := s.activity(harsh, "?from=-1h")
		if got := strings.Join(shareLines(mine), " | "); got != "share created <nil> | share revoked arrived at Office" {
			t.Errorf("Harsh's share history = %q", got)
		}
	})
}
