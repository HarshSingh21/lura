package httpapi_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
)

// Two-way live tracking between Harsh and Nishtha, scenario by scenario, as the
// two of them (and a stranger) would live it: real HTTP for every consent
// change, real WebSockets for what each person's map receives — and, as much
// as what arrives, what must not.

var (
	harshHome   = [2]float64{12.9611, 77.6387}
	nishthaHome = [2]float64{12.9700, 77.6400}
)

// ---------------------------------------------------------------- connections

func TestTrackingInviteThenAcceptReadsRightOnEachSide(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.invite(s.harsh, s.nishtha)

		mine := s.people(s.harsh)[s.nishtha.id]
		theirs := s.people(s.nishtha)[s.harsh.id]
		if mine["status"] != "pending_out" || theirs["status"] != "pending_in" {
			t.Fatalf("pending: Harsh sees %v, Nishtha sees %v", mine["status"], theirs["status"])
		}
		if theirs["peerName"] != "Harsh" || mine["peerName"] != "Nishtha" {
			t.Errorf("names: Harsh sees %v, Nishtha sees %v", mine["peerName"], theirs["peerName"])
		}
		for who, row := range map[string]map[string]any{"Harsh": mine, "Nishtha": theirs} {
			if row["watchingMe"] == true || row["sharingWithMe"] == true {
				t.Errorf("%s: a pending invitation already shares: %v", who, row)
			}
		}
		if len(s.people(s.stranger)) != 0 {
			t.Error("the stranger sees the pair's invitation")
		}

		s.accept(s.nishtha, s.harsh)
		mine = s.people(s.harsh)[s.nishtha.id]
		theirs = s.people(s.nishtha)[s.harsh.id]
		for who, row := range map[string]map[string]any{"Harsh": mine, "Nishtha": theirs} {
			if row["status"] != "accepted" || row["watchingMe"] != true || row["sharingWithMe"] != true {
				t.Errorf("%s after accepting: %v, want accepted both ways", who, row)
			}
		}
	})
}

func TestTrackingDeclineLeavesNothingAndReinviteIsFresh(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.invite(s.harsh, s.nishtha)
		// The client's Decline is a DELETE by the invitee.
		s.remove(s.nishtha, s.harsh)

		if p := s.people(s.harsh); len(p) != 0 {
			t.Errorf("inviter still lists a declined invitation: %v", p)
		}
		if p := s.people(s.nishtha); len(p) != 0 {
			t.Errorf("invitee still lists the invitation she declined: %v", p)
		}
		// Accepting what was declined is not possible.
		if got, _ := s.call(s.nishtha.token, http.MethodPost, "/api/v1/people/"+s.harsh.id+"/accept", nil); got != http.StatusNotFound {
			t.Errorf("accepting a declined invitation = %d, want 404", got)
		}

		// Harsh may ask again; it is a new, pending invitation.
		s.invite(s.harsh, s.nishtha)
		if got := s.people(s.nishtha)[s.harsh.id]["status"]; got != "pending_in" {
			t.Errorf("re-invite after decline: Nishtha sees %v, want pending_in", got)
		}
	})
}

func TestTrackingInviterCancelsAnInvitation(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.invite(s.harsh, s.nishtha)
		s.remove(s.harsh, s.nishtha)
		if len(s.people(s.harsh)) != 0 || len(s.people(s.nishtha)) != 0 {
			t.Fatal("a cancelled invitation is still listed")
		}
		if got, _ := s.call(s.nishtha.token, http.MethodPost, "/api/v1/people/"+s.harsh.id+"/accept", nil); got != http.StatusNotFound {
			t.Errorf("accepting a cancelled invitation = %d, want 404", got)
		}
	})
}

