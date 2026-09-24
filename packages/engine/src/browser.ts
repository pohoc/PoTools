import type { JobRequest, JobSnapshot, PageThumb, ProbedPdf, RpcMethodName, ToolId } from '@potools/core';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EngineError } from './errors.ts';
import { runInMemoryJob, type InMemoryJobResult } from './lib/memory-job.ts';
import { hasUniformSize, loadDocument, pagesInfo, readMetadata } from './lib/pdf.ts';
import { normalizePdfBytes } from './lib/render.ts';
import type { ResolvedInput } from './types.ts';
import type { TextRunRequest } from './lib/text-run.ts';
import { runTextToolWithImplementations } from './lib/text-run.ts';
import { canRunEmbeddedFileJob, canRunEmbeddedRpc } from './browser-capabilities.ts';
import { canDecodeBrowserRaster } from './tools/image-browser.ts';
import { canRunBrowserOcr } from './tools/ocr-browser.ts';
import { embeddedFileToolImplementations, embeddedTextToolImplementations } from './embedded-registry.ts';
import { analyzeInvoiceCandidate, type InvoiceScanCandidate } from './tools/invoice-scan-browser.ts';
import { detectBrowserRaster, openBrowserRaster } from './tools/image-browser.ts';

export type { TextRunRequest } from './lib/text-run.ts';
export type { ResolvedInput } from './types.ts';
export type { InMemoryJobResult, MemoryArtifact } from './lib/memory-job.ts';

export interface EmbeddedRpcRequest {
  method: RpcMethodName;
  params: Record<string, unknown>;
}

export interface EmbeddedRpcReply {
  handled: boolean;
  result?: unknown;
  jobResult?: InMemoryJobResult;
}

export interface EmbeddedRpcHost {
  inputs?: ResolvedInput[];
  onProgress?: (snapshot: JobSnapshot) => void;
  isCancelled?: () => boolean;
  runtimeData?: Record<string, unknown>;
}

/** One RPC entry for the in-process runtime; unsupported methods remain host-routable. */
export async function dispatchEmbeddedRpc(request: EmbeddedRpcRequest, host: EmbeddedRpcHost = {}): Promise<EmbeddedRpcReply> {
  if (!canRunEmbeddedRpc(request)) return { handled: false };
  switch (request.method) {
    case 'tool.run': {
      const result = await runEmbeddedTextTool({
        tool: request.params.tool as ToolId,
        options: (request.params.options ?? {}) as Record<string, unknown>,
        globals: request.params.globals as TextRunRequest['globals'],
      }, host.runtimeData);
      return result ? { handled: true, result } : { handled: false };
    }
    case 'job.submit': {
      const job = request.params.job as JobRequest;
      const inputs = host.inputs;
      if (!job || !canRunEmbeddedFileJob(job.tool, job.options) || !inputs) return { handled: false };
      if (job.tool === 'ocr-text' || job.tool === 'ocr-table') {
        if (!await canRunBrowserOcr(inputs)) return { handled: false };
      }
      if ((job.tool.startsWith('image-') || job.tool === 'images-to-pdf') && !await canDecodeBrowserRaster(inputs, job.tool === 'image-watermark-clean' || job.tool === 'image-id-photo' || job.tool === 'images-to-pdf' ? 20_000_000 : 120_000_000, job.tool, job.options)) return { handled: false };
      const jobResult = await runInMemoryJob(
        job,
        inputs,
        embeddedFileToolImplementations,
        host.onProgress,
        host.isCancelled,
        host.runtimeData,
      );
      return jobResult.handled ? { handled: true, jobResult } : { handled: false };
    }
    case 'invoice.scan': {
      const candidate = request.params.file as (InvoiceScanCandidate & { changedWhileReading?: boolean }) | undefined;
      const input = host.inputs?.[0];
      if (!candidate || !input) return { handled: false };
      const result = await analyzeInvoiceCandidate(candidate, input, candidate.changedWhileReading === true);
      return { handled: true, result };
    }
    case 'page.thumbs': {
      const file = request.params.file as { id?: string; name?: string } | undefined;
      const input = host.inputs?.find((item) => item.id === file?.id) ?? host.inputs?.[0];
      const workerSrc = request.params.workerSrc;
      if (!file || !input) return { handled: false };
      const signature = new TextDecoder().decode(input.bytes.subarray(0, 1024));
      if (typeof OffscreenCanvas === 'undefined') return { handled: false };
      if (!signature.includes('%PDF-')) {
        const requested = Array.isArray(request.params.pages) ? request.params.pages.map(Number) : [];
        if (!requested.length || !requested.includes(1)) return { handled: true, result: [] };
        const result = await renderRasterThumb(input, request.params);
        return result ? { handled: true, result: [result] } : { handled: false };
      }
      if (typeof workerSrc !== 'string' || !workerSrc) return { handled: false };
      try {
        const result = await renderPdfThumbs(input.bytes, request.params, workerSrc);
        return result ? { handled: true, result } : { handled: false };
      } catch {
        // Keep the native rasterizer's established handling for unusual PDFs.
        return { handled: false };
      }
    }
    case 'file.probe':
    case 'page.list': {
      const file = request.params.file as { id?: string; name?: string } | undefined;
      const input = host.inputs?.find((item) => item.id === file?.id) ?? host.inputs?.[0];
      if (!file || !input) return { handled: false };
      let doc;
      try {
        doc = await loadEmbeddedPdf(input.bytes, input.name);
      } catch (error) {
        if (error instanceof EngineError && error.code === 'encrypted_document') throw error;
        // Keep MuPDF normalization and its established errors in the legacy host.
        return { handled: false };
      }
      const pages = pagesInfo(doc);
      if (request.method === 'page.list') {
        return { handled: true, result: { pageCount: pages.length, pages } };
      }
      const result: ProbedPdf = {
        fileId: input.id,
        name: input.name,
        sizeBytes: input.bytes.byteLength,
        pageCount: pages.length,
        pages,
        metadata: readMetadata(doc),
        encrypted: false,
        uniformSize: hasUniformSize(doc),
      };
      return { handled: true, result };
    }
    default:
      return { handled: false };
  }
}

