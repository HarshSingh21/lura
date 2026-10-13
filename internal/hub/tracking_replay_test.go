package hub_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/hub"
)

// Reconnect replay must be exactly once: a client that reconnects with
// since=<the time of the newest frame it saw> is sent what it missed and
// nothing it already has.

func geoResolver(user string) hub.SubjectResolver {
	return func(context.Context) ([]string, error) { return []string{bus.GeoSubject(user)}, nil }
}

// collect reads every geo frame that arrives within d.
func collect(t *testing.T, c *hub.Client, d time.Duration) []hub.Frame {
	t.Helper()
	var out []hub.Frame
	deadline := time.After(d)
	for {
		select {
		case raw, ok := <-c.Out():
			if !ok {
				return out
			}
			var f hub.Frame
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatalf("undecodable frame: %v", err)
			}
			if f.Type == hub.FrameGeo {
				out = append(out, f)
			}
		case <-deadline:
			return out
		}
	}
}

// The time on a live frame is the time replay files it under. If the two are
// stamped separately, a client resuming from the newest frame it saw is sent
// that frame again (or misses one stamped just before it).
func TestReplayFromAnyLiveFrameSendsOnlyWhatCameAfter(t *testing.T) {
	h, b := newHub(t)
	live, err := h.Connect(context.Background(), "u1", geoResolver("u1"))
	if err != nil {
		t.Fatal(err)
	}
	const n = 40
	for i := 0; i < n; i++ {
		if err := b.Publish(bus.GeoSubject("u1"), []byte(fmt.Sprintf(`{"id":"ev%02d"}`, i))); err != nil {
			t.Fatal(err)
		}
	}
	frames := collect(t, live, 300*time.Millisecond)
	if len(frames) != n {
		t.Fatalf("live client got %d of %d frames", len(frames), n)
	}
	h.Disconnect(live)

	for i, seen := range frames {
		back, err := h.Connect(context.Background(), "u1", geoResolver("u1"))
		if err != nil {
			t.Fatal(err)
		}
		h.Replay(back, seen.TS)
		got := collect(t, back, 30*time.Millisecond)
		h.Disconnect(back)
		if len(got) != n-1-i {
			t.Fatalf("resuming after frame %d (%s) replayed %d frames, want %d", i, seen.Data, len(got), n-1-i)
		}
		for j, f := range got {
			if want := frames[i+1+j]; string(f.Data) != string(want.Data) {
				t.Fatalf("resuming after frame %d: replay[%d] = %s, want %s", i, j, f.Data, want.Data)
			}
		}
	}
}

// A crossing that fires between the reconnecting socket subscribing and the
// replay running is delivered live; the replay must not send it a second time.
func TestReplayDoesNotRepeatWhatArrivedLiveSinceConnecting(t *testing.T) {
	h, b := newHub(t)
	since := time.Now().UTC()
	time.Sleep(2 * time.Millisecond)

	c, err := h.Connect(context.Background(), "u1", geoResolver("u1"))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Disconnect(c)
	if err := b.Publish(bus.GeoSubject("u1"), []byte(`{"id":"while-connecting"}`)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond) // delivered live and remembered
	h.Replay(c, since)
	// And one that fires after the replay: live only, once.
	if err := b.Publish(bus.GeoSubject("u1"), []byte(`{"id":"after"}`)); err != nil {
		t.Fatal(err)
	}

	counts := map[string]int{}
	for _, f := range collect(t, c, 200*time.Millisecond) {
		counts[string(f.Data)]++
	}
	if counts[`{"id":"while-connecting"}`] != 1 || counts[`{"id":"after"}`] != 1 || len(counts) != 2 {
		t.Fatalf("frames received = %v, want each event exactly once", counts)
	}
}

// What fired while the client was away still arrives, once, alongside what
// arrives live afterwards.
func TestReplayStillSendsWhatFiredBeforeConnecting(t *testing.T) {
	h, b := newHub(t)
	since := time.Now().UTC()
	time.Sleep(2 * time.Millisecond)
	if err := b.Publish(bus.GeoSubject("u1"), []byte(`{"id":"offline"}`)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)

	c, err := h.Connect(context.Background(), "u1", geoResolver("u1"))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Disconnect(c)
	if n := h.Replay(c, since); n != 1 {
		t.Fatalf("replayed %d, want the offline event", n)
	}
	if err := b.Publish(bus.GeoSubject("u1"), []byte(`{"id":"live"}`)); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, f := range collect(t, c, 200*time.Millisecond) {
		counts[string(f.Data)]++
	}
	if counts[`{"id":"offline"}`] != 1 || counts[`{"id":"live"}`] != 1 {
		t.Fatalf("frames received = %v, want each exactly once", counts)
	}
}
