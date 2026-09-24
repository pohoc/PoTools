import { getIdPhotoPrintSize, getIdPhotoSize, type ToolId } from '@potools/core';
import { EngineError } from '../errors.ts';
import { baseName, renderName } from '../lib/naming.ts';
import type { ResolvedInput, ToolContext, ToolImpl, ToolResult } from '../types.ts';
import { bool, num, str } from '../lib/options.ts';
import { isTiff, openTiffBitmap, readTiffInfo } from './tiff-browser.ts';
import UTIF from 'utif';
import jpeg from 'jpeg-js';

type RasterFormat = 'jpeg' | 'png' | 'webp' | 'tiff';
type BrowserRasterFormat = RasterFormat | 'other';
type EncodableRasterFormat = Exclude<RasterFormat, 'tiff'>;
const OUTPUT_MIME: Record<EncodableRasterFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT: Record<RasterFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', tiff: 'tiff' };
function requestedRasterFormat(value: string): RasterFormat | null {
  const normalized = value.toLowerCase();
  if (normalized === 'jpg') return 'jpeg';
  if (normalized === 'tif') return 'tiff';
  return normalized === 'jpeg' || normalized === 'png' || normalized === 'webp' || normalized === 'tiff'
    ? normalized
    : null;
}
type CanvasTarget = { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D };

export function detectBrowserRaster(bytes: Uint8Array): RasterFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  if (isTiff(bytes)) return 'tiff';
  return null;
}

export function browserImageHasAlpha(input: ResolvedInput, format = detectBrowserRaster(input.bytes)): boolean {
  return format ? imageChannels(input, format).hasAlpha : false;
}

export async function canDecodeBrowserRaster(
  inputs: ResolvedInput[],
  maxPixels = 120_000_000,
  tool?: ToolId,
  options: Record<string, unknown> = {},
): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined') return false;
  const bitmaps: ImageBitmap[] = [];
  try {
    for (const input of inputs) {
      const format = detectBrowserRaster(input.bytes);
      if (!format && tool !== 'image-convert') return false;
      if (format === 'tiff' && !canProcessTiffForTool(tool, options)) return false;
      const bitmap = format === 'tiff'
        ? (await openTiffBitmap(input.bytes, maxPixels)).bitmap
        : typeof createImageBitmap === 'function'
          ? await createImageBitmap(new Blob([new Uint8Array(input.bytes).buffer]))
          : null;
      if (!bitmap) return false;
      bitmaps.push(bitmap);
      if (bitmap.width * bitmap.height > maxPixels) return false;
    }
    return bitmaps.length > 0;
  } catch {
    return false;
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}

function canProcessTiffForTool(tool: ToolId | undefined, options: Record<string, unknown>): boolean {
  if (!tool) return false;
  if (['image-info', 'image-id-photo', 'image-cutout', 'image-print', 'image-watermark-clean', 'images-to-pdf', 'ocr-text', 'ocr-table'].includes(tool)) return true;
  if (tool === 'image-convert') return ['jpeg', 'jpg', 'png', 'webp', 'tiff', 'tif'].includes(String(options.format ?? 'webp').toLowerCase());
  if (tool === 'image-compress') return ['jpeg', 'jpg', 'png', 'webp', 'tiff', 'tif', 'original'].includes(String(options.format ?? 'original').toLowerCase());
  return false;
}

