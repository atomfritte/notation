package http

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/yoogie27/notation/internal/authstore"
	"github.com/yoogie27/notation/internal/config"
	"github.com/yoogie27/notation/internal/share"
)

type authHandlers struct {
	cfg        *config.Config
	store      *authstore.Store
	secret     []byte
	claimGuard *loginGuard
	loginGuard *loginGuard
}

func newAuthHandlers(cfg *config.Config, store *authstore.Store, secret []byte) *authHandlers {
	return &authHandlers{
		cfg:        cfg,
		store:      store,
		secret:     secret,
		claimGuard: newLoginGuard(10, time.Hour), // claim: 10 fails → 1h lock
		loginGuard: newLoginGuard(10, time.Hour), // passkey login: same
	}
}

// stateResponse is the public state-machine view: the frontend uses this on
// page load to decide which auth screen to show. Includes the CSRF token
// only when there's an active session — clients without one are not yet
// allowed to make state-changing requests.
type stateResponse struct {
	SignedIn          bool   `json:"signed_in"`
	NeedsClaim        bool   `json:"needs_claim"`
	NeedsPasskeySetup bool   `json:"needs_passkey_setup"`
	HasPasskeys       bool   `json:"has_passkeys"`
	RPID              string `json:"rp_id"`
	AuthMode          string `json:"auth_mode"`
	CSRFToken         string `json:"csrf_token,omitempty"`
	User              string `json:"user,omitempty"`
}

func (h *authHandlers) state(w http.ResponseWriter, r *http.Request) {
	admin, err := h.store.Load()
	if err != nil && !errors.Is(err, authstore.ErrAdminNotInitialized) {
		writeInternal(w, r, "auth.state.store", err)
		return
	}
	resp := stateResponse{
		AuthMode: string(h.cfg.AuthMode),
		RPID:     h.cfg.RPID,
	}
	if admin != nil {
		resp.HasPasskeys = admin.HasPasskeys()
		resp.NeedsClaim = admin.Bootstrap != nil
	} else {
		// Should never happen — main.go always inits — but be defensive.
		resp.NeedsClaim = true
	}
	if c, err := r.Cookie(SessionCookieName); err == nil {
		if sess, err := ValidateSession(h.secret, c.Value); err == nil {
			resp.SignedIn = true
			resp.CSRFToken = sess.CSRF
			resp.User = sess.User
			if admin != nil && !admin.HasPasskeys() {
				resp.NeedsPasskeySetup = true
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type claimReq struct {
	Token string `json:"token"`
}

func (h *authHandlers) claim(w http.ResponseWriter, r *http.Request) {
	ip := share.ClientIP(r, h.cfg.TrustProxy)
	if !h.claimGuard.Allow(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again later")
		return
	}
	var req claimReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" {
		writeError(w, http.StatusBadRequest, "token is required")
		return
	}
	admin, err := h.store.Load()
	if err != nil {
		writeInternal(w, r, "auth.claim.store", err)
		return
	}
	if admin.Bootstrap == nil {
		writeError(w, http.StatusGone, "admin already claimed — delete admin.json + restart to reset")
		return
	}
	hash := authstore.HashToken(req.Token)
	if subtle.ConstantTimeCompare([]byte(hash), []byte(admin.Bootstrap.Hash)) != 1 {
		h.claimGuard.RecordFail(ip)
		writeError(w, http.StatusUnauthorized, "invalid token")
		return
	}
	// Success — clear the bootstrap record and issue a session.
	if err := h.store.Update(func(a *authstore.Admin) error {
		a.Bootstrap = nil
		return nil
	}); err != nil {
		writeInternal(w, r, "auth.claim.update", err)
		return
	}
	cookieValue, _, err := IssueSession(h.secret, "admin", h.cfg.SessionLifetime)
	if err != nil {
		writeInternal(w, r, "auth.claim.session", err)
		return
	}
	SetSessionCookie(w, cookieValue, h.cfg.CookieSecure(), h.cfg.SessionLifetime)
	h.claimGuard.RecordSuccess(ip)
	w.WriteHeader(http.StatusNoContent)
}

func (h *authHandlers) logout(w http.ResponseWriter, _ *http.Request) {
	ClearSessionCookie(w, h.cfg.CookieSecure())
	w.WriteHeader(http.StatusNoContent)
}

// ---- loginGuard: per-IP failure tracker with hard lockout ------------------
//
// Reused by `claim` and (later) WebAuthn `/login/finish`. Track consecutive
// failures per IP; lock the IP out for `lockout` after `maxFails` fails;
// reset on any successful attempt. Successful traffic also caps memory growth.

type loginGuard struct {
	mu       sync.Mutex
	perIP    map[string]*loginEntry
	maxFails int
	lockout  time.Duration
}

type loginEntry struct {
	fails       int
	lockedUntil time.Time
	lastFail    time.Time
}

func newLoginGuard(maxFails int, lockout time.Duration) *loginGuard {
	return &loginGuard{
		perIP:    make(map[string]*loginEntry),
		maxFails: maxFails,
		lockout:  lockout,
	}
}

func (g *loginGuard) Allow(ip string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	e := g.perIP[ip]
	if e == nil {
		return true
	}
	if time.Now().Before(e.lockedUntil) {
		return false
	}
	// Entry expired — reset.
	if time.Since(e.lastFail) > g.lockout {
		delete(g.perIP, ip)
	}
	return true
}

func (g *loginGuard) RecordFail(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	e := g.perIP[ip]
	if e == nil {
		e = &loginEntry{}
		g.perIP[ip] = e
	}
	e.fails++
	e.lastFail = time.Now()
	if e.fails >= g.maxFails {
		e.lockedUntil = time.Now().Add(g.lockout)
	}
}

func (g *loginGuard) RecordSuccess(ip string) {
	g.mu.Lock()
	delete(g.perIP, ip)
	g.mu.Unlock()
}
