import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { pdfImageRects } from '../../../../packages/engine/wasm/pkg/potools_engine.js';
import type { JobRequest } from 'core';
import type { ResolvedInput } from './engine-types.ts';
import { recognizeImageLines } from './ocr-recognition.ts';
import { optionFlag, optionJsonNumber } from './option-coerce.ts';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_EDGE = 6000;
const MAX_PIXELS = 24_000_000;

/** Conversion tools whose Rust runners consume adapter-built runtimeData. */
export const CONVERSION_TOOLS = new Set([
  'pdf-to-csv',
  'pdf-to-rtf',
  'pdf-to-excel',
  'pdf-to-markdown',
  'pdf-to-epub',
  'pdf-to-html',
  'pdf-to-word',
  'pdf-to-ppt',
  'pdf-to-ofd',
]);

export type ConvertPhase = 'prepare' | 'render';

export type ConvertProgressFn = (percent: number, phase: ConvertPhase) => void;

/** Failure with a JobError code surfaced verbatim in the job snapshot. */
class JobFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
  }
}

/** One PDF.js text run in visual-space points (packages/engine model.rs contract). */
interface TextRun {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  font: string;
  weight: string;
  style: string;
}

/** One page of runs; width/height are the visual (post-rotation) page size. */
interface TextPage {
  page: number;
  width: number;
  height: number;
  runs: TextRun[];
}

/** Cropped page region PNG; `index` is the 0-based rect index of that page. */
interface ImagePlacement {
  page: number;
  index: number;
  widthPt: number;
  heightPt: number;
  bytes: Uint8Array;
}

/** Full-page PNG render at a specific dpi. */
interface PageImage {
  page: number;
  dpi: number;
  bytes: Uint8Array;
}

/** OCR fallback text for one zero-run page (lines joined with '\n'). */
interface OcrPage {
  page: number;
  text: string;
}

/** One page's image placement rects from the `pdfImageRects` export. */
interface RectPage {
  page: number;
  width: number;
  height: number;
  rects: number[][];
}

/** What the current conversion tool needs beyond `pdfText` (always built). */
interface ToolPlan {
  /** Region crops (`pdfImages`) at this dpi. */
  cropDpi?: number;
  /** Full-page renders (`pdfPageImages`) for every page at this dpi. */
  allPagesDpi?: number;
  /** Word scan pages: OCR renders at this dpi. */
  scanOcrDpi?: number;
  /** Word scan pages: full-page fallback render at this dpi. */
  scanFallbackDpi?: number;
}

/** dpi slider value clamped to the catalog range, defaulting like the Rust runner. */
function clampDpi(options: Record<string, unknown>, fallback: number): number {
  return Math.min(300, Math.max(72, optionJsonNumber(options, 'dpi', fallback)));
}

