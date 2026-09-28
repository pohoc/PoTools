/**
 * Merges two single-pass golden captures (worker-only migration phase 0):
 * entries that reproduce byte-for-byte across processes are marked stable;
 * unstable entries keep shape/warnings/error contracts but lose digests,
 * text, and summary so the browser harness only compares stable surface.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';

const [passA, passB, outPath] = process.argv.slice(2);
if (!passA || !passB || !outPath) {
  console.error('usage: node scripts/merge-golden.mjs <pass1.json> <pass2.json> <out.json>');
  process.exit(1);
}

const first = JSON.parse(await readFile(passA, 'utf8'));
const second = JSON.parse(await readFile(passB, 'utf8'));

const entries = {};
let unstable = 0;
let inputRandom = 0;
for (const [key, entry] of Object.entries(first.entries)) {
  const twin = second.entries[key];
  if (twin && JSON.stringify(entry) === JSON.stringify(twin)) {
    entries[key] = { ...entry, stable: true };
    continue;
  }
  if (!twin) {
    // Key absent from pass 2: the harness generated fresh random inputs
    // (aes containers, rsa keys). The captured reply is still replayable
    // byte-for-byte, so keep everything and just flag it.
    inputRandom += 1;
    entries[key] = { ...entry, stable: false, inputRandom: true };
    continue;
  }
  unstable += 1;
  const loose = { ...entry, stable: false };
  delete loose.text;
  delete loose.summary;
  if (Array.isArray(loose.artifacts)) {
    loose.artifacts = loose.artifacts.map(({ sha256: _sha, ...rest }) => rest);
  }
  entries[key] = loose;
}

await writeFile(outPath, `${JSON.stringify({
  capturedAt: first.capturedAt,
  node: first.node,
  engine: first.engine,
  canonicalVersion: first.canonicalVersion ?? 1,
  entries,
  manifest: first.manifest,
}, null, 2)}\n`);
// Consolidate the first pass's runtime fixtures into the canonical fixtures dir.
const { dirname, join, basename } = await import('node:path');
const { cpSync, rmSync, existsSync } = await import('node:fs');
const fixturesSource = join(dirname(passA), `${basename(passA, '.json')}-fixtures`);
const fixturesTarget = join(dirname(outPath), 'fixtures');
rmSync(fixturesTarget, { recursive: true, force: true });
if (existsSync(fixturesSource)) {
  cpSync(fixturesSource, fixturesTarget, { recursive: true });
  console.log(`[golden] fixtures consolidated -> ${fixturesTarget}`);
}
// The per-pass fixture dirs are intermediate artifacts; only the consolidated dir is kept.
for (const pass of [passA, passB]) {
  rmSync(join(dirname(pass), `${basename(pass, '.json')}-fixtures`), { recursive: true, force: true });
}
console.log(`[golden] ${Object.keys(entries).length} entries (${Object.keys(entries).length - unstable - inputRandom} stable, ${inputRandom} input-random, ${unstable} unstable digest-stripped) -> ${outPath}`);
await Promise.all([rm(passA, { force: true }), rm(passB, { force: true })]);
