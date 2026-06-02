package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/space"
)

var errBadFormBody = errors.New("invalid form body")

// buildFormResponse assembles the schema + stored entries for a form folder.
// canSubmit is permission-derived (always true for admin; comment/edit for a
// share guest) and tells the UI whether to show the submit affordance.
func buildFormResponse(store *space.Store, spaceID, folder string, canSubmit bool) (map[string]any, error) {
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

func writeFormError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, space.ErrNotForm):
		writeError(w, http.StatusNotFound, "not a form folder")
	case errors.Is(err, space.ErrFormRequired),
		errors.Is(err, space.ErrFormInvalid),
		errors.Is(err, errBadFormBody):
		// Validation messages reference field labels (author-controlled), not
		// filesystem internals — safe to return.
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeFileError(w, err)
	}
}
