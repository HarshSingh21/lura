package httpapi_test

// Live-socket and rate-limit scenarios for sessions: what the handshake
// accepts, what a socket carries for whom, what happens when the token it was
// opened with expires, and how a reconnect with a renewed token catches up.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/config"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/coder/websocket"
)

// harshWatchesNishtha sets up the reference scenario: Harsh and Nishtha are
// connected; Harsh has a Grocery polygon that watches her and a "buy milk"
// note that fires when she arrives, notifying only Harsh.
func (s *authStack) harshWatchesNishtha(harsh, nishtha *authUser) (placeID, noteID string) {
	s.t.Helper()
	s.connect(harsh, nishtha)
	place := asMap(s.t, s.must(harsh.token, http.MethodPost, "/api/v1/places", map[string]any{
		"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"arrive"},
		"watchUserIds": []string{nishtha.id.Sub},
	}, http.StatusCreated)["place"])
	note := asMap(s.t, s.must(harsh.token, http.MethodPost, "/api/v1/notes", map[string]any{
		"text": "buy milk", "placeId": place["id"], "trigger": "arrive",
		"watchUserId": nishtha.id.Sub, "notifyUserIds": []string{harsh.id.Sub},
		"autoSuggest": false,
	}, http.StatusCreated)["note"])
	return place["id"].(string), note["id"].(string)
}

// arrive walks the user into the Grocery fence at walking pace.
func (s *authStack) arrive(u *authUser) {
	s.t.Helper()
	s.pub(u, nearGrocery[0], nearGrocery[1], 1)
	s.pub(u, inGrocery[0], inGrocery[1], 0.5)
}

func isNotify(f hub.Frame) bool { return f.Type == hub.FrameNotify }

// Scenario: the socket carries exactly what the person is entitled to. Harsh
// sees Nishtha only once she has accepted; Mallory, a stranger, sees neither;
// a crossing of Harsh's watched fence reaches Harsh and not Nishtha.
func TestAuthScenarioLiveSocketCarriesOnlyWhatEachPersonMaySee(t *testing.T) {
	eachAuthBackend(t, func(t *testing.T, b authBackend) {
		s := newAuthStack(t, b, nil)
		harsh, nishtha, mal := s.signIn(harshID), s.signIn(nishthaID), s.signIn(mallory)

		harshWS := s.dialAs(harsh.token, "")
		malWS := s.dialAs(mal.token, "")
		awaitFrame(t, harshWS, 3*time.Second, "snapshot", func(f hub.Frame) bool { return f.Type == "snapshot" })

		// Not connected yet: Nishtha's fix reaches nobody else.
		s.pub(nishtha, 12.95, 77.63, 4)
		for _, f := range authFrames(t, harshWS, 400*time.Millisecond) {
			if f.Type == hub.FramePosition {
				if uid, _ := positionOf(t, f); uid == nishtha.id.Sub {
					t.Fatalf("Harsh got Nishtha's position before she accepted")
				}
			}
		}

		s.harshWatchesNishtha(harsh, nishtha)
		nishthaWS := s.dialAs(nishtha.token, "")
		awaitFrame(t, nishthaWS, 3*time.Second, "snapshot", func(f hub.Frame) bool { return f.Type == "snapshot" })

		s.arrive(nishtha)
		awaitFrame(t, harshWS, 5*time.Second, "Nishtha's position", func(f hub.Frame) bool {
			if f.Type != hub.FramePosition {
				return false
			}
			uid, _ := positionOf(t, f)
			return uid == nishtha.id.Sub
		})
		notice, _ := awaitFrame(t, harshWS, 8*time.Second, "the watch reminder", isNotify)
		if !json.Valid(notice.Data) {
			t.Fatalf("notify frame data: %s", notice.Data)
		}

		// Nishtha does not learn she is watched (release-spec §3), and the
		// stranger hears nothing of either of them.
		for _, f := range authFrames(t, nishthaWS, 600*time.Millisecond) {
			if f.Type == hub.FrameGeo || f.Type == hub.FrameNotify {
				t.Errorf("Nishtha received %s about Harsh's fence: %s", f.Type, f.Data)
			}
		}
		for _, f := range authFrames(t, malWS, 300*time.Millisecond) {
			switch f.Type {
			case hub.FramePosition, hub.FrameGeo, hub.FrameNotify, hub.FrameReminderAck:
				t.Errorf("Mallory received %s: %s", f.Type, f.Data)
			}
		}
	})
}