function imageChannels(input: ResolvedInput, format: RasterFormat): { channels: number; hasAlpha: boolean } {
  const bytes = input.bytes;
  if (format === 'tiff') {
    const info = readTiffInfo(bytes);
    return { channels: info.channels, hasAlpha: info.hasAlpha };
  }
  if (format === 'png' && bytes.length > 25) {
    const channels: Record<number, number> = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 };
    const colorType = bytes[25]!;
    const count = channels[colorType] ?? 4;
    let transparentPalette = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
      if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'tRNS') transparentPalette = true;
      if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'IEND' || length > bytes.length - offset - 12) break;
      offset += length + 12;
    }
    const alpha = colorType === 4 || colorType === 6 || (colorType === 3 && transparentPalette);
    return { channels: colorType === 3 && transparentPalette ? 4 : count, hasAlpha: alpha };
  }
  if (format === 'jpeg') {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { channels: bytes[offset + 9] ?? 3, hasAlpha: false };
      }
      offset += 2 + length;
    }
    return { channels: 3, hasAlpha: false };
  }
  const isExtendedWebp = String.fromCharCode(...bytes.subarray(12, 16)) === 'VP8X';
  const alpha = isExtendedWebp && Boolean((bytes[20] ?? 0) & 0x10);
  return { channels: alpha ? 4 : 3, hasAlpha: alpha };
}

function canvas(width: number, height: number, color?: string): CanvasTarget {
  if (width < 1 || height < 1 || width > 16000 || height > 16000 || width * height > 120_000_000) {
    throw new EngineError('bad_request', '图片尺寸超出浏览器内存处理范围');
  }
  const target = new OffscreenCanvas(width, height);
  const context = target.getContext('2d', { alpha: !color });
  if (!context) throw new EngineError('no_image_codec', '浏览器图片画布不可用');
  if (color) { context.fillStyle = color; context.fillRect(0, 0, width, height); }
  return { canvas: target, context };
}

export function openBrowserRaster(input: ResolvedInput): Promise<{ bitmap: ImageBitmap; format: RasterFormat }>;
export function openBrowserRaster(input: ResolvedInput, allowOther: boolean): Promise<{ bitmap: ImageBitmap; format: BrowserRasterFormat }>;
export async function openBrowserRaster(input: ResolvedInput, allowOther = false): Promise<{ bitmap: ImageBitmap; format: BrowserRasterFormat }> {
  const format = detectBrowserRaster(input.bytes);
  if (!format && !allowOther) throw new Error('fallback');
  if (format === 'tiff') return { ...(await openTiffBitmap(input.bytes)), format };
  if (typeof createImageBitmap !== 'function') throw new Error('fallback');
  try {
    return {
      bitmap: await createImageBitmap(new Blob([new Uint8Array(input.bytes).buffer]), { imageOrientation: 'from-image' }),
      format: format ?? 'other',
    };
  }
  catch { throw new Error('fallback'); }
}

async function encodeTiffJpeg(target: OffscreenCanvas, quality: number): Promise<Uint8Array> {
  // Match Sharp's JPEG-compressed TIFF output: the strip is RGB (no alpha),
  // uses JPEG quality, and transparency is composited against black.
  const flattened = canvas(target.width, target.height, '#000000');
  flattened.context.drawImage(target, 0, 0);
  const pixels = new Uint8Array(flattened.context.getImageData(0, 0, target.width, target.height).data);
  const global = globalThis as typeof globalThis & { Buffer?: { from(value: ArrayLike<number>): Uint8Array } };
  const originalBuffer = global.Buffer;
  if (!originalBuffer) Object.defineProperty(global, 'Buffer', { configurable: true, value: { from: (value: ArrayLike<number>) => Uint8Array.from(value) } });
  let jpegBytes: Uint8Array;
  try {
    jpegBytes = new Uint8Array(jpeg.encode({ data: pixels, width: target.width, height: target.height }, quality).data);
  } finally {
    if (!originalBuffer) Reflect.deleteProperty(global, 'Buffer');
  }

  const ifd = {
    t256: [target.width], t257: [target.height], t258: [8, 8, 8], t259: [7], t262: [2],
    t273: [0], t277: [3], t278: [target.height], t279: [jpegBytes.byteLength], t284: [1],
  };
  let header = UTIF.encode([ifd]);
  ifd.t273 = [header.byteLength];
  header = UTIF.encode([ifd]);
  const result = new Uint8Array(header.byteLength + jpegBytes.byteLength);
  result.set(new Uint8Array(header));
  result.set(jpegBytes, header.byteLength);
  return result;
}

