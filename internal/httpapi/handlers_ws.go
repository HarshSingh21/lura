package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/share"
	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
)

// WebSocket timings.
//
// keepalive is well under the 60 s idle timeout most reverse proxies default to,
// because a live map that silently dies behind nginx is worse than no live map.
const (
	wsKeepalive    = 25 * time.Second
	wsWriteTimeout = 10 * time.Second
	wsReadLimit    = 32 * 1024 // clients only ever send tiny control frames
)

// clientMessage is the small control vocabulary a client may send. Everything
// else is ignored: the socket is a push channel, not an RPC transport.
type clientMessage struct {
	Type string `json:"type"`
}

// handleWS serves the authenticated live stream.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// Same identity path as the control plane, including provisioning: a client
	// that opens its socket before its first REST call must not race ahead of its
	// own account being created.
	principal, claims, err := s.identify(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.provisi.ensure(r.Context(), principal, claims); err != nil {
		s.writeError(w, r, err)
		return
	}
	uid := principal.UserID

	conn, err := s.acceptWS(w, r)
	if err != nil {
		return // acceptWS already responded
	}

	// The connection outlives the request, so the hub subscription must not be
	// tied to the request context (which the http server cancels on return).
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()

	client, err := s.deps.Hub.Connect(ctx, uid, func(ctx context.Context) ([]string, error) {
		// Authorization lives in the connections service: this user's own subjects
		// plus one per peer who is currently sharing with them. The hub re-runs
		// this on every acl.<viewer> event, so accepting an invitation or pausing
		// sharing changes what flows on the next fix — not at the end of a TTL.
		if s.deps.Connect != nil {
			return s.deps.Connect.Subjects(ctx, uid)
		}
		return []string{
			bus.PosUserWildcard(uid),
			bus.GeoSubject(uid),
			bus.NotifySubject(uid),
		}, nil
	})
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "subscribe failed")
		return
	}
	defer s.deps.Hub.Disconnect(client)

	s.sendSnapshot(ctx, uid, client)
	s.log.InfoContext(ctx, "ws connected", "client", client.ID, "user", uid, "subjects", client.Subjects())

	s.pump(ctx, cancel, conn, client)
	s.log.InfoContext(ctx, "ws disconnected", "client", client.ID, "user", uid)
}

// handleShareWS serves the public read-only stream for a share link.
func (s *Server) handleShareWS(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if _, err := s.deps.Shares.Resolve(r.Context(), token); err != nil {
		s.writeError(w, r, err)
		return
	}

	conn, err := s.acceptWS(w, r)
	if err != nil {
		return
	}

	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()

	// The viewer identity is the token, namespaced. Revoking the share publishes
	// acl.share:<token>, which makes the hub re-run the resolver below; it then
	// returns no subjects and the viewer stops receiving positions immediately.
	client, err := s.deps.Hub.Connect(ctx, share.ViewerID(token), func(ctx context.Context) ([]string, error) {
		return s.deps.Shares.Subjects(ctx, token)
	})
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "subscribe failed")
		return
	}
	defer s.deps.Hub.Disconnect(client)

	if view, err := s.deps.Shares.View(ctx, token); err == nil {
		s.deps.Hub.Send(client, "snapshot", map[string]any{"share": view})
	}
	s.log.InfoContext(ctx, "share ws connected", "client", client.ID, "subjects", client.Subjects())

	s.pump(ctx, cancel, conn, client)
}

// acceptWS upgrades the connection, enforcing the origin allowlist.
func (s *Server) acceptWS(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	opts := &websocket.AcceptOptions{
		OriginPatterns:     s.deps.Config.AllowedOrigins,
		CompressionMode:    websocket.CompressionContextTakeover,
		InsecureSkipVerify: originAllowed(s.deps.Config.AllowedOrigins, "*"),
	}
	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		// Accept has already written a response; log for diagnosis and stop.
		s.log.WarnContext(r.Context(), "ws upgrade failed", "error", err, "origin", r.Header.Get("Origin"))
		return nil, err
	}
	conn.SetReadLimit(wsReadLimit)
	return conn, nil
}

// sendSnapshot gives a freshly connected client everything it needs to paint the
// map before the first live fix arrives — otherwise the map is empty for up to
// one ping interval (~20 s), which reads as "broken".
func (s *Server) sendSnapshot(ctx context.Context, uid string, client *hub.Client) {
	devices, err := s.deps.Store.ListDevices(ctx, uid)
	if err != nil {
		s.log.WarnContext(ctx, "ws: snapshot devices failed", "error", err)
		return
	}
	places, err := s.deps.Store.ListPlaces(ctx, uid)
	if err != nil {
		s.log.WarnContext(ctx, "ws: snapshot places failed", "error", err)
		return
	}
	inside := map[string][]string{}
	if s.deps.Geofence != nil {
		inside = s.deps.Geofence.InsideSnapshot()
	}
	views := make([]deviceView, 0, len(devices))
	for _, d := range devices {
		views = append(views, deviceView{Device: d, InsidePlaces: inside[d.ID]})
	}
	s.deps.Hub.Send(client, "snapshot", map[string]any{
		"devices": views,
		"places":  places,
		"server":  s.serverInfo(),
	})
}

// pump runs the read and write loops until either side goes away.
//
// Reads exist mostly to notice a dead peer: the protocol is push-only apart from
// an application-level ping, which browsers need because they cannot send
// WebSocket control pings themselves.
func (s *Server) pump(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, client *hub.Client) {
	go func() {
		defer cancel()
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				status := websocket.CloseStatus(err)
				if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
					return
				}
				if !errors.Is(err, context.Canceled) {
					s.log.DebugContext(ctx, "ws read ended", "client", client.ID, "error", err)
				}
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			var msg clientMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "ping":
				s.deps.Hub.Send(client, hub.FramePong, map[string]any{"ts": time.Now().UTC()})
			case "resubscribe":
				// Lets a client force an authorization re-check, e.g. after it
				// knows a share changed.
				if err := client.Resubscribe(ctx); err != nil {
					s.log.WarnContext(ctx, "ws resubscribe failed", "client", client.ID, "error", err)
				}
			}
		}
	}()

	keepalive := time.NewTicker(wsKeepalive)
	defer keepalive.Stop()

	for {
		select {
		case <-ctx.Done():
			_ = conn.Close(websocket.StatusNormalClosure, "bye")
			return

		case <-client.Done():
			_ = conn.Close(websocket.StatusNormalClosure, "server closed subscription")
			return

		case frame, ok := <-client.Out():
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "bye")
				return
			}
			writeCtx, cancelWrite := context.WithTimeout(ctx, wsWriteTimeout)
			err := conn.Write(writeCtx, websocket.MessageText, frame)
			cancelWrite()
			if err != nil {
				s.log.DebugContext(ctx, "ws write failed", "client", client.ID, "error", err)
				_ = conn.CloseNow()
				return
			}

		case <-keepalive.C:
			pingCtx, cancelPing := context.WithTimeout(ctx, wsWriteTimeout)
			err := conn.Ping(pingCtx)
			cancelPing()
			if err != nil {
				// A peer that will not answer a ping is gone, whatever TCP thinks.
				s.log.DebugContext(ctx, "ws keepalive failed", "client", client.ID, "error", err)
				_ = conn.CloseNow()
				return
			}
		}
	}
}
