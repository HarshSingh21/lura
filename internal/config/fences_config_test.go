package config

import (
	"testing"
	"time"
)

// The geofence guards are the operator's to tune; cmd/lura hands each of these
// to the engine, so a value lost here is a guard silently left at its default.
func TestFenceTuningComesFromTheEnvironment(t *testing.T) {
	for _, k := range []string{"LURA_LEAVE_MARGIN_M", "LURA_COOLOFF", "LURA_FRESH_WINDOW"} {
		t.Setenv(k, "") // a developer's shell must not decide the defaults
	}
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.LeaveMarginM != 20 || c.CoolOff != 30*time.Minute || c.FreshWindow != 5*time.Minute {
		t.Errorf("defaults = margin %v, cool-off %v, fresh %v; want 20 m, 30m, 5m", c.LeaveMarginM, c.CoolOff, c.FreshWindow)
	}

	t.Setenv("LURA_LEAVE_MARGIN_M", "35.5")
	t.Setenv("LURA_COOLOFF", "90s")
	t.Setenv("LURA_FRESH_WINDOW", "2m")
	t.Setenv("LURA_ARRIVE_DEBOUNCE", "10s")
	t.Setenv("LURA_DWELL_TICK", "1s")
	c, err = Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.LeaveMarginM != 35.5 {
		t.Errorf("LeaveMarginM = %v, want 35.5", c.LeaveMarginM)
	}
	if c.CoolOff != 90*time.Second || c.FreshWindow != 2*time.Minute || c.ArriveDebounce != 10*time.Second || c.DwellTick != time.Second {
		t.Errorf("tuning = %+v", c)
	}
}
