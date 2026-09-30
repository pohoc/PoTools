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

const failures = [];
for (const crate of crates) {
  const cwd = path.join(root, crate);
  console.log(`\n===== cargo ${args.join(' ')} (${crate}) =====`);
  const result = spawnSync('cargo', [...args, ...offline], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) failures.push(crate);
}

if (failures.length) {
  console.error(`\n[rust] cargo ${args.join(' ')} failed in: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\n[rust] cargo ${args.join(' ')} passed in all ${crates.length} crate(s)`);
