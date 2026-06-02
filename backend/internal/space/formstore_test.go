package space

import (
	"strings"
	"testing"
	"time"
)

func TestFormRoundTrip(t *testing.T) {
	st := NewStore(t.TempDir())
	if _, err := st.Create("clinic", "Clinic", "admin"); err != nil {
		t.Fatalf("Create space: %v", err)
	}
	tmpl := "# Patient intake\n\nName: ______ [string] (required)\nAge: ______ [integer]\nRisk: ______ [select: low, high]\n"
	if _, err := st.WriteFile("clinic", "patients/_form.md", strings.NewReader(tmpl), 1<<20); err != nil {
		t.Fatalf("write template: %v", err)
	}

	if !st.IsFormFolder("clinic", "patients") {
		t.Fatal("IsFormFolder = false, want true")
	}
	schema, err := st.FormSchema("clinic", "patients")
	if err != nil {
		t.Fatalf("FormSchema: %v", err)
	}
	if len(schema.Fields) != 3 || schema.TitleField != "name" {
		t.Fatalf("schema = %+v", schema)
	}

	// Create an entry; an undeclared key must be dropped, a bad-typed value rejected.
	t0 := time.Date(2026, 6, 2, 14, 30, 15, 0, time.UTC)
	entry, err := st.CreateFormEntry("clinic", "patients", schema,
		map[string]any{"name": "Max Mustermann", "age": "42", "risk": "low", "evil": "../x"}, t0, 1<<20)
	if err != nil {
		t.Fatalf("CreateFormEntry: %v", err)
	}
	if entry.Title != "Max Mustermann" {
		t.Errorf("title = %q", entry.Title)
	}
	if entry.Values["age"] != int64(42) {
		t.Errorf("age = %v (%T)", entry.Values["age"], entry.Values["age"])
	}
	if _, leaked := entry.Values["evil"]; leaked {
		t.Error("undeclared key leaked")
	}
	if !strings.HasPrefix(entry.ID, "2026-06-02_143015") {
		t.Errorf("entry id = %q, want datetime prefix", entry.ID)
	}

	// Bad integer is rejected.
	if _, err := st.CreateFormEntry("clinic", "patients", schema, map[string]any{"name": "x", "age": "abc"}, t0, 1<<20); err == nil {
		t.Error("expected integer validation error")
	}
	// Missing required field is rejected.
	if _, err := st.CreateFormEntry("clinic", "patients", schema, map[string]any{"age": "1"}, t0, 1<<20); err == nil {
		t.Error("expected required-field error")
	}

	// List reflects the one valid entry, with the derived title.
	entries, err := st.ListFormEntries("clinic", "patients", schema)
	if err != nil {
		t.Fatalf("ListFormEntries: %v", err)
	}
	if len(entries) != 1 || entries[0].Title != "Max Mustermann" {
		t.Fatalf("entries = %+v", entries)
	}

	// The tree marks the folder as a form, hides its files, and counts entries.
	tree, err := st.Tree("clinic")
	if err != nil {
		t.Fatalf("Tree: %v", err)
	}
	var patients *Entry
	for i := range tree {
		if tree[i].Name == "patients" {
			patients = &tree[i]
		}
	}
	if patients == nil || !patients.Form {
		t.Fatalf("patients folder not marked as form: %+v", tree)
	}
	if patients.Entries != 1 {
		t.Errorf("entry count = %d, want 1", patients.Entries)
	}
	if len(patients.Children) != 0 {
		t.Errorf("form folder children should be hidden, got %d", len(patients.Children))
	}
}
