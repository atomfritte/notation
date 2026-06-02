// Package tts provides server-side text-to-speech: it runs Piper (a fast,
// CPU-only neural TTS) via the bundled `piper` binary, encodes the audio to
// Ogg/Opus with `opusenc`, and caches the result on disk keyed by voice+text.
// The browser streams small per-paragraph clips from /tts and the deterministic,
// immutable URLs make them trivially cacheable (browser HTTP cache today; a PWA
// service worker offline later).
//
// The spoken text only ever reaches THIS server (same origin as the app) and is
// synthesised locally by Piper — never sent to a third-party service.
//
// Voices are auto-discovered from the model directory: every `*.onnx` with a
// sibling `*.onnx.json` becomes a selectable voice (id = file stem, language =
// its first two letters), so dropping more Piper models in adds more voices.
// If no models / binaries are present, Available() is false and the API returns
// 503 — the frontend then falls back to the on-device system voice.
package tts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrUnavailable = errors.New("server tts not available")
	ErrEmpty       = errors.New("empty text")
	ErrNoVoice     = errors.New("no such voice")
)

// Voice is one selectable server voice.
type Voice struct {
	ID    string `json:"id"`    // file stem, e.g. "de_DE-thorsten-high"
	Label string `json:"label"` // human label, e.g. "Thorsten — de_DE (high)"
	Lang  string `json:"lang"`  // 2-letter language, e.g. "de"
}

// Config configures the synthesiser. Zero values fall back to sensible defaults.
type Config struct {
	PiperBin      string // path or name of the piper binary
	ModelDir      string // dir scanned for *.onnx voice models
	EspeakData    string // path to espeak-ng-data (optional)
	OpusEnc       string // path or name of opusenc
	Bitrate       int    // opus bitrate kbps (default 32)
	CacheDir      string // disk cache directory
	CacheMaxBytes int64  // cache size cap (default 512 MiB)
	Concurrency   int    // max concurrent piper runs (default ~NumCPU/2)
}

type voiceModel struct {
	Voice
	model      string // path to .onnx
	sampleRate int
}

// Synth is a cached, concurrency-limited server-side TTS synthesiser.
type Synth struct {
	cfg     Config
	voices  map[string]*voiceModel
	order   []Voice // discovery order, for listing + default
	sem     chan struct{}
	cache   *diskCache
	flight  flightGroup
	// synthFn produces raw Opus bytes; the piper+opusenc pipeline by default,
	// swappable in tests.
	synthFn func(ctx context.Context, vm *voiceModel, text string) ([]byte, error)
}

// New builds a Synth, discovering voices and detecting whether TTS can run.
func New(cfg Config) *Synth {
	if cfg.Bitrate <= 0 {
		cfg.Bitrate = 32
	}
	if cfg.CacheMaxBytes <= 0 {
		cfg.CacheMaxBytes = 512 << 20
	}
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = max(1, runtime.NumCPU()/2)
	}
	if cfg.OpusEnc == "" {
		cfg.OpusEnc = "opusenc"
	}
	s := &Synth{
		cfg:    cfg,
		voices: map[string]*voiceModel{},
		sem:    make(chan struct{}, cfg.Concurrency),
		cache:  &diskCache{dir: cfg.CacheDir, maxBytes: cfg.CacheMaxBytes},
	}
	s.synthFn = s.runPipeline

	piper := resolveBin(cfg.PiperBin)
	opus := resolveBin(cfg.OpusEnc)
	if piper == "" || opus == "" {
		return s // unavailable
	}
	s.cfg.PiperBin, s.cfg.OpusEnc = piper, opus
	s.discover()
	return s
}

func (s *Synth) discover() {
	entries, err := os.ReadDir(s.cfg.ModelDir)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".onnx") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		model := filepath.Join(s.cfg.ModelDir, name)
		if !fileExists(model + ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".onnx")
		vm := &voiceModel{
			Voice:      Voice{ID: id, Label: voiceLabel(id), Lang: voiceLang(id)},
			model:      model,
			sampleRate: 22050,
		}
		if sr := readSampleRate(model + ".json"); sr > 0 {
			vm.sampleRate = sr
		}
		s.voices[id] = vm
		s.order = append(s.order, vm.Voice)
	}
}

func (s *Synth) Available() bool { return len(s.voices) > 0 }

