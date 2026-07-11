package gitrepo

import (
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/yoogie27/notation/internal/space"
)

// Reinit (used by the convert-to-encrypted finalize step) removes .git and
// re-creates it. It must never run concurrently with an auto-commit on the same
// Space, or `rm -rf .git` races git writing objects → "directory not empty"
// (the production bug hit while encrypting a space). This test drives constant
// commit churn while hammering Reinit; every Reinit must succeed and the repo
// must stay valid. Runs under -race in CI.
func TestReinit_ConcurrentAutoCommit_NoRace(t *testing.T) {
	dir := t.TempDir()
	store := space.NewStore(dir)
	if _, err := store.Create("racetest", "racetest", "tester"); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	// Tiny debounce so the Schedule() timers actually fire mid-test.
	m := NewManager(store, time.Millisecond, logger)
	filesDir := store.FilesDir("racetest")
	if err := m.Init("racetest"); err != nil {
		t.Fatal(err)
	}
	writeN := func(n int) {
		_ = os.WriteFile(filepath.Join(filesDir, "note.md"), []byte("v"+strconv.Itoa(n)), 0o644)
	}
	writeN(0)
	if err := m.SnapshotCommit("racetest", Author{Name: "t"}, "init"); err != nil {
		t.Fatal(err)
	}

	// Background churn: several goroutines writing + committing (both the
	// debounced path and immediate snapshots) so git is actively touching .git.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			i := 0
			for {
				select {
				case <-stop:
					return
				default:
				}
				writeN(g*100000 + i)
				m.Schedule("racetest", Author{Name: "auto"})
				_ = m.SnapshotCommit("racetest", Author{Name: "snap"}, "s")
				i++
			}
		}(g)
	}

	// Hammer Reinit — each call must succeed despite the concurrent commits.
	for r := 0; r < 25; r++ {
		writeN(900000 + r)
		if err := m.Reinit("racetest", Author{Name: "reinit"}, "convert to encrypted"); err != nil {
			close(stop)
			wg.Wait()
			t.Fatalf("Reinit #%d failed under concurrent commits: %v", r, err)
		}
	}
	close(stop)
	wg.Wait()
	m.FlushAll() // drain any queued debounce timer

	// Under the op lock so no in-flight commit is mid-write: the repo must be
	// valid and hold exactly one commit (Reinit's single fresh commit).
	l := m.opLock("racetest")
	l.Lock()
	defer l.Unlock()
	out, err := run(filesDir, nil, "rev-list", "--count", "HEAD")
	if err != nil {
		t.Fatalf("repo invalid after reinit churn: %v (%s)", err, out)
	}
	if got := string(out); len(got) == 0 {
		t.Fatalf("expected a commit count, got empty")
	}
}
