// Package ai holds the instance-wide settings for the in-app Claude assistant.
//
// The assistant itself runs in the BROWSER: the agent loop, the tools and the
// call to the Claude API all live client-side, so the notation server is never a
// man-in-the-middle for chat traffic. That is what makes the assistant usable on
// a zero-knowledge Space — the server stores only ciphertext and would have to
// see plaintext to proxy a request. The server's only part is to keep the
// owner's API key (so it follows them across devices) and a few defaults.
//
// File: <data>/.notation/ai.json, mode 0600, written atomically. The key can also
// come from the environment (NOTATION_ANTHROPIC_API_KEY); then it never touches
// the disk and the settings UI shows it as managed by the environment.
package ai

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
	ErrInvalidKey          = errors.New("invalid API key: expected an Anthropic key (sk-ant-…)")
	ErrInvalidModel        = errors.New("invalid model id")
	ErrInvalidEffort       = errors.New("invalid effort: use low, medium, high, xhigh or max")
	ErrInstructionsTooLong = fmt.Errorf("instructions too long (max %d bytes)", MaxInstructionsBytes)
	ErrInvalidSkillsSpace  = errors.New("invalid skills space id")
	ErrKeyFromEnv          = errors.New("the API key is set via NOTATION_ANTHROPIC_API_KEY; change it there")
)

var (
	// Model ids are lowercase dotted/dashed words (claude-opus-5-5, …). Kept
	// open on purpose so a future model works without a server release; the
	// API itself rejects an unknown id.
	modelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{2,63}$`)
	// Mirrors space.idPattern (kept local to avoid an import cycle risk).
	spaceIDPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$`)
	validEfforts   = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true}
)

// Settings is what ai.json holds.
type Settings struct {
	APIKey        string    `json:"api_key,omitempty"`
	DefaultModel  string    `json:"default_model,omitempty"`
	DefaultEffort string    `json:"default_effort,omitempty"`
	Instructions  string    `json:"instructions,omitempty"`
	SkillsSpace   string    `json:"skills_space,omitempty"`
	UpdatedAt     time.Time `json:"updated_at,omitempty"`
}

// View is the settings as the admin UI sees them: everything except the key,
// which is reduced to "is there one, where from, and its last four characters".
type View struct {
	Enabled       bool   `json:"enabled"`
	Configured    bool   `json:"configured"`
	KeySource     string `json:"key_source"` // "env" | "settings" | ""
	KeyHint       string `json:"key_hint,omitempty"`
	DefaultModel  string `json:"default_model"`
	DefaultEffort string `json:"default_effort"`
	Instructions  string `json:"instructions"`
	SkillsSpace   string `json:"skills_space"`
}

// Update is a partial change: nil fields stay as they are.
type Update struct {
	APIKey        *string `json:"api_key,omitempty"`
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
	key, src := s.keyOf(st)
	if key != "" && !s.disabled {
		v.Configured = true
		v.KeySource = src
		v.KeyHint = hint(key)
	}
	return v
}

func (s *Store) keyOf(st Settings) (string, string) {
	if s.envKey != "" {
		return s.envKey, "env"
	}
	if st.APIKey != "" {
		return st.APIKey, "settings"
	}
	return "", ""
}

// APIKey returns the effective key ("" when none is configured or the feature
// is disabled).
func (s *Store) APIKey() (string, error) {
	if s.disabled {
		return "", nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return "", err
	}
	key, _ := s.keyOf(st)
	return key, nil
}

// Apply validates and persists a partial update, returning the new view.
func (s *Store) Apply(u Update) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return View{}, err
	}
	if u.APIKey != nil {
		key := strings.TrimSpace(*u.APIKey)
		if s.envKey != "" {
			return View{}, ErrKeyFromEnv
		}
		if key != "" && !validKey(key) {
			return View{}, ErrInvalidKey
		}
		st.APIKey = key // "" clears it
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

// validKey is a shape check, not authentication: it catches a paste of the
// wrong thing (a URL, a sentence, an admin key) before it is stored. The API
// decides whether the key actually works.
func validKey(k string) bool {
	if len(k) < 20 || len(k) > 256 || !strings.HasPrefix(k, "sk-ant-") {
		return false
	}
	// Admin keys (sk-ant-admin…) can manage the organisation — far more than a
	// chat needs. Refuse them so one never ends up in a browser.
	if strings.HasPrefix(k, "sk-ant-admin") {
		return false
	}
	for _, r := range k {
		if !(r == '-' || r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

func hint(k string) string {
	if len(k) <= 8 {
		return "…"
	}
	return "sk-ant-…" + k[len(k)-4:]
}