// Voices lists the discovered voices in a stable order.
func (s *Synth) Voices() []Voice { return s.order }

// resolveVoice returns the requested voice, or the first discovered one when id
// is empty/unknown (so a stale client id still produces audio).
func (s *Synth) resolveVoice(id string) (*voiceModel, error) {
	if len(s.voices) == 0 {
		return nil, ErrUnavailable
	}
	if vm, ok := s.voices[id]; ok {
		return vm, nil
	}
	if id == "" {
		return s.voices[s.order[0].ID], nil
	}
	return nil, ErrNoVoice
}

// cacheKey is the content-addressed key (hex) for scope+voice+text, also the
// ETag. The scope (e.g. "admin" or a spaceID) isolates each caller's entries so
// a share guest can't pollute or evict another context's cached audio.
func cacheKey(scope, voiceID, text string) string {
	h := sha256.Sum256([]byte(scope + "\x00" + voiceID + "\x00" + strings.TrimSpace(text)))
	return hex.EncodeToString(h[:])
}

// synthTimeout bounds a single synthesis so a stuck piper can't pin a worker.
const synthTimeout = 120 * time.Second

// Get returns the Ogg/Opus audio for (voice, text) — from cache or freshly
// synthesised — plus its ETag. Concurrent identical requests synthesise once.
//
// The request context is intentionally NOT threaded into synthesis: a chunk is
// often prefetched, and if that prefetch is aborted the synthesis must still
// finish (and cache) so a concurrent real playback request doesn't fail with the
// prefetcher's cancellation. A fixed timeout bounds it instead.
func (s *Synth) Get(_ context.Context, scope, voiceID, text string) (audio []byte, etag string, err error) {
	if !s.Available() {
		return nil, "", ErrUnavailable
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, "", ErrEmpty
	}
	vm, err := s.resolveVoice(voiceID)
	if err != nil {
		return nil, "", err
	}
	key := cacheKey(scope, vm.ID, text)
	etag = `"` + key + `"`
	if b, ok := s.cache.get(key); ok {
		return b, etag, nil
	}
	b, err := s.flight.Do(key, func() ([]byte, error) {
		if b, ok := s.cache.get(key); ok {
			return b, nil
		}
		sctx, cancel := context.WithTimeout(context.Background(), synthTimeout)
		defer cancel()
		out, err := s.synthFn(sctx, vm, text)
		if err != nil {
			return nil, err
		}
		s.cache.put(key, out)
		return out, nil
	})
	return b, etag, err
}

// runPipeline = piper (raw PCM) → opusenc (Ogg/Opus), fully buffered for
// robustness (a paragraph's PCM is only a couple of MB).
func (s *Synth) runPipeline(ctx context.Context, vm *voiceModel, text string) ([]byte, error) {
	s.sem <- struct{}{}
	defer func() { <-s.sem }()

	args := []string{"--model", vm.model, "--output-raw"}
	if s.cfg.EspeakData != "" && dirExists(s.cfg.EspeakData) {
		args = append(args, "--espeak_data", s.cfg.EspeakData)
	}
	piper := exec.CommandContext(ctx, s.cfg.PiperBin, args...)
	piper.Stdin = strings.NewReader(text)
	var pcm, pErr bytes.Buffer
	piper.Stdout = &pcm
	piper.Stderr = &pErr
	if err := piper.Run(); err != nil {
		return nil, fmt.Errorf("piper: %w: %s", err, strings.TrimSpace(pErr.String()))
	}
	if pcm.Len() == 0 {
		return nil, errors.New("piper produced no audio")
	}

	opus := exec.CommandContext(ctx, s.cfg.OpusEnc,
		"--quiet", "--raw",
		"--raw-rate", strconv.Itoa(vm.sampleRate), "--raw-chan", "1", "--raw-bits", "16",
		"--bitrate", strconv.Itoa(s.cfg.Bitrate), "-", "-")
	opus.Stdin = &pcm
	var out, oErr bytes.Buffer
	opus.Stdout = &out
	opus.Stderr = &oErr
	if err := opus.Run(); err != nil {
		return nil, fmt.Errorf("opusenc: %w: %s", err, strings.TrimSpace(oErr.String()))
	}
	if out.Len() == 0 {
		return nil, errors.New("opusenc produced no audio")
	}
	return out.Bytes(), nil
}

