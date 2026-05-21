package share

import (
	"bufio"
	"bytes"
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
	Actor  string    `json:"actor"`            // "share:<id>:<perm>" / "admin:<name>" / "mcp:<key-id>"
	Action string    `json:"action"`           // read.space / read.file / write.file / ...
	Path   string    `json:"path,omitempty"`
	IP     string    `json:"ip,omitempty"`
	UA     string    `json:"ua,omitempty"`
	Err    string    `json:"err,omitempty"`
}

// AuditLog appends JSONL entries to <space>/.notation/audit.log. The log is
// outside the git repo (which lives at <space>/files/) so secrets and IPs
// never enter the version history.
type AuditLog struct {
	spacesDir string
	mu        sync.Mutex
}

func NewAuditLog(spacesDir string) *AuditLog {
	return &AuditLog{spacesDir: spacesDir}
}

func (a *AuditLog) Append(spaceID string, entry AuditEntry) error {
	if entry.Time.IsZero() {
		entry.Time = time.Now().UTC()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	path := filepath.Join(a.spacesDir, spaceID, ".notation", "audit.log")
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	_, err = f.Write(append(data, '\n'))
	return err
}

// Read returns the most recent `limit` audit entries for a Space, newest-first.
// JSONL is read in full and truncated; fine for our log sizes (a few MB), would
// need a reverse-scanner for very large logs.
func (a *AuditLog) Read(spaceID string, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 5000 {
		limit = 200
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	path := filepath.Join(a.spacesDir, spaceID, ".notation", "audit.log")
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []AuditEntry{}, nil
		}
		return nil, err
	}
	var out []AuditEntry
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
	// Newest first; keep last `limit`.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

var _ = time.Time{} // keep time import even if not used elsewhere
