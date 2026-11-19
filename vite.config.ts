
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const crossOriginIsolation: Plugin = {
  name: 'ourcinema-cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), crossOriginIsolation],
  optimizeDeps: {
    exclude: ['libvlc-wasm'],
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'esnext',
    sourcemap: false,
    // AudioWorklet modules cannot be loaded from a data: URL under the site's
    // script-src policy. Emit libvlc-wasm's worklet as a same-origin asset.
    assetsInlineLimit: (filePath) =>
      filePath.endsWith('audio-worklet.js') ? false : undefined,
  },
});
