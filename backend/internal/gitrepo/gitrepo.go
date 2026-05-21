// Package gitrepo wraps the `git` CLI for per-Space versioning. The git
// repository lives inside <space>/files/, which has two benefits:
//
//  1. The .notation/ sibling directory (tokens, audit log) is automatically
//     outside the repo, so secrets never get committed.
//  2. SafeJoin already rejects dotfiles, so the .git/ directory cannot be
//     touched through any of the file APIs.
package gitrepo

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yoogie27/notation/internal/space"
)

type Author struct {
	Name  string
	Email string
}

func (a Author) withDefaults() Author {
	if a.Name == "" {
		a.Name = "notation"
	}
	if a.Email == "" {
		a.Email = "notation@local"
	}
	return a
}

type Commit struct {
	Hash    string    `json:"hash"`
	Author  string    `json:"author"`
	Email   string    `json:"email"`
	Date    time.Time `json:"date"`
	Subject string    `json:"subject"`
}

var (
	commitHashRe = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
	ErrInvalidHash = errors.New("invalid commit hash")
)

type pending struct {
	timer  *time.Timer
	author Author
}

// Manager owns a debouncer per Space. Edits call Schedule(); after the
// debounce window passes with no further activity, an auto-commit is created
// using the latest author that triggered the window.
type Manager struct {
	store    *space.Store
	debounce time.Duration
	log      *slog.Logger

	mu      sync.Mutex
	pending map[string]*pending
	closed  bool
}

func NewManager(store *space.Store, debounce time.Duration, log *slog.Logger) *Manager {
	return &Manager{
		store:    store,
		debounce: debounce,
		log:      log,
		pending:  make(map[string]*pending),
	}
}

// Init runs `git init` inside <space>/files/ and sets a default user identity.
// Called once when a Space is first created. Idempotent: re-running on an
// already-initialized repo is a no-op.
func (m *Manager) Init(spaceID string) error {
	dir := m.store.FilesDir(spaceID)
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return nil
	}
	if _, err := run(dir, nil, "init", "-q", "-b", "main"); err != nil {
		return fmt.Errorf("git init: %w", err)
	}
	// Local config so commits work even if env vars are missing.
	_, _ = run(dir, nil, "config", "user.name", "notation")
	_, _ = run(dir, nil, "config", "user.email", "notation@local")
	return nil
}

// Schedule debounces a commit for the given Space. If a commit is already
// pending, its timer is reset and the latest author overwrites the previous
// (last-writer-wins semantics for the commit metadata).
func (m *Manager) Schedule(spaceID string, author Author) {
	author = author.withDefaults()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	if p, ok := m.pending[spaceID]; ok {
		p.timer.Stop()
		p.author = author
		p.timer = time.AfterFunc(m.debounce, func() { m.fire(spaceID) })
		return
	}
	p := &pending{author: author}
	p.timer = time.AfterFunc(m.debounce, func() { m.fire(spaceID) })
	m.pending[spaceID] = p
}

func (m *Manager) fire(spaceID string) {
	m.mu.Lock()
	p, ok := m.pending[spaceID]
	if !ok {
		m.mu.Unlock()
		return
	}
	author := p.author
	delete(m.pending, spaceID)
	m.mu.Unlock()
	if err := m.commit(spaceID, author, ""); err != nil {
		m.log.Error("auto-commit failed", "space", spaceID, "err", err)
	}
}

// FlushAll fires every pending debouncer immediately and blocks until each
// auto-commit finishes. Call on shutdown to avoid losing the last edit.
func (m *Manager) FlushAll() {
	m.mu.Lock()
	pendings := make(map[string]Author, len(m.pending))
	for id, p := range m.pending {
		p.timer.Stop()
		pendings[id] = p.author
	}
	m.pending = make(map[string]*pending)
	m.closed = true
	m.mu.Unlock()

	for id, a := range pendings {
		if err := m.commit(id, a, "flush on shutdown"); err != nil {
			m.log.Error("flush commit failed", "space", id, "err", err)
		}
	}
}

// SnapshotCommit creates a named (non-debounced) commit immediately.
// Useful for the "save snapshot" UI button (stage 8).
func (m *Manager) SnapshotCommit(spaceID string, author Author, message string) error {
	author = author.withDefaults()
	if strings.TrimSpace(message) == "" {
		message = "snapshot"
	}
	return m.commit(spaceID, author, message)
}