async function encode(target: OffscreenCanvas, format: RasterFormat, quality: number, background: string): Promise<Uint8Array> {
  if (format === 'tiff') return encodeTiffJpeg(target, quality);
  if (format === 'jpeg') {
    const flattened = canvas(target.width, target.height, background);
    flattened.context.drawImage(target, 0, 0);
    target = flattened.canvas;
  }
  const blob = await target.convertToBlob({ type: OUTPUT_MIME[format], quality: Math.max(0.2, Math.min(1, quality / 100)) });
  if (blob.type !== OUTPUT_MIME[format]) throw new EngineError('no_image_codec', `浏览器不支持输出 ${format} 格式`);
  return new Uint8Array(await blob.arrayBuffer());
}

function setJpegDensity(bytes: Uint8Array, dpi: number): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const density = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (bytes.length >= 18 && bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.subarray(6, 11)) === 'JFIF\0') {
    const output = new Uint8Array(bytes);
    output[13] = 1;
    output[14] = density >>> 8; output[15] = density & 0xff;
    output[16] = density >>> 8; output[17] = density & 0xff;
    return output;
  }
  const segment = new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, density >>> 8, density & 0xff, density >>> 8, density & 0xff, 0x00, 0x00]);
  const output = new Uint8Array(bytes.length + segment.length);
  output.set(bytes.subarray(0, 2), 0); output.set(segment, 2); output.set(bytes.subarray(2), 2 + segment.length);
  return output;
}

async function emit(ctx: ToolContext, input: ResolvedInput, index: number, bytes: Uint8Array, format: RasterFormat, label: string): Promise<void> {
  const name = renderName(ctx.namePattern, { name: baseName(input.name), tool: label, index: index + 1, total: ctx.inputs.length }, EXT[format]);
  await ctx.emit({ name, kind: 'image', bytes, sourceFileId: input.id });
}

function progress(ctx: ToolContext, index: number, phase: string): void {
  ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), phase, current: index + 1, total: ctx.inputs.length });
}

