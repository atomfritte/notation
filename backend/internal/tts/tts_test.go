package tts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fakeBin(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func writeModel(t *testing.T, dir, id string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, id+".onnx"), []byte("model"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".onnx.json"), []byte(`{"audio":{"sample_rate":22050}}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newTestSynth(t *testing.T) *Synth {
	t.Helper()
	bin := t.TempDir()
	models := t.TempDir()
	writeModel(t, models, "de_DE-thorsten-high")
	writeModel(t, models, "en_US-lessac-medium")
	// A bare .onnx without its .json must be ignored.
	if err := os.WriteFile(filepath.Join(models, "broken.onnx"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return New(Config{
		PiperBin: fakeBin(t, bin, "piper"),
		OpusEnc:  fakeBin(t, bin, "opusenc"),
		ModelDir: models,
		CacheDir: t.TempDir(),
	})
}

func TestSynth_DiscoveryAndVoices(t *testing.T) {
	s := newTestSynth(t)
	if !s.Available() {
		t.Fatal("expected available")
	}
	vs := s.Voices()
	if len(vs) != 2 {
		t.Fatalf("voices = %+v, want 2 (broken.onnx without .json ignored)", vs)
	}
	byID := map[string]Voice{}
	for _, v := range vs {
		byID[v.ID] = v
	}
	if byID["de_DE-thorsten-high"].Lang != "de" || byID["en_US-lessac-medium"].Lang != "en" {
		t.Errorf("lang detection: %+v", vs)
	}
	if byID["de_DE-thorsten-high"].Label == "" {
		t.Error("expected a label")
	}
}

func TestSynth_CacheAndKeys(t *testing.T) {
	s := newTestSynth(t)
	var calls int32
	s.synthFn = func(_ context.Context, vm *voiceModel, _ styleParams, text string) ([]byte, error) {
		atomic.AddInt32(&calls, 1)
		return []byte("audio:" + vm.ID + ":" + text), nil
	}
	ctx := context.Background()

	a1, etag, err := s.Get(ctx, "test", "de_DE-thorsten-high", "", "Hallo Welt")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(a1) != "audio:de_DE-thorsten-high:Hallo Welt" || etag == "" {
		t.Fatalf("a1 = %q etag=%q", a1, etag)
	}
	// Cache hit: no new synth.
	if _, _, err := s.Get(ctx, "test", "de_DE-thorsten-high", "", "Hallo Welt"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d after cache hit, want 1", calls)
	}
	// Different voice → different key → new synth.
	if _, _, err := s.Get(ctx, "test", "en_US-lessac-medium", "", "Hallo Welt"); err != nil {
		t.Fatal(err)
	}
	// Different text → new synth.
	if _, _, err := s.Get(ctx, "test", "de_DE-thorsten-high", "", "Andere"); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
	// Empty voice → falls back to the first voice (no error).
	if _, _, err := s.Get(ctx, "test", "", "", "x"); err != nil {
		t.Fatalf("empty voice should fall back: %v", err)
	}
	// Unknown voice → error.
	if _, _, err := s.Get(ctx, "test", "xx_XX-nope", "", "x"); err == nil {
		t.Error("unknown voice should error")
	}
	// Empty text → error.
	if _, _, err := s.Get(ctx, "test", "de_DE-thorsten-high", "", "   "); err == nil {
		t.Error("empty text should error")
	}
}

func TestSynth_GetCached(t *testing.T) {
	s := newTestSynth(t)
	var calls int32
	s.synthFn = func(_ context.Context, vm *voiceModel, _ styleParams, text string) ([]byte, error) {
		atomic.AddInt32(&calls, 1)
		return []byte("audio:" + vm.ID + ":" + text), nil
	}

	// Not synthesised yet → ErrNotCached, and GetCached must NOT synthesise.
	if _, _, err := s.GetCached("test", "de_DE-thorsten-high", "", "Hallo"); !errors.Is(err, ErrNotCached) {
		t.Fatalf("GetCached miss = %v, want ErrNotCached", err)
	}
	if calls != 0 {
		t.Fatalf("GetCached synthesised (%d calls); it must only peek", calls)
	}

	// Prime the cache via a normal Get, then GetCached returns it with no synth.
	if _, _, err := s.Get(context.Background(), "test", "de_DE-thorsten-high", "", "Hallo"); err != nil {
		t.Fatal(err)
	}
	a, etag, err := s.GetCached("test", "de_DE-thorsten-high", "", "Hallo")
	if err != nil {
		t.Fatalf("GetCached hit: %v", err)
	}
	if string(a) != "audio:de_DE-thorsten-high:Hallo" || etag == "" {
		t.Fatalf("GetCached a=%q etag=%q", a, etag)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1 (GetCached must not re-synthesise)", calls)
	}

	// Empty text + unknown voice still error the same way as Get.
	if _, _, err := s.GetCached("test", "de_DE-thorsten-high", "", "  "); !errors.Is(err, ErrEmpty) {
		t.Errorf("empty text = %v, want ErrEmpty", err)
	}
	if _, _, err := s.GetCached("test", "xx_XX-nope", "", "x"); !errors.Is(err, ErrNoVoice) {
		t.Errorf("unknown voice = %v, want ErrNoVoice", err)
	}
}

func TestSynth_Style(t *testing.T) {
	if styleFor("meditation").lengthScale <= 1 || styleFor("meditation").sentenceSilence <= 0 {
		t.Errorf("meditation should be slower with pauses: %+v", styleFor("meditation"))
	}
	if styleFor("meditation.v2").lengthScale != styleFor("meditation").lengthScale {
		t.Error("versioned meditation token must map to the same params")
	}
	// Normal voice keeps Piper's natural pace (no length scaling) but gets a gentle
	// inter-sentence pause so paragraphs don't run together.
	if styleFor("").lengthScale != 0 || styleFor("v2").lengthScale != 0 {
		t.Error("normal style must not slow speech down")
	}
	if styleFor("").sentenceSilence <= 0 || styleFor("v2").sentenceSilence <= 0 {
		t.Error("normal style should still breathe between sentences")
	}
	s := newTestSynth(t)
	var calls int32
	s.synthFn = func(_ context.Context, _ *voiceModel, _ styleParams, _ string) ([]byte, error) {
		atomic.AddInt32(&calls, 1)
		return []byte("a"), nil
	}
	ctx := context.Background()
	_, _, _ = s.Get(ctx, "test", "de_DE-thorsten-high", "", "same text")
	_, _, _ = s.Get(ctx, "test", "de_DE-thorsten-high", "meditation", "same text") // different style → new key
	if calls != 2 {
		t.Errorf("style must be part of the cache key: %d synth calls, want 2", calls)
	}
}

func TestSynth_SingleFlight(t *testing.T) {
	s := newTestSynth(t)
	var calls int32
	release := make(chan struct{})
	s.synthFn = func(_ context.Context, _ *voiceModel, _ styleParams, _ string) ([]byte, error) {
		atomic.AddInt32(&calls, 1)
		<-release // hold the flight open so concurrent callers pile up
		return []byte("x"), nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _, _ = s.Get(context.Background(), "test", "de_DE-thorsten-high", "", "shared") }()
	}
	time.Sleep(30 * time.Millisecond)
	close(release)
	wg.Wait()
	if calls != 1 {
		t.Fatalf("single-flight: %d synth calls for one text, want 1", calls)
	}
}

// A panic in the synth fn must release single-flight waiters, not wedge the key.
func TestSynth_PanicReleasesWaiters(t *testing.T) {
	s := newTestSynth(t)
	enter := make(chan struct{})
	release := make(chan struct{})
	s.synthFn = func(_ context.Context, _ *voiceModel, _ styleParams, _ string) ([]byte, error) {
		close(enter)
		<-release
		panic("boom")
	}
	go func() { defer func() { _ = recover() }(); _, _, _ = s.Get(context.Background(), "test", "de_DE-thorsten-high", "", "x") }()
	<-enter // leader is inside fn, holding the flight open
	waiterDone := make(chan struct{})
	go func() {
		defer func() { _ = recover(); close(waiterDone) }()
		_, _, _ = s.Get(context.Background(), "test", "de_DE-thorsten-high", "", "x")
	}()
	time.Sleep(30 * time.Millisecond) // let the waiter reach wg.Wait()
	close(release)                    // leader panics → deferred Done must wake the waiter
	select {
	case <-waiterDone:
	case <-time.After(2 * time.Second):
		t.Fatal("waiter deadlocked after the leader panicked")
	}
}

func TestSynth_KokoroVoices(t *testing.T) {
	bin := t.TempDir()
	// No piper/models — only opusenc + a Kokoro sidecar URL.
	s := New(Config{
		OpusEnc:      fakeBin(t, bin, "opusenc"),
		ModelDir:     t.TempDir(),
		CacheDir:     t.TempDir(),
		KokoroURL:    "http://127.0.0.1:9/",
		KokoroVoices: []string{"de_DE-martin-kokoro"},
	})
	if !s.Available() {
		t.Fatal("kokoro-only config should be available")
	}
	vs := s.Voices()
	if len(vs) != 1 || vs[0].ID != "de_DE-martin-kokoro" || vs[0].Lang != "de" {
		t.Fatalf("voices = %+v", vs)
	}
	vm, err := s.resolveVoice("de_DE-martin-kokoro")
	if err != nil || vm.engine != engineKokoro || vm.sampleRate != kokoroRate {
		t.Fatalf("vm = %+v err=%v", vm, err)
	}
}

func TestSynth_Unavailable(t *testing.T) {
	s := New(Config{PiperBin: "/nonexistent/piper", OpusEnc: "/nonexistent/opusenc", ModelDir: t.TempDir(), CacheDir: t.TempDir()})
	if s.Available() {
		t.Fatal("expected unavailable without binaries")
	}
	if _, _, err := s.Get(context.Background(), "test", "", "", "x"); err != ErrUnavailable {
		t.Errorf("err = %v, want ErrUnavailable", err)
	}
}
