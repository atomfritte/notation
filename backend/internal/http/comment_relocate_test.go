package http

import (
	"encoding/json"
	"net/http"
	"testing"
)

// A comment is filed against a path, so anything that moves a file without
// moving its comments leaves the whole thread pointing at something that no
// longer opens. Two things have to hold: a rename carries the comments along by
// itself, and there is a repair route for the moves that never went through one.

func postComment(t *testing.T, e *isoEnv, path, text string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"text": text})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/comments/"+path, body); rec.Code != http.StatusCreated {
		t.Fatalf("post comment on %s: want 201, got %d body=%s", path, rec.Code, rec.Body.String())
	}
}

// commentTexts returns the comment bodies currently filed under `path`.
func commentTexts(t *testing.T, e *isoEnv, path string) []string {
	t.Helper()
	rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/comments/"+path, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list comments on %s: want 200, got %d body=%s", path, rec.Code, rec.Body.String())
	}
	var list []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode comments: %v", err)
	}
	out := make([]string, 0, len(list))
	for _, c := range list {
		out = append(out, c.Text)
	}
	return out
}

// TestRename_CarriesComments: renaming a file re-files its comments onto the new
// path, so a moved page keeps its thread.
func TestRename_CarriesComments(t *testing.T) {
	e := newIsoEnv(t)
	postComment(t, e, "notes/note1.md", "on the original")
	postComment(t, e, "notes/note1.md", "and a second one")

	body, _ := json.Marshal(map[string]any{"to": "archive/2026/note1.md"})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/rename/notes/note1.md", body); rec.Code != http.StatusNoContent {
		t.Fatalf("rename: want 204, got %d body=%s", rec.Code, rec.Body.String())
	}

	if got := commentTexts(t, e, "archive/2026/note1.md"); len(got) != 2 {
		t.Errorf("comments did not follow the rename: %v", got)
	}
	// Nothing left behind on a path that no longer exists.
	if rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/comments/notes/note1.md", nil); rec.Code == http.StatusOK {
		t.Errorf("old path still answers after rename: %s", rec.Body.String())
	}
}

// TestRelocateComments: the repair route re-files a vanished path's comments
// onto a file that does exist.
func TestRelocateComments(t *testing.T) {
	e := newIsoEnv(t)
	postComment(t, e, "notes/note1.md", "stranded")

	// Simulate what a delete-and-recreate elsewhere leaves behind: the file is
	// gone, its comment is not.
	if rec := e.admin(http.MethodDelete, "/api/admin/spaces/alpha/file/notes/note1.md", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: want 204, got %d", rec.Code)
	}

	body, _ := json.Marshal(map[string]any{"from": "notes/note1.md", "to": "notes/deep/inner.md"})
	rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/relocate-comments", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("relocate: want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Moved int `json:"moved"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.Moved != 1 {
		t.Errorf("moved = %d, want 1", res.Moved)
	}
	if got := commentTexts(t, e, "notes/deep/inner.md"); len(got) != 1 || got[0] != "stranded" {
		t.Errorf("comment did not land on the target: %v", got)
	}
}

// TestRelocateComments_Validation: comments can never be parked on a file that
// isn't there, and the request has to name both ends.
func TestRelocateComments_Validation(t *testing.T) {
	e := newIsoEnv(t)
	postComment(t, e, "notes/note1.md", "a note")

	missing, _ := json.Marshal(map[string]any{"from": "notes/note1.md", "to": "does/not/exist.md"})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/relocate-comments", missing); rec.Code != http.StatusNotFound {
		t.Errorf("relocate onto a missing file: want 404, got %d", rec.Code)
	}

	half, _ := json.Marshal(map[string]any{"from": "notes/note1.md"})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/relocate-comments", half); rec.Code != http.StatusBadRequest {
		t.Errorf("relocate without a target: want 400, got %d", rec.Code)
	}

	// Escaping the space is refused like every other path in the admin API.
	escape, _ := json.Marshal(map[string]any{"from": "notes/note1.md", "to": "../../beta/files/secret.md"})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/relocate-comments", escape); rec.Code == http.StatusOK {
		t.Errorf("path traversal in `to` was accepted: %s", rec.Body.String())
	}

	// The original comment is untouched by every rejected attempt.
	if got := commentTexts(t, e, "notes/note1.md"); len(got) != 1 {
		t.Errorf("comment lost during rejected relocations: %v", got)
	}
}

// TestRename_CarriesCommentsAcrossAFolder: renaming a FOLDER takes the comments
// on every file inside it along, each keeping its position in the subtree.
func TestRename_CarriesCommentsAcrossAFolder(t *testing.T) {
	e := newIsoEnv(t)
	postComment(t, e, "notes/note1.md", "top level")
	postComment(t, e, "notes/deep/inner.md", "nested")

	body, _ := json.Marshal(map[string]any{"to": "journal"})
	if rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/rename/notes", body); rec.Code != http.StatusNoContent {
		t.Fatalf("rename folder: want 204, got %d body=%s", rec.Code, rec.Body.String())
	}

	if got := commentTexts(t, e, "journal/note1.md"); len(got) != 1 || got[0] != "top level" {
		t.Errorf("comment on a direct child did not follow: %v", got)
	}
	if got := commentTexts(t, e, "journal/deep/inner.md"); len(got) != 1 || got[0] != "nested" {
		t.Errorf("comment deeper in the subtree did not follow: %v", got)
	}
}
