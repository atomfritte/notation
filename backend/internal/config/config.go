package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// AuthMode controls how /api/admin/* and the admin SPA are protected.
type AuthMode string

const (
	AuthModeSession  AuthMode = "session"  // notation's own passkey + session-cookie auth (default)
	AuthModeAuthelia AuthMode = "authelia" // legacy: trust Authelia ForwardAuth header
	AuthModeBoth     AuthMode = "both"     // require Authelia outer + session inner
)

type Config struct {
	Bind              string
	DataDir           string
	AdminHeader       string
	AdminGroupsHeader string
	AdminGroup        string
	SharePath         string
	MCPPath           string
	BaseURL           string
	DevBypassAuth     bool
	MaxUploadBytes    int64
	CommitDebounceMS  int
	// Raw NOTATION_COOKIE_SECURE value ("", "0" or "1") — see CookieSecure.
	CookieSecureEnv string

	// Auth
	AuthMode        AuthMode
	RPID            string
	SessionLifetime time.Duration
	TrustProxy      bool

	// Server-side TTS (Piper). Paths default to the container layout; the
	// feature simply disables itself if the binaries/models aren't present.
	TTSPiperBin   string
	TTSModelDir   string
	TTSEspeakData string
	TTSOpusEnc    string
	TTSBitrate    int
	TTSCacheMB    int64
	// Optional Kokoro ONNX sidecar (higher-quality voice). Empty URL = off.
	TTSKokoroURL    string
	TTSKokoroVoices string
}

func Load() (*Config, error) {
	cfg := &Config{
		Bind:              getEnv("NOTATION_BIND", ":8080"),
		DataDir:           getEnv("NOTATION_DATA_DIR", "/data"),
		AdminHeader:       getEnv("NOTATION_ADMIN_HEADER", "Remote-User"),
		AdminGroupsHeader: getEnv("NOTATION_ADMIN_GROUPS_HEADER", "Remote-Groups"),
		AdminGroup:        getEnv("NOTATION_ADMIN_GROUP", ""),
		SharePath:         strings.TrimRight(getEnv("NOTATION_SHARE_PATH", "/s"), "/"),
		MCPPath:           strings.TrimRight(getEnv("NOTATION_MCP_PATH", "/mcp"), "/"),
		BaseURL:           strings.TrimRight(getEnv("NOTATION_BASE_URL", ""), "/"),
		DevBypassAuth:     getEnv("NOTATION_DEV_BYPASS_AUTH", "") == "1",
		CookieSecureEnv:   getEnv("NOTATION_COOKIE_SECURE", ""),
		MaxUploadBytes:    getEnvInt64("NOTATION_MAX_UPLOAD_BYTES", 64*1024*1024),
		CommitDebounceMS:  int(getEnvInt64("NOTATION_COMMIT_DEBOUNCE_MS", 5000)),
		AuthMode:          AuthMode(getEnv("NOTATION_AUTH_MODE", string(AuthModeSession))),
		RPID:              getEnv("NOTATION_RP_ID", ""),
		SessionLifetime:   time.Duration(getEnvInt64("NOTATION_SESSION_LIFETIME_HOURS", 720)) * time.Hour,
		TrustProxy:        getEnv("NOTATION_TRUST_PROXY", "") == "1",
		TTSPiperBin:       getEnv("NOTATION_TTS_PIPER_BIN", "/opt/piper/piper"),
		TTSModelDir:       getEnv("NOTATION_TTS_MODEL_DIR", "/opt/piper/models"),
		TTSEspeakData:     getEnv("NOTATION_TTS_ESPEAK_DATA", "/opt/piper/espeak-ng-data"),
		TTSOpusEnc:        getEnv("NOTATION_TTS_OPUSENC", "opusenc"),
		TTSBitrate:        int(getEnvInt64("NOTATION_TTS_BITRATE", 32)),
		TTSCacheMB:        getEnvInt64("NOTATION_TTS_CACHE_MB", 512),
		TTSKokoroURL:      getEnv("NOTATION_TTS_KOKORO_URL", ""),
		TTSKokoroVoices:   getEnv("NOTATION_TTS_KOKORO_VOICES", "de_DE-martin-kokoro"),
	}
	if !strings.HasPrefix(cfg.SharePath, "/") || cfg.SharePath == "/" {
		return nil, fmt.Errorf("NOTATION_SHARE_PATH must be a non-root absolute path, got %q", cfg.SharePath)
	}
	if !strings.HasPrefix(cfg.MCPPath, "/") || cfg.MCPPath == "/" {
		return nil, fmt.Errorf("NOTATION_MCP_PATH must be a non-root absolute path, got %q", cfg.MCPPath)
	}
	if cfg.SharePath == cfg.MCPPath {
		return nil, fmt.Errorf("share and MCP paths must differ")
	}
	switch cfg.AuthMode {
	case AuthModeSession, AuthModeAuthelia, AuthModeBoth:
	default:
		return nil, fmt.Errorf("NOTATION_AUTH_MODE must be session|authelia|both, got %q", cfg.AuthMode)
	}
	if cfg.RPID == "" {
		cfg.RPID = deriveRPID(cfg.BaseURL)
	}
	switch cfg.CookieSecureEnv {
	case "", "0", "1":
	default:
		return nil, fmt.Errorf("NOTATION_COOKIE_SECURE must be 0 or 1, got %q", cfg.CookieSecureEnv)
	}
	return cfg, nil
}

// deriveRPID extracts the bare host from a base URL so WebAuthn passkeys are
// bound to the right domain. Falls back to "localhost" for dev when no base
// URL is configured.
func deriveRPID(baseURL string) string {
	if baseURL == "" {
		return "localhost"
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" {
		return "localhost"
	}
	host := u.Hostname() // strips port
	if host == "" {
		return "localhost"
	}
	return host
}

// CookieSecure reports whether the session cookie should carry the Secure
// flag. Fail-safe: an admin session unlocks every space, so the flag is on
// unless plain HTTP was explicitly configured. NOTATION_COOKIE_SECURE=1/0
// overrides; otherwise an http:// base URL opts out and everything else —
// including the common "TLS proxy in front, no NOTATION_BASE_URL set"
// deployment that previously got an insecure cookie — stays Secure.
// (Browsers accept Secure cookies on http://localhost, so local testing
// keeps working without the override.)
func (c *Config) CookieSecure() bool {
	switch c.CookieSecureEnv {
	case "1":
		return true
	case "0":
		return false
	}
	return !strings.HasPrefix(c.BaseURL, "http://")
}

func (c *Config) SpacesDir() string {
	return filepath.Join(c.DataDir, "spaces")
}

// TTSCacheDir is where synthesised audio clips are cached on disk.
func (c *Config) TTSCacheDir() string {
	return filepath.Join(c.DataDir, "tts-cache")
}

func (c *Config) AssetsPath() string {
	return c.SharePath + "/_assets"
}

func getEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getEnvInt64(k string, def int64) int64 {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}
