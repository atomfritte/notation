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
// neuralVoiceHosts are the only cross-origin endpoints the app talks to, and
// only to DOWNLOAD the on-device neural read-aloud voice (one-time, then
// cached): the Piper model from HuggingFace (which redirects large files to its
// LFS/Xet CDNs), the ONNX runtime from cdnjs, and the phonemizer WASM from
// jsDelivr. Synthesis runs entirely in the browser — no page text is ever sent
// to these hosts. They are connect-src only, so they cannot frame, script, or
// receive form data. (Self-hosters wanting zero outbound calls can proxy these
// through the backend; left as a follow-up.)
const neuralVoiceHosts = "https://huggingface.co https://*.huggingface.co https://*.hf.co " +
	"https://cdnjs.cloudflare.com https://cdn.jsdelivr.net"

const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self' data:; " +
	"connect-src 'self' " + neuralVoiceHosts + "; " +
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
