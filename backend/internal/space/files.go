package space

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

var (
	ErrSymlink    = errors.New("symlinks are not allowed")
	ErrIsDir      = errors.New("path is a directory")
	ErrFileTooBig = errors.New("file too big")
)

// openRoot opens an os.Root (Go 1.24+) anchored at the Space's files/ dir.
// Every read/write the file APIs perform goes through this sandbox: the
// kernel-level openat(RESOLVE_BENEATH) semantics refuse any path that
// escapes the root via ".." or via a symlink that points outside, atomically
// closing the TOCTOU race that purely string-based SafeJoin can't.
func (s *Store) openRoot(spaceID string) (*os.Root, error) {
	return os.OpenRoot(s.FilesDir(spaceID))
}

// safeRel runs the userPath through SafeJoin (which does the string-level
// validation: no .., no NUL, no dotfiles, no backslash) and returns the
// slash-delimited path *relative* to the Space's files root — the form
// os.Root operates on.
func (s *Store) safeRel(spaceID, userPath string) (string, error) {
	abs, err := SafeJoin(s.FilesDir(spaceID), userPath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(s.FilesDir(spaceID), abs)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(rel), nil
}

// mkdirAllInRoot creates all missing ancestor directories under the sandbox.
// os.Root.MkdirAll lands in Go 1.25; for 1.24 we walk and Mkdir each level.
func mkdirAllInRoot(root *os.Root, dir string) error {
	dir = strings.Trim(dir, "/")
	if dir == "" || dir == "." {
		return nil
	}
	if info, err := root.Stat(dir); err == nil {
		if info.IsDir() {
			return nil
		}
		return errors.New("path exists but is not a directory: " + dir)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	parent := path.Dir(dir)
	if parent != "." && parent != "" && parent != dir {
		if err := mkdirAllInRoot(root, parent); err != nil {
			return err
		}
	}
	if err := root.Mkdir(dir, 0o750); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	return nil
}

// ReadFile reads a file under <spaceID>/files/<userPath>.
func (s *Store) ReadFile(spaceID, userPath string) ([]byte, error) {
	rel, err := s.safeRel(spaceID, userPath)
	if err != nil {
		return nil, err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()

	info, err := root.Lstat(rel)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, ErrIsDir
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSymlink
	}
	f, err := root.Open(rel)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// WriteFile streams r into <spaceID>/files/<userPath>, enforcing maxBytes.
// Writes go through a temp file inside the sandbox + same-directory rename
// for atomicity. Parent directories are created lazily.
func (s *Store) WriteFile(spaceID, userPath string, r io.Reader, maxBytes int64) (int64, error) {
	rel, err := s.safeRel(spaceID, userPath)
	if err != nil {
		return 0, err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return 0, err
	}
	defer root.Close()

	parent := path.Dir(rel)
	if err := mkdirAllInRoot(root, parent); err != nil {
		return 0, err
	}

	// Temp file path inside the sandbox, in the same parent so rename is
	// atomic on the same filesystem.
	tmpName := tmpSibling(parent)
	tmp, err := root.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(tmp, io.LimitReader(r, maxBytes+1))
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = root.Remove(tmpName)
		return written, copyErr
	}
	if closeErr != nil {
		_ = root.Remove(tmpName)
		return written, closeErr
	}
	if written > maxBytes {
		_ = root.Remove(tmpName)
		return written, ErrFileTooBig
	}
	// os.Root.Rename doesn't exist in 1.24. SafeJoin already validated `rel`,
	// and the tmp is a sibling of the target (also inside the root), so a
	// raw os.Rename here is safe.
	tmpAbs := filepath.Join(s.FilesDir(spaceID), filepath.FromSlash(tmpName))
	finalAbs := filepath.Join(s.FilesDir(spaceID), filepath.FromSlash(rel))
	if err := os.Rename(tmpAbs, finalAbs); err != nil {
		_ = root.Remove(tmpName)
		return written, err
	}
	return written, nil
}

func (s *Store) DeleteFile(spaceID, userPath string) error {
	rel, err := s.safeRel(spaceID, userPath)
	if err != nil {
		return err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return err
	}
	defer root.Close()
	info, err := root.Lstat(rel)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return ErrSymlink
	}
	return root.Remove(rel)
}

// RenameFile validates both endpoints via SafeJoin and uses os.Rename. The
// sandbox doesn't expose Rename in 1.24; SafeJoin enforces both paths stay
// inside the Space, so the raw rename is bounded.
func (s *Store) RenameFile(spaceID, from, to string) error {
	fromAbs, err := SafeJoin(s.FilesDir(spaceID), from)
	if err != nil {
		return err
	}
	toAbs, err := SafeJoin(s.FilesDir(spaceID), to)
	if err != nil {
		return err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return err
	}
	defer root.Close()
	// Reject symlinked source.
	fromRel, _ := filepath.Rel(s.FilesDir(spaceID), fromAbs)
	if info, err := root.Lstat(filepath.ToSlash(fromRel)); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return ErrSymlink
		}
	}
	// Ensure target parent exists.
	toRel, _ := filepath.Rel(s.FilesDir(spaceID), toAbs)
	if err := mkdirAllInRoot(root, path.Dir(filepath.ToSlash(toRel))); err != nil {
		return err
	}
	return os.Rename(fromAbs, toAbs)
}

func (s *Store) Mkdir(spaceID, userPath string) error {
	rel, err := s.safeRel(spaceID, userPath)
	if err != nil {
		return err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return err
	}
	defer root.Close()
	return mkdirAllInRoot(root, rel)
}

// Stat returns the size and modtime of a file (does not read content).
func (s *Store) Stat(spaceID, userPath string) (os.FileInfo, error) {
	rel, err := s.safeRel(spaceID, userPath)
	if err != nil {
		return nil, err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat(rel)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSymlink
	}
	return info, nil
}

// tmpSibling returns a randomly-suffixed temp filename in the given parent
// directory (slash-delimited, relative to root). Hidden via leading dot so
// it doesn't show up in the file tree if the rename ever fails.
func tmpSibling(parent string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	suffix := hex.EncodeToString(b)
	if parent == "" || parent == "." {
		return ".tmp-" + suffix
	}
	return parent + "/.tmp-" + suffix
}
