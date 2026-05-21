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
	p := strings.TrimPrefix(userPath, "/")
	p = path.Clean(p)
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
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
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
