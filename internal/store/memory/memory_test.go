package memory_test

import (
	"testing"

	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
	"github.com/HarshSingh21/locnot/internal/store/storetest"
)

// TestConformance runs the shared store suite against the in-memory store. The
// same suite runs against PostgreSQL in ../postgres, which is what keeps the two
// implementations honest about the guards they both have to enforce.
func TestConformance(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store {
		st := memory.New()
		t.Cleanup(func() { _ = st.Close() })
		return st
	})
}
