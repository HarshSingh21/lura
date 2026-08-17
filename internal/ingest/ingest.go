// Package ingest is the write path for location fixes.
//
// HLD §5.2 and §9 pin the contract: validate, rate-limit, stamp a
// high-resolution server-receive timestamp, publish, ack. Nothing slow happens
// inline — persistence, geofence evaluation and fan-out all hang off the bus —
// which is what keeps the p99 ack under the 50 ms NFR.
//
// The idempotency key is (device_id, recv_ts µs) plus an optional client
// sequence number, deliberately *not* OwnTracks' `tst`: that field has
// one-second resolution and collides for two genuine fixes in the same second
// (HLD §5.2, "Idempotency (fixed)").
package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/metrics"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/ratelimit"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// ErrRateLimited is returned when a device exceeds its fix budget.
var ErrRateLimited = errors.New("rate limited")

// Payload is an OwnTracks `_type:location` message, extended with two optional
// Lura fields.
//
// OwnTracks compatibility matters because it means any existing OwnTracks
// installation can point at Lura without new client software (HLD §2.1).
type Payload struct {
	Type string `json:"_type"`

	Lat  float64  `json:"lat"`
	Lon  float64  `json:"lon"`
	TST  int64    `json:"tst"`  // device clock, epoch seconds
	Acc  *float64 `json:"acc"`  // accuracy, metres
	Vel  *float64 `json:"vel"`  // velocity, km/h (OwnTracks unit)
	Alt  *float64 `json:"alt"`  // altitude, metres
	Cog  *float64 `json:"cog"`  // course over ground, degrees
	Batt *float64 `json:"batt"` // battery percentage
	TID  string   `json:"tid"`  // tracker id
	Conn string   `json:"conn"` // w=wifi, m=mobile, o=offline

	// Lura extensions, both optional:
	SpeedMPS *float64 `json:"speedMps"` // exact m/s, avoids the km/h round-trip
	Seq      int64    `json:"seq"`      // client sequence number for dedupe
}

// Validate rejects payloads that cannot be a location fix. Being strict here is
// cheap; being lax means garbage in the history and phantom geofence events.
func (p Payload) Validate() error {
	if p.Type != "" && p.Type != "location" {
		return fmt.Errorf("unsupported _type %q: %w", p.Type, domain.ErrInvalid)
	}
	if !geo.Valid(p.Lat, p.Lon) {
		return fmt.Errorf("lat/lon out of range: %w", domain.ErrInvalid)
	}
	if p.Lat == 0 && p.Lon == 0 {
		// Null Island: almost always an uninitialised GPS reading, never a real
		// user. Dropping it keeps the history and the map honest.
		return fmt.Errorf("null coordinates: %w", domain.ErrInvalid)
	}
	if p.Acc != nil && (*p.Acc < 0 || *p.Acc > 100_000) {
		return fmt.Errorf("implausible accuracy %.1f: %w", *p.Acc, domain.ErrInvalid)
	}
	if p.Batt != nil && (*p.Batt < 0 || *p.Batt > 100) {
		return fmt.Errorf("battery out of range: %w", domain.ErrInvalid)
	}
	return nil
}

// Service accepts fixes and publishes them.
type Service struct {
	bus     bus.Bus
	log     *slog.Logger
	limiter *ratelimit.Limiter
	now     func() time.Time
}

// New returns an ingest service.
func New(b bus.Bus, log *slog.Logger, ratePerMin, burst int) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		bus:     b,
		log:     log,
		limiter: ratelimit.New(ratePerMin, burst),
		now:     time.Now,
	}
}

// WithClock overrides the clock (tests).
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

// Accept validates and publishes one fix for an authenticated device. It returns
// the stored position so the caller can echo it back.
//
// Publish order is deliberate: durable first, then live. If the process dies
// between the two, we lose a live frame (the next fix repaints the map in
// seconds) rather than a durable record (which would lose a reminder or a
// history row).
func (s *Service) Accept(ctx context.Context, dev domain.Device, p Payload) (domain.Position, error) {
	start := s.now()
	ctx, span := obs.Start(ctx, "ingest.accept", trace.WithAttributes(
		attribute.String("lura.device_id", dev.ID),
		attribute.String("lura.user_id", dev.UserID),
	))
	defer span.End()

	if err := p.Validate(); err != nil {
		metrics.IngestRejected.Inc(metrics.AttrOutcome.String("invalid"))
		span.SetStatus(codes.Error, "invalid payload")
		return domain.Position{}, err
	}

	if !s.limiter.Allow(dev.ID) {
		metrics.IngestRejected.Inc(metrics.AttrOutcome.String("rate_limited"))
		span.SetStatus(codes.Error, "rate limited")
		return domain.Position{}, fmt.Errorf("device %s: %w", dev.ID, ErrRateLimited)
	}

	pos := s.toPosition(dev, p, start)

	// Durable path: the position writer and the geofence engine consume this,
	// partitioned by device so one device's fixes stay ordered (HLD §5.4).
	if err := bus.PublishDurableJSON(s.bus, bus.PosSubject(dev.UserID, dev.ID), pos); err != nil {
		metrics.IngestRejected.Inc(metrics.AttrOutcome.String("bus"))
		span.SetStatus(codes.Error, "durable publish failed")
		return domain.Position{}, fmt.Errorf("ingest: durable publish: %w", err)
	}

	// Live path: at-most-once fan-out to whichever Gateway subscribers exist.
	if err := bus.PublishJSON(s.bus, bus.PosSubject(dev.UserID, dev.ID), pos); err != nil {
		// Not fatal: history and reminders are already guaranteed by the durable
		// publish above, and the next fix will repaint the live map.
		s.log.WarnContext(ctx, "ingest: live publish failed", "device", dev.ID, "error", err)
	}

	metrics.IngestAccepted.Inc()
	metrics.IngestAckSeconds.ObserveSince(start)
	span.SetAttributes(attribute.Float64("lura.speed_mps", pos.SpeedMPS))
	return pos, nil
}

// RetryAfter reports how long a rate-limited device should wait.
func (s *Service) RetryAfter(deviceID string) time.Duration { return s.limiter.Retry(deviceID) }

func (s *Service) toPosition(dev domain.Device, p Payload, recv time.Time) domain.Position {
	pos := domain.Position{
		DeviceID: dev.ID,
		UserID:   dev.UserID,
		RecvTS:   recv.UTC(),
		Point:    domain.Point{Lat: p.Lat, Lon: p.Lon},
		Seq:      p.Seq,
	}

	// Device clock is data, not truth: a phone with a wrong clock must not be
	// able to reorder history or defeat the freshness gate.
	if p.TST > 0 {
		pos.DeviceTS = time.Unix(p.TST, 0).UTC()
	} else {
		pos.DeviceTS = pos.RecvTS
	}

	switch {
	case p.SpeedMPS != nil:
		pos.SpeedMPS = *p.SpeedMPS
	case p.Vel != nil:
		pos.SpeedMPS = *p.Vel * 1000 / 3600 // OwnTracks reports km/h
	}
	if pos.SpeedMPS < 0 {
		pos.SpeedMPS = 0
	}
	if p.Acc != nil {
		pos.AccuracyM = *p.Acc
	}
	if p.Alt != nil {
		pos.AltitudeM = *p.Alt
	}
	if p.Cog != nil {
		pos.HeadingD = *p.Cog
	}
	if p.Batt != nil {
		pos.Battery = int(*p.Batt)
	}
	return pos
}
