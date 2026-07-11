package http

// Phase 3d: convert an EXISTING plaintext space to encrypted (and back). These
// tests drive the REAL wired router with httptest, exactly as production does.
// The blind /enc endpoints only ever move opaque bytes, so the "client" here
// stages made-up ciphertext (bytes that deliberately do NOT contain the
// plaintext marker) — the crypto round-trip itself is proven by the frontend
// suite. What these tests assert is the destructive machinery: the gate
// relaxation, the staging cleanup on abort, and — critically — that after a
// finalize the git history no longer contains the purged mode's bytes.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yoogie27/notation/internal/gitrepo"
)

const plaintextMarker = "PLAINTEXT_MARKER_9F3C2A"

// mkPlainSpace provisions a plaintext space through the real create API (so git
// is initialised), then seeds it with nested files incl. a binary-ish one and a
// couple of distinct commits so its history carries the plaintext marker.
func (e *isoEnv) mkPlainSpace(id string) {
	e.t.Helper()
	body, _ := json.Marshal(map[string]any{"id": id})
	rec := e.admin(http.MethodPost, "/api/admin/spaces", body)
	if rec.Code != http.StatusCreated {
		e.t.Fatalf("create plaintext space %s: code=%d body=%s", id, rec.Code, rec.Body.String())
	}
	e.write(id, "readme.md", "# Readme\n"+plaintextMarker+" at the top level\n")
	e.write(id, "notes/deep/inner.md", "nested "+plaintextMarker+" here\n")
	// A binary-ish file (NUL + high bytes) to prove lossless handling downstream.
	e.write(id, "assets/blob.bin", string([]byte{0x00, 0x01, 0xff, 0xfe, 0x42, 0x00}))
	if err := e.git.SnapshotCommit(id, gitrepo.Author{Name: "t"}, "commit one"); err != nil {
		e.t.Fatalf("snapshot 1: %v", err)
	}
	e.write(id, "readme.md", "# Readme v2\n"+plaintextMarker+" edited\n")
	if err := e.git.SnapshotCommit(id, gitrepo.Author{Name: "t"}, "commit two"); err != nil {
		e.t.Fatalf("snapshot 2: %v", err)
	}
}

// stageCiphertext writes a minimal set of opaque artifacts through the blind
// /enc endpoints, as the client would while encrypting. The bytes intentionally
// do NOT contain the plaintext marker.
func (e *isoEnv) stageCiphertext(id string) {
	e.t.Helper()
	blobID := "aaaabbbbccccdddd"
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/"+id+"/enc/blob/"+blobID, []byte("OPAQUE_CIPHERTEXT_BLOB")); rec.Code != http.StatusNoContent {
		e.t.Fatalf("stage blob: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/"+id+"/enc/ops?opId=1111222233334444", []byte("SEALED_OP_ENVELOPE")); rec.Code != http.StatusCreated {
		e.t.Fatalf("stage op: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/"+id+"/enc/checkpoint", []byte("SEALED_CHECKPOINT")); rec.Code != http.StatusNoContent {
		e.t.Fatalf("stage checkpoint: code=%d", rec.Code)
	}
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/"+id+"/enc/keyrecord", []byte(`{"version":1}`)); rec.Code != http.StatusNoContent {
		e.t.Fatalf("stage keyrecord: code=%d", rec.Code)
	}
}

func (e *isoEnv) beginConvert(id, direction string) *httptest.ResponseRecorder {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"direction": direction})
	return e.admin(http.MethodPost, "/api/admin/spaces/"+id+"/enc/begin-convert", body)
}

func (e *isoEnv) metaEncryptedConverting(id string) (bool, string) {
	e.t.Helper()
	rec := e.admin(http.MethodGet, "/api/admin/spaces/"+id, nil)
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		e.t.Fatalf("decode meta: %v", err)
	}
	enc, _ := m["encrypted"].(bool)
	conv, _ := m["converting"].(string)
	return enc, conv
}

