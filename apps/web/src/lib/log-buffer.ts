/**
 * In-app log buffer.
 *
 * The packaged app has no WebView devtools, so a failure there used to leave
 * nothing to inspect beyond a one-line error card. This captures what the console
 * would have shown — console calls, uncaught errors, rejections — plus the
 * `PoTools⏱` timing marks, and keeps it in a bounded ring buffer that the log
 * panel renders.
 *
 * Formatting is deliberately paranoid: the buffers that flow through this app can
 * be tens of megabytes (a 47 MB scan once cost ~6 s per request when it was
 * turned into a string), so binary payloads are summarised and text is truncated
 * rather than serialised.
 */
const MAX_ENTRIES = 500;
const MAX_TEXT = 400;
const MAX_DETAIL = 4000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  seq: number;
  at: number;
  level: LogLevel;
  text: string;
  detail?: string;
}

/**
 * Reassigned, never mutated: `useSyncExternalStore` compares snapshots by
 * reference, so an in-place `entries.length = 0` (the first version of "clear")
 * left the panel rendering the stale array forever.
 */
let entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let seq = 0;
let installed = false;
let notifying = false;
let queued = false;

/**
 * Escape hatch: the panel is a diagnostic and must never be load-bearing.
 * `localStorage.setItem('potools.log', '0')` turns capture off completely.
 */
const enabled = ((): boolean => {
  try {
    return localStorage.getItem('potools.log') !== '0';
  } catch {
    return true;
  }
})();

function notify(): void {
  // Reentrancy guard: a listener that itself logs (directly or through a render)
  // must not recurse, which is what turned a burst of warnings into a freeze.
  if (notifying) return;
  notifying = true;
  try {
    for (const listener of listeners) listener();
  } finally {
    notifying = false;
  }
}

function scheduleNotify(): void {
  if (queued) return;
  queued = true;
  // Coalesce a burst — a failing render can log hundreds of lines — into a single
  // update instead of one re-render per line.
  const run = () => {
    queued = false;
    notify();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function binaryLabel(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
  const name = value.constructor?.name ?? 'Binary';
  if (bytes >= 1024 * 1024) return `<${name} ${(bytes / 1024 / 1024).toFixed(1)} MB>`;
  if (bytes >= 1024) return `<${name} ${(bytes / 1024).toFixed(1)} KB>`;
  return `<${name} ${bytes} B>`;
}

/** Renders one log argument without ever stringifying a large payload. */
function format(value: unknown): string {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return binaryLabel(value);
  if (typeof File !== 'undefined' && value instanceof File) {
    return `<File "${value.name}" ${(value.size / 1024 / 1024).toFixed(1)} MB>`;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map(format).join(', ');
    return value.length > 20 ? `[${head}, … ${value.length - 20} more]` : `[${head}]`;
  }
  try {
    return JSON.stringify(value, (_key, nested: unknown) => {
      if (nested instanceof ArrayBuffer || ArrayBuffer.isView(nested)) return binaryLabel(nested);
      return nested;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

function stackOf(value: unknown): string | undefined {
  if (value instanceof Error && value.stack) return value.stack.slice(0, MAX_DETAIL);
  return undefined;
}

function push(level: LogLevel, args: unknown[], cause?: unknown): void {
  const text = args.map(format).join(' ');
  const detail = stackOf(cause) ?? stackOf(args.find((arg) => arg instanceof Error));
  seq += 1;
  const entry = { seq, at: Date.now(), level, text, ...(detail ? { detail } : {}) };
  // Bounded: drop from the front so a long session cannot grow without limit.
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1), entry] : [...entries, entry];
  scheduleNotify();
}

/** Mirrors console output into the buffer, keeping the original behaviour. */
export function installLogCapture(): void {
  if (!enabled || installed || typeof window === 'undefined') return;
  installed = true;
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      push(level, args);
      original(...args);
    };
  }
  window.addEventListener('error', (event) => {
    push('error', [`Uncaught: ${event.message}`], event.error);
  });
  window.addEventListener('unhandledrejection', (event) => {
    push('error', [`Unhandled rejection: ${format(event.reason)}`], event.reason);
  });
}

export function logEntries(): readonly LogEntry[] {
  return entries;
}

export function subscribeLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearLog(): void {
  entries = [];
  scheduleNotify();
}

/** Plain text for the "copy" button, newest last. */
export function exportLog(): string {
  return entries
    .map((entry) => {
      const time = new Date(entry.at).toISOString().slice(11, 23);
      const line = `${time} [${entry.level}] ${entry.text}`;
      return entry.detail ? `${line}\n${entry.detail}` : line;
    })
    .join('\n');
}
