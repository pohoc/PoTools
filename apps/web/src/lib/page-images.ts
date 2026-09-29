import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { renderToolName } from '../../../../packages/engine/wasm/pkg/potools_engine.js';
import { PageRangeError, parsePageRanges } from './core-bindings.ts';
import type { FileKind, JobProgress, JobRequest, JobSnapshot, OutputFile } from 'core';
import type { InMemoryJobResult, ResolvedInput } from './engine-types.ts';
import { optionFlag, optionNumber } from './option-coerce.ts';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ImageFormat = 'jpeg' | 'png' | 'webp';
const MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MAX_EDGE = 6000;
const MAX_PIXELS = 24_000_000;

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

function baseName(fileName: string): string {
  const withoutDir = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = withoutDir.lastIndexOf('.');
  return dot > 0 ? withoutDir.slice(0, dot) : withoutDir;
}

/** `"report.pdf"` → `"report (2).pdf"` when a name is already taken. */
function dedupe(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 2;
  while (taken.has(`${stem} (${counter})${ext}`)) counter += 1;
  return `${stem} (${counter})${ext}`;
}

/** dpi/72 clamped so no page exceeds 6000px per edge or 24 megapixels. */
function rasterScale(base: number, width: number, height: number): number {
  let scale = Math.min(base, MAX_EDGE / Math.max(1, width), MAX_EDGE / Math.max(1, height));
  scale = Math.min(scale, Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
  return Math.max(0.05, scale);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>;

/**
 * Browser adapter for `pdf-to-images`: renders PDF pages through PDF.js into
 * OffscreenCanvas and encodes one image artifact per selected page. The Rust
 * engine has no rasterizer, so this stays a web-worker capability.
 *
 * The caller must have initialized the Rust core (page-range parsing and
 * output naming both live in the WASM runtime).
 */
export async function runPageImagesJob(
  job: JobRequest,
  inputs: ResolvedInput[],
  onProgress: (snapshot: JobSnapshot) => void,
): Promise<InMemoryJobResult> {
  if (typeof OffscreenCanvas === 'undefined') return { handled: false };

  const rawFormat = String(job.options.format ?? 'jpeg');
  const format: ImageFormat = rawFormat === 'png' || rawFormat === 'webp' ? rawFormat : 'jpeg';
  const dpi = Math.max(48, optionNumber(job.options, 'dpi', 150, 72, 600));
  const quality = optionNumber(job.options, 'quality', 88, 30, 100);
  const transparent = optionFlag(job.options, 'transparentBackground', false) && format !== 'jpeg';
  const pages = String(job.options.pages ?? 'all');

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

  const artifacts: NonNullable<InMemoryJobResult['artifacts']> = [];
  const snapshotArtifacts: OutputFile[] = [];
  const takenNames = new Set<string>();
  let exported = 0;
  let lastEmit = 0;

  try {
    for (const [inputIndex, input] of inputs.entries()) {
      // PDF.js may detach the source buffer, so hand it a private copy.
      const loading = getDocument({
        data: new Uint8Array(input.bytes),
        password: job.globals?.password ?? undefined,
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
        const selection = parsePageRanges(pages, document.numPages);
        if (!selection.length) throw new JobFailure('empty_selection', '没有可导出的页面');
        const stem = baseName(input.name);
        for (const [pageIndex, pageNumber] of selection.entries()) {
          const page = await document.getPage(pageNumber);
          let bytes: Uint8Array;
          try {
            const baseViewport = page.getViewport({ scale: 1 });
            const scale = rasterScale(dpi / 72, baseViewport.width, baseViewport.height);
            const viewport = page.getViewport({ scale });
            const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
            const context = canvas.getContext('2d', { alpha: transparent });
            if (!context) throw new JobFailure('unsupported', 'PDF page canvas is unavailable');
            if (!transparent) {
              context.fillStyle = '#ffffff';
              context.fillRect(0, 0, canvas.width, canvas.height);
            }
            await page.render({
              canvasContext: context as unknown as CanvasRenderingContext2D,
              viewport,
              ...(transparent ? {} : { background: '#ffffff' }),
            }).promise;
            const blob = await canvas.convertToBlob({ type: MIME[format], quality: format === 'png' ? undefined : quality / 100 });
            if (blob.type !== MIME[format]) throw new JobFailure('no_image_codec', `browser cannot encode ${format}`);
            bytes = new Uint8Array(await blob.arrayBuffer());
          } finally {
            page.cleanup();
          }
          exported += 1;
          const name = dedupe(renderToolName(
            job.namePattern,
            stem,
            `p${String(pageNumber).padStart(2, '0')}`,
            pageIndex + 1,
            selection.length,
            String(pageNumber),
            EXT[format],
          ), takenNames);
          takenNames.add(name);
          const id = String(artifacts.length + 1);
          artifacts.push({ id, name, kind: 'image' as FileKind, bytes, sourceFileId: input.id });
          snapshotArtifacts.push({ id, name, kind: 'image', path: null, sizeBytes: bytes.byteLength, page: pageNumber, sourceFileId: input.id });
          const percent = Math.round(((inputIndex + (pageIndex + 1) / selection.length) / inputs.length) * 100);
          const now = Date.now();
          if (now - lastEmit >= 120 || percent >= 100) {
            lastEmit = now;
            publish({ state: 'running', percent, phase: 'render', current: exported, total: selection.length * inputs.length });
          }
        }
      } finally {
        if (document) await document.destroy();
        else await loading.destroy();
      }
    }
  } catch (error) {
    if (error instanceof JobFailure) return failed(error.code, error.message, error.hintKey);
    const message = errorMessage(error);
    if (error instanceof PageRangeError) return failed('bad_page_range', message, 'error.badRange');
    return failed(/password/i.test(message) ? 'encrypted_document' : 'internal', message);
  }

  const inputBytes = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
  const outputBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0);
  const snapshot: JobSnapshot = {
    ...base,
    artifacts: snapshotArtifacts,
    finishedAt: Date.now(),
    progress: { state: 'succeeded', percent: 100, phase: 'done' },
    summary: {
      inputBytes,
      outputBytes,
      pageCountIn: 0,
      pageCountOut: exported,
      sizeDeltaPercent: inputBytes > 0 ? Math.round(((outputBytes - inputBytes) / inputBytes) * 100) : 0,
      extra: { images: exported, dpi },
    },
    warnings: [],
  };
  return { handled: true, snapshot, artifacts };
}