func TestTrackingInviteRejections(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		cases := []struct {
			name  string
			email string
			want  int
		}{
			{"self", s.harsh.email, http.StatusBadRequest},
			{"self in capitals", strings.ToUpper(s.harsh.email), http.StatusBadRequest},
			{"unknown address", "nobody@lura.local", http.StatusNotFound},
			{"empty", "  ", http.StatusBadRequest},
		}
		for _, tc := range cases {
			if got, body := s.call(s.harsh.token, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": tc.email}); got != tc.want {
				t.Errorf("%s: invite = %d, want %d: %v", tc.name, got, tc.want, body)
			}
		}
		if len(s.people(s.harsh)) != 0 {
			t.Fatalf("a rejected invitation left a row: %v", s.people(s.harsh))
		}

		// An address typed differently still finds the account.
		s.must(s.harsh, http.MethodPost, "/api/v1/people/invite",
			map[string]any{"email": "  NISHTHA@Lura.Local "}, http.StatusCreated)

		// A second invitation while the first is unanswered is a conflict.
		if got, _ := s.call(s.harsh.token, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": s.nishtha.email}); got != http.StatusConflict {
			t.Errorf("duplicate pending invite = %d, want 409", got)
		}
		s.accept(s.nishtha, s.harsh)

		// Inviting someone already connected never downgrades the connection.
		for _, from := range []trackingUser{s.harsh, s.nishtha} {
			to := s.nishtha
			if from.id == s.nishtha.id {
				to = s.harsh
			}
			if got, _ := s.call(from.token, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": to.email}); got != http.StatusConflict {
				t.Errorf("%s re-inviting a connected peer = %d, want 409", from.name, got)
			}
		}
		if s.people(s.harsh)[s.nishtha.id]["status"] != "accepted" || s.people(s.nishtha)[s.harsh.id]["status"] != "accepted" {
			t.Error("a repeated invite downgraded a live connection")
		}
	})
}

func TestTrackingAcceptRules(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		// Nothing to accept.
		if got, _ := s.call(s.nishtha.token, http.MethodPost, "/api/v1/people/"+s.harsh.id+"/accept", nil); got != http.StatusNotFound {
			t.Errorf("accept with no invitation = %d, want 404", got)
		}
		s.invite(s.harsh, s.nishtha)
		// The inviter cannot accept on the invitee's behalf.
		if got, _ := s.call(s.harsh.token, http.MethodPost, "/api/v1/people/"+s.nishtha.id+"/accept", nil); got != http.StatusBadRequest {
			t.Errorf("inviter accepting their own invitation = %d, want 400", got)
		}
		// Nor can a third party.
		if got, _ := s.call(s.stranger.token, http.MethodPost, "/api/v1/people/"+s.harsh.id+"/accept", nil); got != http.StatusNotFound {
			t.Errorf("stranger accepting = %d, want 404", got)
		}
		if s.people(s.nishtha)[s.harsh.id]["status"] != "pending_in" {
			t.Fatal("a refused accept changed the invitation")
		}
		// Accepting twice (a double tap) is not an error.
		s.accept(s.nishtha, s.harsh)
		s.accept(s.nishtha, s.harsh)
		if s.people(s.harsh)[s.nishtha.id]["status"] != "accepted" {
			t.Fatal("accept twice broke the connection")
		}
	})
}

func TestTrackingCrossedInvitesBecomeOneConnection(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.invite(s.harsh, s.nishtha)
		// She invites him instead of accepting: that is an accept.
		body := s.invite(s.nishtha, s.harsh)
		if conn, _ := body["connection"].(map[string]any); conn["status"] != "accepted" {
			t.Errorf("crossed invite returned %v, want the accepted connection", body)
		}
		assertOneAcceptedPair(t, s)
	})
}

func TestTrackingConcurrentCrossedInvites(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		for round := 0; round < 5; round++ {
			var wg sync.WaitGroup
			codes := make([]int, 2)
			for i, pair := range [][2]trackingUser{{s.harsh, s.nishtha}, {s.nishtha, s.harsh}} {
				wg.Add(1)
				go func() {
					defer wg.Done()
					codes[i], _ = s.call(pair[0].token, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": pair[1].email})
				}()
			}
			wg.Wait()
			for i, code := range codes {
				if code != http.StatusCreated {
					t.Fatalf("round %d: invite %d = %d, want 201", round, i, code)
				}
			}
			assertOneAcceptedPair(t, s)
			s.remove(s.harsh, s.nishtha)
		}
	})
}

func assertOneAcceptedPair(t *testing.T, s *trackingStack) {
	t.Helper()
	for _, side := range []struct {
		who  trackingUser
		peer string
	}{{s.harsh, s.nishtha.id}, {s.nishtha, s.harsh.id}} {
		list := s.people(side.who) // fails on a duplicate row
		if len(list) != 1 || list[side.peer]["status"] != "accepted" || list[side.peer]["sharingWithMe"] != true {
			t.Fatalf("%s's People = %v, want one accepted, sharing connection", side.who.name, list)
		}
	}
}

