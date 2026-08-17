package ai_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/ai"
	"github.com/HarshSingh21/locnot/internal/domain"
)

func demoPlaces() []domain.Place {
	return []domain.Place{
		{ID: "plc_home", Name: "Home", Tags: []string{"home"},
			Triggers: []domain.Trigger{domain.TriggerArrive, domain.TriggerLeave}},
		{ID: "plc_office", Name: "Office", Tags: []string{"work"},
			Triggers: []domain.Trigger{domain.TriggerArrive}},
		{ID: "plc_grocery", Name: "Whole Foods", Tags: []string{"grocery"},
			Triggers: []domain.Trigger{domain.TriggerPassby, domain.TriggerArrive}},
		{ID: "plc_library", Name: "City Library", Tags: []string{"errands"},
			Triggers: []domain.Trigger{domain.TriggerPassby}},
		{ID: "plc_gym", Name: "Gym", Tags: []string{"health"},
			Triggers: []domain.Trigger{domain.TriggerDwell}},
		{ID: "plc_moms", Name: "Mom's", Tags: []string{"family"},
			Triggers: []domain.Trigger{domain.TriggerArrive}},
	}
}

func TestRulesSuggest(t *testing.T) {
	cases := []struct {
		name        string
		text        string
		wantPlace   string
		wantTrigger domain.Trigger
		wantTag     string
		minConf     float64
	}{
		{
			name:      "grocery items imply the grocery place and pass-by phrasing",
			text:      "buy oat milk & eggs when I pass the store",
			wantPlace: "plc_grocery", wantTrigger: domain.TriggerPassby, wantTag: "grocery", minConf: 0.4,
		},
		{
			name:      "explicit place name wins",
			text:      "call the landlord about the lease when I get home",
			wantPlace: "plc_home", wantTrigger: domain.TriggerArrive, wantTag: "admin", minConf: 0.6,
		},
		{
			name:      "library books",
			text:      "return the library books on the way",
			wantPlace: "plc_library", wantTrigger: domain.TriggerPassby, wantTag: "errands", minConf: 0.5,
		},
		{
			name:      "leaving phrasing",
			text:      "pick up the dry cleaning before I leave home",
			wantPlace: "plc_home", wantTrigger: domain.TriggerLeave, wantTag: "errands", minConf: 0.5,
		},
		{
			name:      "possessive place name",
			text:      "take the cake to mom's",
			wantPlace: "plc_moms", wantTrigger: domain.TriggerArrive, minConf: 0.4,
		},
		{
			name:      "workout implies the gym, whose only trigger is dwell",
			text:      "do the shoulder workout",
			wantPlace: "plc_gym", wantTrigger: domain.TriggerDwell, wantTag: "health", minConf: 0.3,
		},
	}

	engine := ai.NewRules()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := engine.Suggest(context.Background(), tc.text, demoPlaces())
			if err != nil {
				t.Fatalf("Suggest: %v", err)
			}
			if got.PlaceID != tc.wantPlace {
				t.Errorf("place = %q (%s), want %q", got.PlaceID, got.PlaceName, tc.wantPlace)
			}
			if got.Trigger != tc.wantTrigger {
				t.Errorf("trigger = %q, want %q", got.Trigger, tc.wantTrigger)
			}
			if tc.wantTag != "" && !hasTag(got.Tags, tc.wantTag) {
				t.Errorf("tags = %v, want to include %q", got.Tags, tc.wantTag)
			}
			if got.Confidence < tc.minConf {
				t.Errorf("confidence = %.2f, want >= %.2f", got.Confidence, tc.minConf)
			}
			if got.Confidence > 0.95 {
				t.Errorf("confidence = %.2f: the rules engine should never claim near-certainty", got.Confidence)
			}
			if got.Engine != "rules" || !got.OnDevice {
				t.Errorf("engine = %q, onDevice = %v; want rules, true", got.Engine, got.OnDevice)
			}
		})
	}
}

// A suggestion must never propose a trigger the place cannot fire, or the user
// would get a reminder that silently never arrives.
func TestSuggestedTriggerIsAlwaysArmable(t *testing.T) {
	engine := ai.NewRules()
	// "on the way" implies pass-by, but the Gym only has dwell armed.
	got, err := engine.Suggest(context.Background(), "gym bag on the way", []domain.Place{
		{ID: "plc_gym", Name: "Gym", Tags: []string{"health"}, Triggers: []domain.Trigger{domain.TriggerDwell}},
	})
	if err != nil {
		t.Fatalf("Suggest: %v", err)
	}
	if got.PlaceID != "plc_gym" {
		t.Fatalf("place = %q, want plc_gym", got.PlaceID)
	}
	if got.Trigger != domain.TriggerDwell {
		t.Errorf("trigger = %q, want dwell (the only one the place arms)", got.Trigger)
	}
}

