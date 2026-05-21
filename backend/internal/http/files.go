package http

import (
	"mime"
	"net/http"
	"path/filepath"
	"strings"
)

// inlineSafeMimes is the allowlist of Content-Types we are willing to serve
// with Content-Disposition: inline. Everything else gets forced to
// application/octet-stream with attachment disposition so uploaded
// HTML/SVG/etc. can't execute in our origin when accessed directly.
//
// Notable omissions:
//   - text/html: would render as HTML in admin origin → stored XSS
//   - image/svg+xml: SVG can contain <script>; <img src=foo.svg> still
//     renders fine even with attachment header, so we lose nothing
var inlineSafeMimes = map[string]bool{
	"text/markdown":             true,
	"text/plain":                true,
	"text/css":                  true,
	"text/csv":                  true,
	"text/tab-separated-values": true,
	"application/json":          true,
	"image/png":                 true,
	"image/jpeg":                true,
	"image/gif":                 true,
	"image/webp":                true,
	"image/avif":                true,
	"image/bmp":                 true,
	"application/pdf":           true,
}

func isInlineSafe(mtype string) bool {
	if i := strings.IndexByte(mtype, ';'); i > 0 {
		mtype = mtype[:i]
	}
	return inlineSafeMimes[strings.TrimSpace(strings.ToLower(mtype))]
}

// writeFileResponse writes a file's bytes with safe response headers.
//   - inline-safe MIME types render normally
//   - everything else gets attachment disposition + octet-stream
//   - X-Content-Type-Options: nosniff prevents MIME-sniffing fallback
func writeFileResponse(w http.ResponseWriter, upath string, data []byte) {
	mtype := mime.TypeByExtension(filepath.Ext(upath))
	if mtype == "" {
		mtype = http.DetectContentType(data)
	}
	if isInlineSafe(mtype) {
		w.Header().Set("Content-Type", mtype)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="`+escapeFilename(filepath.Base(upath))+`"`)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func escapeFilename(s string) string {
	// Strip control characters and quote / backslash so the header parses.
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, s)
}
