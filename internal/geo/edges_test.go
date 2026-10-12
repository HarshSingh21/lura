package geo

import (
	"math"
	"testing"
)

func TestDistanceToRingM(t *testing.T) {
	sq := square()
	// 0.0002° of latitude south of the bottom edge is ~22.2 m.
	if d := DistanceToRingM(Vertex{12.9598, 77.6385}, sq); math.Abs(d-22.24) > 0.1 {
		t.Errorf("below the bottom edge: %.2f m, want ~22.24", d)
	}
	// The centre is ~54 m from the nearest (east/west) edge.
	if d := DistanceToRingM(Vertex{12.9605, 77.6385}, sq); math.Abs(d-54.2) > 0.5 {
		t.Errorf("centre: %.2f m, want ~54.2", d)
	}
	// Past a corner, the distance is to the corner itself.
	c := Vertex{12.9612, 77.6392}
	want := DistanceM(c.Lat, c.Lon, 12.9610, 77.6390)
	if d := DistanceToRingM(c, sq); math.Abs(d-want) > 0.05 {
		t.Errorf("past the corner: %.2f m, want %.2f", d, want)
	}
}

func TestSegmentCrossesRing(t *testing.T) {
	sq := square()
	cases := []struct {
		name string
		a, b Vertex
		want bool
	}{
		{"straight through", Vertex{12.9595, 77.6385}, Vertex{12.9615, 77.6385}, true},
		{"clips a corner", Vertex{12.9612, 77.6386}, Vertex{12.9606, 77.6393}, true},
		{"passes alongside", Vertex{12.9595, 77.6392}, Vertex{12.9615, 77.6392}, false},
		{"stops short", Vertex{12.9590, 77.6385}, Vertex{12.9598, 77.6385}, false},
	}
	for _, tc := range cases {
		if got := SegmentCrossesRing(tc.a, tc.b, sq); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestSegmentDistanceAndClosestPoint(t *testing.T) {
	p := Vertex{12.9605, 77.6385}
	a, b := Vertex{12.9600, 77.6395}, Vertex{12.9610, 77.6395}
	want := DistanceM(p.Lat, p.Lon, p.Lat, 77.6395)
	if d := SegmentDistanceM(p, a, b); math.Abs(d-want) > 0.05 {
		t.Errorf("distance %.2f, want %.2f", d, want)
	}
	if c := ClosestPointOnSegment(p, a, b); math.Abs(c.Lat-p.Lat) > 1e-7 || math.Abs(c.Lon-77.6395) > 1e-9 {
		t.Errorf("closest point %+v", c)
	}
	// Beyond an end, the end is closest.
	if c := ClosestPointOnSegment(Vertex{12.9620, 77.6395}, a, b); c != b {
		t.Errorf("closest point past b: %+v", c)
	}
}