func (m *Manager) commit(spaceID string, author Author, label string) error {
	dir := m.store.FilesDir(spaceID)
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		// Repo doesn't exist — attempt init (e.g., older Space without git).
		if err := m.Init(spaceID); err != nil {
			return err
		}
	}
	if _, err := run(dir, nil, "add", "-A"); err != nil {
		return fmt.Errorf("git add: %w", err)
	}
	status, err := run(dir, nil, "status", "--porcelain")
	if err != nil {
		return fmt.Errorf("git status: %w", err)
	}
	if len(bytes.TrimSpace(status)) == 0 {
		return nil
	}
	message := "auto: " + author.Name
	if label != "" {
		message = label + ": " + author.Name
	}
	env := []string{
		"GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=" + author.Name,
		"GIT_AUTHOR_EMAIL=" + author.Email,
		"GIT_COMMITTER_NAME=" + author.Name,
		"GIT_COMMITTER_EMAIL=" + author.Email,
	}
	if _, err := run(dir, env, "commit", "-q", "-m", message); err != nil {
		return fmt.Errorf("git commit: %w", err)
	}
	return nil
}

// Log returns the most recent commits for a Space.
func (m *Manager) Log(spaceID string, limit int) ([]Commit, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	dir := m.store.FilesDir(spaceID)
	format := "%H%x09%an%x09%ae%x09%cI%x09%s"
	out, err := run(dir, nil, "log", "--max-count="+strconv.Itoa(limit), "--pretty=format:"+format)
	if err != nil {
		// Empty repo returns exit 128 with "does not have any commits yet" — treat as empty.
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return []Commit{}, nil
		}
		return nil, err
	}
	var commits []Commit
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 5)
		if len(parts) != 5 {
			continue
		}
		t, _ := time.Parse(time.RFC3339, parts[3])
		commits = append(commits, Commit{
			Hash: parts[0], Author: parts[1], Email: parts[2],
			Date: t, Subject: parts[4],
		})
	}
	return commits, nil
}

// ShowFileAtCommit returns the bytes of `userPath` as they existed at the
// given commit (`git show <hash>:<path>`). Used by the history viewer to
// render or restore past versions. Path is canonicalized via SafeJoin to
// reject traversal before git sees it.
func (m *Manager) ShowFileAtCommit(spaceID, hash, userPath string) ([]byte, error) {
	if !commitHashRe.MatchString(hash) {
		return nil, ErrInvalidHash
	}
	if _, err := space.SafeJoin(m.store.FilesDir(spaceID), userPath); err != nil {
		return nil, err
	}
	dir := m.store.FilesDir(spaceID)
	out, err := run(dir, nil, "show", hash+":"+userPath)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// FileDiff returns the unified diff of a specific path between two commits.
func (m *Manager) FileDiff(spaceID, from, to, userPath string) (string, error) {
	if !commitHashRe.MatchString(from) || !commitHashRe.MatchString(to) {
		return "", ErrInvalidHash
	}
	if _, err := space.SafeJoin(m.store.FilesDir(spaceID), userPath); err != nil {
		return "", err
	}
	dir := m.store.FilesDir(spaceID)
	out, err := run(dir, nil, "diff", "--no-color", from+".."+to, "--", userPath)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// Diff returns the unified diff of a single commit.
func (m *Manager) Diff(spaceID, hash string) (string, error) {
	if !commitHashRe.MatchString(hash) {
		return "", ErrInvalidHash
	}
	dir := m.store.FilesDir(spaceID)
	out, err := run(dir, nil, "show", "--no-color", "--format=fuller", hash)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// FileHistory returns commits that touched a specific path.
func (m *Manager) FileHistory(spaceID, userPath string, limit int) ([]Commit, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	// Validate path goes through SafeJoin even though we don't use the abs result —
	// this rejects traversal and dotfiles before passing to git.
	if _, err := space.SafeJoin(m.store.FilesDir(spaceID), userPath); err != nil {
		return nil, err
	}
	dir := m.store.FilesDir(spaceID)
	format := "%H%x09%an%x09%ae%x09%cI%x09%s"
	out, err := run(dir, nil, "log", "--max-count="+strconv.Itoa(limit), "--pretty=format:"+format, "--", userPath)
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return []Commit{}, nil
		}
		return nil, err
	}
	var commits []Commit
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 5)
		if len(parts) != 5 {
			continue
		}
		t, _ := time.Parse(time.RFC3339, parts[3])
		commits = append(commits, Commit{
			Hash: parts[0], Author: parts[1], Email: parts[2],
			Date: t, Subject: parts[4],
		})
	}
	return commits, nil
}

func run(workDir string, extraEnv []string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = workDir
	if extraEnv != nil {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}
