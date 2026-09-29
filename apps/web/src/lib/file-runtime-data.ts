import type { JobRequest } from 'core';
import type { ResolvedInput } from './engine-types.ts';
import { engineBridge } from './tauri.ts';
import { relativeAssetPath } from './transport-shared.ts';

let fontCandidates: Promise<string[]> | null = null;
const fontBytes = new Map<string, Promise<Uint8Array | null>>();

async function readFileBinary(bridge: Awaited<ReturnType<typeof engineBridge>>, path: string): Promise<Uint8Array> {
  const value = await bridge.invoke<ArrayBuffer | Uint8Array | number[]>('read_file_binary', { path });
  if (Array.isArray(value)) return Uint8Array.from(value);
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

export async function systemFontRuntimeData(explicitPath?: string | null): Promise<Record<string, unknown>> {
  try {
    const bridge = await engineBridge();
    fontCandidates ??= bridge.invoke<string[]>('system_font_candidates').catch(() => []);
    const paths = [...new Set([explicitPath, ...(await fontCandidates)].filter((path): path is string => Boolean(path?.trim())))];
    const fonts: Array<{ name: string; bytes: Uint8Array }> = [];
    const maxFontCount = 8;
    const maxFontBytes = 128 * 1024 * 1024;
    let totalFontBytes = 0;
    for (const path of paths) {
      if (fonts.length >= maxFontCount || totalFontBytes >= maxFontBytes) break;
      let pending = fontBytes.get(path);
      if (!pending) {
        pending = readFileBinary(bridge, path)
          .catch(() => null);
        fontBytes.set(path, pending);
      }
      const bytes = await pending;
      if (!bytes?.byteLength || bytes.byteLength > 64 * 1024 * 1024) continue;
      if (totalFontBytes + bytes.byteLength > maxFontBytes) continue;
      fonts.push({ name: path.split(/[\\/]/).pop() ?? path, bytes });
      totalFontBytes += bytes.byteLength;
    }
    return { systemFonts: fonts };
  } catch {
    return { systemFonts: [] };
  }
}

export function markupNeedsUnicodeFont(request: JobRequest, inputs: ResolvedInput[]): boolean {
  const options = request.options ?? {};
  const text = [options.text, options.format, options.header, options.footer, ...inputs.map((input) => input.name)]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /[^\x00-\x7f]/u.test(text);
}

export async function markdownRuntimeData(request: JobRequest, inputs: ResolvedInput[]): Promise<Record<string, unknown>> {
  const bridge = await engineBridge();
  const runtimeData: Record<string, unknown> = {};
  const fontPath = request.globals?.fontPath;
  if (fontPath) {
    try {
      runtimeData.markdownFontBytes = await readFileBinary(bridge, fontPath);
    } catch { /* The compatibility engine will report the established font error. */ }
  }
  const markdownAssets: Record<string, Uint8Array> = {};
  for (const input of inputs) {
    if (!input.path) continue;
    const markdown = new TextDecoder('utf-8').decode(input.bytes);
    const references = [...markdown.matchAll(/^!\[[^\]]*\]\(([^)]+)\)\s*$/gm)];
    for (const reference of references) {
      const source = reference[1]?.trim();
      if (!source) continue;
      const path = relativeAssetPath(input.path, source);
      if (!path) continue;
      try {
        const bytes = await bridge.invoke<ArrayBuffer>('read_file_binary', { path });
        markdownAssets[`${input.id}\0${source}`] = new Uint8Array(bytes);
      } catch { /* Match the original missing-image warning. */ }
    }
  }
  runtimeData.markdownAssets = markdownAssets;
  if (!fontPath) Object.assign(runtimeData, await systemFontRuntimeData());
  return runtimeData;
}

export async function ofdRuntimeData(request: JobRequest): Promise<Record<string, unknown>> {
  const path = String(request.globals?.fontPath ?? '');
  if (path) {
    try {
      const bridge = await engineBridge();
      const bytes = await readFileBinary(bridge, path);
      const fileName = path.split(/[\\/]/).pop() ?? path;
      const dot = fileName.lastIndexOf('.');
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const extension = dot > 0 ? fileName.slice(dot + 1) : '';
      const name = `${stem.replace(/[^\w.-]/g, '_')}${extension ? `.${extension}` : ''}`;
      return { ofdFont: { name, bytes } };
    } catch {
      // Preserve the compatibility engine's configured-font error behavior.
      return {};
    }
  }
  return systemFontRuntimeData();
}
