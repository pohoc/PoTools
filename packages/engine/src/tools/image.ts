import type sharpDefault from 'sharp';
import { getIdPhotoPrintSize, getIdPhotoSize } from '@potools/core';
import { EngineError } from '../errors.ts';
import { bool, num, str } from '../lib/options.ts';
import { getSharp, imageInfo, type RasterFormat } from '../lib/images.ts';
import { baseName, renderName } from '../lib/naming.ts';
import type { ToolContext, ToolImpl } from '../types.ts';

type Sharp = typeof sharpDefault;
type Pipeline = ReturnType<Sharp>;
type ImageFormat = RasterFormat;
const FORMAT_EXT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', tiff: 'tiff' };
const IMAGE_FORMATS = new Set<ImageFormat>(['jpeg', 'png', 'webp', 'tiff']);

function getFormat(value: string, fallback: string): ImageFormat {
  const normalized = value === 'jpg' ? 'jpeg' : value || fallback;
  if (!IMAGE_FORMATS.has(normalized as ImageFormat)) {
    throw new EngineError('bad_request', `不支持的图片格式：${normalized}`);
  }
  return normalized as ImageFormat;
}

async function requireSharp(): Promise<Sharp> {
  const sharp = await getSharp();
  if (!sharp) throw new EngineError('no_image_codec', '图片编解码器不可用', 'error.noImageCodec');
  return sharp;
}

async function encode(pipeline: Pipeline, format: ImageFormat, quality: number, background: string): Promise<Uint8Array> {
  let output: Pipeline;
  switch (format) {
    case 'jpeg': output = pipeline.flatten({ background }).jpeg({ quality, mozjpeg: true }); break;
    case 'png': output = pipeline.png({ compressionLevel: 9, effort: 8 }); break;
    case 'webp': output = pipeline.webp({ quality, effort: 5 }); break;
    case 'tiff': output = pipeline.tiff({ quality }); break;
  }
  return new Uint8Array(await output.toBuffer());
}

async function emitImage(
  ctx: ToolContext,
  input: ToolContext['inputs'][number],
  index: number,
  bytes: Uint8Array,
  extension: string,
  tool: string,
): Promise<void> {
  await ctx.emit({
    name: renderName(ctx.namePattern, { name: baseName(input.name), tool, index: index + 1, total: ctx.inputs.length }, extension),
    kind: 'image', bytes, sourceFileId: input.id,
  });
}

function report(ctx: ToolContext, index: number, phase: string): void {
  ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), phase, current: index + 1, total: ctx.inputs.length });
}

const imageCompress: ToolImpl = {
  id: 'image-compress',
  async run(ctx) {
    const sharp = await requireSharp();
    const quality = Math.round(num(ctx.options, 'quality'));
    const maxEdge = Math.round(num(ctx.options, 'maxEdge'));
    const background = str(ctx.options, 'background') || '#ffffff';
    let inputBytes = 0;
    let outputBytes = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const meta = await imageInfo(input.bytes);
      const sourceFormat = getFormat(meta.format, '');
      const requested = str(ctx.options, 'format');
      const format = requested === 'original' ? sourceFormat : getFormat(requested, sourceFormat);
      let pipeline = sharp(input.bytes, { failOn: 'none' }).rotate();
      if (maxEdge > 0) pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
      const bytes = await encode(pipeline, format, quality, background);
      await emitImage(ctx, input, index, bytes, FORMAT_EXT[format], 'compressed');
      inputBytes += input.bytes.byteLength;
      outputBytes += bytes.byteLength;
      report(ctx, index, 'compress');
    }
    return { extra: { inputBytes, outputBytes, savedBytes: inputBytes - outputBytes } };
  },
};

