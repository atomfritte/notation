package http

import (
	"encoding/json"
	"net/http"
	"testing"
)

// TestComment_EmojiReaction: a comment may be an anchored emoji reaction (emoji,
// no text); a comment with neither text nor emoji is rejected.
func TestComment_EmojiReaction(t *testing.T) {
	e := newIsoEnv(t)

	// Emoji reaction, no text → created and stored.
	body, _ := json.Marshal(map[string]any{
		"emoji":  "❤️",
		"anchor": map[string]string{"quote": "hello", "prefix": "", "suffix": ""},
	})
	rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/comments/notes/note1.md", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("emoji reaction: want 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	var c struct {
		Emoji string `json:"emoji"`
		Text  string `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &c); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if c.Emoji != "❤️" || c.Text != "" {
		t.Errorf("reaction not stored as emoji-only: %+v", c)
	}

	// Neither text nor emoji → 400.
	empty, _ := json.Marshal(map[string]any{})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/comments/notes/note1.md", empty); rec.Code != http.StatusBadRequest {
		t.Errorf("empty comment: want 400, got %d", rec.Code)
	}

	// A normal text comment still works.
	txt, _ := json.Marshal(map[string]any{"text": "a real comment"})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/comments/notes/note1.md", txt); rec.Code != http.StatusCreated {
		t.Errorf("text comment: want 201, got %d", rec.Code)
	}
}
