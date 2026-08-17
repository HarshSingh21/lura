// Command lurasim is a device simulator: it drives a virtual phone along a route
// and posts OwnTracks-compatible fixes to /pub.
//
// It exists because the interesting behaviour in this system only happens when a
// device is moving. Geofence debounce, pass-by while moving, dwell timers,
// cool-off, live fan-out and the trip segmenter cannot be exercised by hand with
// curl, and waiting to walk past a real shop is a poor development loop.
//
// The default route visits the seeded places in a way that exercises each
// trigger: it parks at Home (arrive), drives past Whole Foods without stopping
// (pass-by), stops at the Office (arrive), sits at the Gym (dwell), then returns.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/HarshSingh21/locnot/internal/geo"
)

type waypoint struct {
	Name    string
	Lat     float64
	Lon     float64
	DwellS  int     // seconds to sit still here (0 = drive straight through)
	SpeedMS float64 // travel speed on the leg leading to this waypoint
}

// defaultRoute matches the seeded demo places (central Bengaluru).
var defaultRoute = []waypoint{
	{Name: "Home", Lat: 12.9611, Lon: 77.6387, DwellS: 30, SpeedMS: 8},
	{Name: "Whole Foods (pass-by)", Lat: 12.9705, Lon: 77.6350, DwellS: 0, SpeedMS: 12},
	{Name: "Office", Lat: 12.9784, Lon: 77.6408, DwellS: 90, SpeedMS: 11},
	{Name: "City Library (pass-by)", Lat: 12.9750, Lon: 77.6200, DwellS: 0, SpeedMS: 12},
	{Name: "Gym", Lat: 12.9668, Lon: 77.6290, DwellS: 120, SpeedMS: 9},
}

