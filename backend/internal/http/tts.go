package http

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/yoogie27/notation/internal/tts"
)

// maxTTSChars bounds a single synthesis request. The reader chunks by paragraph
// (≤ ~500 chars), so this is a generous ceiling that also keeps the cacheable
// GET URL well within limits.
const maxTTSChars = 4000

// ttsInfoResponse advertises whether server TTS is available and which voices
// exist, so the frontend can offer the studio voice and pick one by language.
type ttsInfoResponse struct {
	Available bool        `json:"available"`
	Voices    []tts.Voice `json:"voices"`
}

func ttsInfo(synth *tts.Synth) ttsInfoResponse {
	if synth == nil || !synth.Available() {
		return ttsInfoResponse{Available: false, Voices: []tts.Voice{}}
	}
	return ttsInfoResponse{Available: true, Voices: synth.Voices()}
}

// serveTTS synthesises (or cache-hits) one text chunk and streams Ogg/Opus with
// immutable caching headers + Range support. `scope` isolates cache entries per
// security context; auth is the caller's concern.
func serveTTS(synth *tts.Synth, scope string, w http.ResponseWriter, r *http.Request) {
	if synth == nil || !synth.Available() {
		writeError(w, http.StatusServiceUnavailable, "server tts not available")
		return
	}
	text := r.URL.Query().Get("text")
	if len(text) > maxTTSChars {
		writeError(w, http.StatusRequestEntityTooLarge, "text too long")
		return
	}
	audio, etag, err := synth.Get(r.Context(), scope, r.URL.Query().Get("voice"), text)
	if err != nil {
		switch {
		case errors.Is(err, tts.ErrEmpty):
			writeError(w, http.StatusBadRequest, "missing text")
		case errors.Is(err, tts.ErrNoVoice):
			writeError(w, http.StatusNotFound, "no such voice")
		case errors.Is(err, tts.ErrUnavailable):
			writeError(w, http.StatusServiceUnavailable, "server tts not available")
		default:
			slog.Default().Error("tts synth failed", "err", err)
			writeError(w, http.StatusInternalServerError, "tts failed")
		}
		return
	}
	h := w.Header()
	h.Set("Content-Type", "audio/ogg")
	h.Set("ETag", etag)
	// Audio for a given voice+text never changes → cache hard. Private because
	// the endpoint is auth-gated (per-user/SW caches only, no shared proxies).
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	// ServeContent honours If-None-Match/Range against the ETag we set.
	http.ServeContent(w, r, "tts.opus", time.Time{}, bytes.NewReader(audio))
}

// ---- admin ----

func (h *adminHandlers) getTTSInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, ttsInfo(h.tts))
}

func (h *adminHandlers) getTTS(w http.ResponseWriter, r *http.Request) {
	serveTTS(h.tts, "admin", w, r)
}

// ---- share ----

func (h *shareHandlers) getTTSInfo(w http.ResponseWriter, r *http.Request) {
	_, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsRead() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	writeJSON(w, http.StatusOK, ttsInfo(h.tts))
}

func (h *shareHandlers) getTTS(w http.ResponseWriter, r *http.Request) {
	spaceID, sh, err := h.resolve(r)
	if err != nil {
		writeShareError(w, err)
		return
	}
	if !sh.Permission.AllowsRead() {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	serveTTS(h.tts, spaceID, w, r)
}
