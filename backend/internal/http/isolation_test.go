package http

// Cross-space ISOLATION suite. The single invariant under test: content or
// metadata belonging to one Space can never be reached by an actor that is
// authorized only for a different Space (or not authorized at all). Every test
// here drives the REAL router built by NewRouter with httptest, exactly as
// production wires it — no handler is called in isolation.
//
// Two spaces are provisioned with deliberately distinct secret markers:
//
//	alpha/files/secret.md           -> "ALPHA_SECRET"
//	beta/files/secret.md            -> "BETA_SECRET"
//
// The hard assertion, repeated across every access vector, is that an
// alpha-authorized response body NEVER contains "BETA_SECRET" (and vice-versa),
// and that a metadata read never returns another space's — or alpha's own
// .notation/* — secrets.

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yoogie27/notation/internal/authstore"
	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/mcphandler"
	"github.com/yoogie27/notation/internal/mcptoken"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
	"github.com/yoogie27/notation/internal/tts"
)

const (
	alphaSecret = "ALPHA_SECRET"
	betaSecret  = "BETA_SECRET"
)

// isoEnv is a fully wired notation server backed by a temp DataDir, with two
// spaces and a set of tokens minted for isolation testing.
type isoEnv struct {
	t       *testing.T
	handler http.Handler
	cfg     *config.Config
	store   *space.Store
	git     *gitrepo.Manager
	shares  *share.Store
	mcp     *mcptoken.Store
	dataDir string

	// alpha tokens
	alphaShareTok string // read, whole-space
	alphaEditTok  string // edit, whole-space
	alphaNotesTok string // comment, scoped to "notes"
	alphaMCPTok   string // MCP bearer for alpha

	// beta tokens
	betaShareTok string // read, whole-space
}

func newIsoEnv(t *testing.T) *isoEnv {
	t.Helper()
	dataDir := t.TempDir()
	spacesDir := filepath.Join(dataDir, "spaces")
	if err := os.MkdirAll(spacesDir, 0o750); err != nil {
		t.Fatalf("mkdir spaces: %v", err)
	}

	cfg := &config.Config{
		Bind:            ":0",
		DataDir:         dataDir,
		SharePath:       "/s",
		MCPPath:         "/mcp",
		BaseURL:         "http://localhost",
		DevBypassAuth:   true, // admin routes: no cookie needed, CSRF = "dev-csrf-token"
		MaxUploadBytes:  8 << 20,
		AuthMode:        config.AuthModeSession,
		RPID:            "localhost",
		SessionLifetime: time.Hour,
		// Point TTS at paths that don't exist so the synth reports unavailable
		// (piper is not present in CI). The suite must not depend on it.
		TTSPiperBin: filepath.Join(dataDir, "no-piper"),
		TTSModelDir: filepath.Join(dataDir, "no-models"),
		TTSOpusEnc:  "no-opusenc",
		TTSBitrate:  32,
		TTSCacheMB:  8,
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	store := space.NewStore(spacesDir)
	// A 24h debounce guarantees no background auto-commit fires during the test;
	// nothing here performs a *successful* HTTP write, so no commit is ever queued.
	gitMgr := gitrepo.NewManager(store, 24*time.Hour, logger)
	t.Cleanup(gitMgr.FlushAll)
	shareStore := share.NewStore(spacesDir)
	auditLog := share.NewAuditLog(spacesDir)
	commentStore := share.NewCommentStore(spacesDir)
	mcpStore := mcptoken.NewStore(spacesDir)
	mcpSrv := mcphandler.New(cfg, store, gitMgr, mcpStore, auditLog)
	synth := tts.New(tts.Config{
		PiperBin: cfg.TTSPiperBin,
		ModelDir: cfg.TTSModelDir,
		OpusEnc:  cfg.TTSOpusEnc,
		Bitrate:  cfg.TTSBitrate,
		CacheDir: cfg.TTSCacheDir(),
	})
	// Generous limiters: the suite fires many requests from one client IP and
	// must not trip the per-IP token bucket (that would mask real failures).
	lim := share.NewLimiter(1e6, 1e6, false)

	handler, err := NewRouter(Deps{
		Cfg:           cfg,
		Log:           logger,
		Store:         store,
		Git:           gitMgr,
		Shares:        shareStore,
		Audit:         auditLog,
		Lim:           lim,
		AdminLim:      lim,
		Comments:      commentStore,
		MCPTokens:     mcpStore,
		MCP:           mcpSrv,
		AuthStore:     authstore.New(dataDir),
		TTS:           synth,
		SessionSecret: bytes.Repeat([]byte("k"), 32),
	})
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}

	e := &isoEnv{
		t: t, handler: handler, cfg: cfg, store: store, git: gitMgr,
		shares: shareStore, mcp: mcpStore, dataDir: dataDir,
	}

	// ---- provision spaces + distinct content ----
	e.mkSpace("alpha")
	e.write("alpha", "secret.md", "# top\n"+alphaSecret+" lives here\n")
	e.write("alpha", "notes/note1.md", "alpha note one, has the word SECRET in it\n")
	e.write("alpha", "notes/deep/inner.md", "alpha deep "+alphaSecret+" nested\n")
	e.write("alpha", "survey/_form.md", "# Survey\n\nName ____ [string] (required)\nMood [smiley]\n")

	e.mkSpace("beta")
	e.write("beta", "secret.md", "# top\n"+betaSecret+" lives here\n")
	e.write("beta", "private/b.md", "beta private "+betaSecret+" here, SECRET\n")

	// ---- tokens ----
	e.alphaShareTok = e.mkShare("alpha", share.PermissionRead, "")
	e.alphaEditTok = e.mkShare("alpha", share.PermissionEdit, "")
	e.alphaNotesTok = e.mkShare("alpha", share.PermissionComment, "notes")
	e.betaShareTok = e.mkShare("beta", share.PermissionRead, "")
	e.alphaMCPTok = e.mkMCP("alpha")
	// beta's MCP token exists so beta is a real MCP-enabled space, but the
	// isolation checks drive alpha's token against beta, so we don't retain it.
	_ = e.mkMCP("beta")

	return e
}

