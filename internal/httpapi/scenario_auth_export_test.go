package httpapi

import "github.com/go-chi/chi/v5"

// RoutesForTest exposes the router so the auth scenarios can walk every
// registered route instead of keeping a hand-written list that drifts.
func RoutesForTest(s *Server) chi.Routes { return s.router }
