package space

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// This file implements the storage backend for a zero-knowledge ("encrypted")
// Space. The server is BLIND: it stores and serves opaque ciphertext bytes and
// never holds, derives, or needs the space key. The on-disk layout, all inside
// the space's files/ dir (so git versions it) except the key record:
//
//	files/blobs/<id>              opaque ciphertext content blobs
//	files/ops/<seq>-<opId>        append-only op-log; <seq> is a server-assigned,
//	                              zero-padded monotonic integer for fetch ordering
//	files/checkpoint              latest encrypted checkpoint blob (overwritten)
//	.notation/spacekey.json       the client's SpaceKeyRecord (KDF params, salt,
//	                              wrapped DEKs) — non-secret, stored as-is
//
// blobs/ and ops/ are NOT dotfiles, so they pass SafeJoin; every path is still
// routed through the existing os.Root sandbox (via ReadFile/WriteFile). Opaque
// ids are additionally validated against a strict hex charset before use as a
// path segment (defense in depth on top of SafeJoin).

var (
	// ErrNotEncrypted is returned when an enc-store operation targets a plaintext
	// Space. ErrEncrypted is its mirror: a plaintext file op targeting an
	// encrypted Space. The HTTP layer maps both to 409 Conflict.
	ErrNotEncrypted = errors.New("space is not encrypted")
	ErrEncrypted    = errors.New("space is encrypted")
	// ErrInvalidEncID marks an opaque id (blob id / op id) that fails the strict
	// safe-charset check.
	ErrInvalidEncID = errors.New("invalid opaque id")
)

// encIDPattern mirrors the client's SAFE_ID_RE (frontend/src/shared/vfs/ids.ts):
// 8–64 lowercase hex chars. Hex-only means an id is always a safe single path
// segment — no '/', '.', '..', whitespace, or case-folding hazard.
var encIDPattern = regexp.MustCompile(`^[0-9a-f]{8,64}$`)

// ValidEncID reports whether id is a well-formed opaque blob/op id.
func ValidEncID(id string) bool { return encIDPattern.MatchString(id) }

const (
	encBlobsDir  = "blobs"
	encOpsDir    = "ops"
	encCheckpt   = "checkpoint"
	encKeyRecord = "spacekey.json"
	// opSeqWidth zero-pads <seq> so op filenames sort lexicographically the same
	// way they sort numerically. 12 digits covers ~10^12 ops per space.
	opSeqWidth = 12
)

// seqCounter is a per-space append sequencer. It is seeded lazily from disk (so
// counts survive a restart) and then advanced purely in memory. Its mutex is
// held across the whole read-assign-write-increment so two concurrent appends
// can never be handed the same seq.
type seqCounter struct {
	mu     sync.Mutex
	next   int64
	seeded bool
}

func (s *Store) seqCounterFor(spaceID string) *seqCounter {
	s.encMu.Lock()
	defer s.encMu.Unlock()
	if s.encSeq == nil {
		s.encSeq = make(map[string]*seqCounter)
	}
	c, ok := s.encSeq[spaceID]
	if !ok {
		c = &seqCounter{}
		s.encSeq[spaceID] = c
	}
	return c
}

// ---- content blobs ----

// WriteBlob stores an opaque ciphertext blob under files/blobs/<blobID>.
// The write reuses WriteFile, so it inherits the os.Root sandbox, the size cap,
// and atomic temp+rename semantics.
func (s *Store) WriteBlob(spaceID, blobID string, r io.Reader, maxBytes int64) error {
	if !ValidEncID(blobID) {
		return ErrInvalidEncID
	}
	_, err := s.WriteFile(spaceID, encBlobsDir+"/"+blobID, r, maxBytes)
	return err
}

// ReadBlob returns the raw ciphertext bytes of a blob (fs.ErrNotExist if none).
func (s *Store) ReadBlob(spaceID, blobID string) ([]byte, error) {
	if !ValidEncID(blobID) {
		return nil, ErrInvalidEncID
	}
	return s.ReadFile(spaceID, encBlobsDir+"/"+blobID)
}

// DeleteBlob removes a blob (fs.ErrNotExist if none).
func (s *Store) DeleteBlob(spaceID, blobID string) error {
	if !ValidEncID(blobID) {
		return ErrInvalidEncID
	}
	return s.DeleteFile(spaceID, encBlobsDir+"/"+blobID)
}

// ---- checkpoint ----

// WriteCheckpoint overwrites the single encrypted checkpoint blob.
func (s *Store) WriteCheckpoint(spaceID string, r io.Reader, maxBytes int64) error {
	_, err := s.WriteFile(spaceID, encCheckpt, r, maxBytes)
	return err
}

// ReadCheckpoint returns the checkpoint bytes (fs.ErrNotExist if none yet).
func (s *Store) ReadCheckpoint(spaceID string) ([]byte, error) {
	return s.ReadFile(spaceID, encCheckpt)
}

