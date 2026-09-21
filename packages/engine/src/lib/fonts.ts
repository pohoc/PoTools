import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import fontkitAdaptor from '@pdf-lib/fontkit';
import type { JobGlobals } from '@potools/core';
import { EngineError } from '../errors';
import { logger } from '../logger';

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
  ],
  win32: [
    'C:/Windows/Fonts/msyh.ttf',
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/simsun.ttc',
    'C:/Windows/Fonts/simfang.ttf',
  ],
  default: [
    '/usr/share/fonts/truetype/arphic/uming.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ],
};

const bytesCache = new Map<string, Promise<Uint8Array>>();

export function cjkFontCandidates(): string[] {
  const list = CANDIDATES[process.platform] ?? [];
  return [...list, ...(CANDIDATES.default ?? [])];
}

/** First usable font able to render `text`, or null when only Latin is needed. */
export function resolveFontPath(explicit?: string | null): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  if (explicit) logger.warn('configured font path not found', { explicit });
  const env = process.env.POTOOLS_FONT;
  if (env && existsSync(env)) return env;
  return cjkFontCandidates().find((path) => existsSync(path)) ?? null;
}

function loadBytes(path: string): Promise<Uint8Array> {
  let cached = bytesCache.get(path);
  if (!cached) {
    cached = readFile(path).then((buffer) => new Uint8Array(buffer));
    bytesCache.set(path, cached);
  }
  return cached;
}

/**
 * Helvetica is used whenever the string fits WinAnsi, which keeps outputs small.
 * Anything else (CJK, Cyrillic, ...) needs an embedded Unicode font.
 */
export async function textFont(
  doc: PDFDocument,
  text: string,
  globals: JobGlobals = {},
): Promise<{ font: PDFFont; embedded: boolean; fontPath: string | null }> {
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  try {
    helvetica.encodeText(text);
    return { font: helvetica, embedded: false, fontPath: null };
  } catch {
    // falls through to the embedded font below
  }

  const fontPath = resolveFontPath(globals.fontPath);
  if (!fontPath) {
    throw new EngineError(
      'no_cjk_font',
      `文本 "${text.slice(0, 20)}" 需要嵌入字体，但未找到可用的系统字体文件`,
      'error.noFont',
    );
  }
  doc.registerFontkit(fontkitAdaptor);
  const bytes = await loadBytes(fontPath);
  const font = await doc.embedFont(bytes, { subset: true });
  return { font, embedded: true, fontPath };
}

export async function selfCheckFont(): Promise<string | null> {
  const path = resolveFontPath(null);
  if (!path) return null;
  try {
    const doc = await PDFDocument.create();
    await textFont(doc, '中文字形检查 漢字', {});
    return path;
  } catch (error) {
    logger.warn('font self-check failed', { path, error: String(error) });
    return null;
  }
}
