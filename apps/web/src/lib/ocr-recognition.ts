import { PaddleOcrService } from 'paddleocr';
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import ortWasmModuleUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import {
  decodeImageRgba,
  ocrTableWorkbook,
  ocrTextArtifacts,
} from '../../../../packages/engine/wasm/pkg/potools_engine.js';
import type { FileKind, JobProgress, JobRequest, JobSnapshot } from 'core';
import type { InMemoryJobResult, ResolvedInput } from './engine-types.ts';
import { optionFlag, optionNumber } from './option-coerce.ts';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_PIXELS = 20_000_000;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortWasmModuleUrl };

/** Failure with a JobError code that should surface verbatim in the job snapshot. */
class JobFailure extends Error {
  readonly code: string;
  readonly hintKey?: string;
  constructor(code: string, message: string, hintKey?: string) {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
    this.hintKey = hintKey;
  }
}

/** Model/dictionary fetch or ONNX session init failure. */
class OcrInitError extends Error {
  /**
   * The display layer resolves a failure by looking up `error.<code>`, so
   * without this the (already translated) `error.ocrInit` entry was unreachable
   * and every init failure surfaced its Chinese message verbatim in the English
   * UI. The message is kept for logs and for the no-code fallback.
   */
  readonly code = 'ocrInit';
  constructor(message: string) {
    super(message);
    this.name = 'OcrInitError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-');
}

/** A line handed to the Rust artifact builders; boxes are [minX, minY, maxX, maxY]. */
interface OcrLinePayload {
  text: string;
  confidence?: number;
  box?: [number, number, number, number];
}

/** Box shapes seen across paddleocr releases: point arrays and x/y/w/h rectangles. */
interface OcrPointBox {
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Array<{ x: number; y: number }>;
}

interface OcrRecognizedItem {
  text?: string;
  score?: number;
  confidence?: number;
  box?: number[][] | OcrPointBox;
}

/**
 * `processRecognition` reply. paddleocr 1.2 returns grouped `lines`; the
 * flattened `items` shape is kept for parity with the TypeScript oracle.
 */
interface ProcessedRecognition {
  text?: string;
  items?: OcrRecognizedItem[];
  lines?: OcrRecognizedItem[][];
}

interface RecognizedPageData {
  /** 1-based page number within the input (drives markers and sheet names). */
  page: number;
  /** Raster width in pixels; feeds the Rust column-anchor threshold. */
  width: number;
  lines: OcrLinePayload[];
}

interface RecognizedInputData {
  name: string;
  pages: RecognizedPageData[];
}

interface RustErrorPayload {
  code?: string;
  message?: string;
  hintKey?: string;
}

interface OcrTextReply {
  artifacts: Array<{ name: string; text: string; inputId?: string | null }>;
  warnings: string[];
  empty: boolean;
  error?: RustErrorPayload;
}

interface OcrTableReply {
  ok: boolean;
  name?: string;
  bytes?: Uint8Array;
  pages?: number;
  rows?: number;
  warnings: string[];
  error?: RustErrorPayload;
}

let servicePromise: Promise<PaddleOcrService> | null = null;

function publicAssetUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}models/ocr/${file}`, self.location.origin).href;
}

async function fetchModel(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OCR 模型请求失败（${response.status}）`);
  return response.arrayBuffer();
}

