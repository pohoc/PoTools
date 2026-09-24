import { InMemoryFallback } from './memory-job.ts';
import type { RasterHandle } from './render.ts';
import type { PlacedRegion } from './office.ts';

/** Raster-crops a structured PDF region for the Worker-based exporters. */
export async function cropPdfRegionPng(
  raster: RasterHandle,
  page: number,
  box: { x: number; y: number; w: number; h: number },
  dpi = 150,
): Promise<PlacedRegion> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new InMemoryFallback('Browser image crop APIs are unavailable');
  }
  const pageBox = raster.pageBox(page);
  const png = raster.renderPng({ page, dpi });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([png.slice().buffer as ArrayBuffer]));
  } catch (error) {
    throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
  }
  try {
    const scale = bitmap.width / pageBox.width;
    const left = clamp(Math.round(box.x * scale), 0, bitmap.width - 1);
    const top = clamp(Math.round(box.y * scale), 0, bitmap.height - 1);
    const width = clamp(Math.round(box.w * scale), 1, bitmap.width - left);
    const height = clamp(Math.round(box.h * scale), 1, bitmap.height - top);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new InMemoryFallback('Canvas 2D context is unavailable');
    context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: box.w, height: box.h };
  } catch (error) {
    if (error instanceof InMemoryFallback) throw error;
    throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
  } finally {
    bitmap.close();
  }
}

/** Encodes binary data in bounded chunks so large images do not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
