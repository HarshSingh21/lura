package postgres_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/postgres"
	"github.com/HarshSingh21/locnot/internal/store/storetest"
)

// TestConformance runs the shared store suite against a real PostgreSQL+PostGIS
// database.
//
// It is skipped unless LURA_TEST_DATABASE_URL is set, so `go test ./...` stays
// green on a laptop with no database — but CI (and `make test-pg`) point it at
// the compose Postgres, which is the only way to catch a divergence between the
// SQL guards and the in-memory ones.
//
// Each subtest gets its own schema, so the suite can run in parallel and cannot
// leave rows behind for the next one.
func TestConformance(t *testing.T) {
	dsn := os.Getenv("LURA_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set LURA_TEST_DATABASE_URL to run the PostgreSQL conformance suite")
	}

	counter := 0
	storetest.Run(t, func(t *testing.T) store.Store {
		counter++
		schema := fmt.Sprintf("lura_test_%d_%d", time.Now().UnixNano()%1e9, counter)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		t.Cleanup(cancel)

		// search_path in the DSN gives each subtest an isolated namespace while
		// sharing one server; PostGIS stays in public and is still visible.
		isolated := withSearchPath(dsn, schema)

		bootstrap, err := postgres.Open(ctx, dsn, nil)
		if err != nil {
			t.Fatalf("open bootstrap connection: %v", err)
		}
		if _, err := bootstrap.Pool().Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
			_ = bootstrap.Close()
			t.Fatalf("create schema: %v", err)
		}

		st, err := postgres.Open(ctx, isolated, nil)
		if err != nil {
			_ = bootstrap.Close()
			t.Fatalf("open test connection: %v", err)
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
			if _, err := bootstrap.Pool().Exec(dropCtx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
				t.Logf("drop schema %s: %v", schema, err)
			}
			_ = bootstrap.Close()
		})
		return st
	})
}

func withSearchPath(dsn, schema string) string {
	sep := "?"
	if containsRune(dsn, '?') {
		sep = "&"
	}
	// public stays on the path so the PostGIS functions resolve.
	return dsn + sep + "search_path=" + schema + ",public"
}

func containsRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}
