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
	"io"
	"net/http"
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
	// ErrNotCached is returned by GetCached when a clip hasn't been synthesised
	// yet. The offline "include voice" flow uses cache-only requests so it pulls
	// only already-synthesised audio instead of triggering (slow) synthesis.
	ErrNotCached = errors.New("not cached")
)

// Voice is one selectable server voice.
type Voice struct {
	ID    string `json:"id"`    // file stem, e.g. "de_DE-thorsten-high"
	Label string `json:"label"` // human label, e.g. "Thorsten — de_DE (high)"
	Lang  string `json:"lang"`  // 2-letter language, e.g. "de"
}

// Config configures the synthesiser. Zero values fall back to sensible defaults.
type Config struct {
	PiperBin      string   // path or name of the piper binary
	ModelDir      string   // dir scanned for *.onnx voice models
	EspeakData    string   // path to espeak-ng-data (optional)
	OpusEnc       string   // path or name of opusenc (required for ALL engines)
	Bitrate       int      // opus bitrate kbps (default 32)
	CacheDir      string   // disk cache directory
	CacheMaxBytes int64    // cache size cap (default 512 MiB)
	Concurrency   int      // max concurrent synth runs (default ~NumCPU/2)
	KokoroURL     string   // base URL of an optional Kokoro ONNX sidecar
	KokoroVoices  []string // voice ids served by the sidecar (engine "kokoro")
}

const (
	enginePiper  = "piper"
	engineKokoro = "kokoro"
	kokoroRate   = 24000 // Kokoro outputs 24 kHz mono PCM
)

type voiceModel struct {
	Voice
	engine     string // enginePiper | engineKokoro
	model      string // path to .onnx (piper only)
	sampleRate int
}

// Synth is a cached, concurrency-limited server-side TTS synthesiser.
type Synth struct {
	cfg    Config
	voices map[string]*voiceModel
	order  []Voice // discovery order, for listing + default
	sem    chan struct{}
	cache  *diskCache
	flight flightGroup
	httpc  *http.Client
	// synthFn produces raw Opus bytes; dispatches per voice engine by default,
	// swappable in tests.
	synthFn func(ctx context.Context, vm *voiceModel, p styleParams, text string) ([]byte, error)
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
		httpc:  &http.Client{Timeout: synthTimeout},
	}
	s.synthFn = s.synthesize

	// opusenc encodes every engine's PCM → Ogg/Opus, so it's required for any TTS.
	opus := resolveBin(cfg.OpusEnc)
	if opus == "" {
		return s // unavailable
	}
	s.cfg.OpusEnc = opus

	// Piper voices (local ONNX) need the piper binary; optional.
	if piper := resolveBin(cfg.PiperBin); piper != "" {
		s.cfg.PiperBin = piper
		s.discover()
	}
	// Kokoro voices come from an optional sidecar (no local model needed).
	if cfg.KokoroURL != "" {
		s.registerKokoro()
	}
	return s
}

