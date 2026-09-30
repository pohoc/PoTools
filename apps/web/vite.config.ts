import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';


// 构建时间戳（MMDDHHMM 本地时间）：区分每次打包（dev 下为启动时刻）。
const now = new Date();
const pad2 = (n: number) => String(n).padStart(2, '0');
const buildStamp = `${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}`;

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      core: fileURLToPath(new URL('./src/lib/core-contract.ts', import.meta.url)),
      '@napi-rs/canvas': fileURLToPath(new URL('./src/shims/optional-canvas.ts', import.meta.url)),
      '@napi-rs/canvas-darwin-x64': fileURLToPath(new URL('./src/shims/optional-canvas.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
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
  envPrefix: ['VITE_'],
});
