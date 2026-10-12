package config

import "testing"

// Share links are built from PublicBaseURL. Left unset, it must follow the
// port the server listens on: a Lura on :8097 that hands out
// http://localhost:8080/s/… links hands out links to somebody else's server.
func TestPublicBaseURLFollowsListenPort(t *testing.T) {
	cases := map[string]string{
		":8097":        "http://localhost:8097",
		"0.0.0.0:9000": "http://localhost:9000",
		"[::]:8443":    "http://localhost:8443",
		"localhost":    "http://localhost:8080",
		":http":        "http://localhost:8080",
		"127.0.0.1:":   "http://localhost:8080",
	}
	for addr, want := range cases {
		if got := localBaseURL(addr); got != want {
			t.Errorf("localBaseURL(%q) = %q, want %q", addr, got, want)
		}
	}

	t.Setenv("LURA_HTTP_ADDR", ":8097")
	t.Setenv("LURA_PUBLIC_BASE_URL", "")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.PublicBaseURL != "http://localhost:8097" {
		t.Errorf("PublicBaseURL = %q with LURA_HTTP_ADDR=:8097", c.PublicBaseURL)
	}

	t.Setenv("LURA_PUBLIC_BASE_URL", "https://lura.example.com/")
	c, err = Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.PublicBaseURL != "https://lura.example.com" {
		t.Errorf("an explicit LURA_PUBLIC_BASE_URL was not kept: %q", c.PublicBaseURL)
	}
}
