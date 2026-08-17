// Package idgen mints the opaque identifiers Lura hands out.
//
// Prefixed, URL-safe, collision-resistant IDs (`plc_8f2K…`) make logs and
// support tickets readable, and let clients generate their own IDs for
// idempotent retries (HLD §10).
package idgen

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/base64"
	"strings"
)

var b32 = base32.NewEncoding("0123456789abcdefghjkmnpqrstvwxyz").WithPadding(base32.NoPadding)

// New returns a prefixed 16-byte random identifier, e.g. New("plc").
func New(prefix string) string {
	b := make([]byte, 10)
	must(b)
	return prefix + "_" + b32.EncodeToString(b)
}

// Token returns a 32-byte URL-safe secret, used for share links and device
// ingest credentials. 256 bits of entropy: unguessable, safe in a URL.
func Token() string {
	b := make([]byte, 32)
	must(b)
	return strings.TrimRight(base64.RawURLEncoding.EncodeToString(b), "=")
}

// ShortToken returns a shorter (120-bit) URL-safe secret for share links, which
// people paste into chat apps by hand.
func ShortToken() string {
	b := make([]byte, 15)
	must(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func must(b []byte) {
	if _, err := rand.Read(b); err != nil {
		// crypto/rand on a supported OS only fails if the kernel CSPRNG is
		// broken; continuing would mint predictable share tokens.
		panic("idgen: crypto/rand failed: " + err.Error())
	}
}
