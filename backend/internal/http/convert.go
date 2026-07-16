package http

// Convert an EXISTING plaintext Space to encrypted (and back). This is the only
// DESTRUCTIVE operation in the zero-knowledge feature — finalize-convert purges
// the other-mode content and re-initialises git so the old bytes don't survive
// in history.
//
// The three endpoints implement the safety ordering:
//
//	begin-convert     set the transient Meta.Converting marker (relaxes the gate)
//	                  — NON-destructive.
//	abort-convert     drop the staged target-mode data, leave the ORIGINAL mode
//	                  fully intact — safe any time mid-conversion.
//	finalize-convert  the destructive commit: purge the source mode, flip the
//	                  encrypted flag, re-init git.
//
// Plaintext is destroyed only by finalize, after the client has staged all
// ciphertext AND its key record, so a crash/abort before then loses nothing.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/yoogie27/notation/internal/space"
)

type beginConvertReq struct {
	Direction string `json:"direction"`
}

// beginConvert sets the conversion marker. It refuses (409) if the space is
// already converting or the direction contradicts the current mode, and for
// to-encrypted it refuses if a top-level entry would collide with the ciphertext
// layout (blobs/ops/checkpoint). NON-destructive.
func (h *adminHandlers) beginConvert(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	m, err := h.store.Get(id)
	if err != nil {
		writeSpaceError(w, err)
		return
	}
	var req beginConvertReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch req.Direction {
	case space.ConvertToEncrypted, space.ConvertToPlaintext:
	default:
		writeError(w, http.StatusBadRequest, "direction must be to-encrypted or to-plaintext")
		return
	}
	if m.Converting != "" {
		writeError(w, http.StatusConflict, "space is already converting")
		return
	}
	if req.Direction == space.ConvertToEncrypted && m.Encrypted {
		writeError(w, http.StatusConflict, "space is already encrypted")
		return
	}
	if req.Direction == space.ConvertToPlaintext && !m.Encrypted {
		writeError(w, http.StatusConflict, "space is already plaintext")
		return
	}
	if req.Direction == space.ConvertToEncrypted {
		reserved, err := h.store.HasReservedTopLevel(id)
		if err != nil {
			writeInternal(w, r, "convert.begin.reserved", err)
			return
		}
		if reserved {
			writeError(w, http.StatusConflict, "a top-level file or folder is named blobs/ops/checkpoint; rename it before encrypting")
			return
		}
	}
	if err := h.store.BeginConvert(id, req.Direction); err != nil {
		writeConvertError(w, r, err)
		return
	}
	m, err = h.store.Get(id)
	if err != nil {
		writeSpaceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// abortConvert clears the marker and cleans the staged data for the in-progress
// direction, leaving the space in its ORIGINAL mode intact. Idempotent: calling
// it on a settled space just returns the current meta. Safe any time.
func (h *adminHandlers) abortConvert(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	m, err := h.store.Get(id)
	if err != nil {
		writeSpaceError(w, err)
		return
	}
	if m.Converting == "" {
		writeJSON(w, http.StatusOK, m)
		return
	}
	// Data-loss guard: if a finalize already purged the SOURCE mode but crashed
	// before finishing (e.g. the reinit race), the only surviving copy of the
	// content is the staged TARGET-mode data. Aborting would discard it and leave
	// an empty space. Refuse — the user must resume (re-run finalize) instead.
	staged, err := h.store.CountPlaintextFiles(id)
	if err != nil {
		writeInternal(w, r, "convert.abort.count", err)
		return
	}
	hasEnc, err := h.store.HasEncContent(id)
	if err != nil {
		writeInternal(w, r, "convert.abort.hasenc", err)
		return
	}
	switch m.Converting {
	case space.ConvertToEncrypted:
		if staged == 0 && hasEnc {
			writeError(w, http.StatusConflict, "this space is past the point of no return: the plaintext was already replaced by ciphertext. Use Resume to finish encrypting — aborting now would lose your content.")
			return
		}
	case space.ConvertToPlaintext:
		if !hasEnc && staged > 0 {
			writeError(w, http.StatusConflict, "this space is past the point of no return: the ciphertext was already replaced by plaintext. Use Resume to finish decrypting — aborting now would lose your content.")
			return
		}
	}
	if err := h.store.AbortConvert(id); err != nil {
		writeConvertError(w, r, err)
		return
	}
	// Version the cleaned tree so the working copy and git agree again.
	h.git.Schedule(id, adminAuthor(r))
	m, err = h.store.Get(id)
	if err != nil {
		writeSpaceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// finalizeConvert is the destructive commit. For to-encrypted it verifies the key
// record is present, purges the plaintext tree, re-inits git (purging plaintext
// history), then flips encrypted=true. For to-plaintext it verifies plaintext was
// staged, purges the ciphertext artifacts, re-inits git, then flips
// encrypted=false. The meta flip is LAST so a failure mid-way leaves Converting
// set and the operation safely retryable.
func (h *adminHandlers) finalizeConvert(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	m, err := h.store.Get(id)
	if err != nil {
		writeSpaceError(w, err)
		return
	}
	switch m.Converting {
	case space.ConvertToEncrypted:
		if _, err := h.store.ReadKeyRecord(id); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeError(w, http.StatusConflict, "cannot finalize: key record not uploaded yet")
				return
			}
			writeInternal(w, r, "convert.finalize.keyrecord", err)
			return
		}
		if err := h.store.PurgePlaintextContent(id); err != nil {
			writeInternal(w, r, "convert.finalize.purge_plaintext", err)
			return
		}
		// Drop the plaintext server sidecars (.notation/comments.jsonl + audit.log)
		// so no cleartext path/text survives the encrypt. The client has already
		// migrated any comments into the encrypted op-log before calling finalize.
		if err := h.store.PurgeLegacyServerMetadata(id); err != nil {
			writeInternal(w, r, "convert.finalize.purge_legacy", err)
			return
		}
		if err := h.git.Reinit(id, adminAuthor(r), "convert to encrypted: reinitialize history"); err != nil {
			writeInternal(w, r, "convert.finalize.reinit", err)
			return
		}
		m, err = h.store.FinishConvert(id, true)
		if err != nil {
			writeInternal(w, r, "convert.finalize.finish", err)
			return
		}
	case space.ConvertToPlaintext:
		// Guard against finalizing before the client staged anything: if the space
		// still holds ciphertext but no plaintext landed, refuse.
		staged, err := h.store.CountPlaintextFiles(id)
		if err != nil {
			writeInternal(w, r, "convert.finalize.count", err)
			return
		}
		hasEnc, err := h.store.HasEncContent(id)
		if err != nil {
			writeInternal(w, r, "convert.finalize.hasenc", err)
			return
		}
		if staged == 0 && hasEnc {
			writeError(w, http.StatusConflict, "cannot finalize: no decrypted files staged yet")
			return
		}
		if err := h.store.PurgeEncArtifacts(id); err != nil {
			writeInternal(w, r, "convert.finalize.purge_enc", err)
			return
		}
		if err := h.git.Reinit(id, adminAuthor(r), "convert to plaintext: reinitialize history"); err != nil {
			writeInternal(w, r, "convert.finalize.reinit", err)
			return
		}
		m, err = h.store.FinishConvert(id, false)
		if err != nil {
			writeInternal(w, r, "convert.finalize.finish", err)
			return
		}
	default:
		writeError(w, http.StatusConflict, "space is not converting")
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// listFilesFlat returns every plaintext file path in the space as a flat JSON
// array. The encrypt conversion uses it instead of the tree because the tree
// collapses form-folder contents — a flat list guarantees a lossless copy. It
// lives in the requirePlaintext group, so it is reachable on a plaintext space
// and (via the relaxed gate) on a space mid to-encrypted conversion.
func (h *adminHandlers) listFilesFlat(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "spaceID")
	if _, err := h.store.Get(id); err != nil {
		writeSpaceError(w, err)
		return
	}
	paths, err := h.store.ListFilePaths(id)
	if err != nil {
		writeInternal(w, r, "convert.files_flat", err)
		return
	}
	if paths == nil {
		paths = []string{}
	}
	writeJSON(w, http.StatusOK, paths)
}

func writeConvertError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, space.ErrConvertState):
		writeError(w, http.StatusConflict, "invalid conversion state")
	case errors.Is(err, space.ErrInvalidID):
		writeError(w, http.StatusBadRequest, "invalid id")
	case errors.Is(err, space.ErrNotFound):
		writeError(w, http.StatusNotFound, "space not found")
	default:
		writeInternal(w, r, "convert", err)
	}
}
