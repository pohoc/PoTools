import type { JobGlobals } from '@potools/core';
import { EngineError } from '../errors.ts';
import { logger } from '../logger.ts';
import type { Box } from './pdf.ts';

/**
 * Minimal structural view of the MuPDF WASM surface we rely on. The published
 * typings expose these only on subclasses, so the namespace is cast once here.
 */
interface MupdfPixmap {
  getWidth(): number;
  getHeight(): number;
  asPNG(): ArrayBuffer;
  destroy(): void;
}

interface MupdfStructuredText {
  asText(): string;
  asJSON(scale?: number): string;
}

interface MupdfPage {
  getBounds(): [number, number, number, number];
  toPixmap(matrix: unknown, colorspace: unknown, alpha: boolean, useCss: boolean): MupdfPixmap;
  toStructuredText(options?: unknown, area?: unknown): MupdfStructuredText;
}

interface MupdfDocument {
  countPages(): number;
  loadPage(index: number): MupdfPage;
  needsPassword(): number;
  authenticatePassword(password: string): boolean;
  saveToBuffer(options: string): { asUint8Array(): Uint8Array };
  close(): void;
}

interface MupdfNamespace {
  Document: { openDocument(source: Uint8Array, mime: string): MupdfDocument };
  Matrix: { scale(x: number, y: number): unknown };
  ColorSpace: { DeviceRGB: unknown };
}

let modulePromise: Promise<MupdfNamespace | null> | null = null;

export async function getMupdf(): Promise<MupdfNamespace | null> {
  if (!modulePromise) {
    modulePromise = import('mupdf')
      .then((mod) => (mod as unknown as { default?: MupdfNamespace }).default ?? (mod as unknown as MupdfNamespace))
      .catch((error) => {
        logger.error('mupdf failed to load', { error: String(error) });
        modulePromise = null;
        return null;
      });
  }
  return modulePromise;
}

const MAX_PIXELS = 24_000_000;
const MAX_EDGE = 6000;

export interface RenderOptions {
  /** 1-based page number. */
  page: number;
  dpi?: number;
  transparent?: boolean;
}

export interface RasterHandle {
  pageCount: number;
  pageBox(page: number): Box;
  /** PNG buffer; MuPDF encodes PNG natively, other formats go through sharp. */
  renderPng(options: RenderOptions): Uint8Array;
  /** Selectable text layer of a page (empty for scans). */
  pageText(page: number): string;
  /** MuPDF structured-text tree (blocks/lines with fonts and boxes), or null. */
  stext(page: number): unknown | null;
  /** Share of pixels that differ from the background, 0-1. */
  inkRatio(page: number): Promise<number>;
  /** Bounding box of visible content in points, or null when the page is blank. */
  inkBounds(page: number): Promise<{ x: number; y: number; width: number; height: number } | null>;
  close(): void;
}

