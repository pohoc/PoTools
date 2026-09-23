import { PDFDict, PDFDocument, PDFName, PDFObject, PDFRawStream, PDFStream } from 'pdf-lib';
import { parsePageRanges } from '@potools/core';
import { loadPdf } from '../lib/files.ts';
import { createDocument, copyPagesInto, stripXmp } from '../lib/pdf.ts';
import { normalizePdfBytes, openRaster } from '../lib/render.ts';
import { getSharp, transcodePng, type RasterFormat } from '../lib/images.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num, str } from '../lib/options.ts';
import { EngineError } from '../errors.ts';
import type { ToolImpl } from '../types.ts';

const IMAGE_EXTS: Record<string, string> = {
  DCTDecode: 'jpg',
  JPXDecode: 'jp2',
  JBIG2Decode: 'jb2',
  CCITTFaxDecode: 'tif',
  FlateDecode: 'png',
};

/** Form XObjects may nest; the depth cap keeps a cyclic resource tree from looping. */
const XOBJECT_DEPTH = 4;

/** Image streams one page references, including images nested in form XObjects. */
function pageImages(doc: PDFDocument, page: number): PDFRawStream[] {
  const found: PDFRawStream[] = [];
  const asDict = (value: PDFObject | undefined): PDFDict | undefined => {
    const resolved = doc.context.lookup(value);
    return resolved instanceof PDFDict ? resolved : undefined;
  };
  const walk = (resources: PDFDict | undefined, depth: number): void => {
    if (!resources || depth > XOBJECT_DEPTH) return;
    const xobjects = asDict(resources.get(PDFName.of('XObject')));
    if (!xobjects) return;
    for (const name of xobjects.keys()) {
      const entry = doc.context.lookup(xobjects.get(name));
      if (!(entry instanceof PDFStream)) continue;
      const subtype = String(entry.dict.get(PDFName.of('Subtype')) ?? '');
      if (subtype === '/Image') {
        if (entry instanceof PDFRawStream) found.push(entry);
      } else if (subtype === '/Form') {
        // A form without its own Resources inherits the page's, per the PDF spec.
        walk(asDict(entry.dict.get(PDFName.of('Resources'))) ?? resources, depth + 1);
      }
    }
  };
  walk(asDict(doc.getPage(page - 1).node.Resources()), 0);
  return found;
}

/** Pulls the rasters referenced by the selected pages, skipping tiny artwork. */
const extractImages: ToolImpl = {
  id: 'extract-images',
  async run(ctx) {
    const sharp = await getSharp();
    const wanted = str(ctx.options, 'format');
    const minBytes = Math.max(0, num(ctx.options, 'minBytes')) * 1024;
    let emitted = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await loadPdf(input, ctx.globals);
      const stem = baseName(input.name);
      const selection = parsePageRanges(str(ctx.options, 'pages'), doc.getPageCount());
      const seen = new Set<PDFRawStream>();
      let counter = 0;
      for (const page of selection) {
        for (const object of pageImages(doc, page)) {
          if (seen.has(object)) continue;
          seen.add(object);
          const dict = object.dict;
          if (dict.get(PDFName.of('ImageMask'))?.toString() === 'true') continue;
          const bytes = object.contents;
          if (!bytes || bytes.byteLength < minBytes) continue;
          const filter = String(dict.get(PDFName.of('Filter'))?.toString() ?? '').replace('/', '');
          const native = IMAGE_EXTS[filter] ?? 'bin';
          if (native === 'bin') continue;
          counter += 1;
          emitted += 1;
          const name = `${stem}-img${String(counter).padStart(2, '0')}`;
          if (wanted === 'original' || !sharp) {
            await ctx.emit({ name: `${name}.${native}`, kind: 'image', bytes, page, sourceFileId: input.id });
            continue;
          }
          try {
            const png = await sharp(Buffer.from(bytes), { failOn: 'none' }).png().toBuffer();
            const converted = await transcodePng(new Uint8Array(png), { format: wanted as RasterFormat, quality: 90 });
            await ctx.emit({
              name: `${name}.${wanted === 'jpeg' ? 'jpg' : wanted}`,
              kind: 'image',
              bytes: converted,
              page,
              sourceFileId: input.id,
            });
          } catch {
            // Some codecs (JBIG2/CCITT) are not decodable by sharp: keep the original.
            await ctx.emit({ name: `${name}.${native}`, kind: 'image', bytes, page, sourceFileId: input.id });
          }
        }
      }
      if (!counter) ctx.warnings.push(`${stem}：未找到符合条件的图片`);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    if (!emitted) throw new EngineError('empty_selection', '没有可提取的图片');
    return { extra: { images: emitted } };
  },
};

