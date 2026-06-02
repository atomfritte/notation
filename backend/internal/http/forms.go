package http

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/space"
)

var (
	errBadFormBody = errors.New("invalid form body")
	errNotImage    = errors.New("unsupported image type (use JPEG, PNG, GIF or WebP)")
)

// formImageMaxBytes bounds a single form image upload. Images are downscaled in
// the browser before upload, so this is a generous safety ceiling that also
// caps the memory used to sniff + write the upload.
const formImageMaxBytes = 16 << 20

// imageExt maps a sniffed image content type to a file extension.
var imageExt = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/gif":  "gif",
	"image/webp": "webp",
}

// buildFormResponse assembles the schema + stored entries for a form folder.
// canSubmit / canEdit are permission-derived and tell the UI which affordances
// to show (submit; edit+delete — admin only).
func buildFormResponse(store *space.Store, spaceID, folder string, canSubmit, canEdit bool) (map[string]any, error) {
	if !store.IsFormFolder(spaceID, folder) {
		return nil, space.ErrNotForm
	}
	schema, err := store.FormSchema(spaceID, folder)
	if err != nil {
		return nil, err
	}
	entries, err := store.ListFormEntries(spaceID, folder, schema)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"folder":     folder,
		"schema":     schema,
		"entries":    entries,
		"can_submit": canSubmit,
		"can_edit":   canEdit,
	}, nil
}

// submitFormEntry validates a submission against the folder's schema and writes
// a new entry. The schema validation drops any undeclared keys and the filename
// is server-generated inside the folder, so this is safe for share guests.
func submitFormEntry(store *space.Store, cfg *config.Config, spaceID, folder string, w http.ResponseWriter, r *http.Request) (space.FormEntry, error) {
	if !store.IsFormFolder(spaceID, folder) {
		return space.FormEntry{}, space.ErrNotForm
	}
	schema, err := store.FormSchema(spaceID, folder)
	if err != nil {
		return space.FormEntry{}, err
	}
	var body struct {
		Values map[string]any `json:"values"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return space.FormEntry{}, errBadFormBody
	}
	return store.CreateFormEntry(spaceID, folder, schema, body.Values, time.Now(), cfg.MaxUploadBytes)
}

// updateFormEntry re-validates a submission and rewrites the named existing
// entry in place. The entry ID is validated by the store against path tricks.
func updateFormEntry(store *space.Store, cfg *config.Config, spaceID, folder string, w http.ResponseWriter, r *http.Request) (space.FormEntry, error) {
	if !store.IsFormFolder(spaceID, folder) {
		return space.FormEntry{}, space.ErrNotForm
	}
	schema, err := store.FormSchema(spaceID, folder)
	if err != nil {
		return space.FormEntry{}, err
	}
	var body struct {
		ID     string         `json:"id"`
		Values map[string]any `json:"values"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return space.FormEntry{}, errBadFormBody
	}
	return store.UpdateFormEntry(spaceID, folder, body.ID, schema, body.Values, time.Now(), cfg.MaxUploadBytes)
}

// uploadFormImage stores one image attachment for a form folder. The body is the
// raw image bytes; the type is sniffed (only real images accepted) and the file
// is given a server-generated name inside the folder's attachment dir.
func uploadFormImage(store *space.Store, cfg *config.Config, spaceID, folder string, w http.ResponseWriter, r *http.Request) (string, error) {
	if !store.IsFormFolder(spaceID, folder) {
		return "", space.ErrNotForm
	}
	limit := cfg.MaxUploadBytes
	if limit <= 0 || limit > formImageMaxBytes {
		limit = formImageMaxBytes
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		return "", errBadFormBody
	}
	ext, ok := imageExt[http.DetectContentType(data)]
	if !ok {
		return "", errNotImage
	}
	return store.SaveFormImage(spaceID, folder, data, ext, limit)
}

func writeFormError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, space.ErrNotForm):
		writeError(w, http.StatusNotFound, "not a form folder")
	case errors.Is(err, space.ErrFormRequired),
		errors.Is(err, space.ErrFormInvalid),
		errors.Is(err, errBadFormBody),
		errors.Is(err, errNotImage):
		// Validation messages reference field labels (author-controlled), not
		// filesystem internals — safe to return.
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeFileError(w, err)
	}
}
