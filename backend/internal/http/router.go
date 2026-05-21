package http

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/yoogie27/notation/internal/auth"
	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/mcphandler"
	"github.com/yoogie27/notation/internal/mcptoken"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
	"github.com/yoogie27/notation/web"
)

type Deps struct {
	Cfg       *config.Config
	Log       *slog.Logger
	Store     *space.Store
	Git       *gitrepo.Manager
	Shares    *share.Store
	Audit     *share.AuditLog
	Lim       *share.Limiter
	Comments  *share.CommentStore
	MCPTokens *mcptoken.Store
	MCP       *mcphandler.Server
}

func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(requestLogger(d.Log))
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
			api.Get("/{token}/comments/*", sh.listComments)
			api.Post("/{token}/comments/*", sh.postComment)
		})
		sr.Get("/{token}", web.ShareIndex())
		sr.Get("/{token}/*", web.ShareIndex())
	})

	// Authelia-bypass: MCP endpoints, Bearer-auth per space.
	mcpHandler := d.MCP.Handler()
	r.Route(d.Cfg.MCPPath, func(mr chi.Router) {
		mr.Use(d.Lim.Middleware)
		mr.Handle("/{spaceID}", mcpHandler)
	})

	// Admin: protected by Authelia ForwardAuth header.
	ah := &adminHandlers{
		cfg: d.Cfg, store: d.Store, git: d.Git,
		shares: d.Shares, mcpTokens: d.MCPTokens,
	}
	adminMW := auth.AdminMiddleware(d.Cfg)
	r.Group(func(ar chi.Router) {
		ar.Use(adminMW)
		ar.Get("/api/admin/me", auth.MeHandler())
		ar.Get("/api/admin/spaces", ah.listSpaces)
		ar.Post("/api/admin/spaces", ah.createSpace)
		ar.Route("/api/admin/spaces/{spaceID}", func(sr chi.Router) {
			sr.Get("/", ah.getSpace)
			sr.Delete("/", ah.deleteSpace)
			sr.Get("/tree", ah.getTree)
			sr.Post("/mkdir", ah.mkdir)
			sr.Get("/file/*", ah.getFile)
			sr.Put("/file/*", ah.putFile)
			sr.Delete("/file/*", ah.deleteFile)
			sr.Post("/rename/*", ah.renameFile)
			sr.Get("/log", ah.getLog)
			sr.Get("/diff/{hash}", ah.getDiff)
			sr.Post("/snapshot", ah.snapshot)
			sr.Get("/shares", ah.listShares)
			sr.Post("/shares", ah.createShare)
			sr.Delete("/shares/{shareID}", ah.deleteShare)
			sr.Get("/mcp-tokens", ah.listMCPTokens)
			sr.Post("/mcp-tokens", ah.createMCPToken)
			sr.Delete("/mcp-tokens/{tokenID}", ah.deleteMCPToken)
		})
		ar.Get("/", web.AdminIndex())
		ar.Get("/admin", web.AdminIndex())
		ar.Get("/admin/*", web.AdminIndex())
	})

	return r
}

func notImplemented(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not implemented: "+name, http.StatusNotImplemented)
	}
}
