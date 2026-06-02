package space

import (
	"strings"
	"testing"
)

func TestMap(t *testing.T) {
	st := NewStore(t.TempDir())
	if _, err := st.Create("docs", "Docs", "admin"); err != nil {
		t.Fatalf("Create space: %v", err)
	}

	write := func(path, body string) {
		t.Helper()
		if _, err := st.WriteFile("docs", path, strings.NewReader(body), 1<<20); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	write("intro.md", "# Intro\nsome text\n## Background\n")
	write("notes/today.md", "# Today\n```\n# not a heading\n```\n### Deep\n")
	write("notes/raw.txt", "# ignored, not markdown\n")
	// A form folder — its template + entries must be collapsed (absent from the map).
	write("survey/_form.md", "# Survey\nName: ___ [string]\n")
	write("survey/entry1.md", "---\nnotation_entry: true\n---\n# leaked?\n")

	got, err := st.Map("docs", "", 6)
	if err != nil {
		t.Fatalf("Map: %v", err)
	}

	byPath := map[string][]Heading{}
	for _, fm := range got {
		byPath[fm.Path] = fm.Headings
	}

	if _, ok := byPath["notes/raw.txt"]; ok {
		t.Error("non-markdown file should not appear in the map")
	}
	if _, ok := byPath["survey/_form.md"]; ok {
		t.Error("form template should be collapsed out of the map")
	}
	if _, ok := byPath["survey/entry1.md"]; ok {
		t.Error("form entry should be collapsed out of the map")
	}

	intro := byPath["intro.md"]
	if len(intro) != 2 || intro[0].Text != "Intro" || intro[1].Text != "Background" {
		t.Errorf("intro.md headings = %+v", intro)
	}

	today := byPath["notes/today.md"]
	// The `# not a heading` line sits inside a fenced block and must be skipped.
	if len(today) != 2 || today[0].Text != "Today" || today[1].Level != 3 {
		t.Errorf("notes/today.md headings = %+v", today)
	}

	// max_depth must drop headings deeper than the cap.
	shallow, err := st.Map("docs", "", 2)
	if err != nil {
		t.Fatalf("Map depth: %v", err)
	}
	for _, fm := range shallow {
		for _, h := range fm.Headings {
			if h.Level > 2 {
				t.Errorf("%s: heading past max_depth: %+v", fm.Path, h)
			}
		}
	}

	// directory scope must restrict the map to that subtree.
	scoped, err := st.Map("docs", "notes/", 6)
	if err != nil {
		t.Fatalf("Map scoped: %v", err)
	}
	for _, fm := range scoped {
		if !strings.HasPrefix(fm.Path, "notes/") {
			t.Errorf("scoped map leaked %s", fm.Path)
		}
	}
	if len(scoped) != 1 {
		t.Errorf("scoped map = %d files, want 1", len(scoped))
	}
}
