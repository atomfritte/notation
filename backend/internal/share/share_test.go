package share

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// An admin who explicitly disables every feature must keep them disabled —
// the all-on backfill is only for legacy shares that predate the features block.
func TestCreate_AllFeaturesOff_Honored(t *testing.T) {
	st := NewStore(t.TempDir())
	res, err := st.Create("myspace", PermissionRead, "", "ro", nil, "admin", Features{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Via Resolve (the guest path).
	_, sh, err := st.Resolve(res.Token)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if (sh.Features != Features{}) {
		t.Errorf("explicit all-off features were re-enabled: %+v", sh.Features)
	}
	if sh.Features.Search {
		t.Error("Search must stay off when the admin disabled it")
	}
}

// A legacy share written before the features block existed (no features_set,
// zero-value features) should still be backfilled to the full reader.
func TestLoad_LegacyShare_BackfilledAllOn(t *testing.T) {
	dir := t.TempDir()
	st := NewStore(dir)
	legacy := []Share{{
		ID:         "share_legacy",
		Hash:       "deadbeef",
		Permission: PermissionRead,
		Features:   Features{}, // FeaturesSet omitted → legacy
	}}
	data, _ := json.Marshal(legacy)
	path := filepath.Join(dir, "myspace", ".notation", "shares.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o640); err != nil {
		t.Fatal(err)
	}
	views, err := st.List("myspace")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(views) != 1 {
		t.Fatalf("want 1 share, got %d", len(views))
	}
	if views[0].Features != DefaultFeatures() {
		t.Errorf("legacy share not backfilled to all-on: %+v", views[0].Features)
	}
}

// The record ID must not carry bytes of the secret token (it leaks into audit
// logs / comment authors).
func TestCreate_IDDoesNotLeakToken(t *testing.T) {
	st := NewStore(t.TempDir())
	res, err := st.Create("myspace", PermissionEdit, "", "", nil, "admin", DefaultFeatures())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(res.Token) >= 8 {
		prefix := res.Token[:8]
		if filepath.Base(res.Share.ID) == "share_"+prefix || contains(res.Share.ID, prefix) {
			t.Errorf("share ID %q embeds token prefix %q", res.Share.ID, prefix)
		}
	}
}

// A scoped share must round-trip through disk + Resolve, and legacy records
// (no scope field) must read back as whole-space access.
func TestCreate_ScopeRoundTrip(t *testing.T) {
	st := NewStore(t.TempDir())
	res, err := st.Create("myspace", PermissionRead, "/notes//weekly/../weekly/page.md", "", nil, "admin", DefaultFeatures())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if res.Share.Scope != "notes/weekly/page.md" {
		t.Errorf("scope not normalized on create: %q", res.Share.Scope)
	}
	_, sh, err := st.Resolve(res.Token)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if sh.Scope != "notes/weekly/page.md" {
		t.Errorf("scope lost on resolve: %q", sh.Scope)
	}
}

func TestCreate_InvalidScopeRejected(t *testing.T) {
	st := NewStore(t.TempDir())
	for _, scope := range []string{"..", "../x", "a/../../b", ".notation/shares.json", "a/.hidden/b", `a\b`, "a/\x00b"} {
		if _, err := st.Create("myspace", PermissionRead, scope, "", nil, "admin", DefaultFeatures()); err == nil {
			t.Errorf("scope %q accepted, want ErrInvalidScope", scope)
		}
	}
}

func TestScopeAllows(t *testing.T) {
	cases := []struct {
		scope, path string
		want        bool
	}{
		{"", "anything/at/all.md", true},
		{"notes", "notes/a.md", true},
		{"notes", "notes", true},
		{"notes", "notes2/a.md", false}, // segment-aware, no prefix confusion
		{"notes", "Notes/a.md", false},  // case-sensitive like the FS
		{"notes/page.md", "notes/page.md", true},
		{"notes/page.md", "notes/page.md.bak", false},
		{"notes/page.md", "notes/other.md", false},
		{"notes", "notes/../secret.md", false}, // traversal normalized away
		{"notes", "notes/sub/../a.md", true},   // normalizes to notes/a.md
		{"notes", "../notes/a.md", false},
		{"notes", "/notes/a.md", true}, // leading slash trimmed, still inside
		{"notes", "", false},
		{"notes", ".", false},
		{"notes", "notes/.notation/x", false}, // dot segments always denied
		{"notes", " notes/a.md", false},       // padded path aliases a literal " notes" dir — deny
		{"notes", "notes/a.md ", false},
	}
	for _, c := range cases {
		sh := Share{Scope: c.scope}
		if got := sh.ScopeAllows(c.path); got != c.want {
			t.Errorf("ScopeAllows(scope=%q, path=%q) = %v, want %v", c.scope, c.path, got, c.want)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && (indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
