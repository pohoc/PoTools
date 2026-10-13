#!/usr/bin/env node
/**
 * REL-01: derive the release version that artifact names and the updater
 * manifest are built from.
 *
 * `.github/workflows/release.yml` used to spell `PoTools_0.1.0_*` in eleven `mv`
 * targets and three manifest URLs, so any version bump failed only at the very
 * last step of the pipeline — after every platform had already built. The version
 * now comes from the tag (`v0.2.0` -> `0.2.0`), and this script is what makes the
 * derivation safe to use: the tag has to look like a release tag AND agree with
 * the root `package.json`, because Tauri and electron-builder name their bundles
 * from the synced manifests, not from the tag.
 *
 * Manifest-to-manifest consistency is deliberately NOT re-implemented here:
 * `scripts/sync-version.mjs --check` (`pnpm version:check`) owns that, and the
 * release workflow runs it in `prepare`. This script only closes the remaining
 * gap, tag <-> root version.
 *
 * Usage:
 *   node scripts/release-version.mjs <tag>          # prints the version
 *   node scripts/release-version.mjs <tag> --json   # { tag, version, rootVersion }
 * Exit: 0 on success, 1 with the reason.
 */
import {readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * @param {string} tag a release tag such as `v0.2.0` (a bare `0.2.0` also works)
 * @returns {{ version?: string, rootVersion?: string, error?: string }}
 */
export function resolveReleaseVersion(tag) {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (!SEMVER.test(version)) {
    return {
      error:
        `tag '${tag}' is not v<X>.<Y>.<Z>, so no artifact name can be derived from it. ` +
        'Release tags look like v0.2.0.',
    };
  }
  const manifest = path.join(root, 'package.json');
  let rootVersion;
  try {
    rootVersion = JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch (error) {
    return { error: `cannot read the root version from ${manifest}: ${error.message}` };
  }
  if (typeof rootVersion !== 'string' || rootVersion === '') {
    return { error: `root package.json has no usable version: ${JSON.stringify(rootVersion)}` };
  }
  if (rootVersion !== version) {
    return {
      error:
        `tag '${tag}' claims ${version} but the root package.json is at ${rootVersion}. ` +
        'Tauri and electron-builder name their bundles from the manifests, so publish would not ' +
        'find the expected files. Either run `pnpm version:sync`, commit and re-tag, or tag the ' +
        'version the tree already carries.',
    };
  }
  return { version, rootVersion };
}

function fail(message) {
  console.error(`[release-version] ${message}`);
  process.exit(1);
}

export function main(argv) {
  const asJson = argv.includes('--json');
  const tag = argv.find((entry) => !entry.startsWith('--'));
  if (!tag) {
    fail('usage: node scripts/release-version.mjs <tag> [--json]  (example: v0.2.0)');
  }
  const result = resolveReleaseVersion(tag);
  if (result.error) fail(result.error);
  if (asJson) {
    console.log(JSON.stringify({ tag, version: result.version, rootVersion: result.rootVersion }));
  } else {
    console.log(result.version);
  }
  console.error(`[release-version] ${tag} -> ${result.version} (root package.json agrees)`);
  return result;
}

// Compare realpaths: `import.meta.url` is already resolved, while `argv[1]` keeps
// any symlink in the invocation path. Comparing the unresolved form made this
// guard silently skip `main()` — a gate that runs nothing and exits 0, which is
// exactly the false-green class this script exists to prevent.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
