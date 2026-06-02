package space

import "testing"

func TestParseFormSchema_InlineBlanks(t *testing.T) {
	tmpl := `# Patient intake

Name: ______ [string] (required)
Birthdate: ______ [date]
Weight: ______ [number] kg
Smoker?  [bool]
Risk: ______ [select: low, med, high]

Notes:
______ [text]
`
	s := ParseFormSchema(tmpl)
	if s.Title != "Patient intake" {
		t.Errorf("title = %q", s.Title)
	}
	if len(s.Fields) != 6 {
		t.Fatalf("want 6 fields, got %d: %+v", len(s.Fields), s.Fields)
	}
	want := []struct {
		key  string
		typ  FieldType
		req  bool
		opts int
	}{
		{"name", FieldString, true, 0},
		{"birthdate", FieldDate, false, 0},
		{"weight", FieldNumber, false, 0},
		{"smoker", FieldBool, false, 0},
		{"risk", FieldSelect, false, 3},
		{"notes", FieldText, false, 0},
	}
	for i, w := range want {
		f := s.Fields[i]
		if f.Key != w.key || f.Type != w.typ || f.Required != w.req || len(f.Options) != w.opts {
			t.Errorf("field %d = %+v, want key=%s type=%s req=%v opts=%d", i, f, w.key, w.typ, w.req, w.opts)
		}
	}
	if s.Fields[4].Options[2] != "high" {
		t.Errorf("select options = %v", s.Fields[4].Options)
	}
	if s.TitleField != "name" {
		t.Errorf("title field = %q", s.TitleField)
	}
}

func TestValidateFormValues(t *testing.T) {
	schema := FormSchema{Fields: []FormField{
		{Key: "name", Label: "Name", Type: FieldString, Required: true},
		{Key: "age", Label: "Age", Type: FieldInteger},
		{Key: "risk", Label: "Risk", Type: FieldSelect, Options: []string{"low", "high"}},
	}}

	// Required field missing → error.
	if _, err := validateFormValues(schema, map[string]any{"age": "5"}); err == nil {
		t.Error("expected required-field error")
	}
	// Bad integer → error.
	if _, err := validateFormValues(schema, map[string]any{"name": "x", "age": "abc"}); err == nil {
		t.Error("expected integer error")
	}
	// Disallowed select option → error.
	if _, err := validateFormValues(schema, map[string]any{"name": "x", "risk": "extreme"}); err == nil {
		t.Error("expected select error")
	}
	// Valid + only declared keys survive (injected key dropped).
	out, err := validateFormValues(schema, map[string]any{"name": "Max", "age": "42", "risk": "low", "evil": "../etc"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out["age"] != int64(42) {
		t.Errorf("age = %v (%T)", out["age"], out["age"])
	}
	if _, leaked := out["evil"]; leaked {
		t.Error("undeclared key leaked into entry values")
	}
}

// A template with no recognised fields must yield a non-nil empty slice, not a
// nil slice — nil marshals to JSON `null`, which the client iterates and crashes.
func TestParseFormSchema_EmptyIsNonNil(t *testing.T) {
	s := ParseFormSchema("# Heading only\n\nNo fields here at all.\n")
	if s.Fields == nil {
		t.Fatal("Fields must be non-nil for an empty template")
	}
	if len(s.Fields) != 0 {
		t.Errorf("want 0 fields, got %d", len(s.Fields))
	}
}
