package space

import (
	"strings"
	"testing"
	"time"
)

func fptr(v float64) *float64 { return &v }

func TestParseFormSchema_RichTypes(t *testing.T) {
	tmpl := `# Survey
Mood: ______ [smiley]
Stars: ______ [rating: 10]
Volume: ______ [slider: 0, 100, 5]
Color: ______ [buttons: red, green, blue]
Tags: ______ [multiselect: a, b, c]
Photos: ______ [image]
`
	s := ParseFormSchema(tmpl)
	if len(s.Fields) != 6 {
		t.Fatalf("want 6 fields, got %d: %+v", len(s.Fields), s.Fields)
	}
	if s.Fields[0].Type != FieldSmiley || s.Fields[0].Levels != 5 {
		t.Errorf("smiley = %+v", s.Fields[0])
	}
	if s.Fields[1].Type != FieldRating || s.Fields[1].Levels != 10 {
		t.Errorf("rating = %+v", s.Fields[1])
	}
	sl := s.Fields[2]
	if sl.Type != FieldSlider || sl.Min == nil || *sl.Min != 0 || sl.Max == nil || *sl.Max != 100 || sl.Step == nil || *sl.Step != 5 {
		t.Errorf("slider = %+v (min/max/step)", sl)
	}
	if s.Fields[3].Type != FieldButtons || len(s.Fields[3].Options) != 3 {
		t.Errorf("buttons = %+v", s.Fields[3])
	}
	if s.Fields[4].Type != FieldMulti || len(s.Fields[4].Options) != 3 {
		t.Errorf("multi = %+v", s.Fields[4])
	}
	if s.Fields[5].Type != FieldImage {
		t.Errorf("image = %+v", s.Fields[5])
	}
}

func TestValidateFormValues_RichTypes(t *testing.T) {
	schema := FormSchema{Fields: []FormField{
		{Key: "mood", Label: "Mood", Type: FieldSmiley, Levels: 5},
		{Key: "stars", Label: "Stars", Type: FieldRating, Levels: 10},
		{Key: "vol", Label: "Vol", Type: FieldSlider, Min: fptr(0), Max: fptr(100)},
		{Key: "color", Label: "Color", Type: FieldButtons, Options: []string{"Red", "Green"}},
		{Key: "tags", Label: "Tags", Type: FieldMulti, Options: []string{"a", "b", "c"}},
		{Key: "photos", Label: "Photos", Type: FieldImage},
	}}

	out, err := validateFormValues(schema, map[string]any{
		"mood":   "7",                // clamps to 5
		"stars":  "8",                // ok
		"vol":    "250",              // clamps to 100
		"color":  "red",              // canonicalises to declared "Red"
		"tags":   []any{"a", "B"},    // "b" not in options
		"photos": []any{"p.jpg", ""}, // empties dropped
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out["mood"] != int64(5) {
		t.Errorf("mood = %v (%T), want 5", out["mood"], out["mood"])
	}
	if out["vol"] != int64(100) {
		t.Errorf("vol = %v (%T), want 100", out["vol"], out["vol"])
	}
	if out["color"] != "Red" {
		t.Errorf("color = %v, want Red", out["color"])
	}
	if tags, ok := out["tags"].([]string); !ok || len(tags) != 2 || tags[1] != "b" {
		t.Errorf("tags = %v (%T)", out["tags"], out["tags"])
	}
	if ph, ok := out["photos"].([]string); !ok || len(ph) != 1 || ph[0] != "p.jpg" {
		t.Errorf("photos = %v (%T)", out["photos"], out["photos"])
	}

	// A non-numeric rating is rejected.
	if _, err := validateFormValues(schema, map[string]any{"stars": "abc"}); err == nil {
		t.Error("expected rating error")
	}
	// A multi value outside the option set is rejected.
	if _, err := validateFormValues(schema, map[string]any{"tags": []any{"z"}}); err == nil {
		t.Error("expected multiselect option error")
	}
}

func TestFormEntry_EditDeleteAndImages(t *testing.T) {
	st := NewStore(t.TempDir())
	if _, err := st.Create("s", "S", "admin"); err != nil {
		t.Fatalf("create: %v", err)
	}
	tmpl := "# Log\nName: ______ [string] (required)\nMood: ______ [smiley]\nPhoto: ______ [image]\n"
	if _, err := st.WriteFile("s", "log/_form.md", strings.NewReader(tmpl), 1<<20); err != nil {
		t.Fatalf("write template: %v", err)
	}
	schema, _ := st.FormSchema("s", "log")

	img, err := st.SaveFormImage("s", "log", []byte("not-really-png-but-bytes"), "png", 1<<20)
	if err != nil {
		t.Fatalf("SaveFormImage: %v", err)
	}
	if !strings.HasPrefix(img, "log/_att/") || !strings.HasSuffix(img, ".png") {
		t.Fatalf("image path = %q", img)
	}

	t0 := time.Date(2026, 6, 2, 9, 0, 0, 0, time.UTC)
	// Create referencing the uploaded image + an out-of-folder path that must be dropped.
	e, err := st.CreateFormEntry("s", "log", schema, map[string]any{
		"name": "Alice", "mood": "4", "photo": []any{img, "../escape.png"},
	}, t0, 1<<20)
	if err != nil {
		t.Fatalf("create entry: %v", err)
	}
	if ph, _ := e.Values["photo"].([]string); len(ph) != 1 || ph[0] != img {
		t.Fatalf("photo not sanitised: %v", e.Values["photo"])
	}

	// Update: change a value and drop the photo → the image file is cleaned up.
	e2, err := st.UpdateFormEntry("s", "log", e.ID, schema, map[string]any{"name": "Bob", "mood": "2"}, time.Now(), 1<<20)
	if err != nil {
		t.Fatalf("update entry: %v", err)
	}
	if e2.ID != e.ID {
		t.Errorf("update changed id: %q -> %q", e.ID, e2.ID)
	}
	if !e2.CreatedAt.Equal(t0) {
		t.Errorf("created_at not preserved: %v", e2.CreatedAt)
	}
	if e2.Title != "Bob" {
		t.Errorf("title = %q", e2.Title)
	}
	if _, err := st.Stat("s", img); err == nil {
		t.Error("removed image should have been deleted on update")
	}

	// Reading the entry back reflects the update.
	got, err := st.GetFormEntry("s", "log", e.ID, schema)
	if err != nil {
		t.Fatalf("get entry: %v", err)
	}
	if got.Values["name"] != "Bob" {
		t.Errorf("name = %v", got.Values["name"])
	}

	// A path-trick entry id is rejected.
	if _, _, err := st.resolveFormEntry("s", "log", "../_form"); err == nil {
		t.Error("expected rejection of traversal entry id")
	}

	// Delete removes the entry file.
	if err := st.DeleteFormEntry("s", "log", e.ID, schema); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := st.Stat("s", e.Path); err == nil {
		t.Error("entry file should be gone after delete")
	}
}
