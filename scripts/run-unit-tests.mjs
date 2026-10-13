#!/usr/bin/env node
/**
 * QA-01: run the repository's Node-native unit tests on whatever Node is
 * actually present, or explain precisely why it cannot.
 *
 * `apps/web/tests/*.test.ts` are `node:test` files written in TypeScript. Node
 * can only load those when it can strip types, and the repo declares
 * `engines.node: "^20.19.0 || >=22.12.0"` — Node 20 has no type stripping at
 * all, so the old `node --test "apps/web/tests/*.test.ts"` script was either a
 * silent no-op (unexpanded glob) or an `ERR_UNKNOWN_FILE_EXTENSION` crash
 * depending on the runtime. No new dependency is justified here (see
 * docs/standards/ENGINEERING.md §2): the test runner that ships with Node is the
 * right tool once the version question is answered honestly.
 *
 * Approach: probe instead of guessing a version table. A throwaway `.ts` file is
 * executed with the candidate runtime settings, and the first setting that works
 * is used for the real run. That covers today's three regimes (22.6–22.17 needs
 * `--experimental-strip-types`, 22.18+ / 23.6+ strips by default) and any future
 * Node without editing this file. `NODE_OPTIONS` carries the flag because the
 * test runner spawns one child process per file, and CLI flags are not the
 * reliable way to reach those children.
 *
 * Usage:
 *   node scripts/run-unit-tests.mjs            # discover + run
 *   node scripts/run-unit-tests.mjs --list     # show discovered files + mode
 *   node scripts/run-unit-tests.mjs -- --test-name-pattern=…   # pass-through
 */
import { spawnSync } from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRIP_FLAG = '--experimental-strip-types';

/** Where unit tests live, and what counts as one. */
const TEST_DIRS = ['apps/web/tests', 'apps/legacy-win7/tests'];
const TEST_FILE = /\.test\.(?:mjs|cjs|js|ts)$/;

/**
 * The TypeScript syntax the runner relies on is erasable-only (annotations,
 * `as const`, `interface`), which is exactly what Node's built-in stripping
 * accepts. Enum/namespace usage would need `--experimental-transform-types`.
 */
const PROBE_SOURCE = 'const answer: number = 42;\nif (answer !== 42) process.exit(3);\n';

function nodeVersion() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return { raw: process.versions.node, major, minor };
}

/** Human-readable state of the declared support window, for error text. */
function supportNotes() {
  let engines = '(unreadable)';
  try {
    engines = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).engines?.node ?? '(unset)';
  } catch {
    // The error text still stands without it; the gate itself never depends on
    // the manifest being readable.
  }
  return [
    'Node support for running .ts files directly:',
    '  * 22.6.0 – 22.17.x : needs --experimental-strip-types',
    '  * 22.18.0+ and 23.6.0+ (and every later line, incl. the 24.x CI uses): on by default',
    '  * 20.x : not available at all — no flag exists',
    `This repository declares engines.node = ${engines} in the root package.json,`,
    'so `pnpm test:unit` and therefore `pnpm check` require Node >= 22.6.',
  ];
}

/** Discover every test file under TEST_DIRS; a missing dir is a finding, not a skip. */
export function discoverTests() {
  const found = [];
  const missing = [];
  for (const dir of TEST_DIRS) {
    const absolute = path.join(root, dir);
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') missing.push(dir);
      else throw error;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && TEST_FILE.test(entry.name)) found.push(path.join(dir, entry.name));
    }
  }
  return { found, missing };
}

/**
 * Run the probe file under each candidate setting and return the first one Node
 * accepts. `env` is merged into the child environment; `undefined` means "no
 * change", i.e. the runtime already strips types.
 */
export function selectRuntimeSetting(spawn) {
  const version = nodeVersion();
  const candidates = [
    { label: 'type stripping is available without flags', env: {} },
    // Preserve an existing NODE_OPTIONS: replacing it would drop flags the caller
    // set (e.g. --max-old-space-size or a --require for a loader).
    {
      label: `type stripping needs NODE_OPTIONS=${STRIP_FLAG}`,
      env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, STRIP_FLAG].filter(Boolean).join(' ') },
    },
  ];
  const attempts = [];
  for (const candidate of candidates) {
    const result = spawn(candidate.env);
    if (result.status === 0) return { ...candidate, version, attempts };
    attempts.push({
      label: candidate.label,
      detail: (result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n')[0],
    });
  }
  return { unsupported: true, version, attempts };
}

function spawnProbe(env, file) {
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return result;
}

function probeTypeStripping(directory) {
  const file = path.join(directory, 'probe.ts');
  writeFileSync(file, PROBE_SOURCE, 'utf8');
  return selectRuntimeSetting((env) => spawnProbe(env, file));
}

export function explainUnsupported(selected) {
  const lines = [
    `[unit] Node ${selected.version.raw} cannot execute the repository's TypeScript unit tests.`,
  ];
  for (const attempt of selected.attempts) {
    lines.push(`[unit]   tried ${attempt.label} -> ${attempt.detail}`);
  }
  lines.push('');
  lines.push(...supportNotes());
  lines.push('');
  lines.push('[unit] Options: switch to Node >= 22.6 (`nvm use`, or the version CI uses');
  lines.push('[unit] from .github/workflows/ci.yml: 24.x), or rewrite the test in plain .mjs.');
  lines.push('[unit] CI runs this gate on every push, so a local skip is never silent.');
  return lines.join('\n');
}

export function main(argv) {
  const passthrough = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];
  const list = argv.includes('--list');
  const { found, missing } = discoverTests();
  if (missing.length > 0) {
    console.error(`[unit] expected test directories are missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (found.length === 0) {
    console.error(`[unit] no test files matched ${TEST_DIRS.join(' or ')}/*.test.*`);
    process.exit(1);
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'potools-unit-probe-'));
  let selected;
  try {
    selected = probeTypeStripping(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (list) {
    for (const file of found) console.log(file);
    console.error(`[unit] ${found.length} file(s), Node ${process.versions.node}`);
    process.exit(0);
  }
  if (selected.unsupported) {
    console.error(explainUnsupported(selected));
    process.exit(1);
  }
  console.log(`[unit] Node ${selected.version.raw} — ${selected.label}; ${found.length} test file(s)`);
  const result = spawnSync(process.execPath, ['--test', ...passthrough, ...found], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, ...selected.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[unit] node --test exited with status ${result.status ?? 'signal ' + result.signal}`);
  }
  process.exit(result.status ?? 1);
}

// Compare realpaths: `import.meta.url` is already resolved, while `argv[1]` keeps
// any symlink in the invocation path. Comparing the unresolved form made this
// guard silently skip `main()` — a gate that runs nothing and exits 0, which is
// exactly the false-green class this script exists to prevent.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
