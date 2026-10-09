//! Root `pnpm tauri` entry.
//!
//! `pnpm tauri build` chains the packagable targets **for the host it runs
//! on**, reusing the exact recipes of the single-target `package:*` scripts
//! and collecting each release artifact with its version stamp:
//!
//! - macOS host:   x64 DMG → Windows x64/x86 NSIS (cargo-xwin cross) →
//!                 Win7 legacy shell (Electron 22) → Linux via the Docker
//!                 builder (scripts/run-linux-build.sh, Debian 12 recipe).
//! - Windows host: same minus the DMG.
//! - Linux host:   native packages for the host architecture
//!                 (scripts/package-linux.mjs; WebKitGTK and the target arch
//!                 must match the host — the repo's own assertion enforces it,
//!                 cross-building AppImage/DEB/RPM is not supported).
//!
//! Windows cross-compilation (from this Mac) needs two host tools beyond the
//! Rust targets: `cargo-xwin` (runner for the MSVC CRT) and `llvm-rc`
//! (embed_resource compiles the .exe's version/icon resource with it). The
//! LLVM here comes from an extracted brew bottle because `brew install llvm`
//! is gated on a Command Line Tools update that requires a GUI confirm.
//!
//! Single-target builds stay available through `pnpm package:macos` /
//! `package:windows:x64` / `package:windows:x86` / `package:linux` /
//! `package:win7`.
//!
//! Everything else — `dev`, `icon`, `info`, … — forwards to the Tauri CLI
//! untouched.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildStamp } from './build-stamp.mjs';

const args = process.argv.slice(2);

/** 版本戳在链入口计算一次并经环境变量下发：四个目标跨数十分钟构建，各自取当下时间会把同一次发布的产物命名得五花八门（build-stamp.mjs 认这个变量）。 */
const CHAIN_STAMP = buildStamp();
process.env.POTOOLS_BUILD_STAMP = CHAIN_STAMP;

const LLVM_BIN = join(homedir(), 'tools', 'llvm22', 'llvm@22', '22.1.8', 'bin');
const ZSTD_LIB = '/usr/local/opt/zstd/lib';

/** Extra environment for the Windows cross builds: llvm-rc on PATH plus the
 *  zstd dylib its bundled LLVM links against. */
const WIN_ENV = existsSync(join(LLVM_BIN, 'llvm-rc'))
  ? {
      PATH: `${LLVM_BIN}:${process.env.PATH}`,
      DYLD_FALLBACK_LIBRARY_PATH: [ZSTD_LIB, process.env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':'),
      XWIN_ARCH: 'x86,x86_64',
    }
  : {};

/** Desktop packages drop browser-only assets (the bundled CJK TTF) — see
 *  vite.config.ts `dropBrowserOnlyAssets`. */
const DESKTOP_ENV = { POTOLS_WEB_TARGET: 'desktop' };

/** Updater signing key for local packaging (CI reads the GitHub secret).
 *  Created once via `pnpm tauri signer generate -w ~/.tauri/potools-updater.key`
 *  with an empty password. Without it, `createUpdaterArtifacts` fails the bundle. */
const UPDATER_KEY = join(homedir(), '.tauri', 'potools-updater.key');
const UPDATER_ENV = existsSync(UPDATER_KEY)
  ? { TAURI_SIGNING_PRIVATE_KEY: readFileSync(UPDATER_KEY, 'utf8') }
  : {};
if (!UPDATER_ENV.TAURI_SIGNING_PRIVATE_KEY) {
  console.error('[tauri] 注意：未找到 ~/.tauri/potools-updater.key，updater 产物将无法签名');
}


function run(command, argv, label, env = {}) {
  console.error(`\n[tauri] ==> ${label}: ${command} ${argv.join(' ')} [stamp ${CHAIN_STAMP}]`);
  const result = spawnSync(command, argv, { stdio: 'inherit', env: { ...process.env, POTOLS_BUILD_STAMP: CHAIN_STAMP, ...UPDATER_ENV, ...env } });
  if ((result.status ?? 1) !== 0) {
    console.error(`[tauri] step failed (${label}), aborting the chain`);
    process.exit(result.status ?? 1);
  }
}

if (args[0] !== 'build') {
  run('pnpm', ['--filter', '@potools/desktop', 'tauri', ...args], 'tauri cli');
  process.exit(0);
}

const extra = args.slice(1);
const desktop = ['--filter', '@potools/desktop', 'tauri', 'build'];
const winRunner = ['--runner', 'cargo-xwin'];
const isDarwin = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

const steps = [
  ['pnpm', ['version:check'], 'version check'],
  ['pnpm', ['icons'], 'regenerate icons'],
];
if (isDarwin) {
  steps.push(
    ['pnpm', [...desktop, '--bundles', 'dmg', '--target', 'x86_64-apple-darwin', ...extra], 'macOS x64 DMG', DESKTOP_ENV],
    ['node', ['scripts/collect-release-artifacts.mjs', 'macos'], 'collect macOS artifacts'],
  );
}
if (!isLinux) {
  steps.push(
    ['pnpm', [...desktop, ...winRunner, '--bundles', 'nsis', '--target', 'x86_64-pc-windows-msvc', ...extra], 'Windows x64 NSIS', { ...WIN_ENV, ...DESKTOP_ENV }],
    ['node', ['scripts/collect-release-artifacts.mjs', 'windows', 'x64'], 'collect Windows x64 artifacts', WIN_ENV],
    ['pnpm', [...desktop, ...winRunner, '--bundles', 'nsis', '--target', 'i686-pc-windows-msvc', ...extra], 'Windows x86 NSIS', { ...WIN_ENV, ...DESKTOP_ENV }],
    ['node', ['scripts/collect-release-artifacts.mjs', 'windows', 'x86'], 'collect Windows x86 artifacts', WIN_ENV],
    // Windows 7 legacy shell (Electron 22, browser-mode feature set). Must NOT
    // inherit POTOLS_WEB_TARGET=desktop: it needs the bundled font + OCR models.
    ['pnpm', ['package:win7'], 'Windows 7 installer (Electron 22 legacy shell)'],
    ['node', ['scripts/collect-release-artifacts.mjs', 'win7'], 'collect Windows 7 artifacts'],
  );
}
if (isLinux) {
  steps.push(['node', ['scripts/package-linux.mjs'], 'Linux native packages (appimage/deb/rpm, host arch)', DESKTOP_ENV]);
}

console.error('[tauri] build: chaining the packagable targets for this host');
for (const [command, argv, label, env] of steps) {
  run(command, argv, label, env);
}

// Linux on macOS/Windows hosts goes through the Docker builder container.
const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!isLinux && dockerOk) {
  // 容器网络经宿主代理，抖动时自动重试（最多 6 次，间隔 60 秒）。
  // 宿主网络对镜像源偶发抖动：自动重试（最多 3 次，间隔 60 秒）。
  run('bash', ['-c', 'for i in 1 2 3; do bash scripts/run-linux-build.sh && exit 0; echo "[retry] linux attempt failed, retry in 60s"; sleep 60; done; exit 1'], 'Linux x64 packages (appimage/deb/rpm via docker, auto-retry)');
} else if (!isLinux) {
  console.error('[tauri] Linux packages skipped: Docker daemon unavailable.');
}

console.error('\n[tauri] all packagable targets built');
