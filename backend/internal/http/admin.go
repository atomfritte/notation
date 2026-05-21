package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/yoogie27/notation/internal/auth"
	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/mcptoken"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
)

type adminHandlers struct {
	cfg       *config.Config
	store     *space.Store
	git       *gitrepo.Manager
	shares    *share.Store
	mcpTokens *mcptoken.Store
	comments  *share.CommentStore
	audit     *share.AuditLog
}

func adminAuthor(r *http.Request) gitrepo.Author {
	u, _ := auth.AdminFromContext(r.Context())
	return gitrepo.Author{
		Name:  "admin:" + u.Name,
		Email: u.Name + "@notation.admin",
	}
}

func (h *adminHandlers) listSpaces(w http.ResponseWriter, r *http.Request) {
	spaces, err := h.store.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, spaces)
}

type createSpaceReq struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (h *adminHandlers) createSpace(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.AdminFromContext(r.Context())
	var req createSpaceReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	m, err := h.store.Create(req.ID, req.Name, user.Name)
	if err != nil {
		switch {
		case errors.Is(err, space.ErrInvalidID):
			writeError(w, http.StatusBadRequest, "invalid id (lowercase alphanumeric, _-, 3-32 chars)")
		case errors.Is(err, space.ErrExists):
			writeError(w, http.StatusConflict, "space already exists")
		default:
			writeError(w, http.StatusInternalServerError, "create failed: "+err.Error())
		}
		return
	}
	if err := h.git.Init(m.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "git init: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (h *adminHandlers) deleteSpace(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if err := h.store.Delete(id); err != nil {
		switch {
		case errors.Is(err, space.ErrInvalidID):
			writeError(w, http.StatusBadRequest, "invalid id")
		case errors.Is(err, space.ErrNotFound):
			writeError(w, http.StatusNotFound, "space not found")
		default:
			writeError(w, http.StatusInternalServerError, "delete failed: "+err.Error())
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *adminHandlers) getSpace(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	m, err := h.store.Get(id)
	if err != nil {
		writeSpaceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (h *adminHandlers) getTree(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	entries, err := h.store.Tree(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "tree failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (h *adminHandlers) getFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	upath := chi.URLParam(r, "*")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	data, err := h.store.ReadFile(id, upath)
	if err != nil {
		writeFileError(w, err)
		return
	}
	info, err := h.store.Stat(id, upath)
	if err == nil {
		w.Header().Set("ETag", `W/"`+fmt.Sprintf("%x", info.ModTime().UnixNano())+`"`)
	}
	mtype := mime.TypeByExtension(filepath.Ext(upath))
	if mtype == "" {
		mtype = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", mtype)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func (h *adminHandlers) putFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	upath := chi.URLParam(r, "*")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}

	if match := r.Header.Get("If-Match"); match != "" {
		info, err := h.store.Stat(id, upath)
		if err == nil {
			currentETag := `W/"` + fmt.Sprintf("%x", info.ModTime().UnixNano()) + `"`
			if match != currentETag && match != "*" {
				writeError(w, http.StatusPreconditionFailed, "file has been modified since last read")
				return
			}
		}
	}

	limited := http.MaxBytesReader(w, r.Body, h.cfg.MaxUploadBytes)
	defer limited.Close()
	if _, err := h.store.WriteFile(id, upath, limited, h.cfg.MaxUploadBytes); err != nil {
		writeFileError(w, err)
		return
	}
	h.git.Schedule(id, adminAuthor(r))
	w.WriteHeader(http.StatusNoContent)
}

func (h *adminHandlers) deleteFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	upath := chi.URLParam(r, "*")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	if err := h.store.DeleteFile(id, upath); err != nil {
		writeFileError(w, err)
		return
	}
	h.git.Schedule(id, adminAuthor(r))
	w.WriteHeader(http.StatusNoContent)
}

type renameReq struct {
	To string `json:"to"`
}

func (h *adminHandlers) renameFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	from := chi.URLParam(r, "*")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	var req renameReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.store.RenameFile(id, from, req.To); err != nil {
		writeFileError(w, err)
		return
	}
	h.git.Schedule(id, adminAuthor(r))
	w.WriteHeader(http.StatusNoContent)
}

type mkdirReq struct {
	Path string `json:"path"`
}

func (h *adminHandlers) mkdir(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	var req mkdirReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.store.Mkdir(id, req.Path); err != nil {
		writeFileError(w, err)
		return
	}
	// git doesn't track empty dirs; no Schedule() needed until a file lands.
	w.WriteHeader(http.StatusNoContent)
}

func (h *adminHandlers) getLog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	commits, err := h.git.Log(id, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "log: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, commits)
}

func (h *adminHandlers) getDiff(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	hash := chi.URLParam(r, "hash")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	diff, err := h.git.Diff(id, hash)
	if err != nil {
		if errors.Is(err, gitrepo.ErrInvalidHash) {
			writeError(w, http.StatusBadRequest, "invalid commit hash")
			return
		}
		writeError(w, http.StatusInternalServerError, "diff: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(diff))
}

type snapshotReq struct {
	Message string `json:"message"`
}

func (h *adminHandlers) snapshot(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	var req snapshotReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.git.SnapshotCommit(id, adminAuthor(r), req.Message); err != nil {
		writeError(w, http.StatusInternalServerError, "snapshot: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- shares ----

func (h *adminHandlers) listShares(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	views, err := h.shares.List(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, views)
}

type createShareReq struct {
	Permission share.Permission `json:"permission"`
	Label      string           `json:"label"`
	ExpiresIn  string           `json:"expires_in,omitempty"` // duration string e.g. "168h" (7d)
}

func (h *adminHandlers) createShare(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	user, _ := auth.AdminFromContext(r.Context())
	var req createShareReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !share.ValidPermission(req.Permission) {
		writeError(w, http.StatusBadRequest, "permission must be read|comment|edit")
		return
	}
	var expiresAt *time.Time
	if req.ExpiresIn != "" {
		d, err := time.ParseDuration(req.ExpiresIn)
		if err != nil || d <= 0 {
			writeError(w, http.StatusBadRequest, "invalid expires_in (e.g. 24h, 168h)")
			return
		}
		t := time.Now().UTC().Add(d)
		expiresAt = &t
	}
	res, err := h.shares.Create(id, req.Permission, req.Label, expiresAt, user.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	res.URL = shareURL(h.cfg, r, res.Token)
	writeJSON(w, http.StatusCreated, res)
}

func (h *adminHandlers) deleteShare(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	shareID := chi.URLParam(r, "shareID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	if err := h.shares.Delete(id, shareID); err != nil {
		if errors.Is(err, share.ErrShareNotFound) {
			writeError(w, http.StatusNotFound, "share not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- MCP tokens ----

func (h *adminHandlers) listMCPTokens(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	tokens, err := h.mcpTokens.List(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}

type createMCPTokenReq struct {
	Label string `json:"label"`
}

type createMCPTokenResp struct {
	Token mcptoken.View `json:"token"`
	Raw   string        `json:"raw"`
	URL   string        `json:"url"`
}

func (h *adminHandlers) createMCPToken(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	user, _ := auth.AdminFromContext(r.Context())
	var req createMCPTokenReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	res, err := h.mcpTokens.Create(id, req.Label, user.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	url := mcpURL(h.cfg, r, id)
	writeJSON(w, http.StatusCreated, createMCPTokenResp{Token: res.Token, Raw: res.Raw, URL: url})
}

func (h *adminHandlers) deleteMCPToken(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	tokenID := chi.URLParam(r, "tokenID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	if err := h.mcpTokens.Delete(id, tokenID); err != nil {
		if errors.Is(err, mcptoken.ErrNotFound) {
			writeError(w, http.StatusNotFound, "token not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- per-file history (restore + compare) ----

func (h *adminHandlers) fileHistory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	upath := chi.URLParam(r, "*")
	commits, err := h.git.FileHistory(id, upath, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "log: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, commits)
}

func (h *adminHandlers) fileAt(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	hash := chi.URLParam(r, "hash")
	upath := chi.URLParam(r, "*")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	data, err := h.git.ShowFileAtCommit(id, hash, upath)
	if err != nil {
		if errors.Is(err, gitrepo.ErrInvalidHash) {
			writeError(w, http.StatusBadRequest, "invalid commit hash")
			return
		}
		writeFileError(w, err)
		return
	}
	mtype := mime.TypeByExtension(filepath.Ext(upath))
	if mtype == "" {
		mtype = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", mtype)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func (h *adminHandlers) fileDiffAcross(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	upath := chi.URLParam(r, "*")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" || to == "" {
		writeError(w, http.StatusBadRequest, "from and to query params required")
		return
	}
	diff, err := h.git.FileDiff(id, from, to, upath)
	if err != nil {
		if errors.Is(err, gitrepo.ErrInvalidHash) {
			writeError(w, http.StatusBadRequest, "invalid commit hash")
			return
		}
		writeError(w, http.StatusInternalServerError, "diff: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(diff))
}

type restoreReq struct {
	Hash string `json:"hash"`
}

func (h *adminHandlers) restoreFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	upath := chi.URLParam(r, "*")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	var req restoreReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	data, err := h.git.ShowFileAtCommit(id, req.Hash, upath)
	if err != nil {
		if errors.Is(err, gitrepo.ErrInvalidHash) {
			writeError(w, http.StatusBadRequest, "invalid commit hash")
			return
		}
		writeFileError(w, err)
		return
	}
	if _, err := h.store.WriteFile(id, upath, bytes.NewReader(data), h.cfg.MaxUploadBytes); err != nil {
		writeFileError(w, err)
		return
	}
	short := req.Hash
	if len(short) > 7 {
		short = short[:7]
	}
	h.git.Schedule(id, gitrepo.Author{
		Name:  adminAuthor(r).Name + " (restore " + short + ")",
		Email: adminAuthor(r).Email,
	})
	w.WriteHeader(http.StatusNoContent)
}

// ---- search + audit ----

func (h *adminHandlers) search(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, []space.Match{})
		return
	}
	glob := r.URL.Query().Get("glob")
	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	matches, err := h.store.Search(id, q, glob, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "search: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, matches)
}

func (h *adminHandlers) getAudit(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 5000 {
			limit = n
		}
	}
	entries, err := h.audit.Read(id, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "audit: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func mcpURL(cfg *config.Config, r *http.Request, spaceID string) string {
	if cfg.BaseURL != "" {
		return cfg.BaseURL + cfg.MCPPath + "/" + spaceID
	}
	scheme := r.URL.Scheme
	if scheme == "" {
		if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
			scheme = proto
		} else if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host + cfg.MCPPath + "/" + spaceID
}

// shareURL prefers the explicit NOTATION_BASE_URL config; otherwise falls back
// to reconstructing it from the incoming request (honoring X-Forwarded-Proto
// and Host so the link works behind a reverse proxy).
func shareURL(cfg *config.Config, r *http.Request, token string) string {
	if cfg.BaseURL != "" {
		return cfg.BaseURL + cfg.SharePath + "/" + token
	}
	scheme := r.URL.Scheme
	if scheme == "" {
		if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
			scheme = proto
		} else if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host + cfg.SharePath + "/" + token
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeSpaceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, space.ErrInvalidID):
		writeError(w, http.StatusBadRequest, "invalid id")
	case errors.Is(err, space.ErrNotFound):
		writeError(w, http.StatusNotFound, "space not found")
	case errors.Is(err, space.ErrExists):
		writeError(w, http.StatusConflict, "space already exists")
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func writeFileError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, space.ErrPathEscape),
		errors.Is(err, space.ErrPathEmpty),
		errors.Is(err, space.ErrPathDot),
		errors.Is(err, space.ErrPathNUL):
		writeError(w, http.StatusBadRequest, "invalid path: "+err.Error())
	case errors.Is(err, space.ErrSymlink):
		writeError(w, http.StatusBadRequest, "symlinks are not allowed")
	case errors.Is(err, space.ErrIsDir):
		writeError(w, http.StatusBadRequest, "path is a directory")
	case errors.Is(err, space.ErrFileTooBig):
		writeError(w, http.StatusRequestEntityTooLarge, "file exceeds size limit")
	case errors.Is(err, fs.ErrNotExist):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, fs.ErrExist):
		writeError(w, http.StatusConflict, "already exists")
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// ---- comments ----

func (h *adminHandlers) listComments(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	upath := chi.URLParam(r, "*")
	if _, err := h.store.Stat(id, upath); err != nil {
		writeFileError(w, err)
		return
	}
	list, err := h.comments.ListForFile(id, upath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *adminHandlers) postComment(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	upath := chi.URLParam(r, "*")
	if _, err := h.store.Stat(id, upath); err != nil {
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
	author := adminAuthor(r).Name
	c, err := h.comments.Add(id, upath, author, share.CommentInput{
		Text:     req.Text,
		ParentID: req.ParentID,
		Anchor:   req.Anchor,
	})
	if err != nil {
		writeCommentError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}
