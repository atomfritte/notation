package space

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"regexp"
	"strings"
)

// maxPatternLen bounds user-supplied regex / glob patterns so a malicious
// search can't burn CPU compiling a giant counted-repetition expression.
const maxPatternLen = 1024

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
// the optional glob filter, then streams matching files line-by-line for
// the regex. Memory is bounded by ContextBefore + pending matches, not by
// file size — see grepReader for the inner loop.
func (s *Store) Grep(spaceID string, opts GrepOpts) ([]GrepMatch, error) {
	out := make([]GrepMatch, 0)
	if opts.Pattern == "" {
		return out, errors.New("pattern is required")
	}
	// Bound the pattern length. RE2 is linear at match time, but compiling a
	// large counted-repetition pattern (e.g. `a{900}` chained thousands of
	// times) costs real CPU; reject oversized patterns before regexp.Compile so
	// a low-privilege search guest can't spend server cores on compilation.
	if len(opts.Pattern) > maxPatternLen || len(opts.Glob) > maxPatternLen {
		return out, errors.New("pattern too long")
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
		remaining := opts.MaxResults - len(out)
		hits := grepReader(f, p, re, opts.ContextBefore, opts.ContextAfter, remaining)
		_ = f.Close()
		out = append(out, hits...)
		if len(out) >= opts.MaxResults {
			return fs.SkipAll
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, fs.SkipAll) {
		return out, walkErr
	}
	return out, nil
}

// grepReader streams r line-by-line. Memory footprint is O(ctxBefore +
// in-flight matches), never the whole file. Match-with-after-context handling
// uses a "pending" list: when a match fires we stash it, and subsequent lines
// are appended as After until that line's count hits ctxAfter, at which point
// the match is emitted.
func grepReader(r io.Reader, p string, re *regexp.Regexp, ctxBefore, ctxAfter, maxRemaining int) []GrepMatch {
	out := make([]GrepMatch, 0)
	if maxRemaining <= 0 {
		return out
	}
	before := newRingBuf(ctxBefore)
	type pending struct {
		match     *GrepMatch
		matchLine int
	}
	var pendingList []*pending

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := sc.Text()

		// Feed this line into any pending after-collectors, and emit those
		// that have collected enough.
		kept := pendingList[:0]
		for _, pp := range pendingList {
			ac := lineNo - pp.matchLine
			if ac <= ctxAfter {
				pp.match.After = append(pp.match.After, clip(line, 400))
			}
			if ac >= ctxAfter {
				out = append(out, *pp.match)
				if len(out) >= maxRemaining {
					return out
				}
			} else {
				kept = append(kept, pp)
			}
		}
		pendingList = kept

		if re.MatchString(line) {
			m := &GrepMatch{
				Path:    p,
				Line:    lineNo,
				Content: clip(line, 400),
				Before:  before.snapshot(),
			}
			if ctxAfter > 0 {
				pendingList = append(pendingList, &pending{match: m, matchLine: lineNo})
			} else {
				out = append(out, *m)
				if len(out) >= maxRemaining {
					return out
				}
			}
		}
		before.push(line)
	}
	// EOF — flush remaining pending matches (their After is whatever we got).
	for _, pp := range pendingList {
		out = append(out, *pp.match)
		if len(out) >= maxRemaining {
			break
		}
	}
	return out
}

// ringBuf is a fixed-size circular buffer of strings used as the rolling
// "before-context" window for grepReader.
type ringBuf struct {
	buf  []string
	next int
	size int
}

func newRingBuf(size int) *ringBuf { return &ringBuf{size: size} }

func (rb *ringBuf) push(s string) {
	if rb.size == 0 {
		return
	}
	if len(rb.buf) < rb.size {
		rb.buf = append(rb.buf, s)
		return
	}
	rb.buf[rb.next] = s
	rb.next = (rb.next + 1) % rb.size
}

// snapshot returns the buffer contents in insertion order. Caller-owned copy.
func (rb *ringBuf) snapshot() []string {
	if rb.size == 0 || len(rb.buf) == 0 {
		return nil
	}
	if len(rb.buf) < rb.size {
		out := make([]string, len(rb.buf))
		copy(out, rb.buf)
		return out
	}
	out := make([]string, rb.size)
	copy(out, rb.buf[rb.next:])
	copy(out[rb.size-rb.next:], rb.buf[:rb.next])
	return out
}

// Glob returns paths under the Space's files dir that match the glob pattern.
// Supports `**` for cross-segment wildcards, `*`/`?` within a segment.
// Slash-delimited paths, dotfiles skipped.
func (s *Store) Glob(spaceID, pattern string, limit int) ([]string, error) {
	out := make([]string, 0)
	if pattern == "" {
		return out, nil
	}
	if len(pattern) > maxPatternLen {
		return out, errors.New("pattern too long")
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
