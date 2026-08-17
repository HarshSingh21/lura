// Package geo holds the spherical-geometry helpers Lura needs when it is not
// delegating to PostGIS: the memory store and the trip segmenter use these, and
// they double as the fallback path when PostGIS/Tile38 is unavailable
// (HLD §10, "Tile38 down → fall back to inline PostGIS eval").
package geo

import "math"

// EarthRadiusM is the mean Earth radius used by PostGIS' spheroid-free math.
const EarthRadiusM = 6371008.8

// DistanceM returns the great-circle distance in metres between two points.
// This mirrors ST_Distance on GEOGRAPHY closely enough for geofence radii
// (sub-metre agreement at city scale).
func DistanceM(lat1, lon1, lat2, lon2 float64) float64 {
	φ1, φ2 := rad(lat1), rad(lat2)
	Δφ := φ2 - φ1
	Δλ := rad(lon2 - lon1)
	s := math.Sin(Δφ/2)*math.Sin(Δφ/2) +
		math.Cos(φ1)*math.Cos(φ2)*math.Sin(Δλ/2)*math.Sin(Δλ/2)
	return 2 * EarthRadiusM * math.Asin(math.Sqrt(math.Min(1, s)))
}

// DWithin reports whether two points are within radius metres of each other —
// the in-process equivalent of ST_DWithin(geography, geography, radius).
func DWithin(lat1, lon1, lat2, lon2, radiusM float64) bool {
	return DistanceM(lat1, lon1, lat2, lon2) <= radiusM
}

// BearingDeg returns the initial compass bearing from point 1 to point 2.
func BearingDeg(lat1, lon1, lat2, lon2 float64) float64 {
	φ1, φ2 := rad(lat1), rad(lat2)
	Δλ := rad(lon2 - lon1)
	y := math.Sin(Δλ) * math.Cos(φ2)
	x := math.Cos(φ1)*math.Sin(φ2) - math.Sin(φ1)*math.Cos(φ2)*math.Cos(Δλ)
	d := deg(math.Atan2(y, x))
	if d < 0 {
		d += 360
	}
	return d
}

// Destination returns the point reached by travelling distM metres from
// (lat, lon) along bearing bearingDeg. Used by the device simulator.
func Destination(lat, lon, bearingDeg, distM float64) (float64, float64) {
	φ1, λ1, θ := rad(lat), rad(lon), rad(bearingDeg)
	δ := distM / EarthRadiusM
	sinφ2 := math.Sin(φ1)*math.Cos(δ) + math.Cos(φ1)*math.Sin(δ)*math.Cos(θ)
	φ2 := math.Asin(sinφ2)
	λ2 := λ1 + math.Atan2(math.Sin(θ)*math.Sin(δ)*math.Cos(φ1), math.Cos(δ)-math.Sin(φ1)*sinφ2)
	return deg(φ2), math.Mod(deg(λ2)+540, 360) - 180
}

// BBox is a lat/lon bounding box.
type BBox struct {
	MinLat, MinLon, MaxLat, MaxLon float64
}

// BBoxAround returns a bounding box that fully contains the circle of radius
// radiusM around (lat, lon). The memory store uses it as a cheap pre-filter
// before exact distance checks, the way PostGIS uses a GIST index.
func BBoxAround(lat, lon, radiusM float64) BBox {
	dLat := deg(radiusM / EarthRadiusM)
	cosφ := math.Cos(rad(lat))
	if cosφ < 1e-9 {
		cosφ = 1e-9
	}
	dLon := deg(radiusM / (EarthRadiusM * cosφ))
	return BBox{lat - dLat, lon - dLon, lat + dLat, lon + dLon}
}

// Contains reports whether the box contains the point.
func (b BBox) Contains(lat, lon float64) bool {
	return lat >= b.MinLat && lat <= b.MaxLat && lon >= b.MinLon && lon <= b.MaxLon
}

// Valid reports whether a coordinate pair is a plausible WGS84 position.
func Valid(lat, lon float64) bool {
	if math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) {
		return false
	}
	return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

func rad(d float64) float64 { return d * math.Pi / 180 }
func deg(r float64) float64 { return r * 180 / math.Pi }