func (e *isoEnv) mkSpace(id string) {
	e.t.Helper()
	if _, err := e.store.Create(id, id, "admin"); err != nil {
		e.t.Fatalf("create space %s: %v", id, err)
	}
}

func (e *isoEnv) write(spaceID, path, content string) {
	e.t.Helper()
	if _, err := e.store.WriteFile(spaceID, path, strings.NewReader(content), e.cfg.MaxUploadBytes); err != nil {
		e.t.Fatalf("write %s/%s: %v", spaceID, path, err)
	}
}

func (e *isoEnv) mkShare(spaceID string, perm share.Permission, scope string) string {
	e.t.Helper()
	res, err := e.shares.Create(spaceID, perm, scope, "test", nil, "admin", share.DefaultFeatures())
	if err != nil {
		e.t.Fatalf("create share %s scope=%q: %v", spaceID, scope, err)
	}
	return res.Token
}

func (e *isoEnv) mkMCP(spaceID string) string {
	e.t.Helper()
	res, err := e.mcp.Create(spaceID, "test", "admin")
	if err != nil {
		e.t.Fatalf("create mcp token %s: %v", spaceID, err)
	}
	return res.Raw
}

// do issues a request against the wired router and returns the recorder.
func (e *isoEnv) do(method, target string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	e.t.Helper()
	var r *http.Request
	var err error
	if body != nil {
		r, err = http.NewRequest(method, target, bytes.NewReader(body))
	} else {
		r, err = http.NewRequest(method, target, nil)
	}
	if err != nil {
		e.t.Fatalf("build request %s %s: %v", method, target, err)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, r)
	return rec
}

// admin issues an authenticated admin request (dev bypass supplies the session;
// writes carry the dev CSRF token).
func (e *isoEnv) admin(method, target string, body []byte) *httptest.ResponseRecorder {
	h := map[string]string{}
	if method != http.MethodGet && method != http.MethodHead {
		h["X-CSRF-Token"] = "dev-csrf-token"
		h["Content-Type"] = "application/json"
	}
	return e.do(method, target, body, h)
}

