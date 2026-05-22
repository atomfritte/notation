package http

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/yoogie27/notation/internal/authstore"
	"github.com/yoogie27/notation/internal/share"
)

// webauthnHandlers groups the four WebAuthn endpoints + passkey management.
// Sits next to authHandlers but kept separate because it needs the heavier
// go-webauthn dependency.
type webauthnHandlers struct {
	auth *authHandlers
	wa   *webauthn.WebAuthn

	// In-memory store of WebAuthn challenge sessions. Each entry is keyed by
	// a random opaque cookie value handed to the client between begin/finish.
	// Per-process, never persisted (challenges are short-lived and pointless
	// across restarts anyway). 5-minute TTL is plenty for a ceremony.
	sessMu sync.Mutex
	sess   map[string]*webauthnSessionEntry
}

type webauthnSessionEntry struct {
	data    webauthn.SessionData
	purpose string // "register" or "login"
	exp     time.Time
}

const (
	webauthnCookie    = "notation_webauthn"
	webauthnTTL       = 5 * time.Minute
	purposeRegister   = "register"
	purposeLogin      = "login"
)

func newWebAuthnHandlers(ah *authHandlers) (*webauthnHandlers, error) {
	// Build the set of acceptable origins for the WebAuthn ceremony. The
	// browser sends an Origin header on register / login and go-webauthn
	// refuses the assertion if it isn't on this list, hence the dreaded
	// "verify failed: Error validating origin" when this list is wrong.
	//
	// Sources in priority order:
	//   1. NOTATION_BASE_URL — explicit, full origin from the deploy.
	//   2. https://<RPID> — fallback derived from the relying-party id. This
	//      covers the common case where the operator only sets NOTATION_RP_ID
	//      (which is the only setting that *has* to be right for passkeys to
	//      bind to the correct domain).
	//   3. localhost dev defaults — last resort so `go run` works out of the
	//      box without env vars.
	origins := []string{}
	if ah.cfg.BaseURL != "" {
		origins = append(origins, ah.cfg.BaseURL)
	}
	if ah.cfg.RPID != "" {
		derived := "https://" + ah.cfg.RPID
		seen := false
		for _, o := range origins {
			if o == derived {
				seen = true
				break
			}
		}
		if !seen {
			origins = append(origins, derived)
		}
	}
	if len(origins) == 0 {
		origins = []string{"http://localhost:5173", "http://localhost:8080"}
	}
	slog.Default().Info("webauthn config",
		"rp_id", ah.cfg.RPID,
		"origins", origins,
	)
	wa, err := webauthn.New(&webauthn.Config{
		RPDisplayName: "notation",
		RPID:          ah.cfg.RPID,
		RPOrigins:     origins,
	})
	if err != nil {
		return nil, err
	}
	return &webauthnHandlers{
		auth: ah,
		wa:   wa,
		sess: make(map[string]*webauthnSessionEntry),
	}, nil
}

// ----- session-data store ---------------------------------------------------

func (h *webauthnHandlers) saveSession(purpose string, sd *webauthn.SessionData) (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	key := base64.RawURLEncoding.EncodeToString(b)
	h.sessMu.Lock()
	h.cleanupLocked()
	h.sess[key] = &webauthnSessionEntry{
		data:    *sd,
		purpose: purpose,
		exp:     time.Now().Add(webauthnTTL),
	}
	h.sessMu.Unlock()
	return key, nil
}

func (h *webauthnHandlers) takeSession(key, purpose string) (*webauthn.SessionData, bool) {
	h.sessMu.Lock()
	defer h.sessMu.Unlock()
	e, ok := h.sess[key]
	if !ok {
		return nil, false
	}
	delete(h.sess, key)
	if e.purpose != purpose || time.Now().After(e.exp) {
		return nil, false
	}
	return &e.data, true
}

func (h *webauthnHandlers) cleanupLocked() {
	now := time.Now()
	for k, e := range h.sess {
		if now.After(e.exp) {
			delete(h.sess, k)
		}
	}
}

