package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// RootFile serves a file from the dist root (the PWA service worker, manifest,
// and icons live there, outside _assets, so they're reachable at root scope).
func RootFile(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := fs.ReadFile(dist, "dist/"+name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Type", rootContentType(name))
		switch name {
		case "sw.js":
			// Revalidate so worker updates roll out; allow it to control root scope.
			h.Set("Cache-Control", "no-cache")
			h.Set("Service-Worker-Allowed", "/")
		case "manifest.webmanifest":
			h.Set("Cache-Control", "public, max-age=3600")
		default:
			h.Set("Cache-Control", "public, max-age=86400")
		}
		_, _ = w.Write(data)
	}
}

func rootContentType(name string) string {
	switch {
	case strings.HasSuffix(name, ".js"):
		return "application/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".webmanifest"):
		return "application/manifest+json"
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	default:
		return "application/octet-stream"
	}
}

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
