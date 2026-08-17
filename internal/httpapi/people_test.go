package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/seed"
	"github.com/coder/websocket"
)

// Two people, one server: this is the test that answers "what does each person
// actually see?" — over real HTTP and real WebSockets, with two separate
// credentials, exactly as two devices would.

// TestMutualSharingBothDirections is the headline: once both sides agree, each
// one's fixes reach the other's live socket.
func TestMutualSharingBothDirections(t *testing.T) {
	s := newStack(t)
	nistha := s.addPeer(t, "usr_nistha", "nistha@lura.local", "Nistha")

	// Before any connection, neither can see the other.
	aravindSocket := s.dialWS(t, "/ws?access_token="+apiToken)
	nisthaSocket := s.dialWS(t, "/ws?access_token="+nistha.token)
	nextFrame(t, aravindSocket, hub.FrameHello, 3*time.Second)
	nisthaHello := nextFrame(t, nisthaSocket, hub.FrameHello, 3*time.Second)

	var hello struct {
		Subjects []string `json:"subjects"`
	}
	if err := json.Unmarshal(nisthaHello.Data, &hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	for _, subject := range hello.Subjects {
		if subject == "pos."+seed.DemoUserID+".*" {
			t.Fatal("a stranger is subscribed to another user's positions")
		}
	}

	// Connect them: Aravind invites, Nistha accepts.
	s.connectPeers(t, nistha)

	// The ACL event re-authorises both live sockets without a reconnect.
	nextFrame(t, aravindSocket, hub.FrameACL, 5*time.Second)
	nextFrame(t, nisthaSocket, hub.FrameACL, 5*time.Second)

	// Aravind moves → Nistha sees it.
	s.pub(t, 12.9611, 77.6387, 7)
	fromAravind := nextPositionFrom(t, nisthaSocket, seed.DemoUserID, 5*time.Second)
	if fromAravind.DeviceID != "dev_phone" {
		t.Errorf("device = %q, want dev_phone", fromAravind.DeviceID)
	}

	// Nistha moves → Aravind sees it. Same path, opposite direction.
	s.pubAs(t, nistha, 12.9700, 77.6400, 5)
	fromNistha := nextPositionFrom(t, aravindSocket, nistha.userID, 5*time.Second)
	if fromNistha.DeviceID != nistha.deviceID {
		t.Errorf("device = %q, want %q", fromNistha.DeviceID, nistha.deviceID)
	}
	if fromNistha.Point.Lat < 12.96 || fromNistha.Point.Lat > 12.98 {
		t.Errorf("peer position looks wrong: %+v", fromNistha.Point)
	}
}

// nextPositionFrom reads until a position belonging to the given user arrives.
//
// A socket carries the viewer's own device as well as their peers', so "the next
// position frame" is not necessarily the one the test is waiting for.
func nextPositionFrom(t *testing.T, conn *websocket.Conn, userID string, timeout time.Duration) domain.Position {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		frame := nextFrame(t, conn, hub.FramePosition, time.Until(deadline))
		var pos domain.Position
		if err := json.Unmarshal(frame.Data, &pos); err != nil {
			t.Fatalf("position frame: %v", err)
		}
		if pos.UserID == userID {
			return pos
		}
	}
	t.Fatalf("no position from %s within %s", userID, timeout)
	return domain.Position{}
}