const imageResize: ToolImpl = {
  id: 'image-resize',
  async run(ctx) {
    const sharp = await requireSharp();
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const meta = await imageInfo(input.bytes);
      const format = getFormat(meta.format, '');
      const width = Math.round(num(ctx.options, 'width'));
      const height = Math.round(num(ctx.options, 'height'));
      if (width < 1 || height < 1) throw new EngineError('bad_request', '宽度和高度必须大于 0');
      const bytes = new Uint8Array(await sharp(input.bytes, { failOn: 'none' }).rotate().resize({
        width, height, fit: str(ctx.options, 'fit') as 'inside' | 'cover' | 'fill',
        withoutEnlargement: bool(ctx.options, 'withoutEnlargement'),
      }).toBuffer());
      await emitImage(ctx, input, index, bytes, FORMAT_EXT[format], 'resized');
      report(ctx, index, 'resize');
    }
    return { extra: { images: ctx.inputs.length } };
  },
};

const imageCrop: ToolImpl = {
  id: 'image-crop',
  async run(ctx) {
    const sharp = await requireSharp();
    const ratio = str(ctx.options, 'aspect');
    const position = str(ctx.options, 'position');
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const meta = await imageInfo(input.bytes);
      const format = getFormat(meta.format, '');
      const aspect = ratio === 'original' ? meta.width / meta.height : (() => {
        const [w, h] = ratio.split(':').map(Number);
        return w && h ? w / h : 1;
      })();
      const sourceAspect = meta.width / meta.height;
      const cropWidth = sourceAspect > aspect ? Math.max(1, Math.round(meta.height * aspect)) : meta.width;
      const cropHeight = sourceAspect > aspect ? meta.height : Math.max(1, Math.round(meta.width / aspect));
      const left = position === 'west' ? 0 : position === 'east' ? meta.width - cropWidth : Math.round((meta.width - cropWidth) / 2);
      const top = position === 'north' ? 0 : position === 'south' ? meta.height - cropHeight : Math.round((meta.height - cropHeight) / 2);
      const bytes = new Uint8Array(await sharp(input.bytes, { failOn: 'none' }).rotate().extract({ left, top, width: cropWidth, height: cropHeight }).toBuffer());
      await emitImage(ctx, input, index, bytes, FORMAT_EXT[format], 'cropped');
      report(ctx, index, 'crop');
    }
    return { extra: { images: ctx.inputs.length } };
  },
};

const imageRotate: ToolImpl = {
  id: 'image-rotate',
  async run(ctx) {
    const sharp = await requireSharp();
    const angle = num(ctx.options, 'angle');
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const meta = await imageInfo(input.bytes);
      const format = getFormat(meta.format, '');
      // Normalize EXIF orientation first so the requested rotation is predictable.
      const upright = await sharp(input.bytes, { failOn: 'none' }).rotate().toBuffer();
      let pipeline = sharp(upright).rotate(angle);
      if (bool(ctx.options, 'flipHorizontal')) pipeline = pipeline.flop();
      if (bool(ctx.options, 'flipVertical')) pipeline = pipeline.flip();
      const bytes = new Uint8Array(await pipeline.toBuffer());
      await emitImage(ctx, input, index, bytes, FORMAT_EXT[format], 'rotated');
      report(ctx, index, 'rotate');
    }
    return { extra: { images: ctx.inputs.length, angle } };
  },
};

const imageConvert: ToolImpl = {
  id: 'image-convert',
  async run(ctx) {
    const sharp = await requireSharp();
    const format = getFormat(str(ctx.options, 'format'), 'webp');
    const quality = Math.round(num(ctx.options, 'quality'));
    const background = str(ctx.options, 'background') || '#ffffff';
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const bytes = await encode(sharp(input.bytes, { failOn: 'none' }).rotate(), format, quality, background);
      await emitImage(ctx, input, index, bytes, FORMAT_EXT[format], 'converted');
      report(ctx, index, 'convert');
    }
    return { extra: { images: ctx.inputs.length, format: FORMAT_EXT[format] } };
  },
};

