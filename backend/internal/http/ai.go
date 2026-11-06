package http

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/yoogie27/notation/internal/ai"
	"github.com/yoogie27/notation/internal/space"
)

// The in-app Claude assistant.
//
// The agent loop runs in the browser and talks to the Claude API DIRECTLY, so
// this server never relays a chat message — for a zero-knowledge Space it could
// not, without seeing plaintext. The handlers below cover only what has to be
// server-side:
//
//   - instance settings (/api/admin/ai/settings): the owner's API key (stored
//     0600, or taken from NOTATION_ANTHROPIC_API_KEY) plus defaults. Reads are
//     redacted; the key never appears in a settings response.
//   - key issue (POST /api/admin/ai/key): hands the key to the signed-in admin's
//     browser for the duration of the page. POST so it sits behind the CSRF
//     check, and no-store so it never lands in a cache.
//   - chat history (/api/admin/spaces/{id}/chats): opaque records the server
//     stores but never parses. A zero-knowledge Space only accepts sealed
//     records (see space/chats.go).

// aiEnabled 404s the request when the assistant is switched off for this
// instance. Settings stay readable so the UI can learn that it is off.
func (h *adminHandlers) aiEnabled(w http.ResponseWriter) bool {
	if h.ai == nil || !h.ai.Enabled() {
		writeError(w, http.StatusNotFound, "assistant disabled on this instance")
		return false
	}
	return true
}

func (h *adminHandlers) getAISettings(w http.ResponseWriter, r *http.Request) {
	if h.ai == nil {
		writeJSON(w, http.StatusOK, ai.View{})
		return
	}
	v, err := h.ai.View()
	if err != nil {
		writeInternal(w, r, "ai.settings.get", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, v)
}

func (h *adminHandlers) putAISettings(w http.ResponseWriter, r *http.Request) {
	if !h.aiEnabled(w) {
		return
	}
	var u ai.Update
	dec := json.NewDecoder(io.LimitReader(r.Body, ai.MaxInstructionsBytes+8<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&u); err != nil {
		writeError(w, http.StatusBadRequest, "invalid settings payload")
		return
	}
	v, err := h.ai.Apply(u)
	if err != nil {
		switch {
		case errors.Is(err, ai.ErrInvalidKey), errors.Is(err, ai.ErrInvalidModel),
			errors.Is(err, ai.ErrInvalidEffort), errors.Is(err, ai.ErrInstructionsTooLong),
			errors.Is(err, ai.ErrInvalidSkillsSpace), errors.Is(err, ai.ErrKeyFromEnv):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeInternal(w, r, "ai.settings.put", err)
		}
		return
	}
	if u.APIKey != nil {
		rid, _ := r.Context().Value(chimw.RequestIDKey).(string)
		slog.Default().Info("ai api key changed", "cleared", v.KeySource == "", "req_id", rid)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, v)
}

func (h *adminHandlers) issueAIKey(w http.ResponseWriter, r *http.Request) {
	if !h.aiEnabled(w) {
		return
	}
	key, err := h.ai.APIKey()
	if err != nil {
		writeInternal(w, r, "ai.key", err)
		return
	}
	if key == "" {
		writeError(w, http.StatusNotFound, "no API key configured")
		return
	}
	rid, _ := r.Context().Value(chimw.RequestIDKey).(string)
	slog.Default().Info("ai api key issued to admin browser", "req_id", rid)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"api_key": key})
}

// ---- chat history ----

type chatListItem struct {
	ID       string `json:"id"`
	Sealed   bool   `json:"sealed"`
	Modified string `json:"modified"`
	Size     int64  `json:"size"`
	Meta     string `json:"meta"` // base64 of the opaque meta record
}

