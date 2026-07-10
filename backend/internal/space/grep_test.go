package space

import (
	"os"
	"strings"
	"testing"
)

func TestGrep_RejectsOverlongPattern(t *testing.T) {
	st := NewStore(t.TempDir())
	_, err := st.Grep("anyspace", GrepOpts{Pattern: strings.Repeat("a", maxPatternLen+1)})
	if err == nil {
		t.Fatal("expected an error for an over-long pattern, got nil")
	}
	if !strings.Contains(err.Error(), "too long") {
		t.Errorf("expected 'too long' error, got %v", err)
	}
}

// PathPrefix is an access boundary: hits outside the prefix must not appear,
// and the prefix must be segment-aware (no "notes" → "notes2" bleed).
func TestGrep_PathPrefix(t *testing.T) {
	dir := t.TempDir()
	st := NewStore(dir)
	// The files root must exist before SafeJoin resolves paths (in the app,
	// space creation guarantees this).
	if err := os.MkdirAll(st.FilesDir("sp"), 0o750); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"readme.md":       "needle at root",
		"notes/a.md":      "needle in notes",
		"notes/deep/b.md": "needle deep in notes",
		"notes2/decoy.md": "needle in notes2",
		"other/c.md":      "needle elsewhere",
	}
	for p, body := range files {
		if err := writeTestFile(t, st, "sp", p, body); err != nil {
			t.Fatal(err)
		}
	}

	hits, err := st.Grep("sp", GrepOpts{Pattern: "needle", PathPrefix: "notes"})
	if err != nil {
		t.Fatalf("Grep: %v", err)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.Path] = true
	}
	if len(hits) != 2 || !got["notes/a.md"] || !got["notes/deep/b.md"] {
		t.Errorf("prefix 'notes' should match exactly its subtree, got %v", got)
	}

	hits, err = st.Grep("sp", GrepOpts{Pattern: "needle", PathPrefix: "notes/deep/b.md"})
	if err != nil {
		t.Fatalf("Grep: %v", err)
	}
	if len(hits) != 1 || hits[0].Path != "notes/deep/b.md" {
		t.Errorf("file prefix should match only that file, got %+v", hits)
	}
}

func writeTestFile(t *testing.T, st *Store, spaceID, rel, body string) error {
	t.Helper()
	_, err := st.WriteFile(spaceID, rel, strings.NewReader(body), 1<<20)
	return err
}

func TestGlob_RejectsOverlongPattern(t *testing.T) {
	st := NewStore(t.TempDir())
	_, err := st.Glob("anyspace", strings.Repeat("*", maxPatternLen+1), 100)
	if err == nil {
		t.Fatal("expected an error for an over-long glob, got nil")
	}
}
