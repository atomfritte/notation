package http

import (
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

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
		IP:     share.ClientIP(r),
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
	})
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
		writeError(w, http.StatusInternalServerError, "tree: "+err.Error())
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
	mtype := mime.TypeByExtension(filepath.Ext(upath))
	if mtype == "" {
		mtype = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", mtype)
	w.Header().Set("Cache-Control", "no-store")
	h.audit1(spaceID, "read.file", upath, sh, r, nil)
	_, _ = w.Write(data)
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
	Text string `json:"text"`
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
	c, err := h.comments.Add(spaceID, upath, actor(sh), req.Text)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	h.audit1(spaceID, "comment.add", upath, sh, r, nil)
	writeJSON(w, http.StatusCreated, c)
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
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
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
