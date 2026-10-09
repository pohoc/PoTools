import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BUILD_INFO_FILENAME, buildStamp, buildTimestamp, displayVersion } from '../../scripts/build-stamp.mjs';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(appRoot, '..', '..');

// The root package.json is the version single source of truth (see
// scripts/sync-version.mjs). The build stamp is generated here, once, and
// recorded in dist/build-info.json so the release collector names artifacts
// with exactly the version the app reports about itself.
const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
const stamp = buildStamp();
const display = displayVersion(version, stamp);

const buildInfo = {
  name: 'PoTools',
  version,
  buildStamp: stamp,
  displayVersion: display,
  builtAt: buildTimestamp(),
};

/** Writes the build identity next to the bundle so packaging can consume it. */
function emitBuildInfo(): Plugin {
  return {
    name: 'potools-build-info',
    apply: 'build',
    writeBundle(options) {
      const outDir = options.dir ? path.resolve(appRoot, options.dir) : path.resolve(appRoot, 'dist');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, BUILD_INFO_FILENAME), `${JSON.stringify(buildInfo, null, 2)}\n`);
    },
  };
}

/**
 * Desktop packages ship the whole dist directory, and the bundled Noto Sans SC
 * TTF is browser-only weight there: the desktop host reads system fonts
 * through its own bridge and never fetches `fonts/NotoSansSC-Regular.ttf`.
 * Dropping it from desktop builds trims ~17 MB per installer. Opt in with
 * `POTOLS_WEB_TARGET=desktop` (run-tauri.mjs sets it for packaging).
 */
function dropBrowserOnlyAssets(): Plugin {
  return {
    name: 'potools-drop-browser-only-assets',
    apply: 'build',
    closeBundle() {
      if (process.env.POTOLS_WEB_TARGET !== 'desktop') return;
      const outDir = path.resolve(appRoot, 'dist');
      rmSync(path.join(outDir, 'fonts'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_STAMP__: JSON.stringify(stamp),
    __DISPLAY_VERSION__: JSON.stringify(display),
  },
  plugins: [react(), tailwindcss(), emitBuildInfo(), dropBrowserOnlyAssets()],
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
  },
  worker: {
    format: 'es',
  },
  clearScreen: false,
  envPrefix: ['VITE_'],
});
