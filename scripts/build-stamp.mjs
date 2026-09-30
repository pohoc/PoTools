/**
 * Build stamp helpers shared by the web build and the release collector.
 *
 * The stamp is `MMDDHHMM` in Asia/Shanghai. Pinning the zone (instead of using
 * the build host's local time) keeps the artifact filename and the in-app
 * `DISPLAY_VERSION` identical no matter where the build ran.
 *
 * The web build owns stamp generation and records the result in
 * `apps/web/dist/build-info.json`; the release collector reads that file rather
 * than recomputing, so the two can never disagree.
 */
import path from 'node:path';

export const BUILD_TIME_ZONE = 'Asia/Shanghai';

const pad2 = (value) => String(value).padStart(2, '0');

/** `2026-09-30 09:50` in Asia/Shanghai -> `09300950`. */
export function buildStamp(date = new Date()) {
  const local = date.toLocaleString('sv-SE', { timeZone: BUILD_TIME_ZONE });
  return local.replace(/[-: T]/g, '').slice(4, 12);
}

/** ISO-ish timestamp recorded next to the stamp for human inspection. */
export function buildTimestamp(date = new Date()) {
  return date.toLocaleString('sv-SE', { timeZone: BUILD_TIME_ZONE });
}

export const BUILD_INFO_FILENAME = 'build-info.json';

/** Absolute path of the build-info file inside the web dist directory. */
export function buildInfoPath(repoRoot, outDir = 'apps/web/dist') {
  return path.join(repoRoot, outDir, BUILD_INFO_FILENAME);
}

/** `v0.1.0-09300950` — must stay in lockstep with the web `DISPLAY_VERSION`. */
export function displayVersion(version, stamp) {
  return `v${version}-${stamp}`;
}
