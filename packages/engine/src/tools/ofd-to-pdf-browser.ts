import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { parsePageRanges } from '@potools/core';
import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { str } from '../lib/options.ts';
import { mmToPt, readOfd } from '../lib/ofd.ts';
import type { ToolImpl } from '../types.ts';

/** OFD import using only bundled JS/WASM-friendly libraries and input bytes. */
export const embeddedOfdToPdfTool: ToolImpl = {
  id: 'ofd-to-pdf',
  async run(ctx) {
    let pagesOut = 0;
    for (const input of ctx.inputs) {
      const doc = await readOfd(input.bytes);
      if (!doc.pages.length) throw new EngineError('empty_selection', `${input.name} 中没有页面`);
      const wanted = new Set(parsePageRanges(str(ctx.options, 'pages'), doc.pages.length));
      const out = await PDFDocument.create();
      out.setProducer('PoTools');
      out.setCreator('PoTools');
      out.setCreationDate(new Date());
      out.setModificationDate(new Date());

      const embeddedFonts = new Map<string, PDFFont>();
      if (doc.fonts.size) out.registerFontkit(fontkit);
      for (const [name, bytes] of doc.fonts) {
        try {
          embeddedFonts.set(name, await out.embedFont(bytes, { subset: true }));
        } catch {
          // The original engine reports this and falls back to a host font.
          // Let unsupported text take the compatibility route below.
          ctx.warnings.push(`字体 ${name} 无法嵌入，尝试使用标准字体`);
        }
      }
      const standardFont = await out.embedFont(StandardFonts.Helvetica);

      for (const [index, source] of doc.pages.entries()) {
        if (!wanted.has(index + 1)) continue;
        const width = mmToPt(source.width);
        const height = mmToPt(source.height);
        const page = out.addPage([width, height]);
        pagesOut += 1;
        for (const image of source.images) {
          try {
            const embedded = image.bytes[0] === 0xff && image.bytes[1] === 0xd8
              ? await out.embedJpg(image.bytes)
              : await out.embedPng(image.bytes);
            page.drawImage(embedded, {
              x: mmToPt(image.x),
              y: height - mmToPt(image.y) - mmToPt(image.height),
              width: mmToPt(image.width),
              height: mmToPt(image.height),
            });
          } catch {
            ctx.warnings.push(`${baseName(input.name)}：第 ${index + 1} 页有无法解码的图片`);
          }
        }
        for (const line of source.texts) {
          const selectedFont = line.font ? embeddedFonts.get(line.font) : undefined;
          const font = selectedFont ?? standardFont;
          try {
            font.encodeText(line.text);
          } catch {
            // System font discovery/registry access belongs to the native host.
            throw new InMemoryFallback(`OFD text needs a system font: ${line.text.slice(0, 24)}`);
          }
          page.drawText(line.text, {
            x: mmToPt(line.x),
            y: height - mmToPt(line.y),
            size: mmToPt(line.size),
            font,
            color: rgb(0.08, 0.1, 0.14),
          });
        }
        ctx.report({ percent: Math.round(((index + 1) / doc.pages.length) * 95) });
      }

      const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'ofd-pdf' }, 'pdf'),
        bytes,
        input.id,
      );
    }
    return { pageCountOut: pagesOut };
  },
};
