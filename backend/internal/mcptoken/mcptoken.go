// Package mcptoken stores per-Space Bearer tokens that grant MCP access.
// Storage mirrors the share package but is intentionally separate so MCP
// credentials cannot be confused with share-link tokens. Tokens are 32 random
// bytes (base64url), hashed with SHA-256 before persistence; constant-time
// compare on lookup.
package mcptoken

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/yoogie27/notation/internal/space"
)

type Token struct {
	ID        string     `json:"id"`
	Hash      string     `json:"hash"`
	Label     string     `json:"label"`
	CreatedAt time.Time  `json:"created_at"`
	CreatedBy string     `json:"created_by"`
	LastUsed  *time.Time `json:"last_used,omitempty"`
}

type View struct {
	ID        string     `json:"id"`
	Label     string     `json:"label"`
	CreatedAt time.Time  `json:"created_at"`
	CreatedBy string     `json:"created_by"`
	LastUsed  *time.Time `json:"last_used,omitempty"`
}

func (t Token) View() View {
	return View{
		ID: t.ID, Label: t.Label, CreatedAt: t.CreatedAt,
		CreatedBy: t.CreatedBy, LastUsed: t.LastUsed,
	}
}

type CreateResult struct {
	Token View   `json:"token"`
	Raw   string `json:"raw"` // shown exactly once
}

var ErrNotFound = errors.New("mcp token not found")

type Store struct {
	spacesDir string
	mu        sync.Mutex
}

func NewStore(spacesDir string) *Store {
	return &Store{spacesDir: spacesDir}
}

func (s *Store) path(spaceID string) string {
	return filepath.Join(s.spacesDir, spaceID, ".notation", "mcp-tokens.json")
}

func (s *Store) load(spaceID string) ([]Token, error) {
	// Self-protect: never build a token-file path from an unvalidated id.
	// path() joins spaceID into the spaces dir, so a traversal id like
	// "../other" would otherwise read another location. Every public method
	// funnels through load(), so one guard here covers them all. (The MCP HTTP
	// handler also validates, but the store must not depend on that.)
	if !space.ValidID(spaceID) {
		return nil, ErrNotFound
	}
	data, err := os.ReadFile(s.path(spaceID))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []Token
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("mcp-tokens.json: %w", err)
	}
	return out, nil
}

func (s *Store) save(spaceID string, tokens []Token) error {
	path := s.path(spaceID)
	data, err := json.MarshalIndent(tokens, "", "  ")
	if err != nil {
		return err
	}
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
	if err := tmp.Chmod(0o640); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func (s *Store) List(spaceID string) ([]View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens, err := s.load(spaceID)
	if err != nil {
		return nil, err
	}
	out := make([]View, 0, len(tokens))
	for _, t := range tokens {
		out = append(out, t.View())
	}
	return out, nil
}

func (s *Store) Create(spaceID, label, createdBy string) (CreateResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens, err := s.load(spaceID)
	if err != nil {
		return CreateResult{}, err
	}
	raw := generateToken()
	t := Token{
		// ID is independent of the token — it appears in audit logs as the
		// MCP actor ("mcp:<id>"), so it must not embed token bytes.
		ID:        "mcp_" + randID(6),
		Hash:      hashToken(raw),
		Label:     label,
		CreatedAt: time.Now().UTC(),
		CreatedBy: createdBy,
	}
	tokens = append(tokens, t)
	if err := s.save(spaceID, tokens); err != nil {
		return CreateResult{}, err
	}
	return CreateResult{Token: t.View(), Raw: raw}, nil
}

func (s *Store) Delete(spaceID, tokenID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens, err := s.load(spaceID)
	if err != nil {
		return err
	}
	out := tokens[:0]
	found := false
	for _, t := range tokens {
		if t.ID == tokenID {
			found = true
			continue
		}
		out = append(out, t)
	}
	if !found {
		return ErrNotFound
	}
	return s.save(spaceID, out)
}

// Validate checks the provided raw token against the stored hashes for spaceID.
// Returns the token record on success; constant-time compare prevents timing
// leaks on tokens that happen to share a prefix.
func (s *Store) Validate(spaceID, raw string) (Token, error) {
	if raw == "" {
		return Token{}, ErrNotFound
	}
	h := hashToken(raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens, err := s.load(spaceID)
	if err != nil {
		return Token{}, err
	}
	for _, t := range tokens {
		if subtle.ConstantTimeCompare([]byte(t.Hash), []byte(h)) == 1 {
			return t, nil
		}
	}
	return Token{}, ErrNotFound
}

func (s *Store) TouchLastUsed(spaceID, tokenID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokens, err := s.load(spaceID)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	for i := range tokens {
		if tokens[i].ID == tokenID {
			tokens[i].LastUsed = &now
			_ = s.save(spaceID, tokens)
			return
		}
	}
}

func generateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// randID returns n bytes of crypto-random hex for record IDs that must not
// carry any bytes of the secret token.
func randID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
