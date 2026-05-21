package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
		MaxUploadBytes:    getEnvInt64("NOTATION_MAX_UPLOAD_BYTES", 64*1024*1024),
		CommitDebounceMS:  int(getEnvInt64("NOTATION_COMMIT_DEBOUNCE_MS", 5000)),
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
	return cfg, nil
}

func (c *Config) SpacesDir() string {
	return filepath.Join(c.DataDir, "spaces")
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
