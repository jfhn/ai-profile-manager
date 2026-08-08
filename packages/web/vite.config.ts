import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

// Dev: vite on :5173 proxies API/WS to the daemon on :4747.
// Prod: `vite build` emits static files the daemon serves itself.
export default defineConfig({
  // svelteTesting resolves svelte's browser entry and cleans the DOM between
  // tests; it no-ops outside vitest, so dev and build are unaffected.
  plugins: [svelte(), svelteTesting()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4747',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://127.0.0.1:4747',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    // Component tests mount real Svelte components, so they need a DOM. The
    // plain logic tests run fine in it too, so there is no per-file override.
    environment: 'jsdom',
  },
});
