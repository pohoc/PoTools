import { parsePageRanges } from '@potools/core';
import { EngineError } from '../errors.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { cropPage, normalizeAngle } from '../lib/pdf.ts';
import { bool, num, str } from '../lib/options.ts';
import type { ToolImpl } from '../types.ts';

const MAX_PIXELS = 24_000_000;
const MAX_EDGE = 6000;
const INK_THRESHOLD = 246;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function toUnrotatedInsets(insets: Insets, rotation: number): Insets {
  switch (normalizeAngle(rotation)) {
    case 90: return { left: insets.top, right: insets.bottom, top: insets.right, bottom: insets.left };
    case 180: return { left: insets.right, right: insets.left, top: insets.bottom, bottom: insets.top };
    case 270: return { left: insets.bottom, right: insets.top, top: insets.left, bottom: insets.right };
    default: return insets;
  }
}

/** In-memory MuPDF WASM equivalent of the host's 72 DPI content-bound detection. */
export async function browserContentInsets(bytes: Uint8Array, pageNumber: number, password: string | null | undefined, rotation: number): Promise<Insets | null> {
  let document: import('mupdf').Document | null = null;
  try {
    const { default: mupdf } = await import('mupdf');
    document = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
    if (document.needsPassword() && !document.authenticatePassword(password ?? '')) return null;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.countPages()) return null;
    const page = document.loadPage(pageNumber - 1);
    try {
      const bounds = page.getBounds();
      const boxWidth = bounds[2]! - bounds[0]!;
      const boxHeight = bounds[3]! - bounds[1]!;
      const scale = clampRasterFactor(boxWidth, boxHeight);
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        const width = pixmap.getWidth();
        const height = pixmap.getHeight();
        const stride = pixmap.getStride();
        const channels = pixmap.getNumberOfComponents();
        const pixels = pixmap.getPixels();
        let minX = width;
        let maxX = -1;
        let minY = height;
        let maxY = -1;
        for (let y = 0; y < height; y += 1) {
          const row = y * stride;
          let left = -1;
          for (let x = 0; x < width; x += 1) {
            const offset = row + x * channels;
            const gray = 0.2126 * pixels[offset]! + 0.7152 * pixels[offset + 1]! + 0.0722 * pixels[offset + 2]!;
            if (gray < INK_THRESHOLD) { left = x; break; }
          }
          if (left < 0) continue;
          let right = left;
          for (let x = width - 1; x > left; x -= 1) {
            const offset = row + x * channels;
            const gray = 0.2126 * pixels[offset]! + 0.7152 * pixels[offset + 1]! + 0.0722 * pixels[offset + 2]!;
            if (gray < INK_THRESHOLD) { right = x; break; }
          }
          minX = Math.min(minX, left);
          maxX = Math.max(maxX, right);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        if (maxX < 0) return null;

        const sx = boxWidth / width;
        const sy = boxHeight / height;
        const left = Math.max(0, (minX - 1) * sx);
        const top = Math.max(0, (minY - 1) * sy);
        const contentWidth = Math.min(boxWidth - left, (maxX + 2) * sx - left);
        const contentHeight = Math.min(boxHeight - top, (maxY + 2) * sy - top);
        const visual = {
          left,
          bottom: Math.max(0, boxHeight - top - contentHeight),
          right: Math.max(0, boxWidth - left - contentWidth),
          top: Math.max(0, top),
        };
        return toUnrotatedInsets(visual, rotation);
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  } catch {
    return null;
  } finally {
    document?.destroy();
  }
}

function clampRasterFactor(widthPt: number, heightPt: number): number {
  const width = Math.max(1, widthPt);
  const height = Math.max(1, heightPt);
  let factor = 1;
  factor = Math.min(factor, MAX_EDGE / width, MAX_EDGE / height);
  factor = Math.min(factor, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.max(0.05, factor);
}

export const embeddedCropTool: ToolImpl = {
  id: 'crop',
  async run(ctx) {
    let cropped = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const selection = new Set(parsePageRanges(str(ctx.options, 'pages'), doc.getPageCount()));
      const manual = {
        top: num(ctx.options, 'top'),
        right: num(ctx.options, 'right'),
        bottom: num(ctx.options, 'bottom'),
        left: num(ctx.options, 'left'),
      };
      const shrink = bool(ctx.options, 'shrinkToContent');
      for (const [pageIndex, page] of doc.getPages().entries()) {
        if (!selection.has(pageIndex + 1)) continue;
        let edges = manual;
        if (shrink) {
          const detected = await browserContentInsets(input.bytes, pageIndex + 1, ctx.globals.password, normalizeAngle(page.getRotation().angle));
          if (detected) {
            edges = {
              top: detected.top + manual.top,
              right: detected.right + manual.right,
              bottom: detected.bottom + manual.bottom,
              left: detected.left + manual.left,
            };
          } else {
            ctx.warnings.push(`${baseName(input.name)}：无法自动贴合内容（缺少图片解码器），已按手动边距裁剪`);
          }
        }
        cropPage(page, edges);
        cropped += 1;
      }
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'cropped' }, 'pdf'), bytes, input.id);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    if (!ctx.inputs.length) throw new EngineError('bad_request', '请先添加文件');
    return { pageCountOut: cropped, extra: { pages: cropped } };
  },
};
