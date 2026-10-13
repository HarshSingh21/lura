package seed

import (
	"testing"
	"time"
)

func TestDayStart(t *testing.T) {
	ist := time.FixedZone("IST", 330*60)
	at := func(h, m int) time.Time { return time.Date(2026, 10, 13, h, m, 0, 0, ist) }
	cases := []struct {
		name string
		now  time.Time
		want time.Time
	}{
		{"mid-afternoon: the day starts at 08:04", at(14, 0), at(8, 4)},
		{"just after 09:34: still 08:04", at(9, 35), at(8, 4)},
		{"08:12, minutes after 08:04: six hours back, so a trip exists", at(8, 12), at(2, 12)},
		{"before 08:04: six hours back", at(6, 0), at(0, 0)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := dayStart(tc.now)
			if !got.Equal(tc.want) {
				t.Fatalf("dayStart(%s) = %s, want %s", tc.now.Format("15:04"), got.Format("15:04"), tc.want.Format("15:04"))
			}
			if got.Add(firstTripDone).After(tc.now) {
				t.Fatalf("the first trip would end after now")
			}
		})
	}
}
