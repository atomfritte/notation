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

	// Authelia-bypass: share routes.
	sh := &shareHandlers{
		cfg: d.Cfg, store: d.Store, shares: d.Shares,
		audit: d.Audit, comments: d.Comments, git: d.Git,
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
			api.Get("/{token}/search", sh.searchSpace)
		})
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
		audit: d.Audit,
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
		ar.Get("/spaces", ahdmin.listSpaces)
		ar.Post("/spaces", ahdmin.createSpace)
		ar.Route("/spaces/{spaceID}", func(sr chi.Router) {
			sr.Get("/", ahdmin.getSpace)
			sr.Delete("/", ahdmin.deleteSpace)
			sr.Get("/tree", ahdmin.getTree)
			sr.Get("/export", ahdmin.exportSpace)
			sr.Post("/mkdir", ahdmin.mkdir)
			sr.Get("/file/*", ahdmin.getFile)
			sr.Put("/file/*", ahdmin.putFile)
			sr.Delete("/file/*", ahdmin.deleteFile)
			sr.Post("/rename/*", ahdmin.renameFile)
			sr.Get("/log", ahdmin.getLog)
			sr.Get("/diff/{hash}", ahdmin.getDiff)
			sr.Post("/snapshot", ahdmin.snapshot)
			sr.Get("/shares", ahdmin.listShares)
			sr.Post("/shares", ahdmin.createShare)
			sr.Delete("/shares/{shareID}", ahdmin.deleteShare)
			sr.Get("/mcp-tokens", ahdmin.listMCPTokens)
			sr.Post("/mcp-tokens", ahdmin.createMCPToken)
			sr.Delete("/mcp-tokens/{tokenID}", ahdmin.deleteMCPToken)
			// Space-wide comment listing for the "All comments" sidebar tab.
			// Placed before the path-suffix routes so it matches the bare
			// /comments without the wildcard catching it.
			sr.Get("/all-comments", ahdmin.listAllComments)
			sr.Delete("/comments/by-id/{commentID}", ahdmin.deleteComment)
			sr.Get("/comments/*", ahdmin.listComments)
			sr.Get("/form/*", ahdmin.getForm)
			sr.Post("/form/*", ahdmin.postFormEntry)
			sr.Put("/form/*", ahdmin.putFormEntry)
			sr.Delete("/form/*", ahdmin.deleteFormEntry)
			sr.Post("/form-upload/*", ahdmin.postFormImage)
			sr.Post("/comments/*", ahdmin.postComment)
			sr.Get("/search", ahdmin.search)
			sr.Get("/audit", ahdmin.getAudit)
			sr.Get("/file-history/*", ahdmin.fileHistory)
			sr.Get("/file-at/{hash}/*", ahdmin.fileAt)
			sr.Get("/file-diff/*", ahdmin.fileDiffAcross)
			sr.Post("/restore/*", ahdmin.restoreFile)
		})
	})

	return r, nil
}
