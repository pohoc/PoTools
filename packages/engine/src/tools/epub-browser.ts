import { EngineError } from '../errors.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { chapterize, writeEpub, type EpubImage } from '../lib/epub.ts';
import { bool, str } from '../lib/options.ts';
import { readDocModel, toFlow, type FlowBlock } from '../lib/docmodel.ts';
import { openRaster } from '../lib/render.ts';
import { cropPdfRegionPng } from '../lib/browser-region.ts';
import type { ToolImpl } from '../types.ts';
import { readBrowserPdfTextPages, browserPagesToFlow } from './pdf-text-export-browser.ts';

/** Browser worker implementation for text and cropped-page-image EPUB exports. */
export const embeddedPdfToEpubTool: ToolImpl = {
  id: 'pdf-to-epub',
  async run(ctx) {
    const includeImages = bool(ctx.options, 'includeImages');
    const chapterBy = str(ctx.options, 'chapterBy') === 'page' ? 'page' : 'heading';
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const stem = baseName(input.name);
      let flow: FlowBlock[];
      const images = new Map<string, EpubImage>();
      if (includeImages) {
        const doc = await ctx.loadPdf(input, ctx.globals);
        if (!doc.getPageCount()) throw new EngineError('empty_selection', `${input.name} 没有页面`);
        const model = await readDocModel(input.bytes, doc, ctx.globals);
        const raster = await openRaster(input.bytes, ctx.globals);
        try {
          flow = toFlow(model);
          let counter = 0;
          for (const block of flow) {
            if (block.kind !== 'image' || !block.box.w || !block.box.h) continue;
            const cropped = await cropPdfRegionPng(raster, block.page, block.box, 144);
            const name = `p${block.page}-${String(++counter).padStart(2, '0')}.png`;
            images.set(name, { name, bytes: cropped.bytes });
            block.src = name;
          }
        } finally {
          raster.close();
        }
      } else {
        const pages = await readBrowserPdfTextPages(input.bytes, ctx.globals.password);
        flow = browserPagesToFlow(pages, false);
      }
      const bytes = await writeEpub({ title: stem, author: 'PoTools', chapters: chapterize(flow, chapterBy), images });
      await ctx.emit({ name: renderName(ctx.namePattern, { name: stem, tool: 'epub' }, 'epub'), kind: 'epub', bytes, sourceFileId: input.id });
      produced += 1;
      ctx.report({
        percent: Math.round(((index + 1) / ctx.inputs.length) * 100),
        current: index + 1,
        total: ctx.inputs.length,
      });
    }
    return { extra: { books: produced } };
  },
};