/** Per-tool runtimeData plan mirroring the Rust converters' option reads. */
function planFor(tool: string, options: Record<string, unknown>): ToolPlan | null {
  switch (tool) {
    case 'pdf-to-csv':
    case 'pdf-to-rtf':
    case 'pdf-to-excel':
      return {};
    case 'pdf-to-markdown':
      return optionFlag(options, 'includeImages', true) ? { cropDpi: 150 } : {};
    case 'pdf-to-epub':
      return optionFlag(options, 'includeImages', true) ? { cropDpi: 144 } : {};
    case 'pdf-to-html':
      return { cropDpi: clampDpi(options, 144) };
    case 'pdf-to-word': {
      // Scan-page fallback runs regardless of includeImages (TS parity).
      const plan: ToolPlan = { scanOcrDpi: 200, scanFallbackDpi: 150 };
      if (optionFlag(options, 'includeImages', true)) plan.cropDpi = 150;
      return plan;
    }
    case 'pdf-to-ppt':
      return { allPagesDpi: clampDpi(options, 144) };
    case 'pdf-to-ofd':
      return String(options.mode ?? 'text') === 'image' ? { allPagesDpi: clampDpi(options, 144) } : {};
    default:
      return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>;

/** Opens a PDF through PDF.js, mapping load failures to job error codes. */
async function loadImageDocument(bytes: Uint8Array, password?: string): Promise<PdfDocument> {
  // PDF.js may detach the source buffer, so hand it a private copy.
  const loading = getDocument({ data: Uint8Array.from(bytes), password: password || undefined, isEvalSupported: false });
  let document: PdfDocument | null = null;
  try {
    document = await loading.promise;
    return document;
  } catch (error) {
    const message = errorMessage(error);
    throw new JobFailure(/password/i.test(message) ? 'encrypted_document' : 'unreadable_file', message);
  } finally {
    if (!document) await loading.destroy();
  }
}

/**
 * Extracts visual-space text runs per page, mirroring the TS oracle's
 * readPages: fontSize from the transform scale, top-left y from the baseline
 * minus ascent*size, trailing-whitespace-only items dropped.
 */
async function extractTextPages(bytes: Uint8Array, password?: string): Promise<TextPage[]> {
  const document = await loadImageDocument(bytes, password);
  try {
    const pages: TextPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const runs: TextRun[] = [];
        for (const item of content.items) {
          if (!('str' in item) || typeof item.str !== 'string' || !item.str.trim()) continue;
          const transform = item.transform;
          const style = content.styles[item.fontName];
          const fontSize = Math.max(1, Math.hypot(transform[0] ?? 0, transform[1] ?? 0));
          const point = viewport.convertToViewportPoint(transform[4] ?? 0, transform[5] ?? 0);
          const ascent = typeof style?.ascent === 'number' ? style.ascent : 0.8;
          const text = item.str.replace(/\s+$/u, '');
          if (!text) continue;
          const font = style?.fontFamily ?? item.fontName;
          runs.push({
            text,
            x: point[0] ?? 0,
            y: (point[1] ?? 0) - ascent * fontSize,
            w: item.width,
            h: Math.max(1, item.height || fontSize),
            size: fontSize,
            font,
            weight: /bold|black|heavy/i.test(`${style?.fontFamily ?? ''} ${item.fontName}`) ? 'bold' : 'normal',
            style: /italic|oblique/i.test(`${style?.fontFamily ?? ''} ${item.fontName}`) ? 'italic' : 'normal',
          });
        }
        pages.push({ page: pageNumber, width: viewport.width, height: viewport.height, runs });
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await document.destroy();
  }
}

/** Reads the ≥18×18pt image rects per page; errors keep the same job codes. */
async function imageRectPages(bytes: Uint8Array): Promise<RectPage[]> {
  try {
    const reply = pdfImageRects(Uint8Array.from(bytes)) as { pages?: RectPage[] };
    return reply.pages ?? [];
  } catch (error) {
    const payload = error as { code?: unknown; message?: unknown };
    throw new JobFailure(
      typeof payload?.code === 'string' && payload.code ? payload.code : 'unreadable_file',
      typeof payload?.message === 'string' && payload.message ? payload.message : errorMessage(error),
    );
  }
}

/** dpi/72 clamped so no page exceeds 6000px per edge or 24 megapixels. */
function renderScale(dpi: number, width: number, height: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  let scale = Math.min(dpi / 72, MAX_EDGE / w, MAX_EDGE / h);
  scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (w * h)));
  return Math.max(0.05, scale);
}

/** Renders one page (white background) at the given scale into a canvas. */
async function renderPageCanvas(page: Awaited<ReturnType<PdfDocument['getPage']>>, scale: number): Promise<OffscreenCanvas> {
  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('PDF 页面画布不可用');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    background: '#ffffff',
  }).promise;
  return canvas;
}

