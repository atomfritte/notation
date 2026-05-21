package space

import (
	"os"
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
// and symlinks are skipped silently. Entries are sorted: directories first,
// then by name (case-insensitive).
func (s *Store) Tree(spaceID string) ([]Entry, error) {
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return readDirInRoot(root, ".")
}

func readDirInRoot(root *os.Root, dir string) ([]Entry, error) {
	f, err := root.Open(dir)
	if err != nil {
		return nil, err
	}
	items, err := f.ReadDir(-1)
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(items))
	for _, it := range items {
		if strings.HasPrefix(it.Name(), ".") {
			continue
		}
		var rel string
		if dir == "." || dir == "" {
			rel = it.Name()
		} else {
			rel = dir + "/" + it.Name()
		}
		info, err := root.Lstat(rel)
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		e := Entry{
			Name:     it.Name(),
			Path:     rel,
			IsDir:    info.IsDir(),
			Size:     info.Size(),
			Modified: info.ModTime().UTC().Format(time.RFC3339),
		}
		if info.IsDir() {
			children, err := readDirInRoot(root, rel)
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
