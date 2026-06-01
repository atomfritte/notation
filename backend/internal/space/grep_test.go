package space

import (
	"strings"
	"testing"
)

func TestGrep_RejectsOverlongPattern(t *testing.T) {
	st := NewStore(t.TempDir())
	_, err := st.Grep("anyspace", GrepOpts{Pattern: strings.Repeat("a", maxPatternLen+1)})
	if err == nil {
		t.Fatal("expected an error for an over-long pattern, got nil")
	}
	if !strings.Contains(err.Error(), "too long") {
		t.Errorf("expected 'too long' error, got %v", err)
	}
}

func TestGlob_RejectsOverlongPattern(t *testing.T) {
	st := NewStore(t.TempDir())
	_, err := st.Glob("anyspace", strings.Repeat("*", maxPatternLen+1), 100)
	if err == nil {
		t.Fatal("expected an error for an over-long glob, got nil")
	}
}
