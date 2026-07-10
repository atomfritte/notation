package http

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
	"github.com/yoogie27/notation/internal/tts"
)

type shareHandlers struct {
	cfg      *config.Config
	store    *space.Store
	shares   *share.Store
	audit    *share.AuditLog
	comments *share.CommentStore
	git      *gitrepo.Manager
	tts      *tts.Synth
}

func (h *shareHandlers) resolve(r *http.Request) (string, share.Share, error) {
	return h.shares.Resolve(chi.URLParam(r, "token"))
}

// requireScope enforces a share's page/folder scope for one requested path.
// Denials are audit-logged (the guest holds a valid token but asked for
// content outside what the admin shared — worth a trace) and answered with a
// generic 403 that doesn't reveal whether the path exists.
func (h *shareHandlers) requireScope(w http.ResponseWriter, r *http.Request, spaceID, action, upath string, sh share.Share) bool {
	if sh.ScopeAllows(upath) {
		return true
	}
	h.audit1(spaceID, action, upath, sh, r, share.ErrScopeDenied)
	writeError(w, http.StatusForbidden, "outside share scope")
	return false
}

// scopeTree prunes a Space tree to a share's scope. A folder scope returns the
// folder's children (the guest sees the subtree as their whole world); a file
// or form-folder scope returns just that node. A vanished scope target yields
// an empty tree rather than an error — the link stays valid, just empty.
func scopeTree(entries []space.Entry, scope string) []space.Entry {
	if scope == "" {
		return entries
	}
	node := findTreeEntry(entries, scope)
	if node == nil {
		return []space.Entry{}
	}
	if node.IsDir && !node.Form {
		if node.Children == nil {
			return []space.Entry{}
		}
		return node.Children
	}
	return []space.Entry{*node}
}

func findTreeEntry(entries []space.Entry, path string) *space.Entry {
	for i := range entries {
		if entries[i].Path == path {
			return &entries[i]
		}
		if entries[i].IsDir {
			if hit := findTreeEntry(entries[i].Children, path); hit != nil {
				return hit
			}
		}
	}
	return nil
}

func actor(sh share.Share) string {
	return "share:" + sh.ID + ":" + string(sh.Permission)
}

func (h *shareHandlers) audit1(spaceID, action, path string, sh share.Share, r *http.Request, err error) {
	entry := share.AuditEntry{
		Actor:  actor(sh),
		Action: action,
		Path:   path,
		IP:     share.ClientIP(r, h.cfg.TrustProxy),
		UA:     r.UserAgent(),
	}
	if err != nil {
		entry.Err = err.Error()
	}
	_ = h.audit.Append(spaceID, entry)
}

func (h *shareHandlers) getSpace(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsRead() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	meta, err := h.store.Get(spaceID)
	if err != nil {
		writeSpaceError(w, err)
		return
	}
	h.shares.TouchLastUsed(spaceID, sh.ID)
	h.audit1(spaceID, "read.space", "", sh, r, nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"space":      map[string]string{"id": meta.ID, "name": meta.Name},
		"permission": sh.Permission,
		"scope":      sh.Scope,
		"label":      sh.Label,
		"features":   sh.Features,
	})
}

