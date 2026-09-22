import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { win32 as winPath } from 'node:path';
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
    'msyh.ttc',
    'msyh.ttf',
    'msyhl.ttc',
    'msyhbd.ttc',
    'simhei.ttf',
    'simsun.ttc',
    'simsun.ttf',
    'simfang.ttf',
    'simkai.ttf',
    'Deng.ttf',
    'Dengb.ttf',
    'Dengl.ttf',
    'msjh.ttc',
    'mingliu.ttc',
  ],
  default: [
    '/usr/share/fonts/truetype/arphic/uming.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ],
};

const CJK_FONT_NAME = /(?:yahei|simsun|simhei|simkai|simfang|dengxian|mingliu|pmingliu|jhenghei|arial unicode|noto.*(?:cjk|sc|tc|jp|kr)|source han|wenquanyi|ar pl|微软雅黑|宋体|黑体|楷体|仿宋|等线|細明體|正黑體)/i;
const WINDOWS_FONT_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
];
const bytesCache = new Map<string, Promise<Uint8Array>>();
type FontFace = ReturnType<typeof fontkitAdaptor.create>;
const fontFacesCache = new Map<string, Promise<FontFace[]>>();
let windowsCandidates: string[] | null = null;
let validatedDefaultFontPath: string | null = null;

function environmentValue(name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(process.env).find(([key]) => key.toLowerCase() === normalized)?.[1];
}

function windowsFontDirectories(): string[] {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const directories = [winPath.join(systemRoot, 'Fonts')];
  if (process.env.LOCALAPPDATA) {
    directories.push(winPath.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  }
  if (process.env.USERPROFILE) {
    directories.push(winPath.join(process.env.USERPROFILE, 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'));
  }
  return [...new Set(directories)];
}

function registeredCjkFontPaths(directories: string[]): string[] {
  const paths: string[] = [];
  for (const key of WINDOWS_FONT_REGISTRY_KEYS) {
    let output: string;
    try {
      output = execFileSync('reg.exe', ['query', key], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }

    for (const line of output.split(/\r?\n/)) {
      const entry = line.match(/^\s*(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/);
      const [, fontName, rawValue] = entry ?? [];
      if (!fontName || !rawValue || !CJK_FONT_NAME.test(fontName)) continue;

      const value = rawValue
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/^\\\\\?\\/, '')
        .replace(/%([^%]+)%/g, (match, variable: string) => environmentValue(variable) ?? match);
      if (winPath.isAbsolute(value)) {
        paths.push(value);
      } else {
        paths.push(...directories.map((directory) => winPath.join(directory, value)));
      }
    }
  }
  return paths;
}

function discoverWindowsFontCandidates(): string[] {
  if (windowsCandidates) return windowsCandidates;
  const directories = windowsFontDirectories();
  const wellKnown = directories.flatMap((directory) =>
    (CANDIDATES.win32 ?? []).map((filename) => winPath.join(directory, filename)),
  );
  windowsCandidates = [...new Set([...wellKnown, ...registeredCjkFontPaths(directories)])];
  return windowsCandidates;
}

export function cjkFontCandidates(): string[] {
  const list = CANDIDATES[process.platform] ?? [];
  const platformCandidates = process.platform === 'win32' ? discoverWindowsFontCandidates() : list;
  const configured = process.env.POTOOLS_FONT ? [process.env.POTOOLS_FONT] : [];
  return [...new Set([
    ...configured,
    ...(validatedDefaultFontPath ? [validatedDefaultFontPath] : []),
    ...platformCandidates,
    ...(CANDIDATES.default ?? []),
  ])];
}

/** First usable font able to render `text`, or null when only Latin is needed. */
export function resolveFontPath(explicit?: string | null): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  if (explicit) logger.warn('configured font path not found', { explicit });
  const env = process.env.POTOOLS_FONT;
  if (env && existsSync(env)) return env;
  if (validatedDefaultFontPath && existsSync(validatedDefaultFontPath)) return validatedDefaultFontPath;
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

function loadFontFaces(path: string): Promise<FontFace[]> {
  let cached = fontFacesCache.get(path);
  if (!cached) {
    cached = loadBytes(path).then((bytes) => {
      const parsed = fontkitAdaptor.create(bytes) as FontFace & { fonts?: FontFace[] };
      return parsed.fonts?.length ? parsed.fonts : [parsed];
    });
    fontFacesCache.set(path, cached);
  }
  return cached;
}

function fontFaceForText(faces: FontFace[], text: string): FontFace {
  const codePoints = [...text]
    .filter((character) => !/\s/u.test(character))
    .map((character) => character.codePointAt(0)!)
    .filter((codePoint, index, all) => all.indexOf(codePoint) === index);
  const face = faces.find((candidate) => codePoints.every((codePoint) => candidate.hasGlyphForCodePoint(codePoint)));
  if (face) return face;

  const missing = codePoints.find((codePoint) => !faces.some((candidate) => candidate.hasGlyphForCodePoint(codePoint)));
  const sample = missing === undefined ? text.slice(0, 20) : String.fromCodePoint(missing);
  throw new Error(`字体不包含所需字形：${sample}`);
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

  const candidates = [...new Set([
    resolveFontPath(globals.fontPath),
    ...cjkFontCandidates(),
  ].filter((path): path is string => Boolean(path)))].filter((path) => existsSync(path));
  if (!candidates.length) {
    throw new EngineError(
      'no_cjk_font',
      `文本 "${text.slice(0, 20)}" 需要嵌入字体，但未找到可用的系统字体文件`,
      'error.noFont',
    );
  }

  let lastError: unknown;
  for (const fontPath of candidates) {
    try {
      const [bytes, faces] = await Promise.all([loadBytes(fontPath), loadFontFaces(fontPath)]);
      const selectedFace = fontFaceForText(faces, text);
      doc.registerFontkit({ create: () => selectedFace });
      const font = await doc.embedFont(bytes, { subset: true });
      if (!globals.fontPath) validatedDefaultFontPath = fontPath;
      return { font, embedded: true, fontPath };
    } catch (error) {
      lastError = error;
      logger.warn('CJK font candidate cannot render requested text', { path: fontPath, error: String(error) });
    }
  }

  throw new EngineError(
    'no_cjk_font',
    `文本 "${text.slice(0, 20)}" 需要嵌入字体，但已找到的系统字体都无法完整显示这些字符${lastError instanceof Error ? `：${lastError.message}` : ''}`,
    'error.noFont',
  );
}

export async function selfCheckFont(): Promise<string | null> {
  try {
    const doc = await PDFDocument.create();
    const result = await textFont(doc, '中文字形检查 漢字', {});
    validatedDefaultFontPath = result.fontPath;
    return result.fontPath;
  } catch (error) {
    logger.warn('font self-check failed', { error: String(error) });
    return null;
  }
}
