package seed_test

import (
	"context"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/seed"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

// The demo day is whole whatever the time the server starts: just after 08:04
// it once held one fix and no trips.
func TestSeededDayIsWholeAtAnyHour(t *testing.T) {
	ist, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Skip("no tz database")
	}
	var want int
	for i, hhmm := range [][2]int{{15, 30}, {1, 0}, {8, 5}, {8, 40}, {11, 0}, {23, 50}} {
		now := time.Date(2026, 10, 13, hhmm[0], hhmm[1], 0, 0, ist)
		res, err := seed.Run(context.Background(), memory.New(), nil, seed.Options{
			TZ: "Asia/Kolkata", WithHistory: true, Now: func() time.Time { return now },
		})
		if err != nil {
			t.Fatalf("%02d:%02d: Run: %v", hhmm[0], hhmm[1], err)
		}
		if i == 0 {
			want = res.Positions // the afternoon: the day has long been over
			if want < 50 {
				t.Fatalf("15:30: seeded %d fixes, want a day of them", want)
			}
			continue
		}
		if res.Positions != want {
			t.Errorf("%02d:%02d: seeded %d fixes, want the whole day's %d", hhmm[0], hhmm[1], res.Positions, want)
		}
	}
}
