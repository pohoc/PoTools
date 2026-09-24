import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const enginePort = process.env.POTOOLS_ENGINE_PORT ?? '8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      core: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@napi-rs/canvas': fileURLToPath(new URL('./src/shims/optional-canvas.ts', import.meta.url)),
      '@napi-rs/canvas-darwin-x64': fileURLToPath(new URL('./src/shims/optional-canvas.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    proxy: {
      '/engine': {
        target: `http://127.0.0.1:${enginePort}`,
        rewrite: (path) => path.replace(/^\/engine/, ''),
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'POTOOLS_'],
});
