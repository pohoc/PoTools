import { dirname, join, basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument, rgb } from 'pdf-lib';
import { parsePageRanges } from '@potools/core';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num, str } from '../lib/options.ts';
import { createDocument, sizePreset } from '../lib/pdf.ts';
import { resolveFontPath, textFont } from '../lib/fonts.ts';
import { mmToPt, readOfd } from '../lib/ofd.ts';
import { parseMarkdown } from '../lib/textfmt.ts';
import { Typesetter, wrapText, type TypesetImage } from '../lib/typesetter.ts';
import { EngineError } from '../errors.ts';
import type { ToolContext, ToolImpl } from '../types.ts';

async function saveAndEmit(
  ctx: ToolContext,
  doc: Awaited<ReturnType<typeof createDocument>>,
  name: string,
  sourceFileId?: string,
): Promise<number> {
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  await ctx.emitPdf(name, bytes, sourceFileId);
  return doc.getPageCount();
}

const ofdToPdf: ToolImpl = {
  id: 'ofd-to-pdf',
  async run(ctx) {
    let pages = 0;
    for (const input of ctx.inputs) {
      const doc = await readOfd(input.bytes);
      if (!doc.pages.length) throw new EngineError('empty_selection', `${input.name} 中没有页面`);
      const wanted = new Set(parsePageRanges(str(ctx.options, 'pages'), doc.pages.length));
      const out = await createDocument();
      const fonts = new Map<string, Awaited<ReturnType<typeof out.embedFont>>>();
      if (doc.fonts.size) out.registerFontkit((await import('@pdf-lib/fontkit')).default);
      for (const [name, bytes] of doc.fonts) {
        try {
          fonts.set(name, await out.embedFont(bytes, { subset: true }));
        } catch {
          ctx.warnings.push(`字体 ${name} 无法嵌入，改用系统字体`);
        }
      }
      for (const [index, source] of doc.pages.entries()) {
        if (!wanted.has(index + 1)) continue;
        const box = { width: mmToPt(source.width), height: mmToPt(source.height) };
        const page = out.addPage([box.width, box.height]);
        pages += 1;
        for (const image of source.images) {
          try {
            const embedded =
              image.bytes[0] === 0xff && image.bytes[1] === 0xd8
                ? await out.embedJpg(image.bytes)
                : await out.embedPng(image.bytes);
            page.drawImage(embedded, {
              x: mmToPt(image.x),
              y: box.height - mmToPt(image.y) - mmToPt(image.height),
              width: mmToPt(image.width),
              height: mmToPt(image.height),
            });
          } catch {
            ctx.warnings.push(`${baseName(input.name)}：第 ${index + 1} 页有无法解码的图片`);
          }
        }
        for (const line of source.texts) {
          const embedded = line.font ? fonts.get(line.font) : undefined;
          const font = embedded ?? (await textFont(out, line.text, { fontPath: ctx.globals.fontPath })).font;
          page.drawText(line.text, {
            x: mmToPt(line.x),
            y: box.height - mmToPt(line.y),
            size: line.size,
            font,
            color: rgb(0.08, 0.1, 0.14),
          });
        }
        ctx.report({ percent: Math.round(((index + 1) / doc.pages.length) * 95) });
      }
      await saveAndEmit(
        ctx,
        out,
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'ofd-pdf' }, 'pdf'),
        input.id,
      );
    }
    return { pageCountOut: pages };
  },
};

const markdownToPdf: ToolImpl = {
  id: 'markdown-to-pdf',
  async run(ctx) {
    let pages = 0;
    for (const input of ctx.inputs) {
      const head = Buffer.from(input.bytes.slice(0, 8)).toString('latin1');
      // Feeding a PDF or an Office package in would typeset binary garbage.
      if (head.startsWith('%PDF') || head.startsWith('PK')) {
        throw new EngineError(
          'unreadable_file',
          `${input.name} 是二进制文件，Markdown 导入只接受纯文本 .md`,
          'error.notMarkdown',
        );
      }
      const { blocks } = parseMarkdown(Buffer.from(input.bytes).toString('utf8'));
      if (!blocks.length) throw new EngineError('empty_selection', `${input.name} 是空文档`);
      const box = sizePreset(str(ctx.options, 'pageSize')) ?? { width: 595.28, height: 841.89 };
      const out = await createDocument();
      const typesetter = new Typesetter(
        out,
        box,
        num(ctx.options, 'margin'),
        { size: num(ctx.options, 'fontSize'), lineHeight: 1.5, paragraphGap: 8, headingGap: 12, indent: 18 },
        async (doc, text) => (await textFont(doc, text, { fontPath: ctx.globals.fontPath })).font,
      );
      const folder = input.path ? dirname(input.path) : null;
      const cache = new Map<string, TypesetImage | null>();
      const imageFor = async (src: string): Promise<TypesetImage | null> => {
        if (!folder) return null;
        if (cache.has(src)) return cache.get(src) ?? null;
        const path = join(folder, decodeURIComponent(src));
        if (!existsSync(path)) {
          ctx.warnings.push(`找不到图片 ${src}`);
          cache.set(src, null);
          return null;
        }
        const image: TypesetImage = { bytes: new Uint8Array(await readFile(path)) };
        cache.set(src, image);
        return image;
      };
      const flow = blocks;
      // Resolve referenced files first so the synchronous imageFor can stay pure.
      const resolved = new Map<string, TypesetImage | null>();
      for (const block of flow) {
        if (block.kind !== 'image' || !block.src) continue;
        resolved.set(block.src, await imageFor(block.src));
      }
      await typesetter.block(flow, {
        inline: true,
        imageFor: (block) => (block.src ? (resolved.get(block.src) ?? null) : null),
      });
      pages += await saveAndEmit(
        ctx,
        out,
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'md-pdf' }, 'pdf'),
        input.id,
      );
    }
    return { pageCountOut: pages };
  },
};

export const importTools: ToolImpl[] = [ofdToPdf, markdownToPdf];
