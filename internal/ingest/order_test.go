package ingest_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/ingest"
)

// liveFrames records what the live map would be sent.
func liveFrames(t *testing.T, b bus.Bus) func() []domain.Position {
	t.Helper()
	var mu sync.Mutex
	var got []domain.Position
	sub, err := b.Subscribe(bus.PosAll(), func(m bus.Msg) {
		var p domain.Position
		if err := json.Unmarshal(m.Data, &p); err != nil {
			t.Errorf("unmarshal: %v", err)
			return
		}
		mu.Lock()
		got = append(got, p)
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	t.Cleanup(sub.Unsubscribe)
	return func() []domain.Position {
		time.Sleep(50 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		return append([]domain.Position(nil), got...)
	}
}

// A phone on a flaky network can deliver a fix it took 30 s ago after the one
// it took just now. The live map must never step backwards to it, and the
// newest fix's resend must not stutter the marker.
func TestLateAndDuplicateFixesNeverReachTheLiveMap(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()
	frames := liveFrames(t, b)
	svc := ingest.New(b, nil, 600, 60)
	ctx := context.Background()
	now := time.Now().Unix()

	newest := ingest.Payload{Type: "location", Lat: 12.9709, Lon: 77.6384, TST: now, SpeedMPS: f64(1.2)}
	if pos, err := svc.Accept(ctx, testDevice, newest); err != nil || pos.Late {
		t.Fatalf("newest: pos=%+v err=%v", pos, err)
	}
	late, err := svc.Accept(ctx, testDevice, ingest.Payload{Type: "location", Lat: 12.97, Lon: 77.637, TST: now - 30})
	if err != nil {
		t.Fatalf("late fix refused: %v (it is still history)", err)
	}
	if !late.Late {
		t.Error("a fix 30 s older than the newest was not marked late")
	}
	if _, err := svc.Accept(ctx, testDevice, newest); err != nil {
		t.Fatalf("duplicate refused: %v (a resend must be acked)", err)
	}

	got := frames()
	if len(got) != 1 || got[0].Point.Lat != newest.Lat {
		t.Fatalf("live frames = %+v, want only the newest fix once", got)
	}
}

// tst has one-second resolution: two genuine fixes in the same second are both
// news, and so is anything that carries no time of its own.
func TestSameSecondAndUntimedFixesAreNews(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()
	frames := liveFrames(t, b)
	svc := ingest.New(b, nil, 600, 60)
	ctx := context.Background()
	now := time.Now().Unix()

	for _, p := range []ingest.Payload{
		{Type: "location", Lat: 12.9709, Lon: 77.6384, TST: now},
		{Type: "location", Lat: 12.9710, Lon: 77.6385, TST: now}, // same second, moved
		{Type: "location", Lat: 12.9711, Lon: 77.6386},           // no tst at all
		{Type: "location", Lat: 12.9711, Lon: 77.6386},           // again: cannot be ordered, so it is news
	} {
		if pos, err := svc.Accept(ctx, testDevice, p); err != nil || pos.Late {
			t.Fatalf("%+v: pos=%+v err=%v", p, pos, err)
		}
	}
	if got := frames(); len(got) != 4 {
		t.Fatalf("live frames = %d, want 4", len(got))
	}
}

// Each device is ordered on its own: one phone's newer clock says nothing
// about another's.
func TestOrderIsPerDevice(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()
	svc := ingest.New(b, nil, 600, 60)
	ctx := context.Background()
	now := time.Now().Unix()
	if _, err := svc.Accept(ctx, testDevice, ingest.Payload{Type: "location", Lat: 12.97, Lon: 77.63, TST: now}); err != nil {
		t.Fatal(err)
	}
	other := domain.Device{ID: "d2", UserID: "u1", Name: "Tablet", Token: "t2"}
	pos, err := svc.Accept(ctx, other, ingest.Payload{Type: "location", Lat: 12.97, Lon: 77.63, TST: now - 600})
	if err != nil || pos.Late {
		t.Fatalf("another device's first fix: pos=%+v err=%v", pos, err)
	}
}
