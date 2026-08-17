// Package ai binds free-text notes to places, tags and triggers.
//
// HLD §5.7 defines the contract — POST /suggest {text} → {tags[], place, trigger,
// confidence} — and gives it two implementations: a Python sidecar embedding text
// with paraphrase-multilingual-MiniLM-L12-v2 (Phase 2), and a Go keyword map with
// the same signature (Phase 1). This package is the Go side plus the client for
// the sidecar, with the sidecar falling back to the rules engine when it is
// unreachable, because HLD §10 requires note creation to succeed even when the AI
// Brain is down: the suggestion is an assist, never a dependency.
//
// The privacy invariant (§11) is enforced structurally: the rules engine is pure
// local computation, and the sidecar is only ever consulted when it is configured
// *and* airgap mode is off. Note text never reaches a third party by default
// because there is no code path that would send it to one.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/HarshSingh21/locnot/internal/domain"
)

// Suggester turns note text into a suggestion.
type Suggester interface {
	Suggest(ctx context.Context, text string, places []domain.Place) (domain.Suggestion, error)
}

// tagRule maps intent keywords onto a tag.
type tagRule struct {
	Tag      string
	Keywords []string
}

// tagRules is deliberately explicit rather than clever. It is a Phase 1
// stand-in for embeddings, and an operator can read it and predict exactly what
// the product will do — which is worth more at this stage than recall.
var tagRules = []tagRule{
	{"grocery", []string{"milk", "oat milk", "eggs", "bread", "groceries", "grocery", "supermarket", "vegetables", "veggies", "fruit", "rice", "coffee beans", "sugar", "flour", "shopping list"}},
	{"health", []string{"pharmacy", "chemist", "medicine", "prescription", "vitamins", "doctor", "dentist", "gym", "workout", "yoga", "run", "physio"}},
	{"errands", []string{"library", "books", "return", "dry cleaning", "laundry", "post office", "parcel", "package", "courier", "pickup", "pick up", "drop off", "hardware", "repair"}},
	{"admin", []string{"landlord", "lease", "rent", "bank", "insurance", "invoice", "tax", "passport", "licence", "license", "renew", "bill", "bills", "appointment"}},
	{"home", []string{"plants", "water the plants", "trash", "bins", "rubbish", "recycling", "laundry basket", "dishwasher", "filter", "lightbulb", "bulb"}},
	{"family", []string{"mom", "mum", "dad", "parents", "grandma", "grandpa", "sister", "brother", "kids", "school pickup"}},
	{"work", []string{"office", "standup", "meeting", "deck", "report", "colleague", "desk", "badge", "laptop charger"}},
	{"car", []string{"petrol", "gas", "fuel", "charge the car", "ev charge", "tyres", "tires", "oil change", "car wash", "parking"}},
	{"food", []string{"lunch", "dinner", "takeaway", "takeout", "restaurant", "cafe", "coffee", "bakery"}},
	{"money", []string{"cash", "atm", "withdraw", "deposit", "cheque", "check"}},
}

// triggerRule maps phrasing onto a trigger.
//
// Ordering matters: "on the way" must beat the bare "at", so the longer, more
// specific phrases come first.
var triggerRules = []struct {
	Trigger domain.Trigger
	Phrases []string
}{
	{domain.TriggerPassby, []string{"pass by", "passing by", "pass the", "on the way", "on my way", "drive by", "driving past", "next time i pass", "when i pass", "if i pass", "en route"}},
	{domain.TriggerLeave, []string{"before i leave", "when i leave", "on leaving", "as i leave", "on my way out", "leaving"}},
	{domain.TriggerDwell, []string{"while i am at", "while i'm at", "once i settle", "after arriving", "stay at", "while at", "spend time"}},
	{domain.TriggerArrive, []string{"when i arrive", "when i get to", "when i reach", "once i get", "on arrival", "when i'm at", "when i am at", "at home", "at the office", "reach"}},
}

// stopwords are ignored when matching place names, so "buy milk at the store"
// does not match a place called "The".
var stopwords = map[string]bool{
	"a": true, "an": true, "the": true, "at": true, "to": true, "in": true, "on": true,
	"for": true, "of": true, "and": true, "or": true, "my": true, "me": true, "i": true,
	"when": true, "while": true, "before": true, "after": true, "some": true, "get": true,
	"buy": true, "pick": true, "up": true, "from": true, "with": true, "this": true,
	"that": true, "it": true, "is": true, "am": true, "next": true, "time": true,
}

