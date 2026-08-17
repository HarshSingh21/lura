package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/coder/websocket"
)

// TestLiveFanoutLatency measures the live path end to end — HTTP POST /pub →
// ingest → bus → Gateway → WebSocket frame — and holds it to the NFR in HLD §2.2:
// p99 ingest→client under 250 ms.
//
// It exists because "real time" is a claim that deserves a number. Sub-millisecond
// is not achievable over a network at all (a loopback round trip alone is
// typically ~0.1–1 ms, a LAN 1–5 ms, mobile 30–80 ms); what the design actually
// promises is that the server adds no meaningful delay of its own, and this is
// what proves it.
func TestLiveFanoutLatency(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	s := newStack(t)

	conn := s.dialWS(t, "/ws?access_token="+apiToken)
	nextFrame(t, conn, hub.FrameHello, 3*time.Second)
	nextFrame(t, conn, "snapshot", 3*time.Second)

	const samples = 40
	latencies := make([]time.Duration, 0, samples)

	for i := 0; i < samples; i++ {
		// Move the device each iteration so nothing can be deduplicated away.
		lat := 12.9500 + float64(i)*0.0002
		sent := time.Now()
		s.json(http.MethodPost, "/pub?device=dev_phone", map[string]any{
			"_type": "location", "lat": lat, "lon": 77.6300, "speedMps": 6,
			"tst": time.Now().Unix(), "seq": i + 1,
		}, http.StatusOK)

		frame := nextFrame(t, conn, hub.FramePosition, 5*time.Second)
		elapsed := time.Since(sent)

		var pos domain.Position
		if err := json.Unmarshal(frame.Data, &pos); err != nil {
			t.Fatalf("position frame: %v", err)
		}
		latencies = append(latencies, elapsed)
	}

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	p := func(q float64) time.Duration {
		idx := int(q * float64(len(latencies)-1))
		return latencies[idx]
	}

	p50, p95, p99, worst := p(0.50), p(0.95), p(0.99), latencies[len(latencies)-1]
	t.Logf("live fan-out over %d fixes: p50 %s · p95 %s · p99 %s · max %s",
		len(latencies), round(p50), round(p95), round(p99), round(worst))

	// The NFR, asserted. Generous against a loaded CI box, but far below the
	// point where a map feels laggy.
	if p99 > 250*time.Millisecond {
		t.Errorf("p99 fan-out latency %s exceeds the 250ms NFR", round(p99))
	}
	// A p50 in the tens of milliseconds would mean something is batching or
	// sleeping on the live path, which is the failure this test really guards.
	if p50 > 50*time.Millisecond {
		t.Errorf("p50 fan-out latency %s is far above the expected single-digit ms", round(p50))
	}
}

// TestPeerFanoutLatency measures the same path for a *peer's* position: the fix
// belongs to one account and is delivered to another that they share with.
//
// The interesting part is that it should be no slower than watching your own
// device — authorization is resolved once when the socket subscribes, not on
// every fix.
func TestPeerFanoutLatency(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	s := newStack(t)
	ctx := context.Background()

	peer := s.addPeer(t, "usr_peer", "peer@lura.local", "Peer")
	s.connectPeers(t, peer)

	// The peer's socket: it must receive the demo user's fixes.
	conn := s.dialWSAs(t, peer)
	nextFrame(t, conn, hub.FrameHello, 3*time.Second)

	const samples = 25
	latencies := make([]time.Duration, 0, samples)
	for i := 0; i < samples; i++ {
		sent := time.Now()
		s.json(http.MethodPost, "/pub?device=dev_phone", map[string]any{
			"_type": "location", "lat": 12.9400 + float64(i)*0.0002, "lon": 77.6100,
			"speedMps": 8, "tst": time.Now().Unix(), "seq": 1000 + i,
		}, http.StatusOK)
		nextFrame(t, conn, hub.FramePosition, 5*time.Second)
		latencies = append(latencies, time.Since(sent))
	}
	_ = ctx

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	p95 := latencies[int(0.95*float64(len(latencies)-1))]
	t.Logf("peer fan-out over %d fixes: p50 %s · p95 %s",
		len(latencies), round(latencies[len(latencies)/2]), round(p95))

	if p95 > 250*time.Millisecond {
		t.Errorf("peer p95 fan-out latency %s exceeds the 250ms NFR", round(p95))
	}
}

func round(d time.Duration) time.Duration {
	if d < time.Millisecond {
		return d.Round(10 * time.Microsecond)
	}
	return d.Round(100 * time.Microsecond)
}

// dialWSAs opens the live socket as another user. The stack's authenticator maps
// one static token to one user, so this uses the per-user token the test stack
// mints in addPeer.
func (s *stack) dialWSAs(t *testing.T, peer testPeer) *websocket.Conn {
	t.Helper()
	return s.dialWS(t, "/ws?access_token="+peer.token)
}
