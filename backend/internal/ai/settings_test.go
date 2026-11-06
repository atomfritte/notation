package ai

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const goodKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789_-ABCD"

func strp(s string) *string { return &s }

func sealed(hint string) *SealedKey {
	return &SealedKey{
		V:          1,
		KDF:        SealedKDF{Algorithm: "argon2id", MemoryKiB: 65536, Iterations: 3, Parallelism: 1},
		Salt:       base64.StdEncoding.EncodeToString(make([]byte, 16)),
		Ciphertext: base64.StdEncoding.EncodeToString(make([]byte, 2+12+16+len(goodKey))),
		Hint:       hint,
	}
}

func TestSealedKeyIsStoredOwnerOnlyAndNeverInTheView(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "", false)
	v, err := s.Apply(Update{SealedKey: sealed("sk-ant-…ABCD")})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !v.Configured || v.KeySource != "sealed" || v.KeyHint != "sk-ant-…ABCD" {
		t.Errorf("view = %+v", v)
	}
	info, err := os.Stat(filepath.Join(dir, ".notation", "ai.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("ai.json mode = %o, want 0600", perm)
	}
	km, err := s.Key()
	if err != nil || km.Source != "sealed" || km.Sealed == nil || km.APIKey != "" {
		t.Errorf("Key = %+v, %v", km, err)
	}
	// Clearing.
	v, err = s.Apply(Update{ClearKey: true})
	if err != nil || v.Configured {
		t.Errorf("clear: %+v %v", v, err)
	}
	if km, _ := s.Key(); km.Source != "" {
		t.Errorf("cleared store still hands out %+v", km)
	}
}

// An install from before sealing keeps working until the browser seals the
// key; storing the sealed key removes the plaintext from disk.
func TestLegacyPlaintextKeyIsReplacedBySealing(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".notation"), 0o750); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".notation", "ai.json")
	if err := os.WriteFile(path, []byte(`{"api_key":"`+goodKey+`","default_model":"claude-sonnet-5-5"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(dir, "", false)
	v, _ := s.View()
	if v.KeySource != "legacy" || v.KeyHint != "sk-ant-…ABCD" {
		t.Errorf("legacy view = %+v", v)
	}
	km, _ := s.Key()
	if km.Source != "legacy" || km.APIKey != goodKey {
		t.Errorf("legacy key = %+v", km)
	}
	if _, err := s.Apply(Update{SealedKey: sealed("sk-ant-…ABCD")}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "abcdefghij") || strings.Contains(string(raw), `"api_key"`) {
		t.Errorf("plaintext key still on disk after sealing: %s", raw)
	}
	if !strings.Contains(string(raw), "claude-sonnet-5-5") {
		t.Errorf("sealing dropped the other settings: %s", raw)
	}
}

func TestSealedKeyShapeIsChecked(t *testing.T) {
	s := NewStore(t.TempDir(), "", false)
	b64 := base64.StdEncoding.EncodeToString
	for name, mut := range map[string]func(k *SealedKey){
		"version":       func(k *SealedKey) { k.V = 2 },
		"algorithm":     func(k *SealedKey) { k.KDF.Algorithm = "pbkdf2" },
		"weak memory":   func(k *SealedKey) { k.KDF.MemoryKiB = 1024 },
		"huge memory":   func(k *SealedKey) { k.KDF.MemoryKiB = 8 << 20 }, // would wedge the browser
		"iterations":    func(k *SealedKey) { k.KDF.Iterations = 0 },
		"many passes":   func(k *SealedKey) { k.KDF.Iterations = 1000 },
		"parallelism":   func(k *SealedKey) { k.KDF.Parallelism = 64 },
		"short salt":    func(k *SealedKey) { k.Salt = b64(make([]byte, 4)) },
		"bad salt":      func(k *SealedKey) { k.Salt = "not base64!" },
		"empty ct":      func(k *SealedKey) { k.Ciphertext = "" },
		"huge ct":       func(k *SealedKey) { k.Ciphertext = b64(make([]byte, 4096)) },
		"hint sentence": func(k *SealedKey) { k.Hint = "<script>alert(1)</script>" },
		"hint is key":   func(k *SealedKey) { k.Hint = goodKey },
	} {
		k := sealed("sk-ant-…ABCD")
		mut(k)
		if _, err := s.Apply(Update{SealedKey: k}); !errors.Is(err, ErrInvalidSealedKey) {
			t.Errorf("%s: Apply = %v, want ErrInvalidSealedKey", name, err)
		}
	}
}

func TestEnvKeyWinsAndLocksTheSetting(t *testing.T) {
	s := NewStore(t.TempDir(), goodKey, false)
	v, _ := s.View()
	if !v.Configured || v.KeySource != "env" {
		t.Errorf("view = %+v", v)
	}
	if _, err := s.Apply(Update{SealedKey: sealed("sk-ant-…ABCD")}); !errors.Is(err, ErrKeyFromEnv) {
		t.Errorf("setting a key over an env key = %v, want ErrKeyFromEnv", err)
	}
	if _, err := s.Apply(Update{ClearKey: true}); !errors.Is(err, ErrKeyFromEnv) {
		t.Errorf("clearing an env key = %v, want ErrKeyFromEnv", err)
	}
	if km, _ := s.Key(); km.Source != "env" || km.APIKey != goodKey {
		t.Errorf("env key = %+v", km)
	}
	// Defaults stay editable.
	if _, err := s.Apply(Update{DefaultModel: strp("claude-sonnet-5-5"), DefaultEffort: strp("high")}); err != nil {
		t.Errorf("defaults under env key: %v", err)
	}
}

func TestDisabledHidesTheKey(t *testing.T) {
	s := NewStore(t.TempDir(), goodKey, true)
	if s.Enabled() {
		t.Fatal("disabled store reports enabled")
	}
	v, _ := s.View()
	if v.Enabled || v.Configured {
		t.Errorf("view = %+v", v)
	}
	if km, _ := s.Key(); km.Source != "" || km.APIKey != "" {
		t.Errorf("disabled store hands out a key")
	}
}

func TestDefaultsValidation(t *testing.T) {
	s := NewStore(t.TempDir(), "", false)
	if _, err := s.Apply(Update{DefaultEffort: strp("turbo")}); !errors.Is(err, ErrInvalidEffort) {
		t.Errorf("effort: %v", err)
	}
	if _, err := s.Apply(Update{DefaultModel: strp("Claude Opus!")}); !errors.Is(err, ErrInvalidModel) {
		t.Errorf("model: %v", err)
	}
	if _, err := s.Apply(Update{SkillsSpace: strp("../etc")}); !errors.Is(err, ErrInvalidSkillsSpace) {
		t.Errorf("skills space: %v", err)
	}
	if _, err := s.Apply(Update{Instructions: strp(strings.Repeat("x", MaxInstructionsBytes+1))}); !errors.Is(err, ErrInstructionsTooLong) {
		t.Errorf("instructions: %v", err)
	}
	v, err := s.Apply(Update{Instructions: strp("Antworte auf Deutsch."), SkillsSpace: strp("skills")})
	if err != nil || v.Instructions != "Antworte auf Deutsch." || v.SkillsSpace != "skills" {
		t.Errorf("valid update: %+v %v", v, err)
	}
}