const imageInfoTool: ToolImpl = {
  id: 'image-info',
  async run(ctx) {
    const rows = [];
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const meta = await imageInfo(input.bytes);
      rows.push({ file: input.name, bytes: input.bytes.byteLength, width: meta.width, height: meta.height, format: meta.format, channels: meta.channels, hasAlpha: meta.hasAlpha });
      report(ctx, index, 'inspect');
    }
    if (!rows.length) throw new EngineError('bad_request', '没有可读取的图片');
    await ctx.emit({ name: 'image-info.json', kind: 'json', bytes: new TextEncoder().encode(JSON.stringify(rows, null, 2)) });
    return { extra: { images: rows.length } };
  },
};

const imageMetadataClean: ToolImpl = {
  id: 'image-metadata-clean',
  async run(ctx) {
    const sharp = await requireSharp();
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const metadata = await sharp(input.bytes, { failOn: 'none' }).metadata();
      const format = getFormat(metadata.format ?? '', '');
      const bytes = await encode(sharp(input.bytes, { failOn: 'none' }).rotate(), format, 92, '#ffffff');
      await emitImage(ctx, input, index, bytes, FORMAT_EXT[format], 'metadata-clean');
      report(ctx, index, 'metadata-clean');
    }
    return { extra: { images: ctx.inputs.length, removed: 'EXIF,GPS,IPTC,XMP' } };
  },
};

const imagePrint: ToolImpl = {
  id: 'image-print',
  async run(ctx) {
    const sharp = await requireSharp();
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const paper = str(ctx.options, 'paper') === 'letter' ? { width: 2550, height: 3300, name: 'Letter' } : { width: 2480, height: 3508, name: 'A4' };
      const orientation = str(ctx.options, 'orientation');
      const landscape = orientation === 'landscape' || (orientation === 'auto' && (await imageInfo(input.bytes)).width > (await imageInfo(input.bytes)).height);
      const width = landscape ? paper.height : paper.width;
      const height = landscape ? paper.width : paper.height;
      const margin = Math.round(Math.max(0, Math.min(40, num(ctx.options, 'marginMm'))) * 300 / 25.4);
      const image = await sharp(input.bytes, { failOn: 'none' }).rotate().resize({ width: width - 2 * margin, height: height - 2 * margin, fit: str(ctx.options, 'fit') === 'cover' ? 'cover' : 'contain', position: 'centre' }).png().toBuffer();
      const bytes = new Uint8Array(await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite([{ input: image, gravity: 'centre' }]).withMetadata({ density: 300 }).jpeg({ quality: 94, mozjpeg: true }).toBuffer());
      await emitImage(ctx, input, index, bytes, 'jpg', `${paper.name.toLowerCase()}-print`);
      report(ctx, index, 'print-layout');
    }
    return { extra: { images: ctx.inputs.length, paper: str(ctx.options, 'paper') || 'a4', dpi: 300 } };
  },
};

const imageWatermarkClean: ToolImpl = {
  id: 'image-watermark-clean',
  async run(ctx) {
    const sharp = await requireSharp();
    const input = ctx.inputs[0];
    if (!input) throw new EngineError('bad_request', '请先添加图片');
    const encoded = str(ctx.options, 'repairPng');
    if (!encoded) throw new EngineError('bad_request', '请先在预览中涂选要修复的区域');
    const png = Buffer.from(encoded, 'base64');
    const base = sharp(input.bytes, { failOn: 'none' }).rotate();
    const meta = await base.metadata();
    const width = meta.width ?? 0; const height = meta.height ?? 0;
    if (!width || !height) throw new EngineError('unreadable_file', '无法解析图片尺寸');
    const mask = await sharp(png).resize(width, height).greyscale().raw().toBuffer();
    const { data, info } = await base.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const copy = Buffer.from(data);
    const radius = Math.max(1, Math.min(8, Math.round(Math.min(width, height) / 160)));
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if ((mask[y * width + x] ?? 0) < 32) continue;
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
        const sx = x + dx; const sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height || (mask[sy * width + sx] ?? 0) >= 32) continue;
        const offset = (sy * width + sx) * channels;
        r += data[offset] ?? 0; g += data[offset + 1] ?? 0; b += data[offset + 2] ?? 0; n += 1;
      }
      if (!n) continue;
      const offset = (y * width + x) * channels;
      copy[offset] = Math.round(r / n); copy[offset + 1] = Math.round(g / n); copy[offset + 2] = Math.round(b / n);
    }
    const bytes = new Uint8Array(await sharp(copy, { raw: { width, height, channels } }).png().toBuffer());
    await emitImage(ctx, input, 0, bytes, 'png', 'watermark-cleaned');
    return { extra: { width, height, method: 'local-neighbor-fill' } };
  },
};

