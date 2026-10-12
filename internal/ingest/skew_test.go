package ingest_test

import (
	"context"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/ingest"
)

// A device whose clock is ten minutes slow (a laptop whose timer lagged
// through sleep) is still live: FixTS is its arrival, not ten minutes ago.
// When the same device later uploads fixes it queued in a tunnel, those are
// dated by its clock corrected for that offset — as history.
func TestFixTimeCorrectsTheDeviceClockAndSeesQueuedFixes(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	clock := now
	svc := ingest.New(b, nil, 600, 60).WithClock(func() time.Time { return clock })
	ctx := context.Background()
	slow := 10 * time.Minute

	// Live, every 10 s, from a clock ten minutes behind.
	for i := 0; i < 5; i++ {
		clock = now.Add(time.Duration(i) * 10 * time.Second)
		pos, err := svc.Accept(ctx, testDevice, ingest.Payload{
			Type: "location", Lat: 12.97 + float64(i)*1e-4, Lon: 77.63, TST: clock.Add(-slow).Unix(),
		})
		if err != nil {
			t.Fatal(err)
		}
		if d := pos.RecvTS.Sub(pos.FixTS); d < 0 || d > time.Second {
			t.Fatalf("fix %d: FixTS is %v before arrival, want ~0 for a live fix from a slow clock", i, d)
		}
	}

	// Tunnel: five minutes without network, then the queue arrives at once.
	takenAt := clock.Add(30 * time.Second) // device was there 30 s after the last live fix…
	clock = clock.Add(5 * time.Minute)     // …and the fix arrives 5 min later
	pos, err := svc.Accept(ctx, testDevice, ingest.Payload{
		Type: "location", Lat: 12.98, Lon: 77.63, TST: takenAt.Add(-slow).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if pos.Late {
		t.Fatal("a queued fix newer than the last one is history, not out of order")
	}
	if got := pos.FixTS.Sub(takenAt); got < -time.Second || got > time.Second {
		t.Fatalf("FixTS = %v, want when the device was there (%v)", pos.FixTS, takenAt)
	}
}

// Without a timestamp of its own a fix is taken at arrival.
func TestUntimedFixIsTakenAtArrival(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()
	svc := ingest.New(b, nil, 600, 60)
	pos, err := svc.Accept(context.Background(), testDevice, ingest.Payload{Type: "location", Lat: 12.97, Lon: 77.63})
	if err != nil {
		t.Fatal(err)
	}
	if !pos.FixTS.Equal(pos.RecvTS) {
		t.Fatalf("FixTS = %v, RecvTS = %v", pos.FixTS, pos.RecvTS)
	}
}
