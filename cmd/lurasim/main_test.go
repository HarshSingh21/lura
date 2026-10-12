package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestRunStopsOnCancel guards the endless-route stop: with -loops 0 a cancelled
// context used to make every wait and post return immediately, so the loop span
// through its waypoints at full CPU and never exited.
func TestRunStopsOnCancel(t *testing.T) {
	var posts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		posts.Add(1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	s := &simulator{
		baseURL:  srv.URL,
		token:    "t",
		device:   "d",
		client:   srv.Client(),
		quiet:    true,
		battery:  90,
		scale:    1,
		interval: 5 * time.Millisecond,
	}
	route := []waypoint{{Name: "a", Lat: 12.97, Lon: 77.64, SpeedMS: 10}, {Name: "b", Lat: 12.98, Lon: 77.65, SpeedMS: 10}}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.run(ctx, route, 0) }()

	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run after cancel = %v, want nil (a stop is not a failure)", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run did not return after its context was cancelled")
	}
	if posts.Load() == 0 {
		t.Fatal("no fixes were posted before the stop")
	}
}