// mcpCall drives one JSON-RPC tools/call and returns (httpStatus, rawBody).
func (e *isoEnv) mcpCall(spaceID, bearer, tool string, args map[string]any) (int, string) {
	e.t.Helper()
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params":  map[string]any{"name": tool, "arguments": args},
	}
	b, _ := json.Marshal(payload)
	h := map[string]string{"Content-Type": "application/json"}
	if bearer != "" {
		h["Authorization"] = "Bearer " + bearer
	}
	rec := e.do(http.MethodPost, e.cfg.MCPPath+"/"+spaceID, b, h)
	return rec.Code, rec.Body.String()
}

// mustNotLeak fails when body contains a foreign space's secret marker.
func (e *isoEnv) mustNotLeak(where, body, foreignSecret string) {
	e.t.Helper()
	if strings.Contains(body, foreignSecret) {
		e.t.Errorf("[%s] ISOLATION LEAK: response contained %q\nbody: %s", where, foreignSecret, truncate(body))
	}
}

func truncate(s string) string {
	if len(s) > 400 {
		return s[:400] + "...(truncated)"
	}
	return s
}

// The nasty cross-space path set. Every one names beta from an alpha-scoped
// actor; none may ever yield beta content.
var crossSpaceTraversals = []string{
	"../beta/secret.md",
	"../../beta/secret.md",
	"..%2Fbeta%2Fsecret.md",
	"%2e%2e/beta/secret.md",
	"..%5cbeta%5csecret.md",
	`..\beta\secret.md`,
	"/beta/secret.md",
	"....//beta/secret.md",
	"../../spaces/beta/files/secret.md",
	"notes/../../beta/secret.md",
	"../beta/files/secret.md",
	"..%2f..%2fbeta%2ffiles%2fsecret.md",
}

// ---------------------------------------------------------------------------
// 1. SHARE TOKEN ISOLATION
// ---------------------------------------------------------------------------

