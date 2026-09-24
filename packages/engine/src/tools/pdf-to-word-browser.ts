import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { cropPdfRegionPng } from '../lib/browser-region.ts';
import { openRaster } from '../lib/render.ts';
import { readDocModel, toFlow, type FlowBlock } from '../lib/docmodel.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool } from '../lib/options.ts';
import type { PlacedRegion } from '../lib/office.ts';
import { writeBrowserDocx } from '../lib/office.ts';
import type { ToolImpl } from '../types.ts';
import { recognizeBrowserPng } from './ocr-browser.ts';

/** PDF-to-Word using the shared layout model, MuPDF WASM, and embedded OCR. */
export const embeddedPdfToWordTool: ToolImpl = {
  id: 'pdf-to-word',
  async run(ctx) {
    const wantImages = bool(ctx.options, 'includeImages');
    const pageBreaks = bool(ctx.options, 'pageBreaks');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      if (!doc.getPageCount()) throw new EngineError('empty_selection', `${input.name} 没有页面`);
      const model = await readDocModel(input.bytes, doc, ctx.globals);
      const raster = await openRaster(input.bytes, ctx.globals);
      try {
        const flow = toFlow(model, { pageBreaks });
        const crops = wantImages ? await cropAll(raster, flow) : new Map<Extract<FlowBlock, { kind: 'image' }>, PlacedRegion>();
        const first = model.pages[0];
        const fallbackImages = new Map<FlowBlock, PlacedRegion>();
        const blocks: FlowBlock[] = [];
        for (const [pageIndex, page] of model.pages.entries()) {
          if (pageBreaks && pageIndex > 0) blocks.push({ kind: 'pageBreak' });
          blocks.push(...flow.filter((block) => 'page' in block && block.page === page.page));
          if (page.lines.length > 0) continue;
          try {
            const ocr = await recognizeBrowserPng(raster.renderPng({ page: page.page, dpi: 200 }));
            const recognized = (ocr.lines.length ? ocr.lines.map((line) => line.text) : ocr.text.split(/\r?\n/))
              .map((line) => line.trim())
              .filter(Boolean);
            if (recognized.length) {
              blocks.push({ kind: 'paragraph', text: recognized.join('\n'), page: page.page, bold: false });
              continue;
            }
          } catch (error) {
            if (error instanceof InMemoryFallback) throw error;
            if (!(error instanceof EngineError) || error.code !== 'unsupported') throw error;
          }
          const block: FlowBlock = {
            kind: 'image',
            page: page.page,
            box: { x: 0, y: 0, w: page.width, h: page.height },
          };
          blocks.push(block);
          fallbackImages.set(block, {
            bytes: raster.renderPng({ page: page.page, dpi: 150 }),
            width: page.width,
            height: page.height,
          });
        }

        const bytes = await writeBrowserDocx({
          title: baseName(input.name),
          blocks,
          pageBreaks,
          contentWidth: Math.max(200, (first?.width ?? 595) - 144),
          imageFor: (block) => crops.get(block) ?? fallbackImages.get(block) ?? null,
        });
        await ctx.emit({
          name: renderName(ctx.namePattern, { name: baseName(input.name), tool: 'word' }, 'docx'),
          kind: 'docx',
          bytes,
          sourceFileId: input.id,
        });
        produced += 1;
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
      } finally {
        raster.close();
      }
    }
    return { extra: { documents: produced } };
  },
};

async function cropAll(
  raster: Awaited<ReturnType<typeof openRaster>>,
  flow: FlowBlock[],
): Promise<Map<Extract<FlowBlock, { kind: 'image' }>, PlacedRegion>> {
  const images = new Map<Extract<FlowBlock, { kind: 'image' }>, PlacedRegion>();
  for (const block of flow) {
    if (block.kind !== 'image' || !block.box.w || !block.box.h) continue;
    images.set(block, await cropPdfRegionPng(raster, block.page, block.box));
  }
  return images;
}
