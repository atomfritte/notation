package space

// Conversion between a plaintext Space and a zero-knowledge (encrypted) one, and
// back. This is the ONLY destructive operation in the feature: it purges the
// other-mode content and (via gitrepo.Reinit, driven by the HTTP layer) wipes
// git history so the pre-conversion bytes don't survive.
//
// The safety model lives in Meta.Converting. While it is set, the HTTP gate is
// relaxed so the client can read the SOURCE mode and stage the TARGET mode at
// the same time. Plaintext is destroyed only by FinishConvert, which runs after
// the client has fully uploaded the ciphertext (and its key record), so a crash
// or abort at any earlier point leaves the original mode intact.

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Conversion direction markers stored in Meta.Converting.
const (
	ConvertToEncrypted = "to-encrypted"
	ConvertToPlaintext = "to-plaintext"
)

// ErrConvertState marks an illegal conversion request: a bad direction, a
// direction that contradicts the current mode, or a conversion started while one
// is already in progress. The HTTP layer maps it to 409 Conflict.
var ErrConvertState = errors.New("invalid conversion state")

// reservedEncNames are the top-level names the blind encrypted store occupies
// inside files/. A plaintext space that already has a top-level entry with one of
// these names would collide with the ciphertext layout, so to-encrypted refuses
// up front rather than silently mixing the two.
func reservedEncNames() map[string]bool {
	return map[string]bool{encBlobsDir: true, encOpsDir: true, encCheckpt: true}
}

// BeginConvert sets the transient conversion marker. It validates the direction
// against the current mode and refuses if a conversion is already in progress.
// NON-destructive: only meta.json changes.
func (s *Store) BeginConvert(id, direction string) error {
	if direction != ConvertToEncrypted && direction != ConvertToPlaintext {
		return ErrConvertState
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(id)
	if err != nil {
		return err
	}
	if m.Converting != "" {
		return ErrConvertState
	}
	if direction == ConvertToEncrypted && m.Encrypted {
		return ErrConvertState
	}
	if direction == ConvertToPlaintext && !m.Encrypted {
		return ErrConvertState
	}
	m.Converting = direction
	m.UpdatedAt = time.Now().UTC()
	return s.writeMeta(id, m)
}

// AbortConvert clears the marker and removes the staged data for the in-progress
// direction, leaving the space in its ORIGINAL mode fully intact. Safe to call at
// any point mid-conversion; a space that isn't converting is left untouched.
func (s *Store) AbortConvert(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(id)
	if err != nil {
		return err
	}
	switch m.Converting {
	case ConvertToEncrypted:
		// Discard staged ciphertext; the plaintext source is untouched.
		if err := s.purgeEncArtifacts(id); err != nil {
			return err
		}
	case ConvertToPlaintext:
		// Discard staged decrypted plaintext; the ciphertext is untouched.
		if err := s.purgePlaintextContent(id); err != nil {
			return err
		}
	default:
		return nil // not converting — nothing to clean, nothing to clear.
	}
	m.Converting = ""
	m.UpdatedAt = time.Now().UTC()
	return s.writeMeta(id, m)
}

// FinishConvert flips the encrypted flag and clears the conversion marker in one
// atomic meta write. The HTTP finalize handler calls it LAST, after the
// other-mode content has been purged and git history re-initialised.
func (s *Store) FinishConvert(id string, encrypted bool) (Meta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(id)
	if err != nil {
		return Meta{}, err
	}
	m.Encrypted = encrypted
	m.Converting = ""
	m.UpdatedAt = time.Now().UTC()
	if err := s.writeMeta(id, m); err != nil {
		return Meta{}, err
	}
	return m, nil
}

// HasReservedTopLevel reports whether the plaintext files/ dir already contains a
// top-level entry named like one of the encrypted store's reserved dirs/files
// (blobs, ops, checkpoint) — which would collide with the ciphertext layout.
func (s *Store) HasReservedTopLevel(id string) (bool, error) {
	if !ValidID(id) {
		return false, ErrInvalidID
	}
	entries, err := os.ReadDir(s.FilesDir(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	reserved := reservedEncNames()
	for _, e := range entries {
		if reserved[e.Name()] {
			return true, nil
		}
	}
	return false, nil
}

// CountPlaintextFiles counts regular files under files/ EXCLUDING the encrypted
// store's reserved artifacts (blobs/, ops/, checkpoint) and the git dir. Used to
// guard to-plaintext finalize against being called before anything was staged.
func (s *Store) CountPlaintextFiles(id string) (int, error) {
	if !ValidID(id) {
		return 0, ErrInvalidID
	}
	base := s.FilesDir(id)
	skip := reservedEncNames()
	skip[".git"] = true
	entries, err := os.ReadDir(base)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	count := 0
	for _, e := range entries {
		if skip[e.Name()] {
			continue
		}
		if e.IsDir() {
			n, err := countFilesUnder(filepath.Join(base, e.Name()))
			if err != nil {
				return 0, err
			}
			count += n
		} else if e.Type().IsRegular() {
			count++
		}
	}
	return count, nil
}

func countFilesUnder(dir string) (int, error) {
	count := 0
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			count++
		}
		return nil
	})
	return count, err
}

