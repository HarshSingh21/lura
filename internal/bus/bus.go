// Package bus is Lura's message bus abstraction, shaped deliberately like NATS.
//
// HLD §4 splits the bus in two, and that split is the whole point of this
// package existing in Phase 1:
//
//   - Core (Publish/Subscribe): at-most-once, fire-and-forget, used for the live
//     position fan-out. Dropping a fix is harmless because a fresher one arrives
//     seconds later, so a slow subscriber is dropped rather than allowed to
//     block the publisher.
//   - Durable (PublishDurable/SubscribePartitioned): at-least-once, ordered per
//     partition key, used for the position writer, the geofence engine and the
//     notification worker. Partitioning by device_id is what removes the
//     multi-worker geofence race described in HLD §5.4 — and keeping that
//     contract here in Phase 1 means the Phase 2 swap to a JetStream
//     partitioned consumer is a driver change, not a redesign.
//
// Subject syntax matches NATS: dot-separated tokens, `*` matching exactly one
// token, `>` matching one or more trailing tokens.
package bus

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/HarshSingh21/locnot/internal/metrics"
)

// ErrClosed is returned by publishes after Close.
var ErrClosed = errors.New("bus: closed")

// Msg is one published message.
type Msg struct {
	Subject string
	Data    []byte
}

// Handler consumes a message. Core handlers must not block for long; durable
// handlers may, and applying backpressure is the correct behaviour there.
type Handler func(Msg)

// Subscription is a live subscription. Unsubscribe is idempotent.
type Subscription interface {
	Unsubscribe()
	Subject() string
}

// Bus is the contract the rest of Lura codes against.
type Bus interface {
	// Publish sends on the core (at-most-once) path.
	Publish(subject string, data []byte) error
	// PublishDurable sends on the durable (at-least-once) path.
	PublishDurable(subject string, data []byte) error
	// Subscribe registers a core subscriber. Slow subscribers lose messages.
	Subscribe(subject string, h Handler) (Subscription, error)
	// SubscribePartitioned registers a durable subscriber processed by
	// `partitions` workers, where all messages with the same key go to the same
	// worker in publish order.
	SubscribePartitioned(subject string, partitions int, key func(Msg) string, h Handler) (Subscription, error)
	Close() error
}

// ---------------------------------------------------------------- subjects

// Subject builders. Centralised so a subject rename is a compile error rather
// than a silently dead subscription.
func PosSubject(userID, deviceID string) string { return "pos." + userID + "." + deviceID }
func PosUserWildcard(userID string) string      { return "pos." + userID + ".*" }
func PosAll() string                            { return "pos.>" }
func GeoSubject(userID string) string           { return "geo." + userID }
func GeoAll() string                            { return "geo.*" }
func ACLSubject(viewerID string) string         { return "acl." + viewerID }
func NotifySubject(userID string) string        { return "notify." + userID }
func NotifyAll() string                         { return "notify.*" }

// Match reports whether a concrete subject matches a (possibly wildcarded)
// pattern, using NATS semantics.
func Match(pattern, subject string) bool {
	if pattern == subject {
		return true
	}
	pt := strings.Split(pattern, ".")
	st := strings.Split(subject, ".")
	for i, p := range pt {
		if p == ">" {
			return i < len(st) // `>` must match at least one token
		}
		if i >= len(st) {
			return false
		}
		if p != "*" && p != st[i] {
			return false
		}
	}
	return len(pt) == len(st)
}

// ---------------------------------------------------------------- in-process

// InProcess is the Phase 1 bus: goroutines and channels inside the monolith.
type InProcess struct {
	log *slog.Logger

	mu     sync.RWMutex
	closed bool
	core   []*coreSub
	dur    []*durSub

	// coreBuffer bounds each core subscriber's queue. Live fan-out only needs
	// the newest fix, so a full queue drops rather than blocks.
	coreBuffer int
	// durBuffer bounds each durable partition's queue. Full means the publisher
	// waits: losing a fix here would lose a reminder or a history row.
	durBuffer int
}

