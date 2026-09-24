import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const architecture = process.argv[2];
const targets = {
  x64: 'x86_64-pc-windows-msvc',
  x86: 'i686-pc-windows-msvc',
};

if (!targets[architecture]) {
  throw new Error('Usage: node scripts/build-windows-embedded.mjs <x64|x86>');
}

const target = targets[architecture];
const sdkRoot = process.env.POTOOLS_NODE_EMBED_SDK_ROOT;
if (!sdkRoot) {
  throw new Error('Set POTOOLS_NODE_EMBED_SDK_ROOT to the directory containing the architecture-specific Node embed SDKs.');
}

const sdk = path.resolve(sdkRoot, target);
const sdkMetadata = JSON.parse(await readFile(path.join(sdk, 'build-metadata.json'), 'utf8'));
if (sdkMetadata.cargoTarget !== target || sdkMetadata.architecture !== architecture) {
  throw new Error(`Node embed SDK metadata does not match ${target}: ${sdk}`);
}
for (const file of ['link-libraries.txt', 'node-version.txt', 'target.txt']) {
  await access(path.join(sdk, file));
}

const run = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${command} ${args.join(' ')} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
  });
});

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
await run(packageManager, ['--filter', '@potools/engine', 'build:embedded'], process.env);
await run(process.execPath, ['scripts/check-embedded-engine.mjs'], process.env);

const bundle = path.join(root, 'packages/engine/dist/engine-embedded.cjs');
await access(bundle);
const env = {
  ...process.env,
  POTOOLS_NODE_EMBED_SDK: sdk,
  POTOOLS_ENGINE_BUNDLE: bundle,
};

const args = [
  'tauri', 'build',
  '--features', 'node-embed',
  '--bundles', 'nsis',
  '--target', target,
  '--config', path.join(root, 'apps/desktop/src-tauri/tauri.windows-embedded.conf.json'),
];
if (process.platform === 'darwin') {
  const sysroot = env.POTOOLS_WIN_MSVC_SYSROOT
    ?? path.join(process.env.HOME ?? '', 'Library/Caches/cargo-xwin/windows-msvc-sysroot/windows-msvc-sysroot');
  env.POTOOLS_WIN_MSVC_SYSROOT = sysroot;
  env.XWIN_CROSS_COMPILER ??= 'clang';
  env.XWIN_MSVC_SYSROOT_DOWNLOAD_URL ??= 'https://ghproxy.net/https://github.com/trcrsired/windows-msvc-sysroot/releases/download/2026-01-16/windows-msvc-sysroot.tar.xz';
  env.PATH = `${path.join(process.env.HOME ?? '', '.cargo/bin')}:${path.join('/usr/local/opt/llvm@22/bin')}:${env.PATH ?? ''}`;
  args.push('--runner', 'cargo-xwin');
}

await run(packageManager, args, env);
if (process.platform === 'win32') {
  await run(process.execPath, ['scripts/check-embedded-engine.mjs'], {
    ...env,
    POTOOLS_EMBEDDED_EXE: path.join(root, 'apps/desktop/src-tauri/target', target, 'release/potools.exe'),
  });
} else {
  console.warn('[windows-embedded] Windows EXE execution check requires a Windows host');
}
console.log(`[windows-embedded] built ${architecture} with statically embedded Node and engine bundle`);
