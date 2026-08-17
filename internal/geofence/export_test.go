package geofence

import "context"

// RunDueDwellsForTest fires matured dwell timers once, synchronously.
//
// In production this runs on a ticker; tests need it deterministic, so the hook
// lives in a _test.go file — it exists only when the tests are built, and never
// widens the package's real API.
func (e *Engine) RunDueDwellsForTest(ctx context.Context) { e.runDwellDue(ctx) }