// Rules is the Phase 1 suggester: pure local text matching, no model, no network.
type Rules struct{}

// NewRules returns the keyword-based suggester.
func NewRules() *Rules { return &Rules{} }

// Suggest implements Suggester.
func (r *Rules) Suggest(_ context.Context, text string, places []domain.Place) (domain.Suggestion, error) {
	clean := strings.ToLower(strings.TrimSpace(text))
	if clean == "" {
		return domain.Suggestion{}, fmt.Errorf("suggest: empty text: %w", domain.ErrInvalid)
	}
	tokens := tokenize(clean)
	tokenSet := make(map[string]bool, len(tokens))
	for _, t := range tokens {
		tokenSet[t] = true
	}

	tags, tagScore := inferTags(clean, tokenSet)
	trigger, triggerMatched := inferTrigger(clean)
	place, placeScore, runnerUp := matchPlace(clean, tokenSet, tags, places)

	sug := domain.Suggestion{
		Text:     text,
		Tags:     tags,
		Trigger:  trigger,
		Engine:   "rules",
		OnDevice: true,
	}
	if place != nil {
		sug.PlaceID = place.ID
		sug.PlaceName = place.Name
		// A place's own triggers constrain what we can promise: suggesting
		// "pass-by" for a place that only has arrive armed would be a lie.
		if !placeSupports(*place, trigger) {
			if len(place.Triggers) > 0 {
				sug.Trigger = place.Triggers[0]
			}
		}
	}
	sug.Confidence = confidence(placeScore, runnerUp, tagScore, triggerMatched, place != nil)
	return sug, nil
}

// Sidecar is the client for the Phase 2 AI Brain (FastAPI + MiniLM ONNX).
type Sidecar struct {
	URL      string
	Client   *http.Client
	Fallback Suggester
}

// NewSidecar returns a sidecar-backed suggester that degrades to fallback.
func NewSidecar(url string, timeout time.Duration, fallback Suggester) *Sidecar {
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if fallback == nil {
		fallback = NewRules()
	}
	return &Sidecar{
		URL:      strings.TrimRight(url, "/"),
		Client:   &http.Client{Timeout: timeout},
		Fallback: fallback,
	}
}

type sidecarRequest struct {
	Text   string         `json:"text"`
	Places []sidecarPlace `json:"places"`
}

type sidecarPlace struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Tags      []string `json:"tags"`
	UpdatedAt string   `json:"updated_at"` // part of the embedding cache key (HLD §5.7)
}

type sidecarResponse struct {
	Tags       []string `json:"tags"`
	PlaceID    string   `json:"suggested_place_id"`
	Trigger    string   `json:"trigger"`
	Confidence float64  `json:"confidence"`
}

