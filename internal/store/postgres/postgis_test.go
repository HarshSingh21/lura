package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// EnsurePostGISInPublic makes sure the PostGIS extension lives in the public
// schema before a test migrates its own schema.
//
// Left to 0001_init.sql on a fresh database, CREATE EXTENSION would install
// PostGIS into the first test schema on the search_path, and dropping that
// schema at cleanup would take the extension away from every other test
// running at the same time ("type geography does not exist"). Several test
// binaries may race to create it, so a failed CREATE is followed by a re-check.
func EnsurePostGISInPublic(ctx context.Context, t testing.TB, s *Store) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var where string
		err := s.pool.QueryRow(ctx, `SELECT n.nspname FROM pg_extension e
			JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'postgis'`).Scan(&where)
		switch {
		case err == nil && where == "public":
			return
		case err == nil:
			t.Fatalf("postgis is installed in schema %q, not public; tests need it in public", where)
		case !errors.Is(err, pgx.ErrNoRows):
			t.Fatalf("look up postgis: %v", err)
		}
		if _, cerr := s.pool.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public"); cerr == nil {
			continue
		} else if time.Now().After(deadline) {
			t.Fatalf("create postgis in public: %v", cerr)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
