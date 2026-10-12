package geo

import (
	"errors"
	"math"
	"testing"
)

// square is a ~108 m × ~111 m box in Bengaluru, wound counter-clockwise.
func square() []Vertex {
	return []Vertex{
		{12.9600, 77.6380},
		{12.9600, 77.6390},
		{12.9610, 77.6390},
		{12.9610, 77.6380},
	}
}

func TestValidatePolygon(t *testing.T) {
	cases := []struct {
		name string
		ring []Vertex
		want error
	}{
		{"square", square(), nil},
		{"clockwise square", reverse(square()), nil},
		{"triangle", []Vertex{{12.96, 77.63}, {12.961, 77.63}, {12.9605, 77.631}}, nil},
		{"two vertices", square()[:2], ErrPolygonTooFew},
		{"too many", circleRing(201), ErrPolygonTooMany},
		{"200 is fine", circleRing(200), nil},
		{"bad vertex", []Vertex{{12.96, 77.63}, {95, 77.63}, {12.9605, 77.631}}, ErrPolygonBadVertex},
		{"repeated vertex", []Vertex{{12.96, 77.63}, {12.96, 77.63}, {12.961, 77.63}, {12.9605, 77.631}}, ErrPolygonDuplicate},
		{"collinear", []Vertex{{12.96, 77.63}, {12.961, 77.63}, {12.962, 77.63}}, ErrPolygonSelfCrossing}, // the closing edge folds back
		{"bow tie", []Vertex{
			{12.9600, 77.6380}, {12.9610, 77.6390}, {12.9600, 77.6390}, {12.9610, 77.6380},
		}, ErrPolygonSelfCrossing},
		{"vertex touching an edge", []Vertex{
			{12.9600, 77.6380}, {12.9600, 77.6390}, {12.9610, 77.6390},
			{12.9600, 77.6385}, // lies on the first edge
			{12.9610, 77.6380},
		}, ErrPolygonSelfCrossing},
		{"spike", []Vertex{
			{12.9600, 77.6380}, {12.9600, 77.6390}, {12.9600, 77.6385}, {12.9610, 77.6385},
		}, ErrPolygonSelfCrossing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePolygon(tc.ring)
			if !errors.Is(err, tc.want) {
				t.Fatalf("ValidatePolygon = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestPointInPolygon(t *testing.T) {
	sq := square()
	cases := []struct {
		name     string
		lat, lon float64
		want     bool
	}{
		{"centre", 12.9605, 77.6385, true},
		{"just inside", 12.96001, 77.63801, true},
		{"on an edge", 12.9600, 77.6385, true},
		{"on a vertex", 12.9610, 77.6390, true},
		{"north", 12.9612, 77.6385, false},
		{"east", 12.9605, 77.6392, false},
		{"far", 13.0, 78.0, false},
	}
	for _, tc := range cases {
		if got := PointInPolygon(tc.lat, tc.lon, sq); got != tc.want {
			t.Errorf("%s: PointInPolygon = %v, want %v", tc.name, got, tc.want)
		}
		if got := PointInPolygon(tc.lat, tc.lon, reverse(sq)); got != tc.want {
			t.Errorf("%s (clockwise): PointInPolygon = %v, want %v", tc.name, got, tc.want)
		}
	}

	// A concave "L": the notch is outside even though it is inside the bbox.
	l := []Vertex{
		{12.9600, 77.6380}, {12.9600, 77.6390}, {12.9605, 77.6390},
		{12.9605, 77.6385}, {12.9610, 77.6385}, {12.9610, 77.6380},
	}
	if PointInPolygon(12.9608, 77.6388, l) {
		t.Error("point in the notch of an L counted as inside")
	}
	if !PointInPolygon(12.9608, 77.6382, l) {
		t.Error("point in the upright of an L counted as outside")
	}
}

func TestCentroidAndBoundingRadius(t *testing.T) {
	c := Centroid(square())
	if math.Abs(c.Lat-12.9605) > 1e-7 || math.Abs(c.Lon-77.6385) > 1e-7 {
		t.Fatalf("centroid = %+v, want 12.9605,77.6385", c)
	}
	r := BoundingRadiusM(c, square())
	// half-diagonal of ~108 m × ~111 m ≈ 77.5 m
	if r < 76 || r > 79 {
		t.Fatalf("bounding radius = %d, want ≈ 78", r)
	}
	for _, v := range square() {
		if !DWithin(c.Lat, c.Lon, v.Lat, v.Lon, float64(r)) {
			t.Errorf("vertex %+v is outside the bounding radius", v)
		}
	}

	// A concave L's centroid is pulled toward its heavier arm, not the bbox middle.
	l := []Vertex{
		{0, 0}, {0, 0.002}, {0.001, 0.002}, {0.001, 0.001}, {0.002, 0.001}, {0.002, 0},
	}
	lc := Centroid(l)
	if math.Abs(lc.Lat-0.000833) > 1e-5 || math.Abs(lc.Lon-0.000833) > 1e-5 {
		t.Errorf("L centroid = %+v, want ≈ 0.000833,0.000833", lc)
	}
}

func TestOpenRing(t *testing.T) {
	closed := append(square(), square()[0])
	if got := OpenRing(closed); len(got) != 4 {
		t.Fatalf("OpenRing kept %d vertices, want 4", len(got))
	}
	if got := OpenRing(square()); len(got) != 4 {
		t.Fatalf("OpenRing changed an open ring to %d vertices", len(got))
	}
}

func reverse(in []Vertex) []Vertex {
	out := make([]Vertex, len(in))
	for i, v := range in {
		out[len(in)-1-i] = v
	}
	return out
}

func circleRing(n int) []Vertex {
	out := make([]Vertex, n)
	for i := range out {
		lat, lon := Destination(12.96, 77.63, float64(i)*360/float64(n), 200)
		out[i] = Vertex{lat, lon}
	}
	return out
}
