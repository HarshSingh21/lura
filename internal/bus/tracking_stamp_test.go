package bus_test

import (
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
)

// Every subscriber sees one publish time per message, and those times
// strictly increase even for messages published in the same clock tick —
// which is what lets a reconnecting socket name "the last frame I saw".
func TestPublishStampsOneStrictlyIncreasingTime(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	const n = 200
	var mu sync.Mutex
	got := map[string][]time.Time{}
	var wg sync.WaitGroup
	wg.Add(2 * n)
	for _, name := range []string{"a", "b"} {
		if _, err := b.Subscribe("geo.*", func(m bus.Msg) {
			mu.Lock()
			got[name] = append(got[name], m.TS)
			mu.Unlock()
			wg.Done()
		}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < n; i++ {
		if err := b.Publish(bus.GeoSubject("u1"), []byte(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()

	for i := 0; i < n; i++ {
		if got["a"][i].IsZero() || !got["a"][i].Equal(got["b"][i]) {
			t.Fatalf("message %d: subscribers saw %v and %v", i, got["a"][i], got["b"][i])
		}
		if i > 0 && !got["a"][i].After(got["a"][i-1]) {
			t.Fatalf("message %d stamped %v, not after %v", i, got["a"][i], got["a"][i-1])
		}
	}
}