// ---- single-flight (dedupe concurrent identical synth requests) ----

type flightGroup struct {
	mu sync.Mutex
	m  map[string]*flightCall
}
type flightCall struct {
	wg  sync.WaitGroup
	val []byte
	err error
}

func (g *flightGroup) Do(key string, fn func() ([]byte, error)) ([]byte, error) {
	g.mu.Lock()
	if g.m == nil {
		g.m = map[string]*flightCall{}
	}
	if c, ok := g.m[key]; ok {
		g.mu.Unlock()
		c.wg.Wait()
		return c.val, c.err
	}
	c := &flightCall{}
	c.wg.Add(1)
	g.m[key] = c
	g.mu.Unlock()

	// Even if fn panics, release waiters + drop the entry so the key isn't
	// wedged forever (the panic still propagates to the leader's recoverer).
	defer func() {
		g.mu.Lock()
		delete(g.m, key)
		g.mu.Unlock()
		c.wg.Done()
	}()
	c.val, c.err = fn()
	return c.val, c.err
}

// ---- disk cache (content-addressed, LRU-by-mtime eviction) ----

type diskCache struct {
	dir      string
	maxBytes int64
	mu       sync.Mutex
}

func (c *diskCache) path(key string) string { return filepath.Join(c.dir, key+".opus") }

func (c *diskCache) get(key string) ([]byte, bool) {
	if c.dir == "" {
		return nil, false
	}
	p := c.path(key)
	// Read + LRU-touch under the lock so an entry can't be evicted between the
	// read and the touch (which would lose its recency and risk premature evict).
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	_ = os.Chtimes(p, time.Now(), time.Now()) // touch → LRU recency
	return b, true
}

func (c *diskCache) put(key string, data []byte) {
	if c.dir == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.MkdirAll(c.dir, 0o750); err != nil {
		return
	}
	tmp := c.path(key) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o640); err != nil {
		return
	}
	if err := os.Rename(tmp, c.path(key)); err != nil {
		_ = os.Remove(tmp)
		return
	}
	c.evict()
}

// evict deletes the oldest entries until the cache is back under its cap.
func (c *diskCache) evict() {
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	var items []item
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasSuffix(name, ".tmp") {
			// Orphan from a crashed/failed write — we hold the lock, so no write
			// is in flight; safe to drop.
			_ = os.Remove(filepath.Join(c.dir, name))
			continue
		}
		if !strings.HasSuffix(name, ".opus") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, item{filepath.Join(c.dir, name), info.Size(), info.ModTime()})
		total += info.Size()
	}
	if total <= c.maxBytes {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items {
		if total <= c.maxBytes {
			break
		}
		if os.Remove(it.path) == nil {
			total -= it.size
		}
	}
}

// ---- helpers ----

func voiceLang(id string) string {
	if len(id) >= 2 {
		return strings.ToLower(id[:2])
	}
	return ""
}

// voiceLabel prettifies an id like "de_DE-thorsten-high" → "Thorsten — de_DE (high)".
func voiceLabel(id string) string {
	parts := strings.Split(id, "-")
	if len(parts) < 2 {
		return id
	}
	locale := parts[0]
	name := titleCase(strings.ReplaceAll(parts[1], "_", " "))
	label := name + " — " + locale
	if len(parts) >= 3 {
		label += " (" + parts[2] + ")"
	}
	return label
}

func titleCase(s string) string {
	out := []rune(s)
	upNext := true
	for i, r := range out {
		if r == ' ' {
			upNext = true
			continue
		}
		if upNext && r >= 'a' && r <= 'z' {
			out[i] = r - 32
		}
		upNext = false
	}
	return string(out)
}

func resolveBin(p string) string {
	if p == "" {
		return ""
	}
	if strings.ContainsRune(p, os.PathSeparator) {
		if fileExists(p) {
			return p
		}
		return ""
	}
	if found, err := exec.LookPath(p); err == nil {
		return found
	}
	return ""
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func readSampleRate(jsonPath string) int {
	b, err := os.ReadFile(jsonPath)
	if err != nil {
		return 0
	}
	var cfg struct {
		Audio struct {
			SampleRate int `json:"sample_rate"`
		} `json:"audio"`
	}
	if json.Unmarshal(b, &cfg) != nil {
		return 0
	}
	return cfg.Audio.SampleRate
}