/** Singleton PaddleOCR service (det + rec + dict, PP-OCRv6_small), mirroring the TS oracle init. */
function getOcrService(): Promise<PaddleOcrService> {
  if (!servicePromise) {
    servicePromise = (async () => {
      const [detection, recognition] = await Promise.all([
        fetchModel(publicAssetUrl('PP-OCRv6_small_det_infer.onnx')),
        fetchModel(publicAssetUrl('PP-OCRv6_small_rec_infer.onnx')),
      ]);
      const response = await fetch(publicAssetUrl('ppocrv6_dict.txt'));
      if (!response.ok) throw new Error(`OCR 字典请求失败（${response.status}）`);
      const charactersDictionary = (await response.text()).trimEnd().split(/\r?\n/);
      if (!charactersDictionary.includes(' ')) charactersDictionary.push(' ');
      return PaddleOcrService.createInstance({
        ort: ort as never,
        modelPreset: 'PP-OCRv6_small',
        detection: { modelBuffer: detection },
        recognition: { modelBuffer: recognition, charactersDictionary },
      });
    })().catch((error: unknown) => {
      servicePromise = null;
      throw new OcrInitError(`OCR 引擎初始化失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return servicePromise;
}

/** Maps one recognized region to the line payload; empty text is dropped. */
function itemBox(box: OcrRecognizedItem['box']): [number, number, number, number] | undefined {
  if (!box) return undefined;
  if (Array.isArray(box)) {
    if (!box.length) return undefined;
    return [
      Math.min(...box.map((point) => point[0] ?? 0)),
      Math.min(...box.map((point) => point[1] ?? 0)),
      Math.max(...box.map((point) => point[0] ?? 0)),
      Math.max(...box.map((point) => point[1] ?? 0)),
    ];
  }
  if (box.points?.length) {
    return [
      Math.min(...box.points.map((point) => point.x)),
      Math.min(...box.points.map((point) => point.y)),
      Math.max(...box.points.map((point) => point.x)),
      Math.max(...box.points.map((point) => point.y)),
    ];
  }
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

/** Port of the oracle's processRecognition consumption, plus paddleocr 1.2 `lines` support. */
function recognitionLines(processed: ProcessedRecognition, imageWidth: number): OcrLinePayload[] {
  const items = processed.items ?? processed.lines?.flat() ?? [];
  const lines: OcrLinePayload[] = [];
  for (const item of items) {
    const text = String(item.text ?? '').trim();
    if (!text) continue;
    const confidence = typeof item.score === 'number' ? item.score : typeof item.confidence === 'number' ? item.confidence : undefined;
    const box = itemBox(item.box);
    lines.push({
      text,
      ...(confidence === undefined ? {} : { confidence }),
      ...(box ? { box } : {}),
    });
  }
  if (!lines.length && processed.text?.trim()) {
    for (const [index, raw] of processed.text.split(/\r?\n/).entries()) {
      const text = raw.trim();
      if (!text) continue;
      lines.push({ text, box: [0, index * 24, imageWidth, index * 24 + 18] });
    }
  }
  return lines;
}

/** RGBA → RGB strip (shared by the OCR job pipeline and the convert fallback). */
function stripRgbaToRgb(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4) {
    rgb[target++] = rgba[source]!;
    rgb[target++] = rgba[source + 1]!;
    rgb[target++] = rgba[source + 2]!;
  }
  return rgb;
}

/** RGBA → RGB strip, then the shared PaddleOCR det/rec pipeline. */
async function recognizePixels(page: number, width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Promise<RecognizedPageData> {
  const service = await getOcrService();
  const results = await service.recognize({ width, height, data: stripRgbaToRgb(width, height, rgba) });
  const processed = service.processRecognition(results) as unknown as ProcessedRecognition;
  return { page, width, lines: recognitionLines(processed, width) };
}

/**
 * RGBA pixels → recognized line texts (trimmed, non-empty), for the
 * pdf-to-word scan-page fallback. Reuses the singleton OCR model so the
 * conversion path never re-initializes detection/recognition.
 */
export async function recognizeImageLines(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Promise<string[]> {
  const service = await getOcrService();
  const results = await service.recognize({ width, height, data: stripRgbaToRgb(width, height, rgba) });
  const processed = service.processRecognition(results) as unknown as ProcessedRecognition;
  return recognitionLines(processed, width).map((line) => line.text).filter(Boolean);
}

/** Parses the JSON `{code,message}` strings thrown by the Rust image decoder. */
function rustErrorPayload(message: string): RustErrorPayload | null {
  try {
    const parsed = JSON.parse(message) as RustErrorPayload;
    if (parsed && typeof parsed.code === 'string' && typeof parsed.message === 'string') return parsed;
  } catch {
    // Not a JSON payload; fall back to the raw message.
  }
  return null;
}

/** Standalone images (jpg/png/webp/gif/tiff/bmp) decode through the Rust decoder. */
function decodeRustImage(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  try {
    const decoded = decodeImageRgba(new Uint8Array(bytes), MAX_PIXELS) as { width: number; height: number; rgba: Uint8Array };
    if (!decoded.width || !decoded.height || !decoded.rgba?.length) throw new Error('图片解码结果为空');
    return decoded;
  } catch (error) {
    const message = errorMessage(error);
    const parsed = rustErrorPayload(message);
    throw new JobFailure(parsed?.code ?? 'unsupported', parsed?.message ?? message);
  }
}

type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>;

/**
 * Browser adapter for `ocr-text` / `ocr-table`: pixels come from PDF.js
 * (documents) or the Rust decoder (images), recognition runs on the shared
 * PaddleOCR model, and the Rust engine owns artifact assembly (naming, page
 * markers, warnings, xlsx). Returns null when the tool or runtime is out of
 * scope so the caller can fall through.
 */
export async function runOcrJob(
  job: JobRequest,
  inputs: ResolvedInput[],
  onProgress: (snapshot: JobSnapshot) => void,
): Promise<InMemoryJobResult | null> {
  if (job.tool !== 'ocr-text' && job.tool !== 'ocr-table') return null;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return null;

  const isTable = job.tool === 'ocr-table';
  const dpi = optionNumber(job.options, 'dpi', isTable ? 220 : 200, 120, 300);
  const pageMarkers = isTable ? false : optionFlag(job.options, 'pageMarkers', true);
  const locale = job.globals?.locale ?? 'zh-CN';

  const base = {
    id: job.id,
    tool: job.tool,
    label: job.label,
    fileNames: inputs.map((input) => input.name),
    createdAt: job.createdAt ?? Date.now(),
  };
  const publish = (progress: JobProgress): void => {
    onProgress({ ...base, artifacts: [], warnings: [], progress });
  };
  const failed = (code: string, message: string, hintKey?: string): InMemoryJobResult => ({
    handled: true,
    snapshot: {
      ...base,
      artifacts: [],
      warnings: [],
      finishedAt: Date.now(),
      progress: { state: 'failed', percent: 1 },
      error: { code, message, ...(hintKey ? { details: { hintKey } } : {}) },
    },
    artifacts: [],
  });

  const recognized: RecognizedInputData[] = [];
  let totalPages = 0;
  let lastEmit = 0;

  try {
    // Surface model/init failures as `ocr_init` before any page work starts.
    await getOcrService();
    for (const [inputIndex, input] of inputs.entries()) {
      const pages: RecognizedPageData[] = [];
      if (isPdf(input.bytes)) {
        // PDF.js may detach the source buffer, so hand it a private copy.
        const loading = getDocument({
          data: new Uint8Array(input.bytes),
          password: job.globals?.password || undefined,
          isEvalSupported: false,
        });
        let document: PdfDocument | null = null;
        try {
          try {
            document = await loading.promise;
          } catch (error) {
            const message = errorMessage(error);
            throw new JobFailure(/password/i.test(message) ? 'encrypted_document' : 'unreadable_file', message);
          }
          for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            let recognizedPage: RecognizedPageData;
            try {
              const viewport = page.getViewport({ scale: dpi / 72 });
              if (viewport.width * viewport.height > MAX_PIXELS) {
                throw new JobFailure('unsupported', '页面尺寸超过 OCR 上限（2000 万像素）');
              }
              const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
              const context = canvas.getContext('2d', { alpha: false });
              if (!context) throw new JobFailure('unsupported', 'PDF 页面画布不可用');
              context.fillStyle = '#ffffff';
              context.fillRect(0, 0, canvas.width, canvas.height);
              await page.render({
                canvasContext: context as unknown as CanvasRenderingContext2D,
                viewport,
                background: '#ffffff',
              }).promise;
              const image = context.getImageData(0, 0, canvas.width, canvas.height);
              recognizedPage = await recognizePixels(pageNumber, image.width, image.height, image.data);
            } finally {
              page.cleanup();
            }
            pages.push(recognizedPage);
            const percent = Math.round(((inputIndex + pageNumber / document.numPages) / inputs.length) * 100);
            const now = Date.now();
            if (now - lastEmit >= 120 || percent >= 100) {
              lastEmit = now;
              publish({ state: 'running', percent, phase: 'recognize', current: pageNumber, total: document.numPages });
            }
          }
        } finally {
          if (document) await document.destroy();
          else await loading.destroy();
        }
      } else {
        const decoded = decodeRustImage(input.bytes);
        // The Rust view points into wasm memory; copy before async inference.
        const rgba = new Uint8Array(decoded.rgba);
        pages.push(await recognizePixels(1, decoded.width, decoded.height, rgba));
        const percent = Math.round(((inputIndex + 1) / inputs.length) * 100);
        const now = Date.now();
        if (now - lastEmit >= 120 || percent >= 100) {
          lastEmit = now;
          publish({ state: 'running', percent, phase: 'recognize', current: inputIndex + 1, total: inputs.length });
        }
      }
      recognized.push({ name: input.name, pages });
      totalPages += pages.length;
    }
  } catch (error) {
    if (error instanceof JobFailure) return failed(error.code, error.message, error.hintKey);
    if (error instanceof OcrInitError) return failed('ocr_init', error.message, 'error.ocrInit');
    return failed('ocr_error', errorMessage(error));
  }

  const rustInputs = recognized.map((input, index) => ({
    id: inputs[index]?.id,
    name: input.name,
    pages: input.pages.map((page) => ({ page: page.page, width: page.width, lines: page.lines })),
  }));
  const inputBytes = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
  const succeeded = (artifacts: InMemoryJobResult['artifacts'], warnings: string[], extra: Record<string, number>): InMemoryJobResult => {
    const outputBytes = (artifacts ?? []).reduce((sum, artifact) => sum + artifact.bytes!.byteLength, 0);
    const snapshot: JobSnapshot = {
      ...base,
      artifacts: (artifacts ?? []).map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        path: null,
        sizeBytes: artifact.bytes!.byteLength,
        sourceFileId: artifact.sourceFileId,
      })),
      finishedAt: Date.now(),
      progress: { state: 'succeeded', percent: 100, phase: 'done' },
      summary: {
        inputBytes,
        outputBytes,
        // 页数语义与旧引擎一致：产物个数（每个输入一个 txt），
        // 识别页数放 extra.pages。
        pageCountIn: 0,
        pageCountOut: (artifacts ?? []).length,
        sizeDeltaPercent: inputBytes > 0 ? Math.round(((outputBytes - inputBytes) / inputBytes) * 100) : 0,
        extra,
      },
      warnings,
    };
    return { handled: true, snapshot, artifacts };
  };

  if (isTable) {
    const reply = ocrTableWorkbook({ inputs: rustInputs, locale }) as OcrTableReply;
    if (reply.error) return failed(reply.error.code ?? 'ocr_error', reply.error.message ?? '表格识别失败', reply.error.hintKey);
    if (!reply.ok || !reply.bytes) return failed('empty_selection', '没有识别到可导出的表格内容。');
    const bytes = new Uint8Array(reply.bytes);
    const artifacts: NonNullable<InMemoryJobResult['artifacts']> = [{
      id: '1',
      name: reply.name ?? 'ocr-tables.xlsx',
      kind: 'xlsx' as FileKind,
      bytes,
      sourceFileId: inputs.length === 1 ? inputs[0]?.id : undefined,
    }];
    return succeeded(artifacts, reply.warnings ?? [], {
      dpi,
      pages: typeof reply.pages === 'number' ? reply.pages : 0,
      rows: typeof reply.rows === 'number' ? reply.rows : 0,
    });
  }

  const reply = ocrTextArtifacts({ inputs: rustInputs, pageMarkers, locale }) as OcrTextReply;
  if (reply.error) return failed(reply.error.code ?? 'ocr_error', reply.error.message ?? '文字识别失败');
  if (reply.empty) return failed('empty_selection', '没有可识别的页面。');
  const encoder = new TextEncoder();
  const artifacts: NonNullable<InMemoryJobResult['artifacts']> = reply.artifacts.map((artifact, index) => {
    const source = inputs.find((input) => input.id === artifact.inputId) ?? inputs[index];
    return {
      id: String(index + 1),
      name: artifact.name,
      kind: 'text' as FileKind,
      bytes: encoder.encode(artifact.text),
      sourceFileId: source?.id,
    };
  });
  return succeeded(artifacts, reply.warnings ?? [], { pages: totalPages, dpi });
}
