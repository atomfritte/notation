package space

import (
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Entry struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"` // slash-delimited, relative to files dir
	IsDir    bool    `json:"is_dir"`
	Size     int64   `json:"size"`
	Modified string  `json:"modified"` // RFC3339
	Children []Entry `json:"children,omitempty"`
}

// Tree returns a recursive listing of the Space's files directory. Dotfiles
// and symlinks are skipped silently (defense in depth — these shouldn't exist
// via the API anyway). Entries are sorted: directories first, then by name.
func (s *Store) Tree(spaceID string) ([]Entry, error) {
	return readDir(s.FilesDir(spaceID), "")
}

func readDir(root, prefix string) ([]Entry, error) {
	fullDir := filepath.Join(root, filepath.FromSlash(prefix))
	items, err := os.ReadDir(fullDir)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(items))
	for _, it := range items {
		if strings.HasPrefix(it.Name(), ".") {
			continue
		}
		info, err := os.Lstat(filepath.Join(fullDir, it.Name()))
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		rel := path.Join(prefix, it.Name())
		e := Entry{
			Name:     it.Name(),
			Path:     rel,
			IsDir:    info.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime().UTC().Format(time.RFC3339),
		}
		if info.IsDir() {
			children, err := readDir(root, rel)
			if err == nil {
				e.Children = children
			}
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}
