// Package ai holds the instance-wide settings for the in-app Claude assistant.
//
// The assistant itself runs in the BROWSER: the agent loop, the tools and the
// call to the Claude API all live client-side, so the notation server is never a
// man-in-the-middle for chat traffic. That is what makes the assistant usable on
// a zero-knowledge Space — the server stores only ciphertext and would have to
// see plaintext to proxy a request. The server's only part is to keep the
// owner's API key (so it follows them across devices) and a few defaults.
//
// The key is stored SEALED: the browser encrypts it under a chat password
// (Argon2id → AES-256-GCM) before it ever reaches this server, so the server —
// and anyone who reads its disk or backups — holds only ciphertext it cannot
// open. The admin's browser fetches the sealed record and unlocks it with the
// password, into memory only.
//
// File: <data>/.notation/ai.json, mode 0600, written atomically. The key can
// instead come from the environment (NOTATION_ANTHROPIC_API_KEY): no password
// then, by the operator's choice, and it never touches the disk. Installs from
// before sealing may still hold a plaintext key ("legacy"); the browser seals
// it on next use and the plaintext is dropped.
package ai

import (
	"encoding/base64"
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

const (
	storeDir     = ".notation"
	settingsFile = "ai.json"

	// MaxInstructionsBytes bounds the free-text "instructions for every chat".
	// It goes into every system prompt, so a runaway paste would cost on every
	// request — 32 KiB is several pages of guidance.
	MaxInstructionsBytes = 32 << 10
)

// Errors returned by Update for invalid input (surfaced as 400s).
var (
	ErrInvalidModel        = errors.New("invalid model id")
	ErrInvalidEffort       = errors.New("invalid effort: use low, medium, high, xhigh or max")
	ErrInstructionsTooLong = fmt.Errorf("instructions too long (max %d bytes)", MaxInstructionsBytes)
	ErrInvalidSkillsSpace  = errors.New("invalid skills space id")
	ErrKeyFromEnv          = errors.New("the API key is set via NOTATION_ANTHROPIC_API_KEY; change it there")
	ErrInvalidSealedKey    = errors.New("invalid sealed key record")
)

var (
	// Model ids are lowercase dotted/dashed words (claude-opus-5-5, …). Kept
	// open on purpose so a future model works without a server release; the
	// API itself rejects an unknown id.
	modelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{2,63}$`)
	// Mirrors space.idPattern (kept local to avoid an import cycle risk).
	spaceIDPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$`)
	validEfforts   = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true}
	// The hint is chosen by the browser (it alone sees the key): the fixed
	// prefix plus the key's last four characters, so the owner recognises it.
	hintPattern = regexp.MustCompile(`^sk-ant-…[A-Za-z0-9_-]{4}$`)
)

// SealedKey is the API key encrypted in the browser under the chat password.
// The server validates its SHAPE (so a bad record can't wedge or DoS the
// unlock) but cannot open it.
type SealedKey struct {
	V   int       `json:"v"`
	KDF SealedKDF `json:"kdf"`
	// Salt for the password derivation, base64.
	Salt string `json:"salt"`
	// Framed AES-GCM ciphertext of the key (version||suite||nonce||ct||tag), base64.
	Ciphertext string `json:"ct"`
	// "sk-ant-…ABCD", set by the browser.
	Hint string `json:"hint"`
}

// SealedKDF are the Argon2id parameters the key was sealed with.
type SealedKDF struct {
	Algorithm   string `json:"algorithm"`
	MemoryKiB   int    `json:"memory_kib"`
	Iterations  int    `json:"iterations"`
	Parallelism int    `json:"parallelism"`
}

func (k *SealedKey) valid() bool {
	if k == nil || k.V != 1 || k.KDF.Algorithm != "argon2id" {
		return false
	}
	// Bounds a browser can run in a few seconds (and that aren't trivially
	// weak). The default is 64 MiB × 3; the browser clamps to the same range.
	if k.KDF.MemoryKiB < 19456 || k.KDF.MemoryKiB > 256<<10 || k.KDF.Iterations < 1 || k.KDF.Iterations > 10 ||
		k.KDF.Parallelism < 1 || k.KDF.Parallelism > 4 {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(k.Salt)
	if err != nil || len(salt) < 16 || len(salt) > 64 {
		return false
	}
	ct, err := base64.StdEncoding.DecodeString(k.Ciphertext)
	// header(2) + nonce(12) + tag(16) + a key of 20..256 bytes.
	if err != nil || len(ct) < 2+12+16+20 || len(ct) > 2+12+16+256 {
		return false
	}
	return hintPattern.MatchString(k.Hint)
}

// Settings is what ai.json holds.
type Settings struct {
	// Legacy plaintext key (before sealing existed). Never written any more;
	// replaced as soon as the browser stores a sealed key.
	APIKey        string     `json:"api_key,omitempty"`
	SealedKey     *SealedKey `json:"sealed_key,omitempty"`
	DefaultModel  string     `json:"default_model,omitempty"`
	DefaultEffort string     `json:"default_effort,omitempty"`
	Instructions  string     `json:"instructions,omitempty"`
	SkillsSpace   string     `json:"skills_space,omitempty"`
	UpdatedAt     time.Time  `json:"updated_at,omitempty"`
}

// View is the settings as the admin UI sees them: everything except the key,
// which is reduced to "is there one, where from, and its last four characters".
type View struct {
	Enabled       bool   `json:"enabled"`
	Configured    bool   `json:"configured"`
	KeySource     string `json:"key_source"` // "env" | "sealed" | "legacy" | ""
	KeyHint       string `json:"key_hint,omitempty"`
	DefaultModel  string `json:"default_model"`
	DefaultEffort string `json:"default_effort"`
	Instructions  string `json:"instructions"`
	SkillsSpace   string `json:"skills_space"`
}

// Update is a partial change: nil fields stay as they are. There is no way to
// store a plaintext key: the browser seals it first.
type Update struct {
	SealedKey *SealedKey `json:"sealed_key,omitempty"`
	// ClearKey removes the stored key (sealed or legacy).
	ClearKey      bool    `json:"clear_key,omitempty"`
	DefaultModel  *string `json:"default_model,omitempty"`
	DefaultEffort *string `json:"default_effort,omitempty"`
	Instructions  *string `json:"instructions,omitempty"`
	SkillsSpace   *string `json:"skills_space,omitempty"`
}

// Store persists Settings. Safe for concurrent use.
type Store struct {
	mu       sync.Mutex
	path     string
	envKey   string
	disabled bool
}

// NewStore opens the settings under dataDir. envKey (may be empty) overrides the
// stored key; disabled hides the feature entirely (NOTATION_AI_DISABLED=1).
func NewStore(dataDir, envKey string, disabled bool) *Store {
	return &Store{
		path:     filepath.Join(dataDir, storeDir, settingsFile),
		envKey:   strings.TrimSpace(envKey),
		disabled: disabled,
	}
}

// Enabled reports whether the assistant feature is switched on for this instance.
func (s *Store) Enabled() bool { return !s.disabled }

func (s *Store) load() (Settings, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return Settings{}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	var st Settings
	if err := json.Unmarshal(data, &st); err != nil {
		return Settings{}, fmt.Errorf("ai settings: %w", err)
	}
	return st, nil
}

func (s *Store) save(st Settings) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-ai-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	// The file holds a credential: owner-only from the first byte written.
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

// View returns the redacted settings.
func (s *Store) View() (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return View{}, err
	}
	return s.viewOf(st), nil
}

