import { PaddleOcrService } from 'paddleocr';
import * as ort from 'onnxruntime-web/wasm';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import detectionModelUrl from '../../ocr-models/PP-OCRv6_small_det_infer.onnx?url';
import recognitionModelUrl from '../../ocr-models/PP-OCRv6_small_rec_infer.onnx?url';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import wasmModuleUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import dictionary from '../../ocr-models/ppocrv6_dict.txt?raw';
import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import type { ResolvedInput, ToolImpl } from '../types.ts';
import type { OcrLine, OcrPageResult } from '../lib/ocr.ts';
import { writeBrowserXlsx } from '../lib/xlsx-browser.ts';
import { isTiff, openTiffBitmap } from './tiff-browser.ts';

type RecognizedPage = { page: number; lines: OcrLine[]; text: string; width: number; height: number };
type LocalOcr = { recognize(input: { width: number; height: number; data: Uint8Array }): Promise<unknown[]>; processRecognition(results: unknown[]): { text?: string; items?: Array<{ text?: string; score?: number; box?: number[][] }> } };
let servicePromise: Promise<LocalOcr> | null = null;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function canRunBrowserOcr(inputs: ResolvedInput[]): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return false;
  for (const input of inputs) {
    if (isPdf(input.bytes)) continue;
    if (!await canDecodeImage(input)) return false;
  }
  return inputs.length > 0;
}

/** Runs the shared local OCR model on a PNG rendered from a PDF page. */
export async function recognizeBrowserPng(png: Uint8Array): Promise<OcrPageResult> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    throw new InMemoryFallback('Canvas image decoding is unavailable for OCR');
  }
  const bitmap = await decodeBitmap(png);
  try {
    if (bitmap.width * bitmap.height > 20_000_000) throw new InMemoryFallback('OCR page exceeds browser pixel limit');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new InMemoryFallback('Canvas is unavailable for OCR');
    context.drawImage(bitmap, 0, 0);
    return await recognizePixels(context.getImageData(0, 0, bitmap.width, bitmap.height));
  } finally {
    bitmap.close();
  }
}

const ocrTextBrowser: ToolImpl = {
  id: 'ocr-text',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const dpi = Math.max(120, Math.min(300, Number(ctx.options.dpi) || 200));
    const markers = ctx.options.pageMarkers !== false;
    let totalPages = 0;
    for (const input of ctx.inputs) {
      const pages = await recognizeInput(ctx, input, dpi);
      totalPages += pages.length;
      const text = pages.map((page) => markers && pages.length > 1 ? `${msg('ocr.page', { page: page.page })}\n${page.text.trim()}` : page.text.trim()).filter(Boolean).join('\n\n');
      if (!text) ctx.warnings.push(msg('ocr.warning.empty', { name: baseName(input.name) }));
      else await ctx.emit({ name: `${baseName(input.name)}-ocr.txt`, kind: 'text', bytes: new TextEncoder().encode(`${text}\n`), sourceFileId: input.id });
    }
    if (!totalPages) throw new EngineError('empty_selection', msg('ocr.error.empty'));
    return { extra: { pages: totalPages } };
  },
};

const ocrTableBrowser: ToolImpl = {
  id: 'ocr-table',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const dpi = Math.max(120, Math.min(300, Number(ctx.options.dpi) || 220));
    const sheets: Array<{ name: string; rows: string[][] }> = [];
    for (const input of ctx.inputs) {
      const pages = await recognizeInput(ctx, input, dpi);
      for (const page of pages) {
        const rows = tableRows(page.lines, page.width);
        if (!rows.length) {
          ctx.warnings.push(msg('ocr.warning.noTable', { name: baseName(input.name), page: page.page }));
          continue;
        }
        const sheetBase = `${baseName(input.name)}-${page.page}`.replace(/[\\/?*\[\]:]/g, '-').slice(0, 31) || `Page-${sheets.length + 1}`;
        const sheetName = uniqueSheetName(sheetBase, sheets.map((sheet) => sheet.name));
        sheets.push({ name: sheetName, rows });
      }
    }
    if (!sheets.length) throw new EngineError('empty_selection', msg('ocr.error.noTable'));
    const bytes = await writeBrowserXlsx(sheets);
    const outputName = ctx.inputs.length === 1 ? `${baseName(ctx.inputs[0]!.name)}-tables.xlsx` : 'ocr-tables.xlsx';
    await ctx.emit({ name: outputName, kind: 'xlsx', bytes, sourceFileId: ctx.inputs.length === 1 ? ctx.inputs[0]!.id : undefined });
    ctx.warnings.push(msg('ocr.warning.review'));
    return { extra: { pages: sheets.length, rows: sheets.reduce((count, sheet) => count + sheet.rows.length, 0) } };
  },
};

