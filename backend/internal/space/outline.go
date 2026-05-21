package space

import (
	"bufio"
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
	out := make([]Heading, 0)
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

	sc := bufio.NewScanner(f)
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
		text := strings.TrimSpace(trimmed[level:])
		text = strings.TrimRight(text, "#")
		text = strings.TrimSpace(text)
		text = strings.ReplaceAll(text, "`", "")
		if text == "" {
			continue
		}
		out = append(out, Heading{Level: level, Text: text, Line: lineNo})
	}
	return out, nil
}
