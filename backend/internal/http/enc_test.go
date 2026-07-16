package http

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
)

// mkEncSpace creates an encrypted space through the real admin API (so the
// {"encrypted":true} create path is exercised end-to-end) and returns its id.
func (e *isoEnv) mkEncSpace(id string) string {
	e.t.Helper()
	body, _ := json.Marshal(map[string]any{"id": id, "encrypted": true})
	rec := e.admin(http.MethodPost, "/api/admin/spaces", body)
	if rec.Code != http.StatusCreated {
		e.t.Fatalf("create encrypted space %s: code=%d body=%s", id, rec.Code, rec.Body.String())
	}
	return id
}

func TestEnc_CreateExposesFlag(t *testing.T) {
	e := newIsoEnv(t)
	e.mkEncSpace("vault")

	// getSpace exposes encrypted=true for the vault, false for a plaintext space.
	rec := e.admin(http.MethodGet, "/api/admin/spaces/vault", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("getSpace vault: code=%d", rec.Code)
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if m["encrypted"] != true {
		t.Errorf("vault getSpace encrypted = %v, want true", m["encrypted"])
	}

	rec = e.admin(http.MethodGet, "/api/admin/spaces/alpha", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	if m["encrypted"] != false {
		t.Errorf("alpha getSpace encrypted = %v, want false", m["encrypted"])
	}
}

func TestEnc_BlobRoundTrip(t *testing.T) {
	e := newIsoEnv(t)
	e.mkEncSpace("vault")

	blobID := "deadbeefcafe0011"
	payload := []byte{0x00, 0x01, 0xff, 0xfe, 0x42, 0x00, 0x99, 0x7f}

	rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/enc/blob/"+blobID, payload)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT blob: code=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/blob/"+blobID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET blob: code=%d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("blob Content-Type = %q, want application/octet-stream", ct)
	}
	if !bytes.Equal(rec.Body.Bytes(), payload) {
		t.Errorf("blob bytes round-trip mismatch: got %x want %x", rec.Body.Bytes(), payload)
	}

	rec = e.admin(http.MethodDelete, "/api/admin/spaces/vault/enc/blob/"+blobID, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE blob: code=%d", rec.Code)
	}
	rec = e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/blob/"+blobID, nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET deleted blob: code=%d, want 404", rec.Code)
	}

	// Traversal / non-hex ids are rejected with 400.
	for _, bad := range []string{"..", "..%2F..%2Fetc", "ABCDEF01", "xyz", "abc"} {
		rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/enc/blob/"+bad, payload)
		if rec.Code == http.StatusNoContent || rec.Code == http.StatusOK {
			t.Errorf("PUT blob bad id %q unexpectedly succeeded (code=%d)", bad, rec.Code)
		}
	}
}

