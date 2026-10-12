package httpapi

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/HarshSingh21/locnot/internal/auth"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

// postgresLikeStore behaves like Postgres under a race: an insert that finds the
// person's e-mail already taken by a concurrent insert fails with a conflict,
// although the row it collided with is the same person.
type postgresLikeStore struct {
	store.Store
	upserts atomic.Int32
	mu      sync.Mutex
}

func (s *postgresLikeStore) UpsertUser(ctx context.Context, u domain.User) error {
	s.upserts.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.Store.GetUser(ctx, u.ID); err == nil {
		return domain.ErrConflict
	}
	return s.Store.UpsertUser(ctx, u)
}

func TestProvisionFirstRequestsAtOnceAllSucceed(t *testing.T) {
	st := &postgresLikeStore{Store: memory.New()}
	p := newProvisioner(&Server{deps: Deps{Store: st}, log: slog.Default()})
	principal := auth.Principal{UserID: "kc-harsh"}
	claims := auth.Claims{Subject: "kc-harsh", Email: "harsh@lura.local", Name: "Harsh Singh"}

	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = p.ensure(context.Background(), principal, claims)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if n := st.upserts.Load(); n != 1 {
		t.Fatalf("%d inserts for one person, want 1", n)
	}
}

// Another process sharing the database created the row between our read and
// our insert: the conflict means "already provisioned", not a failure.
func TestProvisionConflictWithAnExistingRowIsSuccess(t *testing.T) {
	st := &postgresLikeStore{Store: memory.New()}
	p := newProvisioner(&Server{deps: Deps{Store: &racingStore{postgresLikeStore: st}}, log: slog.Default()})
	err := p.ensure(context.Background(), auth.Principal{UserID: "kc-n"}, auth.Claims{Subject: "kc-n", Email: "n@lura.local"})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
}

// racingStore creates the user itself (as another process would) the first
// time it is asked whether the user exists, after answering "no".
type racingStore struct {
	*postgresLikeStore
	once sync.Once
}

func (s *racingStore) GetUser(ctx context.Context, id string) (domain.User, error) {
	var raced bool
	s.once.Do(func() {
		raced = true
		_ = s.postgresLikeStore.Store.UpsertUser(ctx, domain.User{ID: id, Email: "n@lura.local"})
	})
	if raced {
		return domain.User{}, domain.ErrNotFound
	}
	return s.postgresLikeStore.GetUser(ctx, id)
}
