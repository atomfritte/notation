package space

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSafeJoin_Accepts(t *testing.T) {
	root := t.TempDir()
	cases := []string{
		"foo.md",
		"a/b/c.md",
		"folder/deep/nested.txt",
		"with spaces/file.md",
		"unicode-ümlaut.md",
		// Clean collapses traversal that doesn't escape root.
		"foo/../bar.md",
	}
	for _, c := range cases {
		if _, err := SafeJoin(root, c); err != nil {
			t.Errorf("expected %q to be accepted, got %v", c, err)
		}
	}
}

func TestSafeJoin_Rejects(t *testing.T) {
	root := t.TempDir()
	cases := map[string]string{
		"empty":           "",
		"dot":             ".",
		"dotdot":          "..",
		"abs":             "/etc/passwd",
		"escape":          "../etc/passwd",
		"deep_escape":     "a/b/../../../etc",
		"backslash":       "foo\\bar",
		"nul":             "foo\x00bar",
		"dotfile":         ".secret",
		"hidden_subpath":  "foo/.git/config",
		"hidden_in_chain": ".notation/meta.json",
	}
	for name, p := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := SafeJoin(root, p); err == nil {
				t.Errorf("expected %q to be rejected, got nil error", p)
			}
		})
	}
}

func TestSafeJoin_RejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	// Create root/escape -> outside (absolute symlink)
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlink creation failed (likely Windows non-admin): %v", err)
	}
	if _, err := SafeJoin(root, "escape/foo.md"); err == nil {
		t.Fatal("expected symlink-escape to be rejected")
	}
}

func TestSafeJoin_ResultStaysInRoot(t *testing.T) {
	root := t.TempDir()
	got, err := SafeJoin(root, "a/b.md")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "a", "b.md")
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// SafeJoin must work when the data root is reached through a symlink (e.g.
// /data -> /mnt/vol/data) — otherwise every file op is rejected as an escape.
func TestSafeJoin_RootViaSymlink(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if _, err := SafeJoin(link, "notes/today.md"); err != nil {
		t.Errorf("in-root path through symlinked root should be accepted, got %v", err)
	}
	if _, err := SafeJoin(link, "../escape"); err == nil {
		t.Error("escape through symlinked root should still be rejected")
	}
}