// ---------------------------------------------------------------- live

func TestTrackingBothShareAndEachSeesTheOther(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		// Sockets are open before they are connected: the accept must upgrade
		// them in place.
		harsh, _ := s.dial(s.harsh, "")
		nishtha, _ := s.dial(s.nishtha, "")
		stranger, _ := s.dial(s.stranger, "")

		s.connect()
		harsh.next(hub.FrameACL)
		nishtha.next(hub.FrameACL)

		s.publish(s.harsh.phone, at(harshHome[0], harshHome[1]))
		if got := nishtha.positionFrom(s.harsh.phone.id); got.UserID != s.harsh.id || got.Point.Lat != harshHome[0] {
			t.Errorf("Nishtha received %+v, want Harsh at home", got)
		}
		// Harsh's own map shows his own phone too.
		harsh.positionFrom(s.harsh.phone.id)

		s.publish(s.nishtha.phone, at(nishthaHome[0], nishthaHome[1]))
		if got := harsh.positionFrom(s.nishtha.phone.id); got.UserID != s.nishtha.id || got.Point.Lat != nishthaHome[0] {
			t.Errorf("Harsh received %+v, want Nishtha at home", got)
		}

		// The stranger publishes; neither of them may receive it, and the
		// stranger receives nothing of theirs.
		s.publish(s.stranger.phone, at(12.99, 77.70))
		for who, sock := range map[string]*liveSocket{"Harsh": harsh, "Nishtha": nishtha} {
			if got := positionsOf(t, sock.drain(400*time.Millisecond), s.stranger.id); len(got) != 0 {
				t.Errorf("%s received the stranger's position", who)
			}
		}
		frames := stranger.drain(200 * time.Millisecond)
		for _, uid := range []string{s.harsh.id, s.nishtha.id} {
			if got := positionsOf(t, frames, uid); len(got) != 0 {
				t.Errorf("the stranger received %s's position", uid)
			}
		}
	})
}

func TestTrackingSnapshotOnConnectShowsOnlySharingPeers(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.connect()
		s.publish(s.harsh.phone, at(harshHome[0], harshHome[1]))
		s.publish(s.nishtha.phone, at(nishthaHome[0], nishthaHome[1]))
		eventually(t, "both last points stored", func() bool {
			return s.devicePoint(s.harsh, s.nishtha.id, s.nishtha.phone.id) != nil &&
				s.devicePoint(s.nishtha, s.harsh.id, s.harsh.phone.id) != nil
		})

		_, snap := s.dial(s.harsh, "")
		devices, ok := snap.peer(s.nishtha.id)
		if !ok || len(devices) != 1 || devices[0].ID != s.nishtha.phone.id || devices[0].Point == nil ||
			devices[0].Point.Lat != nishthaHome[0] {
			t.Fatalf("Harsh's snapshot peers = %+v, want Nishtha's phone at home", snap.Peers)
		}
		_, snap = s.dial(s.nishtha, "")
		if _, ok := snap.peer(s.harsh.id); !ok {
			t.Errorf("Nishtha's snapshot has no Harsh: %+v", snap.Peers)
		}
		_, snap = s.dial(s.stranger, "")
		if len(snap.Peers) != 0 {
			t.Errorf("the stranger's snapshot carries peers: %+v", snap.Peers)
		}

		// Nishtha pauses: Harsh's next first paint does not have her, hers still
		// has him.
		s.setSharing(s.nishtha, s.harsh, false)
		_, snap = s.dial(s.harsh, "")
		if _, ok := snap.peer(s.nishtha.id); ok {
			t.Errorf("a paused peer is in the snapshot: %+v", snap.Peers)
		}
		_, snap = s.dial(s.nishtha, "")
		if _, ok := snap.peer(s.harsh.id); !ok {
			t.Error("pausing her own sharing removed Harsh from her snapshot")
		}
	})
}

