package http

import (
	"context"
	"crypto/subtle"
	"net/http"
)

type sessionCtxKey struct{}

// SessionFromContext returns the validated session for the current request,
// or false if the request didn't pass through a session-requiring middleware.
func SessionFromContext(ctx context.Context) (*Session, bool) {
	s, ok := ctx.Value(sessionCtxKey{}).(*Session)
	return s, ok
}

// requireSession validates the session cookie and stashes the parsed Session
// on the request context. Refuses the request on missing / invalid / expired.
func requireSession(secret []byte) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie(SessionCookieName)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "not signed in")
				return
			}
			sess, err := ValidateSession(secret, c.Value)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "invalid session")
				return
			}
			ctx := context.WithValue(r.Context(), sessionCtxKey{}, sess)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// requireCSRF enforces the double-submit pattern: for any state-changing
// request, the X-CSRF-Token header must match the token stored in the
// signed session cookie. GET / HEAD / OPTIONS are exempt (idempotent).
func requireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		sess, ok := SessionFromContext(r.Context())
		if !ok {
			writeError(w, http.StatusUnauthorized, "csrf: no session")
			return
		}
		hdr := r.Header.Get("X-CSRF-Token")
		if hdr == "" || subtle.ConstantTimeCompare([]byte(hdr), []byte(sess.CSRF)) != 1 {
			writeError(w, http.StatusForbidden, "csrf token mismatch")
			return
		}
		next.ServeHTTP(w, r)
	})
}