// ----- user adapter ---------------------------------------------------------
//
// go-webauthn drives the ceremony off a user object. Notation has exactly
// one admin user, so the adapter is small. WebAuthnID is the stable bytes
// used as `user.id` in the credential — we use the literal string "admin"
// since we'll never have a second user under the same RP.

type adminWebAuthnUser struct {
	admin *authstore.Admin
	// flagsOverride lets the login flow inject the assertion's current
	// BE/BS flags into any stored credential whose FlagsRecorded == false.
	// This is the one-time migration for passkeys registered under
	// go-webauthn < 0.11 (when we didn't persist the flags). nil during
	// registration and for the normal path. See loginFinish.
	flagsOverride *webauthn.CredentialFlags
}

func (u *adminWebAuthnUser) WebAuthnID() []byte          { return []byte("admin") }
func (u *adminWebAuthnUser) WebAuthnName() string        { return "admin" }
func (u *adminWebAuthnUser) WebAuthnDisplayName() string { return "notation admin" }
func (u *adminWebAuthnUser) WebAuthnIcon() string        { return "" }
func (u *adminWebAuthnUser) WebAuthnCredentials() []webauthn.Credential {
	return adminCredentials(u.admin, u.flagsOverride)
}

func adminCredentials(a *authstore.Admin, flagsOverride *webauthn.CredentialFlags) []webauthn.Credential {
	out := make([]webauthn.Credential, 0, len(a.Passkeys))
	for _, p := range a.Passkeys {
		cid, err1 := base64.RawURLEncoding.DecodeString(p.CredentialID)
		pk, err2 := base64.RawURLEncoding.DecodeString(p.PublicKey)
		if err1 != nil || err2 != nil {
			continue
		}
		aaguid, _ := base64.RawURLEncoding.DecodeString(p.AAGUID)
		var transports []protocol.AuthenticatorTransport
		for _, t := range p.Transports {
			transports = append(transports, protocol.AuthenticatorTransport(t))
		}
		var flags webauthn.CredentialFlags
		switch {
		case p.FlagsRecorded:
			flags = webauthn.CredentialFlags{
				BackupEligible: p.BackupEligible,
				BackupState:    p.BackupState,
			}
		case flagsOverride != nil:
			flags = *flagsOverride
		}
		out = append(out, webauthn.Credential{
			ID:        cid,
			PublicKey: pk,
			Flags:     flags,
			Authenticator: webauthn.Authenticator{
				AAGUID:    aaguid,
				SignCount: p.SignCount,
			},
			Transport: transports,
		})
	}
	return out
}

// ----- handlers -------------------------------------------------------------

// passkey register: admin must already be signed in (post-claim).

func (h *webauthnHandlers) registerBegin(w http.ResponseWriter, r *http.Request) {
	admin, err := h.auth.store.Load()
	if err != nil {
		writeInternal(w, r, "passkey.register.begin.store", err)
		return
	}
	user := &adminWebAuthnUser{admin: admin}
	opts, sd, err := h.wa.BeginRegistration(user,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationPreferred,
		}),
	)
	if err != nil {
		writeInternal(w, r, "passkey.register.begin", err)
		return
	}
	key, err := h.saveSession(purposeRegister, sd)
	if err != nil {
		writeInternal(w, r, "passkey.register.stash", err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     webauthnCookie,
		Value:    key,
		Path:     "/api/auth/passkey/",
		HttpOnly: true,
		Secure:   h.auth.cfg.CookieSecure(),
		SameSite: http.SameSiteStrictMode,
		Expires:  time.Now().Add(webauthnTTL),
	})
	// go-webauthn wraps the publicKey options in `{publicKey: {...}}`, but
	// @simplewebauthn/browser wants the inner object — send just that.
	writeJSON(w, http.StatusOK, opts.Response)
}

type registerFinishReq struct {
	Label      string          `json:"label"`
	Credential json.RawMessage `json:"credential"`
}

