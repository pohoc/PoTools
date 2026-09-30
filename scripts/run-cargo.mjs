#!/usr/bin/env node
/**
 * Runs one cargo command across every Rust crate in the repository.
 *
 * The three crates are separate Cargo packages (there is no workspace root yet),
 * so a plain `cargo test` at the repository root does nothing. CI and the root
 * `package.json` scripts use this helper instead of shell loops so the crate
 * list lives in exactly one place.
 *
 * Usage:
 *   node scripts/run-cargo.mjs <cargo args...>
 *
 * Environment:
 *   POTOOLS_CARGO_OFFLINE=1   add `--offline` (useful on a warm local cache)
 *   POTOOLS_CARGO_CRATES=a,b  override the crate list
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CRATES = ['packages/core', 'packages/engine', 'apps/desktop'];

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run-cargo.mjs <cargo args...>');
  process.exit(2);
}

const crates = (process.env.POTOOLS_CARGO_CRATES ?? DEFAULT_CRATES.join(','))
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const offline = process.env.POTOOLS_CARGO_OFFLINE === '1' ? ['--offline'] : [];

// Two placement rules for the injected flags:
//  * `--offline` is a cargo flag, so it has to stay on cargo's side of the `--`
//    separator; after the separator it would be handed to rustc/clippy-driver.
//  * `cargo fmt` does not accept `--offline` at all (it forwards its arguments
//    to rustfmt), so it only ever gets the caller's own arguments.
const separator = args.indexOf('--');
const forwardOffline = offline.length > 0 && args[0] !== 'fmt';
const flagArgs = forwardOffline ? offline : [];
const cargoArgs = separator === -1
  ? [...args, ...flagArgs]
  : [...args.slice(0, separator), ...flagArgs, ...args.slice(separator)];

const failures = [];
for (const crate of crates) {
  const cwd = path.join(root, crate);
  console.log(`\n===== cargo ${cargoArgs.join(' ')} (${crate}) =====`);
  const result = spawnSync('cargo', cargoArgs, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) failures.push(crate);
}

if (failures.length) {
  console.error(`\n[rust] cargo ${cargoArgs.join(' ')} failed in: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\n[rust] cargo ${cargoArgs.join(' ')} passed in all ${crates.length} crate(s)`);
