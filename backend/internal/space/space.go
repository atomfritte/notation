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
	ErrNotFound  = errors.New("space not found")
	ErrExists    = errors.New("space already exists")
	ErrInvalidID = errors.New("invalid space id")
)

// idPattern: lowercase alnum + - + _, length 3-32, must start and end with alnum.
var idPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$`)

type Meta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Owner     string    `json:"owner"`
}

type Store struct {
	root string
	mu   sync.Mutex // serializes create/delete; per-file ops use OS atomicity
}

func NewStore(rootDir string) *Store {
	return &Store{root: rootDir}
}

func (s *Store) List() ([]Meta, error) {
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

func (s *Store) Create(id, name, owner string) (Meta, error) {
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
	meta := Meta{ID: id, Name: strings.TrimSpace(name), CreatedAt: now, UpdatedAt: now, Owner: owner}
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
	return s.readMeta(id)
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
