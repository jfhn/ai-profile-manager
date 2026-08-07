import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Dev: vite on :5173 proxies API/WS to the daemon on :4747.
// Prod: `vite build` emits static files the daemon serves itself.
export default defineConfig({
  plugins: [svelte()],
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
});