// Option configures an InProcess bus.
type Option func(*InProcess)

// WithBuffers overrides the core and durable queue depths.
func WithBuffers(core, durable int) Option {
	return func(b *InProcess) {
		if core > 0 {
			b.coreBuffer = core
		}
		if durable > 0 {
			b.durBuffer = durable
		}
	}
}

// NewInProcess returns a running in-process bus.
func NewInProcess(log *slog.Logger, opts ...Option) *InProcess {
	if log == nil {
		log = slog.Default()
	}
	b := &InProcess{log: log, coreBuffer: 256, durBuffer: 8192}
	for _, o := range opts {
		o(b)
	}
	return b
}

type coreSub struct {
	bus     *InProcess
	subject string
	ch      chan Msg
	done    chan struct{}
	once    sync.Once
	dropped atomic.Int64
}

func (s *coreSub) Subject() string { return s.subject }

func (s *coreSub) Unsubscribe() {
	s.once.Do(func() {
		s.bus.removeCore(s)
		close(s.done)
	})
}

type durSub struct {
	bus       *InProcess
	subject   string
	partition []chan Msg
	key       func(Msg) string
	done      chan struct{}
	wg        sync.WaitGroup
	once      sync.Once
}

func (s *durSub) Subject() string { return s.subject }

func (s *durSub) Unsubscribe() {
	s.once.Do(func() {
		s.bus.removeDur(s)
		close(s.done)
		s.wg.Wait()
	})
}

// Publish implements the core path.
func (b *InProcess) Publish(subject string, data []byte) error {
	b.mu.RLock()
	if b.closed {
		b.mu.RUnlock()
		return ErrClosed
	}
	subs := make([]*coreSub, 0, len(b.core))
	for _, s := range b.core {
		if Match(s.subject, subject) {
			subs = append(subs, s)
		}
	}
	b.mu.RUnlock()

	metrics.BusPublished.Inc()
	msg := Msg{Subject: subject, Data: data}
	for _, s := range subs {
		select {
		case s.ch <- msg:
			metrics.BusDelivered.Inc()
		default:
			// At-most-once by design: a subscriber that cannot keep up with the
			// live path loses the fix rather than stalling ingest.
			s.dropped.Add(1)
			metrics.BusDropped.Inc()
		}
	}
	return nil
}

// PublishDurable implements the at-least-once path. It blocks when a partition
// queue is full, pushing backpressure to the caller instead of dropping work.
func (b *InProcess) PublishDurable(subject string, data []byte) error {
	b.mu.RLock()
	if b.closed {
		b.mu.RUnlock()
		return ErrClosed
	}
	subs := make([]*durSub, 0, len(b.dur))
	for _, s := range b.dur {
		if Match(s.subject, subject) {
			subs = append(subs, s)
		}
	}
	b.mu.RUnlock()

	metrics.BusPublished.Inc()
	msg := Msg{Subject: subject, Data: data}
	for _, s := range subs {
		idx := 0
		if n := len(s.partition); n > 1 {
			idx = int(hash(s.key(msg)) % uint32(n))
		}
		select {
		case s.partition[idx] <- msg:
			metrics.BusDelivered.Inc()
			metrics.BusQueueDepth.Add(1)
		case <-s.done:
			// subscription went away mid-publish; nothing to deliver to
		}
	}
	return nil
}

// PublishJSON marshals v and publishes it on the core path.
func PublishJSON(b Bus, subject string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("bus: marshal %s: %w", subject, err)
	}
	return b.Publish(subject, data)
}

// PublishDurableJSON marshals v and publishes it on the durable path.
func PublishDurableJSON(b Bus, subject string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("bus: marshal %s: %w", subject, err)
	}
	return b.PublishDurable(subject, data)
}

