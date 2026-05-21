package share

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type AuditEntry struct {
	Time   time.Time `json:"ts"`
	Actor  string    `json:"actor"`          // "share:<id>:<perm>" / "admin:<name>" / "mcp:<key-id>"
	Action string    `json:"action"`         // read.space / read.file / write.file / ...
	Path   string    `json:"path,omitempty"`
	IP     string    `json:"ip,omitempty"`
	UA     string    `json:"ua,omitempty"`
	Err    string    `json:"err,omitempty"`

	// PrevHash is the hex SHA-256 of the previous entry's serialized JSON
	// (without its own PrevHash field). Forms a tamper-evident chain: an
	// attacker editing or removing any past entry breaks the hash of every
	// subsequent line, and Verify will surface the break.
	PrevHash string `json:"prev_hash,omitempty"`
}

// AuditLog appends JSONL entries to <space>/.notation/audit.log. Entries are
// chained: each new entry's PrevHash is the SHA-256 of the previous entry's
// canonical bytes. We cache the last hash in memory so the common-case
// Append doesn't re-scan the file every time.
type AuditLog struct {
	spacesDir string
	mu        sync.Mutex
	lastHash  map[string]string // spaceID → hex sha256 of last entry
}

func NewAuditLog(spacesDir string) *AuditLog {
	return &AuditLog{spacesDir: spacesDir, lastHash: make(map[string]string)}
}

func (a *AuditLog) path(spaceID string) string {
	return filepath.Join(a.spacesDir, spaceID, ".notation", "audit.log")
}

func (a *AuditLog) Append(spaceID string, entry AuditEntry) error {
	if entry.Time.IsZero() {
		entry.Time = time.Now().UTC()
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	prev, ok := a.lastHash[spaceID]
	if !ok {
		// First write since startup — load tail of file to seed the chain.
		prev = a.loadLastHashLocked(spaceID)
		a.lastHash[spaceID] = prev
	}
	entry.PrevHash = prev

	path := a.path(spaceID)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	// Update lastHash: chain hashes the serialized entry as written (including
	// its prev_hash field) so the verifier can recompute deterministically.
	h := sha256.Sum256(data)
	a.lastHash[spaceID] = hex.EncodeToString(h[:])
	return nil
}

// loadLastHashLocked reads the last non-empty line of the audit log and
// returns its sha256. Empty file → empty hash (chain genesis).
func (a *AuditLog) loadLastHashLocked(spaceID string) string {
	data, err := os.ReadFile(a.path(spaceID))
	if err != nil {
		return ""
	}
	data = bytes.TrimRight(data, "\n")
	if len(data) == 0 {
		return ""
	}
	idx := bytes.LastIndexByte(data, '\n')
	last := data
	if idx >= 0 {
		last = data[idx+1:]
	}
	h := sha256.Sum256(last)
	return hex.EncodeToString(h[:])
}

// Read returns the most recent `limit` audit entries for a Space, newest-first.
func (a *AuditLog) Read(spaceID string, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 5000 {
		limit = 200
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	path := a.path(spaceID)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []AuditEntry{}, nil
		}
		return nil, err
	}
	out := make([]AuditEntry, 0)
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var e AuditEntry
		if err := json.Unmarshal(line, &e); err == nil {
			out = append(out, e)
		}
	}
	// Newest first
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// Verify walks the audit log front-to-back and confirms each entry's
// PrevHash matches the sha256 of the preceding entry's bytes. Returns the
// first 1-based line number where the chain breaks (0 = log is intact) plus
// a description. Surfacing this in an admin UI / CLI is the M5 deliverable.
func (a *AuditLog) Verify(spaceID string) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	data, err := os.ReadFile(a.path(spaceID))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	var prev string
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var e AuditEntry
		if err := json.Unmarshal(line, &e); err != nil {
			return lineNo, errors.New("malformed entry")
		}
		if e.PrevHash != prev {
			return lineNo, errors.New("prev_hash mismatch — log was tampered")
		}
		h := sha256.Sum256(line)
		prev = hex.EncodeToString(h[:])
	}
	return 0, nil
}