type payload struct {
	Type     string  `json:"_type"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	TST      int64   `json:"tst"`
	Acc      float64 `json:"acc"`
	Alt      float64 `json:"alt"`
	Cog      float64 `json:"cog"`
	Batt     float64 `json:"batt"`
	SpeedMPS float64 `json:"speedMps"`
	Seq      int64   `json:"seq"`
}

func main() {
	var (
		baseURL   = flag.String("url", envOr("LURA_URL", "http://localhost:8080"), "Lura base URL")
		token     = flag.String("token", envOr("LURA_DEVICE_TOKEN", envOr("LURA_API_TOKEN", "lura-dev-token")), "device ingest token, or the API token with -device")
		device    = flag.String("device", envOr("LURA_SIM_DEVICE", "dev_phone"), "device id (required when using the API token)")
		interval  = flag.Duration("interval", 2*time.Second, "wall-clock time between fixes")
		timeScale = flag.Float64("scale", 10, "simulated seconds per real second (10 = 10x faster than life)")
		loops     = flag.Int("loops", 0, "number of route loops (0 = forever)")
		routeArg  = flag.String("route", "", `custom route as "lat,lon[,dwellSeconds];…"`)
		jitterM   = flag.Float64("jitter", 6, "GPS jitter in metres")
		quiet     = flag.Bool("quiet", false, "only log errors")
	)
	flag.Parse()

	route := defaultRoute
	if *routeArg != "" {
		parsed, err := parseRoute(*routeArg)
		if err != nil {
			log.Fatalf("lurasim: %v", err)
		}
		route = parsed
	}
	if len(route) < 2 {
		log.Fatal("lurasim: need at least two waypoints")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sim := &simulator{
		baseURL:  strings.TrimRight(*baseURL, "/"),
		token:    *token,
		device:   *device,
		client:   &http.Client{Timeout: 10 * time.Second},
		jitterM:  *jitterM,
		quiet:    *quiet,
		battery:  92,
		scale:    *timeScale,
		interval: *interval,
	}

	fmt.Printf("lurasim → %s (device %s), %d waypoints, %.0fx time, fix every %s\n",
		sim.baseURL, sim.device, len(route), sim.scale, sim.interval)

	if err := sim.run(ctx, route, *loops); err != nil {
		log.Fatalf("lurasim: %v", err)
	}
	fmt.Println("lurasim: done")
}

type simulator struct {
	baseURL  string
	token    string
	device   string
	client   *http.Client
	jitterM  float64
	quiet    bool
	battery  float64
	scale    float64
	interval time.Duration

	seq  int64
	sent int
	fail int
}

func (s *simulator) run(ctx context.Context, route []waypoint, loops int) error {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	// simStep is how much simulated time each fix advances. Decoupling simulated
	// from real time is what lets a 45-second arrive debounce and a 45-minute dwell
	// both be observable in a short session.
	simStep := s.interval.Seconds() * s.scale

	for loop := 0; loops == 0 || loop < loops; loop++ {
		for i := 1; i <= len(route); i++ {
			from := route[i-1]
			to := route[i%len(route)] // last leg closes the loop

			distM := geo.DistanceM(from.Lat, from.Lon, to.Lat, to.Lon)
			bearing := geo.BearingDeg(from.Lat, from.Lon, to.Lat, to.Lon)
			speed := to.SpeedMS
			if speed <= 0 {
				speed = 10
			}
			steps := int(math.Ceil(distM / (speed * simStep)))
			if steps < 1 {
				steps = 1
			}

			if !s.quiet {
				fmt.Printf("  leg %s → %s: %.0f m at %.0f m/s (%d fixes)\n",
					from.Name, to.Name, distM, speed, steps)
			}

			for step := 1; step <= steps; step++ {
				frac := float64(step) / float64(steps)
				lat, lon := geo.Destination(from.Lat, from.Lon, bearing, distM*frac)
				// Ease speed in and out so the profile looks like real driving; the
				// fly-by filter reacts to exactly this shape.
				v := speed * math.Max(0.35, math.Sin(frac*math.Pi))
				if err := s.post(ctx, lat, lon, v, bearing); err != nil {
					return err
				}
				if err := wait(ctx, ticker); err != nil {
					return err
				}
			}

			// Sit still at the waypoint. Zero speed plus staying inside the fence is
			// what confirms an arrival and what arms a dwell timer.
			if to.DwellS > 0 {
				dwellFixes := int(math.Ceil(float64(to.DwellS) / simStep))
				if dwellFixes < 1 {
					dwellFixes = 1
				}
				if !s.quiet {
					fmt.Printf("  parked at %s for %ds simulated (%d fixes)\n", to.Name, to.DwellS, dwellFixes)
				}
				for k := 0; k < dwellFixes; k++ {
					if err := s.post(ctx, to.Lat, to.Lon, 0, bearing); err != nil {
						return err
					}
					if err := wait(ctx, ticker); err != nil {
						return err
					}
				}
			}
		}
		if !s.quiet {
			fmt.Printf("  loop %d complete: %d fixes sent, %d failed\n", loop+1, s.sent, s.fail)
		}
	}
	return nil
}

func wait(ctx context.Context, t *time.Ticker) error {
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return nil // a Ctrl-C is a clean stop, not an error
	}
}

// post sends one fix. Failures are logged and counted but do not stop the run: a
// simulator that dies because the server restarted is annoying.
func (s *simulator) post(ctx context.Context, lat, lon, speed, heading float64) error {
	if ctx.Err() != nil {
		return nil
	}

	jLat, jLon := jitter(lat, lon, s.jitterM)
	s.seq++
	if s.battery > 20 {
		s.battery -= 0.02
	}

	body, err := json.Marshal(payload{
		Type:     "location",
		Lat:      jLat,
		Lon:      jLon,
		TST:      time.Now().Unix(),
		Acc:      3 + s.jitterM/2,
		Alt:      920,
		Cog:      heading,
		Batt:     math.Round(s.battery),
		SpeedMPS: speed,
		Seq:      s.seq,
	})
	if err != nil {
		return err
	}

	url := s.baseURL + "/pub"
	if s.device != "" {
		url += "?device=" + s.device
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("User-Agent", "lurasim/1.0")

	resp, err := s.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		s.fail++
		log.Printf("post failed: %v", err)
		return nil
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		s.fail++
		log.Printf("post rejected: %s: %s", resp.Status, strings.TrimSpace(string(snippet)))
		// A 401 will not fix itself; stop rather than spam.
		if resp.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("unauthorized: check -token / -device")
		}
		return nil
	}

	s.sent++
	if !s.quiet && s.sent%10 == 0 {
		fmt.Printf("    %d fixes sent (last %.5f,%.5f @ %.1f m/s)\n", s.sent, jLat, jLon, speed)
	}
	return nil
}

// jitter offsets a point by up to metres in a deterministic-ish direction, so the
// stream looks like a real GPS rather than a perfect line — which matters because
// the trip segmenter and the arrive debounce both have to tolerate it.
func jitter(lat, lon, metres float64) (float64, float64) {
	if metres <= 0 {
		return lat, lon
	}
	// Derived from the clock rather than math/rand: no seeding, no dependency, and
	// repeated runs still look different.
	t := float64(time.Now().UnixNano()%1_000_000) / 1_000_000
	bearing := t * 360
	return geo.Destination(lat, lon, bearing, metres*t)
}

func parseRoute(spec string) ([]waypoint, error) {
	var out []waypoint
	for i, part := range strings.Split(spec, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		fields := strings.Split(part, ",")
		if len(fields) < 2 {
			return nil, fmt.Errorf("waypoint %d: want lat,lon[,dwellSeconds]", i+1)
		}
		lat, err := strconv.ParseFloat(strings.TrimSpace(fields[0]), 64)
		if err != nil {
			return nil, fmt.Errorf("waypoint %d latitude: %w", i+1, err)
		}
		lon, err := strconv.ParseFloat(strings.TrimSpace(fields[1]), 64)
		if err != nil {
			return nil, fmt.Errorf("waypoint %d longitude: %w", i+1, err)
		}
		if !geo.Valid(lat, lon) {
			return nil, fmt.Errorf("waypoint %d: lat/lon out of range", i+1)
		}
		wp := waypoint{Name: fmt.Sprintf("wp%d", i+1), Lat: lat, Lon: lon, SpeedMS: 11}
		if len(fields) > 2 {
			d, err := strconv.Atoi(strings.TrimSpace(fields[2]))
			if err != nil {
				return nil, fmt.Errorf("waypoint %d dwell: %w", i+1, err)
			}
			wp.DwellS = d
		}
		out = append(out, wp)
	}
	return out, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
