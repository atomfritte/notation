package space

import (
	"bufio"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

type Match struct {
	Path    string  `json:"path"`
	Line    int     `json:"line"`
	Content string  `json:"content"`
}

// Search performs a substring (case-insensitive) match across all files in the
// Space. Optional globPattern (e.g. "*.md", "**/*.md") restricts which files
// are scanned. Returns up to maxResults matches. The result is fast enough for
// small Spaces (under a few thousand files); for larger trees we'd want to
// shell out to ripgrep.
func (s *Store) Search(spaceID, query, globPattern string, maxResults int) ([]Match, error) {
	if query == "" {
		return nil, nil
	}
	if maxResults <= 0 || maxResults > 1000 {
		maxResults = 200
	}
	root := s.FilesDir(spaceID)
	needle := strings.ToLower(query)
	var out []Match
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable paths
		}
		// Skip dot dirs (e.g. .git) and dot files defensively.
		if d.IsDir() {
			name := d.Name()
			if strings.HasPrefix(name, ".") && p != root {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		if info, _ := d.Info(); info != nil && info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if globPattern != "" {
			ok, err := path.Match(globPattern, relSlash)
			if err != nil {
				return nil
			}
			if !ok {
				return nil
			}
		}
		f, err := os.Open(p)
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
				out = append(out, Match{Path: relSlash, Line: lineNo, Content: snippet})
				if len(out) >= maxResults {
					return filepath.SkipAll
				}
			}
		}
		return nil
	})
	if err != nil && err != filepath.SkipAll {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Line < out[j].Line
	})
	return out, nil
}
