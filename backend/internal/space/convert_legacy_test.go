package space

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLegacyServerMetadataPurge: the plaintext comment + audit sidecars in
// .notation/ are detected and removed, and the operation is idempotent. These
// files live OUTSIDE files/, so purgePlaintextContent never reaches them — this
// is the dedicated leak-plug for an encrypted space.
func TestLegacyServerMetadataPurge(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.Create("spc", "Space", "admin"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	dir := s.MetaDir("spc")
	commentsPath := filepath.Join(dir, "comments.jsonl")
	auditPath := filepath.Join(dir, "audit.log")
	if err := os.WriteFile(commentsPath, []byte(`{"path":"secret/notes.md","text":"leak"}`+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(auditPath, []byte(`{"path":"secret/notes.md","ip":"1.2.3.4"}`+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}

	comments, audit, err := s.HasLegacyServerMetadata("spc")
	if err != nil {
		t.Fatalf("HasLegacyServerMetadata: %v", err)
	}
	if !comments || !audit {
		t.Fatalf("expected both sidecars present, got comments=%v audit=%v", comments, audit)
	}

	if err := s.PurgeLegacyServerMetadata("spc"); err != nil {
		t.Fatalf("PurgeLegacyServerMetadata: %v", err)
	}
	if _, err := os.Stat(commentsPath); !os.IsNotExist(err) {
		t.Errorf("comments.jsonl survived purge (err=%v)", err)
	}
	if _, err := os.Stat(auditPath); !os.IsNotExist(err) {
		t.Errorf("audit.log survived purge (err=%v)", err)
	}

	// Idempotent: purging again with nothing to remove is not an error.
	if err := s.PurgeLegacyServerMetadata("spc"); err != nil {
		t.Fatalf("second PurgeLegacyServerMetadata: %v", err)
	}
	comments, audit, err = s.HasLegacyServerMetadata("spc")
	if err != nil {
		t.Fatalf("HasLegacyServerMetadata after purge: %v", err)
	}
	if comments || audit {
		t.Errorf("sidecars still reported present after purge: comments=%v audit=%v", comments, audit)
	}
}
