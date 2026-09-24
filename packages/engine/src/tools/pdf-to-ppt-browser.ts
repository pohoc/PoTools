import { EngineError } from '../errors.ts';
import { openRaster } from '../lib/render.ts';
import { readDocModel } from '../lib/docmodel.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num } from '../lib/options.ts';
import { writePptx } from '../lib/pptx.ts';
import type { ToolImpl } from '../types.ts';

/** PDF-to-PPT using the bundled MuPDF WASM renderer and the shared writer. */
export const embeddedPdfToPptTool: ToolImpl = {
  id: 'pdf-to-ppt',
  async run(ctx) {
    const withText = bool(ctx.options, 'textLayer');
    const dpi = num(ctx.options, 'dpi');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      if (!doc.getPageCount()) throw new EngineError('empty_selection', `${input.name} 没有页面`);
      const model = await readDocModel(input.bytes, doc, ctx.globals);
      const raster = await openRaster(input.bytes, ctx.globals);
      try {
        const slides = [];
        for (const page of model.pages) {
          const image = raster.renderPng({ page: page.page, dpi });
          if (!image.length) continue;
          slides.push({
            widthIn: page.width / 72,
            heightIn: page.height / 72,
            image,
            lines: withText
              ? page.lines.map((line) => ({
                  text: line.text,
                  xIn: line.x / 72,
                  yIn: line.y / 72,
                  wIn: Math.max(0.2, line.w / 72),
                  hIn: Math.max(0.12, line.h / 72),
                  size: line.size,
                  bold: line.weight === 'bold' || /bold/i.test(line.font),
                  color: '000000',
                }))
              : [],
          });
          ctx.report({
            percent: Math.round(((index + page.page / model.pages.length) / ctx.inputs.length) * 100),
          });
        }
        if (!slides.length) throw new EngineError('no_rasterizer', '无法渲染页面图像', 'error.noRasterizer');
        const bytes = await writePptx({ slides, title: baseName(input.name) });
        await ctx.emit({
          name: renderName(ctx.namePattern, { name: baseName(input.name), tool: 'ppt' }, 'pptx'),
          kind: 'pptx',
          bytes,
          sourceFileId: input.id,
        });
        produced += 1;
      } finally {
        raster.close();
      }
    }
    return { extra: { presentations: produced } };
  },
};
