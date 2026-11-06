package http

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yoogie27/notation/internal/auth"
)

const testAIKey = "sk-ant-api03-testkeytestkeytestkeytestkey_-WXYZ"

func chatPayload(meta, body []byte) []byte {
	b, _ := json.Marshal(map[string]string{
		"meta": base64.StdEncoding.EncodeToString(meta),
		"body": base64.StdEncoding.EncodeToString(body),
	})
	return b
}

func fakeSealed() []byte {
	b := bytes.Repeat([]byte{7}, 48)
	b[0], b[1] = 1, 1
	return b
}

// The key goes in through settings and only comes back out through the
// CSRF-guarded POST — never in a settings read.
func TestAIKeyNeverInSettingsResponse(t *testing.T) {
	e := newIsoEnv(t)
	put := e.admin(http.MethodPut, "/api/admin/ai/settings", []byte(`{"api_key":"`+testAIKey+`"}`))
	if put.Code != http.StatusOK {
		t.Fatalf("PUT settings = %d %s", put.Code, put.Body)
	}
	if strings.Contains(put.Body.String(), "testkeytestkey") {
		t.Fatalf("PUT response leaks the key: %s", put.Body)
	}
	get := e.admin(http.MethodGet, "/api/admin/ai/settings", nil)
	if get.Code != http.StatusOK || strings.Contains(get.Body.String(), "testkeytestkey") {
		t.Fatalf("GET settings = %d %s", get.Code, get.Body)
	}
	if !strings.Contains(get.Body.String(), `"configured":true`) {
		t.Errorf("settings not marked configured: %s", get.Body)
	}

	// No CSRF token → refused, even for the signed-in admin.
	noCSRF := e.do(http.MethodPost, "/api/admin/ai/key", nil, nil)
	if noCSRF.Code != http.StatusForbidden {
		t.Errorf("key issue without CSRF = %d, want 403", noCSRF.Code)
	}
	key := e.admin(http.MethodPost, "/api/admin/ai/key", nil)
	if key.Code != http.StatusOK || !strings.Contains(key.Body.String(), testAIKey) {
		t.Fatalf("key issue = %d %s", key.Code, key.Body)
	}
	if cc := key.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("key response Cache-Control = %q, want no-store", cc)
	}
}

func TestAIRejectsAdminKey(t *testing.T) {
	e := newIsoEnv(t)
	rec := e.admin(http.MethodPut, "/api/admin/ai/settings", []byte(`{"api_key":"sk-ant-admin01-abcdefghijklmnopqrstuvwxyz"}`))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("admin key accepted: %d %s", rec.Code, rec.Body)
	}
}

// A share or MCP token can never reach the assistant: /api/admin is behind the
// admin session, and the key endpoint is not on any share/MCP route.
func TestAIKeyUnreachableWithoutAdminSession(t *testing.T) {
	e := newIsoEnv(t)
	_ = e.admin(http.MethodPut, "/api/admin/ai/settings", []byte(`{"api_key":"`+testAIKey+`"}`))
	for _, target := range []string{
		"/s/api/" + e.alphaShareTok + "/ai/key",
		"/mcp/alpha/ai/key",
	} {
		rec := e.do(http.MethodPost, target, nil, map[string]string{"Authorization": "Bearer " + e.alphaMCPTok})
		if strings.Contains(rec.Body.String(), testAIKey) {
			t.Fatalf("%s leaked the key", target)
		}
	}
}

