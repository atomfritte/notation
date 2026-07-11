package http

import (
	"net/http"
	"testing"
)

// A finalize that already purged the plaintext but crashed before finishing
// (the reinit race that hit production) leaves the ONLY surviving copy of the
// content in the staged ciphertext. Abort must REFUSE (aborting would drop the
// ciphertext → empty space); resume (re-running finalize) must complete the
// encryption.
func TestConvert_AbortRefusedAfterPartialFinalize_ResumeCompletes(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("recov")
	if rec := e.beginConvert("recov", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("begin: %d %s", rec.Code, rec.Body.String())
	}
	e.stageCiphertext("recov")

	// Simulate the crash point: PurgePlaintextContent ran, Reinit did NOT.
	if err := e.store.PurgePlaintextContent("recov"); err != nil {
		t.Fatalf("purge plaintext: %v", err)
	}

	// Abort must be refused — the plaintext is gone and the ciphertext is the
	// only copy; dropping it would leave an empty space.
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/recov/enc/abort-convert", []byte(`{}`)); rec.Code != http.StatusConflict {
		t.Fatalf("abort should be refused (409) after plaintext purge, got %d %s", rec.Code, rec.Body.String())
	}
	// Still mid-convert, ciphertext intact.
	if enc, conv := e.metaEncryptedConverting("recov"); enc || conv != "to-encrypted" {
		t.Fatalf("space should still be mid-convert, got encrypted=%v converting=%q", enc, conv)
	}

	// Resume: finalize now completes (the reinit race is fixed).
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/recov/enc/finalize-convert", []byte(`{}`)); rec.Code != http.StatusOK {
		t.Fatalf("resume/finalize should complete, got %d %s", rec.Code, rec.Body.String())
	}
	if enc, conv := e.metaEncryptedConverting("recov"); !enc || conv != "" {
		t.Fatalf("after resume: want encrypted=true converting='', got encrypted=%v converting=%q", enc, conv)
	}
}

// Sanity: a normal abort (before finalize purges anything) is still allowed and
// restores the plaintext space — the guard must not block the common case.
func TestConvert_AbortAllowedBeforeFinalize(t *testing.T) {
	e := newIsoEnv(t)
	e.mkPlainSpace("normalabort")
	if rec := e.beginConvert("normalabort", "to-encrypted"); rec.Code != http.StatusOK {
		t.Fatalf("begin: %d %s", rec.Code, rec.Body.String())
	}
	e.stageCiphertext("normalabort")
	// Plaintext still present → abort is safe and allowed.
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/normalabort/enc/abort-convert", []byte(`{}`)); rec.Code != http.StatusOK {
		t.Fatalf("normal abort should be allowed (200), got %d %s", rec.Code, rec.Body.String())
	}
	if enc, conv := e.metaEncryptedConverting("normalabort"); enc || conv != "" {
		t.Fatalf("after abort: want plaintext + not converting, got encrypted=%v converting=%q", enc, conv)
	}
}
