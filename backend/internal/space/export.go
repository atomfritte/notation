package space

import (
	"archive/zip"
	"io"
	"io/fs"
	"strings"
)

// WriteZip streams every file in the Space into w as a ZIP archive. It walks
// through the same os.Root sandbox as every other file op, and skips dotfiles,
// dot-directories, and symlinks — mirroring the search/tree walkers so the
// export contains exactly the files a user can see in the tree.
//
// The caller is responsible for response headers; WriteZip only writes the
// archive bytes. Because it streams, a mid-walk error may arrive after some
// bytes are already on the wire — callers that haven't flushed headers should
// treat a non-nil error as fatal, others can only log it.
func (s *Store) WriteZip(spaceID string, w io.Writer) error {
	root, err := s.openRoot(spaceID)
	if err != nil {
		return err
	}
	defer root.Close()

	zw := zip.NewWriter(w)

	walkErr := fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") && p != "." {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		f, err := root.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()

		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = p // forward-slash relative path, exactly the tree path
		hdr.Method = zip.Deflate
		entry, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		_, err = io.Copy(entry, f)
		return err
	})
	if walkErr != nil {
		_ = zw.Close()
		return walkErr
	}
	return zw.Close()
}