func (h *webauthnHandlers) registerFinish(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(webauthnCookie)
	if err != nil {
		writeError(w, http.StatusBadRequest, "no challenge in progress")
		return
	}
	sd, ok := h.takeSession(cookie.Value, purposeRegister)
	if !ok {
		writeError(w, http.StatusBadRequest, "challenge expired or already used")
		return
	}
	var body registerFinishReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(body.Credential))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid credential: "+err.Error())
		return
	}
	admin, err := h.auth.store.Load()
	if err != nil {
		writeInternal(w, r, "passkey.register.finish.store", err)
		return
	}
	user := &adminWebAuthnUser{admin: admin}
	cred, err := h.wa.CreateCredential(user, *sd, parsed)
	if err != nil {
		writeError(w, http.StatusBadRequest, "verify failed: "+err.Error())
		return
	}
	label := body.Label
	if label == "" {
		label = "Passkey"
	}
	idLen := 6
	if len(cred.ID) < idLen {
		idLen = len(cred.ID)
	}
	pk := authstore.Passkey{
		ID:             "pk_" + base64.RawURLEncoding.EncodeToString(cred.ID[:idLen]),
		Label:          label,
		CredentialID:   base64.RawURLEncoding.EncodeToString(cred.ID),
		PublicKey:      base64.RawURLEncoding.EncodeToString(cred.PublicKey),
		SignCount:      cred.Authenticator.SignCount,
		AAGUID:         base64.RawURLEncoding.EncodeToString(cred.Authenticator.AAGUID),
		CreatedAt:      time.Now().UTC(),
		BackupEligible: cred.Flags.BackupEligible,
		BackupState:    cred.Flags.BackupState,
		FlagsRecorded:  true,
	}
	for _, t := range cred.Transport {
		pk.Transports = append(pk.Transports, string(t))
	}
	err = h.auth.store.Update(func(a *authstore.Admin) error {
		a.Passkeys = append(a.Passkeys, pk)
		return nil
	})
	if err != nil {
		writeInternal(w, r, "passkey.register.persist", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":         pk.ID,
		"label":      pk.Label,
		"created_at": pk.CreatedAt,
	})
}

// passkey login: discoverable-credential flow, no prior session needed.

func (h *webauthnHandlers) loginBegin(w http.ResponseWriter, r *http.Request) {
	ip := share.ClientIP(r, h.auth.cfg.TrustProxy)
	if !h.auth.loginGuard.Allow(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again later")
		return
	}
	opts, sd, err := h.wa.BeginDiscoverableLogin()
	if err != nil {
		writeInternal(w, r, "passkey.login.begin", err)
		return
	}
	key, err := h.saveSession(purposeLogin, sd)
	if err != nil {
		writeInternal(w, r, "passkey.login.stash", err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     webauthnCookie,
		Value:    key,
		Path:     "/api/auth/passkey/",
		HttpOnly: true,
		Secure:   h.auth.cfg.CookieSecure(),
		SameSite: http.SameSiteStrictMode,
		Expires:  time.Now().Add(webauthnTTL),
	})
	// Send the inner publicKey block, not the {publicKey: {...}} wrapper.
	writeJSON(w, http.StatusOK, opts.Response)
}