const imageCutout: ToolImpl = {
  id: 'image-cutout',
  async run(ctx) {
    const sharp = await requireSharp();
    for (const [index, input] of ctx.inputs.entries()) {
      const transparent = bool(ctx.options, 'transparent');
      const background = str(ctx.options, 'background') || '#ffffff';
      let pipeline = sharp(input.bytes, { failOn: 'none' }).rotate();
      let extension = 'png';
      if (transparent) pipeline = pipeline.png({ compressionLevel: 8 });
      else {
        pipeline = pipeline.flatten({ background }).jpeg({ quality: 94, mozjpeg: true });
        extension = 'jpg';
      }
      const bytes = new Uint8Array(await pipeline.toBuffer());
      await emitImage(ctx, input, index, bytes, extension, 'cutout');
      report(ctx, index, 'cutout');
    }
    return { extra: { images: ctx.inputs.length } };
  },
};

const imageIdPhoto: ToolImpl = {
  id: 'image-id-photo',
  async run(ctx) {
    const sharp = await requireSharp();
    const input = ctx.inputs[0];
    if (!input) throw new EngineError('bad_request', '请先添加一张人物照片');
    const size = getIdPhotoSize(ctx.options.size);
    const background = str(ctx.options, 'background') || '#438edb';
    const scale = Math.min(130, Math.max(70, num(ctx.options, 'scale') || 100)) / 100;
    const verticalOffset = Math.min(20, Math.max(-20, num(ctx.options, 'verticalOffset'))) / 100;
    const limitKb = Math.min(1000, Math.max(10, Math.round(num(ctx.options, 'maxFileKb') || 100)));
    const metadata = await sharp(input.bytes, { failOn: 'none' }).metadata();
    if (!metadata.width || !metadata.height || (metadata.channels ?? 0) < 4) {
      throw new EngineError('unreadable_file', '人物抠图结果没有透明通道，请重新识别人物。');
    }
    const { data, info } = await sharp(input.bytes, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = info.width;
    let top = info.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (data[(y * info.width + x) * info.channels + 3]! < 24) continue;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
    if (right < left || bottom < top) throw new EngineError('unreadable_file', '没有识别到人物，请换一张正面清晰的照片。');

    const subjectWidth = right - left + 1;
    const subjectHeight = bottom - top + 1;
    const aspect = size.width / size.height;
    const cropHeight = Math.max(subjectHeight * 0.62, subjectWidth / aspect) / scale;
    const cropWidth = cropHeight * aspect;
    const cropLeft = (left + right + 1) / 2 - cropWidth / 2;
    const cropTop = top - cropHeight * 0.035 + cropHeight * verticalOffset;
    const cropX = Math.round(cropLeft);
    const cropY = Math.round(cropTop);
    const cropW = Math.max(1, Math.round(cropWidth));
    const cropH = Math.max(1, Math.round(cropHeight));
    const visibleLeft = Math.max(0, cropX);
    const visibleTop = Math.max(0, cropY);
    const visibleRight = Math.min(info.width, cropX + cropW);
    const visibleBottom = Math.min(info.height, cropY + cropH);
    const photoCanvas = sharp({ create: { width: cropW, height: cropH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    const layers: Array<{ input: Buffer; left: number; top: number }> = [];
    if (visibleRight > visibleLeft && visibleBottom > visibleTop) {
      const clipped = await sharp(input.bytes, { failOn: 'none' }).extract({
        left: visibleLeft, top: visibleTop, width: visibleRight - visibleLeft, height: visibleBottom - visibleTop,
      }).png().toBuffer();
      layers.push({ input: clipped, left: visibleLeft - cropX, top: visibleTop - cropY });
    }
    const framed = await photoCanvas.composite(layers).png().toBuffer();
    const flattened = await sharp(framed).resize(size.width, size.height, { fit: 'fill' })
      .flatten({ background }).png().toBuffer();
    const limitBytes = limitKb * 1024;
    let photo: Uint8Array | null = null;
    let smallest = Number.POSITIVE_INFINITY;
    for (const quality of [94, 90, 86, 82, 78, 74, 70, 66, 62, 58, 54, 50, 46, 42, 38, 34, 30, 26, 22, 18, 14, 10]) {
      const encoded = await sharp(flattened).withMetadata({ density: size.dpi ?? 300 }).jpeg({ quality, mozjpeg: true }).toBuffer();
      smallest = Math.min(smallest, encoded.byteLength);
      if (encoded.byteLength <= limitBytes) {
        photo = new Uint8Array(encoded);
        break;
      }
    }
    if (!photo) {
      throw new EngineError('bad_request', `证件照最低可用画质仍为 ${Math.ceil(smallest / 1024)} KB，超过 ${limitKb} KB 上限；请提高文件大小上限后重试。`);
    }
    if (photo.byteLength > limitBytes) throw new EngineError('bad_request', `证件照实际大小 ${photo.byteLength} 字节超过 ${limitBytes} 字节上限`);
    const stem = baseName(input.name);
    await ctx.emit({ name: `${stem}-${size.fileLabel}-id-photo.jpg`, kind: 'image', bytes: photo, sourceFileId: input.id });

    if (bool(ctx.options, 'printSheet')) {
      const sheetWidth = 2480;
      const sheetHeight = 3508;
      const margin = 59;
      const gap = 24;
      const printSize = getIdPhotoPrintSize(ctx.options.size);
      const columns = Math.max(1, Math.floor((sheetWidth - 2 * margin + gap) / (printSize.width + gap)));
      const rows = Math.max(1, Math.floor((sheetHeight - 2 * margin + gap) / (printSize.height + gap)));
      const count = columns * rows;
      const contentWidth = columns * printSize.width + (columns - 1) * gap;
      const contentHeight = rows * printSize.height + (rows - 1) * gap;
      const originX = Math.floor((sheetWidth - contentWidth) / 2);
      const originY = Math.floor((sheetHeight - contentHeight) / 2);
      const printPhoto = await sharp(photo).resize(printSize.width, printSize.height, { fit: 'fill' }).toBuffer();
      const copies = Array.from({ length: count }, (_, index) => ({
        input: printPhoto,
        left: originX + (index % columns) * (printSize.width + gap),
        top: originY + Math.floor(index / columns) * (printSize.height + gap),
      }));
      const sheet = new Uint8Array(await sharp({ create: { width: sheetWidth, height: sheetHeight, channels: 3, background: '#ffffff' } })
        .composite(copies).withMetadata({ density: 300 }).jpeg({ quality: 94, mozjpeg: true }).toBuffer());
      if (!sheet.byteLength) throw new EngineError('unreadable_file', 'A4 打印排版页生成结果为空');
      await ctx.emit({ name: `${stem}-${size.fileLabel}-A4-print-sheet.jpg`, kind: 'image', bytes: sheet, sourceFileId: input.id });
    }
    ctx.report({ percent: 100, current: 1, total: 1 });
    return { extra: { width: size.width, height: size.height, dpi: size.dpi ?? 300, fileSizeLimitKb: limitKb, photoBytes: photo.byteLength } };
  },
};

export const imageTools: ToolImpl[] = [imageCompress, imageResize, imageCrop, imageRotate, imageConvert, imageInfoTool, imageCutout, imageIdPhoto, imageMetadataClean, imagePrint, imageWatermarkClean];
