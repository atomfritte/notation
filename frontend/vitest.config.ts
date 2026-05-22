import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts — that one is wired for the embedded
// build (two HTML entries, /s/ base path, ../backend/web/dist output) and
// pulls in machinery the test runner doesn't need.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
  },
})
