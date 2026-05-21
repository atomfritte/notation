package http

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// SessionCookieName is the cookie that carries our HMAC-signed session.
const SessionCookieName = "notation_session"

// Session is the payload of the session cookie. Signed by HMAC-SHA256 using
// the server-secret, so any tampering is detected on the next request.
type Session struct {
	User      string `json:"u"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	CSRF      string `json:"c"`
}

func (s *Session) Expired() bool {
	return time.Now().Unix() >= s.ExpiresAt
}

// IssueSession mints a new signed session cookie value for the given user.
func IssueSession(secret []byte, user string, lifetime time.Duration) (string, *Session, error) {
	csrf, err := randomString(24)
	if err != nil {
		return "", nil, err
	}
	now := time.Now().UTC()
	s := &Session{
		User:      user,
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(lifetime).Unix(),
		CSRF:      csrf,
	}
	cookie, err := signSession(secret, s)
	if err != nil {
		return "", nil, err
	}
	return cookie, s, nil
}

// ValidateSession parses + verifies a cookie value. Rejects on bad signature,
// malformed payload, or expired session.
func ValidateSession(secret []byte, cookieValue string) (*Session, error) {
	if cookieValue == "" {
		return nil, errors.New("empty session cookie")
	}
	parts := strings.SplitN(cookieValue, ".", 2)
	if len(parts) != 2 {
		return nil, errors.New("malformed session cookie")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("cookie payload: %w", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("cookie signature: %w", err)
	}
	expected := hmacSum(secret, payload)
	if subtle.ConstantTimeCompare(sig, expected) != 1 {
		return nil, errors.New("session signature mismatch")
	}
	var s Session
	if err := json.Unmarshal(payload, &s); err != nil {
		return nil, fmt.Errorf("session payload: %w", err)
	}
	if s.Expired() {
		return nil, errors.New("session expired")
	}
	return &s, nil
}

func signSession(secret []byte, s *Session) (string, error) {
	payload, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	sig := hmacSum(secret, payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func hmacSum(secret, data []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write(data)
	return m.Sum(nil)
}

func randomString(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SetSessionCookie writes the cookie with secure flags. `secure` should be
// set to false only for local HTTP dev (over http://localhost…).
func SetSessionCookie(w http.ResponseWriter, value string, secure bool, lifetime time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
		Expires:  time.Now().UTC().Add(lifetime),
	})
}

// ClearSessionCookie deletes the cookie (used on logout).
func ClearSessionCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}
