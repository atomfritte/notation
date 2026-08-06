package http

import (
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/yoogie27/notation/internal/config"
)

// Match base64url-encoded 32-byte share / mcp / bootstrap tokens (43 chars).
// We don't want these in plaintext server logs — anyone with log access could
// replay them. Tighter than a generic catch-all so legitimate long filenames
// don't get redacted.
var tokenRedactRe = regexp.MustCompile(`[A-Za-z0-9_-]{43}`)

func requestLogger(log *slog.Logger, cfg *config.Config) func(http.Handler) http.Handler {
	sharePrefix := cfg.SharePath + "/"
	mcpPrefix := cfg.MCPPath + "/"
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := chimw.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			log.Info("http",
				"method", r.Method,
				"path", redactSensitive(r.URL.Path, sharePrefix, mcpPrefix),
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"duration_ms", time.Since(start).Milliseconds(),
				"req_id", chimw.GetReqID(r.Context()),
			)
		})
	}
}

func redactSensitive(p, sharePrefix, mcpPrefix string) string {
	// Only redact under prefixes that can carry secrets. Keeps legitimate
	// long filenames in admin routes intact.
	if !strings.HasPrefix(p, sharePrefix) && !strings.HasPrefix(p, mcpPrefix) {
		return p
	}
	return tokenRedactRe.ReplaceAllString(p, "<token>")
}

// canonicalPath makes chi route on the DECODED request path.
//
// chi routes on r.URL.RawPath whenever net/url set it — that is, whenever the
// client's percent-encoding differs from Go's own canonical escaping — and then
// hands the handler a still-encoded chi.URLParam(r, "*"). The browser's
// encodeURIComponent leaves ( ) ! * ' unescaped where Go escapes them, so any
// filename holding one of those AND something that must be escaped (a space, a
// literal %) reached the file API encoded: "Angebot (Mai).pdf" was looked up on
// disk as "Angebot%20(Mai).pdf" and 404'd, while "Angebot Mai.pdf" worked. Same
// bug for every other path-addressed route (comments, rename, forms) and for
// the offline sync, which fetches the very same URLs.
//
// Clearing RawPath removes the inconsistency: every request routes on
// r.URL.Path, which net/url has already unescaped exactly once — the path the
// overwhelming majority of requests took anyway.
//
// An encoded separator is the one case where decoding would change the path's
// SHAPE rather than just a name, so it is refused rather than guessed. No
// filename can contain one; a double-encoded %252F (a file literally named
// "a%2Fb") survives, since it decodes to text, not a separator.
func canonicalPath(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawPath != "" {
			if hasEncodedSeparator(r.URL.RawPath) {
				writeError(w, http.StatusBadRequest, "invalid path encoding")
				return
			}
			r.URL.RawPath = ""
		}
		next.ServeHTTP(w, r)
	})
}

// hasEncodedSeparator reports whether raw carries a percent-encoded "/" or "\".
func hasEncodedSeparator(raw string) bool {
	lower := strings.ToLower(raw)
	return strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c")
}

// CSP — keep as one constant so it's easy to tighten/relax in one place.
// `'wasm-unsafe-eval'` lets the highlighter and any future WASM-backed lib
// run without `'unsafe-eval'`. `style-src 'unsafe-inline'` is required by
// Tailwind / Mermaid / many React libs that inject inline styles. If we
// ever drop those, tighten this further.
//
// `frame-ancestors 'self'` (not 'none') lets the SPA embed its own
// same-origin resources — the PDF viewer renders uploads in an <iframe>
// pointing at the file endpoint. Cross-origin framing is still refused, so
// clickjacking protection is intact. `X-Frame-Options: SAMEORIGIN` mirrors
// this for legacy browsers that ignore frame-ancestors.
// Read-aloud now synthesises on the server (same-origin /tts), so the CSP needs
// no third-party hosts — everything the app talks to is 'self'.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"media-src 'self' blob:; " +
	"worker-src 'self' blob:; " +
	"frame-src 'self'; " +
	"frame-ancestors 'self'; " +
	"base-uri 'self'; " +
	"form-action 'self'; " +
	"object-src 'none'"

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		next.ServeHTTP(w, r)
	})
}