async function runIdPhoto(ctx: ToolContext, input: ResolvedInput, bitmap: ImageBitmap): Promise<ToolResult> {
  const meta = imageChannels(input, detectBrowserRaster(input.bytes)!);
  if (meta.channels < 4) throw new EngineError('unreadable_file', '人物抠图结果没有透明通道，请重新识别人物。');
  const sourceCanvas = canvas(bitmap.width, bitmap.height);
  sourceCanvas.context.drawImage(bitmap, 0, 0);
  const source = sourceCanvas.context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  let left = bitmap.width; let top = bitmap.height; let right = -1; let bottom = -1;
  for (let y = 0; y < bitmap.height; y += 1) for (let x = 0; x < bitmap.width; x += 1) {
    if (source[(y * bitmap.width + x) * 4 + 3]! < 24) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) throw new EngineError('unreadable_file', '没有识别到人物，请换一张正面清晰的照片。');

  const size = getIdPhotoSize(ctx.options.size);
  const background = str(ctx.options, 'background') || '#438edb';
  const scale = Math.min(130, Math.max(70, num(ctx.options, 'scale') || 100)) / 100;
  const verticalOffset = Math.min(20, Math.max(-20, num(ctx.options, 'verticalOffset'))) / 100;
  const subjectWidth = right - left + 1; const subjectHeight = bottom - top + 1;
  const aspect = size.width / size.height;
  const cropHeight = Math.max(subjectHeight * 0.62, subjectWidth / aspect) / scale;
  const cropWidth = cropHeight * aspect;
  const cropX = Math.round((left + right + 1) / 2 - cropWidth / 2);
  const cropY = Math.round(top - cropHeight * 0.035 + cropHeight * verticalOffset);
  const cropW = Math.max(1, Math.round(cropWidth)); const cropH = Math.max(1, Math.round(cropHeight));
  const visibleLeft = Math.max(0, cropX); const visibleTop = Math.max(0, cropY);
  const visibleRight = Math.min(bitmap.width, cropX + cropW); const visibleBottom = Math.min(bitmap.height, cropY + cropH);
  const crop = canvas(cropW, cropH);
  if (visibleRight > visibleLeft && visibleBottom > visibleTop) {
    crop.context.drawImage(bitmap, visibleLeft, visibleTop, visibleRight - visibleLeft, visibleBottom - visibleTop,
      visibleLeft - cropX, visibleTop - cropY, visibleRight - visibleLeft, visibleBottom - visibleTop);
  }
  const photoCanvas = canvas(size.width, size.height, background);
  photoCanvas.context.drawImage(crop.canvas, 0, 0, size.width, size.height);
  const limitKb = Math.min(1000, Math.max(10, Math.round(num(ctx.options, 'maxFileKb') || 100)));
  const limitBytes = limitKb * 1024;
  let photoBlob: Blob | null = null; let smallest = Number.POSITIVE_INFINITY;
  for (const quality of [94, 90, 86, 82, 78, 74, 70, 66, 62, 58, 54, 50, 46, 42, 38, 34, 30, 26, 22, 18, 14, 10]) {
    const encoded = await photoCanvas.canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
    smallest = Math.min(smallest, encoded.size);
    if (encoded.size <= limitBytes) { photoBlob = encoded; break; }
  }
  if (!photoBlob) throw new EngineError('bad_request', `证件照最低可用画质仍为 ${Math.ceil(smallest / 1024)} KB，超过 ${limitKb} KB 上限；请提高文件大小上限后重试。`);
  if (photoBlob.size > limitBytes) throw new EngineError('bad_request', `证件照实际大小 ${photoBlob.size} 字节超过 ${limitBytes} 字节上限`);
  const photo = setJpegDensity(new Uint8Array(await photoBlob.arrayBuffer()), size.dpi ?? 300);
  const stem = baseName(input.name);
  await ctx.emit({ name: `${stem}-${size.fileLabel}-id-photo.jpg`, kind: 'image', bytes: photo, sourceFileId: input.id });

  if (bool(ctx.options, 'printSheet')) {
    const sheetWidth = 2480; const sheetHeight = 3508; const margin = 59; const gap = 24;
    const printSize = getIdPhotoPrintSize(ctx.options.size);
    const columns = Math.max(1, Math.floor((sheetWidth - 2 * margin + gap) / (printSize.width + gap)));
    const rows = Math.max(1, Math.floor((sheetHeight - 2 * margin + gap) / (printSize.height + gap)));
    const contentWidth = columns * printSize.width + (columns - 1) * gap;
    const contentHeight = rows * printSize.height + (rows - 1) * gap;
    const originX = Math.floor((sheetWidth - contentWidth) / 2); const originY = Math.floor((sheetHeight - contentHeight) / 2);
    const sheet = canvas(sheetWidth, sheetHeight, '#ffffff');
    const photoBitmap = await createImageBitmap(photoBlob);
    try {
      for (let index = 0; index < columns * rows; index += 1) {
        sheet.context.drawImage(photoBitmap, originX + (index % columns) * (printSize.width + gap), originY + Math.floor(index / columns) * (printSize.height + gap), printSize.width, printSize.height);
      }
    } finally { photoBitmap.close(); }
    const sheetBytes = await encode(sheet.canvas, 'jpeg', 94, '#ffffff');
    if (!sheetBytes.byteLength) throw new EngineError('unreadable_file', 'A4 打印排版页生成结果为空');
    await ctx.emit({ name: `${stem}-${size.fileLabel}-A4-print-sheet.jpg`, kind: 'image', bytes: setJpegDensity(sheetBytes, 300), sourceFileId: input.id });
  }
  ctx.report({ percent: 100, current: 1, total: 1 });
  return { extra: { width: size.width, height: size.height, dpi: size.dpi ?? 300, fileSizeLimitKb: limitKb, photoBytes: photo.byteLength } };
}