// registerKokoro adds the sidecar-served voices (engine "kokoro").
func (s *Synth) registerKokoro() {
	for _, id := range s.cfg.KokoroVoices {
		id = strings.TrimSpace(id)
		if id == "" || s.voices[id] != nil {
			continue
		}
		vm := &voiceModel{
			Voice:      Voice{ID: id, Label: voiceLabel(id), Lang: voiceLang(id)},
			engine:     engineKokoro,
			sampleRate: kokoroRate,
		}
		s.voices[id] = vm
		s.order = append(s.order, vm.Voice)
	}
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
			engine:     enginePiper,
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
func cacheKey(scope, voiceID, style, text string) string {
	h := sha256.Sum256([]byte(scope + "\x00" + voiceID + "\x00" + style + "\x00" + strings.TrimSpace(text)))
	return hex.EncodeToString(h[:])
}

// styleParams tunes Piper's delivery for a named style.
type styleParams struct {
	lengthScale     float64 // >1 = slower speech; 0 = piper default
	sentenceSilence float64 // seconds of silence between sentences; 0 = default
}

// styleFor maps a style name to synthesis params. "meditation" reads slowly with
// long pauses; anything else is normal.
func styleFor(name string) styleParams {
	switch name {
	case "meditation":
		return styleParams{lengthScale: 1.45, sentenceSilence: 1.0}
	default:
		return styleParams{}
	}
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
func (s *Synth) Get(_ context.Context, scope, voiceID, style, text string) (audio []byte, etag string, err error) {
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
	key := cacheKey(scope, vm.ID, style, text)
	etag = `"` + key + `"`
	if b, ok := s.cache.get(key); ok {
		return b, etag, nil
	}
	p := styleFor(style)
	b, err := s.flight.Do(key, func() ([]byte, error) {
		if b, ok := s.cache.get(key); ok {
			return b, nil
		}
		sctx, cancel := context.WithTimeout(context.Background(), synthTimeout)
		defer cancel()
		out, err := s.synthFn(sctx, vm, p, text)
		if err != nil {
			return nil, err
		}
		s.cache.put(key, out)
		return out, nil
	})
	return b, etag, err
}

// GetCached returns a clip ONLY if it's already in the disk cache; it never
// synthesises. Returns ErrNotCached on a miss. The "include voice" offline option
// uses this (via a cache-only request header) so it downloads only audio that has
// already been prepared, without hammering Piper for a whole space on demand.
func (s *Synth) GetCached(scope, voiceID, style, text string) (audio []byte, etag string, err error) {
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
	key := cacheKey(scope, vm.ID, style, text)
	etag = `"` + key + `"`
	if b, ok := s.cache.get(key); ok {
		return b, etag, nil
	}
	return nil, etag, ErrNotCached
}

// synthesize dispatches to the voice's engine, then encodes the resulting raw
// 16-bit-mono PCM to Ogg/Opus. The concurrency gate + opus stage are shared.
func (s *Synth) synthesize(ctx context.Context, vm *voiceModel, p styleParams, text string) ([]byte, error) {
	s.sem <- struct{}{}
	defer func() { <-s.sem }()

	var pcm []byte
	var err error
	switch vm.engine {
	case engineKokoro:
		pcm, err = s.runKokoro(ctx, vm, p, text)
	default:
		pcm, err = s.runPiper(ctx, vm, p, text)
	}
	if err != nil {
		return nil, err
	}
	if len(pcm) == 0 {
		return nil, errors.New("synth produced no audio")
	}
	return s.pcmToOpus(ctx, pcm, vm.sampleRate)
}

// runPiper produces raw 16-bit mono PCM via the piper binary (stdin = text).
func (s *Synth) runPiper(ctx context.Context, vm *voiceModel, p styleParams, text string) ([]byte, error) {
	args := []string{"--model", vm.model, "--output-raw"}
	if s.cfg.EspeakData != "" && dirExists(s.cfg.EspeakData) {
		args = append(args, "--espeak_data", s.cfg.EspeakData)
	}
	if p.lengthScale > 0 {
		args = append(args, "--length_scale", strconv.FormatFloat(p.lengthScale, 'f', 2, 64))
	}
	if p.sentenceSilence > 0 {
		args = append(args, "--sentence_silence", strconv.FormatFloat(p.sentenceSilence, 'f', 2, 64))
	}
	piper := exec.CommandContext(ctx, s.cfg.PiperBin, args...)
	piper.Stdin = strings.NewReader(text)
	var pcm, pErr bytes.Buffer
	piper.Stdout = &pcm
	piper.Stderr = &pErr
	if err := piper.Run(); err != nil {
		return nil, fmt.Errorf("piper: %w: %s", err, strings.TrimSpace(pErr.String()))
	}
	return pcm.Bytes(), nil
}

// runKokoro asks the Kokoro ONNX sidecar to synthesise, returning raw 16-bit
// mono PCM at kokoroRate. Contract: POST {voice,text,speed} → audio/* PCM bytes.
func (s *Synth) runKokoro(ctx context.Context, vm *voiceModel, p styleParams, text string) ([]byte, error) {
	speed := 1.0
	if p.lengthScale > 0 {
		speed = 1.0 / p.lengthScale // meditation (1.45) → ~0.69, slower
	}
	body, _ := json.Marshal(map[string]any{"voice": vm.ID, "text": text, "speed": speed})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.KokoroURL, "/")+"/synthesize", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.httpc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("kokoro sidecar: %w", err)
	}
	defer resp.Body.Close()
	pcm, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("kokoro sidecar: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("kokoro sidecar: status %d: %s", resp.StatusCode, strings.TrimSpace(string(pcm[:min(len(pcm), 200)])))
	}
	return pcm, nil
}

// pcmToOpus encodes raw 16-bit mono PCM at sampleRate to Ogg/Opus via opusenc.
func (s *Synth) pcmToOpus(ctx context.Context, pcm []byte, sampleRate int) ([]byte, error) {
	opus := exec.CommandContext(ctx, s.cfg.OpusEnc,
		"--quiet", "--raw",
		"--raw-rate", strconv.Itoa(sampleRate), "--raw-chan", "1", "--raw-bits", "16",
		"--bitrate", strconv.Itoa(s.cfg.Bitrate), "-", "-")
	opus.Stdin = bytes.NewReader(pcm)
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
