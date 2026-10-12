package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// A place or note changed in one session reaches every other live session of
// the same user at once, as an acl frame naming what changed — so a fence moved
// on the phone moves on the laptop without a reload.
func TestWorkspaceChangesReachOtherSessions(t *testing.T) {
	s := newStack(t)
	conn := s.dialWS(t, "/ws?access_token="+apiToken)
	nextFrame(t, conn, "hello", 2*time.Second)

	action := func() string {
		t.Helper()
		f := nextFrame(t, conn, "acl", 2*time.Second)
		var d struct {
			Action string `json:"action"`
		}
		if err := json.Unmarshal(f.Data, &d); err != nil {
			t.Fatalf("acl frame: %v", err)
		}
		return d.Action
	}

	body := s.json(http.MethodPost, "/api/v1/places", map[string]any{
		"name": "Kiosk", "center": map[string]float64{"lat": 12.9, "lon": 77.6}, "radiusM": 60,
	}, http.StatusCreated)
	id := placeOf(t, body)["id"].(string)
	if got := action(); got != "places" {
		t.Fatalf("after create: action %q, want places", got)
	}
	s.json(http.MethodPatch, "/api/v1/places/"+id, map[string]any{"radiusM": 90}, http.StatusOK)
	if got := action(); got != "places" {
		t.Fatalf("after patch: action %q, want places", got)
	}
	s.json(http.MethodPost, "/api/v1/notes", map[string]any{"text": "buy milk", "placeId": id, "trigger": "arrive"}, http.StatusCreated)
	if got := action(); got != "notes" {
		t.Fatalf("after note: action %q, want notes", got)
	}
	resp := s.do(http.MethodDelete, "/api/v1/places/"+id, nil, true)
	_ = resp.Body.Close()
	if got := action(); got != "places" {
		t.Fatalf("after delete: action %q, want places", got)
	}
}
