import { loadPdfjs } from './pdfjs.ts';

export interface ContentInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const MAX_PIXELS = 24_000_000;
const MAX_EDGE = 6000;
const INK_THRESHOLD = 246;

function normalizeAngle(angle: number): number {
  return ((Math.round(angle) % 360) + 360) % 360;
}

function toUnrotatedInsets(insets: ContentInsets, rotation: number): ContentInsets {
  switch (normalizeAngle(rotation)) {
    case 90: return { left: insets.top, right: insets.bottom, top: insets.right, bottom: insets.left };
    case 180: return { left: insets.right, right: insets.left, top: insets.bottom, bottom: insets.top };
    case 270: return { left: insets.bottom, right: insets.top, top: insets.left, bottom: insets.right };
    default: return insets;
  }
}

function rasterScale(widthPt: number, heightPt: number): number {
  const width = Math.max(1, widthPt);
  const height = Math.max(1, heightPt);
  let scale = 1;
  scale = Math.min(scale, MAX_EDGE / width, MAX_EDGE / height);
  scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.max(0.05, scale);
}

function measurePixels(pixels: Uint8ClampedArray, width: number, height: number, stride: number, channels: number): ContentInsets | null {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    let left = -1;
    for (let x = 0; x < width; x += 1) {
      const offset = row + x * channels;
      const gray = 0.2126 * pixels[offset]! + 0.7152 * pixels[offset + 1]! + 0.0722 * pixels[offset + 2]!;
      if (gray < INK_THRESHOLD) { left = x; break; }
    }
    if (left < 0) continue;
    let right = left;
    for (let x = width - 1; x > left; x -= 1) {
      const offset = row + x * channels;
      const gray = 0.2126 * pixels[offset]! + 0.7152 * pixels[offset + 1]! + 0.0722 * pixels[offset + 2]!;
      if (gray < INK_THRESHOLD) { right = x; break; }
    }
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (maxX < 0) return null;
  return { left: minX, right: width - maxX - 1, top: minY, bottom: height - maxY - 1 };
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

/** Renders pages in the Web platform adapter and returns unrotated PDF-point insets. */
export async function pdfContentInsets(
  bytes: Uint8Array,
  password?: string | null,
): Promise<Array<ContentInsets | null>> {
  const { getDocument } = await loadPdfjs();
  const loading = getDocument({ data: Uint8Array.from(bytes), password: password ?? undefined, isEvalSupported: false });
  let document: Awaited<typeof loading.promise> | null = null;
  try {
    document = await loading.promise;
    const results: Array<ContentInsets | null> = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = rasterScale(base.width, base.height);
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const canvas = createCanvas(width, height);
        if (!canvas) {
          results.push(null);
          continue;
        }
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
          results.push(null);
          continue;
        }
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        await page.render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
          background: '#ffffff',
        }).promise;
        const image = context.getImageData(0, 0, width, height);
        const visualPixels = measurePixels(image.data, width, height, width * 4, 4);
        if (!visualPixels) {
          results.push(null);
          continue;
        }
        const sx = base.width / width;
        const sy = base.height / height;
        const left = Math.max(0, (visualPixels.left - 1) * sx);
        const top = Math.max(0, (visualPixels.top - 1) * sy);
        const contentWidth = Math.min(base.width - left, (width - visualPixels.right + 1) * sx - left);
        const contentHeight = Math.min(base.height - top, (height - visualPixels.bottom + 1) * sy - top);
        const visual = {
          left,
          bottom: Math.max(0, base.height - top - contentHeight),
          right: Math.max(0, base.width - left - contentWidth),
          top: Math.max(0, top),
        };
        results.push(toUnrotatedInsets(visual, page.rotate));
      } catch {
        results.push(null);
      } finally {
        page.cleanup();
      }
    }
    return results;
  } catch {
    return [];
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
  }
}

export async function contentInsetsRuntimeData(
  inputs: Array<{ id: string; bytes: Uint8Array }>,
  password?: string | null,
): Promise<Record<string, unknown>> {
  const pages: Record<string, Array<ContentInsets | null>> = {};
  for (const input of inputs) pages[input.id] = await pdfContentInsets(input.bytes, password);
  return { contentInsets: pages };
}

/** 36 DPI-capped raster scale used by the remove-blank host implementation. */
function blankRasterScale(widthPt: number, heightPt: number): number {
  const width = Math.max(1, widthPt);
  const height = Math.max(1, heightPt);
  const scale = Math.min(
    0.5,
    MAX_EDGE / width,
    MAX_EDGE / height,
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
  return Math.max(0.05, scale);
}

/**
 * Share of pixels darker than the background threshold, measured with the
 * ITU-R 601 luma coefficients (the Rec.601 luma used by the previous
 * remove-blank implementation). Note the separate bbox path above uses
 * Rec. 709 coefficients on purpose.
 */
function inkRatio(pixels: Uint8ClampedArray, width: number, height: number): number {
  let inked = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const offset = row + x * 4;
      const gray = Math.round(0.299 * pixels[offset]! + 0.587 * pixels[offset + 1]! + 0.114 * pixels[offset + 2]!);
      if (gray < INK_THRESHOLD) inked += 1;
    }
  }
  return width && height ? inked / (width * height) : 0;
}

/**
 * Renders every page and returns one ink ratio per page. The text layer is
 * not consulted. An empty array signals that the document could not be
 * rendered, so blankness cannot be decided for it.
 */
export async function removeBlankInkRatios(
  bytes: Uint8Array,
  password?: string | null,
): Promise<number[]> {
  const { getDocument } = await loadPdfjs();
  const loading = getDocument({ data: Uint8Array.from(bytes), password: password ?? undefined, isEvalSupported: false });
  let document: Awaited<typeof loading.promise> | null = null;
  try {
    document = await loading.promise;
    const results: number[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: blankRasterScale(base.width, base.height) });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const canvas = createCanvas(width, height);
        if (!canvas) {
          return [];
        }
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
          return [];
        }
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        await page.render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
          background: '#ffffff',
        }).promise;
        const image = context.getImageData(0, 0, width, height);
        results.push(inkRatio(image.data, width, height));
      } catch {
        return [];
      } finally {
        page.cleanup();
      }
    }
    return results;
  } catch {
    return [];
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
  }
}

/** Runtime data contract: `removeBlankInk[fileId] = [ink ratio per page]`. */
export async function removeBlankInkRuntimeData(
  inputs: Array<{ id: string; bytes: Uint8Array }>,
  password?: string | null,
): Promise<Record<string, unknown>> {
  const pages: Record<string, number[]> = {};
  for (const input of inputs) pages[input.id] = await removeBlankInkRatios(input.bytes, password);
  return { removeBlankInk: pages };
}
