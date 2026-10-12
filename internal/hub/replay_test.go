package hub_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/hub"
)

// A crossing that fires while the person's socket is down must reach them when
// it comes back — and only theirs, and only what they have not seen.
func TestReplaySendsWhatFiredWhileOffline(t *testing.T) {
	h, b := newHub(t)
	resolve := func(context.Context) ([]string, error) {
		return []string{bus.GeoSubject("u1"), bus.NotifySubject("u1")}, nil
	}

	before := time.Now().UTC()
	time.Sleep(5 * time.Millisecond)
	// Nobody is connected: these are only remembered.
	for _, m := range []struct{ subject, data string }{
		{bus.GeoSubject("u1"), `{"id":"ev1"}`},
		{bus.NotifySubject("u1"), `{"event":{"id":"ev1"}}`},
		{bus.GeoSubject("u2"), `{"id":"someone-else"}`},
	} {
		if err := b.Publish(m.subject, []byte(m.data)); err != nil {
			t.Fatalf("Publish: %v", err)
		}
	}
	time.Sleep(50 * time.Millisecond) // in-process delivery is asynchronous

	c, err := h.Connect(context.Background(), "u1", resolve)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer h.Disconnect(c)
	if n := h.Replay(c, before); n != 2 {
		t.Fatalf("replayed %d frames, want u1's geo and notify", n)
	}
	got := map[string]hub.Frame{}
	for len(got) < 2 {
		select {
		case raw := <-c.Out():
			var f hub.Frame
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatalf("undecodable frame: %v", err)
			}
			if f.Type == hub.FrameGeo || f.Type == hub.FrameNotify {
				got[f.Type] = f
			}
		case <-time.After(time.Second):
			t.Fatalf("replay delivered only %v", got)
		}
	}
	if geo := got[hub.FrameGeo]; string(geo.Data) != `{"id":"ev1"}` || !geo.TS.After(before) {
		t.Errorf("geo = %s at %v", geo.Data, geo.TS)
	}

	// Asking from after the event replays nothing; neither does a fresh page.
	if n := h.Replay(c, time.Now().UTC()); n != 0 {
		t.Errorf("replayed %d frames newer than now", n)
	}
	if n := h.Replay(c, time.Time{}); n != 0 {
		t.Errorf("replayed %d frames with no since", n)
	}
}
