import { PDFName, PDFNumber, PDFRawStream, type PDFDocument } from 'pdf-lib';
import { loadPdf } from '../lib/files.ts';
import { readMetadata, stripXmp, clearInfoDates } from '../lib/pdf.ts';
import { rescale } from '../lib/images.ts';
import { bool, num, str } from '../lib/options.ts';
import { baseName, renderName } from '../lib/naming.ts';
import type { ToolImpl, ToolResult } from '../types.ts';
import { EngineError } from '../errors.ts';

const metadata: ToolImpl = {
  id: 'metadata',
  async run(ctx): Promise<ToolResult> {
    const mode = str(ctx.options, 'mode');
    const report: Record<string, unknown> = {};

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await loadPdf(input, ctx.globals);
      const info = readMetadata(doc);
      if (mode === 'read') {
        report[baseName(input.name)] = { pages: doc.getPageCount(), ...info };
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100) });
        continue;
      }

      if (mode === 'clear') {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setKeywords([]);
        doc.setCreator('');
        doc.setProducer('');
        clearInfoDates(doc);
      } else {
        const title = str(ctx.options, 'title').trim();
        if (title) doc.setTitle(title);
        const author = str(ctx.options, 'author').trim();
        if (author) doc.setAuthor(author);
        const subject = str(ctx.options, 'subject').trim();
        if (subject) doc.setSubject(subject);
        const keywords = str(ctx.options, 'keywords').trim();
        if (keywords) doc.setKeywords(splitList(keywords));
        const creator = str(ctx.options, 'creator').trim();
        if (creator) doc.setCreator(creator);
        const producer = str(ctx.options, 'producer').trim();
        if (producer) doc.setProducer(producer);
      }
      if (bool(ctx.options, 'stripXmp')) stripXmp(doc);
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: mode === 'clear' ? 'clean' : 'meta' }, 'pdf'),
        bytes,
        input.id,
      );
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100) });
    }

    if (mode === 'read') {
      if (!Object.keys(report).length) throw new EngineError('bad_request', '没有可读取的文档');
      const json = new TextEncoder().encode(JSON.stringify(report, null, 2));
      await ctx.emit({ name: 'document-info.json', kind: 'json', bytes: json });
      return { extra: { documents: Object.keys(report).length } };
    }
    return { extra: { mode } };
  },
};

function splitList(value: string): string[] {
  return value
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Re-encodes embedded JPEG images that are larger or lower quality than the
 * target settings allow. Images with transparency, JPX, CMYK or 16-bit depth
 * are left untouched rather than risk visual damage.
 */
async function recompressImages(
  doc: PDFDocument,
  options: { maxEdge: number; quality: number },
): Promise<{ replaced: number; skipped: number; savedBytes: number }> {
  let replaced = 0;
  let skipped = 0;
  let savedBytes = 0;

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    if (dict.get(PDFName.of('ImageMask'))?.toString() === 'true') continue;
    if (dict.get(PDFName.of('Filter'))?.toString() !== '/DCTDecode') {
      skipped += 1;
      continue;
    }
    if (dict.get(PDFName.of('SMask'))) {
      skipped += 1;
      continue;
    }
    if (dict.get(PDFName.of('BitsPerComponent'))?.toString() !== '8') {
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
    try {
      const shrunk = await rescale(bytes, { maxEdge: options.maxEdge, quality: options.quality });
      if (shrunk.bytes.byteLength >= bytes.byteLength || !shrunk.width) {
        skipped += 1;
        continue;
      }
      // Replace the stream in place: pdf-lib never garbage-collects orphaned
      // objects, so registering a second image stream would keep the original
      // bytes in the file and make the output larger.
      dict.set(PDFName.of('Width'), PDFNumber.of(shrunk.width));
      dict.set(PDFName.of('Height'), PDFNumber.of(shrunk.height));
      dict.set(PDFName.of('Length'), PDFNumber.of(shrunk.bytes.byteLength));
      doc.context.assign(ref, PDFRawStream.of(dict, shrunk.bytes));
      savedBytes += bytes.byteLength - shrunk.bytes.byteLength;
      replaced += 1;
    } catch {
      skipped += 1;
    }
  }
  return { replaced, skipped, savedBytes };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value === 0) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

const compress: ToolImpl = {
  id: 'compress',
  async run(ctx): Promise<ToolResult> {
    const resample = bool(ctx.options, 'resampleImages');
    const quality = resample ? clampNumber(num(ctx.options, 'imageQuality'), 20, 96, 70) : 100;
    const dpi = resample ? clampNumber(num(ctx.options, 'maxDpi'), 72, 300, 150) : 300;
    // Without layout analysis the page box is used as the size reference, so a
    // full-page image ends up near the target dpi and larger ones shrink.
    const maxEdge = Math.round((dpi / 72) * 612);
    const objectStreams = bool(ctx.options, 'objectStreams');
    let totalIn = 0;
    let totalOut = 0;
    let imagesReplaced = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await loadPdf(input, ctx.globals);
      const stats = resample
        ? await recompressImages(doc, { maxEdge, quality })
        : { replaced: 0, skipped: 0, savedBytes: 0 };
      if (stats.skipped) {
        ctx.warnings.push(`${baseName(input.name)}：${stats.skipped} 张图片因带透明度/特殊色彩空间被跳过`);
      }
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
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'compressed' }, 'pdf'),
        bytes,
        input.id,
      );
      ctx.report({
        percent: Math.round(((index + 1) / ctx.inputs.length) * 100),
        current: index + 1,
        total: ctx.inputs.length,
      });
    }
    return {
      extra: {
        savedPercent: totalIn ? Math.round(((totalIn - totalOut) / totalIn) * 100) : 0,
        imagesReplaced,
      },
    };
  },
};

export const docTools: ToolImpl[] = [metadata, compress];