// Scenario: a token expiring under a live socket. The socket keeps streaming —
// docs/auth.md §4: validated at the handshake, a connection outlives its
// 15-minute token — but the expired token opens nothing new: REST and a new
// handshake are 401. The app reconnects with its renewed token and `since=`,
// and whatever fired while it was away is replayed.
func TestAuthScenarioTokenExpiresUnderALiveSocket(t *testing.T) {
	eachAuthBackend(t, func(t *testing.T, b authBackend) {
		s := newAuthStack(t, b, nil)
		harsh, nishtha := s.signIn(harshID), s.signIn(nishthaID)
		s.harshWatchesNishtha(harsh, nishtha)

		live := s.dialAs(harsh.token, "")
		snap, _ := awaitFrame(t, live, 3*time.Second, "snapshot", func(f hub.Frame) bool { return f.Type == "snapshot" })

		// Seventeen minutes on: the 15-minute token is past its minute of leeway.
		s.advanceVerifierClock(17 * time.Minute)
		if r := s.call(harsh.token, http.MethodGet, "/api/v1/overview", nil); r.status != http.StatusUnauthorized {
			t.Fatalf("REST with the expired token = %d, want 401", r.status)
		}

		// The open socket still delivers.
		s.pub(nishtha, 12.95, 77.63, 4)
		last, _ := awaitFrame(t, live, 5*time.Second, "Nishtha's position on the old socket", func(f hub.Frame) bool {
			if f.Type != hub.FramePosition {
				return false
			}
			uid, _ := positionOf(t, f)
			return uid == nishtha.id.Sub
		})
		if last.TS.Before(snap.TS) {
			t.Fatalf("frame timestamps go backwards: %s < %s", last.TS, snap.TS)
		}

		// The socket drops (a network change, a sleep). Meanwhile Nishtha arrives.
		_ = live.Close(websocket.StatusNormalClosure, "network changed")
		s.arrive(nishtha)
		var pending []any
		deadline := time.Now().Add(8 * time.Second)
		renewed := s.realm.mint(t, tokenSpec{who: harshID, issued: time.Now().Add(17 * time.Minute)})
		for time.Now().Before(deadline) {
			pending, _ = s.must(renewed, http.MethodGet, "/api/v1/reminders?status=pending", nil, http.StatusOK)["reminders"].([]any)
			if len(pending) > 0 {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if len(pending) != 1 {
			t.Fatalf("pending reminders after the crossing = %v", pending)
		}
		reminderID := asMap(t, pending[0])["id"]

		// Reconnecting with the token that expired is refused...
		since := "since=" + url.QueryEscape(last.TS.Format(time.RFC3339Nano))
		if _, status, err := s.tryDial(harsh.token, since, nil); err == nil || status != http.StatusUnauthorized {
			t.Fatalf("reconnect with the expired token = %d (err %v), want 401", status, err)
		}
		// ...with the renewed one it succeeds, and the reminder that fired while
		// the socket was down is replayed after the snapshot.
		back := s.dialAs(renewed, since)
		replayed, seen := awaitFrame(t, back, 5*time.Second, "the replayed reminder", isNotify)
		if seen[0].Type != hub.FrameHello && seen[0].Type != "snapshot" {
			t.Errorf("first frame after reconnect = %s, want hello/snapshot", seen[0].Type)
		}
		var rec struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		}
		_ = json.Unmarshal(replayed.Data, &rec)
		if rec.ID != reminderID || rec.Status != "pending" {
			t.Errorf("replayed notify = %s, want pending %v", replayed.Data, reminderID)
		}

		// A reconnect without since= gets no replay: the client relies on the
		// pending list instead (release-spec §6), so nothing is double-delivered.
		fresh := s.dialAs(renewed, "")
		for _, f := range authFrames(t, fresh, 500*time.Millisecond) {
			if f.Type == hub.FrameNotify {
				t.Errorf("a reconnect without since replayed %s", f.Data)
			}
		}
	})
}

// Scenario: a phone that floods /pub is throttled per device with a useful
// Retry-After, and nobody else's phone is.
func TestAuthScenarioPubIsRateLimitedPerDevice(t *testing.T) {
	eachAuthBackend(t, func(t *testing.T, b authBackend) {
		s := newAuthStack(t, b, func(c *config.Config) {
			c.IngestRatePerMin = 6
			c.IngestBurst = 3
		})
		harsh, nishtha := s.signIn(harshID), s.signIn(nishthaID)

		fix := func(i int) map[string]any {
			return map[string]any{
				"_type": "location", "lat": 12.95 + float64(i)*0.0001, "lon": 77.63,
				"tst": time.Now().Unix() + int64(i), "acc": 5, "speedMps": 1,
			}
		}
		var limited authResp
		for i := 0; i < 6; i++ {
			r := s.call(harsh.deviceToken, http.MethodPost, "/pub", fix(i))
			if r.status == http.StatusTooManyRequests {
				limited = r
				if i < 3 {
					t.Errorf("throttled after %d fixes, burst is 3", i)
				}
				break
			}
			if r.status != http.StatusOK {
				t.Fatalf("fix %d = %d: %s", i, r.status, r.body)
			}
		}
		if limited.status != http.StatusTooManyRequests {
			t.Fatal("six fixes in a row were never throttled")
		}
		if code := limited.object(t)["code"]; code != "rate_limited" {
			t.Errorf("429 code = %v", code)
		}
		if secs, err := strconv.Atoi(limited.header.Get("Retry-After")); err != nil || secs < 1 {
			t.Errorf("Retry-After = %q", limited.header.Get("Retry-After"))
		}

		// Nishtha's phone has its own budget, and Harsh's session is unaffected.
		s.pub(nishtha, 12.96, 77.64, 1)
		s.must(harsh.token, http.MethodGet, "/api/v1/overview", nil, http.StatusOK)
	})
}