// --- git / filesystem helpers -------------------------------------------------

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// grepDirForMarker walks every regular file under root (INCLUDING .git) and
// reports whether the literal marker bytes appear anywhere. Note: git stores
// objects zlib-compressed, so this is a weak check on its own for history — the
// authoritative history check is `git log -p` below.
func grepDirForMarker(t *testing.T, root, marker string) bool {
	t.Helper()
	found := false
	needle := []byte(marker)
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil // unreadable transient file — skip
		}
		if bytes.Contains(data, needle) {
			found = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return found
}

func fileExists(t *testing.T, p string) bool {
	t.Helper()
	_, err := os.Stat(p)
	return err == nil
}

// TestConvert_EncryptPurgesPlaintextAndHistory is the central destructive proof:
// after finalize, the plaintext files AND their git history are gone; only the
// staged ciphertext survives, in a single fresh commit.
func TestConvert_EncryptPurgesPlaintextAndHistory(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("vault")
	filesDir := filepath.Join(e.dataDir, "spaces", "vault", "files")

	// Positive control: before conversion the marker IS in working tree + history.
	if !grepDirForMarker(t, filesDir, plaintextMarker) {
		t.Fatal("precondition: marker should be present in the plaintext space")
	}
	if !strings.Contains(gitOut(t, filesDir, "log", "-p"), plaintextMarker) {
		t.Fatal("precondition: marker should be in git history before conversion")
	}

	// begin → gate relaxed; /enc writes now allowed on a still-plaintext space.
	if rec := e.beginConvert("vault", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("begin-convert: code=%d", rec.Code)
	}
	if enc, conv := e.metaEncryptedConverting("vault"); enc || conv != "to-encrypted" {
		t.Fatalf("after begin: encrypted=%v converting=%q", enc, conv)
	}
	e.stageCiphertext("vault")

	// finalize → destructive.
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/finalize-convert", nil); rec.Code != http.StatusOK {
		t.Fatalf("finalize-convert: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if enc, conv := e.metaEncryptedConverting("vault"); !enc || conv != "" {
		t.Fatalf("after finalize: encrypted=%v converting=%q", enc, conv)
	}

	// Working tree: plaintext gone, ciphertext present.
	for _, gone := range []string{"readme.md", "notes/deep/inner.md", "assets/blob.bin", "notes", "assets"} {
		if fileExists(t, filepath.Join(filesDir, gone)) {
			t.Errorf("plaintext path %q should have been purged", gone)
		}
	}
	for _, kept := range []string{"blobs/aaaabbbbccccdddd", "ops", "checkpoint"} {
		if !fileExists(t, filepath.Join(filesDir, kept)) {
			t.Errorf("ciphertext artifact %q should remain", kept)
		}
	}

	// History: exactly one fresh commit, no marker anywhere in it.
	logOneline := strings.TrimSpace(gitOut(t, filesDir, "log", "--oneline"))
	if lines := strings.Count(logOneline, "\n") + 1; lines != 1 {
		t.Errorf("git log should have exactly one commit, got %d:\n%s", lines, logOneline)
	}
	if strings.Contains(gitOut(t, filesDir, "log", "-p", "--all"), plaintextMarker) {
		t.Error("git history still contains the plaintext marker after reinit")
	}
	// No unreachable objects survive a fresh init.
	if unreach := strings.TrimSpace(gitOut(t, filesDir, "fsck", "--unreachable", "--no-reflogs")); unreach != "" {
		t.Errorf("git fsck found unreachable objects after reinit:\n%s", unreach)
	}
	// Whole space dir INCLUDING .git — the literal marker is absent.
	spaceDir := filepath.Join(e.dataDir, "spaces", "vault")
	if grepDirForMarker(t, spaceDir, plaintextMarker) {
		t.Error("plaintext marker still present somewhere under the space dir after encrypt")
	}
}

