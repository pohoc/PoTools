import { parsePageRanges } from '@potools/core';
import { PDFDict, PDFName, PDFObject, PDFRawStream, PDFStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { EngineError } from '../errors.ts';
import { baseName } from '../lib/naming.ts';
import type { ToolImpl } from '../types.ts';
import { num, str } from '../lib/options.ts';

type ExtractImageFormat = 'original' | 'jpeg' | 'png' | 'webp';
type BrowserExtractFormat = Exclude<ExtractImageFormat, 'original'>;

const IMAGE_EXTS: Record<string, string> = {
  DCTDecode: 'jpg',
  JPXDecode: 'jp2',
  JBIG2Decode: 'jb2',
  CCITTFaxDecode: 'tif',
  FlateDecode: 'png',
};

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const OUTPUT_MIME: Record<BrowserExtractFormat, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
const OUTPUT_EXT: Record<BrowserExtractFormat, string> = {
  jpeg: 'jpg', png: 'png', webp: 'webp',
};
const XOBJECT_DEPTH = 4;

function asDict(doc: PDFDocument, value: PDFObject | undefined): PDFDict | undefined {
  const resolved = doc.context.lookup(value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

function pageImages(doc: PDFDocument, page: number): PDFRawStream[] {
  const found: PDFRawStream[] = [];
  const walk = (resources: PDFDict | undefined, depth: number): void => {
    if (!resources || depth > XOBJECT_DEPTH) return;
    const xobjects = asDict(doc, resources.get(PDFName.of('XObject')));
    if (!xobjects) return;
    for (const name of xobjects.keys()) {
      const entry = doc.context.lookup(xobjects.get(name));
      if (!(entry instanceof PDFStream)) continue;
      const subtype = String(entry.dict.get(PDFName.of('Subtype')) ?? '');
      if (subtype === '/Image') {
        if (entry instanceof PDFRawStream) found.push(entry);
      } else if (subtype === '/Form') {
        walk(asDict(doc, entry.dict.get(PDFName.of('Resources'))) ?? resources, depth + 1);
      }
    }
  };
  walk(asDict(doc, doc.getPage(page - 1).node.Resources()), 0);
  return found;
}

async function convert(bytes: Uint8Array, native: string, format: BrowserExtractFormat): Promise<Uint8Array> {
  const mime = MIME_TYPES[native];
  if (!mime || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') throw new Error('unsupported-raster');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const bitmap = await createImageBitmap(new Blob([copy.buffer], { type: mime }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 16000 || bitmap.height > 16000 || bitmap.width * bitmap.height > 120_000_000) {
      throw new Error('image-size-limit');
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: format === 'png' });
    if (!context) throw new Error('canvas-unavailable');
    if (format !== 'png') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, bitmap.width, bitmap.height);
    }
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: OUTPUT_MIME[format], quality: format === 'png' ? undefined : 0.9 });
    if (blob.type !== OUTPUT_MIME[format]) throw new Error('unsupported-output-format');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** Extracts original PDF image streams in memory; supported raster inputs can be converted by Canvas. */
export const embeddedExtractImagesTool: ToolImpl = {
  id: 'extract-images',
  async run(ctx) {
    const wanted = str(ctx.options, 'format') as ExtractImageFormat;
    const minBytes = Math.max(0, num(ctx.options, 'minBytes')) * 1024;
    let emitted = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input);
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
          if (wanted === 'original') {
            await ctx.emit({ name: `${name}.${native}`, kind: 'image', bytes, page, sourceFileId: input.id });
            continue;
          }
          try {
            const format = wanted as BrowserExtractFormat;
            const converted = await convert(bytes, native, format);
            await ctx.emit({ name: `${name}.${OUTPUT_EXT[format]}`, kind: 'image', bytes: converted, page, sourceFileId: input.id });
          } catch {
            // Match the native engine: unsupported/invalid image codecs remain available in their original form.
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
