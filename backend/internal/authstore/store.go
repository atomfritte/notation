// Package authstore owns the on-disk admin state: bootstrap-token hash,
// registered passkeys, and the HMAC key used to sign session cookies. All
// reads/writes are mutex-guarded and persisted atomically (tmp-file + rename).
//
// File layout under <data>/.notation/:
//
//	admin.json     — single Admin record (bootstrap + passkeys)
//	server-secret  — 64 random bytes hex, HMAC key for session cookies
package authstore

import (
	"crypto/rand"
	"crypto/sha256"
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
)

const (
	adminFile  = "admin.json"
	secretFile = "server-secret"
	storeDir   = ".notation"
)

// Admin is the single record persisted to admin.json.
type Admin struct {
	Version   int        `json:"version"`
	CreatedAt time.Time  `json:"created_at"`
	RPID      string     `json:"rp_id"`
	Bootstrap *Bootstrap `json:"bootstrap,omitempty"`
	Passkeys  []Passkey  `json:"passkeys"`
}

// Bootstrap is the one-time admin claim token (hash-only on disk).
type Bootstrap struct {
	Hash     string    `json:"hash"` // hex sha256 of the raw token
	IssuedAt time.Time `json:"issued_at"`
}

// Passkey is one registered WebAuthn credential.
type Passkey struct {
	ID           string     `json:"id"`
	Label        string     `json:"label"`
	CredentialID string     `json:"credential_id"` // base64url
	PublicKey    string     `json:"public_key"`    // base64url COSE key
	SignCount    uint32     `json:"sign_count"`
	AAGUID       string     `json:"aaguid,omitempty"`
	Transports   []string   `json:"transports,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	LastUsed     *time.Time `json:"last_used,omitempty"`
	// BE/BS are the WebAuthn "Backup Eligible" / "Backup State" flags. go-webauthn
	// 0.17+ enforces consistency between the stored flags and what the
	// authenticator reports on each assertion. FlagsRecorded distinguishes a
	// genuine `false` from "not yet observed" — pre-0.11 we never persisted
	// these, so older Passkey records load with FlagsRecorded=false and the
	// login path treats the first incoming assertion's flags as authoritative.
	BackupEligible bool `json:"backup_eligible,omitempty"`
	BackupState    bool `json:"backup_state,omitempty"`
	FlagsRecorded  bool `json:"flags_recorded,omitempty"`
}

// HasPasskeys reports whether at least one passkey is registered. Used by
// the state-machine to decide which screen to show.
func (a *Admin) HasPasskeys() bool { return len(a.Passkeys) > 0 }

// Store wraps the on-disk admin record. All operations are atomic and
// mutex-guarded.
type Store struct {
	dataDir string
	mu      sync.Mutex
}

func New(dataDir string) *Store {
	return &Store{dataDir: dataDir}
}

func (s *Store) adminPath() string  { return filepath.Join(s.dataDir, storeDir, adminFile) }
func (s *Store) secretPath() string { return filepath.Join(s.dataDir, storeDir, secretFile) }

var ErrAdminNotInitialized = errors.New("admin record not initialized")

// Load reads admin.json from disk. Returns ErrAdminNotInitialized if it's
// missing — callers should react by writing one with a fresh bootstrap token.
func (s *Store) Load() (*Admin, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Store) loadLocked() (*Admin, error) {
	data, err := os.ReadFile(s.adminPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrAdminNotInitialized
		}
		return nil, err
	}
	var a Admin
	if err := json.Unmarshal(data, &a); err != nil {
		return nil, fmt.Errorf("admin.json: %w", err)
	}
	return &a, nil
}

// Save replaces the admin.json contents atomically.
func (s *Store) Save(a *Admin) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(a)
}

func (s *Store) saveLocked(a *Admin) error {
	data, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(s.adminPath(), data, 0o600)
}

// Update performs a read-modify-write under the lock. Common pattern for
// any mutation: pass a function that mutates the loaded Admin.
func (s *Store) Update(fn func(*Admin) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.loadLocked()
	if err != nil {
		return err
	}
	if err := fn(a); err != nil {
		return err
	}
	return s.saveLocked(a)
}

// LoadOrInit either loads admin.json or creates a fresh record with a new
// bootstrap token (if missing). On either path, if the admin is still
// in the unclaimed bootstrap state, a NEW bootstrap token is generated and
// the previous hash is replaced — so the most recently printed token is
// always the valid one. Returns the raw token only when a new one was just
// generated, otherwise returns "".
func (s *Store) LoadOrInit(rpID string) (*Admin, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Join(s.dataDir, storeDir), 0o700); err != nil {
		return nil, "", err
	}

	a, err := s.loadLocked()
	if err != nil && !errors.Is(err, ErrAdminNotInitialized) {
		return nil, "", err
	}

	if a == nil {
		// First boot — make a brand new record.
		token, hash := newBootstrapToken()
		a = &Admin{
			Version:   1,
			CreatedAt: time.Now().UTC(),
			RPID:      rpID,
			Bootstrap: &Bootstrap{Hash: hash, IssuedAt: time.Now().UTC()},
			Passkeys:  []Passkey{},
		}
		if err := s.saveLocked(a); err != nil {
			return nil, "", err
		}
		return a, token, nil
	}

	// Keep RPID up to date so passkeys keep working if config changes.
	if a.RPID != rpID && rpID != "" {
		a.RPID = rpID
	}
	// If still unclaimed, rotate the bootstrap token on every boot so the
	// most recent container log always shows the valid one.
	if a.Bootstrap != nil {
		token, hash := newBootstrapToken()
		a.Bootstrap = &Bootstrap{Hash: hash, IssuedAt: time.Now().UTC()}
		if err := s.saveLocked(a); err != nil {
			return nil, "", err
		}
		return a, token, nil
	}
	// Already claimed.
	return a, "", nil
}

// LoadOrGenerateSecret reads server-secret or generates a new 64-byte secret
// on first boot. The secret signs session cookies.
func (s *Store) LoadOrGenerateSecret() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Join(s.dataDir, storeDir), 0o700); err != nil {
		return nil, err
	}
	path := s.secretPath()
	data, err := os.ReadFile(path)
	if err == nil {
		secret, err := hex.DecodeString(string(data))
		if err == nil && len(secret) >= 32 {
			return secret, nil
		}
		// Corrupt — regenerate.
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	raw := make([]byte, 64)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	hexBytes := []byte(hex.EncodeToString(raw))
	if err := atomicWrite(path, hexBytes, 0o600); err != nil {
		return nil, err
	}
	return raw, nil
}

func newBootstrapToken() (raw, hashHex string) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	raw = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(raw))
	return raw, hex.EncodeToString(h[:])
}

// HashToken returns the hex-encoded sha256 of token. Exported because the
// claim handler needs to compute the same hash for constant-time compare.
func HashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func atomicWrite(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
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