func TestIsolation_ShareToken_CannotReachOtherSpace(t *testing.T) {
	e := newIsoEnv(t)

	// Positive control: alpha's own read token reads alpha content.
	rec := e.do(http.MethodGet, "/s/api/"+e.alphaShareTok+"/file/secret.md", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), alphaSecret) {
		t.Fatalf("positive control failed: alpha token cannot read alpha/secret.md (code=%d body=%s)", rec.Code, truncate(rec.Body.String()))
	}

	// The token maps to alpha; it cannot even NAME beta. Every traversal is
	// denied and never returns BETA_SECRET.
	for _, p := range crossSpaceTraversals {
		rec := e.do(http.MethodGet, "/s/api/"+e.alphaShareTok+"/file/"+p, nil, nil)
		e.mustNotLeak("share.getFile "+p, rec.Body.String(), betaSecret)
		if rec.Code == http.StatusOK {
			t.Errorf("share getFile %q unexpectedly returned 200 (should be denied)", p)
		}
	}

	// Symmetric: beta's token must never reach ALPHA_SECRET.
	for _, p := range []string{"../alpha/secret.md", "/alpha/secret.md", `..\alpha\secret.md`, "../../spaces/alpha/files/secret.md"} {
		rec := e.do(http.MethodGet, "/s/api/"+e.betaShareTok+"/file/"+p, nil, nil)
		e.mustNotLeak("share.getFile(beta) "+p, rec.Body.String(), alphaSecret)
	}

	// A share tree only ever exposes its own space.
	rec = e.do(http.MethodGet, "/s/api/"+e.alphaShareTok+"/tree", nil, nil)
	e.mustNotLeak("share.tree", rec.Body.String(), betaSecret)
	if strings.Contains(rec.Body.String(), "private") {
		t.Errorf("alpha share tree leaked a beta path (\"private\")")
	}

	// Edit token: a write can never land in beta via a traversal path.
	for _, p := range []string{"../beta/pwned.md", "/beta/pwned.md", "notes/../../beta/pwned.md"} {
		rec := e.do(http.MethodPut, "/s/api/"+e.alphaEditTok+"/file/"+p, []byte("PWNED"), map[string]string{"Content-Type": "text/markdown"})
		if rec.Code == http.StatusNoContent || rec.Code == http.StatusOK {
			t.Errorf("share putFile traversal %q unexpectedly succeeded (code=%d)", p, rec.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(e.dataDir, "spaces", "beta", "files", "pwned.md")); err == nil {
		t.Errorf("ISOLATION LEAK: alpha edit token created a file inside beta")
	}
}

// ---------------------------------------------------------------------------
// 2. SCOPED SHARE
// ---------------------------------------------------------------------------

func TestIsolation_ScopedShare_StaysInScope(t *testing.T) {
	e := newIsoEnv(t)
	tok := e.alphaNotesTok // scope = "notes", permission = comment

	// In scope -> 200.
	rec := e.do(http.MethodGet, "/s/api/"+tok+"/file/notes/note1.md", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("scoped share cannot read in-scope file (code=%d)", rec.Code)
	}

	// Out of scope within the SAME space (alpha/secret.md) -> 403, and never
	// leaks the file body.
	rec = e.do(http.MethodGet, "/s/api/"+tok+"/file/secret.md", nil, nil)
	if rec.Code != http.StatusForbidden {
		t.Errorf("out-of-scope read should be 403, got %d", rec.Code)
	}
	e.mustNotLeak("scoped.getFile secret.md", rec.Body.String(), alphaSecret)

	// The survey form folder is outside the "notes" scope -> 403.
	rec = e.do(http.MethodGet, "/s/api/"+tok+"/form/survey", nil, nil)
	if rec.Code != http.StatusForbidden {
		t.Errorf("out-of-scope form should be 403, got %d", rec.Code)
	}

	// Tree is pruned to the scope: only notes/* is visible, secret.md/survey are not.
	rec = e.do(http.MethodGet, "/s/api/"+tok+"/tree", nil, nil)
	body := rec.Body.String()
	if strings.Contains(body, "secret.md") || strings.Contains(body, "survey") {
		t.Errorf("scoped tree leaked out-of-scope entries: %s", truncate(body))
	}
	if !strings.Contains(body, "note1.md") {
		t.Errorf("scoped tree missing in-scope entry note1.md: %s", truncate(body))
	}

	// Search is confined to the scope: the "notes" hit shows, the top-level
	// secret.md hit and anything from beta never do.
	rec = e.do(http.MethodGet, "/s/api/"+tok+"/search?q=SECRET", nil, nil)
	body = rec.Body.String()
	e.mustNotLeak("scoped.search", body, betaSecret)
	if strings.Contains(body, "\"secret.md\"") {
		t.Errorf("scoped search returned an out-of-scope path (secret.md): %s", truncate(body))
	}
	if !strings.Contains(body, "note1.md") {
		t.Errorf("scoped search missed the in-scope hit note1.md: %s", truncate(body))
	}

	// Cross-space is doubly impossible from a scoped token.
	for _, p := range crossSpaceTraversals {
		rec := e.do(http.MethodGet, "/s/api/"+tok+"/file/"+p, nil, nil)
		e.mustNotLeak("scoped.getFile "+p, rec.Body.String(), betaSecret)
		if rec.Code == http.StatusOK {
			t.Errorf("scoped getFile %q unexpectedly returned 200", p)
		}
	}
}

// ---------------------------------------------------------------------------
// 3. MCP TOKEN <-> SPACE BINDING
// ---------------------------------------------------------------------------

func TestIsolation_MCPToken_BoundToItsSpace(t *testing.T) {
	e := newIsoEnv(t)

	// Positive control: alpha's MCP token reads alpha content.
	code, body := e.mcpCall("alpha", e.alphaMCPTok, "read_file", map[string]any{"path": "secret.md"})
	if code != http.StatusOK || !strings.Contains(body, alphaSecret) {
		t.Fatalf("positive control: alpha MCP token cannot read alpha/secret.md (code=%d body=%s)", code, truncate(body))
	}

	// alpha's token used against /mcp/beta must be rejected outright (401) and
	// must never operate on beta.
	code, body = e.mcpCall("beta", e.alphaMCPTok, "read_file", map[string]any{"path": "secret.md"})
	if code != http.StatusUnauthorized {
		t.Errorf("alpha token at /mcp/beta should be 401, got %d", code)
	}
	e.mustNotLeak("mcp cross-token read_file", body, betaSecret)

	// Same for every read-ish tool: cross-token is 401, no beta bytes.
	for _, tc := range []struct {
		tool string
		args map[string]any
	}{
		{"read_file", map[string]any{"path": "secret.md"}},
		{"search", map[string]any{"query": "SECRET"}},
		{"grep", map[string]any{"pattern": "SECRET"}},
		{"glob", map[string]any{"pattern": "**/*.md"}},
		{"list_files", map[string]any{}},
		{"get_tree", map[string]any{}},
	} {
		code, body := e.mcpCall("beta", e.alphaMCPTok, tc.tool, tc.args)
		if code != http.StatusUnauthorized {
			t.Errorf("cross-token %s at /mcp/beta should be 401, got %d", tc.tool, code)
		}
		e.mustNotLeak("mcp cross-token "+tc.tool, body, betaSecret)
	}

	// An unauthenticated MCP call is rejected.
	code, _ = e.mcpCall("beta", "", "read_file", map[string]any{"path": "secret.md"})
	if code != http.StatusUnauthorized {
		t.Errorf("unauthenticated MCP call should be 401, got %d", code)
	}

	// alpha's own token cannot escape alpha's files/ via traversal through any
	// path-taking tool. Result may be an error or empty, but never BETA_SECRET.
	traversalArgs := []struct {
		tool string
		args map[string]any
	}{
		{"read_file", map[string]any{"path": "../beta/secret.md"}},
		{"read_file", map[string]any{"path": "/beta/secret.md"}},
		{"read_file", map[string]any{"path": "notes/../../beta/secret.md"}},
		{"read_file", map[string]any{"path": "secret\x00.md"}},
		{"read_file", map[string]any{"path": `..\beta\secret.md`}},
		{"outline", map[string]any{"path": "../beta/secret.md"}},
	}
	for _, tc := range traversalArgs {
		code, body := e.mcpCall("alpha", e.alphaMCPTok, tc.tool, tc.args)
		if code != http.StatusOK {
			t.Errorf("mcp %s traversal expected transport 200 (RPC-level error), got %d", tc.tool, code)
		}
		e.mustNotLeak("mcp alpha traversal "+tc.tool, body, betaSecret)
	}

	// alpha's search/grep/glob/list/tree only ever see alpha; never beta paths
	// or the beta secret.
	for _, tc := range []struct {
		tool string
		args map[string]any
	}{
		{"search", map[string]any{"query": "SECRET"}},
		{"grep", map[string]any{"pattern": "SECRET"}},
		{"glob", map[string]any{"pattern": "**/*.md"}},
		{"list_files", map[string]any{}},
		{"get_tree", map[string]any{}},
	} {
		code, body := e.mcpCall("alpha", e.alphaMCPTok, tc.tool, tc.args)
		if code != http.StatusOK {
			t.Errorf("mcp alpha %s expected 200, got %d", tc.tool, code)
		}
		e.mustNotLeak("mcp alpha "+tc.tool, body, betaSecret)
		if strings.Contains(body, "private/b.md") {
			t.Errorf("mcp alpha %s leaked a beta path: %s", tc.tool, truncate(body))
		}
	}
}

// ---------------------------------------------------------------------------
// 4. ADMIN PATH TRAVERSAL
// ---------------------------------------------------------------------------

func TestIsolation_AdminPathTraversal(t *testing.T) {
	e := newIsoEnv(t)

	// Positive control: admin can read alpha's own file.
	rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/file/secret.md", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), alphaSecret) {
		t.Fatalf("positive control: admin cannot read alpha/secret.md (code=%d)", rec.Code)
	}

	// GET file traversal into beta -> denied, no beta bytes.
	for _, p := range crossSpaceTraversals {
		rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/file/"+p, nil)
		e.mustNotLeak("admin.getFile "+p, rec.Body.String(), betaSecret)
		if rec.Code == http.StatusOK {
			t.Errorf("admin getFile %q unexpectedly returned 200", p)
		}
	}

	// .notation metadata is off-limits even from the space's own admin path
	// (dotfiles blocked by SafeJoin) — never surface share hashes / mcp hashes.
	for _, p := range []string{
		".notation/shares.json",
		"../.notation/shares.json",
		".notation/mcp-tokens.json",
		"..%2f.notation%2fshares.json",
		".notation/audit.log",
		".notation/meta.json",
	} {
		rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/file/"+p, nil)
		if rec.Code == http.StatusOK {
			t.Errorf("admin getFile dotfile %q unexpectedly returned 200: %s", p, truncate(rec.Body.String()))
		}
		if strings.Contains(rec.Body.String(), "\"hash\"") {
			t.Errorf("admin getFile %q leaked a token hash from .notation: %s", p, truncate(rec.Body.String()))
		}
	}

	// rename destination traversal must not move a file into beta.
	for _, dst := range []string{"../beta/pwned.md", "/beta/pwned.md", "../../spaces/beta/files/pwned.md"} {
		body, _ := json.Marshal(map[string]string{"to": dst})
		rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/rename/notes/note1.md", body)
		if rec.Code == http.StatusNoContent {
			t.Errorf("admin rename to %q unexpectedly succeeded", dst)
		}
	}

	// mkdir traversal must not create a directory inside beta.
	for _, p := range []string{"../beta/injected", "/beta/injected", "../../spaces/beta/files/injected"} {
		body, _ := json.Marshal(map[string]string{"path": p})
		rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/mkdir", body)
		if rec.Code == http.StatusNoContent {
			t.Errorf("admin mkdir %q unexpectedly succeeded", p)
		}
	}

	// form-path traversal.
	for _, p := range crossSpaceTraversals {
		rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/form/"+p, nil)
		e.mustNotLeak("admin.getForm "+p, rec.Body.String(), betaSecret)
	}

	// restore: writing a historical blob to a traversal path must not touch beta.
	for _, p := range []string{"../beta/secret.md", "/beta/secret.md"} {
		body, _ := json.Marshal(map[string]string{"hash": "0000000"})
		rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/restore/"+p, body)
		if rec.Code == http.StatusNoContent {
			t.Errorf("admin restore to %q unexpectedly succeeded", p)
		}
	}

	// file-at (historical read) traversal.
	for _, p := range crossSpaceTraversals {
		rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/file-at/0000000/"+p, nil)
		e.mustNotLeak("admin.fileAt "+p, rec.Body.String(), betaSecret)
	}

	// Confirm none of the above actually wrote anything into beta.
	for _, name := range []string{"pwned.md", "injected", "secret.md.bak"} {
		if _, err := os.Stat(filepath.Join(e.dataDir, "spaces", "beta", "files", name)); err == nil {
			t.Errorf("ISOLATION LEAK: admin traversal created %q inside beta", name)
		}
	}
	// beta/secret.md must still hold BETA_SECRET (not overwritten via restore).
	got, _ := os.ReadFile(filepath.Join(e.dataDir, "spaces", "beta", "files", "secret.md"))
	if !strings.Contains(string(got), betaSecret) {
		t.Errorf("ISOLATION LEAK: beta/secret.md was modified by an alpha-scoped admin op")
	}

	// A bogus space id never resolves to another space's data.
	rec = e.admin(http.MethodGet, "/api/admin/spaces/..%2fbeta/file/secret.md", nil)
	e.mustNotLeak("admin.spaceID traversal", rec.Body.String(), betaSecret)
}