// Suggest implements Suggester, falling back to local rules on any failure.
func (s *Sidecar) Suggest(ctx context.Context, text string, places []domain.Place) (domain.Suggestion, error) {
	if s.URL == "" {
		return s.Fallback.Suggest(ctx, text, places)
	}

	payload := sidecarRequest{Text: text}
	for _, p := range places {
		payload.Places = append(payload.Places, sidecarPlace{
			ID: p.ID, Name: p.Name, Tags: p.Tags,
			UpdatedAt: p.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return s.Fallback.Suggest(ctx, text, places)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.URL+"/suggest", bytes.NewReader(body))
	if err != nil {
		return s.Fallback.Suggest(ctx, text, places)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.Client.Do(req)
	if err != nil {
		return s.Fallback.Suggest(ctx, text, places)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	if resp.StatusCode >= 300 {
		return s.Fallback.Suggest(ctx, text, places)
	}

	var out sidecarResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return s.Fallback.Suggest(ctx, text, places)
	}

	sug := domain.Suggestion{
		Text:       text,
		Tags:       domain.NormalizeTags(out.Tags),
		PlaceID:    out.PlaceID,
		Trigger:    domain.Trigger(out.Trigger),
		Confidence: out.Confidence,
		Engine:     "minilm",
		OnDevice:   true, // the sidecar runs on the operator's own infrastructure
	}
	if !domain.ValidTrigger(sug.Trigger) {
		sug.Trigger = domain.TriggerArrive
	}
	for _, p := range places {
		if p.ID == sug.PlaceID {
			sug.PlaceName = p.Name
			break
		}
	}
	return sug, nil
}

// ---------------------------------------------------------------- internals

func inferTags(clean string, tokens map[string]bool) ([]string, float64) {
	type hit struct {
		tag   string
		score float64
	}
	var hits []hit
	for _, rule := range tagRules {
		var score float64
		for _, kw := range rule.Keywords {
			if strings.Contains(kw, " ") {
				if strings.Contains(clean, kw) {
					score += 2 // a phrase match is stronger evidence than a word
				}
				continue
			}
			if tokens[kw] {
				score++
			}
		}
		if score > 0 {
			hits = append(hits, hit{rule.Tag, score})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score > hits[j].score })

	tags := make([]string, 0, len(hits))
	var total float64
	for i, h := range hits {
		if i >= 3 {
			break // three tags is as much as the UI shows, and as much as is useful
		}
		tags = append(tags, h.tag)
		total += h.score
	}
	return tags, total
}

func inferTrigger(clean string) (domain.Trigger, bool) {
	for _, rule := range triggerRules {
		for _, phrase := range rule.Phrases {
			if strings.Contains(clean, phrase) {
				return rule.Trigger, true
			}
		}
	}
	// Arrive is the safe default: it is the trigger users expect from "remind me
	// at X", and the least likely to fire at the wrong moment.
	return domain.TriggerArrive, false
}

func matchPlace(clean string, tokens map[string]bool, tags []string, places []domain.Place) (*domain.Place, float64, float64) {
	tagSet := make(map[string]bool, len(tags))
	for _, t := range tags {
		tagSet[t] = true
	}

	type scored struct {
		place domain.Place
		score float64
	}
	var all []scored
	for _, p := range places {
		var score float64
		name := strings.ToLower(p.Name)

		// Whole name appearing in the text is the strongest signal.
		if name != "" && strings.Contains(clean, name) {
			score += 4
		}
		for _, tok := range tokenize(name) {
			if stopwords[tok] {
				continue
			}
			if tokens[tok] {
				score += 2.5
			}
		}
		for _, tag := range p.Tags {
			tag = strings.ToLower(tag)
			if tagSet[tag] {
				score += 2 // "buy milk" → grocery → the place tagged grocery
			}
			if tokens[tag] {
				score += 1.5
			}
		}
		if score > 0 {
			all = append(all, scored{p, score})
		}
	}
	if len(all) == 0 {
		return nil, 0, 0
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].score == all[j].score {
			// Deterministic tie-break, so the same note always suggests the same
			// place instead of flickering between two equal candidates.
			return all[i].place.Name < all[j].place.Name
		}
		return all[i].score > all[j].score
	})
	best := all[0]
	var runnerUp float64
	if len(all) > 1 {
		runnerUp = all[1].score
	}
	return &best.place, best.score, runnerUp
}

// confidence turns match scores into the percentage the UI shows.
//
// It is intentionally humble: a strong, unambiguous place match tops out around
// 0.95, and an ambiguous one is pulled down by how close the runner-up was. The
// number exists to tell the user whether to trust the suggestion, so overstating
// it is worse than understating it.
func confidence(placeScore, runnerUp, tagScore float64, triggerMatched, havePlace bool) float64 {
	if !havePlace {
		// Tags only: useful, but we could not bind it to a place.
		c := 0.25 + 0.08*tagScore
		if triggerMatched {
			c += 0.05
		}
		return clamp(c, 0, 0.6)
	}
	base := placeScore / (placeScore + 2.5) // 4 → 0.62, 8 → 0.76, 12 → 0.83
	if runnerUp > 0 {
		margin := (placeScore - runnerUp) / placeScore
		base *= 0.7 + 0.3*clamp(margin, 0, 1)
	}
	if tagScore > 0 {
		base += 0.08
	}
	if triggerMatched {
		base += 0.06
	}
	return clamp(base, 0.2, 0.95)
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func placeSupports(p domain.Place, t domain.Trigger) bool {
	if len(p.Triggers) == 0 {
		return true
	}
	for _, have := range p.Triggers {
		if have == t {
			return true
		}
	}
	return false
}

// tokenize splits text into lowercase word tokens, treating apostrophes as part
// of a word ("mom's" stays one token, matching a place called "Mom's").
func tokenize(s string) []string {
	var out []string
	var b strings.Builder
	flush := func() {
		if b.Len() > 0 {
			out = append(out, strings.Trim(b.String(), "'"))
			b.Reset()
		}
	}
	for _, r := range strings.ToLower(s) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '\'':
			b.WriteRune(r)
		default:
			flush()
		}
	}
	flush()
	return out
}

var (
	_ Suggester = (*Rules)(nil)
	_ Suggester = (*Sidecar)(nil)
)