export const embeddedOcrTools: ToolImpl[] = [ocrTextBrowser, ocrTableBrowser];

async function recognizeInput(ctx: Parameters<ToolImpl['run']>[0], input: ResolvedInput, dpi: number): Promise<RecognizedPage[]> {
  if (isPdf(input.bytes)) {
    const copy = new Uint8Array(input.bytes.byteLength);
    copy.set(input.bytes);
    const loading = getDocument({ data: copy, isEvalSupported: false, password: ctx.globals.password || undefined });
    let document: Awaited<typeof loading.promise> | null = null;
    try {
      document = await loading.promise;
      const pages: RecognizedPage[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (ctx.cancelled()) break;
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: dpi / 72 });
        if (viewport.width * viewport.height > 20_000_000) throw new InMemoryFallback('PDF page exceeds browser OCR raster limit');
        const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new InMemoryFallback('Canvas is unavailable for PDF OCR');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport, background: '#ffffff' }).promise;
        const result = await recognizePixels(context.getImageData(0, 0, canvas.width, canvas.height));
        pages.push({ page: pageNumber, lines: result.lines, text: result.text, width: canvas.width, height: canvas.height });
        page.cleanup();
        ctx.report({ percent: Math.round(((pageNumber / document.numPages) / ctx.inputs.length) * 100), phase: 'recognize', current: pageNumber, total: document.numPages });
      }
      return pages;
    } catch (error) {
      if (error instanceof InMemoryFallback) throw error;
      throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
    } finally {
      if (document) await document.destroy();
      else await loading.destroy();
    }
  }

  const bitmap = await decodeBitmap(input.bytes);
  try {
    if (bitmap.width * bitmap.height > 20_000_000) throw new InMemoryFallback('Image exceeds browser OCR pixel limit');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new InMemoryFallback('Canvas is unavailable for image OCR');
    context.drawImage(bitmap, 0, 0);
    const result = await recognizePixels(context.getImageData(0, 0, bitmap.width, bitmap.height));
    ctx.report({ percent: Math.round(((ctx.inputs.indexOf(input) + 1) / ctx.inputs.length) * 100), phase: 'recognize', current: ctx.inputs.indexOf(input) + 1, total: ctx.inputs.length });
    return [{ page: 1, lines: result.lines, text: result.text, width: bitmap.width, height: bitmap.height }];
  } finally {
    bitmap.close();
  }
}

async function recognizePixels(image: ImageData): Promise<OcrPageResult> {
  const rgb = new Uint8Array(image.width * image.height * 3);
  for (let source = 0, target = 0; source < image.data.length; source += 4) {
    rgb[target++] = image.data[source]!;
    rgb[target++] = image.data[source + 1]!;
    rgb[target++] = image.data[source + 2]!;
  }
  const service = await getService();
  const results = await service.recognize({ width: image.width, height: image.height, data: rgb });
  const processed = service.processRecognition(results);
  const lines: OcrLine[] = (processed.items ?? []).map((item) => ({
    text: String(item.text ?? '').trim(),
    confidence: typeof item.score === 'number' ? item.score : undefined,
    box: item.box?.length ? [
      Math.min(...item.box.map((point) => point[0] ?? 0)),
      Math.min(...item.box.map((point) => point[1] ?? 0)),
      Math.max(...item.box.map((point) => point[0] ?? 0)),
      Math.max(...item.box.map((point) => point[1] ?? 0)),
    ] as [number, number, number, number] : undefined,
  })).filter((line) => line.text);
  if (!lines.length && processed.text?.trim()) {
    lines.push(...processed.text.split(/\r?\n/).map((text, index) => ({
      text: text.trim(),
      box: [0, index * 24, image.width, index * 24 + 18] as [number, number, number, number],
    })).filter((line) => line.text));
  }
  return { text: String(processed.text ?? lines.map((line) => line.text).join('\n')), lines, model: 'PP-OCRv6_small' };
}

