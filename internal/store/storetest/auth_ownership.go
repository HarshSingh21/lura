package storetest

import (
	"errors"
	"testing"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store"
)

// testDeviceOwnership: device ids are global (clients may choose their own), so
// an upsert naming an id that another user's device already has is a conflict.
// It must neither move the device to the caller (memory once did: the phone,
// its last position and its future fixes became the caller's) nor silently
// succeed without writing anything (PostgreSQL once did, so the API answered
// 201 with a token that did not exist).
func testDeviceOwnership(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustUser(t, st, "u2")
	mustDevice(t, st, "u1", "d1")

	err := st.UpsertDevice(ctx, domain.Device{ID: "d1", UserID: "u2", Name: "Mine now", Kind: "phone", Token: "tok-u2"})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("upsert of u1's device id by u2: err = %v, want ErrConflict", err)
	}

	got, err := st.GetDevice(ctx, "u1", "d1")
	if err != nil {
		t.Fatalf("GetDevice(u1, d1) after the attempt: %v", err)
	}
	if got.UserID != "u1" || got.Name == "Mine now" || got.Token != "tok-d1" {
		t.Errorf("u1's device after the attempt = %+v", got)
	}
	if _, err := st.GetDevice(ctx, "u2", "d1"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("GetDevice(u2, d1) = %v, want ErrNotFound", err)
	}
	if _, err := st.DeviceByToken(ctx, "tok-u2"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Errorf("the refused upsert's token authenticates: %v", err)
	}
	if dev, err := st.DeviceByToken(ctx, "tok-d1"); err != nil || dev.UserID != "u1" {
		t.Errorf("u1's token = %+v, %v", dev, err)
	}

	// The owner upserting their own id is still an update.
	if err := st.UpsertDevice(ctx, domain.Device{ID: "d1", UserID: "u1", Name: "Renamed", Kind: "phone"}); err != nil {
		t.Fatalf("owner upsert: %v", err)
	}
}
