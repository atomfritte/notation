package share

import (
	"encoding/json"
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
