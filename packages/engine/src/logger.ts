/**
 * Engine logging. stdout is reserved for the ndjson protocol in stdio mode,
 * so every log line (and any stray console call from dependencies) goes to stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const runtimeProcess = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined>; stderr?: { write(value: string): unknown } };
}).process;
let threshold = LEVELS[(runtimeProcess?.env?.POTOOLS_LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVELS.info;
let sink: ((level: LogLevel, message: string, data?: unknown) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level] ?? threshold;
}

export function setLogSink(fn: (level: LogLevel, message: string, data?: unknown) => void): void {
  sink = fn;
}

export function log(level: LogLevel, message: string, data?: unknown): void {
  if (LEVELS[level] < threshold) return;
  if (sink) sink(level, message, data);
  const suffix = data === undefined ? '' : ` ${safeJson(data)}`;
  writeLog(`[${level}] ${message}${suffix}\n`, level);
}

export const logger = {
  debug: (m: string, d?: unknown) => log('debug', m, d),
  info: (m: string, d?: unknown) => log('info', m, d),
  warn: (m: string, d?: unknown) => log('warn', m, d),
  error: (m: string, d?: unknown) => log('error', m, d),
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** Keeps third-party code from corrupting the stdio channel. */
export function hijackConsole(): void {
  if (!runtimeProcess?.stderr) return;
  console.log = (...args: unknown[]) => runtimeProcess.stderr?.write(`${format(args)}\n`);
  console.info = console.log;
  console.debug = console.log;
  console.warn = (...args: unknown[]) => process.stderr.write(`${format(args)}\n`);
  console.error = (...args: unknown[]) => process.stderr.write(`${format(args)}\n`);
}

function writeLog(message: string, level: LogLevel): void {
  if (runtimeProcess?.stderr) {
    runtimeProcess.stderr.write(message);
    return;
  }
  const method = level === 'debug' ? 'debug' : level;
  console[method](message.trimEnd());
}

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ');
}
