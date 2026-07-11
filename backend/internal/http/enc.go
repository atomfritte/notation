package http

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/yoogie27/notation/internal/space"
)

// This file wires the blind zero-knowledge blob + op-log store to HTTP. Every
// handler operates on opaque ciphertext bytes; the server never decrypts and
// never needs the space key. All routes live under the existing
// /api/admin/spaces/{spaceID} subtree, so they inherit rate-limit + admin auth
// + CSRF.
//
// A Space is EITHER a plaintext filesystem OR an opaque blob store, never both.
// Two gates enforce that split:
//   - requireEncrypted: the /enc/* handlers 409 on a plaintext space.
//   - requirePlaintext: a middleware that 409s the normal file/tree/search/…
//     endpoints on an encrypted space (centralised so no content route can
//     forget it).

// requireEncrypted resolves the space and rejects (409) if it is not encrypted.
// Returns the space id and true on success.
func (h *adminHandlers) requireEncrypted(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "spaceID")
	m, err := h.store.Get(id)
	if err != nil {
		writeSpaceError(w, err)
		return "", false
	}
	if !m.Encrypted {
		writeError(w, http.StatusConflict, "space is not encrypted")
		return "", false
	}
	return id, true
}

// requirePlaintext is the mirror gate as chi middleware: it 409s every wrapped
// (plaintext-only) content route when the space is encrypted. Centralising it
// here means a newly added file endpoint can't silently skip the check — it
// just has to live in the guarded route group.
func (h *adminHandlers) requirePlaintext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "spaceID")
		m, err := h.store.Get(id)
		if err != nil {
			writeSpaceError(w, err)
			return
		}
		if m.Encrypted {
			writeError(w, http.StatusConflict, "space is encrypted; use the /enc endpoints")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *adminHandlers) writeEncError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, space.ErrInvalidEncID):
		writeError(w, http.StatusBadRequest, "invalid opaque id (8-64 hex chars)")
	case errors.Is(err, space.ErrNotEncrypted):
		writeError(w, http.StatusConflict, "space is not encrypted")
	default:
		// Reuse the file-error mapping: fs.ErrNotExist→404, ErrFileTooBig→413,
		// path-escape→400, everything else logged + generic 500.
		writeFileError(w, err)
	}
}

// writeRawBytes emits opaque ciphertext with headers that keep it inert: never
// sniffed, never cached.
func writeRawBytes(w http.ResponseWriter, contentType string, data []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

// ---- content blobs ----

func (h *adminHandlers) putBlob(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	limited := http.MaxBytesReader(w, r.Body, h.cfg.MaxUploadBytes)
	defer limited.Close()
	if err := h.store.WriteBlob(id, chi.URLParam(r, "blobId"), limited, h.cfg.MaxUploadBytes); err != nil {
		h.writeEncError(w, err)
		return
	}
	h.git.Schedule(id, adminAuthor(r))
	w.WriteHeader(http.StatusNoContent)
}

func (h *adminHandlers) getBlob(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	data, err := h.store.ReadBlob(id, chi.URLParam(r, "blobId"))
	if err != nil {
		h.writeEncError(w, err)
		return
	}
	writeRawBytes(w, "application/octet-stream", data)
}

func (h *adminHandlers) deleteBlob(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	if err := h.store.DeleteBlob(id, chi.URLParam(r, "blobId")); err != nil {
		h.writeEncError(w, err)
		return
	}
	h.git.Schedule(id, adminAuthor(r))
	w.WriteHeader(http.StatusNoContent)
}

// ---- op-log ----

func (h *adminHandlers) postOp(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	opID := r.URL.Query().Get("opId")
	if opID == "" {
		opID = r.Header.Get("X-Op-Id")
	}
	if !space.ValidEncID(opID) {
		writeError(w, http.StatusBadRequest, "invalid or missing opId (8-64 hex chars)")
		return
	}
	limited := http.MaxBytesReader(w, r.Body, h.cfg.MaxUploadBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "op envelope exceeds size limit")
		return
	}
	seq, err := h.store.AppendOp(id, opID, data, h.cfg.MaxUploadBytes)
	if err != nil {
		h.writeEncError(w, err)
		return
	}
	h.git.Schedule(id, adminAuthor(r))
	writeJSON(w, http.StatusCreated, map[string]int64{"seq": seq})
}

func (h *adminHandlers) getOps(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	var since int64
	if s := r.URL.Query().Get("since"); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "invalid since (non-negative integer)")
			return
		}
		since = n
	}
	ops, err := h.store.ListOps(id, since)
	if err != nil {
		h.writeEncError(w, err)
		return
	}
	if ops == nil {
		ops = []space.OpRecord{}
	}
	writeJSON(w, http.StatusOK, ops)
}

// ---- checkpoint ----

func (h *adminHandlers) putCheckpoint(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	limited := http.MaxBytesReader(w, r.Body, h.cfg.MaxUploadBytes)
	defer limited.Close()
	if err := h.store.WriteCheckpoint(id, limited, h.cfg.MaxUploadBytes); err != nil {
		h.writeEncError(w, err)
		return
	}
	h.git.Schedule(id, adminAuthor(r))
	w.WriteHeader(http.StatusNoContent)
}

func (h *adminHandlers) getCheckpoint(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	data, err := h.store.ReadCheckpoint(id)
	if err != nil {
		h.writeEncError(w, err)
		return
	}
	writeRawBytes(w, "application/octet-stream", data)
}

// ---- key record ----

func (h *adminHandlers) putKeyRecord(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	// The SpaceKeyRecord is small (KDF params + salt + two wrapped DEKs); a 1 MiB
	// cap is generous. It is JSON passthrough — validated only as well-formed
	// JSON, then stored verbatim.
	limited := http.MaxBytesReader(w, r.Body, 1<<20)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "key record exceeds size limit")
		return
	}
	if !json.Valid(data) {
		writeError(w, http.StatusBadRequest, "key record must be valid JSON")
		return
	}
	if err := h.store.WriteKeyRecord(id, data); err != nil {
		h.writeEncError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *adminHandlers) getKeyRecord(w http.ResponseWriter, r *http.Request) {
	id, ok := h.requireEncrypted(w, r)
	if !ok {
		return
	}
	data, err := h.store.ReadKeyRecord(id)
	if err != nil {
		h.writeEncError(w, err)
		return
	}
	writeRawBytes(w, "application/json", data)
}
