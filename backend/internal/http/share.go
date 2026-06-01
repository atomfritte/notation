package http

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
)

type shareHandlers struct {
	cfg      *config.Config
	store    *space.Store
	shares   *share.Store
	audit    *share.AuditLog
	comments *share.CommentStore
	git      *gitrepo.Manager
}

func (h *shareHandlers) resolve(r *http.Request) (string, share.Share, error) {
	return h.shares.Resolve(chi.URLParam(r, "token"))
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
	if list == nil {
		list = []share.Comment{}
	}
	writeJSON(w, http.StatusOK, list)
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

func writeCommentError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, share.ErrCommentNotFound):
		writeError(w, http.StatusNotFound, "parent comment not found")
	case errors.Is(err, share.ErrCommentNested):
		writeError(w, http.StatusBadRequest, "replies cannot be nested further")
	case errors.Is(err, share.ErrCommentPath):
		writeError(w, http.StatusBadRequest, "parent comment is on a different file")
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
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
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}
