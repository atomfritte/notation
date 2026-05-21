package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

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

	store := space.NewStore(cfg.SpacesDir())
	gitMgr := gitrepo.NewManager(store, time.Duration(cfg.CommitDebounceMS)*time.Millisecond, logger)
	shareStore := share.NewStore(cfg.SpacesDir())
	auditLog := share.NewAuditLog(cfg.SpacesDir())
	commentStore := share.NewCommentStore(cfg.SpacesDir())
	limiter := share.NewLimiter(5, 20) // 5 rps avg, burst 20, per client IP
	mcpStore := mcptoken.NewStore(cfg.SpacesDir())
	mcpSrv := mcphandler.New(cfg, store, gitMgr, mcpStore, auditLog)

	handler := httpserver.NewRouter(httpserver.Deps{
		Cfg:       cfg,
		Log:       logger,
		Store:     store,
		Git:       gitMgr,
		Shares:    shareStore,
		Audit:     auditLog,
		Lim:       limiter,
		Comments:  commentStore,
		MCPTokens: mcpStore,
		MCP:       mcpSrv,
	})

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
	// Flush pending auto-commits so no edit is lost.
	gitMgr.FlushAll()
}
