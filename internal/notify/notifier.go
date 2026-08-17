// Package notify turns geofence events into reminders and delivers them.
//
// HLD §5.6: resolve the notes a geo event matches, respect quiet hours, then fan
// out to the user's channels through a pluggable notifier interface with retry
// and failover. Phase 1 ships ntfy plus two channels that need no third party
// (in-app over the WebSocket, and the log), and the interface is the seam where
// UnifiedPush / WebPush / FCM / APNs land in Phase 2.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
)

// Message is a rendered reminder, independent of any channel's wire format.
type Message struct {
	UserID    string          `json:"userId"`
	Title     string          `json:"title"`
	Body      string          `json:"body"`
	Trigger   domain.Trigger  `json:"trigger"`
	PlaceID   string          `json:"placeId"`
	PlaceName string          `json:"placeName"`
	DeviceID  string          `json:"deviceId"`
	NoteIDs   []string        `json:"noteIds"`
	Tags      []string        `json:"tags"`
	Priority  int             `json:"priority"` // 1 low … 5 urgent
	ClickURL  string          `json:"clickUrl,omitempty"`
	TS        time.Time       `json:"ts"`
	Event     domain.GeoEvent `json:"event"`
}

// Notifier delivers a Message over one channel.
//
// Egress reports whether the channel leaves the operator's infrastructure. The
// airgap switch (HLD §11) refuses to use any notifier whose Egress is true, so a
// new channel cannot accidentally break the privacy invariant — it has to
// declare itself.
type Notifier interface {
	Type() string
	Egress() bool
	Send(ctx context.Context, m Message) error
}

// ---------------------------------------------------------------- ntfy

// Ntfy delivers over an ntfy server (Apache-2.0 / GPL, self-hostable — the
// Phase 1 push channel from HLD §16).
type Ntfy struct {
	BaseURL string
	Topic   string
	Token   string // optional bearer for protected topics
	Client  *http.Client
}

// NewNtfy returns an ntfy notifier.
func NewNtfy(baseURL, topic, token string, client *http.Client) *Ntfy {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	return &Ntfy{BaseURL: strings.TrimRight(baseURL, "/"), Topic: topic, Token: token, Client: client}
}

func (n *Ntfy) Type() string { return "ntfy" }

// Egress is true for a hosted ntfy.sh instance and false for a self-hosted one
// on a private address, because "no outbound calls" is about leaving the
// operator's infrastructure, not about using the network at all.
func (n *Ntfy) Egress() bool { return !isPrivateHost(n.BaseURL) }

func (n *Ntfy) Send(ctx context.Context, m Message) error {
	if n.BaseURL == "" || n.Topic == "" {
		return fmt.Errorf("ntfy: base URL and topic required: %w", domain.ErrInvalid)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.BaseURL+"/"+n.Topic, strings.NewReader(m.Body))
	if err != nil {
		return err
	}
	req.Header.Set("Title", m.Title)
	req.Header.Set("Priority", ntfyPriority(m.Priority))
	if len(m.Tags) > 0 {
		req.Header.Set("Tags", strings.Join(m.Tags, ","))
	}
	if m.ClickURL != "" {
		req.Header.Set("Click", m.ClickURL)
	}
	if n.Token != "" {
		req.Header.Set("Authorization", "Bearer "+n.Token)
	}
	return do(n.Client, req)
}

func ntfyPriority(p int) string {
	if p < 1 {
		p = 3
	}
	if p > 5 {
		p = 5
	}
	return strconv.Itoa(p)
}

// ---------------------------------------------------------------- webhook

// Webhook POSTs the message as JSON — the escape hatch for anything the
// operator already runs (Matrix bridge, Home Assistant, Gotify, a shell script).
type Webhook struct {
	URL    string
	Secret string
	Client *http.Client
}

// NewWebhook returns a webhook notifier.
func NewWebhook(url, secret string, client *http.Client) *Webhook {
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	return &Webhook{URL: url, Secret: secret, Client: client}
}

func (w *Webhook) Type() string { return "webhook" }
func (w *Webhook) Egress() bool { return !isPrivateHost(w.URL) }

func (w *Webhook) Send(ctx context.Context, m Message) error {
	if w.URL == "" {
		return fmt.Errorf("webhook: URL required: %w", domain.ErrInvalid)
	}
	body, err := json.Marshal(m)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if w.Secret != "" {
		req.Header.Set("X-Lura-Secret", w.Secret)
	}
	return do(w.Client, req)
}

// ---------------------------------------------------------------- in-app

// Publisher is the subset of the bus the in-app notifier needs.
type Publisher interface {
	Publish(subject string, data []byte) error
}

// InApp pushes the reminder down the user's live WebSocket. It never leaves the
// box, so it is always available — including in airgap mode — and it is what
// makes the web control center show a reminder the moment it fires.
type InApp struct {
	Bus Publisher
}

func (i *InApp) Type() string { return "inapp" }
func (i *InApp) Egress() bool { return false }

func (i *InApp) Send(_ context.Context, m Message) error {
	if i.Bus == nil {
		return fmt.Errorf("inapp: bus required: %w", domain.ErrInvalid)
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return i.Bus.Publish("notify."+m.UserID, data)
}

// ---------------------------------------------------------------- log

// Log writes the reminder to the process log. It is the notifier of last resort:
// with no channels configured, a fired reminder still leaves a trace an operator
// can find (and in a self-hosted, airgapped deployment that may be the point).
type Log struct {
	Logger *slog.Logger
}

func (l *Log) Type() string { return "log" }
func (l *Log) Egress() bool { return false }

func (l *Log) Send(ctx context.Context, m Message) error {
	log := l.Logger
	if log == nil {
		log = slog.Default()
	}
	log.InfoContext(ctx, "reminder",
		"title", m.Title, "body", m.Body, "place", m.PlaceName,
		"trigger", m.Trigger, "device", m.DeviceID, "notes", len(m.NoteIDs))
	return nil
}

// ---------------------------------------------------------------- helpers

func do(client *http.Client, req *http.Request) error {
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	if resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("%s %s: %s: %s", req.Method, req.URL.Host, resp.Status, strings.TrimSpace(string(snippet)))
	}
	return nil
}

// isPrivateHost reports whether a URL points at the operator's own network.
//
// Deliberately conservative: anything it cannot *prove* is local counts as
// egress, because a false "this is local" would let airgap mode leak. Note the
// asymmetry — 172.16.0.0/12 is private but 172.217.0.0/16 is Google, so the host
// is parsed as an IP rather than prefix-matched.
func isPrivateHost(raw string) bool {
	h := raw
	if i := strings.Index(h, "://"); i >= 0 {
		h = h[i+3:]
	}
	if i := strings.IndexAny(h, "/?#"); i >= 0 {
		h = h[:i]
	}
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	h = strings.Trim(strings.ToLower(h), "[]")
	if h == "" {
		return false
	}

	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast()
	}

	switch {
	case h == "localhost", strings.HasSuffix(h, ".localhost"):
		return true
	case strings.HasSuffix(h, ".local"), strings.HasSuffix(h, ".internal"),
		strings.HasSuffix(h, ".lan"), strings.HasSuffix(h, ".home.arpa"):
		return true
	case !strings.Contains(h, "."):
		// A single-label name is a container/service name on a private network
		// ("ntfy", "opensearch"), not a public DNS name.
		return true
	}
	return false
}
