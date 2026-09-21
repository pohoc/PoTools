/** Page range parsing shared by the option inputs and the engine. */

export interface ResolvedPage {
  /** 1-based source page. */
  page: number;
}

const ALL_TOKENS = new Set(['all', '*', '全部', '所有']);

export class PageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRangeError';
  }
}

/**
 * Parses `"1-3, 5, 8-"` or `"odd" / "even"` into 1-based page numbers.
 * A trailing `-` means "until the last page"; an open range never throws.
 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const text = String(input ?? '').trim();
  if (!text || ALL_TOKENS.has(text.toLowerCase())) {
    return range(1, pageCount);
  }
  const lowered = text.toLowerCase();
  if (lowered === 'odd' || lowered === '奇数') return step(1, pageCount, 2);
  if (lowered === 'even' || lowered === '偶数') return step(2, pageCount, 2);

  const out: number[] = [];
  for (const chunk of text.split(/[,;，、]+/)) {
    const token = chunk.trim();
    if (!token) continue;
    const dash = token.includes('-') ? token.split('-') : null;
    if (dash && dash.length === 2) {
      const from = parseSide(dash[0] ?? '', 1, pageCount);
      const to = parseSide(dash[1] ?? '', pageCount, pageCount);
      if (from > to) throw new PageRangeError(`invalid range: ${token}`);
      for (let i = from; i <= to; i += 1) out.push(i);
      continue;
    }
    if (/^\d+$/.test(token)) {
      const single = Number(token);
      // A bare page number must exist; only open ranges clamp to the end.
      if (!Number.isInteger(single) || single < 1 || single > pageCount) {
        throw new PageRangeError(`page ${token} is out of range (1-${pageCount})`);
      }
      out.push(single);
      continue;
    }
    throw new PageRangeError(`invalid page token: ${token}`);
  }
  if (!out.length) throw new PageRangeError('empty page range');
  return out;
}

function parseSide(raw: string, fallback: number, pageCount: number): number {
  const v = raw.trim();
  if (!v) return fallback;
  return clamp(Number(v), 1, pageCount, v);
}

function clamp(value: number, min: number, max: number, token: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new PageRangeError(`invalid page number: ${token}`);
  }
  return Math.min(value, max);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

function step(start: number, pageCount: number, by: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= pageCount; i += by) out.push(i);
  return out;
}

/** Compact `"1-3,7,10-12"` from a sorted page list — used to label outputs. */
export function formatPageRanges(pages: number[]): string {
  if (!pages.length) return '';
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let from = sorted[0] as number;
  let prev = from;
  for (const p of sorted.slice(1)) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(from === prev ? `${from}` : `${from}-${prev}`);
    from = p;
    prev = p;
  }
  parts.push(from === prev ? `${from}` : `${from}-${prev}`);
  return parts.join(',');
}

export function isValidPageRanges(input: string): boolean {
  try {
    parsePageRanges(input, Number.MAX_SAFE_INTEGER);
    return true;
  } catch {
    return false;
  }
}
