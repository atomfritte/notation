package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yoogie27/notation/internal/authstore"
	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	httpserver "github.com/yoogie27/notation/internal/http"
	"github.com/yoogie27/notation/internal/mcphandler"
	"github.com/yoogie27/notation/internal/mcptoken"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(cfg.SpacesDir(), 0o750); err != nil {
		logger.Error("data dir init failed", "err", err)
		os.Exit(1)
	}

	// Auth bootstrap: load (or create) admin.json + server-secret. If the
	// admin hasn't claimed yet, LoadOrInit rotates the bootstrap token on
	// each restart so the most recent container log always shows the valid
	// one.
	authStore := authstore.New(cfg.DataDir)
	secret, err := authStore.LoadOrGenerateSecret()
	if err != nil {
		logger.Error("server-secret init failed", "err", err)
		os.Exit(1)
	}
	_, freshToken, err := authStore.LoadOrInit(cfg.RPID)
	if err != nil {
		logger.Error("admin record init failed", "err", err)
		os.Exit(1)
	}
	if freshToken != "" {
		printBootstrapBanner(freshToken, cfg.BaseURL)
	}

	store := space.NewStore(cfg.SpacesDir())
	gitMgr := gitrepo.NewManager(store, time.Duration(cfg.CommitDebounceMS)*time.Millisecond, logger)
	shareStore := share.NewStore(cfg.SpacesDir())
	auditLog := share.NewAuditLog(cfg.SpacesDir())
	commentStore := share.NewCommentStore(cfg.SpacesDir())
	// Per-IP token-bucket limiters. Two pools: a tight one for public
	// share / MCP routes, a generous one for admin (still useful as a
	// runaway-script brake).
	shareLimiter := share.NewLimiter(5, 20, cfg.TrustProxy)
	adminLimiter := share.NewLimiter(50, 200, cfg.TrustProxy)
	mcpStore := mcptoken.NewStore(cfg.SpacesDir())
	mcpSrv := mcphandler.New(cfg, store, gitMgr, mcpStore, auditLog)

	handler, err := httpserver.NewRouter(httpserver.Deps{
		Cfg:           cfg,
		Log:           logger,
		Store:         store,
		Git:           gitMgr,
		Shares:        shareStore,
		Audit:         auditLog,
		Lim:           shareLimiter,
		AdminLim:      adminLimiter,
		Comments:      commentStore,
		MCPTokens:     mcpStore,
		MCP:           mcpSrv,
		AuthStore:     authStore,
		SessionSecret: secret,
	})
	if err != nil {
		logger.Error("router init failed", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              cfg.Bind,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("notation listening",
			"addr", cfg.Bind,
			"data", cfg.DataDir,
			"share_path", cfg.SharePath,
			"mcp_path", cfg.MCPPath,
			"auth_mode", cfg.AuthMode,
			"rp_id", cfg.RPID,
		)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown error", "err", err)
	}
	gitMgr.FlushAll()
}

// printBootstrapBanner writes the one-time admin claim token to stderr in a
// hard-to-miss banner. We bypass slog so the token doesn't get JSON-wrapped
// inside the structured log stream and can be copy-pasted cleanly.
func printBootstrapBanner(token, baseURL string) {
	const line = "═══════════════════════════════════════════════════════════════════"
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, line)
	fmt.Fprintln(os.Stderr, "  🔑  notation — admin bootstrap token (one-time, rotates per boot)")
	fmt.Fprintln(os.Stderr, line)
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "    "+token)
	fmt.Fprintln(os.Stderr)
	if baseURL != "" {
		fmt.Fprintln(os.Stderr, "  Open "+baseURL+" and paste the token to claim the admin account.")
	} else {
		fmt.Fprintln(os.Stderr, "  Open the web UI and paste the token to claim the admin account.")
	}
	fmt.Fprintln(os.Stderr, "  Once you register a passkey, future restarts won't print a token.")
	fmt.Fprintln(os.Stderr, line)
	fmt.Fprintln(os.Stderr)
}
