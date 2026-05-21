package space

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
)

// GrepMatch is one hit returned by Grep. Lines are 1-indexed.
type GrepMatch struct {
	Path    string   `json:"path"`
	Line    int      `json:"line"`
	Content string   `json:"content"`
	Before  []string `json:"before,omitempty"`
	After   []string `json:"after,omitempty"`
}

// GrepOpts mirrors a subset of ripgrep's flags. Pattern is a Go regex.
type GrepOpts struct {
	Pattern       string
	Glob          string
	CaseSensitive bool
	ContextBefore int
	ContextAfter  int
	MaxResults    int
}

// Grep walks the Space's file tree (through the os.Root sandbox), applies
// the optional glob filter, then scans matching files line-by-line for the
// regex. Returns up to MaxResults hits. Dotfiles / dotdirs and symlinks are
// skipped defensively.
func (s *Store) Grep(spaceID string, opts GrepOpts) ([]GrepMatch, error) {
	out := make([]GrepMatch, 0)
	if opts.Pattern == "" {
		return out, errors.New("pattern is required")
	}
	if opts.MaxResults <= 0 || opts.MaxResults > 1000 {
		opts.MaxResults = 200
	}
	if opts.ContextBefore < 0 || opts.ContextBefore > 50 {
		opts.ContextBefore = 0
	}
	if opts.ContextAfter < 0 || opts.ContextAfter > 50 {
		opts.ContextAfter = 0
	}
	patStr := opts.Pattern
	if !opts.CaseSensitive {
		patStr = "(?i)" + patStr
	}
	re, err := regexp.Compile(patStr)
	if err != nil {
		return nil, fmt.Errorf("invalid regex: %w", err)
	}

	var globRe *regexp.Regexp
	if opts.Glob != "" {
		gr, err := regexp.Compile(globToRegex(opts.Glob))
		if err != nil {
			return nil, fmt.Errorf("invalid glob: %w", err)
		}
		globRe = gr
	}

	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()

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
		if globRe != nil && !globRe.MatchString(p) {
			return nil
		}

		f, err := root.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()

		// Read full file into memory so we can emit context lines. For typical
		// Space sizes (markdown notes) this is cheap; M3 in the audit lists
		// streaming as a follow-up.
		lines := make([]string, 0, 64)
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			lines = append(lines, sc.Text())
		}

		for i, line := range lines {
			if !re.MatchString(line) {
				continue
			}
			m := GrepMatch{
				Path:    p,
				Line:    i + 1,
				Content: clip(line, 400),
			}
			if opts.ContextBefore > 0 {
				start := i - opts.ContextBefore
				if start < 0 {
					start = 0
				}
				for j := start; j < i; j++ {
					m.Before = append(m.Before, clip(lines[j], 400))
				}
			}
			if opts.ContextAfter > 0 {
				end := i + 1 + opts.ContextAfter
				if end > len(lines) {
					end = len(lines)
				}
				for j := i + 1; j < end; j++ {
					m.After = append(m.After, clip(lines[j], 400))
				}
			}
			out = append(out, m)
			if len(out) >= opts.MaxResults {
				return fs.SkipAll
			}
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, fs.SkipAll) {
		return out, walkErr
	}
	return out, nil
}

// Glob returns paths under the Space's files dir that match the glob pattern.
// Supports `**` for cross-segment wildcards, `*`/`?` within a segment.
// Slash-delimited paths, dotfiles skipped.
func (s *Store) Glob(spaceID, pattern string, limit int) ([]string, error) {
	out := make([]string, 0)
	if pattern == "" {
		return out, nil
	}
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	globRe, err := regexp.Compile(globToRegex(pattern))
	if err != nil {
		return nil, fmt.Errorf("invalid glob: %w", err)
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()
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
		if globRe.MatchString(p) {
			out = append(out, p)
			if len(out) >= limit {
				return fs.SkipAll
			}
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, fs.SkipAll) {
		return out, walkErr
	}
	return out, nil
}

// globToRegex converts a shell-style glob into a Go regex.
//
//	**   any number of path segments (including zero, and including `/`)
//	*    any chars within a single segment
//	?    any single char within a segment
//
// A `/` immediately following `**` is consumed so `**/foo` matches `foo` too.
func globToRegex(g string) string {
	var b strings.Builder
	b.WriteByte('^')
	i := 0
	for i < len(g) {
		c := g[i]
		if c == '*' && i+1 < len(g) && g[i+1] == '*' {
			b.WriteString(".*")
			i += 2
			if i < len(g) && g[i] == '/' {
				i++
			}
			continue
		}
		switch c {
		case '*':
			b.WriteString("[^/]*")
		case '?':
			b.WriteString("[^/]")
		case '.':
			b.WriteString(`\.`)
		case '+', '(', ')', '|', '[', ']', '{', '}', '^', '$', '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
		i++
	}
	b.WriteByte('$')
	return b.String()
}

func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	end := max
	for end > 0 && (s[end]&0xC0) == 0x80 {
		end--
	}
	return s[:end] + "…"
}