func TestEnc_OpLog(t *testing.T) {
	e := newIsoEnv(t)
	e.mkEncSpace("vault")

	type seqResp struct {
		Seq int64 `json:"seq"`
	}
	post := func(opID string, body []byte) int64 {
		rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/ops?opId="+opID, body)
		if rec.Code != http.StatusCreated {
			t.Fatalf("POST op %s: code=%d body=%s", opID, rec.Code, rec.Body.String())
		}
		var sr seqResp
		if err := json.Unmarshal(rec.Body.Bytes(), &sr); err != nil {
			t.Fatalf("decode seq: %v", err)
		}
		return sr.Seq
	}

	if s := post("aaaaaaaa", []byte("op-one")); s != 1 {
		t.Errorf("first op seq = %d, want 1", s)
	}
	if s := post("bbbbbbbb", []byte("op-two")); s != 2 {
		t.Errorf("second op seq = %d, want 2", s)
	}
	if s := post("cccccccc", []byte("op-three")); s != 3 {
		t.Errorf("third op seq = %d, want 3", s)
	}

	// Missing/invalid opId → 400.
	rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/ops", []byte("x"))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST op without opId: code=%d, want 400", rec.Code)
	}

	// GET since=1 returns seq 2,3 ordered, blobs base64-decodable.
	rec = e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/ops?since=1", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET ops: code=%d", rec.Code)
	}
	var ops []struct {
		Seq  int64  `json:"seq"`
		OpID string `json:"opId"`
		Blob []byte `json:"blob"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ops); err != nil {
		t.Fatalf("decode ops: %v", err)
	}
	if len(ops) != 2 {
		t.Fatalf("ops since=1 len = %d, want 2", len(ops))
	}
	if ops[0].Seq != 2 || ops[1].Seq != 3 {
		t.Errorf("ops not ordered ascending: %d, %d", ops[0].Seq, ops[1].Seq)
	}
	if string(ops[0].Blob) != "op-two" {
		t.Errorf("op[0].Blob = %q, want op-two", ops[0].Blob)
	}

	// Sanity: the wire form really is base64 (blind server doesn't reinterpret).
	var raw []map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &raw)
	if b64, ok := raw[0]["blob"].(string); ok {
		if dec, err := base64.StdEncoding.DecodeString(b64); err != nil || string(dec) != "op-two" {
			t.Errorf("blob field not base64 of the op bytes: %q (err=%v)", b64, err)
		}
	} else {
		t.Errorf("blob field is not a JSON string")
	}
}

func TestEnc_CheckpointAndKeyRecord(t *testing.T) {
	e := newIsoEnv(t)
	e.mkEncSpace("vault")

	// Checkpoint 404 before first write.
	rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/checkpoint", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET checkpoint before write: code=%d, want 404", rec.Code)
	}
	cp := []byte("encrypted-checkpoint\x00\xff")
	rec = e.admin(http.MethodPut, "/api/admin/spaces/vault/enc/checkpoint", cp)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT checkpoint: code=%d", rec.Code)
	}
	rec = e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/checkpoint", nil)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), cp) {
		t.Errorf("checkpoint round-trip: code=%d bytesEqual=%v", rec.Code, bytes.Equal(rec.Body.Bytes(), cp))
	}

	// Key record: JSON passthrough.
	kr := []byte(`{"version":1,"kdf":{"m":19456,"t":2},"kdfSalt":"AAAA"}`)
	rec = e.admin(http.MethodPut, "/api/admin/spaces/vault/enc/keyrecord", kr)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT keyrecord: code=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/keyrecord", nil)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), kr) {
		t.Errorf("keyrecord round-trip: code=%d body=%s", rec.Code, rec.Body.String())
	}
	// Non-JSON body is rejected.
	rec = e.admin(http.MethodPut, "/api/admin/spaces/vault/enc/keyrecord", []byte("not json{"))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("PUT non-JSON keyrecord: code=%d, want 400", rec.Code)
	}
}

// frameOpHTTP builds a sealed-op envelope carrying a cleartext framing Lamport
// (uint32-BE metaLen || meta JSON || ciphertext) — the shape the server peeks for
// prune safety without decrypting.
func frameOpHTTP(lamport int64) []byte {
	meta := fmt.Sprintf(`{"opId":"%016x","lamport":%d,"actorId":"dev"}`, lamport, lamport)
	out := make([]byte, 4+len(meta)+2)
	binary.BigEndian.PutUint32(out[:4], uint32(len(meta)))
	copy(out[4:], meta)
	return out
}

// TestEnc_Prune drives the prune endpoints through the real router: post framed
// ops, write a checkpoint, prune the folded prefix, and confirm the floor is
// served, the base is stored, and only the retained suffix remains.
func TestEnc_Prune(t *testing.T) {
	prev := space.PruneLamportMargin
	space.PruneLamportMargin = 5
	t.Cleanup(func() { space.PruneLamportMargin = prev })

	e := newIsoEnv(t)
	e.mkEncSpace("vault")

	// Floor starts at 0.
	rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/ops/floor", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET floor: code=%d", rec.Code)
	}
	var fr struct {
		Floor int64 `json:"floor"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &fr)
	if fr.Floor != 0 {
		t.Fatalf("initial floor = %d, want 0", fr.Floor)
	}

	// 20 ops, Lamports 1..20 (strictly increasing → clean cut anywhere).
	for i := int64(1); i <= 20; i++ {
		opID := fmt.Sprintf("%016x", i)
		rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/ops?opId="+opID, frameOpHTTP(i))
		if rec.Code != http.StatusCreated {
			t.Fatalf("POST op %d: code=%d body=%s", i, rec.Code, rec.Body.String())
		}
	}
	// A latest checkpoint must exist for the prune to be allowed.
	if rec := e.admin(http.MethodPut, "/api/admin/spaces/vault/enc/checkpoint", []byte("latest-cp")); rec.Code != http.StatusNoContent {
		t.Fatalf("PUT checkpoint: code=%d", rec.Code)
	}

	// Base checkpoint 404 until the first prune.
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/checkpoint-base", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("GET checkpoint-base before prune: code=%d, want 404", rec.Code)
	}

	// Prune up to seq 10, installing the base.
	base := []byte("prune-base-bytes")
	rec = e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/ops/prune?upTo=10", base)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST prune: code=%d body=%s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &fr)
	if fr.Floor != 10 {
		t.Fatalf("prune floor = %d, want 10", fr.Floor)
	}

	// Floor now served as 10; base retrievable; ops start at seq 11.
	rec = e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/ops/floor", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &fr)
	if fr.Floor != 10 {
		t.Fatalf("served floor = %d, want 10", fr.Floor)
	}
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/checkpoint-base", nil); rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), base) {
		t.Fatalf("GET checkpoint-base: code=%d bytesEqual=%v", rec.Code, bytes.Equal(rec.Body.Bytes(), base))
	}
	rec = e.admin(http.MethodGet, "/api/admin/spaces/vault/enc/ops?since=0", nil)
	var ops []struct {
		Seq int64 `json:"seq"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &ops)
	if len(ops) != 10 || ops[0].Seq != 11 {
		t.Fatalf("after prune, ListOps(0) = %d ops starting at %d; want 10 starting at 11", len(ops), func() int64 {
			if len(ops) > 0 {
				return ops[0].Seq
			}
			return -1
		}())
	}

	// An empty-body prune is rejected (the base is the sole fallback seed).
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/vault/enc/ops/prune?upTo=15", []byte{}); rec.Code != http.StatusBadRequest {
		t.Errorf("empty-body prune: code=%d, want 400", rec.Code)
	}

	// Enc-prune endpoints 409 on a plaintext space.
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/enc/ops/floor", nil); rec.Code != http.StatusConflict {
		t.Errorf("floor on plaintext space: code=%d, want 409", rec.Code)
	}
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/enc/ops/prune?upTo=1", []byte("b")); rec.Code != http.StatusConflict {
		t.Errorf("prune on plaintext space: code=%d, want 409", rec.Code)
	}
}

// TestEnc_Gating is the central invariant: a space is EITHER plaintext OR an
// opaque blob store. Plaintext endpoints 409 on the vault; enc endpoints 409 on
// a plaintext space.
func TestEnc_Gating(t *testing.T) {
	e := newIsoEnv(t)
	e.mkEncSpace("vault")

	// Plaintext content endpoints must 409 on the encrypted space.
	plaintextCalls := []struct {
		method, path string
		body         []byte
	}{
		{http.MethodGet, "/api/admin/spaces/vault/tree", nil},
		{http.MethodGet, "/api/admin/spaces/vault/file/note.md", nil},
		{http.MethodPut, "/api/admin/spaces/vault/file/note.md", []byte("hi")},
		{http.MethodDelete, "/api/admin/spaces/vault/file/note.md", nil},
		{http.MethodPost, "/api/admin/spaces/vault/mkdir", []byte(`{"path":"x"}`)},
		{http.MethodPost, "/api/admin/spaces/vault/rename/note.md", []byte(`{"to":"y.md"}`)},
		{http.MethodGet, "/api/admin/spaces/vault/search?q=x", nil},
		{http.MethodGet, "/api/admin/spaces/vault/export", nil},
		{http.MethodGet, "/api/admin/spaces/vault/form/f", nil},
		{http.MethodGet, "/api/admin/spaces/vault/log", nil},
	}
	for _, c := range plaintextCalls {
		rec := e.admin(c.method, c.path, c.body)
		if rec.Code != http.StatusConflict {
			t.Errorf("plaintext %s %s on encrypted space: code=%d, want 409", c.method, c.path, rec.Code)
		}
	}

	// Enc endpoints must 409 on the plaintext space (alpha).
	encCalls := []struct {
		method, path string
		body         []byte
	}{
		{http.MethodPut, "/api/admin/spaces/alpha/enc/blob/deadbeef01", []byte("x")},
		{http.MethodGet, "/api/admin/spaces/alpha/enc/blob/deadbeef01", nil},
		{http.MethodPost, "/api/admin/spaces/alpha/enc/ops?opId=deadbeef01", []byte("x")},
		{http.MethodGet, "/api/admin/spaces/alpha/enc/ops", nil},
		{http.MethodGet, "/api/admin/spaces/alpha/enc/checkpoint", nil},
		{http.MethodPut, "/api/admin/spaces/alpha/enc/checkpoint", []byte("x")},
		{http.MethodGet, "/api/admin/spaces/alpha/enc/keyrecord", nil},
	}
	for _, c := range encCalls {
		rec := e.admin(c.method, c.path, c.body)
		if rec.Code != http.StatusConflict {
			t.Errorf("enc %s %s on plaintext space: code=%d, want 409", c.method, c.path, rec.Code)
		}
	}
}

// TestEnc_ShareRefuses: an encrypted space is sealed off from share links.
func TestEnc_ShareRefuses(t *testing.T) {
	e := newIsoEnv(t)
	e.mkEncSpace("vault")
	tok := e.mkShare("vault", share.PermissionRead, "")

	for _, path := range []string{"/space", "/tree", "/file/x.md", "/search?q=a"} {
		rec := e.do(http.MethodGet, "/s/api/"+tok+path, nil, nil)
		if rec.Code != http.StatusConflict {
			t.Errorf("share GET %s on encrypted space: code=%d, want 409", path, rec.Code)
		}
	}
}

// TestEnc_MCPRefuses: an encrypted space is not accessible via MCP; every tool
// call fails with a clear error (through the real wired router).
func TestEnc_MCPRefuses(t *testing.T) {
	e := newIsoEnv(t)
	e.mkEncSpace("vault")
	tok := e.mkMCP("vault")

	code, body := e.mcpCall("vault", tok, "read_file", map[string]any{"path": "note.md"})
	if code != http.StatusOK {
		t.Fatalf("mcp read_file transport code=%d, want 200 (tool-level error)", code)
	}
	if !bytes.Contains([]byte(body), []byte("encrypted")) {
		t.Errorf("mcp tool result should mention 'encrypted', got: %s", truncate(body))
	}
	// Also a write tool: must not succeed.
	code, body = e.mcpCall("vault", tok, "write_file", map[string]any{"path": "x.md", "content": "hi"})
	if !bytes.Contains([]byte(body), []byte("encrypted")) {
		t.Errorf("mcp write_file on encrypted space should be refused, got: %s", truncate(body))
	}
}