func TestTrackingPendingInvitationGrantsNoPositions(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.invite(s.harsh, s.nishtha)
		harsh, snapH := s.dial(s.harsh, "")
		nishtha, snapN := s.dial(s.nishtha, "")
		if len(snapH.Peers)+len(snapN.Peers) != 0 {
			t.Fatalf("a pending invitation put peers in a snapshot: %+v %+v", snapH.Peers, snapN.Peers)
		}
		s.publish(s.harsh.phone, at(harshHome[0], harshHome[1]))
		s.publish(s.nishtha.phone, at(nishthaHome[0], nishthaHome[1]))
		if got := positionsOf(t, nishtha.drain(400*time.Millisecond), s.harsh.id); len(got) != 0 {
			t.Error("the invitee received the inviter's position before accepting")
		}
		if got := positionsOf(t, harsh.drain(200*time.Millisecond), s.nishtha.id); len(got) != 0 {
			t.Error("the inviter received the invitee's position before she accepted")
		}
	})
}

// Pausing must stop the very next fix — the one published right after the
// PATCH returned, without waiting for any frame — and resuming must deliver
// the very next one.
func TestTrackingPauseStopsTheNextFixAndResumeRestarts(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.connect()
		harsh, _ := s.dial(s.harsh, "")
		nishtha, _ := s.dial(s.nishtha, "")

		for round := 0; round < 5; round++ {
			s.publish(s.nishtha.phone, at(nishthaHome[0], nishthaHome[1]))
			harsh.positionFrom(s.nishtha.phone.id)

			s.setSharing(s.nishtha, s.harsh, false)
			s.publish(s.nishtha.phone, at(nishthaHome[0]+0.001, nishthaHome[1]))
			for _, pos := range positionsOf(t, harsh.drain(300*time.Millisecond), s.nishtha.id) {
				t.Fatalf("round %d: Harsh received Nishtha's fix after she paused: %+v", round, pos.Point)
			}
			row := s.people(s.harsh)[s.nishtha.id]
			if devices, _ := row["devices"].([]any); row["sharingWithMe"] == true || len(devices) != 0 {
				t.Fatalf("round %d: Harsh's People still shows her: %v", round, row)
			}

			// One-sided: she still sees him.
			s.publish(s.harsh.phone, at(harshHome[0]+float64(round)*0.0001, harshHome[1]))
			nishtha.positionFrom(s.harsh.phone.id)

			s.setSharing(s.nishtha, s.harsh, true)
			s.publish(s.nishtha.phone, at(nishthaHome[0]+0.002, nishthaHome[1]))
			if got := harsh.positionFrom(s.nishtha.phone.id); got.Point.Lat != nishthaHome[0]+0.002 {
				t.Fatalf("round %d: after resuming Harsh got %+v, want the fix sent after resume", round, got.Point)
			}
		}
	})
}

// A switch turned off before accepting stays off: accepting is consent to the
// connection, not a reset of the choice she already made.
func TestTrackingPauseBeforeAcceptingIsKept(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.invite(s.harsh, s.nishtha)
		s.setSharing(s.nishtha, s.harsh, false)
		s.accept(s.nishtha, s.harsh)

		harsh, _ := s.dial(s.harsh, "")
		nishtha, _ := s.dial(s.nishtha, "")
		s.publish(s.nishtha.phone, at(nishthaHome[0], nishthaHome[1]))
		s.publish(s.harsh.phone, at(harshHome[0], harshHome[1]))
		nishtha.positionFrom(s.harsh.phone.id)
		if got := positionsOf(t, harsh.drain(400*time.Millisecond), s.nishtha.id); len(got) != 0 {
			t.Error("a switch turned off before accepting was ignored")
		}
	})
}