// ---------------------------------------------------------------------------
// 5. TTS CACHE SCOPING
// ---------------------------------------------------------------------------

func TestIsolation_TTSCacheScopedPerSpace(t *testing.T) {
	e := newIsoEnv(t)

	// The synth binary (piper) is absent in CI, so /tts synthesis is
	// unavailable and returns 503. The security-relevant property we CAN assert
	// without piper: the space is resolved+validated BEFORE any cache work, so
	// the cache scope key is bound to a real, canonical space id (see
	// tts.go serveTTS + cacheKey, which hashes `scope=<spaceID>` into every
	// entry — clips for one space can never key-collide with another's).

	// A real space: TTS is reachable (not a 404), just unavailable (503) here.
	rec := e.admin(http.MethodGet, "/api/admin/spaces/alpha/tts?text=hello&voice=x", nil)
	if rec.Code == http.StatusNotFound {
		t.Errorf("existing space TTS should not 404 (space is validated first), got 404")
	}
	if rec.Code == http.StatusOK {
		t.Skip("TTS synth is available in this environment; scope-key assertions require the binary-absent path")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Logf("note: alpha TTS returned %d (expected 503 unavailable)", rec.Code)
	}

	// A non-existent space is rejected before TTS ever runs — proving the cache
	// scope can only ever be a validated space id, never an attacker string.
	rec = e.admin(http.MethodGet, "/api/admin/spaces/ghostspace/tts?text=hello", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("TTS for a non-existent space should 404 (validated before cache), got %d", rec.Code)
	}

	// A traversal space id likewise never resolves.
	rec = e.admin(http.MethodGet, "/api/admin/spaces/..%2fbeta/tts?text=hello", nil)
	if rec.Code == http.StatusOK {
		t.Errorf("TTS with a traversal space id unexpectedly returned 200")
	}
}

