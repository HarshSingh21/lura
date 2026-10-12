package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/seed"
	"github.com/coder/websocket"
)

// The commute case over real HTTP and WebSockets: a reminder keeps waiting
// until its recipient acknowledges it, the ack clears it in every session,
// and the owner hears about someone else's ack.

func (s *stack) reminders(t *testing.T, token, query string) []map[string]any {
	t.Helper()
	body := s.jsonAs(token, http.MethodGet, "/api/v1/reminders"+query, nil, http.StatusOK)
	raw, ok := body["reminders"].([]any)
	if !ok {
		t.Fatalf("reminders is not an array: %v", body)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		out = append(out, r.(map[string]any))
	}
	return out
}

func nextAckFrame(t *testing.T, conn *websocket.Conn) notify.AckFrame {
	t.Helper()
	frame := nextFrame(t, conn, hub.FrameReminderAck, 5*time.Second)
	var ack notify.AckFrame
	if err := json.Unmarshal(frame.Data, &ack); err != nil {
		t.Fatalf("reminder_ack frame: %v", err)
	}
	return ack
}

func TestReminderWaitsForAcknowledgement(t *testing.T) {
	s := newStack(t)
	nishtha := s.addPeer(t, "usr_nishtha", "nishtha@lura.local", "Nishtha")
	s.connectPeers(t, nishtha)

	place := placeOf(t, s.json(http.MethodPost, "/api/v1/places", map[string]any{
		"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"arrive"},
	}, http.StatusCreated))
	note := s.json(http.MethodPost, "/api/v1/notes", map[string]any{
		"text": "buy milk", "placeId": place["id"], "trigger": "arrive",
		"watchUserId": nishtha.userID, "notifyUserIds": []string{seed.DemoUserID, nishtha.userID},
		"autoSuggest": false,
	}, http.StatusCreated)["note"].(map[string]any)
	noteID := note["id"].(string)

	harshSocket := s.dialWS(t, "/ws?access_token="+apiToken)
	nishthaTab1 := s.dialWSAs(t, nishtha)
	nishthaTab2 := s.dialWSAs(t, nishtha)
	for _, c := range []*websocket.Conn{harshSocket, nishthaTab1, nishthaTab2} {
		nextFrame(t, c, hub.FrameHello, 3*time.Second)
	}

	s.pubAs(t, nishtha, nearGrocery[0], nearGrocery[1], 1)
	s.pubAs(t, nishtha, inGrocery[0], inGrocery[1], 0.5)

	live := nextReminder(t, harshSocket)
	if live.ID == "" || live.Status != "pending" {
		t.Fatalf("notify frame lacks the record: id %q status %q", live.ID, live.Status)
	}
	hersLive := nextReminder(t, nishthaTab1)
	nextReminder(t, nishthaTab2)

	// Both have it pending, each only their own.
	harshPending := s.reminders(t, apiToken, "?status=pending")
	hersPending := s.reminders(t, nishtha.token, "?status=pending")
	if len(harshPending) != 1 || harshPending[0]["id"] != live.ID || harshPending[0]["body"] != "buy milk" {
		t.Fatalf("Harsh's pending = %v", harshPending)
	}
	if len(hersPending) != 1 || hersPending[0]["id"] != hersLive.ID || hersPending[0]["fromName"] != "Aravind" ||
		hersPending[0]["ownerId"] != seed.DemoUserID || hersPending[0]["status"] != "pending" {
		t.Fatalf("Nishtha's pending = %v", hersPending)
	}

	// Bad status is a 400; someone else's reminder is a 404 to everyone else.
	if code := s.status(http.MethodGet, "/api/v1/reminders?status=bogus", nil); code != http.StatusBadRequest {
		t.Errorf("status=bogus = %d, want 400", code)
	}
	if code := s.status(http.MethodPost, "/api/v1/reminders/"+hersLive.ID+"/ack", nil); code != http.StatusNotFound {
		t.Errorf("owner acking Nishtha's reminder = %d, want 404", code)
	}
	stranger := s.addPeer(t, "usr_stranger", "stranger@lura.local", "Stranger")
	if code := s.statusAs(stranger.token, http.MethodPost, "/api/v1/reminders/"+hersLive.ID+"/ack", nil); code != http.StatusNotFound {
		t.Errorf("stranger acking = %d, want 404", code)
	}
	if code := s.statusAs(nishtha.token, http.MethodPost, "/api/v1/reminders/rem_nope/ack", nil); code != http.StatusNotFound {
		t.Errorf("missing id = %d, want 404", code)
	}

	// Nishtha acknowledges in one tab: both her tabs clear, Harsh is told.
	res := s.jsonAs(nishtha.token, http.MethodPost, "/api/v1/reminders/"+hersLive.ID+"/ack", nil, http.StatusOK)
	acked := res["reminder"].(map[string]any)
	if acked["status"] != "acknowledged" || acked["ackedAt"] == nil || acked["ackedBy"] != nishtha.userID {
		t.Errorf("ack response = %v", res)
	}
	if done, _ := res["notesDone"].([]any); len(done) != 0 {
		t.Errorf("note done while Harsh has it pending: %v", done)
	}
	for _, tab := range []*websocket.Conn{nishthaTab1, nishthaTab2} {
		if f := nextAckFrame(t, tab); f.ID != hersLive.ID || f.AckedAt.IsZero() {
			t.Errorf("reminder_ack = %+v", f)
		}
	}
	notice := nextReminder(t, harshSocket)
	if notice.Kind != "ack" || notice.Title != "Nishtha acknowledged buy milk" || notice.Status != "acknowledged" {
		t.Errorf("owner's ack notice = %+v", notice)
	}

	// Idempotent.
	again := s.jsonAs(nishtha.token, http.MethodPost, "/api/v1/reminders/"+hersLive.ID+"/ack", nil, http.StatusOK)
	if again["reminder"].(map[string]any)["ackedAt"] != acked["ackedAt"] {
		t.Errorf("second ack moved ackedAt: %v vs %v", again["reminder"], acked)
	}
	if got := s.reminders(t, nishtha.token, "?status=pending"); len(got) != 0 {
		t.Errorf("Nishtha still has %d pending", len(got))
	}
	if got := s.reminders(t, nishtha.token, "?status=acknowledged"); len(got) != 1 {
		t.Errorf("Nishtha acknowledged = %d, want 1", len(got))
	}

	// Harsh acknowledges his: everyone has, so the note is done.
	mine := s.json(http.MethodPost, "/api/v1/reminders/"+live.ID+"/ack", nil, http.StatusOK)
	if done, _ := mine["notesDone"].([]any); len(done) != 1 || done[0] != noteID {
		t.Errorf("notesDone = %v, want [%s]", mine["notesDone"], noteID)
	}
	if n := s.json(http.MethodGet, "/api/v1/notes/"+noteID, nil, http.StatusOK)["note"].(map[string]any); n["done"] != true {
		t.Error("note not done after every recipient acknowledged")
	}
	if f := nextAckFrame(t, harshSocket); f.ID != live.ID {
		t.Errorf("Harsh's reminder_ack = %+v", f)
	}

	// ---- the activity feed, from each side.
	feed := func(token string) []map[string]any {
		body := s.jsonAs(token, http.MethodGet, "/api/v1/activity?from=-2h", nil, http.StatusOK)
		raw := body["items"].([]any)
		out := make([]map[string]any, 0, len(raw))
		for _, r := range raw {
			out = append(out, r.(map[string]any))
		}
		return out
	}
	types := func(items []map[string]any) map[string]int {
		c := map[string]int{}
		for _, it := range items {
			c[it["type"].(string)]++
		}
		return c
	}

	harsh := feed(apiToken)
	ht := types(harsh)
	if ht["geo"] < 1 || ht["reminder"] < 1 || ht["ack"] < 2 || ht["connection"] < 2 {
		t.Errorf("Harsh's feed types = %v", ht)
	}
	var prev string
	for _, it := range harsh {
		ts := it["ts"].(string)
		if _, err := time.Parse(time.RFC3339, ts); err != nil {
			t.Errorf("ts %q is not RFC3339", ts)
		}
		if prev != "" {
			a, _ := time.Parse(time.RFC3339, ts)
			b, _ := time.Parse(time.RFC3339, prev)
			if a.After(b) {
				t.Errorf("feed not newest first: %s after %s", ts, prev)
			}
		}
		prev = ts
		if it["type"] == "geo" && it["subjectName"] != "Nishtha" {
			t.Errorf("geo item = %v, want Nishtha's crossing", it)
		}
		if (it["type"] == "trip" || it["type"] == "stop") && it["deviceId"] == nishtha.deviceID {
			t.Errorf("Nishtha's track leaked into Harsh's feed: %v", it)
		}
	}

	hers := feed(nishtha.token)
	for _, it := range hers {
		switch it["type"] {
		case "geo":
			t.Errorf("Nishtha sees Harsh's fence event: %v", it)
		case "trip", "stop":
			if it["deviceId"] != nishtha.deviceID {
				t.Errorf("another person's movement in Nishtha's feed: %v", it)
			}
		}
	}
	nt := types(hers)
	if nt["reminder"] != 1 || nt["ack"] != 1 || nt["connection"] < 2 {
		t.Errorf("Nishtha's feed types = %v", nt)
	}

	if code := s.status(http.MethodGet, "/api/v1/activity?from=2026-01-02&to=2026-01-01", nil); code != http.StatusBadRequest {
		t.Errorf("inverted window = %d, want 400", code)
	}
}
