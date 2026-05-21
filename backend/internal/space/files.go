package space

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

var (
	ErrSymlink    = errors.New("symlinks are not allowed")
	ErrIsDir      = errors.New("path is a directory")
	ErrFileTooBig = errors.New("file too big")
)

// ReadFile reads a file under <spaceID>/files/<userPath>.
func (s *Store) ReadFile(spaceID, userPath string) ([]byte, error) {
	abs, err := SafeJoin(s.FilesDir(spaceID), userPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSymlink
	}
	if info.IsDir() {
		return nil, ErrIsDir
	}
	return os.ReadFile(abs)
}

// WriteFile streams r into <spaceID>/files/<userPath>, enforcing maxBytes.
// Writes go through a tmp-file + rename for atomicity. Existing files are
// truncated; missing parent dirs are created (with safe perms).
func (s *Store) WriteFile(spaceID, userPath string, r io.Reader, maxBytes int64) (int64, error) {
	abs, err := SafeJoin(s.FilesDir(spaceID), userPath)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".tmp-*")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	written, err := io.Copy(tmp, io.LimitReader(r, maxBytes+1))
	if err != nil {
		_ = tmp.Close()
		return written, err
	}
	if written > maxBytes {
		_ = tmp.Close()
		return written, ErrFileTooBig
	}
	if err := tmp.Chmod(0o640); err != nil {
		_ = tmp.Close()
		return written, err
	}
	if err := tmp.Close(); err != nil {
		return written, err
	}
	if err := os.Rename(tmpName, abs); err != nil {
		return written, err
	}
	return written, nil
}

func (s *Store) DeleteFile(spaceID, userPath string) error {
	abs, err := SafeJoin(s.FilesDir(spaceID), userPath)
	if err != nil {
		return err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return ErrSymlink
	}
	if info.IsDir() {
		return os.Remove(abs) // fails non-empty dirs — intentional
	}
	return os.Remove(abs)
}

func (s *Store) RenameFile(spaceID, from, to string) error {
	fromAbs, err := SafeJoin(s.FilesDir(spaceID), from)
	if err != nil {
		return err
	}
	toAbs, err := SafeJoin(s.FilesDir(spaceID), to)
	if err != nil {
		return err
	}
	info, err := os.Lstat(fromAbs)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return ErrSymlink
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o750); err != nil {
		return err
	}
	return os.Rename(fromAbs, toAbs)
}

func (s *Store) Mkdir(spaceID, userPath string) error {
	abs, err := SafeJoin(s.FilesDir(spaceID), userPath)
	if err != nil {
		return err
	}
	return os.MkdirAll(abs, 0o750)
}

// Stat returns the size and modtime of a file (does not read content).
func (s *Store) Stat(spaceID, userPath string) (os.FileInfo, error) {
	abs, err := SafeJoin(s.FilesDir(spaceID), userPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSymlink
	}
	return info, nil
}
