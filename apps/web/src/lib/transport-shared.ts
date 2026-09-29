import type { EngineEvent, EngineInfo, RpcMethodName } from 'core';

export type TransportStatus = 'connecting' | 'ready' | 'offline';

/** Tools that run through the desktop host's native Rust engine command. */
export const RUST_NATIVE_FILE_TOOLS = new Set([
  'image-compress', 'image-resize', 'image-crop', 'image-rotate', 'image-convert', 'image-info', 'image-metadata-clean', 'image-print',
  'image-cutout', 'image-watermark-clean', 'image-id-photo',
  'merge', 'split', 'organize', 'rotate', 'extract-pages', 'delete-pages',
  'metadata', 'crop', 'repair', 'invoice-merge', 'watermark', 'page-numbers', 'header-footer',
  'remove-blank',
]);

export class RpcError extends Error {
  readonly code: string;
  readonly hintKey?: string;

  constructor(code: string, message: string, hintKey?: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.hintKey = hintKey;
  }
}

export interface Transport {
  readonly mode: 'web' | 'tauri';
  status: TransportStatus;
  info: EngineInfo | null;
  start(options?: { concurrency?: number }): Promise<EngineInfo>;
  call<T>(method: RpcMethodName, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onEvent(handler: (event: EngineEvent) => void): () => void;
  onStatus(handler: (status: TransportStatus) => void): () => void;
  stop(): void;
}

export abstract class BaseTransport implements Transport {
  abstract readonly mode: 'web' | 'tauri';
  status: TransportStatus = 'connecting';
  info: EngineInfo | null = null;
  protected eventHandlers = new Set<(event: EngineEvent) => void>();
  protected statusHandlers = new Set<(status: TransportStatus) => void>();

  abstract start(options?: { concurrency?: number }): Promise<EngineInfo>;
  abstract call<T>(method: RpcMethodName, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  abstract stop(): void;

  onEvent(handler: (event: EngineEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatus(handler: (status: TransportStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  protected emitEvent(event: EngineEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }

  protected setStatus(status: TransportStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const source = value.replace(/-/g, '+').replace(/_/g, '/');
  const prefix = source.match(/^[A-Za-z0-9+/]*/)?.[0] ?? '';
  const usable = prefix.length % 4 === 1 ? prefix.slice(0, -1) : prefix;
  const binary = atob(usable.padEnd(Math.ceil(usable.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeMarkupFontRuntimeData(value: Record<string, unknown>): Record<string, unknown> {
  const fonts = value.systemFonts;
  if (!Array.isArray(fonts)) return value;
  return {
    ...value,
    systemFonts: fonts.flatMap((font) => {
      if (!font || typeof font !== 'object') return [];
      const entry = font as { name?: unknown; bytes?: unknown };
      if (typeof entry.name !== 'string' || !(entry.bytes instanceof Uint8Array)) return [];
      return [{ name: entry.name, bytesBase64: encodeBase64(entry.bytes) }];
    }),
  };
}

export function relativeAssetPath(markdownPath: string, source: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    throw new URIError(`Malformed URI in Markdown image path: ${source}`);
  }
  if (!decoded || decoded.startsWith('//') || decoded.startsWith('\\\\') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;

  const separator = markdownPath.lastIndexOf('/') > markdownPath.lastIndexOf('\\') ? '/' : '\\';
  const separatorIndex = markdownPath.lastIndexOf(separator);
  if (separatorIndex < 0) return null;
  const directory = markdownPath.slice(0, separatorIndex + 1);
  const driveRooted = /^[A-Za-z]:\\/.test(markdownPath);
  const rooted = markdownPath.startsWith('/') || driveRooted;
  const joined = `${directory}${decoded.replace(/[\\/]/g, separator)}`;
  const prefix = driveRooted ? joined.slice(0, 3) : rooted ? separator : '';
  const body = driveRooted ? joined.slice(3) : rooted ? joined.slice(1) : joined;
  const parts: string[] = [];
  for (const part of body.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      else if (!rooted) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  return `${prefix}${parts.join(separator)}`;
}

/** Boolean option coercion matching the shared field coercion: true/'true'/1/'1'. */
export function optionTruthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}
