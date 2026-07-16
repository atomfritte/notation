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
	// An audit log carrying the marker (server writes these on share/MCP access;
	// seed one directly so the purge has something to remove).
	auditPath := filepath.Join(notationDir(e, "vault"), "audit.log")
	if err := os.WriteFile(auditPath, []byte(`{"path":"readme.md","actor":"`+commentMarker+`"}`+"\n"), 0o640); err != nil {
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

	// Both sidecars are gone, and the marker is nowhere under the space dir.
	if fileExists(t, commentsPath) {
		t.Error("comments.jsonl survived encryption — plaintext comment leak")
	}
	if fileExists(t, auditPath) {
		t.Error("audit.log survived encryption — plaintext audit leak")
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
		HasAudit    bool `json:"has_audit"`
		Comments    []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
			Text string `json:"text"`
		} `json:"comments"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode legacy-comments: %v", err)
	}
	if !resp.HasComments || !resp.HasAudit {
		t.Fatalf("flags wrong: has_comments=%v has_audit=%v", resp.HasComments, resp.HasAudit)
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
	if resp.HasComments || resp.HasAudit || len(resp.Comments) != 0 {
		t.Errorf("legacy metadata still reported after purge: %+v", resp)
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
