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

/** `2026-09-30 09:50` in Asia/Shanghai -> `09300950`. */
export function buildStamp(date = new Date()) {
  // 多平台打包链（run-tauri.mjs）在链入口计算一次并经环境变量下发：四个
  // 目标跨数分钟构建，各自取当下时间会把同一次发布的产物命名得五花八门。
  if (process.env.POTOOLS_BUILD_STAMP) return process.env.POTOOLS_BUILD_STAMP;
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