// Subscribe registers a core subscriber served by one goroutine, so a handler
// sees messages in publish order.
func (b *InProcess) Subscribe(subject string, h Handler) (Subscription, error) {
	if subject == "" || h == nil {
		return nil, errors.New("bus: subject and handler required")
	}
	s := &coreSub{bus: b, subject: subject, ch: make(chan Msg, b.coreBuffer), done: make(chan struct{})}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, ErrClosed
	}
	b.core = append(b.core, s)
	b.mu.Unlock()

	go func() {
		for {
			select {
			case msg := <-s.ch:
				b.safely(subject, h, msg)
			case <-s.done:
				return
			}
		}
	}()
	return s, nil
}

// SubscribePartitioned registers a durable subscriber. Messages sharing a
// partition key are handled by the same goroutine in order — the in-process
// equivalent of a JetStream consumer partitioned by device_id (HLD §5.4).
func (b *InProcess) SubscribePartitioned(subject string, partitions int, key func(Msg) string, h Handler) (Subscription, error) {
	if subject == "" || h == nil {
		return nil, errors.New("bus: subject and handler required")
	}
	if partitions < 1 {
		partitions = 1
	}
	if key == nil {
		key = func(Msg) string { return "" }
	}
	s := &durSub{bus: b, subject: subject, key: key, done: make(chan struct{})}
	for i := 0; i < partitions; i++ {
		s.partition = append(s.partition, make(chan Msg, b.durBuffer))
	}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, ErrClosed
	}
	b.dur = append(b.dur, s)
	b.mu.Unlock()

	for i := 0; i < partitions; i++ {
		s.wg.Add(1)
		ch := s.partition[i]
		go func() {
			defer s.wg.Done()
			for {
				select {
				case msg := <-ch:
					metrics.BusQueueDepth.Add(-1)
					b.safely(subject, h, msg)
				case <-s.done:
					// Drain what is already queued so an orderly shutdown does
					// not lose accepted work.
					for {
						select {
						case msg := <-ch:
							metrics.BusQueueDepth.Add(-1)
							b.safely(subject, h, msg)
						default:
							return
						}
					}
				}
			}
		}()
	}
	return s, nil
}

// safely runs a handler and turns a panic into a log line: one malformed
// message must not take the monolith down.
func (b *InProcess) safely(subject string, h Handler, msg Msg) {
	defer func() {
		if r := recover(); r != nil {
			b.log.Error("bus handler panicked", "subject", subject, "panic", r)
		}
	}()
	h(msg)
}

// Close stops every subscriber.
func (b *InProcess) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	core, dur := b.core, b.dur
	b.core, b.dur = nil, nil
	b.mu.Unlock()

	for _, s := range core {
		s.Unsubscribe()
	}
	for _, s := range dur {
		s.Unsubscribe()
	}
	return nil
}

// DroppedFor reports how many messages a core subscription dropped. Exposed for
// tests and for the /healthz payload.
func DroppedFor(s Subscription) int64 {
	if cs, ok := s.(*coreSub); ok {
		return cs.dropped.Load()
	}
	return 0
}

func (b *InProcess) removeCore(target *coreSub) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, s := range b.core {
		if s == target {
			b.core = append(b.core[:i], b.core[i+1:]...)
			return
		}
	}
}

func (b *InProcess) removeDur(target *durSub) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, s := range b.dur {
		if s == target {
			b.dur = append(b.dur[:i], b.dur[i+1:]...)
			return
		}
	}
}

func hash(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return h.Sum32()
}

// DeviceKey extracts the device token from a pos.<user>.<device> subject, for
// use as a partition key.
func DeviceKey(m Msg) string {
	parts := strings.Split(m.Subject, ".")
	if len(parts) >= 3 {
		return parts[2]
	}
	return m.Subject
}

// UserKey extracts the user token from a <kind>.<user>[.…] subject.
func UserKey(m Msg) string {
	parts := strings.Split(m.Subject, ".")
	if len(parts) >= 2 {
		return parts[1]
	}
	return m.Subject
}

var _ Bus = (*InProcess)(nil)
