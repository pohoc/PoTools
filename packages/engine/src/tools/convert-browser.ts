import { parsePageRanges } from '@potools/core';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { rgb } from 'pdf-lib';
import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { createDocument } from '../lib/pdf.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, hexToRgb, num, str } from '../lib/options.ts';
import type { ResolvedInput, ToolContext, ToolImpl } from '../types.ts';
import { browserImageHasAlpha, openBrowserRaster } from './image-browser.ts';

type RasterFormat = 'jpeg' | 'png' | 'webp' | 'tiff';
type EncodableRasterFormat = Exclude<RasterFormat, 'tiff'>;
const MIME: Record<EncodableRasterFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT: Record<EncodableRasterFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MAX_PIXELS = 24_000_000;
const MAX_EDGE = 6000;
const PT_PER_PX = 72 / 96;
const MAX_PAGE_PT = 2400;

function rasterScale(base: number, width: number, height: number): number {
  let scale = Math.min(base, MAX_EDGE / Math.max(1, width), MAX_EDGE / Math.max(1, height));
  scale = Math.min(scale, Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
  return Math.max(0.05, scale);
}

const pdfToImages: ToolImpl = {
  id: 'pdf-to-images',
  async run(ctx) {
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const format = str(ctx.options, 'format') as EncodableRasterFormat;
    const dpi = Math.max(48, num(ctx.options, 'dpi'));
    const quality = num(ctx.options, 'quality');
    const transparent = bool(ctx.options, 'transparentBackground') && format !== 'jpeg';
    let exported = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      let loading: ReturnType<typeof getDocument> | undefined;
      let document: Awaited<ReturnType<typeof getDocument>['promise']> | undefined;
      try {
        const copy = new Uint8Array(input.bytes);
        loading = getDocument({ data: copy, password: ctx.globals.password ?? undefined, isEvalSupported: false });
        document = await loading.promise;
        const selection = parsePageRanges(str(ctx.options, 'pages'), document.numPages);
        const stem = baseName(input.name);
        for (const [pageIndex, pageNumber] of selection.entries()) {
          if (ctx.cancelled()) break;
          const page = await document.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = rasterScale(dpi / 72, baseViewport.width, baseViewport.height);
          const viewport = page.getViewport({ scale });
          const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
          const context = canvas.getContext('2d', { alpha: transparent });
          if (!context) throw new InMemoryFallback('PDF page canvas is unavailable');
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
          if (blob.type !== MIME[format]) throw new InMemoryFallback(`browser cannot encode ${format}`);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          exported += 1;
          await ctx.emit({
            name: renderName(
              ctx.namePattern,
              {
                name: stem,
                tool: `p${String(pageNumber).padStart(2, '0')}`,
                index: pageIndex + 1,
                total: selection.length,
                range: String(pageNumber),
              },
              EXT[format],
            ),
            kind: 'image',
            bytes,
            page: pageNumber,
            sourceFileId: input.id,
          });
          page.cleanup();
          ctx.report({
            percent: Math.round(((index + (pageIndex + 1) / selection.length) / ctx.inputs.length) * 100),
            phase: 'render',
            current: exported,
            total: selection.length * ctx.inputs.length,
          });
        }
      } catch (error) {
        if (error instanceof InMemoryFallback) throw error;
        throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
      } finally {
        if (document) await document.destroy();
        else if (loading) await loading.destroy();
      }
    }
    return { pageCountOut: exported, extra: { images: exported, dpi } };
  },
};

interface PagePlan {
  box: { width: number; height: number };
  draw: { x: number; y: number; width: number; height: number };
  coverAspect?: number;
}

function planPage(
  meta: { width: number; height: number },
  options: { pageSize: string; orientation: string; fit: string; margin: number },
): PagePlan {
  const margin = Math.max(0, options.margin);
  const landscapeSource = meta.width >= meta.height;
  let box: { width: number; height: number };
  if (options.pageSize === 'auto') {
    const raw = { width: meta.width * PT_PER_PX, height: meta.height * PT_PER_PX };
    const cap = Math.max(raw.width, raw.height) / MAX_PAGE_PT;
    box = cap > 1 ? { width: raw.width / cap, height: raw.height / cap } : raw;
  } else {
    const preset = options.pageSize === 'letter' ? { width: 612, height: 792 } : { width: 595.28, height: 841.89 };
    const landscape = options.orientation === 'landscape' || (options.orientation === 'auto' && landscapeSource);
    box = landscape ? { width: preset.height, height: preset.width } : { width: preset.width, height: preset.height };
  }

  const available = { width: box.width - margin * 2, height: box.height - margin * 2 };
  if (options.fit === 'cover') {
    return { box, draw: { x: margin, y: margin, width: available.width, height: available.height }, coverAspect: available.width / available.height };
  }
  const scale = Math.min(available.width / box.width, available.height / box.height, 1);
  const width = box.width * scale;
  const height = box.height * scale;
  return { box, draw: { x: margin + (available.width - width) / 2, y: margin + (available.height - height) / 2, width, height } };
}

