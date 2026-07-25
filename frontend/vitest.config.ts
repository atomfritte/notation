import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts — that one is wired for the embedded
// build (two HTML entries, /s/ base path, ../backend/web/dist output) and
// pulls in machinery the test runner doesn't need.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
    // The crypto suites run real Argon2id (64 MiB, t=3) — deliberately slow, and
    // slower still when several worker threads hit it at once. The 5s default
    // makes those specs flake on a loaded machine; the work itself takes ~1-8s.
    testTimeout: 30_000,
  },
})
