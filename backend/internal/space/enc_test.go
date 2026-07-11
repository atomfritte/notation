package space

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
)

const encMax = 8 << 20

func newEncStore(t *testing.T) *Store {
	t.Helper()
	root := t.TempDir()
	return NewStore(root)
}

// TestEncryptedFlagRoundTrip: the flag persists through meta, and a space
// created the plaintext way (or a legacy meta with no such field) reads false.
func TestEncryptedFlagRoundTrip(t *testing.T) {
	s := newEncStore(t)

	enc, err := s.CreateEncrypted("secret", "Secret", "admin")
	if err != nil {
		t.Fatalf("CreateEncrypted: %v", err)
	}
	if !enc.Encrypted {
		t.Fatalf("CreateEncrypted returned Encrypted=false")
	}
	got, err := s.Get("secret")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.Encrypted {
		t.Errorf("encrypted flag did not round-trip through meta")
	}

	plain, err := s.Create("plain", "Plain", "admin")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if plain.Encrypted {
		t.Errorf("plaintext space reports Encrypted=true")
	}

	// Legacy meta: an older meta.json has no "encrypted" key at all.
	legacyDir := filepath.Join(s.MetaDir("legacy"))
	if err := os.MkdirAll(legacyDir, 0o750); err != nil {
		t.Fatal(err)
	}
	legacy := `{"id":"legacy","name":"Legacy","created_at":"2020-01-01T00:00:00Z","updated_at":"2020-01-01T00:00:00Z","owner":"admin"}`
	if err := os.WriteFile(filepath.Join(legacyDir, "meta.json"), []byte(legacy), 0o640); err != nil {
		t.Fatal(err)
	}
	lm, err := s.Get("legacy")
	if err != nil {
		t.Fatalf("Get legacy: %v", err)
	}
	if lm.Encrypted {
		t.Errorf("legacy meta without the field should default to Encrypted=false")
	}
}

func TestValidEncID(t *testing.T) {
	valid := []string{
		"abcdef01",                            // 8 (min)
		"0123456789abcdef",                    // 16
		"deadbeefdeadbeef",                    // 16
		string(bytes.Repeat([]byte("a"), 64)), // 64 (max)
	}
	for _, id := range valid {
		if !ValidEncID(id) {
			t.Errorf("ValidEncID(%q) = false, want true", id)
		}
	}
	invalid := []string{
		"",                                    // empty
		"abc",                                 // too short (<8)
		"ff",                                  // too short
		"ABCDEF01",                            // uppercase
		"abcdefg1",                            // non-hex 'g'
		"../etc",                              // traversal
		"..",                                  // dotdot
		"blobs/x",                             // slash
		"abcd 1234",                           // space
		string(bytes.Repeat([]byte("a"), 65)), // 65 (overlong)
	}
	for _, id := range invalid {
		if ValidEncID(id) {
			t.Errorf("ValidEncID(%q) = true, want false", id)
		}
	}
}

func TestBlobRoundTripAndIDValidation(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.CreateEncrypted("spc", "spc", "admin"); err != nil {
		t.Fatal(err)
	}

	blobID := "deadbeefcafe0011"
	payload := []byte{0x00, 0x01, 0xff, 0xfe, 0x42, 0x00, 0x99}
	if err := s.WriteBlob("spc", blobID, bytes.NewReader(payload), encMax); err != nil {
		t.Fatalf("WriteBlob: %v", err)
	}
	got, err := s.ReadBlob("spc", blobID)
	if err != nil {
		t.Fatalf("ReadBlob: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("blob bytes not identical: got %x want %x", got, payload)
	}

	// The blob is stored under files/blobs/<id> (versioned but opaque).
	if _, err := os.Stat(filepath.Join(s.FilesDir("spc"), "blobs", blobID)); err != nil {
		t.Errorf("blob not at files/blobs/<id>: %v", err)
	}

	if err := s.DeleteBlob("spc", blobID); err != nil {
		t.Fatalf("DeleteBlob: %v", err)
	}
	if _, err := s.ReadBlob("spc", blobID); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("ReadBlob after delete: got %v, want fs.ErrNotExist", err)
	}

	// Bad ids are rejected before any filesystem access, on every verb.
	for _, bad := range []string{"../../etc/passwd", "..", "ABCDEF01", "xyz", "abc", string(bytes.Repeat([]byte("a"), 65)), "a/b"} {
		if err := s.WriteBlob("spc", bad, bytes.NewReader(payload), encMax); !errors.Is(err, ErrInvalidEncID) {
			t.Errorf("WriteBlob(%q) = %v, want ErrInvalidEncID", bad, err)
		}
		if _, err := s.ReadBlob("spc", bad); !errors.Is(err, ErrInvalidEncID) {
			t.Errorf("ReadBlob(%q) = %v, want ErrInvalidEncID", bad, err)
		}
		if err := s.DeleteBlob("spc", bad); !errors.Is(err, ErrInvalidEncID) {
			t.Errorf("DeleteBlob(%q) = %v, want ErrInvalidEncID", bad, err)
		}
	}
}

