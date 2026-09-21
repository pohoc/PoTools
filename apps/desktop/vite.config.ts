import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const enginePort = process.env.POTOOLS_ENGINE_PORT ?? '8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // The dev proxy buffers SSE, so the event stream dials the engine directly.
    __ENGINE_DIRECT__: JSON.stringify(`http://127.0.0.1:${enginePort}`),
  },
  resolve: {
    alias: {
      core: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: {
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
  clearScreen: false,
  envPrefix: ['VITE_', 'POTOOLS_'],
});