// TestConvert_AbortEncryptRestoresPlaintext: begin to-encrypted, stage a blob,
// abort → the space is fully plaintext again, staging gone, source intact.
func TestConvert_AbortEncryptRestoresPlaintext(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("vault")
	filesDir := filepath.Join(e.dataDir, "spaces", "vault", "files")

	if rec := e.beginConvert("vault", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("begin: code=%d", rec.Code)
	}
	e.stageCiphertext("vault")
	if !fileExists(t, filepath.Join(filesDir, "blobs")) {
		t.Fatal("blobs should exist after staging")
	}

	if rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/abort-convert", nil); rec.Code != http.StatusOK {
		t.Fatalf("abort: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if enc, conv := e.metaEncryptedConverting("vault"); enc || conv != "" {
		t.Fatalf("after abort: encrypted=%v converting=%q (want plaintext, not converting)", enc, conv)
	}
	// Staging gone.
	for _, gone := range []string{"blobs", "ops", "checkpoint"} {
		if fileExists(t, filepath.Join(filesDir, gone)) {
			t.Errorf("staged %q should have been removed on abort", gone)
		}
	}
	if fileExists(t, filepath.Join(e.dataDir, "spaces", "vault", ".notation", "spacekey.json")) {
		t.Error("keyrecord should have been removed on abort")
	}
	// Source intact.
	for _, kept := range []string{"readme.md", "notes/deep/inner.md", "assets/blob.bin"} {
		if !fileExists(t, filepath.Join(filesDir, kept)) {
			t.Errorf("plaintext source %q should be intact after abort", kept)
		}
	}
	// And the strict gate is back: /enc PUT now 409s again.
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/enc/blob/aaaabbbbccccdddd", []byte("x")); rec.Code != http.StatusConflict {
		t.Errorf("after abort, /enc write should 409 again, got %d", rec.Code)
	}
	// Seq counter reset: a fresh encrypt run appends at seq 1 again.
	if rec := e.beginConvert("vault", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("re-begin: code=%d", rec.Code)
	}
	rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/ops?opId=1111222233334444", []byte("x"))
	var sr struct {
		Seq int64 `json:"seq"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &sr)
	if sr.Seq != 1 {
		t.Errorf("after abort the op seq should reset to 1, got %d", sr.Seq)
	}
}

// TestConvert_DecryptPurgesCiphertext simulates a to-plaintext conversion at the
// HTTP layer: an encrypted space with staged ciphertext, decrypted files written
// back through the (relaxed) plaintext API, then finalize purges the ciphertext.
func TestConvert_DecryptPurgesCiphertext(t *testing.T) {
	e := newIsoEnv(t)
	e.mkEncSpace("vault") // encrypted from the start
	if err := e.git.Init("vault"); err != nil {
		t.Fatalf("git init: %v", err)
	}
	e.stageCiphertext("vault")
	filesDir := filepath.Join(e.dataDir, "spaces", "vault", "files")

	// While encrypted (not converting), plaintext writes 409.
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/file/readme.md", []byte("hi")); rec.Code != http.StatusConflict {
		t.Fatalf("plaintext write on encrypted space should 409, got %d", rec.Code)
	}

	if rec := e.beginConvert("vault", "to-plaintext"); rec.Code != http.StatusOK {
		t.Fatalf("begin to-plaintext: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if enc, conv := e.metaEncryptedConverting("vault"); !enc || conv != "to-plaintext" {
		t.Fatalf("after begin: encrypted=%v converting=%q", enc, conv)
	}

	// Now plaintext writes are allowed (gate relaxed). Write decrypted files.
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/file/readme.md", []byte("# Recovered\n"+plaintextMarker+"\n")); rec.Code != http.StatusNoContent {
		t.Fatalf("staged plaintext write: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/file/notes/deep/inner.md", []byte("nested recovered\n")); rec.Code != http.StatusNoContent {
		t.Fatalf("staged nested write: code=%d", rec.Code)
	}
	// /enc reads still work while converting (client reads its ciphertext).
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/blob/aaaabbbbccccdddd", nil); rec.Code != http.StatusOK {
		t.Fatalf("/enc read during to-plaintext should work, got %d", rec.Code)
	}

	if rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/finalize-convert", nil); rec.Code != http.StatusOK {
		t.Fatalf("finalize to-plaintext: code=%d body=%s", rec.Code, rec.Body.String())
	}
	if enc, conv := e.metaEncryptedConverting("vault"); enc || conv != "" {
		t.Fatalf("after finalize: encrypted=%v converting=%q (want plaintext)", enc, conv)
	}

	// Plaintext files remain; ciphertext + keyrecord purged.
	for _, kept := range []string{"readme.md", "notes/deep/inner.md"} {
		if !fileExists(t, filepath.Join(filesDir, kept)) {
			t.Errorf("decrypted file %q should remain after finalize", kept)
		}
	}
	for _, gone := range []string{"blobs", "ops", "checkpoint"} {
		if fileExists(t, filepath.Join(filesDir, gone)) {
			t.Errorf("ciphertext artifact %q should be purged", gone)
		}
	}
	if fileExists(t, filepath.Join(e.dataDir, "spaces", "vault", ".notation", "spacekey.json")) {
		t.Error("keyrecord should be purged after decrypt")
	}
	// The space is now a normal plaintext space: tree works, /enc 409s.
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/tree", nil); rec.Code != http.StatusOK {
		t.Errorf("tree on now-plaintext space: code=%d", rec.Code)
	}
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/blob/aaaabbbbccccdddd", nil); rec.Code != http.StatusConflict {
		t.Errorf("/enc read after decrypt should 409, got %d", rec.Code)
	}
	// One fresh commit, no ciphertext blob names in history beyond the last.
	logOneline := strings.TrimSpace(gitOut(t, filesDir, "log", "--oneline"))
	if lines := strings.Count(logOneline, "\n") + 1; lines != 1 {
		t.Errorf("git log should have exactly one commit after decrypt reinit, got %d", lines)
	}
}

// TestConvert_BeginGuards: contradictory directions and double-convert are 409;
// bad direction is 400.
func TestConvert_BeginGuards(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("plain")
	e.mkEncSpace("vault")

	// Wrong direction for the mode.
	if rec := e.beginConvert("plain", "to-plaintext"); rec.Code != http.StatusConflict {
		t.Errorf("to-plaintext on plaintext space should 409, got %d", rec.Code)
	}
	if rec := e.beginConvert("vault", "to-encrypted"); rec.Code != http.StatusConflict {
		t.Errorf("to-encrypted on encrypted space should 409, got %d", rec.Code)
	}
	// Bad direction.
	body, _ := json.Marshal(map[string]string{"direction": "sideways"})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/plain/enc/begin-convert", body); rec.Code != http.StatusBadRequest {
		t.Errorf("bad direction should 400, got %d", rec.Code)
	}
	// Double convert.
	if rec := e.beginConvert("plain", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("first begin: code=%d", rec.Code)
	}
	if rec := e.beginConvert("plain", "to-encrypted"); rec.Code != http.StatusConflict {
		t.Errorf("second begin should 409 (already converting), got %d", rec.Code)
	}
	// Finalize without a key record staged → 409.
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/plain/enc/finalize-convert", nil); rec.Code != http.StatusConflict {
		t.Errorf("finalize without keyrecord should 409, got %d", rec.Code)
	}
}

// TestConvert_ReservedNameCollision: a plaintext space with a top-level "blobs"
// entry can't be encrypted (would collide with the ciphertext layout).
func TestConvert_ReservedNameCollision(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("collide")
	e.write("collide", "blobs/x.md", "reserved name clash\n")
	if rec := e.beginConvert("collide", "to-encrypted"); rec.Code != http.StatusConflict {
		t.Errorf("encrypt with reserved top-level name should 409, got %d", rec.Code)
	}
}
