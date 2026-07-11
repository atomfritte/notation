// Package space owns the on-disk representation of a Space:
//
//	<data-dir>/spaces/<id>/
//	  files/                user content (tree + read/write APIs operate here)
//	  .notation/
//	    meta.json           Space metadata
//	    shares.json         magic-link tokens (stage 5)
//	    mcp.json            MCP tokens (stage 7)
//	    audit.log           append-only audit (stages 5/7)
package space

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotFound     = errors.New("space not found")
	ErrExists       = errors.New("space already exists")
	ErrInvalidID    = errors.New("invalid space id")
	ErrInvalidBoard = errors.New("invalid board status")
)

// idPattern: lowercase alnum + - + _, length 3-32, must start and end with alnum.
var idPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$`)

// ValidID reports whether id is a syntactically valid Space id. Exported so
// other packages that build filesystem paths from a Space id (mcptoken, share)
// can reject traversal/garbage at their own trust boundary instead of relying
// solely on the HTTP layer having called Get/Create first.
func ValidID(id string) bool { return idPattern.MatchString(id) }

type Meta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Owner     string    `json:"owner"`
	// Status is the Kanban column the space lives in on the landing-page board.
	// Empty means "untriaged" — the frontend renders those in the Inbox column.
	Status string `json:"status,omitempty"`
	// Order is the manual sort rank within a column (ascending). 0 is the
	// default for never-dragged spaces; the frontend tie-breaks equal ranks by
	// created_at descending so freshly created spaces float to the top.
	Order int `json:"order,omitempty"`
	// Encrypted marks a zero-knowledge space: its files/ dir holds only opaque
	// ciphertext (content blobs + an append-only op-log + a checkpoint) that the
	// server never decrypts. Such a space is a blob store, NOT a plaintext
	// filesystem — the two are mutually exclusive, enforced at the HTTP layer.
	// Absent in metas written before this field existed, so legacy spaces read
	// back as false (plaintext). Always serialized (no omitempty) so the GET
	// response is explicit about a space's mode.
	Encrypted bool `json:"encrypted"`
}

// boardStatuses is the closed set of Kanban columns a space may be assigned to.
// The empty string is also accepted (it means "untriaged" → Inbox).
var boardStatuses = map[string]bool{"": true, "inbox": true, "backlog": true, "active": true, "archive": true}

// ValidBoardStatus reports whether s is an allowed Kanban column. Exported so the
// HTTP layer can reject garbage before it ever reaches the store.
func ValidBoardStatus(s string) bool { return boardStatuses[s] }

// BoardUpdate is one card's new column + sort rank, applied by SetBoardBatch.
type BoardUpdate struct {
	ID     string
	Status string
	Order  int
}

type Store struct {
	root string
	// mu guards metadata consistency: writers (Create/Delete/SetBoardBatch) take
	// the write lock; readers (List/Get) take the read lock so a concurrent batch
	// board update can't expose a half-applied view. Per-file content ops still
	// rely on OS atomicity, not this lock.
	mu sync.RWMutex
	// encMu guards the encSeq map only (a short critical section to fetch/create
	// a space's op-log sequencer). The sequencer's own mutex — not encMu — is
	// held across the append, so different encrypted spaces append concurrently.
	encMu  sync.Mutex
	encSeq map[string]*seqCounter
}

func NewStore(rootDir string) *Store {
	return &Store{root: rootDir}
}

func (s *Store) List() ([]Meta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries, err := os.ReadDir(s.root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []Meta{}, nil
		}
		return nil, err
	}
	out := make([]Meta, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		meta, err := s.readMeta(e.Name())
		if err != nil {
			continue // skip malformed dirs
		}
		out = append(out, meta)
	}
	return out, nil
}

// Create provisions a normal plaintext Space (files/ is a versioned filesystem).
func (s *Store) Create(id, name, owner string) (Meta, error) {
	return s.create(id, name, owner, false)
}

// CreateEncrypted provisions a zero-knowledge Space: the on-disk layout is
// identical (files/ + .notation/), but its Meta is flagged Encrypted so the
// HTTP layer routes it to the opaque blob/op-log store instead of the plaintext
// file APIs. The files/ dir starts empty — it fills with ciphertext blobs and
// op-log entries the server never decrypts.
func (s *Store) CreateEncrypted(id, name, owner string) (Meta, error) {
	return s.create(id, name, owner, true)
}

func (s *Store) create(id, name, owner string, encrypted bool) (Meta, error) {
	id = strings.ToLower(strings.TrimSpace(id))
	if !idPattern.MatchString(id) {
		return Meta{}, ErrInvalidID
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	spaceDir := filepath.Join(s.root, id)
	if _, err := os.Stat(spaceDir); err == nil {
		return Meta{}, ErrExists
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Meta{}, err
	}
	if err := os.MkdirAll(filepath.Join(spaceDir, "files"), 0o750); err != nil {
		return Meta{}, err
	}
	if err := os.MkdirAll(filepath.Join(spaceDir, ".notation"), 0o750); err != nil {
		return Meta{}, err
	}
	now := time.Now().UTC()
	if strings.TrimSpace(name) == "" {
		name = id
	}
	meta := Meta{ID: id, Name: strings.TrimSpace(name), CreatedAt: now, UpdatedAt: now, Owner: owner, Encrypted: encrypted}
	if err := s.writeMeta(id, meta); err != nil {
		return Meta{}, err
	}
	return meta, nil
}

func (s *Store) Delete(id string) error {
	id = strings.ToLower(strings.TrimSpace(id))
	if !idPattern.MatchString(id) {
		return ErrInvalidID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	spaceDir := filepath.Join(s.root, id)
	if _, err := os.Stat(spaceDir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return os.RemoveAll(spaceDir)
}

func (s *Store) Get(id string) (Meta, error) {
	id = strings.ToLower(strings.TrimSpace(id))
	if !idPattern.MatchString(id) {
		return Meta{}, ErrInvalidID
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.readMeta(id)
}

// SetBoardBatch atomically-ish applies a set of Kanban column/order changes
// (one drag on the landing page typically touches the source + target columns).
// It validates every update — id syntax, known status, and that the space still
// exists — in a first pass before writing anything, so a single bad entry can't
// leave the board half-updated. UpdatedAt is bumped on every touched space.
func (s *Store) SetBoardBatch(updates []BoardUpdate) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	metas := make([]Meta, len(updates))
	seen := make(map[string]bool, len(updates))
	for i, u := range updates {
		id := strings.ToLower(strings.TrimSpace(u.ID))
		if !idPattern.MatchString(id) {
			return ErrInvalidID
		}
		if !ValidBoardStatus(u.Status) {
			return ErrInvalidBoard
		}
		// Negative ranks would sort ahead of untriaged (order 0) cards and have no
		// legitimate use; reject so a hand-crafted request can't scramble the board.
		if u.Order < 0 {
			return ErrInvalidBoard
		}
		// A single batch addressing the same space twice would silently last-write-
		// wins; reject it so the caller's intent is never ambiguous.
		if seen[id] {
			return ErrInvalidID
		}
		seen[id] = true
		m, err := s.readMeta(id)
		if err != nil {
			return err
		}
		m.Status = u.Status
		m.Order = u.Order
		metas[i] = m
	}
	now := time.Now().UTC()
	for i := range metas {
		metas[i].UpdatedAt = now
		if err := s.writeMeta(metas[i].ID, metas[i]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) readMeta(id string) (Meta, error) {
	path := filepath.Join(s.root, id, ".notation", "meta.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Meta{}, ErrNotFound
		}
		return Meta{}, err
	}
	var m Meta
	if err := json.Unmarshal(data, &m); err != nil {
		return Meta{}, fmt.Errorf("meta: %w", err)
	}
	return m, nil
}

func (s *Store) writeMeta(id string, m Meta) error {
	path := filepath.Join(s.root, id, ".notation", "meta.json")
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, data, 0o640)
}

func (s *Store) Root(id string) string     { return filepath.Join(s.root, id) }
func (s *Store) FilesDir(id string) string { return filepath.Join(s.root, id, "files") }
func (s *Store) MetaDir(id string) string  { return filepath.Join(s.root, id, ".notation") }

// atomicWrite writes data to a tmp file in path's directory, then renames.
func atomicWrite(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
