package http

import (
	"log/slog"
	"net/http"

	chimw "github.com/go-chi/chi/v5/middleware"
)

// writeInternal logs the full error to the server log with an action label
// and the request-id, then returns a generic 500 to the client. Internal
// details (git stderr, filesystem paths, library errors) never leak to the
// network. The admin can correlate a UI failure with the matching server
// log entry via the request-id surfaced in the response body.
func writeInternal(w http.ResponseWriter, r *http.Request, action string, err error) {
	rid, _ := r.Context().Value(chimw.RequestIDKey).(string)
	slog.Default().Error("api internal error",
		"action", action,
		"err", err,
		"req_id", rid,
	)
	msg := "internal error"
	if rid != "" {
		msg = msg + " (req " + rid + ")"
	}
	writeError(w, http.StatusInternalServerError, msg)
}