func TestOpAppendMonotonicAndSince(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.CreateEncrypted("spc", "spc", "admin"); err != nil {
		t.Fatal(err)
	}

	ids := []string{"aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"}
	for i, id := range ids {
		seq, err := s.AppendOp("spc", id, []byte("op-"+id), encMax)
		if err != nil {
			t.Fatalf("AppendOp %d: %v", i, err)
		}
		if want := int64(i + 1); seq != want {
			t.Errorf("AppendOp #%d seq = %d, want %d", i, seq, want)
		}
	}

	all, err := s.ListOps("spc", 0)
	if err != nil {
		t.Fatalf("ListOps: %v", err)
	}
	if len(all) != len(ids) {
		t.Fatalf("ListOps(0) len = %d, want %d", len(all), len(ids))
	}
	for i, rec := range all {
		if rec.Seq != int64(i+1) {
			t.Errorf("ListOps order: rec[%d].Seq = %d, want %d", i, rec.Seq, i+1)
		}
		if rec.OpID != ids[i] {
			t.Errorf("ListOps rec[%d].OpID = %q, want %q", i, rec.OpID, ids[i])
		}
		if string(rec.Blob) != "op-"+ids[i] {
			t.Errorf("ListOps rec[%d].Blob = %q, want %q", i, rec.Blob, "op-"+ids[i])
		}
	}

	since, err := s.ListOps("spc", 2)
	if err != nil {
		t.Fatalf("ListOps since=2: %v", err)
	}
	if len(since) != 3 {
		t.Fatalf("ListOps(2) len = %d, want 3", len(since))
	}
	for i, rec := range since {
		if rec.Seq != int64(i+3) {
			t.Errorf("ListOps(2) rec[%d].Seq = %d, want %d", i, rec.Seq, i+3)
		}
	}
}

// TestOpAppendConcurrent is the core blind-server invariant: two concurrent
// appends must both succeed with distinct seqs, none lost, none duplicated.
func TestOpAppendConcurrent(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.CreateEncrypted("spc", "spc", "admin"); err != nil {
		t.Fatal(err)
	}

	const n = 200
	var wg sync.WaitGroup
	var mu sync.Mutex
	seqs := make([]int64, 0, n)
	errs := make([]error, 0)

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Unique 16-hex opId per goroutine.
			id := make([]byte, 16)
			for j := range id {
				id[j] = "0123456789abcdef"[(i*7+j)%16]
			}
			seq, err := s.AppendOp("spc", string(id), []byte{byte(i)}, encMax)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return
			}
			seqs = append(seqs, seq)
		}(i)
	}
	wg.Wait()

	if len(errs) != 0 {
		t.Fatalf("append errors: %v", errs)
	}
	if len(seqs) != n {
		t.Fatalf("got %d seqs, want %d", len(seqs), n)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	for i, sq := range seqs {
		if sq != int64(i+1) {
			t.Fatalf("seqs not a dense 1..N set: seqs[%d] = %d, want %d (collision or gap)", i, sq, i+1)
		}
	}

	// Every append landed as a distinct file — no overwrite.
	got, err := s.ListOps("spc", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != n {
		t.Errorf("ListOps returned %d ops, want %d (an append was lost)", len(got), n)
	}
}

// TestSeqSurvivesRestart: a fresh Store over the same dir seeds the sequencer
// from disk, so seq keeps climbing rather than colliding.
func TestSeqSurvivesRestart(t *testing.T) {
	root := t.TempDir()
	s1 := NewStore(root)
	if _, err := s1.CreateEncrypted("spc", "spc", "admin"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := s1.AppendOp("spc", "aaaaaaaa", []byte("x"), encMax); err != nil {
			t.Fatal(err)
		}
	}
	s2 := NewStore(root) // simulate process restart
	seq, err := s2.AppendOp("spc", "bbbbbbbb", []byte("y"), encMax)
	if err != nil {
		t.Fatal(err)
	}
	if seq != 4 {
		t.Errorf("post-restart seq = %d, want 4 (should seed from disk max)", seq)
	}
}

func TestCheckpointRoundTrip(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.CreateEncrypted("spc", "spc", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadCheckpoint("spc"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("ReadCheckpoint before write: got %v, want fs.ErrNotExist", err)
	}
	cp1 := []byte("encrypted-checkpoint-v1\x00\xff")
	if err := s.WriteCheckpoint("spc", bytes.NewReader(cp1), encMax); err != nil {
		t.Fatal(err)
	}
	got, err := s.ReadCheckpoint("spc")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, cp1) {
		t.Errorf("checkpoint mismatch: got %x want %x", got, cp1)
	}
	cp2 := []byte("encrypted-checkpoint-v2")
	if err := s.WriteCheckpoint("spc", bytes.NewReader(cp2), encMax); err != nil {
		t.Fatal(err)
	}
	got, _ = s.ReadCheckpoint("spc")
	if !bytes.Equal(got, cp2) {
		t.Errorf("checkpoint not overwritten: got %x want %x", got, cp2)
	}
}

func TestKeyRecordRoundTrip(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.CreateEncrypted("spc", "spc", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadKeyRecord("spc"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("ReadKeyRecord before write: got %v, want fs.ErrNotExist", err)
	}
	rec := []byte(`{"version":1,"kdf":{"m":19456},"kdfSalt":"AAAA"}`)
	if err := s.WriteKeyRecord("spc", rec); err != nil {
		t.Fatal(err)
	}
	got, err := s.ReadKeyRecord("spc")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, rec) {
		t.Errorf("key record mismatch: got %s want %s", got, rec)
	}
	// It lives in .notation/, OUTSIDE files/ (never committed to the git repo).
	if _, err := os.Stat(filepath.Join(s.MetaDir("spc"), "spacekey.json")); err != nil {
		t.Errorf("key record not at .notation/spacekey.json: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.FilesDir("spc"), "spacekey.json")); err == nil {
		t.Errorf("key record leaked into files/ (would be git-committed)")
	}
}