func (h *adminHandlers) listChats(w http.ResponseWriter, r *http.Request) {
	if !h.aiEnabled(w) {
		return
	}
	id := chi.URLParam(r, "spaceID")
	chats, err := h.store.ListChats(id)
	if err != nil {
		if errors.Is(err, space.ErrNotFound) || errors.Is(err, space.ErrInvalidID) {
			writeSpaceError(w, err)
			return
		}
		writeInternal(w, r, "chats.list", err)
		return
	}
	out := make([]chatListItem, 0, len(chats))
	for _, c := range chats {
		out = append(out, chatListItem{
			ID:       c.ID,
			Sealed:   c.Sealed,
			Modified: c.Modified.Format("2006-01-02T15:04:05.000Z07:00"),
			Size:     c.Size,
			Meta:     base64.StdEncoding.EncodeToString(c.Meta),
		})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}

func (h *adminHandlers) getChat(w http.ResponseWriter, r *http.Request) {
	if !h.aiEnabled(w) {
		return
	}
	id := chi.URLParam(r, "spaceID")
	chatID := chi.URLParam(r, "chatID")
	var sealed *bool
	switch r.URL.Query().Get("sealed") {
	case "1":
		t := true
		sealed = &t
	case "0":
		f := false
		sealed = &f
	}
	data, err := h.store.ReadChat(id, chatID, sealed)
	if err != nil {
		switch {
		case errors.Is(err, space.ErrInvalidChatID):
			writeError(w, http.StatusBadRequest, "invalid chat id")
		case errors.Is(err, fs.ErrNotExist):
			writeError(w, http.StatusNotFound, "chat not found")
		case errors.Is(err, space.ErrNotFound), errors.Is(err, space.ErrInvalidID):
			writeSpaceError(w, err)
		default:
			writeInternal(w, r, "chats.get", err)
		}
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

type putChatReq struct {
	Meta string `json:"meta"` // base64
	Body string `json:"body"` // base64
}

func (h *adminHandlers) putChat(w http.ResponseWriter, r *http.Request) {
	if !h.aiEnabled(w) {
		return
	}
	id := chi.URLParam(r, "spaceID")
	chatID := chi.URLParam(r, "chatID")
	if !space.ValidChatID(chatID) {
		writeError(w, http.StatusBadRequest, "invalid chat id")
		return
	}
	// base64 inflates by 4/3; leave room for the JSON envelope.
	limit := h.cfg.MaxUploadBytes*4/3 + space.MaxChatMetaBytes*2 + 1024
	var req putChatReq
	if err := json.NewDecoder(io.LimitReader(r.Body, limit)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid chat payload")
		return
	}
	meta, err1 := base64.StdEncoding.DecodeString(req.Meta)
	body, err2 := base64.StdEncoding.DecodeString(req.Body)
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusBadRequest, "invalid chat encoding")
		return
	}
	if err := h.store.WriteChat(id, chatID, meta, body, h.cfg.MaxUploadBytes); err != nil {
		switch {
		case errors.Is(err, space.ErrChatFormat):
			// The one rule this endpoint exists to enforce: a zero-knowledge Space
			// never stores a plaintext chat (and a plaintext Space never stores
			// one it couldn't show after the key is gone).
			writeError(w, http.StatusConflict, err.Error())
		case errors.Is(err, space.ErrChatTooLarge):
			writeError(w, http.StatusRequestEntityTooLarge, err.Error())
		case errors.Is(err, space.ErrNotFound), errors.Is(err, space.ErrInvalidID):
			writeSpaceError(w, err)
		default:
			writeInternal(w, r, "chats.put", err)
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *adminHandlers) deleteChat(w http.ResponseWriter, r *http.Request) {
	if !h.aiEnabled(w) {
		return
	}
	id := chi.URLParam(r, "spaceID")
	chatID := chi.URLParam(r, "chatID")
	if err := h.store.DeleteChat(id, chatID); err != nil {
		switch {
		case errors.Is(err, space.ErrInvalidChatID):
			writeError(w, http.StatusBadRequest, "invalid chat id")
		case errors.Is(err, fs.ErrNotExist):
			writeError(w, http.StatusNotFound, "chat not found")
		case errors.Is(err, space.ErrNotFound), errors.Is(err, space.ErrInvalidID):
			writeSpaceError(w, err)
		default:
			writeInternal(w, r, "chats.delete", err)
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