async function loadEmbeddedPdf(bytes: Uint8Array, label: string) {
  try {
    return await loadDocument(bytes, label);
  } catch (error) {
    if (!(error instanceof EngineError) || error.code === 'encrypted_document') throw error;
    const normalized = await normalizePdfBytes(bytes, label);
    try {
      return await loadDocument(normalized, label);
    } catch (retryError) {
      throw retryError instanceof EngineError ? error : retryError;
    }
  }
}

async function renderRasterThumb(
  input: ResolvedInput,
  params: Record<string, unknown>,
): Promise<PageThumb | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    const format = detectBrowserRaster(input.bytes);
    if (format) {
      bitmap = (await openBrowserRaster(input)).bitmap;
    } else if (typeof createImageBitmap === 'function') {
      const copy = new Uint8Array(input.bytes.byteLength);
      copy.set(input.bytes);
      bitmap = await createImageBitmap(new Blob([copy.buffer]), { imageOrientation: 'from-image' });
    }
    if (!bitmap) return null;

    const requestedWidth = Math.min(2400, Math.max(48, Number(params.width) || 160));
    const scale = Math.min(1, requestedWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if (width > 32767 || height > 32767) return null;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const usePng = params.format === 'png' || requestedWidth > 600;
    const mime = usePng ? 'image/png' : 'image/jpeg';
    const defaultQuality = requestedWidth > 600 ? 92 : 68;
    const quality = Math.min(95, Math.max(45, Number(params.quality) || defaultQuality));
    const blob = await canvas.convertToBlob({ type: mime, quality: usePng ? undefined : quality / 100 });
    if (blob.type !== mime) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      page: 1,
      dataUrl: `data:${mime};base64,${encodeBase64(bytes)}`,
      width: bitmap.width,
      height: bitmap.height,
      rotation: 0,
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

async function renderPdfThumbs(
  bytes: Uint8Array,
  params: Record<string, unknown>,
  workerSrc: string,
): Promise<PageThumb[] | null> {
  GlobalWorkerOptions.workerSrc = workerSrc;
  const requested = Array.isArray(params.pages) ? params.pages.map(Number) : [];
  if (!requested.length) return [];
  const width = Math.min(2400, Math.max(48, Number(params.width) || 160));
  const format = params.format === 'png' || width > 600 ? 'png' : 'jpeg';
  const quality = Math.min(95, Math.max(45, Number(params.quality) || (width > 600 ? 92 : 68)));
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const loading = getDocument({ data: copy, isEvalSupported: false });
  let document: Awaited<typeof loading.promise> | null = null;
  try {
    document = await loading.promise;
    const thumbs: PageThumb[] = [];
    for (const pageNumber of requested) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) continue;
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / Math.max(1, baseViewport.width) });
      const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return null;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        background: '#ffffff',
      }).promise;
      const mime = format === 'png' ? 'image/png' : 'image/jpeg';
      const blob = await canvas.convertToBlob({ type: mime, quality: quality / 100 });
      const imageBytes = new Uint8Array(await blob.arrayBuffer());
      thumbs.push({
        page: pageNumber,
        dataUrl: `data:${mime};base64,${encodeBase64(imageBytes)}`,
        width: canvas.width,
        height: canvas.height,
        rotation: 0,
      });
      page.cleanup();
    }
    return thumbs;
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function runEmbeddedTextTool(request: TextRunRequest, runtimeData?: Record<string, unknown>) {
  if (!embeddedTextToolImplementations[request.tool]) return null;
  return runTextToolWithImplementations(request, embeddedTextToolImplementations, runtimeData);
}

/** Memory-only PDF page jobs, available to the desktop worker host. */
export function runEmbeddedFileJob(
  request: JobRequest,
  inputs: ResolvedInput[],
  onUpdate?: (snapshot: JobSnapshot) => void,
  isCancelled?: () => boolean,
): Promise<InMemoryJobResult> {
  return runInMemoryJob(request, inputs, embeddedFileToolImplementations, onUpdate, isCancelled);
}