// TestPeopleListShowsEachSidesView checks that the two accounts see the
// relationship from their own perspective, including the peer's live position.
func TestPeopleListShowsEachSidesView(t *testing.T) {
	s := newStack(t)
	nistha := s.addPeer(t, "usr_nistha", "nistha@lura.local", "Nistha")

	// A pending invitation reads differently on each side.
	s.json(http.MethodPost, "/api/v1/people/invite", map[string]any{"email": nistha.email}, http.StatusCreated)

	mine := s.people(t, apiToken)
	if len(mine) != 1 || mine[0]["status"] != "pending_out" {
		t.Fatalf("inviter's list = %+v, want one pending_out", mine)
	}
	theirs := s.people(t, nistha.token)
	if len(theirs) != 1 || theirs[0]["status"] != "pending_in" {
		t.Fatalf("invitee's list = %+v, want one pending_in", theirs)
	}
	if theirs[0]["peerName"] != "Aravind" {
		t.Errorf("invitee sees peerName %v, want Aravind", theirs[0]["peerName"])
	}
	if theirs[0]["sharingWithMe"] == true {
		t.Error("a pending invitation already reports the peer as sharing")
	}

	// Accept, then publish a fix for each side.
	s.jsonAs(nistha.token, http.MethodPost, "/api/v1/people/"+seed.DemoUserID+"/accept", nil, http.StatusOK)
	s.pub(t, 12.9611, 77.6387, 0)
	s.pubAs(t, nistha, 12.9700, 77.6400, 0)

	// Each side now sees the other's device and position — and nothing more.
	theirs = s.people(t, nistha.token)
	if len(theirs) != 1 || theirs[0]["status"] != "accepted" || theirs[0]["sharingWithMe"] != true {
		t.Fatalf("after accepting, invitee's list = %+v", theirs)
	}
	devices, _ := theirs[0]["devices"].([]any)
	if len(devices) == 0 {
		t.Fatal("the peer's devices are not visible after accepting")
	}
	device, _ := devices[0].(map[string]any)
	if _, ok := device["point"]; !ok {
		t.Error("peer device has no position")
	}
	// A peer's view is deliberately reduced: no battery, no notes, no history.
	for _, leak := range []string{"battery", "token", "notes"} {
		if _, present := device[leak]; present {
			t.Errorf("peer device exposes %q", leak)
		}
	}
}

// TestPausingSharingCutsThePeerOffImmediately is the privacy guarantee: turning
// your own switch off stops the *next* fix reaching them, not the one after some
// cache expires.
func TestPausingSharingCutsThePeerOffImmediately(t *testing.T) {
	s := newStack(t)
	nistha := s.addPeer(t, "usr_nistha", "nistha@lura.local", "Nistha")
	s.connectPeers(t, nistha)

	// The socket is opened after the connection exists, so it is authorised from
	// the start — no ACL event to wait for here.
	watcher := s.dialWS(t, "/ws?access_token="+nistha.token)
	nextFrame(t, watcher, hub.FrameHello, 3*time.Second)

	s.pub(t, 12.9611, 77.6387, 6)
	nextFrame(t, watcher, hub.FramePosition, 5*time.Second)

	// Aravind stops sharing with Nistha.
	s.json(http.MethodPatch, "/api/v1/people/"+nistha.userID, map[string]any{"sharing": false}, http.StatusOK)
	nextFrame(t, watcher, hub.FrameACL, 5*time.Second)

	// Nothing published from here on may reach her.
	for i := 0; i < 3; i++ {
		s.pub(t, 12.9620+float64(i)*0.001, 77.6390, 6)
	}
	for _, frame := range drainFor(t, watcher, 700*time.Millisecond) {
		if frame.Type == hub.FramePosition {
			var pos domain.Position
			_ = json.Unmarshal(frame.Data, &pos)
			if pos.UserID == seed.DemoUserID {
				t.Fatal("a peer kept receiving positions after sharing was paused")
			}
		}
	}

	// The switch is one-sided: Aravind can still see Nistha.
	own := s.people(t, apiToken)
	if own[0]["watchingMe"] == true {
		t.Error("watchingMe is still true after pausing")
	}
	if own[0]["sharingWithMe"] != true {
		t.Error("pausing my own sharing also removed my view of the peer")
	}
}