const extractText: ToolImpl = {
  id: 'extract-text',
  async run(ctx) {
    const perPage = str(ctx.options, 'granularity') === 'per-page';
    const markers = bool(ctx.options, 'pageMarkers');
    const encoder = new TextEncoder();

    for (const [index, input] of ctx.inputs.entries()) {
      const raster = await openRaster(input.bytes, ctx.globals);
      const selection = parsePageRanges(str(ctx.options, 'pages'), raster.pageCount);
      const stem = baseName(input.name);
      const parts: string[] = [];
      let characters = 0;
      try {
        for (const [slot, page] of selection.entries()) {
          const text = raster.pageText(page);
          characters += text.length;
          if (perPage) {
            await ctx.emit({
              name: `${stem}-p${String(page).padStart(2, '0')}.txt`,
              kind: 'text',
              bytes: encoder.encode(text),
              page,
              sourceFileId: input.id,
            });
          } else {
            parts.push(markers && selection.length > 1 ? `--- ${page} ---\n${text}` : text);
          }
          ctx.report({ percent: Math.round(((index + slot + 1) / ctx.inputs.length) * 100) });
        }
      } finally {
        raster.close();
      }
      if (!perPage) {
        const body = parts.join('\n\n').trim();
        if (!body) throw new EngineError('empty_selection', `${stem} 中没有可提取的文字（可能是扫描件）`);
        await ctx.emit({ name: `${stem}.txt`, kind: 'text', bytes: encoder.encode(body + '\n'), sourceFileId: input.id });
      }
      if (!characters) ctx.warnings.push(`${stem}：未提取到文字层`);
    }
    return {};
  },
};

/** A page counts as blank when almost no pixel differs from the background. */
const removeBlank: ToolImpl = {
  id: 'remove-blank',
  async run(ctx) {
    const tolerance = Math.max(0, num(ctx.options, 'tolerance')) / 100;
    const reportOnly = bool(ctx.options, 'reportOnly');
    let blankTotal = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await loadPdf(input, ctx.globals);
      const raster = await openRaster(input.bytes, ctx.globals);
      const blank: number[] = [];
      try {
        for (let page = 1; page <= raster.pageCount; page += 1) {
          const ink = await raster.inkRatio(page);
          if (ink <= tolerance) blank.push(page);
          ctx.report({ percent: Math.round(((index + page / raster.pageCount) / ctx.inputs.length) * 80) });
        }
      } finally {
        raster.close();
      }
      blankTotal += blank.length;
      const label = blank.length ? blank.join(', ') : '无';
      if (reportOnly) {
        const json = new TextEncoder().encode(
          JSON.stringify({ file: input.name, pages: doc.getPageCount(), blankPages: blank }, null, 2),
        );
        await ctx.emit({ name: `${baseName(input.name)}-blank-report.json`, kind: 'json', bytes: json, sourceFileId: input.id });
        ctx.warnings.push(`${baseName(input.name)}：检测到 ${blank.length} 个空白页（${label}）`);
        continue;
      }
      if (blank.length >= doc.getPageCount()) throw new EngineError('empty_selection', '全部页面都被判为空白，已停止');
      const out = await createDocument();
      const keep = doc.getPageCount() ? Array.from({ length: doc.getPageCount() }, (_, i) => i + 1).filter((p) => !blank.includes(p)) : [];
      await copyPagesInto(out, doc, keep);
      const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'no-blank' }, 'pdf'), bytes, input.id);
      ctx.warnings.push(`${baseName(input.name)}：已删除 ${blank.length} 个空白页（${label}）`);
    }
    return { extra: { blankPages: blankTotal } };
  },
};

/** Rewrites the file through MuPDF, which rebuilds broken xrefs and streams. */
const repair: ToolImpl = {
  id: 'repair',
  async run(ctx) {
    for (const [index, input] of ctx.inputs.entries()) {
      const before = input.bytes.byteLength;
      // MuPDF rebuilds the xref table and Flate-compresses content streams, so
      // route the bytes through it before handing them back to pdf-lib.
      const source = bool(ctx.options, 'recompress')
        ? { ...input, bytes: await normalizePdfBytes(input.bytes, input.name) }
        : input;
      const doc = await loadPdf(source, ctx.globals);
      if (!doc.getPageCount()) {
        throw new EngineError(
          'unreadable_file',
          `${baseName(input.name)}：文档结构损坏严重，重建后没有任何页面可恢复`,
        );
      }
      if (bool(ctx.options, 'stripMetadata')) {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setKeywords([]);
        stripXmp(doc);
      }
      doc.setProducer('PoTools');
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'repaired' }, 'pdf'),
        bytes,
        input.id,
      );
      const ratio = before ? Math.round(((bytes.byteLength - before) / before) * 100) : 0;
      if (ratio > 5) ctx.warnings.push(`${baseName(input.name)}：结构已重建，体积增加 ${ratio}%`);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return {};
  },
};

export const extractTools: ToolImpl[] = [extractImages, extractText, removeBlank, repair];
