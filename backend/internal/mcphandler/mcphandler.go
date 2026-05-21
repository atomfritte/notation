package mcphandler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/mcptoken"
	"github.com/yoogie27/notation/internal/share"
	"github.com/yoogie27/notation/internal/space"
)

type ctxKey int

const (
	ctxSpaceID ctxKey = iota
	ctxTokenID
)

type Server struct {
	cfg    *config.Config
	store  *space.Store
	git    *gitrepo.Manager
	tokens *mcptoken.Store
	audit  *share.AuditLog
}

func New(cfg *config.Config, store *space.Store, git *gitrepo.Manager, tokens *mcptoken.Store, audit *share.AuditLog) *Server {
	return &Server{cfg: cfg, store: store, git: git, tokens: tokens, audit: audit}
}

// Handler returns an http.Handler that authenticates Bearer tokens against the
// spaceID URL parameter, then dispatches JSON-RPC requests on the same path.
func (s *Server) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		spaceID := chi.URLParam(r, "spaceID")
		if spaceID == "" {
			http.Error(w, "missing space id", http.StatusBadRequest)
			return
		}
		if _, err := s.store.Get(spaceID); err != nil {
			http.Error(w, "space not found", http.StatusNotFound)
			return
		}
		raw := extractBearer(r)
		if raw == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="notation"`)
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		tok, err := s.tokens.Validate(spaceID, raw)
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="notation", error="invalid_token"`)
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		s.tokens.TouchLastUsed(spaceID, tok.ID)

		switch r.Method {
		case http.MethodPost:
			ctx := context.WithValue(r.Context(), ctxSpaceID, spaceID)
			ctx = context.WithValue(ctx, ctxTokenID, tok.ID)
			s.servePOST(w, r.WithContext(ctx))
		case http.MethodGet:
			// Streamable-HTTP optional GET — we don't push server-initiated messages.
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const p = "Bearer "
	if !strings.HasPrefix(h, p) {
		return ""
	}
	return strings.TrimSpace(h[len(p):])
}

func (s *Server) servePOST(w http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+1024))
	var req rpcRequest
	if err := dec.Decode(&req); err != nil {
		writeRPC(w, rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: codeParseError, Message: "parse error"}})
		return
	}
	if req.JSONRPC != "2.0" {
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: codeInvalidRequest, Message: "invalid jsonrpc version"}})
		return
	}
	switch req.Method {
	case "initialize":
		s.handleInitialize(w, req)
	case "notifications/initialized", "initialized":
		// Notification: no response body, just 202.
		w.WriteHeader(http.StatusAccepted)
	case "ping":
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}})
	case "tools/list":
		s.handleToolsList(w, req)
	case "tools/call":
		s.handleToolsCall(w, r.Context(), req)
	case "resources/list":
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{"resources": []any{}}})
	case "prompts/list":
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{"prompts": []any{}}})
	default:
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: codeMethodNotFound, Message: "method not found: " + req.Method}})
	}
}

func (s *Server) handleInitialize(w http.ResponseWriter, req rpcRequest) {
	writeRPC(w, rpcResponse{
		JSONRPC: "2.0", ID: req.ID,
		Result: map[string]any{
			"protocolVersion": protocolVersion,
			"serverInfo": map[string]string{
				"name":    "notation",
				"version": "0.1.0",
			},
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
		},
	})
}

func (s *Server) handleToolsList(w http.ResponseWriter, req rpcRequest) {
	writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{
		"tools": s.toolDefs(),
	}})
}

func (s *Server) handleToolsCall(w http.ResponseWriter, ctx context.Context, req rpcRequest) {
	var p toolCallParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: codeInvalidParams, Message: "invalid params"}})
		return
	}
	spaceID, _ := ctx.Value(ctxSpaceID).(string)
	tokenID, _ := ctx.Value(ctxTokenID).(string)
	res, err := s.dispatchTool(ctx, spaceID, tokenID, p.Name, p.Arguments)
	if err != nil {
		// Protocol-level error.
		writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: codeInternal, Message: err.Error()}})
		return
	}
	writeRPC(w, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: res})
}

func writeRPC(w http.ResponseWriter, resp rpcResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// auditCall records an MCP tool invocation in the per-Space audit log.
func (s *Server) auditCall(spaceID, tokenID, action, path string, err error) {
	entry := share.AuditEntry{
		Actor:  "mcp:" + tokenID,
		Action: action,
		Path:   path,
	}
	if err != nil {
		entry.Err = err.Error()
	}
	_ = s.audit.Append(spaceID, entry)
}

// ErrUnknownTool is returned when a tool name is not registered.
var ErrUnknownTool = errors.New("unknown tool")
