/// <reference path="../assets.d.ts" />
import UTIF, { type TiffIfd } from 'utif';
import { EngineError } from '../errors.ts';

export interface TiffInfo {
  width: number;
  height: number;
  channels: number;
  hasAlpha: boolean;
  orientation: number;
}

export function isTiff(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
    || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  );
}

function decodeIfd(bytes: Uint8Array): { buffer: ArrayBuffer; ifds: TiffIfd[]; first: TiffIfd; info: TiffInfo } {
  try {
    const buffer = new Uint8Array(bytes).buffer as ArrayBuffer;
    const ifds = UTIF.decode(buffer);
    const first = ifds[0];
    if (!first) throw new Error('No image directory');
    const width = Number(first.t256?.[0] ?? first.width ?? 0);
    const height = Number(first.t257?.[0] ?? first.height ?? 0);
    const channels = Number(first.t277?.[0] ?? first.t258?.length ?? 3);
    const extras = first.t338 ?? [];
    const info = {
      width,
      height,
      channels,
      hasAlpha: channels > 3 && extras.some((value) => value === 1 || value === 2),
      orientation: Math.min(8, Math.max(1, Number(first.t274?.[0] ?? 1))),
    };
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Invalid image dimensions');
    return { buffer, ifds, first, info };
  } catch (error) {
    throw new EngineError('unreadable_file', `无法读取 TIFF 图片：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readTiffInfo(bytes: Uint8Array): TiffInfo {
  return decodeIfd(bytes).info;
}

export async function openTiffBitmap(bytes: Uint8Array, maxPixels = 120_000_000): Promise<{ bitmap: ImageBitmap; info: TiffInfo }> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') throw new EngineError('no_image_codec', '浏览器图片画布不可用');
  const decoded = decodeIfd(bytes);
  const { width, height, orientation } = decoded.info;
  if (width > 16000 || height > 16000 || width * height > maxPixels) throw new EngineError('bad_request', '图片尺寸超出浏览器内存处理范围');
  try {
    UTIF.decodeImage(decoded.buffer, decoded.first, decoded.ifds);
    const rgba = UTIF.toRGBA8(decoded.first);
    if (rgba.byteLength !== width * height * 4) throw new Error('Unexpected RGBA length');
    const swap = orientation >= 5 && orientation <= 8;
    const outWidth = swap ? height : width;
    const outHeight = swap ? width : height;
    if (outWidth > 16000 || outHeight > 16000) throw new Error('Image dimensions exceed browser canvas limits');
    const source = new OffscreenCanvas(width, height);
    const sourceContext = source.getContext('2d', { alpha: true });
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const context = canvas.getContext('2d', { alpha: true });
    if (!sourceContext || !context) throw new Error('Canvas 2D context is unavailable');
    const transforms: Record<number, [number, number, number, number, number, number]> = {
      1: [1, 0, 0, 1, 0, 0],
      2: [-1, 0, 0, 1, width, 0],
      3: [-1, 0, 0, -1, width, height],
      4: [1, 0, 0, -1, 0, height],
      5: [0, 1, 1, 0, 0, 0],
      6: [0, 1, -1, 0, height, 0],
      7: [0, -1, -1, 0, height, width],
      8: [0, -1, 1, 0, 0, width],
    };
    sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    context.setTransform(...transforms[orientation]!);
    context.drawImage(source, 0, 0);
    return { bitmap: await createImageBitmap(canvas), info: decoded.info };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError('unreadable_file', `无法解码 TIFF 图片：${error instanceof Error ? error.message : String(error)}`);
  }
}
