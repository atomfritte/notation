package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// AssetHandler serves the contents of dist/_assets/* — these are the hashed,
// long-lived JS/CSS/font bundles produced by Vite. URL prefix is the Authelia
// bypass path (configured via NOTATION_SHARE_PATH + "/_assets").
func AssetHandler() http.Handler {
	sub, err := fs.Sub(dist, "dist/_assets")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "frontend not built", http.StatusServiceUnavailable)
		})
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hashed asset URLs are content-addressed — safe to cache aggressively.
		if !strings.HasSuffix(r.URL.Path, ".html") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func AdminIndex() http.HandlerFunc {
	return serveIndex("dist/index.admin.html")
}

func ShareIndex() http.HandlerFunc {
	return serveIndex("dist/index.share.html")
}

func serveIndex(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := fs.ReadFile(dist, path)
		if err != nil {
			http.Error(w, "frontend not built (run npm run build in frontend/)", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(data)
	}
}
