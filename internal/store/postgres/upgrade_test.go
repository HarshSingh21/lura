package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store"
)

// TestUpgradeFromConnections builds a database exactly as the previous release
// left it (0001 + 0002), writes rows the way that release's SQL did — with none
// of the columns 0003 adds — and then runs the current migrations over it.
//
// Every pre-release row must read back as a plain circle with empty peer lists:
// [] on the wire, never null, because the client iterates them unguarded.
func TestUpgradeFromConnections(t *testing.T) {
	dsn := os.Getenv("LURA_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set LURA_TEST_DATABASE_URL to run the PostgreSQL upgrade-path test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	st := isolatedStore(t, ctx, dsn)
	if err := st.migrateThrough(ctx, "0002_connections.sql"); err != nil {
		t.Fatalf("migrate through 0002: %v", err)
	}

	// The previous release's rows, in its own column lists.
	for _, q := range []string{
		`INSERT INTO users (id, email, display_name) VALUES ('u1','u1@lura.local','One'), ('u2','u2@lura.local','Two')`,
		`INSERT INTO devices (id, user_id, name, token) VALUES ('d1','u1','Phone','tok-old')`,
		`INSERT INTO places (id, user_id, name, tags, center, radius_m, triggers, dwell_mins)
		 VALUES ('p_home','u1','Home','{home}', ST_SetSRID(ST_MakePoint(77.6387,12.9611),4326)::geography, 120, '{arrive,leave}', 0),
		        ('p_shop','u1','Shop','{}',     ST_SetSRID(ST_MakePoint(77.6400,12.9700),4326)::geography,  60, '{passby}', 0)`,
		`INSERT INTO notes (id, user_id, body, place_id, trigger, tags)
		 VALUES ('n1','u1','Water the plants','p_home','arrive','{}'),
		        ('n2','u1','Unbound',NULL,'arrive','{x}')`,
		`INSERT INTO connections (id, user_id, peer_id, peer_name, peer_email, status, sharing)
		 VALUES ('c1','u1','u2','Two','u2@lura.local','accepted',true),
		        ('c2','u2','u1','One','u1@lura.local','accepted',true)`,
	} {
		if _, err := st.pool.Exec(ctx, q); err != nil {
			t.Fatalf("seed pre-release rows: %v\n%s", err, q)
		}
	}

	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate to current: %v", err)
	}

	places, err := st.ListPlaces(ctx, "u1")
	if err != nil {
		t.Fatalf("ListPlaces after upgrade: %v", err)
	}
	if len(places) != 2 {
		t.Fatalf("got %d places after upgrade, want 2", len(places))
	}
	for _, p := range places {
		if p.Shape != domain.ShapeCircle {
			t.Errorf("%s: shape = %q, want circle", p.ID, p.Shape)
		}
		raw, _ := json.Marshal(p)
		for _, want := range []string{`"polygon":[]`, `"watchUserIds":[]`, `"shape":"circle"`} {
			if !strings.Contains(string(raw), want) {
				t.Errorf("%s JSON lacks %s: %s", p.ID, want, raw)
			}
		}
	}

	// Old circles still answer containment after the predicate changed shape.
	inside, err := st.PlacesContaining(ctx, "u1", domain.Point{Lat: 12.9611, Lon: 77.6387})
	if err != nil {
		t.Fatalf("PlacesContaining after upgrade: %v", err)
	}
	if len(inside) != 1 || inside[0].ID != "p_home" {
		t.Errorf("containing after upgrade = %v, want [p_home]", inside)
	}

	notes, err := st.ListNotes(ctx, "u1", store.NoteFilter{})
	if err != nil {
		t.Fatalf("ListNotes after upgrade: %v", err)
	}
	if len(notes) != 2 {
		t.Fatalf("got %d notes after upgrade, want 2", len(notes))
	}
	for _, n := range notes {
		if n.WatchUserID != "" {
			t.Errorf("%s: watchUserId = %q, want empty", n.ID, n.WatchUserID)
		}
		raw, _ := json.Marshal(n)
		if !strings.Contains(string(raw), `"notifyUserIds":[]`) || !strings.Contains(string(raw), `"watchUserId":""`) {
			t.Errorf("%s JSON has null/missing peer fields: %s", n.ID, raw)
		}
	}

	// A pre-release circle can become a polygon and watch someone.
	home := places[0]
	home.Shape = domain.ShapePolygon
	home.Polygon = []domain.Point{{Lat: 12.961, Lon: 77.638}, {Lat: 12.961, Lon: 77.639}, {Lat: 12.962, Lon: 77.639}}
	home.WatchUserIDs = []string{"u2"}
	if _, err := st.UpdatePlace(ctx, home); err != nil {
		t.Fatalf("reshape upgraded place: %v", err)
	}

	conns, err := st.ListConnections(ctx, "u1")
	if err != nil || len(conns) != 1 || !conns[0].Live() {
		t.Errorf("connections after upgrade = %v, %v; want one live", conns, err)
	}
	if _, err := st.DeviceByToken(ctx, "tok-old"); err != nil {
		t.Errorf("device token after upgrade: %v", err)
	}
}

// isolatedStore opens a store confined to a fresh schema that is dropped when
// the test ends.
func isolatedStore(t *testing.T, ctx context.Context, dsn string) *Store {
	t.Helper()
	schema := fmt.Sprintf("lura_upgrade_%d", time.Now().UnixNano()%1e9)
	boot, err := Open(ctx, dsn, nil)
	if err != nil {
		t.Fatalf("open bootstrap: %v", err)
	}
	if _, err := boot.pool.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		_ = boot.Close()
		t.Fatalf("create schema: %v", err)
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	st, err := Open(ctx, dsn+sep+"search_path="+schema+",public", nil)
	if err != nil {
		_ = boot.Close()
		t.Fatalf("open isolated: %v", err)
	}
	t.Cleanup(func() {
		_ = st.Close()
		c, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := boot.pool.Exec(c, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
			t.Logf("drop schema %s: %v", schema, err)
		}
		_ = boot.Close()
	})
	return st
}
