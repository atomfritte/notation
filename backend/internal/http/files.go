package http

import (
	"bytes"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// inlineSafeMimes is the allowlist of Content-Types we are willing to serve
// with Content-Disposition: inline. Everything else gets forced to
// application/octet-stream with attachment disposition so the bytes can't
// execute in our origin when accessed directly.
//
// Notable omissions:
//   - text/html: would render as HTML in admin origin → stored XSS
//   - image/svg+xml: SVG can contain <script>; <img src=foo.svg> still
//     renders fine even with attachment header, so we lose nothing
//   - XLSX / DOCX / etc.: rendered client-side via a sanitised pipeline,
//     never as inline HTML
//
// Video / audio types are allowlisted so <video src=…> / <audio src=…>
// work — browsers route those bytes through their media decoder, not the
// HTML parser, so an attacker can't smuggle script execution through them.
var inlineSafeMimes = map[string]bool{
	// Text / data
	"text/markdown":             true,
	"text/plain":                true,
	"text/css":                  true,
	"text/csv":                  true,
	"text/tab-separated-values": true,
	"application/json":          true,
	// Images
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
	"image/avif": true,
	"image/bmp":  true,
	// PDFs render inline in the built-in browser viewer; the SPA embeds
	// them via a same-origin <iframe> (CSP frame-ancestors 'self' allows
	// our own pages to frame them, while refusing cross-origin framing).
	"application/pdf": true,
	// Audio (browser media decoder)
	"audio/mpeg": true,
	"audio/wav":  true,
	"audio/wave": true,
	"audio/ogg":  true,
	"audio/mp4":  true,
	"audio/aac":  true,
	"audio/flac": true,
	"audio/webm": true,
	"audio/x-m4a": true,
	// Video (browser media decoder)
	"video/mp4":       true,
	"video/webm":      true,
	"video/ogg":       true,
	"video/quicktime": true,
}

func isInlineSafe(mtype string) bool {
	if i := strings.IndexByte(mtype, ';'); i > 0 {
		mtype = mtype[:i]
	}
	return inlineSafeMimes[strings.TrimSpace(strings.ToLower(mtype))]
}

// writeFileResponse writes a file's bytes with safe response headers.
//
// Inline-safe MIME types are delivered through http.ServeContent so the
// browser gets proper Range / If-Modified-Since handling — that's what
// makes <video> seekable and lets <audio> stream. Everything else is sent
// with attachment + octet-stream so direct navigation downloads instead
// of executing.
//
// modTime may be zero for content-addressable responses (e.g. file-at-
// commit) where we don't have a meaningful timestamp; ServeContent then
// just omits the Last-Modified header.
func writeFileResponse(w http.ResponseWriter, r *http.Request, upath string, data []byte, modTime time.Time) {
	mtype := mime.TypeByExtension(filepath.Ext(upath))
	if mtype == "" {
		mtype = http.DetectContentType(data)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	if isInlineSafe(mtype) {
		w.Header().Set("Content-Type", mtype)
		http.ServeContent(w, r, filepath.Base(upath), modTime, bytes.NewReader(data))
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+escapeFilename(filepath.Base(upath))+`"`)
	// Plain Write — attachments don't need range support, the client
	// either downloads the whole thing or our JS fetches it via XHR.
	_, _ = w.Write(data)
}

func escapeFilename(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, s)
}
