import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vite builds two SPA entries (admin + share) into ../backend/web/dist where
 * the Go binary embeds them. Assets are emitted under dist/_assets/ and the
 * HTML files reference them at /s/_assets/* — the Authelia-bypass path, so
 * unauthenticated share visitors can still load the bundle.
 */
export default defineConfig({
  plugins: [react()],
  base: '/s/',
  build: {
    outDir: '../backend/web/dist',
    emptyOutDir: true,
    assetsDir: '_assets',
    rollupOptions: {
      input: {
        admin: 'index.admin.html',
        share: 'index.share.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/s/api': 'http://localhost:8080',
      '/mcp': 'http://localhost:8080',
    },
  },
})
