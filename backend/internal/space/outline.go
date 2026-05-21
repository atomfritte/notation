package space

import (
	"bufio"
	"os"
	"strings"
)

type Heading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	Line  int    `json:"line"`
}

// Outline returns the heading hierarchy of a markdown file with line numbers.
// Skips headings inside fenced code blocks (``` or ~~~) so code samples with
// `# comment` lines don't show up as outline entries.
func (s *Store) Outline(spaceID, userPath string) ([]Heading, error) {
	out := make([]Heading, 0)
	abs, err := SafeJoin(s.FilesDir(spaceID), userPath)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(abs)
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
		// Track fenced code blocks (``` or ~~~) so we ignore # lines inside them.
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
		// Trim trailing closing #s ("# heading #" form).
		text = strings.TrimRight(text, "#")
		text = strings.TrimSpace(text)
		// Strip inline markdown markers for cleaner display.
		text = strings.ReplaceAll(text, "`", "")
		if text == "" {
			continue
		}
		out = append(out, Heading{Level: level, Text: text, Line: lineNo})
	}
	return out, nil
}