func (s *Store) viewOf(st Settings) View {
	v := View{
		Enabled:       !s.disabled,
		DefaultModel:  st.DefaultModel,
		DefaultEffort: st.DefaultEffort,
		Instructions:  st.Instructions,
		SkillsSpace:   st.SkillsSpace,
	}
	if s.disabled {
		return v
	}
	km := s.keyOf(st)
	if km.Source != "" {
		v.Configured = true
		v.KeySource = km.Source
		if km.Sealed != nil {
			v.KeyHint = km.Sealed.Hint
		} else {
			v.KeyHint = hint(km.APIKey)
		}
	}
	return v
}

// KeyMaterial is what the browser needs to get at the key: the plaintext key
// (environment, or a legacy store the browser is about to seal) or the sealed
// record it opens with the chat password.
type KeyMaterial struct {
	Source string     `json:"source"` // "env" | "sealed" | "legacy"
	APIKey string     `json:"api_key,omitempty"`
	Sealed *SealedKey `json:"sealed_key,omitempty"`
}

func (s *Store) keyOf(st Settings) KeyMaterial {
	switch {
	case s.envKey != "":
		return KeyMaterial{Source: "env", APIKey: s.envKey}
	case st.SealedKey != nil:
		return KeyMaterial{Source: "sealed", Sealed: st.SealedKey}
	case st.APIKey != "":
		return KeyMaterial{Source: "legacy", APIKey: st.APIKey}
	}
	return KeyMaterial{}
}

// Key returns the key material (Source "" when none is configured or the
// feature is disabled).
func (s *Store) Key() (KeyMaterial, error) {
	if s.disabled {
		return KeyMaterial{}, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return KeyMaterial{}, err
	}
	return s.keyOf(st), nil
}

// Apply validates and persists a partial update, returning the new view.
func (s *Store) Apply(u Update) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return View{}, err
	}
	if u.SealedKey != nil || u.ClearKey {
		if s.envKey != "" {
			return View{}, ErrKeyFromEnv
		}
		if u.SealedKey != nil && !u.SealedKey.valid() {
			return View{}, ErrInvalidSealedKey
		}
		st.SealedKey = u.SealedKey // nil when clearing
		// Either way the legacy plaintext copy goes: a sealed key supersedes
		// it, and clearing means clearing everything.
		st.APIKey = ""
	}
	if u.DefaultModel != nil {
		m := strings.TrimSpace(*u.DefaultModel)
		if m != "" && !modelPattern.MatchString(m) {
			return View{}, ErrInvalidModel
		}
		st.DefaultModel = m
	}
	if u.DefaultEffort != nil {
		e := strings.TrimSpace(*u.DefaultEffort)
		if e != "" && !validEfforts[e] {
			return View{}, ErrInvalidEffort
		}
		st.DefaultEffort = e
	}
	if u.Instructions != nil {
		if len(*u.Instructions) > MaxInstructionsBytes {
			return View{}, ErrInstructionsTooLong
		}
		st.Instructions = *u.Instructions
	}
	if u.SkillsSpace != nil {
		sp := strings.TrimSpace(*u.SkillsSpace)
		if sp != "" && !spaceIDPattern.MatchString(sp) {
			return View{}, ErrInvalidSkillsSpace
		}
		st.SkillsSpace = sp
	}
	st.UpdatedAt = time.Now().UTC()
	if err := s.save(st); err != nil {
		return View{}, err
	}
	return s.viewOf(st), nil
}

// hint is the recognisable tail of a plaintext key (env or legacy). A sealed
// key's hint is set by the browser.
func hint(k string) string {
	if len(k) <= 8 {
		return "…"
	}
	return "sk-ant-…" + k[len(k)-4:]
}
