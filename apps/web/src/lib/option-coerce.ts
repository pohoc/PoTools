/**
 * Shared option coercion for browser adapters. Two deliberate semantics:
 * `optionNumber` mirrors the engine's slider coercion (loose string parsing +
 * clamp), while `optionJsonNumber`/`optionFlag` mirror the Rust runners'
 * `number()`/`truthy()` reads. Keep the variants distinct — they are not
 * interchangeable.
 */

/** Loose slider coercion: strips unit suffixes from strings, clamps to bounds. */
export function optionNumber(options: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = options[key];
  if (raw === undefined || raw === null) return fallback;
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Strict numeric option: only finite JSON numbers count, everything else falls back. */
export function optionJsonNumber(options: Record<string, unknown>, key: string, fallback: number): number {
  const raw = options[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/** Truthy flag mirroring the Rust runners' `truthy()`: true/'true'/1/'1'. */
export function optionFlag(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = options[key];
  if (raw === undefined || raw === null) return fallback;
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}