// searchSpace mirrors the admin search endpoint but is gated by the
// share's Features.Search flag so a creator who doesn't want their guest
// poking around with full-text search can disable it at create time.
func (h *shareHandlers) searchSpace(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsRead() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	if !sh.Features.Search {
		writeError(w, http.StatusForbidden, "search disabled for this share")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	opts := space.GrepOpts{
		Pattern:       q,
		Glob:          r.URL.Query().Get("glob"),
		CaseSensitive: false,
		ContextBefore: 0,
		ContextAfter:  0,
		MaxResults:    200,
		// A scoped share searches only inside its scope — enforced in the
		// walk itself, not by post-filtering, so out-of-scope files are never
		// even opened and the result cap can't be starved by unseen hits.
		PathPrefix: sh.Scope,
	}
	hits, err := h.store.Grep(spaceID, opts)
	if err != nil {
		writeInternal(w, r, "share.search", err)
		return
	}
	if hits == nil {
		hits = []space.GrepMatch{}
	}
	writeJSON(w, http.StatusOK, hits)
}

func (h *shareHandlers) getTree(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsRead() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	entries, err := h.store.Tree(spaceID)
	if err != nil {
		writeInternal(w, r, "share.tree", err)
		return
	}
	entries = scopeTree(entries, sh.Scope)
	h.audit1(spaceID, "read.tree", "", sh, r, nil)
	writeJSON(w, http.StatusOK, entries)
}

func (h *shareHandlers) getFile(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsRead() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	upath := chi.URLParam(r, "*")
	if !h.requireScope(w, r, spaceID, "read.file", upath, sh) {
		return
	}
	data, err := h.store.ReadFile(spaceID, upath)
	if err != nil {
		h.audit1(spaceID, "read.file", upath, sh, r, err)
		writeFileError(w, err)
		return
	}
	h.audit1(spaceID, "read.file", upath, sh, r, nil)
	var modTime time.Time
	if info, err := h.store.Stat(spaceID, upath); err == nil {
		modTime = info.ModTime()
	}
	writeFileResponse(w, r, upath, data, modTime)
}

func (h *shareHandlers) putFile(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsEdit() {
		writeError(w, http.StatusForbidden, "edit permission required")
		return
	}
	upath := chi.URLParam(r, "*")
	if !h.requireScope(w, r, spaceID, "write.file", upath, sh) {
		return
	}
	limited := http.MaxBytesReader(w, r.Body, h.cfg.MaxUploadBytes)
	defer limited.Close()
	if _, err := h.store.WriteFile(spaceID, upath, limited, h.cfg.MaxUploadBytes); err != nil {
		h.audit1(spaceID, "write.file", upath, sh, r, err)
		writeFileError(w, err)
		return
	}
	h.git.Schedule(spaceID, gitrepo.Author{
		Name:  "guest:" + sh.ID,
		Email: sh.ID + "@notation.share",
	})
	h.audit1(spaceID, "write.file", upath, sh, r, nil)
	w.WriteHeader(http.StatusNoContent)
}

type postCommentReq struct {
	Text     string        `json:"text"`
	ParentID string        `json:"parent_id,omitempty"`
	Anchor   *share.Anchor `json:"anchor,omitempty"`
}

func (h *shareHandlers) postComment(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsComment() {
		writeError(w, http.StatusForbidden, "comment permission required")
		return
	}
	upath := chi.URLParam(r, "*")
	if !h.requireScope(w, r, spaceID, "comment.add", upath, sh) {
		return
	}
	if _, err := h.store.Stat(spaceID, upath); err != nil {
		writeFileError(w, err)
		return
	}
	var req postCommentReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32*1024)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		writeError(w, http.StatusBadRequest, "text required")
		return
	}
	c, err := h.comments.Add(spaceID, upath, actor(sh), share.CommentInput{
		Text:     req.Text,
		ParentID: req.ParentID,
		Anchor:   req.Anchor,
	})
	if err != nil {
		writeCommentError(w, err)
		return
	}
	h.audit1(spaceID, "comment.add", upath, sh, r, nil)
	writeJSON(w, http.StatusCreated, c)
}

// listAllComments returns every comment in the Space so a share guest can
// browse them grouped by page (the sidebar "Comments" tab), mirroring the
// admin all-comments view. Gated on comment permission — a read-only share
// doesn't expose the comment overview.
func (h *shareHandlers) listAllComments(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsComment() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	list, err := h.comments.ListAll(spaceID)
	if err != nil {
		writeInternal(w, r, "share.comments.list_all", err)
		return
	}
	// A scoped share's comment overview must not leak discussion (or even the
	// existence) of pages outside the scope.
	scoped := make([]share.Comment, 0, len(list))
	for _, c := range list {
		if sh.ScopeAllows(c.Path) {
			scoped = append(scoped, c)
		}
	}
	writeJSON(w, http.StatusOK, scoped)
}