// ---------------------------------------------------------------------------
// 6. COMMENTS
// ---------------------------------------------------------------------------

func TestIsolation_Comments(t *testing.T) {
	e := newIsoEnv(t)

	// Post a comment in alpha (on a file that exists).
	body, _ := json.Marshal(map[string]string{"text": "alpha-only-comment-MARKER"})
	rec := e.admin(http.MethodPost, "/api/admin/spaces/alpha/comments/notes/note1.md", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("posting alpha comment failed: code=%d body=%s", rec.Code, truncate(rec.Body.String()))
	}
	// A second alpha comment on the top-level secret.md (out of the notes scope).
	body2, _ := json.Marshal(map[string]string{"text": "alpha-secret-page-comment-OTHER"})
	rec = e.admin(http.MethodPost, "/api/admin/spaces/alpha/comments/secret.md", body2)
	if rec.Code != http.StatusCreated {
		t.Fatalf("posting alpha secret.md comment failed: %d", rec.Code)
	}

	// beta's all-comments must not contain alpha's comment.
	rec = e.admin(http.MethodGet, "/api/admin/spaces/beta/all-comments", nil)
	if strings.Contains(rec.Body.String(), "MARKER") || strings.Contains(rec.Body.String(), "OTHER") {
		t.Errorf("ISOLATION LEAK: beta all-comments contained an alpha comment: %s", truncate(rec.Body.String()))
	}

	// The scoped-to-notes share's all-comments only shows the in-scope comment.
	rec = e.do(http.MethodGet, "/s/api/"+e.alphaNotesTok+"/all-comments", nil, nil)
	scoped := rec.Body.String()
	if !strings.Contains(scoped, "MARKER") {
		t.Errorf("scoped all-comments should include the in-scope notes comment: %s", truncate(scoped))
	}
	if strings.Contains(scoped, "OTHER") {
		t.Errorf("scoped all-comments leaked an out-of-scope comment (secret.md): %s", truncate(scoped))
	}

	// A comment cannot be posted across spaces via a traversal path field: the
	// share token is bound to alpha, and the path is scope+SafeJoin checked.
	for _, p := range crossSpaceTraversals {
		cb, _ := json.Marshal(map[string]string{"text": "x"})
		rec := e.do(http.MethodPost, "/s/api/"+e.alphaEditTok+"/comments/"+p, cb, map[string]string{"Content-Type": "application/json"})
		if rec.Code == http.StatusCreated {
			t.Errorf("share comment on traversal path %q unexpectedly created", p)
		}
	}
	// beta must have zero comments on its private page after all of the above.
	rec = e.admin(http.MethodGet, "/api/admin/spaces/beta/all-comments", nil)
	if strings.Contains(rec.Body.String(), "MARKER") {
		t.Errorf("ISOLATION LEAK: an alpha comment ended up in beta")
	}
}
