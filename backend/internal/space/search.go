package space

import (
	"bufio"
	"io/fs"
	"path"
	"strings"
)

type Match struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Content string `json:"content"`
}

// Search performs a substring (case-insensitive) match across all files in
// the Space. Optional globPattern (e.g. "*.md") restricts which files are
// scanned. Returns up to maxResults matches. Walks the file tree through
// the os.Root sandbox.
func (s *Store) Search(spaceID, query, globPattern string, maxResults int) ([]Match, error) {
	out := make([]Match, 0)
	if query == "" {
		return out, nil
	}
	if maxResults <= 0 || maxResults > 1000 {
		maxResults = 200
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	needle := strings.ToLower(query)

	err = fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, walkErr error) error {
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
			name := d.Name()
			if strings.HasPrefix(name, ".") && p != "." {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		if globPattern != "" {
			ok, err := path.Match(globPattern, p)
			if err != nil || !ok {
				return nil
			}
		}
		f, err := root.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		lineNo := 0
		for scanner.Scan() {
			lineNo++
			line := scanner.Text()
			if strings.Contains(strings.ToLower(line), needle) {
				snippet := line
				if len(snippet) > 240 {
					snippet = snippet[:240] + "…"
				}
				out = append(out, Match{Path: p, Line: lineNo, Content: snippet})
				if len(out) >= maxResults {
					return fs.SkipAll
				}
			}
		}
		return nil
	})
	if err != nil && err != fs.SkipAll {
		return out, err
	}
	return out, nil
}