func (h *shareHandlers) listComments(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsRead() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	upath := chi.URLParam(r, "*")
	if !h.requireScope(w, r, spaceID, "comment.list", upath, sh) {
		return
	}
	if _, err := h.store.Stat(spaceID, upath); err != nil {
		writeFileError(w, err)
		return
	}
	list, err := h.comments.ListForFile(spaceID, upath)
	if err != nil {
		writeInternal(w, r, "share.comments.list", err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// getForm returns a form folder's schema + entries to a share guest. Any
// reader can view; only comment/edit guests get can_submit=true.
func (h *shareHandlers) getForm(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsRead() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	if !h.requireScope(w, r, spaceID, "read.form", chi.URLParam(r, "*"), sh) {
		return
	}
	// Guests may submit (with comment/edit) but never edit/delete entries.
	resp, err := buildFormResponse(h.store, spaceID, chi.URLParam(r, "*"), sh.Permission.AllowsComment(), false)
	if err != nil {
		writeFormError(w, err)
		return
	}
	h.audit1(spaceID, "read.form", chi.URLParam(r, "*"), sh, r, nil)
	writeJSON(w, http.StatusOK, resp)
}

// postFormEntry lets a comment/edit guest submit a form entry. The server
// validates against the schema and names the file itself, so a guest can only
// create a valid entry inside the form folder — not write arbitrary paths.
func (h *shareHandlers) postFormEntry(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsComment() {
		writeError(w, http.StatusForbidden, "comment permission required")
		return
	}
	folder := chi.URLParam(r, "*")
	if !h.requireScope(w, r, spaceID, "form.submit", folder, sh) {
		return
	}
	entry, err := submitFormEntry(h.store, h.cfg, spaceID, folder, w, r)
	if err != nil {
		h.audit1(spaceID, "form.submit", folder, sh, r, err)
		writeFormError(w, err)
		return
	}
	h.git.Schedule(spaceID, gitrepo.Author{
		Name:  "guest:" + sh.ID,
		Email: sh.ID + "@notation.share",
	})
	h.audit1(spaceID, "form.submit", folder, sh, r, nil)
	writeJSON(w, http.StatusCreated, entry)
}

// postFormImage lets a comment/edit guest upload an image attachment for a form
// (so they can fill an image field). Gated like submission, not general file
// writes — a comment guest can attach to a form without full edit rights.
func (h *shareHandlers) postFormImage(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsComment() {
		writeError(w, http.StatusForbidden, "comment permission required")
		return
	}
	folder := chi.URLParam(r, "*")
	if !h.requireScope(w, r, spaceID, "form.image", folder, sh) {
		return
	}
	path, err := uploadFormImage(h.store, h.cfg, spaceID, folder, w, r)
	if err != nil {
		h.audit1(spaceID, "form.image", folder, sh, r, err)
		writeFormError(w, err)
		return
	}
	h.git.Schedule(spaceID, gitrepo.Author{
		Name:  "guest:" + sh.ID,
		Email: sh.ID + "@notation.share",
	})
	h.audit1(spaceID, "form.image", folder, sh, r, nil)
	writeJSON(w, http.StatusCreated, map[string]string{"path": path})
}

func writeCommentError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, share.ErrCommentNotFound):
		writeError(w, http.StatusNotFound, "parent comment not found")
	case errors.Is(err, share.ErrCommentNested):
		writeError(w, http.StatusBadRequest, "replies cannot be nested further")
	case errors.Is(err, share.ErrCommentPath):
		writeError(w, http.StatusBadRequest, "parent comment is on a different file")
	default:
		// Generic message to the guest; keep the detail (which can embed
		// absolute filesystem paths) in the server log only.
		slog.Default().Error("share comment error", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

func writeShareError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, share.ErrShareNotFound):
		writeError(w, http.StatusNotFound, "share not found")
	case errors.Is(err, share.ErrShareExpired):
		writeError(w, http.StatusGone, "share has expired")
	case errors.Is(err, fs.ErrNotExist):
		writeError(w, http.StatusNotFound, "not found")
	default:
		slog.Default().Error("share error", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