func TestTrackingRemoveStopsBothWaysAndReinviteStartsClean(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.connect()
		// She had paused before the removal: a fresh start must not inherit it.
		s.setSharing(s.nishtha, s.harsh, false)
		harsh, _ := s.dial(s.harsh, "")
		nishtha, _ := s.dial(s.nishtha, "")

		s.remove(s.harsh, s.nishtha)
		s.publish(s.harsh.phone, at(harshHome[0], harshHome[1]))
		s.publish(s.nishtha.phone, at(nishthaHome[0], nishthaHome[1]))
		if got := positionsOf(t, nishtha.drain(400*time.Millisecond), s.harsh.id); len(got) != 0 {
			t.Error("Nishtha received Harsh's fix after the connection was removed")
		}
		if got := positionsOf(t, harsh.drain(200*time.Millisecond), s.nishtha.id); len(got) != 0 {
			t.Error("Harsh received Nishtha's fix after the connection was removed")
		}
		if len(s.people(s.harsh)) != 0 || len(s.people(s.nishtha)) != 0 {
			t.Fatal("a removed connection is still listed")
		}
		for _, u := range []trackingUser{s.harsh, s.nishtha} {
			if _, snap := s.dial(u, ""); len(snap.Peers) != 0 {
				t.Errorf("%s's snapshot still has a removed peer", u.name)
			}
		}
		// The other side cannot act on a removed row.
		if got, _ := s.call(s.nishtha.token, http.MethodPatch, "/api/v1/people/"+s.harsh.id, map[string]any{"sharing": true}); got != http.StatusNotFound {
			t.Errorf("patching a removed connection = %d, want 404", got)
		}

		// Re-invite: pending again, nothing flows until accepted, then both
		// share by default.
		s.invite(s.nishtha, s.harsh)
		if got := s.people(s.harsh)[s.nishtha.id]; got["status"] != "pending_in" || got["sharingWithMe"] == true {
			t.Fatalf("re-invite: Harsh sees %v", got)
		}
		s.publish(s.nishtha.phone, at(nishthaHome[0], nishthaHome[1]))
		if got := positionsOf(t, harsh.drain(300*time.Millisecond), s.nishtha.id); len(got) != 0 {
			t.Error("a re-invitation granted positions before it was accepted")
		}
		s.accept(s.harsh, s.nishtha)
		assertOneAcceptedPair(t, s)
		harsh.next(hub.FrameACL)
		nishtha.next(hub.FrameACL)
		s.publish(s.nishtha.phone, at(nishthaHome[0]+0.001, nishthaHome[1]))
		harsh.positionFrom(s.nishtha.phone.id)
		s.publish(s.harsh.phone, at(harshHome[0]+0.001, harshHome[1]))
		nishtha.positionFrom(s.harsh.phone.id)
	})
}

// ---------------------------------------------------------------- reconnect

// Harsh watches Nishtha on his Grocery fence. His socket drops; she leaves the
// shop meanwhile. When he reconnects with since= he is told exactly what he
// missed — once — and nothing he already had.
func TestTrackingReconnectReplaysMissedFramesExactlyOnce(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.connect()
		s.must(s.harsh, http.MethodPost, "/api/v1/places", map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"arrive", "leave"},
			"watchUserIds": []string{s.nishtha.id},
		}, http.StatusCreated)

		harsh, _ := s.dial(s.harsh, "")
		s.publish(s.nishtha.phone, at(nearGrocery[0], nearGrocery[1]))
		s.publish(s.nishtha.phone, at(inGrocery[0], inGrocery[1]))
		// The event and its reminder travel separate subjects: either may
		// arrive first.
		seen := map[string]int{}
		eventually(t, "the arrival and its reminder", func() bool {
			for _, f := range harsh.drain(50 * time.Millisecond) {
				seen[f.Type]++
				if f.Type == hub.FrameGeo && !strings.Contains(string(f.Data), `"arrive"`) {
					t.Fatalf("first geo event = %s, want the arrival", f.Data)
				}
			}
			return seen[hub.FrameGeo] > 0 && seen[hub.FrameNotify] > 0
		})
		harsh.drain(300 * time.Millisecond) // whatever else is in flight
		since := harsh.since()
		harsh.close()

		// While he is away she walks out.
		s.publish(s.nishtha.phone, at(nearGrocery[0], nearGrocery[1]))
		eventually(t, "the leave event", func() bool {
			code, body := s.call(s.harsh.token, http.MethodGet, "/api/v1/events?limit=10", nil)
			if code != http.StatusOK {
				return false
			}
			events, _ := body["events"].([]any)
			for _, raw := range events {
				if ev, _ := raw.(map[string]any); ev["trigger"] == "leave" {
					return true
				}
			}
			return false
		})
		time.Sleep(200 * time.Millisecond) // the reminder follows the event

		back, _ := s.dial(s.harsh, since)
		got := map[string][]string{}
		for _, f := range back.drain(800 * time.Millisecond) {
			switch f.Type {
			case hub.FrameGeo:
				var ev domain.GeoEvent
				_ = json.Unmarshal(f.Data, &ev)
				got["geo"] = append(got["geo"], string(ev.Trigger))
			case hub.FrameNotify:
				var msg struct {
					Title string `json:"title"`
				}
				_ = json.Unmarshal(f.Data, &msg)
				got["notify"] = append(got["notify"], msg.Title)
			}
		}
		if len(got["geo"]) != 1 || got["geo"][0] != "leave" {
			t.Errorf("replayed geo = %v, want only the leave", got["geo"])
		}
		if len(got["notify"]) != 1 || got["notify"][0] != "Nishtha left Grocery" {
			t.Errorf("replayed reminders = %v, want only \"Nishtha left Grocery\"", got["notify"])
		}

		// Reconnecting again from the newest frame replays nothing.
		since = back.since()
		back.close()
		again, _ := s.dial(s.harsh, since)
		for _, f := range again.drain(500 * time.Millisecond) {
			if f.Type == hub.FrameGeo || f.Type == hub.FrameNotify {
				t.Errorf("a second reconnect replayed %s again: %s", f.Type, f.Data)
			}
		}
	})
}

