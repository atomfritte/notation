package share

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Comment struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	CreatedAt time.Time `json:"created_at"`
	Author    string    `json:"author"`
	Text      string    `json:"text"`
}

var ErrCommentNotFound = errors.New("comment not found")

// CommentStore persists comments per Space as JSONL in
// <space>/.notation/comments.jsonl. Document-level for now (no line/range
// anchoring) — sufficient for the comment-mode share level.
type CommentStore struct {
	spacesDir string
	mu        sync.Mutex
}

func NewCommentStore(spacesDir string) *CommentStore {
	return &CommentStore{spacesDir: spacesDir}
}

func (c *CommentStore) path(spaceID string) string {
	return filepath.Join(c.spacesDir, spaceID, ".notation", "comments.jsonl")
}

func (c *CommentStore) load(spaceID string) ([]Comment, error) {
	data, err := os.ReadFile(c.path(spaceID))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []Comment
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var c Comment
		if err := json.Unmarshal(line, &c); err == nil {
			out = append(out, c)
		}
	}
	return out, nil
}

func (c *CommentStore) save(spaceID string, comments []Comment) error {
	var buf bytes.Buffer
	for _, com := range comments {
		data, err := json.Marshal(com)
		if err != nil {
			return err
		}
		buf.Write(data)
		buf.WriteByte('\n')
	}
	return atomicWriteFile(c.path(spaceID), buf.Bytes(), 0o640)
}

func (c *CommentStore) Add(spaceID, filePath, author, text string) (Comment, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	list, err := c.load(spaceID)
	if err != nil {
		return Comment{}, err
	}
	nc := Comment{
		ID:        "c_" + randID(12),
		Path:      filePath,
		CreatedAt: time.Now().UTC(),
		Author:    author,
		Text:      strings.TrimSpace(text),
	}
	list = append(list, nc)
	if err := c.save(spaceID, list); err != nil {
		return Comment{}, err
	}
	return nc, nil
}

func (c *CommentStore) ListForFile(spaceID, filePath string) ([]Comment, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	list, err := c.load(spaceID)
	if err != nil {
		return nil, err
	}
	out := make([]Comment, 0)
	for _, x := range list {
		if x.Path == filePath {
			out = append(out, x)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (c *CommentStore) ListAll(spaceID string) ([]Comment, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.load(spaceID)
}

func (c *CommentStore) Delete(spaceID, commentID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	list, err := c.load(spaceID)
	if err != nil {
		return err
	}
	out := list[:0]
	found := false
	for _, x := range list {
		if x.ID == commentID {
			found = true
			continue
		}
		out = append(out, x)
	}
	if !found {
		return ErrCommentNotFound
	}
	return c.save(spaceID, out)
}

func randID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	s := base64.RawURLEncoding.EncodeToString(b)
	if len(s) > n {
		s = s[:n]
	}
	return s
}
