package space

import (
	"bufio"
	"io"
	"strings"
)

type Heading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	Line  int    `json:"line"`
}

// Outline returns the heading hierarchy of a markdown file with line numbers.
// Reads through the os.Root sandbox so a symlinked path can't escape the
// Space. Skips headings inside fenced code blocks (``` or ~~~) so code
// samples with `# comment` lines don't show up as outline entries.
func (s *Store) Outline(spaceID, userPath string) ([]Heading, error) {
	rel, err := s.safeRel(spaceID, userPath)
	if err != nil {
		return nil, err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	f, err := root.Open(rel)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return scanHeadings(f, 6), nil
}

// FileMap is one file in a Space structure map: its path plus heading outline,
// without any body text.
type FileMap struct {
	Path     string    `json:"path"`
	Headings []Heading `json:"headings"`
}

// Map returns a structural map of the Space — every markdown file with its
// heading outline (no body text) — in a single walk. It reuses Tree(), so form
// folders are collapsed (their template + entries are not listed) exactly as in
// get_tree. dir scopes the map to a subdirectory (slash path, "" = whole
// Space); maxDepth bounds the deepest heading level included (clamped to 1..6,
// 0/out-of-range means all). Files that fail to open are skipped silently so a
// single unreadable file doesn't sink the whole map.
func (s *Store) Map(spaceID, dir string, maxDepth int) ([]FileMap, error) {
	if maxDepth <= 0 || maxDepth > 6 {
		maxDepth = 6
	}
	entries, err := s.Tree(spaceID)
	if err != nil {
		return nil, err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()

	prefix := ""
	if d := strings.Trim(strings.TrimSpace(dir), "/"); d != "" {
		prefix = d + "/"
	}

	out := make([]FileMap, 0)
	var walk func(es []Entry)
	walk = func(es []Entry) {
		for _, e := range es {
			if e.IsDir {
				walk(e.Children)
				continue
			}
			if !isMarkdownName(e.Name) {
				continue
			}
			if prefix != "" && !strings.HasPrefix(e.Path, prefix) {
				continue
			}
			f, err := root.Open(e.Path)
			if err != nil {
				continue
			}
			hs := scanHeadings(f, maxDepth)
			f.Close()
			out = append(out, FileMap{Path: e.Path, Headings: hs})
		}
	}
	walk(entries)
	return out, nil
}

func isMarkdownName(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown")
}

// scanHeadings extracts the heading outline from a markdown stream, skipping
// headings inside fenced code blocks and dropping any deeper than maxDepth.
func scanHeadings(r io.Reader, maxDepth int) []Heading {
	out := make([]Heading, 0)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	inFence := false
	var fenceMark string
	lineNo := 0
	for sc.Scan() {
		lineNo++
		raw := sc.Text()
		trimmed := strings.TrimLeft(raw, " \t")
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			mark := trimmed[:3]
			if !inFence {
				inFence = true
				fenceMark = mark
			} else if mark == fenceMark {
				inFence = false
			}
			continue
		}
		if inFence {
			continue
		}
		if !strings.HasPrefix(trimmed, "#") {
			continue
		}
		level := 0
		for level < len(trimmed) && level < 6 && trimmed[level] == '#' {
			level++
		}
		if level == 0 || level >= len(trimmed) {
			continue
		}
		if trimmed[level] != ' ' && trimmed[level] != '\t' {
			continue
		}
		if level > maxDepth {
			continue
		}
		text := strings.TrimSpace(trimmed[level:])
		text = strings.TrimRight(text, "#")
		text = strings.TrimSpace(text)
		text = strings.ReplaceAll(text, "`", "")
		if text == "" {
			continue
		}
		out = append(out, Heading{Level: level, Text: text, Line: lineNo})
	}
	return out
}
