import type { JobGlobals } from '@potools/core';
import { normalizeAngle } from '../lib/pdf.ts';
import { openRaster } from '../lib/render.ts';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Offsets from each unrotated page edge to visible content, measured in points. */
export async function contentInsets(
  bytes: Uint8Array,
  page: number,
  globals: JobGlobals,
  rotation = 0,
): Promise<Insets | null> {
  const raster = await openRaster(bytes, globals);
  try {
    const box = raster.pageBox(page);
    const bounds = await raster.inkBounds(page);
    if (!bounds) return null;
    return toUnrotatedInsets({
      left: bounds.x,
      bottom: bounds.y,
      right: Math.max(0, box.width - bounds.x - bounds.width),
      top: Math.max(0, box.height - bounds.y - bounds.height),
    }, rotation);
  } catch {
    return null;
  } finally {
    raster.close();
  }
}

/** MuPDF reports bounds after /Rotate; fold them back to the PDF user space. */
export function toUnrotatedInsets(insets: Insets, rotation: number): Insets {
  switch (normalizeAngle(rotation)) {
    case 90:
      return { left: insets.top, right: insets.bottom, top: insets.right, bottom: insets.left };
    case 180:
      return { left: insets.right, right: insets.left, top: insets.bottom, bottom: insets.top };
    case 270:
      return { left: insets.bottom, right: insets.top, top: insets.left, bottom: insets.right };
    default:
      return insets;
  }
}
