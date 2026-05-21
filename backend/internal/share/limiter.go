package share

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Limiter is a per-key token bucket. No extra dependencies — we do our own
// math because golang.org/x/time/rate would add a module just for this.
type Limiter struct {
	mu          sync.Mutex
	cache       map[string]*bucket
	rate        float64 // tokens per second
	burst       float64
	lastCleanup time.Time
}

type bucket struct {
	tokens   float64
	lastFill time.Time
}

func NewLimiter(rps, burst float64) *Limiter {
	return &Limiter{
		cache:       make(map[string]*bucket),
		rate:        rps,
		burst:       burst,
		lastCleanup: time.Now(),
	}
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.cache[key]
	if !ok {
		l.cache[key] = &bucket{tokens: l.burst - 1, lastFill: now}
		l.maybeCleanup(now)
		return true
	}
	elapsed := now.Sub(b.lastFill).Seconds()
	b.tokens += elapsed * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.lastFill = now
	if b.tokens >= 1 {
		b.tokens -= 1
		l.maybeCleanup(now)
		return true
	}
	l.maybeCleanup(now)
	return false
}

func (l *Limiter) maybeCleanup(now time.Time) {
	if now.Sub(l.lastCleanup) < 5*time.Minute {
		return
	}
	l.lastCleanup = now
	for k, v := range l.cache {
		if now.Sub(v.lastFill) > 10*time.Minute {
			delete(l.cache, k)
		}
	}
}

func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.Allow(ClientIP(r)) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP extracts the best-effort client IP, honoring X-Forwarded-For when
// the request looks like it came through a reverse proxy. NOTE: this assumes
// the reverse proxy strips/rewrites the header — if you run this exposed to
// the internet without a proxy, attackers can forge XFF freely.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if ip, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return ip
	}
	return r.RemoteAddr
}