// TestRemovingAConnectionRevokesBothWays covers the harder case: the
// relationship is gone for both people, and neither socket keeps a subscription.
func TestRemovingAConnectionRevokesBothWays(t *testing.T) {
	s := newStack(t)
	nistha := s.addPeer(t, "usr_nistha", "nistha@lura.local", "Nistha")
	s.connectPeers(t, nistha)

	watcher := s.dialWS(t, "/ws?access_token="+nistha.token)
	nextFrame(t, watcher, hub.FrameHello, 3*time.Second)

	if got := s.status(http.MethodDelete, "/api/v1/people/"+nistha.userID, nil); got != http.StatusNoContent {
		t.Fatalf("DELETE person = %d, want 204", got)
	}
	nextFrame(t, watcher, hub.FrameACL, 5*time.Second)

	s.pub(t, 12.9611, 77.6387, 6)
	for _, frame := range drainFor(t, watcher, 700*time.Millisecond) {
		if frame.Type == hub.FramePosition {
			var pos domain.Position
			_ = json.Unmarshal(frame.Data, &pos)
			if pos.UserID == seed.DemoUserID {
				t.Fatal("a removed peer still receives positions")
			}
		}
	}

	if people := s.people(t, apiToken); len(people) != 0 {
		t.Errorf("inviter still lists the removed connection: %+v", people)
	}
	if people := s.people(t, nistha.token); len(people) != 0 {
		t.Errorf("peer still lists the removed connection: %+v", people)
	}
}

// TestPeopleEndpointsAreScoped checks nobody can act on someone else's row.
func TestPeopleEndpointsAreScoped(t *testing.T) {
	s := newStack(t)
	nistha := s.addPeer(t, "usr_nistha", "nistha@lura.local", "Nistha")
	stranger := s.addPeer(t, "usr_stranger", "stranger@lura.local", "Stranger")
	s.connectPeers(t, nistha)

	// A third party sees nothing and cannot touch the pair's rows.
	if people := s.people(t, stranger.token); len(people) != 0 {
		t.Errorf("stranger sees %+v", people)
	}
	if got := s.statusAs(stranger.token, http.MethodPatch, "/api/v1/people/"+nistha.userID,
		map[string]any{"sharing": false}); got != http.StatusNotFound {
		t.Errorf("stranger patching someone else's row = %d, want 404", got)
	}
	if got := s.statusAs(stranger.token, http.MethodPost,
		"/api/v1/people/"+seed.DemoUserID+"/accept", nil); got != http.StatusNotFound {
		t.Errorf("stranger accepting an invitation they were not sent = %d, want 404", got)
	}

	// Inviting an address with no account is a 404, and inviting yourself is a 400.
	if got := s.status(http.MethodPost, "/api/v1/people/invite",
		map[string]any{"email": "nobody@example.com"}); got != http.StatusNotFound {
		t.Errorf("invite to an unknown address = %d, want 404", got)
	}
	if got := s.status(http.MethodPost, "/api/v1/people/invite",
		map[string]any{"email": "you@lura.local"}); got != http.StatusBadRequest {
		t.Errorf("self-invite = %d, want 400", got)
	}
}

// ---------------------------------------------------------------- helpers

func (s *stack) people(t *testing.T, token string) []map[string]any {
	t.Helper()
	body := s.jsonAs(token, http.MethodGet, "/api/v1/people", nil, http.StatusOK)
	raw, _ := body["people"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// pubAs publishes a fix from a peer's device, authenticating with the device's
// own token — the same way a real phone does. A person's session credential is
// deliberately not accepted for ingest.
func (s *stack) pubAs(t *testing.T, peer testPeer, lat, lon, speed float64) {
	t.Helper()
	s.jsonAs(peer.deviceToken, http.MethodPost, "/pub", map[string]any{
		"_type": "location", "lat": lat, "lon": lon, "speedMps": speed,
		"tst": time.Now().Unix(), "acc": 5,
	}, http.StatusOK)
}

func (s *stack) statusAs(token, method, path string, body any) int {
	s.t.Helper()
	previous := s.token
	s.token = token
	defer func() { s.token = previous }()
	return s.status(method, path, body)
}
