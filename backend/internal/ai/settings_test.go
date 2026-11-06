package ai

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const goodKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789_-ABCD"

func strp(s string) *string { return &s }

func TestKeyIsStoredOwnerOnlyAndNeverInTheView(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "", false)
	v, err := s.Apply(Update{APIKey: strp(goodKey)})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !v.Configured || v.KeySource != "settings" || v.KeyHint != "sk-ant-…ABCD" {
		t.Errorf("view = %+v", v)
	}
	info, err := os.Stat(filepath.Join(dir, ".notation", "ai.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("ai.json mode = %o, want 0600", perm)
	}
	got, _ := s.View()
	if strings.Contains(got.KeyHint, "abcdefghij") {
		t.Errorf("view leaks the key: %+v", got)
	}
	key, err := s.APIKey()
	if err != nil || key != goodKey {
		t.Errorf("APIKey = %q, %v", key, err)
	}
	// Clearing.
	v, err = s.Apply(Update{APIKey: strp("")})
	if err != nil || v.Configured {
		t.Errorf("clear: %+v %v", v, err)
	}
}

func TestKeyShapeIsChecked(t *testing.T) {
	s := NewStore(t.TempDir(), "", false)
	for _, bad := range []string{
		"hello",
		"https://console.anthropic.com/settings/keys",
		"sk-ant-admin01-abcdefghijklmnopqrstuvwxyz",  // admin keys never go to a browser
		"sk-ant-api03 with spaces in it xxxxxxxxxxx", // a pasted sentence
		"sk-ant-" + strings.Repeat("x", 300),
	} {
		if _, err := s.Apply(Update{APIKey: strp(bad)}); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Apply(%q) = %v, want ErrInvalidKey", bad, err)
		}
	}
}

func TestEnvKeyWinsAndLocksTheSetting(t *testing.T) {
	s := NewStore(t.TempDir(), goodKey, false)
	v, _ := s.View()
	if !v.Configured || v.KeySource != "env" {
		t.Errorf("view = %+v", v)
	}
	if _, err := s.Apply(Update{APIKey: strp(goodKey)}); !errors.Is(err, ErrKeyFromEnv) {
		t.Errorf("setting a key over an env key = %v, want ErrKeyFromEnv", err)
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
	if k, _ := s.APIKey(); k != "" {
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
