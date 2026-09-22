import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const VERSION = '9.4.0';
const sourceRoot = fileURLToPath(new URL('../../../packages/engine/', import.meta.url));
const engineDist = join(sourceRoot, 'dist');
const vendorRoot = join(engineDist, 'documentbuilder');
const manifestPath = join(engineDist, 'documentbuilder-manifest.json');
const platform = process.env.TAURI_ENV_PLATFORM;
const arch = process.env.TAURI_ENV_ARCH;
const asset = {
  'darwin-x86_64': ['onlyoffice-documentbuilder-macos-x86_64.tar.xz', 'd1963741225801697c40d86971f902a08f515cfd055a9fc24d0682c4532535bc'],
  'darwin-aarch64': ['onlyoffice-documentbuilder-macos-arm64.tar.xz', 'c99ee188726f9450e41ca5f198f3c140ebd43727d8c678db701c8c6e3320216b'],
  'windows-x86_64': ['onlyoffice-documentbuilder-windows-x64.zip', '5b509f6d36c810848ffad1e7c8860b36abf05ac757df66a7691ac4c7d3e488e2'],
  'linux-x86_64': ['onlyoffice-documentbuilder-linux-x86_64.tar.xz', '15c02892fea158b76ad343f4d580763c30cbd151a98f0595478d7b6f8599437a'],
  'linux-aarch64': ['onlyoffice-documentbuilder-linux-aarch64.tar.xz', '8756b0b57a4ab4b27608a6b1fbeb13f67670bde0245da166907277821afbeb8e'],
}[[platform, arch].filter(Boolean).join('-')];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function findExecutable(directory) {
  const candidates = platform === 'windows'
    ? new Set(['docbuilder.exe', 'documentbuilder.exe'])
    : new Set(['documentbuilder', 'docbuilder']);
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && candidates.has(entry.name.toLowerCase())) return path;
    }
  }
  return null;
}

async function removeExisting() {
  await rm(vendorRoot, { recursive: true, force: true });
  await rm(manifestPath, { force: true });
}

if (!asset) {
  await removeExisting();
  console.log(`[document-builder] no verified ${VERSION} package for ${platform ?? 'unknown'} ${arch ?? ''}; local Office conversion will be unavailable in this build`);
} else {
  const archivePath = process.env.POTOOLS_DOCUMENTBUILDER_ARCHIVE;
  if (!archivePath) {
    await removeExisting();
    console.log(`[document-builder] skipped: set POTOOLS_DOCUMENTBUILDER_ARCHIVE to the verified ${asset[0]} archive to bundle the local engine`);
  } else {
    const archive = await readFile(archivePath);
    const actualHash = sha256(archive);
    if (actualHash !== asset[1]) {
      throw new Error(`Document Builder SHA-256 mismatch for ${basename(archivePath)}: ${actualHash}`);
    }

    const temp = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'potools-documentbuilder-')));
    const extracted = join(temp, 'extracted');
    const staged = `${vendorRoot}.staging`;
    await mkdir(extracted, { recursive: true });
    await rm(staged, { recursive: true, force: true });
    try {
      execFileSync('tar', ['-xf', archivePath, '-C', extracted], { stdio: 'inherit' });
      const executable = await findExecutable(extracted);
      if (!executable) throw new Error(`Document Builder executable not found in ${basename(archivePath)}`);
      await cp(extracted, staged, { recursive: true, dereference: true });
      const stagedExecutable = join(staged, relative(extracted, executable));
      if (platform !== 'windows') await chmod(stagedExecutable, 0o755);
      await removeExisting();
      await rename(staged, vendorRoot);
      const manifest = {
        version: VERSION,
        license: 'AGPL-3.0-or-commercial; choose and satisfy an applicable distribution route before publishing',
        root: 'documentbuilder',
        executable: relative(extracted, executable).replaceAll('\\', '/'),
      };
      await mkdir(engineDist, { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`[document-builder] staged verified ONLYOFFICE Document Builder ${VERSION}`);
    } finally {
      await rm(staged, { recursive: true, force: true });
      await rm(temp, { recursive: true, force: true });
    }
  }
}
