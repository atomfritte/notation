// Package share owns magic-link tokens that grant scoped, time-bounded access
// to a Space. Tokens are 32 random bytes (base64url-encoded) shown to the
// admin exactly once. Only their SHA-256 hash is persisted on disk in
// <space>/.notation/shares.json — recovering a token from the stored data is
// not possible. Resolution is a constant-time hash compare across spaces.
package share

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
	"strings"
	"sync"
	"time"
)

type Permission string

const (
	PermissionRead    Permission = "read"
	PermissionComment Permission = "comment"
	PermissionEdit    Permission = "edit"
)

func ValidPermission(p Permission) bool {
	return p == PermissionRead || p == PermissionComment || p == PermissionEdit
}

func (p Permission) AllowsRead() bool {
	return p == PermissionRead || p == PermissionComment || p == PermissionEdit
}
func (p Permission) AllowsComment() bool { return p == PermissionComment || p == PermissionEdit }
func (p Permission) AllowsEdit() bool    { return p == PermissionEdit }

// Features turns specific reader-side UI affordances on or off per share
// link. Comments are NOT here — they remain gated by Permission so we
// don't have two different ways to say "no comments".
//
// All-zero is the "minimal viewer" default for new shares created by
// older clients that don't send a `features` block; for legacy shares
// already on disk we backfill all-on at load time (see migrateLegacyShare)
// so existing links don't suddenly lose features after upgrade.
type Features struct {
	Outline   bool `json:"outline"`
	Search    bool `json:"search"`
	Palette   bool `json:"palette"`
	Bookmarks bool `json:"bookmarks"`
	Theme     bool `json:"theme"`
	Print     bool `json:"print"`
}

// DefaultFeatures: what a brand-new share gets when the admin clicks
// "Create" without unticking any boxes. Tuned for the typical "team
// review" use case where the guest needs the whole reader.
func DefaultFeatures() Features {
	return Features{
		Outline: true, Search: true, Palette: true,
		Bookmarks: true, Theme: true, Print: true,
	}
}

type Share struct {
	ID         string     `json:"id"`
	Hash       string     `json:"hash"` // hex-encoded SHA-256 of the token
	Permission Permission `json:"permission"`
	Label      string     `json:"label"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	CreatedBy  string     `json:"created_by"`
	LastUsed   *time.Time `json:"last_used,omitempty"`
	Features   Features   `json:"features"`
	// FeaturesSet distinguishes "the admin explicitly chose these features
	// (possibly all-off)" from a legacy share that predates the features block.
	// Create() sets it true; only records without it get the all-on backfill,
	// so an all-features-off share is honored instead of silently re-enabled.
	FeaturesSet bool `json:"features_set,omitempty"`
}

// View is the admin-facing shape: identical to Share except Hash is omitted.
type View struct {
	ID         string     `json:"id"`
	Permission Permission `json:"permission"`
	Label      string     `json:"label"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	CreatedBy  string     `json:"created_by"`
	LastUsed   *time.Time `json:"last_used,omitempty"`
	Features   Features   `json:"features"`
}

func (s Share) View() View {
	return View{
		ID: s.ID, Permission: s.Permission, Label: s.Label,
		CreatedAt: s.CreatedAt, ExpiresAt: s.ExpiresAt, CreatedBy: s.CreatedBy,
		LastUsed: s.LastUsed, Features: s.Features,
	}
}

type CreateResult struct {
	Share View   `json:"share"`
	Token string `json:"token"` // shown exactly once
	URL   string `json:"url"`
}

var (
	ErrShareNotFound = errors.New("share not found")
	ErrShareExpired  = errors.New("share expired")
	ErrInvalidPerm   = errors.New("invalid permission")
)

type Store struct {
	spacesDir string
	mu        sync.Mutex
}

func NewStore(spacesDir string) *Store {
	return &Store{spacesDir: spacesDir}
}

func (s *Store) sharesPath(spaceID string) string {
	return filepath.Join(s.spacesDir, spaceID, ".notation", "shares.json")
}

func (s *Store) load(spaceID string) ([]Share, error) {
	data, err := os.ReadFile(s.sharesPath(spaceID))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []Share
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("shares.json: %w", err)
	}
	// Backfill features only for shares written by older versions (no
	// FeaturesSet marker) — they were "full reader" in the previous UI, so
	// default to all-on. A modern share with FeaturesSet=true is honored as-is,
	// even when every feature is off (the admin deliberately disabled them).
	for i := range out {
		if !out[i].FeaturesSet && (out[i].Features == Features{}) {
			out[i].Features = DefaultFeatures()
		}
	}
	return out, nil
}

func (s *Store) save(spaceID string, shares []Share) error {
	path := s.sharesPath(spaceID)
	data, err := json.MarshalIndent(shares, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(path, data, 0o640)
}

func (s *Store) List(spaceID string) ([]View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	shares, err := s.load(spaceID)
	if err != nil {
		return nil, err
	}
	out := make([]View, 0, len(shares))
	for _, sh := range shares {
		out = append(out, sh.View())
	}
	return out, nil
}

func (s *Store) Create(spaceID string, perm Permission, label string, expiresAt *time.Time, createdBy string, features Features) (CreateResult, error) {
	if !ValidPermission(perm) {
		return CreateResult{}, ErrInvalidPerm
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	shares, err := s.load(spaceID)
	if err != nil {
		return CreateResult{}, err
	}
	token := generateToken()
	h := hashToken(token)
	sh := Share{
		// ID is independent of the token — it surfaces in audit logs and the
		// comment Author ("share:<id>:..."), so it must not carry token bytes.
		ID:          "share_" + randID(12),
		Hash:        h,
		Permission:  perm,
		Label:       strings.TrimSpace(label),
		CreatedAt:   time.Now().UTC(),
		ExpiresAt:   expiresAt,
		CreatedBy:   createdBy,
		Features:    features,
		FeaturesSet: true,
	}
	shares = append(shares, sh)
	if err := s.save(spaceID, shares); err != nil {
		return CreateResult{}, err
	}
	return CreateResult{Share: sh.View(), Token: token}, nil
}

func (s *Store) Delete(spaceID, shareID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	shares, err := s.load(spaceID)
	if err != nil {
		return err
	}
	out := shares[:0]
	found := false
	for _, sh := range shares {
		if sh.ID == shareID {
			found = true
			continue
		}
		out = append(out, sh)
	}
	if !found {
		return ErrShareNotFound
	}
	return s.save(spaceID, out)
}

// Resolve looks the token up across all spaces with a constant-time hash
// compare. It returns the matching space ID and the share record. Expired
// shares produce ErrShareExpired so the caller can distinguish them.
func (s *Store) Resolve(token string) (string, Share, error) {
	if token == "" {
		return "", Share{}, ErrShareNotFound
	}
	h := hashToken(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.spacesDir)
	if err != nil {
		return "", Share{}, err
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		shares, err := s.load(e.Name())
		if err != nil {
			continue
		}
		for _, sh := range shares {
			if subtle.ConstantTimeCompare([]byte(sh.Hash), []byte(h)) == 1 {
				if sh.ExpiresAt != nil && time.Now().After(*sh.ExpiresAt) {
					return "", Share{}, ErrShareExpired
				}
				return e.Name(), sh, nil
			}
		}
	}
	return "", Share{}, ErrShareNotFound
}

func (s *Store) TouchLastUsed(spaceID, shareID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	shares, err := s.load(spaceID)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	for i := range shares {
		if shares[i].ID == shareID {
			shares[i].LastUsed = &now
			_ = s.save(spaceID, shares)
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

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
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
