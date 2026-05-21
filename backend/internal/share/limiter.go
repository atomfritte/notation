package share

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// maxLimiterBuckets caps the in-memory per-IP bucket map so a flash burst of
// unique IPs can't grow it unboundedly between cleanup ticks. When the cap
// is hit, we evict the bucket with the oldest lastFill (O(n) scan, fine for
// the cap size).
const maxLimiterBuckets = 10_000

// Limiter is a per-key token bucket. No extra dependencies — we do our own
// math because golang.org/x/time/rate would add a module just for this.
type Limiter struct {
	mu          sync.Mutex
	cache       map[string]*bucket
	rate        float64 // tokens per second
	burst       float64
	trustProxy  bool
	lastCleanup time.Time
}

type bucket struct {
	tokens   float64
	lastFill time.Time
}

func NewLimiter(rps, burst float64, trustProxy bool) *Limiter {
	return &Limiter{
		cache:       make(map[string]*bucket),
		rate:        rps,
		burst:       burst,
		trustProxy:  trustProxy,
		lastCleanup: time.Now(),
	}
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.cache[key]
	if !ok {
		if len(l.cache) >= maxLimiterBuckets {
			l.evictOldestLocked()
		}
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

func (l *Limiter) evictOldestLocked() {
	var oldestKey string
	var oldestT time.Time
	for k, v := range l.cache {
		if oldestT.IsZero() || v.lastFill.Before(oldestT) {
			oldestT = v.lastFill
			oldestKey = k
		}
	}
	if oldestKey != "" {
		delete(l.cache, oldestKey)
	}
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
		if !l.Allow(ClientIP(r, l.trustProxy)) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP returns the best-effort client IP.
//
// If trustProxy is true, X-Forwarded-For is honoured (first hop), suitable
// for deployments behind a known reverse proxy (Traefik, Caddy, nginx) that
// rewrites the header. With trustProxy false, the raw r.RemoteAddr is used
// — anyone exposed to the public internet without a stripping proxy MUST
// keep trustProxy off, otherwise rate limits are trivially bypassed by any
// client setting the header.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i > 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
	}
	if ip, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return ip
	}
	return r.RemoteAddr
}
