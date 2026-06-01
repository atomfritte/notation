package space

import (
	"errors"
	"path"
	"path/filepath"
	"strings"
)

var (
	ErrPathEscape = errors.New("path escapes space")
	ErrPathEmpty  = errors.New("path is empty")
	ErrPathDot    = errors.New("dotfiles and dotdirs are not allowed")
	ErrPathNUL    = errors.New("path contains NUL byte")
)

// SafeJoin validates and resolves userPath (a slash-delimited path supplied by
// the API caller) against root. It returns the absolute filesystem path on
// success, or an error if the path tries to escape root, contains traversal
// segments, NUL bytes, dotfiles, or refers to (or passes through) a symlink.
//
// userPath must be relative and slash-delimited. Backslashes are rejected to
// avoid Windows-style path confusion. Dotfiles are rejected to keep the
// .notation metadata directory off-limits and to avoid exposing editor files.
func SafeJoin(root, userPath string) (string, error) {
	if userPath == "" {
		return "", ErrPathEmpty
	}
	if strings.ContainsRune(userPath, 0) {
		return "", ErrPathNUL
	}
	if strings.Contains(userPath, "\\") {
		return "", ErrPathEscape
	}
	// Reject absolute paths outright. The docstring promises a relative input,
	// and silently stripping a leading "/" maps "/etc/passwd" to "<root>/etc/passwd"
	// — harmless on disk but a defense-in-depth violation that lets callers
	// pretend they typed an absolute path and get a result back.
	if strings.HasPrefix(userPath, "/") {
		return "", ErrPathEscape
	}
	p := path.Clean(userPath)
	if p == "" || p == "." {
		return "", ErrPathEmpty
	}
	if !filepath.IsLocal(p) {
		return "", ErrPathEscape
	}
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, ".") {
			return "", ErrPathDot
		}
	}
	abs := filepath.Join(root, filepath.FromSlash(p))
	// Resolve symlinks in the root so both sides of the insideRoot comparison
	// live in the same namespace. Without this, hosting the data dir under a
	// symlinked path (e.g. /data -> /mnt/vol/data) makes EvalSymlinks(abs)
	// resolve below /mnt/... while rootAbs stays /data/... — and every single
	// file op gets rejected as an escape. Fall back to Abs when root doesn't
	// exist yet (e.g. a freshly-created Space before its files dir is made).
	rootAbs, err := filepath.EvalSymlinks(root)
	if err != nil {
		rootAbs, err = filepath.Abs(root)
		if err != nil {
			return "", err
		}
	}
	// If the target or any existing ancestor resolves outside root through a
	// symlink, reject. Non-existent targets are fine — we check the deepest
	// existing ancestor instead.
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		if !insideRoot(rootAbs, resolved) {
			return "", ErrPathEscape
		}
	} else {
		cur := filepath.Dir(abs)
		for cur != "" && cur != filepath.Dir(cur) {
			if resolved, err := filepath.EvalSymlinks(cur); err == nil {
				if !insideRoot(rootAbs, resolved) {
					return "", ErrPathEscape
				}
				break
			}
			cur = filepath.Dir(cur)
		}
	}
	return abs, nil
}

func insideRoot(rootAbs, target string) bool {
	rel, err := filepath.Rel(rootAbs, target)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if strings.HasPrefix(rel, "..") {
		return false
	}
	return true
}