async function getService(): Promise<LocalOcr> {
  if (!servicePromise) {
    servicePromise = (async () => {
      const [detection, recognition] = await Promise.all([fetchModel(detectionModelUrl), fetchModel(recognitionModelUrl)]);
      const charactersDictionary = dictionary.trimEnd().split(/\r?\n/);
      if (!charactersDictionary.includes(' ')) charactersDictionary.push(' ');
      return PaddleOcrService.createInstance({
        ort: ort as never,
        modelPreset: 'PP-OCRv6_small',
        detection: { modelBuffer: detection },
        recognition: { modelBuffer: recognition, charactersDictionary },
      }) as Promise<LocalOcr>;
    })().catch((error) => {
      servicePromise = null;
      throw new InMemoryFallback(`Embedded OCR initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return servicePromise;
}

async function fetchModel(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OCR model request failed (${response.status})`);
  return response.arrayBuffer();
}

async function decodeBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  try {
    if (isTiff(copy)) return (await openTiffBitmap(copy, 20_000_000)).bitmap;
    return await createImageBitmap(new Blob([copy.buffer]));
  } catch (error) {
    throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
  }
}

async function canDecodeImage(input: ResolvedInput): Promise<boolean> {
  try {
    const bitmap = await decodeBitmap(input.bytes);
    const supported = bitmap.width > 0 && bitmap.height > 0 && bitmap.width * bitmap.height <= 20_000_000;
    bitmap.close();
    return supported;
  } catch { return false; }
}

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-');
}

function baseName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? name;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

function uniqueSheetName(name: string, existing: string[]): string {
  const hasName = (candidate: string) => existing.some((item) => item.toLowerCase() === candidate.toLowerCase());
  if (!hasName(name)) return name;
  for (let suffix = 2; ; suffix += 1) {
    const marker = ` (${suffix})`;
    const candidate = `${name.slice(0, 31 - marker.length)}${marker}`;
    if (!hasName(candidate)) return candidate;
  }
}

type PositionedLine = { text: string; left: number; right: number; top: number; bottom: number };

function tableRows(lines: OcrLine[], width: number): string[][] {
  const positioned: PositionedLine[] = lines.filter((line) => line.text.trim()).map((line, index) => ({
    text: line.text.trim(), left: line.box?.[0] ?? index * 10, top: line.box?.[1] ?? index * 24,
    right: line.box?.[2] ?? index * 10 + Math.max(24, line.text.length * 12), bottom: line.box?.[3] ?? index * 24 + 18,
  })).sort((a, b) => a.top - b.top || a.left - b.left);
  if (!positioned.length) return [];
  const rows: PositionedLine[][] = [];
  for (const line of positioned) {
    const row = rows.find((candidate) => {
      const top = Math.min(...candidate.map((cell) => cell.top));
      const bottom = Math.max(...candidate.map((cell) => cell.bottom));
      const height = Math.max(line.bottom - line.top, bottom - top);
      return Math.abs((line.top + line.bottom) / 2 - (top + bottom) / 2) <= height * 0.55;
    });
    if (row) row.push(line); else rows.push([line]);
  }
  rows.sort((a, b) => Math.min(...a.map((cell) => cell.top)) - Math.min(...b.map((cell) => cell.top)));
  const threshold = Math.max(18, width * 0.018);
  const anchors: number[] = [];
  for (const line of positioned.slice().sort((a, b) => a.left - b.left)) {
    const nearest = anchors.findIndex((anchor) => Math.abs(anchor - line.left) <= threshold);
    if (nearest < 0) anchors.push(line.left); else anchors[nearest] = (anchors[nearest]! + line.left) / 2;
  }
  anchors.sort((a, b) => a - b);
  return rows.map((row) => {
    const cells = Array.from({ length: anchors.length }, () => '');
    for (const line of row.sort((a, b) => a.left - b.left)) {
      let column = anchors.reduce((best, anchor, index) => Math.abs(anchor - line.left) < Math.abs(anchors[best]! - line.left) ? index : best, 0);
      if (cells[column]) {
        const next = anchors.findIndex((_, index) => index > column && !cells[index]);
        if (next >= 0 && line.left - anchors[column]! > threshold) column = next;
      }
      cells[column] = cells[column] ? `${cells[column]} ${line.text}` : line.text;
    }
    return cells;
  });
}