func (h *webauthnHandlers) loginFinish(w http.ResponseWriter, r *http.Request) {
	ip := share.ClientIP(r, h.auth.cfg.TrustProxy)
	if !h.auth.loginGuard.Allow(ip) {
		writeError(w, http.StatusTooManyRequests, "too many attempts — try again later")
		return
	}
	cookie, err := r.Cookie(webauthnCookie)
	if err != nil {
		writeError(w, http.StatusBadRequest, "no challenge in progress")
		return
	}
	sd, ok := h.takeSession(cookie.Value, purposeLogin)
	if !ok {
		writeError(w, http.StatusBadRequest, "challenge expired or already used")
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid assertion: "+err.Error())
		return
	}
	admin, err := h.auth.store.Load()
	if err != nil {
		writeInternal(w, r, "passkey.login.finish.store", err)
		return
	}
	// One-time migration for passkeys registered before we persisted BE/BS
	// flags (go-webauthn < 0.11). For any stored credential with
	// FlagsRecorded == false, the user adapter substitutes the assertion's
	// flags so go-webauthn 0.17's strict consistency check doesn't reject
	// the login. We persist the observed flags after success below.
	assertionFlags := webauthn.NewCredentialFlags(parsed.Response.AuthenticatorData.Flags)
	user := &adminWebAuthnUser{admin: admin, flagsOverride: &assertionFlags}
	// Discoverable-login handler: WebAuthn hands us the rawID/userHandle and
	// we look up the matching admin (there's only one).
	cred, err := h.wa.ValidateDiscoverableLogin(
		func(rawID, userHandle []byte) (webauthn.User, error) {
			if !bytes.Equal(userHandle, user.WebAuthnID()) {
				return nil, errors.New("unknown user handle")
			}
			return user, nil
		},
		*sd,
		parsed,
	)
	if err != nil {
		h.auth.loginGuard.RecordFail(ip)
		writeError(w, http.StatusUnauthorized, "verify failed: "+err.Error())
		return
	}
	// Update sign count + last_used on the matching passkey.
	credIDb64 := base64.RawURLEncoding.EncodeToString(cred.ID)
	now := time.Now().UTC()
	_ = h.auth.store.Update(func(a *authstore.Admin) error {
		for i := range a.Passkeys {
			if a.Passkeys[i].CredentialID == credIDb64 {
				a.Passkeys[i].SignCount = cred.Authenticator.SignCount
				a.Passkeys[i].LastUsed = &now
				if !a.Passkeys[i].FlagsRecorded {
					a.Passkeys[i].BackupEligible = cred.Flags.BackupEligible
					a.Passkeys[i].BackupState = cred.Flags.BackupState
					a.Passkeys[i].FlagsRecorded = true
				}
				break
			}
		}
		return nil
	})
	cookieValue, _, err := IssueSession(h.auth.secret, "admin", h.auth.cfg.SessionLifetime)
	if err != nil {
		writeInternal(w, r, "passkey.login.session", err)
		return
	}
	SetSessionCookie(w, cookieValue, h.auth.cfg.CookieSecure(), h.auth.cfg.SessionLifetime)
	h.auth.loginGuard.RecordSuccess(ip)
	w.WriteHeader(http.StatusNoContent)
}

// ----- passkey management (sign-in required) -------------------------------

func (h *webauthnHandlers) listPasskeys(w http.ResponseWriter, r *http.Request) {
	admin, err := h.auth.store.Load()
	if err != nil {
		writeInternal(w, r, "passkey.list.store", err)
		return
	}
	type publicPasskey struct {
		ID        string     `json:"id"`
		Label     string     `json:"label"`
		CreatedAt time.Time  `json:"created_at"`
		LastUsed  *time.Time `json:"last_used,omitempty"`
	}
	out := make([]publicPasskey, 0, len(admin.Passkeys))
	for _, p := range admin.Passkeys {
		out = append(out, publicPasskey{
			ID: p.ID, Label: p.Label, CreatedAt: p.CreatedAt, LastUsed: p.LastUsed,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *webauthnHandlers) deletePasskey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id required")
		return
	}
	var rejected error
	err := h.auth.store.Update(func(a *authstore.Admin) error {
		if len(a.Passkeys) <= 1 {
			rejected = errors.New("cannot delete the last passkey — register a new one first")
			return rejected
		}
		filtered := a.Passkeys[:0]
		found := false
		for _, p := range a.Passkeys {
			if p.ID == id {
				found = true
				continue
			}
			filtered = append(filtered, p)
		}
		if !found {
			rejected = errors.New("passkey not found")
			return rejected
		}
		a.Passkeys = filtered
		return nil
	})
	if rejected != nil {
		// Distinguish 400 (bad request) from 404.
		if rejected.Error() == "passkey not found" {
			writeError(w, http.StatusNotFound, rejected.Error())
		} else {
			writeError(w, http.StatusBadRequest, rejected.Error())
		}
		return
	}
	if err != nil {
		writeInternal(w, r, "passkey.delete", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

