package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/yoogie27/notation/internal/authstore"
	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/mcphandler"
	"github.com/yoogie27/notation/internal/mcptoken"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
	"github.com/yoogie27/notation/internal/tts"
	"github.com/yoogie27/notation/web"
)

type Deps struct {
	Cfg           *config.Config
	Log           *slog.Logger
	Store         *space.Store
	Git           *gitrepo.Manager
	Shares        *share.Store
	Audit         *share.AuditLog
	Lim           *share.Limiter
	AdminLim      *share.Limiter
	Comments      *share.CommentStore
	MCPTokens     *mcptoken.Store
	MCP           *mcphandler.Server
	AuthStore     *authstore.Store
	TTS           *tts.Synth
	SessionSecret []byte
}

func NewRouter(d Deps) (http.Handler, error) {
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	// RealIP rewrites RemoteAddr from X-Forwarded-For / X-Real-IP. Only honor
	// those headers when we're actually behind a trusted proxy — otherwise a
	// direct client could spoof its IP to poison the audit log and dodge the
	// per-IP rate limiter. With TrustProxy off, RemoteAddr stays the real
	// socket peer (and share.ClientIP agrees).
	if d.Cfg.TrustProxy {
		r.Use(chimw.RealIP)
	}
	r.Use(requestLogger(d.Log, d.Cfg))
	r.Use(chimw.Recoverer)
	r.Use(securityHeaders)

	// Authelia-bypass: static frontend assets. URL prefix matches Vite's `base`.
	assetsPrefix := d.Cfg.AssetsPath() + "/"
	r.Handle(assetsPrefix+"*", http.StripPrefix(assetsPrefix, web.AssetHandler()))

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// PWA root-scope files (public): service worker, manifest, icons.
	for _, f := range []string{"sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "icon.svg"} {
		r.Get("/"+f, web.RootFile(f))
	}

	// Authelia-bypass: share routes.
	sh := &shareHandlers{
		cfg: d.Cfg, store: d.Store, shares: d.Shares,
		audit: d.Audit, comments: d.Comments, git: d.Git, tts: d.TTS,
	}
	r.Route(d.Cfg.SharePath, func(sr chi.Router) {
		sr.Route("/api", func(api chi.Router) {
			api.Use(d.Lim.Middleware)
			api.Get("/{token}/space", sh.getSpace)
			api.Get("/{token}/tree", sh.getTree)
			api.Get("/{token}/file/*", sh.getFile)
			api.Put("/{token}/file/*", sh.putFile)
			api.Get("/{token}/all-comments", sh.listAllComments)
			api.Get("/{token}/comments/*", sh.listComments)
			api.Post("/{token}/comments/*", sh.postComment)
			api.Get("/{token}/form/*", sh.getForm)
			api.Post("/{token}/form/*", sh.postFormEntry)
			api.Post("/{token}/form-upload/*", sh.postFormImage)
			api.Get("/{token}/tts", sh.getTTS)
			api.Get("/{token}/tts/info", sh.getTTSInfo)
			api.Get("/{token}/search", sh.searchSpace)
		})
		// Serve the PWA root files under the share path too. Without these, a
		// request for e.g. /s/manifest.webmanifest falls through to the
		// {token} route and gets the SPA HTML (Content-Type text/html), which
		// the browser then fails to parse as a manifest ("Syntax error"). chi
		// matches these literal paths before the {token} wildcard.
		for _, f := range []string{"manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "icon.svg"} {
			sr.Get("/"+f, web.RootFile(f))
		}
		sr.Get("/{token}", web.ShareIndex())
		sr.Get("/{token}/*", web.ShareIndex())
	})

	// Authelia-bypass: MCP endpoints, Bearer-auth per space.
	mcpHandler := d.MCP.Handler()
	r.Route(d.Cfg.MCPPath, func(mr chi.Router) {
		mr.Use(d.Lim.Middleware)
		mr.Handle("/{spaceID}", mcpHandler)
		mr.Handle("/{spaceID}/*", mcpHandler)
	})

	// ---------- Auth API (mostly public) ----------
	// /api/auth/* — state machine + bootstrap claim + passkey ceremonies.
	// Login endpoints are public (rate-limited via loginGuard internally).
	// Register + passkey-management require an active session.
	ah := newAuthHandlers(d.Cfg, d.AuthStore, d.SessionSecret)
	wah, err := newWebAuthnHandlers(ah)
	if err != nil {
		return nil, err
	}
	sessionMW := sessionAdminMiddleware(d.SessionSecret)
	if d.Cfg.DevBypassAuth {
		sessionMW = devBypassMiddleware()
	}
	r.Route("/api/auth", func(ar chi.Router) {
		ar.Get("/state", ah.state)
		ar.Post("/claim", ah.claim)
		ar.Post("/passkey/login/begin", wah.loginBegin)
		ar.Post("/passkey/login/finish", wah.loginFinish)
		ar.Group(func(pr chi.Router) {
			pr.Use(sessionMW)
			pr.Post("/logout", ah.logout)
			pr.Group(func(csrfR chi.Router) {
				csrfR.Use(requireCSRF)
				csrfR.Post("/passkey/register/begin", wah.registerBegin)
				csrfR.Post("/passkey/register/finish", wah.registerFinish)
				csrfR.Delete("/passkeys/{id}", wah.deletePasskey)
			})
			pr.Get("/passkeys", wah.listPasskeys)
		})
	})

	// Admin SPA HTML — served public so the React AuthGate can render and
	// route to claim / login screens. The JS bundle is also under
	// /s/_assets/ which is already public. All sensitive data is behind
	// /api/admin/* which IS auth-gated below.
	r.Get("/", web.AdminIndex())
	r.Get("/admin", web.AdminIndex())
	r.Get("/admin/*", web.AdminIndex())

	// ---------- Admin API (auth + CSRF on writes) ----------
	ahdmin := &adminHandlers{
		cfg: d.Cfg, store: d.Store, git: d.Git,
		shares: d.Shares, mcpTokens: d.MCPTokens, comments: d.Comments,
		audit: d.Audit, tts: d.TTS,
	}
	adminMW := adminMiddleware(d.Cfg, d.SessionSecret)
	r.Route("/api/admin", func(ar chi.Router) {
		// Rate-limit BEFORE auth so even unauth'd requests can't fill the
		// limiter cache by hammering /api/admin/*.
		ar.Use(d.AdminLim.Middleware)
		ar.Use(adminMW)
		// CSRF middleware is a no-op for GET/HEAD/OPTIONS, so registering it
		// for the whole subtree is safe and centralises the policy.
		ar.Use(requireCSRF)
		ar.Get("/me", adminMeHandler())
		// Voice list is server config (not space data) → stays top-level. The
		// synth endpoint is space-scoped (below) so each clip is isolated to its
		// space's cache + inherits the space's access check.
		ar.Get("/tts/info", ahdmin.getTTSInfo)
		ar.Get("/spaces", ahdmin.listSpaces)
		ar.Post("/spaces", ahdmin.createSpace)
		// Landing-page Kanban board: batch-update column + ordering across spaces.
		// Top-level (not under /spaces/{spaceID}) since one drag spans many spaces.
		ar.Patch("/board", ahdmin.updateBoard)
		ar.Route("/spaces/{spaceID}", func(sr chi.Router) {
			// Mode-agnostic routes: valid whether the space is plaintext or an
			// encrypted blob store. getSpace exposes the `encrypted` flag.
			sr.Get("/", ahdmin.getSpace)
			sr.Delete("/", ahdmin.deleteSpace)
			sr.Get("/shares", ahdmin.listShares)
			sr.Post("/shares", ahdmin.createShare)
			sr.Delete("/shares/{shareID}", ahdmin.deleteShare)
			sr.Get("/mcp-tokens", ahdmin.listMCPTokens)
			sr.Post("/mcp-tokens", ahdmin.createMCPToken)
			sr.Delete("/mcp-tokens/{tokenID}", ahdmin.deleteMCPToken)

			// Zero-knowledge blob + op-log store. Each handler 409s on a
			// plaintext space (requireEncrypted). The server only ever moves
			// opaque ciphertext bytes here — it never decrypts.
			sr.Route("/enc", func(er chi.Router) {
				er.Put("/blob/{blobId}", ahdmin.putBlob)
				er.Get("/blob/{blobId}", ahdmin.getBlob)
				er.Delete("/blob/{blobId}", ahdmin.deleteBlob)
				er.Post("/ops", ahdmin.postOp)
				er.Get("/ops", ahdmin.getOps)
				// Bound op-log growth: prune the checkpoint-folded prefix and serve
				// the pruned floor so a legitimate prune isn't read as truncation.
				er.Get("/ops/floor", ahdmin.getOpsFloor)
				er.Post("/ops/prune", ahdmin.pruneOps)
				er.Put("/checkpoint", ahdmin.putCheckpoint)
				er.Get("/checkpoint", ahdmin.getCheckpoint)
				// Durable fallback seed folding exactly the pruned prefix.
				er.Get("/checkpoint-base", ahdmin.getCheckpointBase)
				er.Put("/keyrecord", ahdmin.putKeyRecord)
				er.Get("/keyrecord", ahdmin.getKeyRecord)
				// One-time migration of pre-encryption plaintext sidecars: read the
				// orphaned comments, then purge comments.jsonl + audit.log.
				er.Get("/legacy-comments", ahdmin.getLegacyComments)
				er.Post("/purge-legacy-metadata", ahdmin.purgeLegacyMetadata)
				// Convert an existing space between plaintext and encrypted.
				// Mode-agnostic (each handler resolves the space itself), so they
				// sit outside the requireEncrypted / requirePlaintext split — the
				// transient Meta.Converting marker relaxes both gates while a
				// conversion is in flight.
				er.Post("/begin-convert", ahdmin.beginConvert)
				er.Post("/abort-convert", ahdmin.abortConvert)
				er.Post("/finalize-convert", ahdmin.finalizeConvert)
			})

			// Plaintext filesystem routes. requirePlaintext 409s the whole
			// group when the space is encrypted, so a space is never both a
			// filesystem and a blob store. Any content endpoint added later just
			// has to live inside this group to inherit the gate.
			sr.Group(func(pr chi.Router) {
				pr.Use(ahdmin.requirePlaintext)
				pr.Get("/tree", ahdmin.getTree)
				// Flat, form-transparent file list for the encrypt conversion
				// (the tree collapses form folders). Relaxed-gate reachable while
				// mid to-encrypted conversion.
				pr.Get("/files-flat", ahdmin.listFilesFlat)
				pr.Get("/tts", ahdmin.getTTS) // scope = this space → audio isolated per space
				pr.Get("/export", ahdmin.exportSpace)
				pr.Post("/mkdir", ahdmin.mkdir)
				pr.Get("/file/*", ahdmin.getFile)
				pr.Put("/file/*", ahdmin.putFile)
				pr.Delete("/file/*", ahdmin.deleteFile)
				pr.Post("/rename/*", ahdmin.renameFile)
				pr.Get("/log", ahdmin.getLog)
				pr.Get("/diff/{hash}", ahdmin.getDiff)
				pr.Post("/snapshot", ahdmin.snapshot)
				// Space-wide comment listing for the "All comments" sidebar tab.
				// Placed before the path-suffix routes so it matches the bare
				// /comments without the wildcard catching it.
				pr.Get("/all-comments", ahdmin.listAllComments)
				pr.Delete("/comments/by-id/{commentID}", ahdmin.deleteComment)
				pr.Get("/comments/*", ahdmin.listComments)
				pr.Get("/form/*", ahdmin.getForm)
				pr.Post("/form/*", ahdmin.postFormEntry)
				pr.Put("/form/*", ahdmin.putFormEntry)
				pr.Delete("/form/*", ahdmin.deleteFormEntry)
				pr.Post("/form-upload/*", ahdmin.postFormImage)
				pr.Post("/comments/*", ahdmin.postComment)
				pr.Get("/search", ahdmin.search)
				pr.Get("/audit", ahdmin.getAudit)
				pr.Get("/file-history/*", ahdmin.fileHistory)
				pr.Get("/file-at/{hash}/*", ahdmin.fileAt)
				pr.Get("/file-diff/*", ahdmin.fileDiffAcross)
				pr.Post("/restore/*", ahdmin.restoreFile)
			})
		})
	})

	return r, nil
}