function coverImage(bitmap: ImageBitmap, aspect: number, quality: number): Promise<Blob> {
  const targetWidth = Math.min(4200, Math.round(Math.max(bitmap.width, bitmap.height * aspect)));
  const targetHeight = Math.max(1, Math.round(targetWidth / aspect));
  const sourceAspect = bitmap.width / bitmap.height;
  const cropWidth = sourceAspect > aspect ? bitmap.height * aspect : bitmap.width;
  const cropHeight = sourceAspect > aspect ? bitmap.height : bitmap.width / aspect;
  const sourceX = (bitmap.width - cropWidth) / 2;
  const sourceY = (bitmap.height - cropHeight) / 2;
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new InMemoryFallback('image crop canvas is unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(bitmap, sourceX, sourceY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
}

async function prepareImage(
  input: ResolvedInput,
  original: ImageBitmap,
  originalFormat: RasterFormat,
  quality: number,
  background: string,
  coverAspect?: number,
): Promise<{ bytes: Uint8Array; format: 'jpeg' | 'png' }> {
  let source = original;
  let ownedSource = false;
  try {
    if (coverAspect) {
      const blob = await coverImage(source, coverAspect, quality);
      if (blob.type !== 'image/jpeg') throw new InMemoryFallback('browser cannot encode JPEG');
      source = await createImageBitmap(blob);
      ownedSource = true;
    }

    const maxPixels = 20_000_000;
    const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, source.width * source.height)));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const alpha = !coverAspect && browserImageHasAlpha(input, originalFormat);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha });
    if (!context) throw new InMemoryFallback('image embedding canvas is unavailable');
    if (!alpha) {
      context.fillStyle = coverAspect ? '#ffffff' : background;
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(source, 0, 0, width, height);
    const kind = alpha ? 'png' : 'jpeg';
    const blob = await canvas.convertToBlob({ type: MIME[kind], quality: kind === 'png' ? undefined : quality / 100 });
    if (blob.type !== MIME[kind]) throw new InMemoryFallback(`browser cannot encode ${kind}`);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), format: kind };
  } finally {
    if (ownedSource) source.close();
  }
}

const imagesToPdf: ToolImpl = {
  id: 'images-to-pdf',
  async run(ctx) {
    const pageSize = str(ctx.options, 'pageSize');
    const orientation = str(ctx.options, 'orientation');
    const fit = str(ctx.options, 'fit');
    const margin = num(ctx.options, 'margin');
    const quality = num(ctx.options, 'imageQuality');
    const background = str(ctx.options, 'background') || '#ffffff';
    const out = await createDocument();

    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      try {
        const opened = await openBrowserRaster(input);
        try {
          const meta = { width: opened.bitmap.width, height: opened.bitmap.height };
          const plan = planPage(meta, { pageSize, orientation, fit, margin });
          const prepared = await prepareImage(input, opened.bitmap, opened.format, quality, background, plan.coverAspect);
          const image = prepared.format === 'jpeg' ? await out.embedJpg(prepared.bytes) : await out.embedPng(prepared.bytes);
          const page = out.addPage([plan.box.width, plan.box.height]);
          if (background !== '#ffffff') {
            const color = hexToRgb(background);
            page.drawRectangle({ x: 0, y: 0, width: plan.box.width, height: plan.box.height, color: rgb(color.r, color.g, color.b) });
          }
          page.drawImage(image, plan.draw);
          ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), phase: 'embed', current: index + 1, total: ctx.inputs.length });
        } finally {
          opened.bitmap.close();
        }
      } catch (error) {
        if (error instanceof InMemoryFallback) throw error;
        throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
      }
    }
    if (!out.getPageCount()) throw new EngineError('empty_selection', '没有可写入的图片');
    const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
    const stem = baseName(ctx.inputs[0]?.name ?? 'images');
    const label = ctx.inputs.length > 1 ? `${stem}-${ctx.inputs.length}pages` : stem;
    await ctx.emitPdf(renderName(ctx.namePattern, { name: label, tool: 'images' }, 'pdf'), bytes);
    return { pageCountOut: out.getPageCount(), extra: { images: ctx.inputs.length } };
  },
};

export const embeddedConvertTools: ToolImpl[] = [pdfToImages, imagesToPdf];