export async function openRaster(bytes: Uint8Array, globals: JobGlobals = {}): Promise<RasterHandle> {
  const mupdf = await getMupdf();
  if (!mupdf) throw new EngineError('no_rasterizer', 'MuPDF 光栅化器不可用', 'error.noRasterizer');
  let doc: MupdfDocument;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  } catch (error) {
    throw new EngineError('unreadable_file', `MuPDF 无法解析文档：${messageOf(error)}`, 'error.unreadable');
  }
  if (doc.needsPassword() && !doc.authenticatePassword(globals.password ?? '')) {
    doc.close();
    throw new EngineError('encrypted_document', '文档需要密码才能读取', 'error.encrypted');
  }

  const boundsOf = (page: number): [number, number, number, number] => {
    const bounds = doc.loadPage(page - 1).getBounds();
    return bounds?.length === 4 ? bounds : [0, 0, 595, 842];
  };

  const renderPng = ({ page, dpi = 150, transparent = false }: RenderOptions): Uint8Array => {
    const bounds = boundsOf(page);
    const factor = clampFactor(dpi / 72, bounds[2] - bounds[0], bounds[3] - bounds[1]);
    const pixmap = doc.loadPage(page - 1).toPixmap(
      mupdf.Matrix.scale(factor, factor),
      mupdf.ColorSpace.DeviceRGB,
      transparent,
      true,
    );
    try {
      return new Uint8Array(pixmap.asPNG());
    } finally {
      pixmap.destroy();
    }
  };

  const handle: RasterHandle = {
    pageCount: doc.countPages(),
    pageBox(page: number): Box {
      const bounds = boundsOf(page);
      return { width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] };
    },
    renderPng,
    pageText(page: number): string {
      try {
        return doc.loadPage(page - 1).toStructuredText('', '').asText();
      } catch (error) {
        logger.debug('text extraction failed', { page, error: messageOf(error) });
        return '';
      }
    },
    stext(page: number): unknown | null {
      try {
        return JSON.parse(doc.loadPage(page - 1).toStructuredText('', '').asJSON(1));
      } catch (error) {
        logger.debug('structured text failed', { page, error: messageOf(error) });
        return null;
      }
    },
    async inkRatio(page: number): Promise<number> {
      const { getSharp } = await import('./images.ts');
      const sharp = await getSharp();
      const png = renderPng({ page, dpi: 36 });
      if (!sharp) return png.byteLength > 2048 ? 1 : 0;
      const { data } = await sharp(Buffer.from(png), { failOn: 'none' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let inked = 0;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index]! < 246) inked += 1;
      }
      return data.length ? inked / data.length : 0;
    },
    async inkBounds(page: number) {
      const box = handle.pageBox(page);
      const dpi = 72;
      const png = renderPng({ page, dpi });
      const { getSharp } = await import('./images.ts');
      const sharp = await getSharp();
      if (!sharp) return null;
      const { data, info } = await sharp(Buffer.from(png), { failOn: 'none' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // Derive the scale from the actual pixmap: clampFactor may have lowered the DPI.
      const sx = box.width / info.width;
      const sy = box.height / info.height;
      let minX = info.width;
      let maxX = -1;
      let minY = info.height;
      let maxY = -1;
      for (let y = 0; y < info.height; y += 1) {
        const row = y * info.width;
        let left = -1;
        for (let x = 0; x < info.width; x += 1) {
          if (data[row + x]! < 246) {
            left = x;
            break;
          }
        }
        if (left < 0) continue;
        let right = left;
        for (let x = info.width - 1; x > left; x -= 1) {
          if (data[row + x]! < 246) {
            right = x;
            break;
          }
        }
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (left < minX) minX = left;
        if (right > maxX) maxX = right;
      }
      if (maxX < 0) return null;
      // One pixel of slack absorbs anti-aliasing at this resolution.
      const x = Math.max(0, (minX - 1) * sx);
      const top = Math.max(0, (minY - 1) * sy);
      const width = Math.min(box.width - x, (maxX + 2) * sx - x);
      const height = Math.min(box.height - top, (maxY + 2) * sy - top);
      // PDF's origin is bottom-left, the raster's is top-left.
      return { x, y: box.height - top - height, width, height };
    },
    close: () => {
      // Drop references held by the document wrapper; MuPDF owns its WASM
      // document lifecycle and finalizes it through its wrapper.
    },
  };
  return handle;
}

function clampFactor(base: number, widthPt: number, heightPt: number): number {
  const w = Math.max(1, widthPt);
  const h = Math.max(1, heightPt);
  let factor = base;
  factor = Math.min(factor, MAX_EDGE / w, MAX_EDGE / h);
  factor = Math.min(factor, Math.sqrt(MAX_PIXELS / (w * h)));
  return Math.max(0.05, factor);
}

/**
 * Repairs or decrypts a document MuPDF can read but pdf-lib cannot. MuPDF
 * writes plaintext output once authenticated, so an empty-password file
 * becomes editable through this path.
 */
export async function normalizePdfBytes(bytes: Uint8Array, label: string): Promise<Uint8Array> {
  const mupdf = await getMupdf();
  if (!mupdf) return bytes;
  try {
    const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
    if (doc.needsPassword() && !doc.authenticatePassword('')) {
      doc.close();
      return bytes;
    }
    const out = doc.saveToBuffer('compress').asUint8Array();
    doc.close();
    logger.debug('normalized pdf via mupdf', { label, from: bytes.length, to: out.length });
    return out;
  } catch (error) {
    logger.debug('mupdf normalize skipped', { label, error: messageOf(error) });
    return bytes;
  }
}

export async function rasterSelfCheck(): Promise<boolean> {
  const mupdf = await getMupdf();
  return Boolean(mupdf && typeof mupdf.Document?.openDocument === 'function' && mupdf.Matrix?.scale);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
