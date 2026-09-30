#!/usr/bin/env node
/**
 * Compiles the engine for the browser (wasm32) with native services disabled.
 *
 * This mirrors what `scripts/build-engine-wasm.mjs` does, so the compile check
 * catches wasm-only breakage without running the full wasm-bindgen pipeline.
 *
 * The command is routed through `rustup run stable cargo` on purpose: a distro
 * or Homebrew `cargo` on PATH does not resolve the rustup toolchain's wasm
 * standard library, and fails with a misleading "can't find crate for `core`".
 *
 * Environment:
 *   POTOOLS_CARGO_OFFLINE=1   add `--offline`
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.env.POTOOLS_CARGO_OFFLINE === '1' ? ['--offline'] : [];

const args = [
  'run',
  'stable',
  'cargo',
  'check',
  '--manifest-path',
  path.join(root, 'packages/engine/Cargo.toml'),
  '--no-default-features',
  '--features',
  'wasm',
  '--target',
  'wasm32-unknown-unknown',
  ...offline,
];

console.log(`\n===== rustup ${args.join(' ')} =====`);
const result = spawnSync('rustup', args, { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error('[rust] could not run rustup; install it and run `rustup target add wasm32-unknown-unknown`');
  throw result.error;
}
if (result.status !== 0) {
  console.error('\n[rust] engine does not compile for wasm32-unknown-unknown');
  process.exit(1);
}
console.log('\n[rust] engine compiles for wasm32-unknown-unknown');
