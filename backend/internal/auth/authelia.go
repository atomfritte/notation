package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/yoogie27/notation/internal/config"
)

type adminCtxKey struct{}

type AdminUser struct {
	Name   string   `json:"name"`
	Groups []string `json:"groups"`
}

// AdminMiddleware enforces the presence of Authelia's ForwardAuth headers
// (configurable via NOTATION_ADMIN_HEADER / NOTATION_ADMIN_GROUPS_HEADER) and,
// if NOTATION_ADMIN_GROUP is set, requires the user to belong to that group.
//
// Authelia must be configured to strip these headers from incoming requests so
// they cannot be forged by a client; this is the standard ForwardAuth setup.
func AdminMiddleware(cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := r.Header.Get(cfg.AdminHeader)
			if user == "" {
				if cfg.DevBypassAuth {
					user = "dev-admin"
				} else {
					http.Error(w, "unauthorized", http.StatusUnauthorized)
					return
				}
			}
			groups := splitGroups(r.Header.Get(cfg.AdminGroupsHeader))
			if cfg.AdminGroup != "" && !contains(groups, cfg.AdminGroup) {
				http.Error(w, "forbidden: admin group required", http.StatusForbidden)
				return
			}
			ctx := context.WithValue(r.Context(), adminCtxKey{}, AdminUser{Name: user, Groups: groups})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func AdminFromContext(ctx context.Context) (AdminUser, bool) {
	u, ok := ctx.Value(adminCtxKey{}).(AdminUser)
	return u, ok
}

func MeHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, _ := AdminFromContext(r.Context())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(u)
	}
}

func splitGroups(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
