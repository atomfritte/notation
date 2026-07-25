package space

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// A folder that only LOOKS empty (the tree hides dotfiles) must survive, or
// pruning after a sync push would destroy real content.
func TestPruneEmptyDirs(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	if _, err := store.Create("alpha", "Alpha", "tester"); err != nil {
		t.Fatalf("create: %v", err)
	}
	files := store.FilesDir("alpha")

	mk := func(p string) {
		if err := os.MkdirAll(filepath.Join(files, filepath.FromSlash(p)), 0o750); err != nil {
			t.Fatalf("mkdir %s: %v", p, err)
		}
	}
	write := func(p, body string) {
		full := filepath.Join(files, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
			t.Fatalf("mkdir for %s: %v", p, err)
		}
		if err := os.WriteFile(full, []byte(body), 0o640); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}

	write("keep/note.md", "content")
	mk("gone")                        // plain empty
	mk("nested/deep/deeper")          // empty chain — must collapse entirely
	write("hidden-only/.env", "shh")  // LOOKS empty in the tree; holds a real file
	write("mixed/sub/note.md", "x")   // parent kept because a descendant has content
	mk("mixed/emptysub")              // …but this one goes

	removed, err := store.PruneEmptyDirs("alpha")
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	sort.Strings(removed)
	want := []string{"gone", "mixed/emptysub", "nested", "nested/deep", "nested/deep/deeper"}
	if strings.Join(removed, ",") != strings.Join(want, ",") {
		t.Fatalf("removed = %v, want %v", removed, want)
	}

	mustExist := []string{"keep", "keep/note.md", "hidden-only", "hidden-only/.env", "mixed", "mixed/sub/note.md"}
	for _, p := range mustExist {
		if _, err := os.Stat(filepath.Join(files, filepath.FromSlash(p))); err != nil {
			t.Errorf("%s should have survived: %v", p, err)
		}
	}
	for _, p := range want {
		if _, err := os.Stat(filepath.Join(files, filepath.FromSlash(p))); !os.IsNotExist(err) {
			t.Errorf("%s should be gone (err=%v)", p, err)
		}
	}

	// Idempotent: a second run finds nothing left to do.
	again, err := store.PruneEmptyDirs("alpha")
	if err != nil || len(again) != 0 {
		t.Fatalf("second prune = %v, %v; want empty", again, err)
	}
}

func TestPruneEmptyDirs_RejectsInvalidID(t *testing.T) {
	store := NewStore(t.TempDir())
	if _, err := store.PruneEmptyDirs("../escape"); err == nil {
		t.Fatal("expected an error for an invalid space id")
	}
}
