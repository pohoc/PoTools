import { EngineError } from '../errors';
import { logger } from '../logger';

import type sharpDefault from 'sharp';

type Sharp = typeof sharpDefault;

let sharpPromise: Promise<Sharp | null> | null = null;

export async function getSharp(): Promise<Sharp | null> {
  if (!sharpPromise) {
    sharpPromise = import(/* @vite-ignore */ 'sharp')
      .then((mod) => {
        const candidate = (mod as unknown as { default?: unknown }).default ?? mod;
        return typeof candidate === 'function' ? (candidate as Sharp) : null;
      })
      .catch((error) => {
        logger.error('sharp failed to load', { error: String(error) });
        sharpPromise = null;
        return null;
      });
  }
  return sharpPromise;
}

export interface ImageMeta {
  width: number;
  height: number;
  format: string;
  channels: number;
  hasAlpha: boolean;
}

export async function imageInfo(bytes: Uint8Array): Promise<ImageMeta> {
  const sharp = await requireSharp();
  const meta = await sharp(bytes, { failOn: 'none' }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new EngineError('unreadable_file', '无法解析图片尺寸');
  // sharp applies EXIF orientation in `rotate()` without arguments.
  const rotated = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
  return {
    width: rotated ? height : width,
    height: rotated ? width : height,
    format: meta.format ?? 'unknown',
    channels: meta.channels ?? 3,
    hasAlpha: (meta.channels ?? 3) === 4 || Boolean(meta.hasAlpha),
  };
}

export type RasterFormat = 'jpeg' | 'png' | 'webp' | 'tiff';

export interface EncodeOptions {
  format: RasterFormat;
  quality?: number;
  background?: string;
  transparent?: boolean;
}

export async function encode(bytes: Uint8Array, options: EncodeOptions): Promise<Uint8Array> {
  const sharp = await requireSharp();
  const quality = Math.round(options.quality ?? 88);
  let pipeline = sharp(bytes, { failOn: 'none' }).rotate();
  if (options.format === 'jpeg') {
    pipeline = pipeline
      .flatten({ background: options.background ?? '#ffffff' })
      .jpeg({ quality, mozjpeg: true });
  } else if (options.format === 'webp') {
    pipeline = options.transparent
      ? pipeline.webp({ quality, lossless: false })
      : pipeline.flatten({ background: options.background ?? '#ffffff' }).webp({ quality });
  } else if (options.format === 'png') {
    pipeline = pipeline.png({ compressionLevel: 9, effort: 7 });
  } else {
    pipeline = pipeline.tiff({ quality });
  }
  return new Uint8Array(await pipeline.toBuffer());
}

/** Downscales and re-encodes a raster so it fits a target pixel budget. */
export async function rescale(
  bytes: Uint8Array,
  target: { maxEdge: number; quality: number; format?: RasterFormat },
): Promise<{ bytes: Uint8Array; width: number; height: number; format: RasterFormat }> {
  const sharp = await requireSharp();
  const format = target.format ?? 'jpeg';
  const pipeline = sharp(bytes, { failOn: 'none' })
    .rotate()
    .resize({
      width: Math.max(1, Math.round(target.maxEdge)),
      height: Math.max(1, Math.round(target.maxEdge)),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: Math.round(target.quality), mozjpeg: true });
  const out = new Uint8Array(await pipeline.toBuffer());
  const info = await sharp(out).metadata();
  return { bytes: out, width: info.width ?? 0, height: info.height ?? 0, format };
}

/**
 * Prepares a user image for embedding: applies EXIF rotation, drops CMYK,
 * keeps alpha only for PNG output, and caps absurd resolutions.
 */
export async function prepareForEmbedding(
  bytes: Uint8Array,
  options: { quality: number; maxPixels?: number; background?: string } = { quality: 85 },
): Promise<{ bytes: Uint8Array; width: number; height: number; kind: 'jpeg' | 'png' }> {
  const sharp = await requireSharp();
  const meta = await imageInfo(bytes);
  const maxPixels = options.maxPixels ?? 20_000_000;
  const cap = Math.sqrt(maxPixels / Math.max(1, meta.width * meta.height));
  let pipeline = sharp(bytes, { failOn: 'none' }).rotate();
  if (cap < 1) {
    pipeline = pipeline.resize({
      width: Math.max(1, Math.round(meta.width * cap)),
      height: Math.max(1, Math.round(meta.height * cap)),
      fit: 'inside',
    });
  }
  if (meta.hasAlpha) {
    const out = new Uint8Array(await pipeline.png({ compressionLevel: 9 }).toBuffer());
    const info = await sharp(out).metadata();
    return { bytes: out, width: info.width ?? meta.width, height: info.height ?? meta.height, kind: 'png' };
  }
  const out = new Uint8Array(
    await pipeline
      .flatten({ background: options.background ?? '#ffffff' })
      .jpeg({ quality: Math.round(options.quality), mozjpeg: true })
      .toBuffer(),
  );
  const info = await sharp(out).metadata();
  return { bytes: out, width: info.width ?? meta.width, height: info.height ?? meta.height, kind: 'jpeg' };
}

/** Converts a PNG buffer produced by MuPDF into the requested format. */
export async function transcodePng(png: Uint8Array, options: EncodeOptions): Promise<Uint8Array> {
  if (options.format === 'png') return png;
  return encode(png, options);
}

async function requireSharp(): Promise<Sharp> {
  const sharp = await getSharp();
  if (!sharp) throw new EngineError('no_image_codec', '图片编解码器 (sharp) 不可用', 'error.noImageCodec');
  return sharp;
}

export async function imageSelfCheck(): Promise<boolean> {
  try {
    const sharp = await requireSharp();
    const buffer = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    return buffer.length > 0;
  } catch (error) {
    logger.warn('image self-check failed', { error: String(error) });
    return false;
  }
}
