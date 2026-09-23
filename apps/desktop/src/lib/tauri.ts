import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { EngineInfo } from 'core';

export type AcceptKind = 'pdf' | 'image' | 'raster' | 'portrait' | 'ofd' | 'markdown';

/**
 * Checked lazily because the injected IPC globals may not exist while this
 * module is still being evaluated.
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const scope = window as unknown as Record<string, unknown>;
  return Boolean(scope.__TAURI_INTERNALS__ || scope.__TAURI__);
}

export const ACCEPT_EXTENSIONS: Record<AcceptKind, { name: string; extensions: string[]; mime: string }> = {
  pdf: { name: 'PDF', extensions: ['pdf'], mime: 'application/pdf,.pdf' },
  image: {
    name: '图片',
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'],
    mime: 'image/*',
  },
  raster: {
    name: 'JPG、PNG、WebP、TIFF',
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'],
    mime: '.jpg,.jpeg,.png,.webp,.tif,.tiff',
  },
  portrait: { name: '人像照片', extensions: ['jpg', 'jpeg', 'png', 'webp'], mime: '.jpg,.jpeg,.png,.webp' },
  ofd: { name: 'OFD', extensions: ['ofd'], mime: '.ofd' },
  markdown: {
    name: 'Markdown',
    extensions: ['md', 'markdown', 'txt'],
    mime: '.md,.markdown,.txt,text/markdown',
  },
};

const FILTERS: Record<AcceptKind, { name: string; extensions: string[] }[]> = {
  pdf: [{ name: ACCEPT_EXTENSIONS.pdf.name, extensions: ACCEPT_EXTENSIONS.pdf.extensions }],
  image: [{ name: ACCEPT_EXTENSIONS.image.name, extensions: ACCEPT_EXTENSIONS.image.extensions }],
  raster: [{ name: ACCEPT_EXTENSIONS.raster.name, extensions: ACCEPT_EXTENSIONS.raster.extensions }],
  portrait: [{ name: ACCEPT_EXTENSIONS.portrait.name, extensions: ACCEPT_EXTENSIONS.portrait.extensions }],
  ofd: [{ name: ACCEPT_EXTENSIONS.ofd.name, extensions: ACCEPT_EXTENSIONS.ofd.extensions }],
  markdown: [
    { name: ACCEPT_EXTENSIONS.markdown.name, extensions: ACCEPT_EXTENSIONS.markdown.extensions },
  ],
};

/** Native open dialog; returns absolute paths. */
export async function nativePickFiles(kind: AcceptKind, multiple: boolean): Promise<string[]> {
  if (!isTauri()) return [];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ multiple, directory: false, filters: FILTERS[kind] });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function nativePickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

export async function nativeSaveAs(name: string, bytes?: Uint8Array): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const target = await save({ defaultPath: name });
  if (!target) return null;
  if (bytes) {
    await invoke('write_file_bytes', { path: target, bytes: Array.from(bytes) });
  }
  return target;
}

export async function nativeOpenPath(path: string, reveal = false): Promise<void> {
  if (!isTauri()) return;
  await invoke('open_path', { path, reveal });
}

export interface EngineBridge {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
}

export async function engineBridge(): Promise<EngineBridge> {
  return {
    invoke: <T>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
    listen: async (event, handler) => listen<string>(event, (message) => handler(message.payload)),
  };
}

export type { EngineInfo };
