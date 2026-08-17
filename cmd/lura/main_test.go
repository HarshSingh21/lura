package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestWithStaticServesAppShellButNotForAssets pins the rule that a missing asset
// is a 404 rather than the app shell.
//
// This exists because of a real bug: MapLibre loads its tile-parsing worker as a
// separate ES module chunk, the bundler did not emit it, and this handler
// answered the 404 with index.html. The browser then rejected the worker for
// having a "non-JavaScript MIME type" — and the only visible symptom was a
// blank basemap, because everything drawn on top of the map still worked. A 404
// would have named the problem immediately.
func TestWithStaticServesAppShellButNotForAssets(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "index.html"), "<!doctype html><title>Lura</title>")
	write(t, filepath.Join(dir, "app.js"), "console.log('bundle')")

	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot) // marks "the API handled this"
	})
	handler := withStatic(api, dir, nil)

	cases := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"existing asset is served", "/app.js", http.StatusOK, "console.log('bundle')"},
		{"client route falls back to the shell", "/places", http.StatusOK, "<!doctype html><title>Lura</title>"},
		// /share/<token> is the *client-side* viewer route, so it gets the shell;
		// /s/<token> below is the server's JSON endpoint and goes to the API.
		{"share viewer route falls back to the shell", "/share/abc123", http.StatusOK, "<!doctype html><title>Lura</title>"},
		{"missing asset is a 404, not the shell", "/maplibre-gl-worker.mjs", http.StatusNotFound, ""},
		{"missing nested asset is a 404", "/_expo/static/js/web/missing.js", http.StatusNotFound, ""},
		{"API paths go to the API", "/api/v1/overview", http.StatusTeapot, ""},
		{"ingest goes to the API", "/pub", http.StatusTeapot, ""},
		{"share links go to the API", "/s/token123", http.StatusTeapot, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("GET %s = %d, want %d", tc.path, rec.Code, tc.wantStatus)
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Errorf("GET %s body = %q, want %q", tc.path, rec.Body.String(), tc.wantBody)
			}
		})
	}
}

// TestWithStaticFallsBackToAPIWithoutAnIndex covers a misconfigured web dir: the
// server should keep serving the API rather than 404 every page.
func TestWithStaticFallsBackToAPIWithoutAnIndex(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	handler := withStatic(api, t.TempDir(), nil) // no index.html inside

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("with no index.html, / = %d, want the API to handle it", rec.Code)
	}
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
