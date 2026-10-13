package postgres_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/store/postgres"
)

// openFenceStore opens a migrated store in a schema of its own.
func openFenceStore(t *testing.T) *postgres.Store {
	t.Helper()
	dsn := os.Getenv("LURA_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set LURA_TEST_DATABASE_URL to run the PostgreSQL fence containment tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	schema := fmt.Sprintf("lura_fencecheck_%d", time.Now().UnixNano()%1e9)
	bootstrap, err := postgres.Open(ctx, dsn, nil)
	if err != nil {
		t.Fatalf("open bootstrap connection: %v", err)
	}
	postgres.EnsurePostGISInPublic(ctx, t, bootstrap)
	if _, err := bootstrap.Pool().Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		_ = bootstrap.Close()
		t.Fatalf("create schema: %v", err)
	}
	st, err := postgres.Open(ctx, withSearchPath(dsn, schema), nil)
	if err != nil {
		_ = bootstrap.Close()
		t.Fatalf("open: %v", err)
	}
	if err := st.Migrate(ctx); err != nil {
		_ = st.Close()
		_ = bootstrap.Close()
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		_ = st.Close()
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer dropCancel()
		_, _ = bootstrap.Pool().Exec(dropCtx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		_ = bootstrap.Close()
	})
	return st
}

// TestCircleContainmentIsHaversine pins the circle rule from the release spec
// (§1: "circle = haversine ≤ radius") on PostgreSQL. The engine judges the
// leave hysteresis, crossings and a reloaded dwell with domain.Place.Contains
// (haversine on the mean-radius sphere), and the memory store answers
// PlacesContaining the same way; PostGIS must agree with both, in every
// direction and at every latitude, to within centimetres of the edge.
//
// ST_DWithin on geography defaults to the WGS84 spheroid, which at 13°N puts a
// 1000 m circle's edge ~5 m further north and ~1.3 m nearer east than the
// sphere does — so a fix the engine called "4 m outside" arrived, and one
// "1 m inside" was missed.
func TestCircleContainmentIsHaversine(t *testing.T) {
	st := openFenceStore(t)
	ctx := context.Background()
	if err := st.UpsertUser(ctx, domain.User{ID: "u_fence", Email: "fence@lura.local", TZ: "UTC"}); err != nil {
		t.Fatalf("user: %v", err)
	}

	const slackM = 0.1
	n := 0
	for _, lat := range []float64{0.5, 12.93, 45, 60} {
		for _, radius := range []int{20, 1000, 5000} {
			n++
			center := domain.Point{Lat: lat, Lon: 77.62 + float64(n)}
			place, err := st.CreatePlace(ctx, domain.Place{
				ID: fmt.Sprintf("p_circle_%d", n), UserID: "u_fence", Name: "Ring", Shape: domain.ShapeCircle,
				Center: center, RadiusM: radius, Triggers: []domain.Trigger{domain.TriggerArrive},
			})
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			for bearing := 0.0; bearing < 360; bearing += 45 {
				for _, d := range []float64{float64(radius) - slackM, float64(radius) + slackM} {
					la, lo := geo.Destination(center.Lat, center.Lon, bearing, d)
					pt := domain.Point{Lat: la, Lon: lo}
					got, err := st.PlacesContaining(ctx, "u_fence", pt)
					if err != nil {
						t.Fatalf("PlacesContaining: %v", err)
					}
					inSQL := false
					for _, p := range got {
						if p.ID == place.ID {
							inSQL = true
						}
					}
					if want := place.Contains(pt); inSQL != want {
						t.Errorf("lat %v, r %d m, bearing %v, %.1f m from centre: PostgreSQL inside=%v, haversine inside=%v",
							lat, radius, bearing, d, inSQL, want)
					}
				}
			}
		}
	}
}
