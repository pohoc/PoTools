/**
 * Static artwork source for browser and native package icons.
 * The in-app AppLogo shares the same geometry and uses theme variables.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(resolve(ROOT, 'scripts/package.json'));
const sharp = require('sharp');

const SOURCE = resolve(ROOT, 'apps/web/public/app-icon.svg');
const PUBLIC = resolve(ROOT, 'apps/web/public');
const TAURI = resolve(ROOT, 'apps/desktop');

async function render(svg, size) {
  return sharp(Buffer.from(svg), { density: 300 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// macOS 图标遵循苹果图标网格：1024 画布、内容 824 居中（四周约 10% 透明
// 边距）。满幅图标在 Dock 里会比系统图标明显大一圈。
async function renderMacosIcon(svg) {
  const canvas = 1024;
  const content = 824;
  const artwork = await render(svg, content);
  const inset = Math.round((canvas - content) / 2);
  return sharp(artwork)
    .extend({ top: inset, bottom: inset, left: inset, right: inset, background: { r: 0, g: 0, b: 0, alpha: 0 } })
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
  await writeFile(resolve(TAURI, 'app-icon.png'), await renderMacosIcon(svg));
  console.log('  apps/desktop/app-icon.png (macOS 网格 824/1024)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
