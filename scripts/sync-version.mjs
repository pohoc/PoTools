#!/usr/bin/env node
/**
 * Version single source of truth.
 *
 * The root `package.json` `version` field is authoritative. Every other
 * manifest that declares a version is derived from it:
 *
 *   - workspace package.json files      (JSON `version`)
 *   - Cargo.toml `[package] version`    (three crates)
 *   - apps/desktop/tauri.conf.json      (JSON `version`, drives bundle naming)
 *
 * Usage:
 *   node scripts/sync-version.mjs           # write drift away
 *   node scripts/sync-version.mjs --check   # fail if any target is out of date
 *
 * `--check` is wired into CI so the manifests cannot silently diverge.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

/** JSON manifests that carry the app version. */
const JSON_TARGETS = [
  'apps/web/package.json',
  'apps/desktop/package.json',
  'packages/engine/package.json',
  'packages/ui/package.json',
  'scripts/package.json',
  'apps/desktop/tauri.conf.json',
];

/** Cargo manifests whose `[package] version` must follow the app version. */
const CARGO_TARGETS = [
  'packages/core/Cargo.toml',
  'packages/engine/Cargo.toml',
  'apps/desktop/Cargo.toml',
];

const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = source.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Root package.json has an unusable version: ${JSON.stringify(version)}`);
}

/** Replaces `version` only inside the `[package]` table, leaving dependency pins alone. */
function replaceCargoPackageVersion(text) {
  const packageHeader = /^\[package\]\s*$/m.exec(text);
  if (!packageHeader) throw new Error('missing [package] table');
  const start = packageHeader.index + packageHeader[0].length;
  const nextTable = /\n\[/.exec(text.slice(start));
  const end = nextTable ? start + nextTable.index : text.length;
  const section = text.slice(start, end);
  if (!/^version\s*=/m.test(section)) throw new Error('missing version key in [package]');
  return text.slice(0, start) + section.replace(/^version\s*=.*$/m, `version = "${version}"`) + text.slice(end);
}

/**
 * Replaces only the top-level `"version"` scalar, leaving all other bytes (and
 * therefore the author's formatting, including inline arrays) untouched.
 */
function replaceJsonTopLevelVersion(text, next) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      // At depth 1 a string starting with `version` followed by `:` is the key.
      if (depth === 1 && text.startsWith('"version"', index)) {
        const colon = text.indexOf(':', index + '"version"'.length);
        const open = text.indexOf('"', colon + 1);
        const close = text.indexOf('"', open + 1);
        if (colon === -1 || open === -1 || close === -1) break;
        return `${text.slice(0, open)}"${next}"${text.slice(close + 1)}`;
      }
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
  }
  throw new Error('could not locate a top-level "version" key');
}

const drifted = [];
const changed = [];

for (const relative of JSON_TARGETS) {
  const absolute = path.join(root, relative);
  const original = await readFile(absolute, 'utf8');
  const current = JSON.parse(original).version;
  if (current === version) continue;
  drifted.push(`${relative}: ${current ?? '(none)'} -> ${version}`);
  if (check) continue;
  const next = replaceJsonTopLevelVersion(original, version);
  // Guard against a malformed edit before it reaches disk.
  if (JSON.parse(next).version !== version) {
    throw new Error(`refusing to write ${relative}: post-edit validation failed`);
  }
  await writeFile(absolute, next);
  changed.push(relative);
}

for (const relative of CARGO_TARGETS) {
  const absolute = path.join(root, relative);
  const original = await readFile(absolute, 'utf8');
  const next = replaceCargoPackageVersion(original);
  if (next === original) continue;
  const current = /^version\s*=\s*"([^"]*)"/m.exec(original)?.[1];
  drifted.push(`${relative}: ${current ?? '(none)'} -> ${version}`);
  if (check) continue;
  await writeFile(absolute, next);
  changed.push(relative);
}

if (drifted.length) {
  if (check) {
    console.error('[version] drifted from root package.json:');
    for (const line of drifted) console.error(`  - ${line}`);
    console.error('Run `pnpm version:sync` to fix.');
    process.exitCode = 1;
  } else {
    console.log(`[version] synced ${version} into ${changed.length} manifest(s):`);
    for (const line of drifted) console.log(`  - ${line}`);
  }
} else {
  console.log(`[version] all manifests already at ${version}`);
}