func TestChatsPlaintextSpaceRoundTrip(t *testing.T) {
	e := newIsoEnv(t)
	id := "0123456789abcdef0123456789abcdef"
	rec := e.admin(http.MethodPut, "/api/admin/spaces/alpha/chats/"+id, chatPayload([]byte(`{"title":"T"}`), []byte(`{"messages":[]}`)))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT chat = %d %s", rec.Code, rec.Body)
	}
	list := e.admin(http.MethodGet, "/api/admin/spaces/alpha/chats", nil)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), id) {
		t.Fatalf("list = %d %s", list.Code, list.Body)
	}
	got := e.admin(http.MethodGet, "/api/admin/spaces/alpha/chats/"+id, nil)
	if got.Code != http.StatusOK || got.Body.String() != `{"messages":[]}` {
		t.Fatalf("get = %d %q", got.Code, got.Body)
	}
	// Other space: nothing there.
	other := e.admin(http.MethodGet, "/api/admin/spaces/beta/chats/"+id, nil)
	if other.Code != http.StatusNotFound {
		t.Errorf("beta sees alpha's chat: %d", other.Code)
	}
	// A sealed record on a plaintext space is refused.
	sealed := e.admin(http.MethodPut, "/api/admin/spaces/alpha/chats/"+id, chatPayload(fakeSealed(), fakeSealed()))
	if sealed.Code != http.StatusConflict {
		t.Errorf("sealed chat on plaintext space = %d, want 409", sealed.Code)
	}
	del := e.admin(http.MethodDelete, "/api/admin/spaces/alpha/chats/"+id, nil)
	if del.Code != http.StatusNoContent {
		t.Errorf("delete = %d", del.Code)
	}
}

// The zero-knowledge guarantee for chats: the server refuses to store a chat in
// the clear on an encrypted space, whatever the client sends.
func TestChatsEncryptedSpaceRefusesPlaintext(t *testing.T) {
	e := newIsoEnv(t)
	if _, err := e.store.CreateEncrypted("vault", "Vault", "admin"); err != nil {
		t.Fatal(err)
	}
	id := "fedcba9876543210fedcba9876543210"
	plain := e.admin(http.MethodPut, "/api/admin/spaces/vault/chats/"+id, chatPayload([]byte(`{"title":"secret plan"}`), []byte(`{"messages":["secret"]}`)))
	if plain.Code != http.StatusConflict {
		t.Fatalf("plaintext chat on encrypted space = %d %s, want 409", plain.Code, plain.Body)
	}
	ok := e.admin(http.MethodPut, "/api/admin/spaces/vault/chats/"+id, chatPayload(fakeSealed(), fakeSealed()))
	if ok.Code != http.StatusNoContent {
		t.Fatalf("sealed chat = %d %s", ok.Code, ok.Body)
	}
	list := e.admin(http.MethodGet, "/api/admin/spaces/vault/chats", nil)
	if !strings.Contains(list.Body.String(), `"sealed":true`) {
		t.Errorf("listing = %s", list.Body)
	}
}

func TestChatsInvalidIDs(t *testing.T) {
	e := newIsoEnv(t)
	for _, bad := range []string{"..%2F..%2Fmeta.json", "XYZ", "0123"} {
		rec := e.admin(http.MethodPut, "/api/admin/spaces/alpha/chats/"+bad, chatPayload([]byte(`{}`), []byte(`{}`)))
		if rec.Code == http.StatusNoContent {
			t.Errorf("chat id %q accepted", bad)
		}
	}
}

func TestCSPAllowsOnlyTheClaudeAPI(t *testing.T) {
	e := newIsoEnv(t)
	rec := e.admin(http.MethodGet, "/healthz", nil)
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "connect-src 'self' https://api.anthropic.com;") {
		t.Fatalf("CSP connect-src = %q", csp)
	}
	if strings.Contains(csp, "script-src 'self' https") {
		t.Errorf("third-party scripts allowed: %q", csp)
	}
}

func TestAIActorCommitsAsAI(t *testing.T) {
	r := httptest.NewRequest(http.MethodPut, "/x", nil)
	r = r.WithContext(auth.WithAdmin(r.Context(), auth.AdminUser{Name: "manu"}))
	if got := adminAuthor(r).Name; got != "admin:manu" {
		t.Errorf("plain author = %q", got)
	}
	r.Header.Set("X-Notation-Actor", "ai")
	if got := adminAuthor(r).Name; got != "ai:manu" {
		t.Errorf("ai author = %q", got)
	}
}