// ---------------------------------------------------------------- ordering

// A phone on a flaky network delivers a fix it took 30 s ago after the newest
// one. Nishtha's marker on Harsh's map must never step back to it: not live,
// not in People, not in a fresh snapshot.
func TestTrackingLateFixesNeverMovePeerBackwards(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.connect()
		harsh, _ := s.dial(s.harsh, "")
		now := time.Now().Unix()

		newest := fix{lat: nishthaHome[0], lon: nishthaHome[1], tst: now}
		s.publish(s.nishtha.phone, newest)
		if got := harsh.positionFrom(s.nishtha.phone.id); got.Point.Lat != newest.lat {
			t.Fatalf("first fix = %+v", got.Point)
		}
		stale := fix{lat: 12.9500, lon: 77.6000, tst: now - 30}
		if out := s.publish(s.nishtha.phone, stale); out == nil {
			t.Fatal("a late fix must still be acked")
		}
		// A resend of the newest fix is not news either.
		s.publish(s.nishtha.phone, newest)
		if got := positionsOf(t, harsh.drain(500*time.Millisecond), s.nishtha.id); len(got) != 0 {
			t.Fatalf("Harsh's map received %d frames after the newest: %+v", len(got), got)
		}

		eventually(t, "the stored point", func() bool {
			return s.devicePoint(s.harsh, s.nishtha.id, s.nishtha.phone.id) != nil
		})
		time.Sleep(100 * time.Millisecond) // let the late fix reach the writer too
		if pt := s.devicePoint(s.harsh, s.nishtha.id, s.nishtha.phone.id); pt.Lat != newest.lat {
			t.Errorf("People shows %+v, want the newest fix", pt)
		}
		_, snap := s.dial(s.harsh, "")
		if devices, _ := snap.peer(s.nishtha.id); len(devices) != 1 || devices[0].Point.Lat != newest.lat {
			t.Errorf("snapshot shows %+v, want the newest fix", devices)
		}

		// The next real fix moves her forwards again.
		s.publish(s.nishtha.phone, fix{lat: nishthaHome[0] + 0.001, lon: nishthaHome[1], tst: now + 5})
		if got := harsh.positionFrom(s.nishtha.phone.id); got.Point.Lat != nishthaHome[0]+0.001 {
			t.Errorf("next fix = %+v", got.Point)
		}
	})
}

// Each device's clock is its own: Nishtha's phone runs ten minutes slow and
// Harsh's five minutes fast, and her laptop is right. Every live fix from each
// still reaches the other's map as live, dated at arrival — and one device's
// clock never makes another's fixes look late.
func TestTrackingClockOffsetIsPerDevice(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.connect()
		laptop := s.addDevice(t, s.nishtha, "laptop")
		harsh, _ := s.dial(s.harsh, "")
		nishtha, _ := s.dial(s.nishtha, "")

		for i := 0; i < 3; i++ {
			lat := nishthaHome[0] + float64(i)*0.0005
			now := time.Now()

			s.publish(s.nishtha.phone, fix{lat: lat, lon: nishthaHome[1], tst: now.Add(-10 * time.Minute).Unix()})
			assertLive(t, harsh.positionFrom(s.nishtha.phone.id), lat)

			s.publish(laptop, fix{lat: lat, lon: nishthaHome[1] + 0.001, tst: now.Unix()})
			assertLive(t, harsh.positionFrom(laptop.id), lat)

			s.publish(s.harsh.phone, fix{lat: harshHome[0] + float64(i)*0.0005, lon: harshHome[1], tst: now.Add(5 * time.Minute).Unix()})
			assertLive(t, nishtha.positionFrom(s.harsh.phone.id), harshHome[0]+float64(i)*0.0005)
			time.Sleep(1100 * time.Millisecond) // the next fix is a second later by every clock
		}
	})
}

