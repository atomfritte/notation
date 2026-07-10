package share

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/yoogie27/notation/internal/space"
)

// FuzzScopeAllows pins the core scoping invariant that the whole scoped-share
// feature rests on. For a share scoped to a non-empty S, if ScopeAllows(S, P)
// returns true then:
//
//	(a) the normalized P equals S or lies strictly under S+"/" (structural
//	    containment — the path can only name something the scope covers), and
//	(b) the CANONICAL target the handler resolves for P is always inside the
//	    space's files root, and inside the scope subtree.
//
// (b) is the load-bearing cross-check, and it has two halves that together
// mean "a scope-allowed path can never touch anything outside the space":
//
//   - SafeJoin(root, normalize(P)) must succeed and stay inside root. This
//     couples NormalizeScope to SafeJoin: if a future change ever let
//     NormalizeScope accept a string SafeJoin would reject (a dotfile, a
//     traversal, a NUL…), this fails. The share handlers only ever act on a
//     path SafeJoin accepts, so the normalized form is the one that matters.
//   - Whenever SafeJoin(root, P) accepts the RAW path (the exact string the
//     handler passes to ReadFile/Stat/WriteFile), the file it resolves must sit
//     inside the scope — never elsewhere in the space, never outside it. A raw
//     path SafeJoin rejects (e.g. a leading-slash "/notes/x") simply yields an
//     error downstream, which is safe: no content is served.
//
// Fuzz functions also execute their seed corpus as an ordinary test under
// `go test`, so this runs in CI without a dedicated fuzzing step.
func FuzzScopeAllows(f *testing.F) {
	// The files root must exist so SafeJoin's symlink resolution has a real
	// anchor; it stays empty (no symlinks) so only string-level rules apply.
	root := f.TempDir()

	seeds := []struct{ scope, path string }{
		{"notes", "notes/a.md"},
		{"notes", "notes/deep/b.md"},
		{"notes", "notes"},
		{"notes", "notes2/x.md"}, // sibling that must NOT be admitted
		{"notes", "../beta/secret.md"},
		{"notes", "..%2Fbeta%2Fsecret.md"},
		{"notes", "/beta/secret.md"},
		{"notes", "notes/../../beta/secret.md"},
		{"notes", `notes\..\beta`},
		{"notes", "notes/../secret.md"},
		{"notes", ".notation/shares.json"},
		{"notes", "notes/.hidden"},
		{"notes", " notes/x.md"}, // leading space
		{"notes", "notes/./a.md"},
		{"notes", "/notes/a.md"}, // leading slash into scope
		{"notes/deep", "notes/deep/b.md"},
		{"a", "a"},
		{"a", "a/b/c"},
		{"", "anything/at/all.md"},
		{"survey", "survey"},
		{"notes", "notes\x00/a.md"}, // embedded NUL
	}
	for _, s := range seeds {
		f.Add(s.scope, s.path)
	}

	f.Fuzz(func(t *testing.T, scope, userPath string) {
		sh := Share{Scope: scope}
		if !sh.ScopeAllows(userPath) {
			return
		}
		// Empty scope means "whole space": ScopeAllows is trivially true and
		// does not, by itself, constrain the path (the file read is still gated
		// by SafeJoin downstream). The subtree invariant only applies to a
		// genuinely scoped share.
		if scope == "" {
			return
		}

		norm, err := NormalizeScope(userPath)
		if err != nil || norm == "" {
			t.Fatalf("ScopeAllows(%q, %q)=true but NormalizeScope failed (err=%v, norm=%q)", scope, userPath, err, norm)
		}

		// (a) structural containment of the normalized path.
		if norm != scope && !strings.HasPrefix(norm, scope+"/") {
			t.Fatalf("ScopeAllows(%q, %q)=true but normalized %q is not within the scope", scope, userPath, norm)
		}

		// (b.1) The canonical (normalized) target must survive SafeJoin and land
		// inside the space's files root — NormalizeScope must never admit a path
		// the filesystem gate would refuse.
		absNorm, err := space.SafeJoin(root, norm)
		if err != nil {
			t.Fatalf("DIVERGENCE: ScopeAllows(%q, %q)=true but SafeJoin rejected the normalized path %q: %v", scope, userPath, norm, err)
		}
		mustBeInside(t, root, absNorm, scope, userPath, "normalized")

		// (b.2) The RAW path is what the handler actually feeds to the store. If
		// SafeJoin accepts it, the resolved file MUST be inside the scope — never
		// elsewhere in the space and never outside it. If SafeJoin rejects it,
		// that's safe (the request errors out with no content).
		if absRaw, err := space.SafeJoin(root, userPath); err == nil {
			mustBeInside(t, root, absRaw, scope, userPath, "raw")
		}
	})
}

// mustBeInside asserts that abs sits inside root and, relative to root, lies
// within the scope subtree (equal to scope or under scope+"/").
func mustBeInside(t *testing.T, root, abs, scope, userPath, which string) {
	t.Helper()
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		t.Fatalf("ScopeAllows(%q, %q): %s target %q not relative to root: %v", scope, userPath, which, abs, err)
	}
	rel = filepath.ToSlash(rel)
	if rel == ".." || strings.HasPrefix(rel, "../") {
		t.Fatalf("ISOLATION HOLE: ScopeAllows(%q, %q)=true but the %s target escaped the space root (rel=%q)", scope, userPath, which, rel)
	}
	if rel != scope && !strings.HasPrefix(rel, scope+"/") {
		t.Fatalf("ISOLATION HOLE: ScopeAllows(%q, %q)=true but the %s target %q is outside the scope subtree", scope, userPath, which, rel)
	}
}
