import { PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num } from '../lib/options.ts';
import { stripXmp } from '../lib/pdf.ts';
import type { ToolImpl, ToolResult } from '../types.ts';

interface RecompressOptions {
  maxEdge: number;
  quality: number;
}

async function recompressImages(
  doc: PDFDocument,
  options: RecompressOptions,
): Promise<{ replaced: number; skipped: number }> {
  let replaced = 0;
  let skipped = 0;
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    if (dict.get(PDFName.of('ImageMask'))?.toString() === 'true') continue;
    if (dict.get(PDFName.of('Filter'))?.toString() !== '/DCTDecode'
      || dict.get(PDFName.of('SMask'))
      || dict.get(PDFName.of('BitsPerComponent'))?.toString() !== '8') {
      skipped += 1;
      continue;
    }
    const space = dict.get(PDFName.of('ColorSpace'))?.toString() ?? '';
    if (space !== '/DeviceRGB' && space !== '/DeviceGray') {
      skipped += 1;
      continue;
    }
    const bytes = object.contents;
    if (!bytes?.byteLength) {
      skipped += 1;
      continue;
    }
    let bitmap: ImageBitmap | undefined;
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      bitmap = await createImageBitmap(new Blob([copy.buffer], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
      if (bitmap.width * bitmap.height > 80_000_000) throw new InMemoryFallback('embedded JPEG exceeds the browser decode budget');
      const scale = Math.min(1, options.maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      if (width === bitmap.width && height === bitmap.height) {
        skipped += 1;
        continue;
      }
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new InMemoryFallback('PDF image compression canvas unavailable');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: options.quality / 100 });
      if (blob.type !== 'image/jpeg') throw new InMemoryFallback('browser JPEG encoder unavailable');
      const shrunk = new Uint8Array(await blob.arrayBuffer());
      if (shrunk.byteLength >= bytes.byteLength) {
        skipped += 1;
        continue;
      }
      dict.set(PDFName.of('Width'), PDFNumber.of(width));
      dict.set(PDFName.of('Height'), PDFNumber.of(height));
      dict.set(PDFName.of('Length'), PDFNumber.of(shrunk.byteLength));
      doc.context.assign(ref, PDFRawStream.of(dict, shrunk));
      replaced += 1;
    } catch (error) {
      if (error instanceof InMemoryFallback) throw error;
      skipped += 1;
    } finally {
      bitmap?.close();
    }
  }
  return { replaced, skipped };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value === 0) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

export const embeddedCompressTool: ToolImpl = {
  id: 'compress',
  async run(ctx): Promise<ToolResult> {
    const resample = bool(ctx.options, 'resampleImages');
    if (resample && (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function')) {
      throw new InMemoryFallback('browser image codec unavailable');
    }
    const quality = resample ? clampNumber(num(ctx.options, 'imageQuality'), 20, 96, 70) : 100;
    const dpi = resample ? clampNumber(num(ctx.options, 'maxDpi'), 72, 300, 150) : 300;
    const maxEdge = Math.round((dpi / 72) * 612);
    const objectStreams = bool(ctx.options, 'objectStreams');
    let totalIn = 0;
    let totalOut = 0;
    let imagesReplaced = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const stats = resample ? await recompressImages(doc, { maxEdge, quality }) : { replaced: 0, skipped: 0 };
      if (stats.skipped) ctx.warnings.push(`${baseName(input.name)}：${stats.skipped} 张图片因带透明度/特殊色彩空间被跳过`);
      imagesReplaced += stats.replaced;
      if (bool(ctx.options, 'stripMetadata')) {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setKeywords([]);
        stripXmp(doc);
      }
      doc.setProducer('PoTools');
      const bytes = await doc.save({ useObjectStreams: objectStreams, addDefaultPage: false });
      totalIn += input.bytes.byteLength;
      totalOut += bytes.byteLength;
      if (bytes.byteLength > input.bytes.byteLength) {
        ctx.warnings.push(`${baseName(input.name)}：已优化结构但体积变大 ${((bytes.byteLength / input.bytes.byteLength - 1) * 100).toFixed(1)}%，可保留原文件`);
      }
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'compressed' }, 'pdf'), bytes, input.id);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    if (!ctx.inputs.length) throw new EngineError('bad_request', '请先添加文件');
    return { extra: { savedPercent: totalIn ? Math.round(((totalIn - totalOut) / totalIn) * 100) : 0, imagesReplaced } };
  },
};