// HasEncContent reports whether any op-log entries or content blobs exist — i.e.
// the space actually holds encrypted content that a decrypt should have staged.
func (s *Store) HasEncContent(id string) (bool, error) {
	root, err := s.openRoot(id)
	if err != nil {
		return false, err
	}
	defer root.Close()
	for _, dir := range []string{encOpsDir, encBlobsDir} {
		names, err := listDirNames(root, dir)
		if err != nil {
			return false, err
		}
		if len(names) > 0 {
			return true, nil
		}
	}
	return false, nil
}

// PurgeEncArtifacts deletes the blind store's ciphertext artifacts: files/blobs,
// files/ops, files/checkpoint, and the key record at .notation/spacekey.json. It
// also resets the in-memory op sequencer so a later encryption run starts at 1.
// Used to abort a to-encrypted conversion and to finalize a to-plaintext one.
func (s *Store) PurgeEncArtifacts(id string) error { return s.purgeEncArtifacts(id) }

func (s *Store) purgeEncArtifacts(id string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	base := s.FilesDir(id)
	for _, name := range []string{encBlobsDir, encOpsDir, encCheckpt} {
		if err := os.RemoveAll(filepath.Join(base, name)); err != nil {
			return err
		}
	}
	if err := os.Remove(filepath.Join(s.MetaDir(id), encKeyRecord)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	s.resetSeqCounter(id)
	return nil
}

// PurgePlaintextContent deletes every top-level entry under files/ EXCEPT the
// ciphertext artifacts (blobs/, ops/, checkpoint) and the git dir. Used to purge
// the plaintext tree when finalizing to-encrypted, and to discard staged
// plaintext when aborting to-plaintext.
func (s *Store) PurgePlaintextContent(id string) error { return s.purgePlaintextContent(id) }

func (s *Store) purgePlaintextContent(id string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	base := s.FilesDir(id)
	entries, err := os.ReadDir(base)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	keep := reservedEncNames()
	keep[".git"] = true
	for _, e := range entries {
		if keep[e.Name()] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(base, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// legacyServerMetadata are the server-written plaintext sidecars that live in
// .notation/ — OUTSIDE files/, so purgePlaintextContent never reached them. For
// an encrypted space they are a zero-knowledge leak: comments.jsonl holds file
// PATHS + comment text + authors + anchor quotes, and audit.log holds file
// paths + IPs. They are purged when a space is encrypted, and swept from spaces
// that were encrypted before this cleanup existed. Comments are migrated into
// the encrypted op-log by the client BEFORE the purge (audit.log is a
// server-only tamper-evidence log and is simply dropped — the server has no key
// to re-encrypt it, and no new entries are written for an encrypted space).
var legacyServerMetadata = []string{"comments.jsonl", "audit.log"}

// PurgeLegacyServerMetadata deletes the plaintext comment + audit sidecars from
// a space's .notation/ dir. Idempotent: a missing file is not an error.
func (s *Store) PurgeLegacyServerMetadata(id string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	dir := s.MetaDir(id)
	for _, name := range legacyServerMetadata {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// HasLegacyServerMetadata reports whether either plaintext sidecar still exists,
// so the client can decide whether a one-time migrate+purge sweep is needed.
func (s *Store) HasLegacyServerMetadata(id string) (comments, audit bool, err error) {
	if !ValidID(id) {
		return false, false, ErrInvalidID
	}
	dir := s.MetaDir(id)
	stat := func(name string) (bool, error) {
		_, statErr := os.Stat(filepath.Join(dir, name))
		if statErr == nil {
			return true, nil
		}
		if errors.Is(statErr, fs.ErrNotExist) {
			return false, nil
		}
		return false, statErr
	}
	if comments, err = stat("comments.jsonl"); err != nil {
		return false, false, err
	}
	audit, err = stat("audit.log")
	return comments, audit, err
}

// ListFilePaths returns every regular file under files/ as a flat list of
// slash-delimited paths, EXCLUDING dotfiles/dirs (so .git and .tmp-* are skipped)
// and the encrypted store's reserved artifacts (blobs/, ops/, checkpoint). Unlike
// Tree it does NOT collapse form folders, so a to-encrypted conversion copies
// EVERY file (form templates + entries included) — nothing is silently dropped.
func (s *Store) ListFilePaths(id string) ([]string, error) {
	if !ValidID(id) {
		return nil, ErrInvalidID
	}
	base := s.FilesDir(id)
	reserved := reservedEncNames()
	var out []string
	err := filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(base, p)
		if relErr != nil {
			return relErr
		}
		if rel == "." {
			return nil
		}
		name := d.Name()
		// Skip dotfiles/dirs (.git, .tmp-*) and, at the top level, the ciphertext
		// artifacts — never part of the plaintext content set.
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.Contains(filepath.ToSlash(rel), "/") && reserved[name] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // skip symlinks / irregular entries
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// resetSeqCounter drops the in-memory op sequencer for a space so the next append
// re-seeds from disk (0 once the ops dir has been purged → the next op is seq 1).
func (s *Store) resetSeqCounter(spaceID string) {
	s.encMu.Lock()
	defer s.encMu.Unlock()
	delete(s.encSeq, spaceID)
}
