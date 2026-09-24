import { EngineError } from '../errors.ts';
import { copyPagesInto, createDocument, loadDocument } from '../lib/pdf.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { getMupdf } from '../lib/render.ts';
import { baseName, renderName } from '../lib/naming.ts';
import type { ToolContext, ToolImpl } from '../types.ts';
import { bool, num } from '../lib/options.ts';

const BACKGROUND_THRESHOLD = 246;

/** In-memory equivalent of the host's 36 DPI MuPDF raster and Sharp grayscale check. */
export const embeddedRemoveBlankTool: ToolImpl = {
  id: 'remove-blank',
  async run(ctx) {
    const mupdf = await getMupdf();
    if (!mupdf) throw new InMemoryFallback('MuPDF WASM unavailable');
    const tolerance = Math.max(0, num(ctx.options, 'tolerance')) / 100;
    const reportOnly = bool(ctx.options, 'reportOnly');
    let blankTotal = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      let mupdfDoc: ReturnType<typeof mupdf.Document.openDocument>;
      try {
        mupdfDoc = mupdf.Document.openDocument(new Uint8Array(input.bytes), 'application/pdf');
        if (mupdfDoc.needsPassword() && !mupdfDoc.authenticatePassword(ctx.globals.password ?? '')) {
          mupdfDoc.destroy();
          throw new Error('密码错误或文档已加密');
        }
      } catch (error) {
        throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
      }

      let doc;
      try {
        doc = await loadDocument(input.bytes, input.name);
      } catch (error) {
        mupdfDoc.destroy();
        throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
      }
      if (mupdfDoc.countPages() !== doc.getPageCount()) {
        mupdfDoc.destroy();
        throw new InMemoryFallback('PDF parsers disagree on page count');
      }

      const blank: number[] = [];
      try {
        for (let pageNumber = 1; pageNumber <= mupdfDoc.countPages(); pageNumber += 1) {
          if (ctx.cancelled()) break;
          const page = mupdfDoc.loadPage(pageNumber - 1);
          const bounds = page.getBounds();
          const factor = Math.max(0.05, Math.min(0.5, 6000 / Math.max(1, bounds[2]! - bounds[0]!), 6000 / Math.max(1, bounds[3]! - bounds[1]!), Math.sqrt(24_000_000 / Math.max(1, (bounds[2]! - bounds[0]!) * (bounds[3]! - bounds[1]!)))));
          const pixmap = page.toPixmap(mupdf.Matrix.scale(factor, factor) as import('mupdf').Matrix, mupdf.ColorSpace.DeviceRGB, false, true);
          try {
            const pixels = pixmap.getPixels();
            const width = pixmap.getWidth();
            const height = pixmap.getHeight();
            const stride = pixmap.getStride();
            const channels = pixmap.getNumberOfComponents();
            let inked = 0;
            for (let y = 0; y < height; y += 1) {
              const row = y * stride;
              for (let x = 0; x < width; x += 1) {
                const offset = row + x * channels;
                // libvips/Sharp's grayscale() uses the ITU-R 601 luma coefficients.
                const gray = Math.round(0.299 * pixels[offset]! + 0.587 * pixels[offset + 1]! + 0.114 * pixels[offset + 2]!);
                if (gray < BACKGROUND_THRESHOLD) inked += 1;
              }
            }
            const ratio = width && height ? inked / (width * height) : 0;
            if (ratio <= tolerance) blank.push(pageNumber);
          } finally {
            pixmap.destroy();
            page.destroy();
          }
          ctx.report({ percent: Math.round(((index + pageNumber / mupdfDoc.countPages()) / ctx.inputs.length) * 80) });
        }
      } catch (error) {
        if (error instanceof InMemoryFallback) throw error;
        throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
      } finally {
        mupdfDoc.destroy();
      }

      blankTotal += blank.length;
      const label = blank.length ? blank.join(', ') : '无';
      if (reportOnly) {
        await ctx.emit({
          name: `${baseName(input.name)}-blank-report.json`,
          kind: 'json',
          bytes: new TextEncoder().encode(JSON.stringify({ file: input.name, pages: doc.getPageCount(), blankPages: blank }, null, 2)),
          sourceFileId: input.id,
        });
        ctx.warnings.push(`${baseName(input.name)}：检测到 ${blank.length} 个空白页（${label}）`);
        continue;
      }
      if (blank.length >= doc.getPageCount()) throw new EngineError('empty_selection', '全部页面都被判为空白，已停止');
      const out = await createDocument();
      const keep = Array.from({ length: doc.getPageCount() }, (_, page) => page + 1).filter((page) => !blank.includes(page));
      await copyPagesInto(out, doc, keep);
      const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'no-blank' }, 'pdf'), bytes, input.id);
      ctx.warnings.push(`${baseName(input.name)}：已删除 ${blank.length} 个空白页（${label}）`);
    }
    return { extra: { blankPages: blankTotal } };
  },
};