// ---- op-log ----

// OpRecord is one op-log entry as returned to a client fetching ops. Blob is a
// []byte, which encoding/json base64-encodes automatically.
type OpRecord struct {
	Seq  int64  `json:"seq"`
	OpID string `json:"opId"`
	Blob []byte `json:"blob"`
}

// AppendOp appends one opaque op envelope to the log and returns its
// server-assigned monotonic seq. It is concurrency-safe: the per-space
// sequencer mutex is held across the whole assign+write, so two concurrent
// appends receive two distinct seqs and neither is rejected — the blind server
// never refuses an append. seq is consumed only on a successful write, so a
// failed write leaves no gap.
func (s *Store) AppendOp(spaceID, opID string, data []byte, maxBytes int64) (int64, error) {
	if !ValidEncID(opID) {
		return 0, ErrInvalidEncID
	}
	if int64(len(data)) > maxBytes {
		return 0, ErrFileTooBig
	}
	c := s.seqCounterFor(spaceID)
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.seeded {
		max, err := s.maxOpSeq(spaceID)
		if err != nil {
			return 0, err
		}
		c.next = max + 1
		c.seeded = true
	}
	seq := c.next
	name := fmt.Sprintf("%s/%0*d-%s", encOpsDir, opSeqWidth, seq, opID)
	if _, err := s.WriteFile(spaceID, name, bytes.NewReader(data), maxBytes); err != nil {
		return 0, err
	}
	c.next++
	return seq, nil
}

// ListOps returns every op-log entry with seq > since, ordered by seq ascending.
func (s *Store) ListOps(spaceID string, since int64) ([]OpRecord, error) {
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	names, err := listDirNames(root, encOpsDir)
	root.Close()
	if err != nil {
		return nil, err
	}
	out := make([]OpRecord, 0, len(names))
	for _, name := range names {
		seq, opID, ok := parseOpName(name)
		if !ok || seq <= since {
			continue
		}
		data, err := s.ReadFile(spaceID, encOpsDir+"/"+name)
		if err != nil {
			// A concurrently-deleted entry (or a stray file) shouldn't abort the
			// whole fetch — skip it.
			continue
		}
		out = append(out, OpRecord{Seq: seq, OpID: opID, Blob: data})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out, nil
}

// maxOpSeq returns the highest seq currently on disk (0 if the log is empty).
func (s *Store) maxOpSeq(spaceID string) (int64, error) {
	root, err := s.openRoot(spaceID)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	names, err := listDirNames(root, encOpsDir)
	if err != nil {
		return 0, err
	}
	var max int64
	for _, name := range names {
		if seq, _, ok := parseOpName(name); ok && seq > max {
			max = seq
		}
	}
	return max, nil
}

// parseOpName splits a "<seq>-<opId>" op filename. The opId is re-validated so a
// stray/hand-crafted file in ops/ is ignored rather than served.
func parseOpName(name string) (seq int64, opID string, ok bool) {
	i := strings.IndexByte(name, '-')
	if i <= 0 || i == len(name)-1 {
		return 0, "", false
	}
	n, err := strconv.ParseInt(name[:i], 10, 64)
	if err != nil || n < 0 {
		return 0, "", false
	}
	opID = name[i+1:]
	if !ValidEncID(opID) {
		return 0, "", false
	}
	return n, opID, true
}

// listDirNames lists the (non-dot) entry names of dir inside the os.Root
// sandbox. A missing directory yields an empty slice, not an error.
func listDirNames(root *os.Root, dir string) ([]string, error) {
	f, err := root.Open(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	items, err := f.ReadDir(-1)
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for _, it := range items {
		if strings.HasPrefix(it.Name(), ".") {
			continue // skip temp files (.tmp-*) and any dotfile
		}
		out = append(out, it.Name())
	}
	return out, nil
}

// ---- key record (non-secret SpaceKeyRecord passthrough) ----

// WriteKeyRecord persists the client's SpaceKeyRecord JSON at
// .notation/spacekey.json. It is non-secret (no key material is recoverable
// without the password or recovery key), so it is stored as-is — but it lives
// alongside meta.json, OUTSIDE the git repo (files/), so it is never committed.
func (s *Store) WriteKeyRecord(spaceID string, data []byte) error {
	if !ValidID(spaceID) {
		return ErrInvalidID
	}
	path := filepath.Join(s.MetaDir(spaceID), encKeyRecord)
	return atomicWrite(path, data, 0o640)
}

// ReadKeyRecord returns the stored SpaceKeyRecord JSON (fs.ErrNotExist if none).
func (s *Store) ReadKeyRecord(spaceID string) ([]byte, error) {
	if !ValidID(spaceID) {
		return nil, ErrInvalidID
	}
	return os.ReadFile(filepath.Join(s.MetaDir(spaceID), encKeyRecord))
}
