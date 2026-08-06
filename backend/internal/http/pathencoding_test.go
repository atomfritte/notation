package http

// Percent-encoding suite for path-addressed routes.
//
// The frontend builds every file URL with encodeURIComponent per segment. That
// leaves ( ) ! * ' literal while Go's own path escaping encodes them, which
// makes net/url set URL.RawPath — and chi then routes on that still-encoded
// string and hands the handler an undecoded chi.URLParam(r, "*"). Result before
// canonicalPath: "Angebot (Mai).pdf" was looked up on disk as
// "Angebot%20(Mai).pdf" and 404'd, while the paren-free "Angebot Mai.pdf"
// worked — a filename's own characters decided whether it was reachable.
//
// These tests drive the REAL router and assert the round trip for the awkward
// names, including one that literally contains percent escapes in its name.

import (
	"net/http"
	"strings"
	"testing"
)

// encodeURIComponent-equivalent escaping, per path segment: exactly what the
// browser puts on the wire, so the test exercises the production encoding
// rather than Go's (which differs — that difference IS the bug).
func encodeURIComponent(s string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var b strings.Builder
	for _, c := range []byte(s) {
		if strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		const hex = "0123456789ABCDEF"
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0xf])
	}
	return b.String()
}

func encodePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = encodeURIComponent(s)
	}
	return strings.Join(segs, "/")
}

// awkwardNames are the filenames that used to be unreachable, plus controls.
var awkwardNames = []struct {
	name string
	path string
}{
	{"space only", "docs/Angebot Mai.pdf"},
	{"parens only", "docs/Angebot(Mai).pdf"},
	{"parens and space", "docs/Angebot (Mai).pdf"},
	{"literal percent escapes in the name", "09_Angebote/A-260189%20(Vorgang%2038297).pdf"},
	{"umlauts, ampersand, plus", "docs/Größe & Preis + Zubehör (2026).pdf"},
	{"exclamation and apostrophe", "docs/Achtung! Kund'in (neu).md"},
	{"hash and question mark", "docs/Frage? #1 (offen).md"},
}

func TestAdminFileRoundTripsAwkwardNames(t *testing.T) {
	e := newIsoEnv(t)

	for _, tc := range awkwardNames {
		t.Run(tc.name, func(t *testing.T) {
			body := "content of " + tc.path
			e.write("alpha", tc.path, body)

			url := "/api/admin/spaces/alpha/file/" + encodePath(tc.path)
			rec := e.admin(http.MethodGet, url, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d %s; want 200", url, rec.Code, rec.Body.String())
			}
			if got := rec.Body.String(); got != body {
				t.Fatalf("GET %s body = %q; want %q", url, got, body)
			}
		})
	}
}

func TestShareFileRoundTripsAwkwardNames(t *testing.T) {
	e := newIsoEnv(t)

	for _, tc := range awkwardNames {
		t.Run(tc.name, func(t *testing.T) {
			body := "shared " + tc.path
			e.write("alpha", tc.path, body)

			url := "/s/api/" + e.alphaShareTok + "/file/" + encodePath(tc.path)
			rec := e.do(http.MethodGet, url, nil, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d %s; want 200", url, rec.Code, rec.Body.String())
			}
			if got := rec.Body.String(); got != body {
				t.Fatalf("GET %s body = %q; want %q", url, got, body)
			}
		})
	}
}

// A scoped share must still be judged on the DECODED path — otherwise an
// encoded prefix could dodge (or falsely trip) the scope check.
func TestScopedShareMatchesDecodedPath(t *testing.T) {
	e := newIsoEnv(t)
	inScope := "notes/Notiz (wichtig).md"
	e.write("alpha", inScope, "in scope")

	rec := e.do(http.MethodGet, "/s/api/"+e.alphaNotesTok+"/file/"+encodePath(inScope), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("in-scope GET = %d %s; want 200", rec.Code, rec.Body.String())
	}

	outOfScope := "secret.md"
	rec = e.do(http.MethodGet, "/s/api/"+e.alphaNotesTok+"/file/"+encodePath(outOfScope), nil, nil)
	if rec.Code == http.StatusOK {
		t.Fatalf("out-of-scope GET leaked: %s", truncate(rec.Body.String()))
	}
	e.mustNotLeak("scoped share, encoded path", rec.Body.String(), alphaSecret)
}

// An encoded separator would change the path's SHAPE once decoded (one segment
// becoming two), so it is refused rather than guessed at. No filename can hold
// one, and refusing keeps traversal-flavoured inputs off the store entirely.
func TestEncodedSeparatorRejected(t *testing.T) {
	e := newIsoEnv(t)

	for _, target := range []string{
		"/api/admin/spaces/alpha/file/notes%2Fnote1.md",
		"/api/admin/spaces/alpha/file/notes%2fnote1.md",
		"/api/admin/spaces/alpha/file/notes%5Cnote1.md",
		"/s/api/" + e.alphaShareTok + "/file/notes%2Fnote1.md",
	} {
		rec := e.do(http.MethodGet, target, nil, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d; want 400", target, rec.Code)
		}
		e.mustNotLeak("encoded separator", rec.Body.String(), alphaSecret)
	}
}

// Writes are path-addressed too — a name that can be read but not saved would
// be just as broken.
func TestAdminPutDeleteAwkwardName(t *testing.T) {
	e := newIsoEnv(t)
	path := "docs/Angebot (Juni) 100%.md"
	url := "/api/admin/spaces/alpha/file/" + encodePath(path)

	rec := e.do(http.MethodPut, url, []byte("hello"), map[string]string{
		"X-CSRF-Token": "dev-csrf-token",
		"Content-Type": "text/markdown",
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT %s = %d %s; want 204", url, rec.Code, rec.Body.String())
	}
	if data, err := e.store.ReadFile("alpha", path); err != nil || string(data) != "hello" {
		t.Fatalf("store after PUT: data=%q err=%v", data, err)
	}

	rec = e.admin(http.MethodGet, url, nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "hello" {
		t.Fatalf("GET after PUT = %d %q", rec.Code, rec.Body.String())
	}

	rec = e.admin(http.MethodDelete, url, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE %s = %d %s; want 204", url, rec.Code, rec.Body.String())
	}
	if _, err := e.store.ReadFile("alpha", path); err == nil {
		t.Fatalf("file still present after DELETE")
	}
}