async function pngBytes(canvas: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Crops a page's rects out of its render (browser-region.ts scale semantics). */
async function cropRectPlacements(rectPage: RectPage, canvas: OffscreenCanvas): Promise<ImagePlacement[]> {
  const scale = canvas.width / rectPage.width;
  const placements: ImagePlacement[] = [];
  for (const [index, rect] of rectPage.rects.entries()) {
    const x = rect[0] ?? 0;
    const y = rect[1] ?? 0;
    const w = rect[2] ?? 0;
    const h = rect[3] ?? 0;
    const left = clampRange(Math.round(x * scale), 0, canvas.width - 1);
    const top = clampRange(Math.round(y * scale), 0, canvas.height - 1);
    const width = clampRange(Math.round(w * scale), 1, canvas.width - left);
    const height = clampRange(Math.round(h * scale), 1, canvas.height - top);
    const crop = new OffscreenCanvas(width, height);
    const context = crop.getContext('2d', { alpha: true });
    if (!context) throw new Error('PDF 区域画布不可用');
    context.drawImage(canvas, left, top, width, height, 0, 0, width, height);
    placements.push({ page: rectPage.page, index, widthPt: w, heightPt: h, bytes: await pngBytes(crop) });
  }
  return placements;
}

/**
 * Renders one scan page at the OCR dpi and recognizes it on the shared
 * PaddleOCR model; when recognition is empty or fails, falls back to a
 * full-page PNG at the fallback dpi (pushed through `pushFallback`).
 * Returns the recognized lines, or null when the fallback was used.
 */
async function recognizeScanPage(
  document: PdfDocument,
  pageNumber: number,
  textPage: TextPage,
  ocrDpi: number,
  fallbackDpi: number,
  pushFallback: (image: PageImage) => void,
): Promise<string[] | null> {
  let lines: string[] = [];
  try {
    const page = await document.getPage(pageNumber);
    try {
      const canvas = await renderPageCanvas(page, renderScale(ocrDpi, textPage.width, textPage.height));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('PDF 页面画布不可用');
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      lines = await recognizeImageLines(image.width, image.height, image.data).catch(() => []);
    } finally {
      page.cleanup();
    }
  } catch {
    lines = [];
  }
  if (lines.length) return lines;
  try {
    const page = await document.getPage(pageNumber);
    try {
      const canvas = await renderPageCanvas(page, renderScale(fallbackDpi, textPage.width, textPage.height));
      pushFallback({ page: pageNumber, dpi: fallbackDpi, bytes: await pngBytes(canvas) });
    } finally {
      page.cleanup();
    }
  } catch {
    // OCR unavailable and the fallback render failed: the page degrades to text-only.
  }
  return null;
}

/**
 * Builds the runtimeData the Rust conversion runners consume
 * (`pdfText`/`pdfImages`/`pdfPageImages`/`pdfOcrPages`, keyed by file id).
 * Returns null for tools needing none (`ofd-to-pdf`, `markdown-to-pdf` —
 * their fonts/assets are plumbed host-side). Rendering degrades gracefully
 * without OffscreenCanvas: text-only runtimeData is still produced, since
 * the Rust engine treats missing image entries as "no images".
 */
export async function buildConvertRuntimeData(
  job: JobRequest,
  inputs: ResolvedInput[],
  onProgress?: ConvertProgressFn,
): Promise<Record<string, unknown> | null> {
  const plan = planFor(job.tool, job.options ?? {});
  if (!plan) return null;
  const password = job.globals?.password ?? undefined;

  let lastEmit = 0;
  const emit = (percent: number, phase: ConvertPhase): void => {
    const now = Date.now();
    if (now - lastEmit < 120) return;
    lastEmit = now;
    try {
      onProgress?.(Math.min(95, Math.max(1, Math.round(percent))), phase);
    } catch {
      // Progress is advisory; never fail the job through it.
    }
  };

  // Phase 1 (prepare): text extraction plus per-input render planning.
  const planned: Array<{ input: ResolvedInput; pages: TextPage[]; cropPages: RectPage[]; scanPages: number[] }> = [];
  let totalUnits = 0;
  for (const [index, input] of inputs.entries()) {
    const pages = await extractTextPages(input.bytes, password);
    const cropPages = plan.cropDpi === undefined ? [] : await imageRectPages(input.bytes);
    const scanPages = plan.scanOcrDpi === undefined
      ? []
      : pages.filter((page) => !page.runs.length).map((page) => page.page);
    planned.push({ input, pages, cropPages, scanPages });
    totalUnits += (plan.cropDpi === undefined ? 0 : cropPages.filter((entry) => entry.rects.length).length)
      + (plan.allPagesDpi === undefined ? 0 : pages.length)
      + scanPages.length;
    emit(((index + 1) / inputs.length) * 20, 'prepare');
  }

  const pdfText: Record<string, TextPage[]> = {};
  const pdfImages: Record<string, ImagePlacement[]> = {};
  const pdfPageImages: Record<string, PageImage[]> = {};
  const pdfOcrPages: Record<string, OcrPage[]> = {};
  for (const { input, pages } of planned) pdfText[input.id] = pages;

  // Phase 2 (render): region crops, full-page renders, scan-page OCR.
  if (totalUnits > 0 && typeof OffscreenCanvas !== 'undefined') {
    let renderedUnits = 0;
    const step = (): void => {
      renderedUnits += 1;
      emit((renderedUnits / totalUnits) * 95, 'render');
    };
    for (const { input, pages, cropPages, scanPages } of planned) {
      const document = await loadImageDocument(input.bytes, password);
      try {
        if (plan.cropDpi !== undefined) {
          const placements: ImagePlacement[] = [];
          for (const rectPage of cropPages) {
            if (!rectPage.rects.length) continue;
            try {
              const page = await document.getPage(rectPage.page);
              try {
                const canvas = await renderPageCanvas(page, renderScale(plan.cropDpi, rectPage.width, rectPage.height));
                placements.push(...await cropRectPlacements(rectPage, canvas));
              } finally {
                page.cleanup();
              }
            } catch {
              // Degrade without this page's crops; the Rust flow gets no image blocks.
            }
            step();
          }
          if (placements.length) pdfImages[input.id] = placements;
        }
        if (plan.allPagesDpi !== undefined) {
          const images: PageImage[] = [];
          for (const textPage of pages) {
            try {
              const page = await document.getPage(textPage.page);
              try {
                const canvas = await renderPageCanvas(page, renderScale(plan.allPagesDpi, textPage.width, textPage.height));
                images.push({ page: textPage.page, dpi: plan.allPagesDpi, bytes: await pngBytes(canvas) });
              } finally {
                page.cleanup();
              }
            } catch {
              // Slides/pages without a render are skipped by the Rust runner.
            }
            step();
          }
          pdfPageImages[input.id] = images;
        }
        if (plan.scanOcrDpi !== undefined && plan.scanFallbackDpi !== undefined) {
          const ocrEntries: OcrPage[] = [];
          const fallbackImages: PageImage[] = [];
          for (const pageNumber of scanPages) {
            const textPage = pages.find((page) => page.page === pageNumber);
            if (!textPage) continue;
            const lines = await recognizeScanPage(
              document,
              pageNumber,
              textPage,
              plan.scanOcrDpi,
              plan.scanFallbackDpi,
              (image) => fallbackImages.push(image),
            );
            if (lines) ocrEntries.push({ page: pageNumber, text: lines.join('\n') });
            step();
          }
          if (ocrEntries.length) pdfOcrPages[input.id] = ocrEntries;
          if (fallbackImages.length) pdfPageImages[input.id] = fallbackImages;
        }
      } finally {
        await document.destroy();
      }
    }
  }

  const runtimeData: Record<string, unknown> = { pdfText };
  if (Object.keys(pdfImages).length) runtimeData.pdfImages = pdfImages;
  if (Object.keys(pdfPageImages).length) runtimeData.pdfPageImages = pdfPageImages;
  if (Object.keys(pdfOcrPages).length) runtimeData.pdfOcrPages = pdfOcrPages;
  return runtimeData;
}
