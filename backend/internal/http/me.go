package http

import (
	"encoding/json"
	"net/http"

	"github.com/yoogie27/notation/internal/auth"
)

// adminMeHandler returns the current admin user. The session middleware
// populates auth.AdminFromContext during the request, so this is just a
// JSON dump of that. Frontend's old me() probe still works post-refactor.
func adminMeHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, _ := auth.AdminFromContext(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(u)
	}
}
