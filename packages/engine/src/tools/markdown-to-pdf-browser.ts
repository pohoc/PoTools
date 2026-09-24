import { PDFDocument, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { num, str } from '../lib/options.ts';
import { createDocument, sizePreset } from '../lib/pdf.ts';
import { embedSystemFont, systemFontResources } from '../lib/system-fonts.ts';
import { parseMarkdown } from '../lib/textfmt.ts';
import { Typesetter, type TypesetterFontResolver, type TypesetImage } from '../lib/typesetter.ts';
import type { ToolImpl } from '../types.ts';

type FontFace = ReturnType<typeof fontkit.create> & { hasGlyphForCodePoint(codePoint: number): boolean };

/** Markdown import whose filesystem assets are supplied by the native host as bytes. */
export const embeddedMarkdownToPdfTool: ToolImpl = {
  id: 'markdown-to-pdf',
  async run(ctx) {
    let pageCountOut = 0;
    const suppliedImages = (ctx.runtimeData?.markdownAssets ?? {}) as Record<string, Uint8Array>;
    const fontBytes = ctx.runtimeData?.markdownFontBytes instanceof Uint8Array
      ? ctx.runtimeData.markdownFontBytes
      : null;
    const hostFonts = systemFontResources(ctx.runtimeData);

    for (const input of ctx.inputs) {
      const head = new TextDecoder().decode(input.bytes.slice(0, 8));
      if (head.startsWith('%PDF') || head.startsWith('PK')) {
        throw new EngineError(
          'unreadable_file',
          `${input.name} 是二进制文件，Markdown 导入只接受纯文本 .md`,
          'error.notMarkdown',
        );
      }
      const { blocks } = parseMarkdown(new TextDecoder('utf-8').decode(input.bytes));
      if (!blocks.length) throw new EngineError('empty_selection', `${input.name} 是空文档`);
      const box = sizePreset(str(ctx.options, 'pageSize')) ?? { width: 595.28, height: 841.89 };
      const out = await createDocument();
      const fontResolver: TypesetterFontResolver = async (doc, text) => fontBytes
        ? embedConfiguredFont(doc, text, fontBytes)
        : embedSystemFont(doc, text, hostFonts).catch((error) => {
          throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
        });
      const typesetter = new Typesetter(
        out,
        box,
        num(ctx.options, 'margin'),
        { size: num(ctx.options, 'fontSize'), lineHeight: 1.5, paragraphGap: 8, headingGap: 12, indent: 18 },
        fontResolver,
      );
      const resolvedImages = new Map<string, TypesetImage | null>();
      for (const block of blocks) {
        if (block.kind !== 'image' || !block.src) continue;
        const bytes = suppliedImages[assetKey(input.id, block.src)];
        if (bytes) resolvedImages.set(block.src, { bytes });
        else {
          resolvedImages.set(block.src, null);
          ctx.warnings.push(`找不到图片 ${block.src}`);
        }
      }
      await typesetter.block(blocks, {
        inline: true,
        imageFor: (block) => (block.src ? resolvedImages.get(block.src) ?? null : null),
      });
      const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'md-pdf' }, 'pdf'),
        bytes,
        input.id,
      );
      pageCountOut += out.getPageCount();
    }
    return { pageCountOut };
  },
};

export function assetKey(inputId: string, source: string): string {
  return `${inputId}\0${source}`;
}

async function embedConfiguredFont(doc: PDFDocument, text: string, bytes: Uint8Array | null): Promise<PDFFont> {
  if (!bytes) throw new InMemoryFallback('Markdown contains Unicode text and no configured font bytes were supplied');
  try {
    const parsed = fontkit.create(bytes) as FontFace & { fonts?: FontFace[] };
    const faces = parsed.fonts?.length ? parsed.fonts : [parsed];
    const codePoints = [...text]
      .filter((character) => !/\s/u.test(character))
      .map((character) => character.codePointAt(0)!)
      .filter((codePoint, index, all) => all.indexOf(codePoint) === index);
    const face = faces.find((candidate) => codePoints.every((codePoint) => candidate.hasGlyphForCodePoint(codePoint)));
    if (!face) throw new InMemoryFallback('Configured font does not contain all glyphs required by Markdown');
    doc.registerFontkit({ create: () => face });
    return await doc.embedFont(bytes, { subset: true });
  } catch (error) {
    if (error instanceof InMemoryFallback) throw error;
    throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
  }
}
