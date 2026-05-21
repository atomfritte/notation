package http

import (
	"context"
	"net/http"

	"github.com/yoogie27/notation/internal/auth"
	"github.com/yoogie27/notation/internal/config"
)

// adminMiddleware returns the middleware that protects /api/admin/* requests.
// The exact check depends on cfg.AuthMode:
//
//	session  — the default; require a valid signed session cookie.
//	authelia — legacy; trust the Remote-User header set by Authelia upstream.
//	both     — require *both* (defense in depth).
//
// When cfg.DevBypassAuth is set we bypass with a fake admin so local Vite
// dev against a backend without auth still works. This bypass MUST NOT be
// enabled in production.
func adminMiddleware(cfg *config.Config, sessionSecret []byte) func(http.Handler) http.Handler {
	if cfg.DevBypassAuth {
		return devBypassMiddleware()
	}
	switch cfg.AuthMode {
	case config.AuthModeAuthelia:
		return auth.AdminMiddleware(cfg)
	case config.AuthModeBoth:
		sess := sessionAdminMiddleware(sessionSecret)
		authelia := auth.AdminMiddleware(cfg)
		// Outer = Authelia ForwardAuth, inner = our session. The session
		// inner runs last so it can stash *Session + CSRF on the context.
		return func(next http.Handler) http.Handler { return authelia(sess(next)) }
	default:
		return sessionAdminMiddleware(sessionSecret)
	}
}

// sessionAdminMiddleware validates the session cookie and stashes both a
// *Session (for CSRF) and an auth.AdminUser (for downstream git/audit
// authors) on the request context.
func sessionAdminMiddleware(secret []byte) func(http.Handler) http.Handler {
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
			ctx := contextWithSession(r.Context(), sess)
			ctx = auth.WithAdmin(ctx, auth.AdminUser{Name: sess.User})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func devBypassMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sess := &Session{User: "dev-admin", CSRF: "dev-csrf-token"}
			ctx := contextWithSession(r.Context(), sess)
			ctx = auth.WithAdmin(ctx, auth.AdminUser{Name: "dev-admin"})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// contextWithSession is the package-internal setter for the session-context
// key declared in csrf.go.
func contextWithSession(parent context.Context, sess *Session) context.Context {
	return context.WithValue(parent, sessionCtxKey{}, sess)
}
