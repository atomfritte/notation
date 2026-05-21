// Package mcphandler implements a minimal MCP (Model Context Protocol) server
// over Streamable-HTTP, scoped to a single Space per request. Bearer-auth is
// enforced by the HTTP middleware; the request context carries the spaceID
// and the validated token record into the tool handlers.
//
// Protocol notes:
//   - JSON-RPC 2.0 over HTTP. Client POSTs a request; server returns a single
//     response (no SSE upgrade for the common case).
//   - We support: initialize, tools/list, tools/call. The `initialized`
//     notification is acknowledged with 202.
//   - Protocol version reported: 2024-11-05 (compatible with current Claude
//     Code MCP clients). The spec evolves; bump as needed.
package mcphandler

import "encoding/json"

const protocolVersion = "2024-11-05"

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// Standard JSON-RPC error codes plus MCP-specific ones we use here.
const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
)

type toolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

type toolCallParams struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type toolResult struct {
	Content []contentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
}

func textResult(s string) *toolResult {
	return &toolResult{Content: []contentBlock{{Type: "text", Text: s}}}
}

func errResult(msg string) *toolResult {
	return &toolResult{Content: []contentBlock{{Type: "text", Text: msg}}, IsError: true}
}

func jsonResult(v any) (*toolResult, error) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return textResult(string(data)), nil
}