function fitDraw(context: OffscreenCanvasRenderingContext2D, bitmap: ImageBitmap, x: number, y: number, width: number, height: number, fit: 'inside' | 'cover' | 'fill', withoutEnlargement = false): void {
  if (fit === 'fill') { context.drawImage(bitmap, x, y, width, height); return; }
  const scale = fit === 'inside'
    ? Math.min(width / bitmap.width, height / bitmap.height, withoutEnlargement ? 1 : Infinity)
    : Math.max(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale; const drawHeight = bitmap.height * scale;
  const left = x + (width - drawWidth) / 2; const top = y + (height - drawHeight) / 2;
  if (fit === 'cover') {
    context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip();
    context.drawImage(bitmap, left, top, drawWidth, drawHeight); context.restore();
  } else context.drawImage(bitmap, left, top, drawWidth, drawHeight);
}

async function runImageTool(ctx: ToolContext, id: ToolId): Promise<ToolResult> {
  let inputBytes = 0; let outputBytes = 0;
  let watermarkWidth = 0; let watermarkHeight = 0;
  if (id === 'image-cutout' && !ctx.inputs.length) throw new EngineError('bad_request', '请先添加图片');
  if (id === 'image-info') {
    const rows = [];
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const { bitmap, format } = await openBrowserRaster(input);
      try {
        const meta = imageChannels(input, format);
        rows.push({ file: input.name, bytes: input.bytes.byteLength, width: bitmap.width, height: bitmap.height, format, ...meta });
        progress(ctx, index, 'inspect');
      } finally { bitmap.close(); }
    }
    if (!rows.length) throw new EngineError('bad_request', '没有可读取的图片');
    await ctx.emit({ name: 'image-info.json', kind: 'json', bytes: new TextEncoder().encode(JSON.stringify(rows, null, 2)) });
    return { extra: { images: rows.length } };
  }
  for (const [index, input] of ctx.inputs.entries()) {
    if (ctx.cancelled()) break;
    const { bitmap, format: sourceFormat } = await openBrowserRaster(input, id === 'image-convert');
    try {
      if (id === 'image-id-photo') return await runIdPhoto(ctx, input, bitmap);
      const options = ctx.options;
      let outputFormat: RasterFormat = sourceFormat === 'other' ? 'jpeg' : sourceFormat;
      let target: CanvasTarget;
      let label = id.replace('image-', '');
      const background = str(options, 'background') || '#ffffff';
      const quality = id === 'image-metadata-clean' ? 92 : id === 'image-cutout' || id === 'image-print' ? 94 : Math.round(num(options, 'quality') || 85);

      if (id === 'image-resize') {
        const width = Math.round(num(options, 'width')); const height = Math.round(num(options, 'height'));
        if (width < 1 || height < 1) throw new EngineError('bad_request', '宽度和高度必须大于 0');
        const fit = str(options, 'fit') === 'cover' ? 'cover' : str(options, 'fit') === 'fill' ? 'fill' : 'inside';
        const scale = fit === 'inside' ? Math.min(width / bitmap.width, height / bitmap.height, bool(options, 'withoutEnlargement') ? 1 : Infinity) : 1;
        const outWidth = fit === 'fill' || fit === 'cover' ? width : Math.max(1, Math.round(bitmap.width * scale));
        const outHeight = fit === 'fill' || fit === 'cover' ? height : Math.max(1, Math.round(bitmap.height * scale));
        const result = canvas(outWidth, outHeight, sourceFormat === 'jpeg' ? background : undefined);
        fitDraw(result.context, bitmap, 0, 0, outWidth, outHeight, fit, bool(options, 'withoutEnlargement'));
        target = result; label = 'resized';
      } else if (id === 'image-crop') {
        const ratio = str(options, 'aspect');
        const [ratioWidth, ratioHeight] = ratio === 'original' ? [bitmap.width, bitmap.height] : ratio.split(':').map(Number);
        const aspect = ratioWidth && ratioHeight ? ratioWidth / ratioHeight : 1;
        const sourceAspect = bitmap.width / bitmap.height;
        const width = sourceAspect > aspect ? Math.max(1, Math.round(bitmap.height * aspect)) : bitmap.width;
        const height = sourceAspect > aspect ? bitmap.height : Math.max(1, Math.round(bitmap.width / aspect));
        const position = str(options, 'position');
        const x = position === 'west' ? 0 : position === 'east' ? bitmap.width - width : Math.round((bitmap.width - width) / 2);
        const y = position === 'north' ? 0 : position === 'south' ? bitmap.height - height : Math.round((bitmap.height - height) / 2);
        target = canvas(width, height); target.context.drawImage(bitmap, x, y, width, height, 0, 0, width, height); label = 'cropped';
      } else if (id === 'image-rotate') {
        const angle = num(options, 'angle'); const radians = angle * Math.PI / 180;
        const swap = Math.abs(angle % 180) === 90;
        target = canvas(swap ? bitmap.height : bitmap.width, swap ? bitmap.width : bitmap.height);
        target.context.translate(target.canvas.width / 2, target.canvas.height / 2);
        target.context.rotate(radians);
        target.context.scale(bool(options, 'flipHorizontal') ? -1 : 1, bool(options, 'flipVertical') ? -1 : 1);
        target.context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
        label = 'rotated';
      } else if (id === 'image-compress') {
        const requested = str(options, 'format');
        const normalized = requested === 'original' ? (sourceFormat === 'other' ? 'jpeg' : sourceFormat) : requestedRasterFormat(requested);
        if (!normalized) throw new Error('fallback');
        outputFormat = normalized;
        const maxEdge = Math.round(num(options, 'maxEdge'));
        const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) : 1;
        target = canvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
        target.context.drawImage(bitmap, 0, 0, target.canvas.width, target.canvas.height);
        label = 'compressed';
      } else if (id === 'image-convert') {
        const requested = str(options, 'format');
        const normalized = requestedRasterFormat(requested);
        if (!normalized) throw new Error('fallback');
        outputFormat = normalized;
        target = canvas(bitmap.width, bitmap.height); target.context.drawImage(bitmap, 0, 0); label = 'converted';
      } else if (id === 'image-cutout') {
        outputFormat = bool(options, 'transparent') ? 'png' : 'jpeg';
        target = canvas(bitmap.width, bitmap.height); target.context.drawImage(bitmap, 0, 0); label = 'cutout';
      } else if (id === 'image-metadata-clean') {
        target = canvas(bitmap.width, bitmap.height); target.context.drawImage(bitmap, 0, 0); label = 'metadata-clean';
      } else if (id === 'image-print') {
        const letter = str(options, 'paper') === 'letter';
        const paper = letter ? { width: 2550, height: 3300, name: 'letter' } : { width: 2480, height: 3508, name: 'a4' };
        const orientation = str(options, 'orientation');
        const landscape = orientation === 'landscape' || (orientation === 'auto' && bitmap.width > bitmap.height);
        const width = landscape ? paper.height : paper.width;
        const height = landscape ? paper.width : paper.height;
        const margin = Math.round(Math.max(0, Math.min(40, num(options, 'marginMm'))) * 300 / 25.4);
        const fit = str(options, 'fit') === 'cover' ? 'cover' : 'inside';
        target = canvas(width, height, '#ffffff');
        fitDraw(target.context, bitmap, margin, margin, width - 2 * margin, height - 2 * margin, fit);
        outputFormat = 'jpeg'; label = `${paper.name}-print`;
      } else if (id === 'image-watermark-clean') {
        const encoded = str(options, 'repairPng').replace(/\s/g, '');
        if (!encoded) throw new EngineError('bad_request', '请先在预览中涂选要修复的区域');
        let maskBytes: Uint8Array;
        try { maskBytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)); }
        catch { throw new EngineError('bad_request', '修复选区数据无效，请重新涂选'); }
        let maskBitmap: ImageBitmap;
        try { maskBitmap = await createImageBitmap(new Blob([new Uint8Array(maskBytes).buffer])); }
        catch { throw new EngineError('bad_request', '无法读取修复选区，请重新涂选'); }
        try {
          const pixels = canvas(bitmap.width, bitmap.height);
          watermarkWidth = bitmap.width; watermarkHeight = bitmap.height;
          pixels.context.drawImage(bitmap, 0, 0);
          const source = pixels.context.getImageData(0, 0, bitmap.width, bitmap.height);
          const maskCanvas = canvas(bitmap.width, bitmap.height);
          maskCanvas.context.drawImage(maskBitmap, 0, 0, bitmap.width, bitmap.height);
          const mask = maskCanvas.context.getImageData(0, 0, bitmap.width, bitmap.height).data;
          const data = source.data;
          const radius = Math.max(1, Math.min(8, Math.round(Math.min(bitmap.width, bitmap.height) / 160)));
          for (let y = 0; y < bitmap.height; y += 1) for (let x = 0; x < bitmap.width; x += 1) {
            const offset = (y * bitmap.width + x) * 4;
            const m = Math.round((mask[offset]! * 299 + mask[offset + 1]! * 587 + mask[offset + 2]! * 114) / 1000);
            if (m < 32) continue;
            let r = 0; let g = 0; let b = 0; let count = 0;
            for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
              const sx = x + dx; const sy = y + dy;
              if (sx < 0 || sy < 0 || sx >= bitmap.width || sy >= bitmap.height) continue;
              const sample = (sy * bitmap.width + sx) * 4;
              const sampleMask = Math.round((mask[sample]! * 299 + mask[sample + 1]! * 587 + mask[sample + 2]! * 114) / 1000);
              if (sampleMask >= 32) continue;
              r += data[sample]!; g += data[sample + 1]!; b += data[sample + 2]!; count += 1;
            }
            if (count) { data[offset] = Math.round(r / count); data[offset + 1] = Math.round(g / count); data[offset + 2] = Math.round(b / count); }
          }
          pixels.context.putImageData(source, 0, 0);
          target = pixels; outputFormat = 'png'; label = 'watermark-cleaned';
        } finally { maskBitmap.close(); }
      } else {
        throw new Error('fallback');
      }

      let bytes = await encode(target.canvas, outputFormat, quality, background);
      if (id === 'image-print') bytes = setJpegDensity(bytes, 300);
      await emit(ctx, input, index, bytes, outputFormat, label);
      inputBytes += input.bytes.byteLength; outputBytes += bytes.byteLength;
      progress(ctx, index, id === 'image-print' ? 'print-layout' : id.replace('image-', ''));
    } finally { bitmap.close(); }
  }
  if (id === 'image-compress') return { extra: { inputBytes, outputBytes, savedBytes: inputBytes - outputBytes } };
  if (id === 'image-print') return { extra: { images: ctx.inputs.length, paper: str(ctx.options, 'paper') || 'a4', dpi: 300 } };
  if (id === 'image-watermark-clean') return { extra: { width: watermarkWidth, height: watermarkHeight, method: 'local-neighbor-fill' } };
  return { extra: { images: ctx.inputs.length } };
}

const IMAGE_TOOL_IDS: readonly ToolId[] = [
  'image-compress', 'image-resize', 'image-crop', 'image-rotate', 'image-convert',
  'image-info', 'image-cutout', 'image-metadata-clean', 'image-print',
  'image-watermark-clean', 'image-id-photo',
];

export const embeddedImageTools: ToolImpl[] = IMAGE_TOOL_IDS.map((id) => ({
  id,
  run: (ctx) => runImageTool(ctx, id),
}));
