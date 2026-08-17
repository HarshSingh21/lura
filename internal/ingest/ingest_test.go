package ingest_test

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/ingest"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

func f64(v float64) *float64 { return &v }

var testDevice = domain.Device{ID: "d1", UserID: "u1", Name: "Phone", Token: "tok"}

func TestPayloadValidation(t *testing.T) {
	cases := []struct {
		name    string
		payload ingest.Payload
		wantErr bool
	}{
		{"valid", ingest.Payload{Type: "location", Lat: 12.9611, Lon: 77.6387}, false},
		{"no type is accepted", ingest.Payload{Lat: 12.9611, Lon: 77.6387}, false},
		{"wrong type", ingest.Payload{Type: "transition", Lat: 12.9611, Lon: 77.6387}, true},
		{"null island", ingest.Payload{Type: "location", Lat: 0, Lon: 0}, true},
		{"latitude out of range", ingest.Payload{Type: "location", Lat: 91, Lon: 77}, true},
		{"longitude out of range", ingest.Payload{Type: "location", Lat: 12, Lon: 181}, true},
		{"NaN", ingest.Payload{Type: "location", Lat: math.NaN(), Lon: 77}, true},
		{"negative accuracy", ingest.Payload{Type: "location", Lat: 12, Lon: 77, Acc: f64(-1)}, true},
		{"battery over 100", ingest.Payload{Type: "location", Lat: 12, Lon: 77, Batt: f64(120)}, true},
		{"battery at 100", ingest.Payload{Type: "location", Lat: 12, Lon: 77, Batt: f64(100)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.payload.Validate()
			if tc.wantErr && err == nil {
				t.Fatal("want an error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr && !errors.Is(err, domain.ErrInvalid) {
				t.Errorf("error = %v, want ErrInvalid", err)
			}
		})
	}
}

// OwnTracks reports velocity in km/h. Getting this conversion wrong would make
// every fly-by filter decision wrong by a factor of 3.6.
func TestOwnTracksVelocityIsConvertedToMetresPerSecond(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	got := make(chan domain.Position, 1)
	sub, err := b.Subscribe("pos.>", func(m bus.Msg) {
		var p domain.Position
		if err := json.Unmarshal(m.Data, &p); err != nil {
			t.Errorf("unmarshal: %v", err)
			return
		}
		got <- p
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	svc := ingest.New(b, nil, 600, 60)
	if _, err := svc.Accept(context.Background(), testDevice, ingest.Payload{
		Type: "location", Lat: 12.9611, Lon: 77.6387, Vel: f64(36), // 36 km/h
	}); err != nil {
		t.Fatalf("Accept: %v", err)
	}

	select {
	case p := <-got:
		if math.Abs(p.SpeedMPS-10) > 0.001 {
			t.Errorf("SpeedMPS = %v, want 10 (36 km/h)", p.SpeedMPS)
		}
	case <-time.After(time.Second):
		t.Fatal("no position published")
	}
}

// Lura's own clients send exact m/s, which must win over the km/h field.
func TestSpeedMpsOverridesVelocity(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()
	svc := ingest.New(b, nil, 600, 60)

	pos, err := svc.Accept(context.Background(), testDevice, ingest.Payload{
		Type: "location", Lat: 12.9611, Lon: 77.6387, Vel: f64(100), SpeedMPS: f64(4.2),
	})
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if pos.SpeedMPS != 4.2 {
		t.Errorf("SpeedMPS = %v, want 4.2", pos.SpeedMPS)
	}
}

// The device's own clock is data, never authority: recv_ts must be the server's
// (HLD §5.2), or a phone with a wrong clock could defeat the freshness gate.
func TestServerTimestampIsAuthoritative(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	fixed := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	svc := ingest.New(b, nil, 600, 60).WithClock(func() time.Time { return fixed })

	// A device claiming it is 1970 (or 2035) must not move recv_ts.
	for _, deviceTS := range []int64{0, 1, 2_000_000_000} {
		pos, err := svc.Accept(context.Background(), testDevice, ingest.Payload{
			Type: "location", Lat: 12.9611, Lon: 77.6387, TST: deviceTS,
		})
		if err != nil {
			t.Fatalf("Accept: %v", err)
		}
		if !pos.RecvTS.Equal(fixed) {
			t.Errorf("RecvTS = %v, want the server clock %v", pos.RecvTS, fixed)
		}
		if deviceTS > 0 && pos.DeviceTS.Unix() != deviceTS {
			t.Errorf("DeviceTS = %v, want the device's own %d", pos.DeviceTS, deviceTS)
		}
	}
}

// Both paths must be published: durable (history + reminders) and core (live map).
func TestAcceptPublishesToBothPaths(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	var wg sync.WaitGroup
	wg.Add(2)
	live, err := b.Subscribe(bus.PosAll(), func(bus.Msg) { wg.Done() })
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer live.Unsubscribe()
	durable, err := b.SubscribePartitioned(bus.PosAll(), 1, bus.DeviceKey, func(bus.Msg) { wg.Done() })
	if err != nil {
		t.Fatalf("SubscribePartitioned: %v", err)
	}
	defer durable.Unsubscribe()

	svc := ingest.New(b, nil, 600, 60)
	if _, err := svc.Accept(context.Background(), testDevice, ingest.Payload{
		Type: "location", Lat: 12.9611, Lon: 77.6387,
	}); err != nil {
		t.Fatalf("Accept: %v", err)
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a fix did not reach both the live and durable paths")
	}
}

func TestRateLimitPerDevice(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	// 60/min sustained with a burst of 3: the fourth immediate fix is refused.
	svc := ingest.New(b, nil, 60, 3)
	payload := ingest.Payload{Type: "location", Lat: 12.9611, Lon: 77.6387}

	for i := 0; i < 3; i++ {
		if _, err := svc.Accept(context.Background(), testDevice, payload); err != nil {
			t.Fatalf("fix %d rejected: %v", i+1, err)
		}
	}
	_, err := svc.Accept(context.Background(), testDevice, payload)
	if !errors.Is(err, ingest.ErrRateLimited) {
		t.Fatalf("fourth fix error = %v, want ErrRateLimited", err)
	}
	if retry := svc.RetryAfter(testDevice.ID); retry <= 0 {
		t.Error("RetryAfter should report a positive wait for a limited device")
	}

	// A different device has its own budget: one noisy tracker must not silence
	// the household.
	other := domain.Device{ID: "d2", UserID: "u1", Name: "Watch", Token: "tok2"}
	if _, err := svc.Accept(context.Background(), other, payload); err != nil {
		t.Errorf("second device was rate-limited by the first: %v", err)
	}
}

// ---------------------------------------------------------------- writer

// The writer must persist what ingest accepted and apply the monotonic guard.
func TestWriterPersistsAndAppliesMonotonicGuard(t *testing.T) {
	ctx := context.Background()
	st := memory.New()
	if err := st.UpsertUser(ctx, domain.User{ID: "u1", TZ: "UTC"}); err != nil {
		t.Fatalf("UpsertUser: %v", err)
	}
	if err := st.UpsertDevice(ctx, testDevice); err != nil {
		t.Fatalf("UpsertDevice: %v", err)
	}

	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	w := ingest.NewWriter(st, b, nil, ingest.WriterOptions{BatchSize: 10, FlushEvery: 20 * time.Millisecond})
	if err := w.Start(ctx); err != nil {
		t.Fatalf("writer Start: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	newest := domain.Point{Lat: 12.9611, Lon: 77.6387}
	replayed := domain.Point{Lat: 12.9000, Lon: 77.6000}

	// A current fix, then a batch of much older ones (an offline replay).
	fixes := []domain.Position{
		{DeviceID: "d1", UserID: "u1", RecvTS: now, DeviceTS: now, Point: newest, SpeedMPS: 2},
		{DeviceID: "d1", UserID: "u1", RecvTS: now.Add(-time.Hour), DeviceTS: now.Add(-time.Hour), Point: replayed},
		{DeviceID: "d1", UserID: "u1", RecvTS: now.Add(-59 * time.Minute), Point: replayed},
	}
	for _, p := range fixes {
		if err := bus.PublishDurableJSON(b, bus.PosSubject("u1", "d1"), p); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}

	w.Stop() // drains before returning

	rows, err := st.ListPositions(ctx, "u1", store.PositionQuery{DeviceID: "d1"})
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("stored %d fixes, want 3 (replays belong in history)", len(rows))
	}

	dev, err := st.GetDevice(ctx, "u1", "d1")
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	if dev.LastPoint == nil {
		t.Fatal("last_point never set")
	}
	if math.Abs(dev.LastPoint.Lat-newest.Lat) > 1e-9 {
		t.Errorf("last_point = %+v, want the newest fix %+v (replay moved the live marker)",
			*dev.LastPoint, newest)
	}
}

// Redelivery of the same fix must not duplicate a history row.
func TestWriterIsIdempotent(t *testing.T) {
	ctx := context.Background()
	st := memory.New()
	_ = st.UpsertUser(ctx, domain.User{ID: "u1", TZ: "UTC"})
	_ = st.UpsertDevice(ctx, testDevice)

	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	w := ingest.NewWriter(st, b, nil, ingest.WriterOptions{BatchSize: 2, FlushEvery: 10 * time.Millisecond})
	if err := w.Start(ctx); err != nil {
		t.Fatalf("writer Start: %v", err)
	}

	ts := time.Now().UTC().Truncate(time.Microsecond)
	fix := domain.Position{DeviceID: "d1", UserID: "u1", RecvTS: ts, DeviceTS: ts,
		Point: domain.Point{Lat: 12.9611, Lon: 77.6387}}

	for i := 0; i < 5; i++ { // same fix, five deliveries
		if err := bus.PublishDurableJSON(b, bus.PosSubject("u1", "d1"), fix); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	w.Stop()

	rows, err := st.ListPositions(ctx, "u1", store.PositionQuery{DeviceID: "d1"})
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("stored %d rows for five deliveries of one fix, want 1", len(rows))
	}
}