// Text with no place signal still yields tags, at a confidence that says "do not
// trust this binding".
func TestSuggestWithoutPlaceMatch(t *testing.T) {
	engine := ai.NewRules()
	got, err := engine.Suggest(context.Background(), "think about the thing", demoPlaces())
	if err != nil {
		t.Fatalf("Suggest: %v", err)
	}
	if got.PlaceID != "" {
		t.Errorf("place = %q, want no binding", got.PlaceID)
	}
	if got.Trigger != domain.TriggerArrive {
		t.Errorf("trigger = %q, want the arrive default", got.Trigger)
	}
	if got.Confidence > 0.6 {
		t.Errorf("confidence = %.2f, want low for an unbound note", got.Confidence)
	}
}

func TestSuggestEmptyTextIsInvalid(t *testing.T) {
	if _, err := ai.NewRules().Suggest(context.Background(), "   ", demoPlaces()); !errors.Is(err, domain.ErrInvalid) {
		t.Errorf("error = %v, want ErrInvalid", err)
	}
}

// The same text must always produce the same suggestion: a flickering suggestion
// is worse than a mediocre one.
func TestSuggestIsDeterministic(t *testing.T) {
	engine := ai.NewRules()
	first, err := engine.Suggest(context.Background(), "buy milk", demoPlaces())
	if err != nil {
		t.Fatalf("Suggest: %v", err)
	}
	for i := 0; i < 20; i++ {
		again, err := engine.Suggest(context.Background(), "buy milk", demoPlaces())
		if err != nil {
			t.Fatalf("Suggest: %v", err)
		}
		if again.PlaceID != first.PlaceID || again.Confidence != first.Confidence {
			t.Fatalf("suggestion is not deterministic: %+v vs %+v", first, again)
		}
	}
}

// The sidecar is used when it answers…
func TestSidecarUsedWhenAvailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/suggest" {
			t.Errorf("sidecar path = %q, want /suggest", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tags":["errands"],"suggested_place_id":"plc_library","trigger":"passby","confidence":0.92}`))
	}))
	defer srv.Close()

	got, err := ai.NewSidecar(srv.URL, time.Second, ai.NewRules()).
		Suggest(context.Background(), "return books", demoPlaces())
	if err != nil {
		t.Fatalf("Suggest: %v", err)
	}
	if got.Engine != "minilm" {
		t.Errorf("engine = %q, want minilm", got.Engine)
	}
	if got.PlaceID != "plc_library" || got.PlaceName != "City Library" {
		t.Errorf("place = %q/%q, want plc_library/City Library", got.PlaceID, got.PlaceName)
	}
	if got.Confidence != 0.92 {
		t.Errorf("confidence = %v, want 0.92", got.Confidence)
	}
}

// …and a broken sidecar degrades to local rules rather than failing the request
// (HLD §10: "AI Brain down → note create still succeeds").
func TestSidecarFallsBackToRules(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"server error": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) },
		"garbage body": func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("not json")) },
	}
	for name, handler := range cases {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(handler)
			defer srv.Close()

			got, err := ai.NewSidecar(srv.URL, time.Second, ai.NewRules()).
				Suggest(context.Background(), "buy oat milk when I pass the store", demoPlaces())
			if err != nil {
				t.Fatalf("Suggest returned an error instead of degrading: %v", err)
			}
			if got.Engine != "rules" {
				t.Errorf("engine = %q, want the rules fallback", got.Engine)
			}
			if got.PlaceID != "plc_grocery" {
				t.Errorf("fallback place = %q, want plc_grocery", got.PlaceID)
			}
		})
	}

	// An unreachable host must behave the same way.
	got, err := ai.NewSidecar("http://127.0.0.1:1", 200*time.Millisecond, ai.NewRules()).
		Suggest(context.Background(), "buy milk", demoPlaces())
	if err != nil {
		t.Fatalf("Suggest against a dead sidecar: %v", err)
	}
	if got.Engine != "rules" {
		t.Errorf("engine = %q, want the rules fallback", got.Engine)
	}
}

// A sidecar returning a trigger Lura does not know must not poison a note.
func TestSidecarInvalidTriggerIsNormalised(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"tags":["x"],"suggested_place_id":"plc_home","trigger":"teleport","confidence":0.8}`))
	}))
	defer srv.Close()

	got, err := ai.NewSidecar(srv.URL, time.Second, ai.NewRules()).
		Suggest(context.Background(), "anything", demoPlaces())
	if err != nil {
		t.Fatalf("Suggest: %v", err)
	}
	if got.Trigger != domain.TriggerArrive {
		t.Errorf("trigger = %q, want the arrive default", got.Trigger)
	}
}

func hasTag(tags []string, want string) bool {
	for _, t := range tags {
		if t == want {
			return true
		}
	}
	return false
}
