/**
 * Phase timing for "it feels slow" reports.
 *
 * Deliberately tiny and always on: the point is that a user can reproduce the
 * slow action, open the console, and hand over numbers instead of an impression.
 * Silence it with `localStorage.setItem('potools.timing', '0')`.
 *
 * Only coarse phases are measured (one line per RPC, one per document parse), so
 * the output stays readable: `PoTools⏱ rpc:page.thumbs 412.7ms {pages: 8, width: 160}`.
 */
const enabled = ((): boolean => {
  try {
    return localStorage.getItem('potools.timing') !== '0';
  } catch {
    return true;
  }
})();

export function now(): number {
  return performance.now();
}

/** Logs the elapsed time since `startedAt`. */
export function mark(label: string, startedAt: number, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  const ms = Math.round((performance.now() - startedAt) * 10) / 10;
  console.info(`PoTools⏱ ${label} ${ms}ms`, extra ?? '');
}

/** Times an async phase and logs it even when the phase rejects. */
export async function timed<T>(
  label: string,
  run: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  if (!enabled) return run();
  const startedAt = now();
  try {
    return await run();
  } finally {
    mark(label, startedAt, extra);
  }
}
