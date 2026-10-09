import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = fileURLToPath(new URL('../packages/engine/wasm/pkg/', import.meta.url));
const wasmBindgenVersion = '0.2.129';
const wasmBindgen = resolveWasmBindgen();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const version = spawnSync(wasmBindgen, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || !version.stdout.includes(wasmBindgenVersion)) {
  console.error(`Install the matching ABI tool with: cargo install wasm-bindgen-cli --version ${wasmBindgenVersion}`);
  process.exit(1);
}

mkdirSync(output, { recursive: true });
run('rustup', ['run', 'stable', 'cargo', 'build', '--release', '--offline', '--manifest-path', 'packages/engine/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--no-default-features', '--features', 'wasm']);
run(wasmBindgen, ['--target', 'web', '--out-dir', output, '--out-name', 'potools_engine', 'packages/engine/target/wasm32-unknown-unknown/release/potools_engine.wasm']);

function resolveWasmBindgen() {
  const installed = join(homedir(), '.cargo', 'bin', 'wasm-bindgen');
  try {
    accessSync(installed, constants.X_OK);
    return installed;
  } catch {
    return 'wasm-bindgen';
  }
}