func assertLive(t *testing.T, pos domain.Position, lat float64) {
	t.Helper()
	if pos.Late {
		t.Errorf("%s: a live fix was marked late", pos.DeviceID)
	}
	if pos.Point.Lat != lat {
		t.Errorf("%s: lat %v, want %v", pos.DeviceID, pos.Point.Lat, lat)
	}
	if d := pos.RecvTS.Sub(pos.FixTS); d < 0 || d > 2*time.Second {
		t.Errorf("%s: fixTs is %v before arrival, want ~0 for a live fix", pos.DeviceID, d)
	}
}

// ---------------------------------------------------------------- devices

func TestTrackingMultipleDevicesPerUser(t *testing.T) {
	forEachTrackingStore(t, func(t *testing.T, s *trackingStack) {
		s.connect()
		laptop := s.addDevice(t, s.nishtha, "laptop")
		harsh, _ := s.dial(s.harsh, "")
		stranger, _ := s.dial(s.stranger, "")

		s.publish(s.nishtha.phone, at(nishthaHome[0], nishthaHome[1]))
		s.publish(laptop, at(nishthaHome[0]+0.01, nishthaHome[1]))
		if got := harsh.positionFrom(s.nishtha.phone.id); got.Point.Lat != nishthaHome[0] {
			t.Errorf("phone = %+v", got.Point)
		}
		if got := harsh.positionFrom(laptop.id); got.Point.Lat != nishthaHome[0]+0.01 {
			t.Errorf("laptop = %+v", got.Point)
		}
		if got := positionsOf(t, stranger.drain(300*time.Millisecond), s.nishtha.id); len(got) != 0 {
			t.Error("the stranger received one of Nishtha's devices")
		}

		eventually(t, "both devices in People", func() bool {
			return s.devicePoint(s.harsh, s.nishtha.id, s.nishtha.phone.id) != nil &&
				s.devicePoint(s.harsh, s.nishtha.id, laptop.id) != nil
		})
		_, snap := s.dial(s.harsh, "")
		if devices, _ := snap.peer(s.nishtha.id); len(devices) != 2 {
			t.Errorf("snapshot has %d of Nishtha's devices, want 2: %+v", len(devices), devices)
		}

		// Pausing covers every device of hers, not just one.
		s.setSharing(s.nishtha, s.harsh, false)
		s.publish(s.nishtha.phone, at(nishthaHome[0]+0.002, nishthaHome[1]))
		s.publish(laptop, at(nishthaHome[0]+0.012, nishthaHome[1]))
		if got := positionsOf(t, harsh.drain(400*time.Millisecond), s.nishtha.id); len(got) != 0 {
			t.Errorf("a paused peer's devices still reach Harsh: %d frames", len(got))
		}
		s.setSharing(s.nishtha, s.harsh, true)

		// She deletes the laptop: Harsh's map is told to re-read her devices,
		// People drops it, and its credential no longer publishes.
		s.must(s.nishtha, http.MethodDelete, "/api/v1/devices/"+laptop.id, nil, http.StatusNoContent)
		eventually(t, "the devices ACL", func() bool {
			for _, f := range harsh.drain(100 * time.Millisecond) {
				if f.Type == hub.FrameACL && strings.Contains(string(f.Data), `"devices"`) {
					return true
				}
			}
			return false
		})
		row := s.people(s.harsh)[s.nishtha.id]
		devices, _ := row["devices"].([]any)
		for _, raw := range devices {
			if raw.(map[string]any)["id"] == laptop.id {
				t.Error("People still lists a deleted device")
			}
		}
		if got, _ := s.call(laptop.token, http.MethodPost, "/pub", map[string]any{"_type": "location", "lat": 12.9, "lon": 77.6}); got != http.StatusUnauthorized {
			t.Errorf("a deleted device published: %d, want 401", got)
		}
	})
}
