import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { EngineInfo } from 'core';
import { translate } from '../i18n/index.tsx';

export type AcceptKind = 'pdf' | 'image' | 'raster' | 'portrait' | 'ofd' | 'markdown' | 'any' | 'pdf-image';

/**
 * Checked lazily because the injected IPC globals may not exist while this
 * module is still being evaluated.
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const scope = window as unknown as Record<string, unknown>;
  return Boolean(scope.__TAURI_INTERNALS__ || scope.__TAURI__);
}

export const ACCEPT_EXTENSIONS: Record<AcceptKind, { nameKey: string; extensions: string[]; mime: string }> = {
  pdf: { nameKey: 'accept.pdf', extensions: ['pdf'], mime: 'application/pdf,.pdf' },
  'pdf-image': { nameKey: 'accept.pdfImage', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'], mime: 'application/pdf,image/*' },
  image: {
    nameKey: 'accept.image',
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'],
    mime: 'image/*',
  },
  raster: {
    nameKey: 'accept.raster',
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'],
    mime: '.jpg,.jpeg,.png,.webp,.tif,.tiff',
  },
  portrait: { nameKey: 'accept.portrait', extensions: ['jpg', 'jpeg', 'png', 'webp'], mime: '.jpg,.jpeg,.png,.webp' },
  ofd: { nameKey: 'accept.ofd', extensions: ['ofd'], mime: '.ofd' },
  markdown: {
    nameKey: 'accept.markdown',
    extensions: ['md', 'markdown', 'txt'],
    mime: '.md,.markdown,.txt,text/markdown',
  },
  any: { nameKey: 'accept.any', extensions: [], mime: '*/*' },
};

/**
 * Dialog filter labels are resolved per call: a module-scope table would freeze
 * them at import time, before the i18n provider knows the active locale.
 */
function filtersFor(kind: AcceptKind): { name: string; extensions: string[] }[] {
  const entry = ACCEPT_EXTENSIONS[kind];
  const label = (key: string): string => translate(key);
  const self = [{ name: label(entry.nameKey), extensions: entry.extensions }];
  if (kind === 'pdf-image') {
    return [
      { name: label(ACCEPT_EXTENSIONS.pdf.nameKey), extensions: ACCEPT_EXTENSIONS.pdf.extensions },
      { name: label(ACCEPT_EXTENSIONS.image.nameKey), extensions: ACCEPT_EXTENSIONS.image.extensions },
    ];
  }
  return self;
}

/**
 * Native open dialog; returns absolute paths.
 *
 * The dialog is shown by the Rust host rather than from here: the host can only
 * authorize file access against a gesture the WebView cannot forge, and a dialog
 * driven from JavaScript tells it nothing about what the user chose. See
 * `apps/desktop/src/access.rs`.
 */
export async function nativePickFiles(kind: AcceptKind, multiple: boolean): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('pick_files', { filters: filtersFor(kind), multiple });
}

export async function nativePickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  return (await invoke<string | null>('pick_directory')) ?? null;
}

export async function nativeSaveAs(name: string, bytes?: Uint8Array): Promise<string | null> {
  if (!isTauri()) return null;
  const target = await invoke<string | null>('save_as', { name });
  if (!target) return null;
  if (bytes) {
    await invoke('write_file_bytes', { path: target, bytes: Array.from(bytes) });
  }
  return target;
}

/**
 * Report the configured output/temp directories to the host.
 *
 * These two settings are visible and persisted, so the host grants them without
 * a native gesture — but only for writes (output) and only for the app's own
 * `jobs/`+`inbox/` subdirectories (temp), so pointing a setting at a sensitive
 * directory does not turn into a read capability. Failures are ignored: the
 * operation that follows reports its own, clearer denial.
 */
export async function authorizeOutputDir(dir: string | null | undefined): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('set_output_dir', { dir: dir && dir.trim() ? dir : null });
  } catch {
    /* the write that follows reports the denial */
  }
}

export async function authorizeTempDir(dir: string | null | undefined): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('set_temp_dir', { dir: dir && dir.trim() ? dir : null });
  } catch {
    /* the staging call that follows reports the denial */
  }
}

export async function nativeOpenPath(path: string, reveal = false): Promise<void> {
  if (!isTauri()) return;
  await invoke('open_path', { path, reveal });
}

export interface EngineBridge {
  invoke: <T>(command: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array, options?: { headers: HeadersInit }) => Promise<T>;
  listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
}

export async function engineBridge(): Promise<EngineBridge> {
  return {
    invoke: <T>(command: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array, options?: { headers: HeadersInit }) => invoke<T>(command, args, options),
    listen: async (event, handler) => listen<string>(event, (message) => handler(message.payload)),
  };
}

export type { EngineInfo };
