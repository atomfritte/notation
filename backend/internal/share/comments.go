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

// Anchor pins a comment to a specific text range using the W3C Web Annotation
// "TextQuoteSelector" pattern: quote = the selected text, prefix/suffix =
// short windows of surrounding text used to disambiguate when the same quote
// occurs multiple times in the document. Resolves robustly across small edits.
type Anchor struct {
	Quote  string `json:"quote"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

type Comment struct {
	ID        string    `json:"id"`
	ParentID  string    `json:"parent_id,omitempty"`
	Path      string    `json:"path"`
	CreatedAt time.Time `json:"created_at"`
	Author    string    `json:"author"`
	Text      string    `json:"text"`
	Anchor    *Anchor   `json:"anchor,omitempty"`
}

type CommentInput struct {
	Text     string
	ParentID string
	Anchor   *Anchor
}

var (
	ErrCommentNotFound = errors.New("comment not found")
	ErrCommentNested   = errors.New("replies cannot be nested further")
	ErrCommentPath     = errors.New("parent comment is on a different file")
)

// CommentStore persists comments per Space as JSONL in
// <space>/.notation/comments.jsonl.
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

// Add appends a comment. Reply semantics: if ParentID is set, the parent must
// exist on the same path and itself be a top-level comment (replies cannot be
// nested further — keeps the UI sane).
func (c *CommentStore) Add(spaceID, filePath, author string, in CommentInput) (Comment, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	list, err := c.load(spaceID)
	if err != nil {
		return Comment{}, err
	}
	if in.ParentID != "" {
		var parent *Comment
		for i := range list {
			if list[i].ID == in.ParentID {
				parent = &list[i]
				break
			}
		}
		if parent == nil {
			return Comment{}, ErrCommentNotFound
		}
		if parent.ParentID != "" {
			return Comment{}, ErrCommentNested
		}
		if parent.Path != filePath {
			return Comment{}, ErrCommentPath
		}
	}
	nc := Comment{
		ID:        "c_" + randID(12),
		ParentID:  in.ParentID,
		Path:      filePath,
		CreatedAt: time.Now().UTC(),
		Author:    author,
		Text:      strings.TrimSpace(in.Text),
		Anchor:    in.Anchor,
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

// Delete removes a comment by ID. If the deleted comment is a top-level entry,
// all of its replies are also removed (cascade).
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
		if x.ID == commentID || x.ParentID == commentID {
			if x.ID == commentID {
				found = true
			}
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
