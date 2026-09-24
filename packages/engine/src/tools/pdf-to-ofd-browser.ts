import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { ptToMm, writeOfd, type OfdPageInput } from '../lib/ofd.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { num } from '../lib/options.ts';
import { openRaster } from '../lib/render.ts';
import { readDocModel } from '../lib/docmodel.ts';
import { systemFontForText, systemFontResources } from '../lib/system-fonts.ts';
import type { ToolImpl } from '../types.ts';

/** Memory-only OFD image export for requests that do not need a local font. */
export const embeddedPdfToOfdTool: ToolImpl = {
  id: 'pdf-to-ofd',
  async run(ctx) {
    const mode = String(ctx.options.mode ?? 'text');
    const fontResource = ctx.runtimeData?.ofdFont as { name?: unknown; bytes?: unknown } | undefined;
    const hostFonts = systemFontResources(ctx.runtimeData);
    const dpi = num(ctx.options, 'dpi');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      if (!doc.getPageCount()) throw new EngineError('empty_selection', `${input.name} 没有页面`);
      const model = await readDocModel(input.bytes, doc, ctx.globals);
      const neededText = model.pages.flatMap((page) => page.lines)
        .filter((line) => !line.font)
        .map((line) => line.text)
        .join('');
      const matchedFont = mode === 'text' && !fontResource
        ? systemFontForText(neededText, hostFonts)?.resource
        : undefined;
      const selectedFont = fontResource && typeof fontResource.name === 'string' && fontResource.bytes instanceof Uint8Array
        ? { name: fontResource.name, bytes: fontResource.bytes }
        : matchedFont;
      if (mode === 'text' && !selectedFont) throw new InMemoryFallback('Text-mode OFD export requires a system font that covers the document');
      const font = mode === 'text' && selectedFont
        ? selectedFont.bytes.byteLength > 3_000_000
          ? (ctx.warnings.push('字体体积过大，OFD 内只登记字体名，请用装有该字体的阅读器打开'), { name: selectedFont.name })
          : { name: selectedFont.name, bytes: selectedFont.bytes }
        : null;
      const raster = mode === 'image' ? await openRaster(input.bytes, ctx.globals) : null;
      try {
        const pages: OfdPageInput[] = [];
        for (const page of model.pages) {
          const width = ptToMm(page.width);
          const height = ptToMm(page.height);
          if (mode === 'text') {
            pages.push({
              width,
              height,
              texts: page.lines.map((line) => ({
                text: line.text,
                x: ptToMm(line.x),
                y: ptToMm(line.y + line.size * 0.82),
                width: ptToMm(line.w),
                size: ptToMm(line.size),
              })),
              images: [],
            });
            continue;
          }
          if (!raster) throw new InMemoryFallback('MuPDF rasterizer is unavailable');
          const bytes = raster.renderPng({ page: page.page, dpi });
          if (!bytes.length) continue;
          pages.push({
            width,
            height,
            texts: [],
            images: [{ bytes, name: `${baseName(input.name)}-p${page.page}.png`, x: 0, y: 0, width, height }],
          });
        }
        if (!pages.length) throw new EngineError('no_rasterizer', '没有可导出的页面', 'error.noRasterizer');
        const stem = baseName(input.name);
        const bytes = await writeOfd({ title: stem, author: 'PoTools', font, pages });
        await ctx.emit({
          name: renderName(ctx.namePattern, { name: stem, tool: 'ofd' }, 'ofd'),
          kind: 'ofd',
          bytes,
          sourceFileId: input.id,
        });
        produced += 1;
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
      } finally {
        raster?.close();
      }
    }
    return { extra: { documents: produced } };
  },
};
