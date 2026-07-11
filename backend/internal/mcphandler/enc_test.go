package mcphandler

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/mcptoken"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
)

// TestDispatchRefusesEncryptedSpace: MCP cannot serve a zero-knowledge space —
// every tool call fails with a clear error at the space-resolution boundary,
// while a plaintext space is still served normally.
func TestDispatchRefusesEncryptedSpace(t *testing.T) {
	dir := t.TempDir()
	store := space.NewStore(dir)
	if _, err := store.CreateEncrypted("vault", "vault", "admin"); err != nil {
		t.Fatalf("CreateEncrypted: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	git := gitrepo.NewManager(store, time.Hour, logger)
	audit := share.NewAuditLog(dir)
	tokens := mcptoken.NewStore(dir)
	cfg := &config.Config{MaxUploadBytes: 1 << 20}
	s := New(cfg, store, git, tokens, audit)

	// Every tool call against the encrypted space is refused.
	for _, tool := range []string{"read_file", "write_file", "get_tree", "search", "list_files"} {
		res, err := s.dispatchTool(context.Background(), "vault", "tok1", tool, map[string]any{
			"path": "note.md", "content": "x", "query": "y",
		})
		if err != nil {
			t.Fatalf("dispatchTool(%s) protocol err: %v", tool, err)
		}
		if !res.IsError {
			t.Errorf("dispatchTool(%s): expected isError=true for encrypted space", tool)
		}
		if len(res.Content) == 0 || !strings.Contains(res.Content[0].Text, "encrypted") {
			t.Errorf("dispatchTool(%s): result should mention 'encrypted', got %+v", tool, res.Content)
		}
	}

	// Positive control: a plaintext space is served normally.
	if _, err := store.Create("plain", "plain", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteFile("plain", "note.md", strings.NewReader("hello world"), 1<<20); err != nil {
		t.Fatal(err)
	}
	res, err := s.dispatchTool(context.Background(), "plain", "tok1", "read_file", map[string]any{"path": "note.md"})
	if err != nil {
		t.Fatalf("dispatchTool(plain read_file): %v", err)
	}
	if res.IsError {
		t.Errorf("plaintext read_file should succeed, got isError: %+v", res.Content)
	}
	if len(res.Content) == 0 || !strings.Contains(res.Content[0].Text, "hello world") {
		t.Errorf("plaintext read_file should return content, got %+v", res.Content)
	}
}
