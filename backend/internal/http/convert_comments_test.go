package http

// Encrypted-comments leak-plug: the plaintext server sidecars in .notation/
// (comments.jsonl + audit.log) must not survive a to-encrypted conversion, and
// an already-encrypted space must be able to hand its orphaned comments to the
// client for migration and then purge them.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const commentMarker = "COMMENT_MARKER_7B1D4E"

func notationDir(e *isoEnv, id string) string {
	return filepath.Join(e.dataDir, "spaces", id, ".notation")
}

// TestConvert_EncryptPurgesLegacyMetadata: a plaintext space's comment (in
// .notation/comments.jsonl) and audit log (.notation/audit.log) are gone after
// finalize — these live OUTSIDE files/, so only the dedicated purge removes them.
func TestConvert_EncryptPurgesLegacyMetadata(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("vault")

	// A real comment carrying the marker (path + text land in comments.jsonl).
	body, _ := json.Marshal(map[string]string{"text": commentMarker})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/comments/readme.md", body); rec.Code != http.StatusCreated {
		t.Fatalf("post comment: code=%d body=%s", rec.Code, rec.Body.String())
	}
	commentsPath := filepath.Join(notationDir(e, "vault"), "comments.jsonl")
	if !fileExists(t, commentsPath) {
		t.Fatal("precondition: comments.jsonl should exist after posting")
	}
	// The other plaintext sidecars (audit/shares/mcp) that also carry cleartext
	// paths/labels; seed them directly so the purge has something to remove.
	nd := notationDir(e, "vault")
	auditPath := filepath.Join(nd, "audit.log")
	sharesPath := filepath.Join(nd, "shares.json")
	mcpPath := filepath.Join(nd, "mcp-tokens.json")
	if err := os.WriteFile(auditPath, []byte(`{"path":"readme.md","actor":"`+commentMarker+`"}`+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sharesPath, []byte(`[{"scope":"`+commentMarker+`","label":"x"}]`), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mcpPath, []byte(`[{"label":"`+commentMarker+`"}]`), 0o640); err != nil {
		t.Fatal(err)
	}

	// begin → stage → finalize.
	if rec := e.beginConvert("vault", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("begin-convert: code=%d", rec.Code)
	}
	e.stageCiphertext("vault")
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/finalize-convert", nil); rec.Code != http.StatusOK {
		t.Fatalf("finalize-convert: code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Every sidecar is gone, and the marker is nowhere under the space dir.
	for _, p := range []string{commentsPath, auditPath, sharesPath, mcpPath} {
		if fileExists(t, p) {
			t.Errorf("%s survived encryption — plaintext leak", filepath.Base(p))
		}
	}
	spaceDir := filepath.Join(e.dataDir, "spaces", "vault")
	if grepDirForMarker(t, spaceDir, commentMarker) {
		t.Error("comment/audit marker still present somewhere under the space dir after encrypt")
	}
}

// TestEnc_LegacyMetadataMigrationEndpoints: an encrypted space that still holds
// orphaned plaintext sidecars exposes the comments for migration, then purges
// both on request. Mirrors a space encrypted before comments joined the crypto
// system.
func TestEnc_LegacyMetadataMigrationEndpoints(t *testing.T) {
	e := newIsoEnv(t)
	if _, err := e.store.CreateEncrypted("vault", "Vault", "admin"); err != nil {
		t.Fatalf("CreateEncrypted: %v", err)
	}
	dir := notationDir(e, "vault")
	commentsPath := filepath.Join(dir, "comments.jsonl")
	auditPath := filepath.Join(dir, "audit.log")
	// A single orphaned comment (pre-encryption shape: has a plaintext path).
	line := `{"id":"c_old","path":"readme.md","created_at":"2026-01-01T00:00:00Z","author":"admin:me","text":"` + commentMarker + `"}`
	if err := os.WriteFile(commentsPath, []byte(line+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(auditPath, []byte(`{"path":"readme.md"}`+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}

	// GET legacy-comments: both flags true, the orphaned comment is returned.
	rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/legacy-comments", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy-comments: code=%d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		HasComments bool `json:"has_comments"`
		HasOther    bool `json:"has_other"`
		Comments    []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
			Text string `json:"text"`
		} `json:"comments"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode legacy-comments: %v", err)
	}
	if !resp.HasComments || !resp.HasOther {
		t.Fatalf("flags wrong: has_comments=%v has_other=%v", resp.HasComments, resp.HasOther)
	}
	if len(resp.Comments) != 1 || resp.Comments[0].Path != "readme.md" || !strings.Contains(resp.Comments[0].Text, commentMarker) {
		t.Fatalf("orphaned comment not returned for migration: %+v", resp.Comments)
	}

	// POST purge → both sidecars gone.
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/purge-legacy-metadata", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("purge-legacy-metadata: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if fileExists(t, commentsPath) || fileExists(t, auditPath) {
		t.Error("sidecars survived purge-legacy-metadata")
	}

	// A follow-up read reports nothing left to migrate.
	rec = e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/legacy-comments", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode legacy-comments (2): %v", err)
	}
	if resp.HasComments || resp.HasOther || len(resp.Comments) != 0 {
		t.Errorf("legacy metadata still reported after purge: %+v", resp)
	}
}

// TestConvert_FinalizeRefusesWithoutStagedCiphertext: a to-encrypted finalize
// that has a key record but NO staged blobs/ops must refuse (409) rather than
// purge the plaintext into an empty encrypted space. Data-loss guard.
func TestConvert_FinalizeRefusesWithoutStagedCiphertext(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("vault")
	filesDir := filepath.Join(e.dataDir, "spaces", "vault", "files")

	if rec := e.beginConvert("vault", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("begin-convert: code=%d", rec.Code)
	}
	// Upload ONLY the key record — no blobs, no ops (simulates a crash/partial upload).
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/enc/keyrecord", []byte(`{"version":1}`)); rec.Code != http.StatusNoContent {
		t.Fatalf("stage keyrecord: code=%d", rec.Code)
	}
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/finalize-convert", nil); rec.Code != http.StatusConflict {
		t.Fatalf("finalize without ciphertext: want 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	// Plaintext source is untouched.
	if !fileExists(t, filepath.Join(filesDir, "readme.md")) {
		t.Error("plaintext source was purged despite the finalize guard refusing")
	}
	if enc, conv := e.metaEncryptedConverting("vault"); enc || conv != "to-encrypted" {
		t.Errorf("space state changed after refused finalize: encrypted=%v converting=%q", enc, conv)
	}
}

// TestConvert_PlaintextWritesPausedDuringEncrypt: while a space is being
// encrypted, plaintext READS stay open (the client reads the source) but
// plaintext WRITES are refused, so an autosave can't race the destructive
// finalize into the encrypted history.
func TestConvert_PlaintextWritesPausedDuringEncrypt(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("vault")

	if rec := e.beginConvert("vault", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("begin-convert: code=%d", rec.Code)
	}
	// A plaintext write is paused (409).
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/file/newpage.md", []byte("hi")); rec.Code != http.StatusConflict {
		t.Errorf("plaintext PUT during to-encrypted: want 409, got %d", rec.Code)
	}
	// A plaintext read still works (the conversion client needs the source).
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/files-flat", nil); rec.Code != http.StatusOK {
		t.Errorf("plaintext read during to-encrypted: want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// TestEnc_LegacyEndpointsRejectPlaintext: the migration endpoints are enc-only.
func TestEnc_LegacyEndpointsRejectPlaintext(t *testing.T) {
	e := newIsoEnv(t)
	e.mkSpace("plain")
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/plain/enc/legacy-comments", nil); rec.Code != http.StatusConflict {
		t.Errorf("legacy-comments on plaintext space: want 409, got %d", rec.Code)
	}
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/plain/enc/purge-legacy-metadata", nil); rec.Code != http.StatusConflict {
		t.Errorf("purge on plaintext space: want 409, got %d", rec.Code)
	}
}
