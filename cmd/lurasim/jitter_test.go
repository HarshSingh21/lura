package main

import (
	"math"
	"testing"

	"github.com/HarshSingh21/locnot/internal/geo"
)

// TestJitterCoversTheDisc guards GPS noise that is noise in every direction: a
// phone parked a few metres inside a fence's east edge must sometimes land
// outside it. The old clock-derived jitter tied distance to bearing, so a fix
// east of the spot was never more than a quarter of the radius away.
func TestJitterCoversTheDisc(t *testing.T) {
	const lat, lon, r = 12.935, 77.63, 10.0
	far := map[int]int{} // samples beyond 0.8 r, per 90° quadrant (0 = north-east)
	for i := 0; i < 4000; i++ {
		jl, jo := jitter(lat, lon, r)
		d := geo.DistanceM(lat, lon, jl, jo)
		if d > r+0.01 {
			t.Fatalf("jitter %.2f m exceeds the %.0f m radius", d, r)
		}
		if d > 0.8*r {
			far[int(geo.BearingDeg(lat, lon, jl, jo))/90%4]++
		}
	}
	for q := 0; q < 4; q++ {
		if far[q] < 100 {
			t.Errorf("quadrant %d: %d of 4000 fixes reached 0.8 r, want ≥ 100 (%v)", q, far[q], far)
		}
	}
}

func TestJitterWithIsUniformInArea(t *testing.T) {
	// Half the draws (v < 0.5) land inside r/√2: equal areas, equal chances.
	jl, jo := jitterWith(12.935, 77.63, 10, 0.25, 0.5)
	if d := geo.DistanceM(12.935, 77.63, jl, jo); math.Abs(d-10/math.Sqrt2) > 0.05 {
		t.Errorf("distance %.3f, want %.3f", d, 10/math.Sqrt2)
	}
	if b := geo.BearingDeg(12.935, 77.63, jl, jo); math.Abs(b-90) > 0.5 {
		t.Errorf("bearing %.1f, want 90", b)
	}
}
