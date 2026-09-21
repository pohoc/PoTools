/**
 * Single source of truth for app artwork: apps/desktop/public/app-icon.svg
 *
 * The desktop icon and the in-app logo are the SAME image on purpose — one
 * rounded-tile artwork feeds favicons, the brand mark and the OS icon set, so
 * they can never drift apart. macOS/Windows receive the squircle art directly.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(resolve(ROOT, 'packages/engine/package.json'));
const sharp = require('sharp');

const SOURCE = resolve(ROOT, 'apps/desktop/public/app-icon.svg');
const PUBLIC = resolve(ROOT, 'apps/desktop/public');
const TAURI = resolve(ROOT, 'apps/desktop/src-tauri');

async function render(svg, size) {
  return sharp(Buffer.from(svg), { density: 300 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function main() {
  const svg = (await readFile(SOURCE)).toString('utf8');
  const targets = [
    [resolve(PUBLIC, 'favicon-32.png'), 32],
    [resolve(PUBLIC, 'apple-touch-icon.png'), 180],
    [resolve(PUBLIC, 'app-icon-512.png'), 512],
    [resolve(TAURI, 'app-icon.png'), 1024],
  ];

  for (const [path, size] of targets) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await render(svg, size));
    console.log(`  ${path.replace(`${ROOT}/`, '')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
