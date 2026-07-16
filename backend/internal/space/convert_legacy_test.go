package space

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLegacyServerMetadataPurge: every plaintext sidecar in .notation/ (comments,
// audit, shares, mcp-tokens — all carrying cleartext file paths/labels) is
// detected and removed, and the operation is idempotent. These live OUTSIDE
// files/, so purgePlaintextContent never reaches them — this is the dedicated
// leak-plug for an encrypted space.
func TestLegacyServerMetadataPurge(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.Create("spc", "Space", "admin"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	dir := s.MetaDir("spc")
	sidecars := map[string]string{
		"comments.jsonl":  `{"path":"secret/notes.md","text":"leak"}` + "\n",
		"audit.log":       `{"path":"secret/notes.md","ip":"1.2.3.4"}` + "\n",
		"shares.json":     `[{"scope":"secret/notes.md","label":"leaked share"}]`,
		"mcp-tokens.json": `[{"label":"leaked token"}]`,
	}
	for name, content := range sidecars {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o640); err != nil {
			t.Fatal(err)
		}
	}

	comments, other, err := s.HasLegacyServerMetadata("spc")
	if err != nil {
		t.Fatalf("HasLegacyServerMetadata: %v", err)
	}
	if !comments || !other {
		t.Fatalf("expected comments + other sidecars present, got comments=%v other=%v", comments, other)
	}

	if err := s.PurgeLegacyServerMetadata("spc"); err != nil {
		t.Fatalf("PurgeLegacyServerMetadata: %v", err)
	}
	for name := range sidecars {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s survived purge (err=%v)", name, err)
		}
	}

	// Idempotent: purging again with nothing to remove is not an error.
	if err := s.PurgeLegacyServerMetadata("spc"); err != nil {
		t.Fatalf("second PurgeLegacyServerMetadata: %v", err)
	}
	comments, other, err = s.HasLegacyServerMetadata("spc")
	if err != nil {
		t.Fatalf("HasLegacyServerMetadata after purge: %v", err)
	}
	if comments || other {
		t.Errorf("sidecars still reported present after purge: comments=%v other=%v", comments, other)
	}
}
