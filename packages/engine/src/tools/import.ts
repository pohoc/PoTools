import { dirname, join, basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument, rgb } from 'pdf-lib';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num, str } from '../lib/options.ts';
import { createDocument, sizePreset } from '../lib/pdf.ts';
import { resolveFontPath, textFont } from '../lib/fonts.ts';
import { readXlsx } from '../lib/office.ts';
import { convertOfficeLocally } from '../lib/document-builder.ts';
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

const wordToPdf: ToolImpl = {
  id: 'word-to-pdf',
  async run(ctx) {
    let pages = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      if (!input.name.toLowerCase().endsWith('.docx')) {
        throw new EngineError('bad_request', `${input.name} 格式不匹配；此工具只接受 .docx 文件。`);
      }
      await validateOfficeContainer(input.bytes, 'docx', input.name);
      const bytes = await convertOfficeLocally(input.bytes, 'docx', 'pdf', {
        mode: 'word-to-pdf',
        pageSize: str(ctx.options, 'pageSize') || 'a4',
        marginPt: num(ctx.options, 'margin'),
        fontPath: resolveFontPath(ctx.globals.fontPath),
      });
      const pdf = await PDFDocument.load(bytes);
      if (pdf.getPageCount() === 0) throw new EngineError('empty_selection', `${input.name} 没有可导出的页面`);
      pages += pdf.getPageCount();
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'word-pdf' }, 'pdf'), bytes, input.id);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: pages };
  },
};

/**
 * Converts paired legacy/OOXML formats in a local Document Builder process.
 * Basic CFB signatures or required OOXML/OPC package parts are checked before
 * output is exposed. Full schema validation or lossless feature preservation
 * is not claimed.
 */
const OFFICE_PAIRS = [
  { id: 'doc-to-docx', from: 'doc', to: 'docx', kind: 'docx' },
  { id: 'docx-to-doc', from: 'docx', to: 'doc', kind: 'doc' },
  { id: 'xls-to-xlsx', from: 'xls', to: 'xlsx', kind: 'xlsx' },
  { id: 'xlsx-to-xls', from: 'xlsx', to: 'xls', kind: 'xls' },
  { id: 'ppt-to-pptx', from: 'ppt', to: 'pptx', kind: 'pptx' },
  { id: 'pptx-to-ppt', from: 'pptx', to: 'ppt', kind: 'ppt' },
] as const;

function officePairTool(pair: (typeof OFFICE_PAIRS)[number]): ToolImpl {
  return {
    id: pair.id,
    async run(ctx) {
      for (const [index, input] of ctx.inputs.entries()) {
        if (!input.name.toLowerCase().endsWith(`.${pair.from}`)) {
          throw new EngineError('bad_request', `${input.name} 格式不匹配；此工具只接受 .${pair.from} 文件。`);
        }
        await validateOfficeContainer(input.bytes, pair.from, input.name);
        const bytes = await convertOfficeLocally(input.bytes, pair.from, pair.to);
        await validateOfficeContainer(bytes, pair.to, `${input.name} 转换结果`);
        await ctx.emit({
          name: renderName(ctx.namePattern, { name: baseName(input.name), tool: pair.to }, pair.to),
          kind: pair.kind,
          bytes,
          sourceFileId: input.id,
        });
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
      }
      return { pageCountOut: ctx.inputs.length };
    },
  };
}

async function validateOfficeContainer(bytes: Uint8Array, extension: string, label: string): Promise<void> {
  const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (['doc', 'xls', 'ppt'].includes(extension)) {
    if (!cfb.every((byte, index) => bytes[index] === byte)) {
      throw new EngineError('unreadable_file', `${label} 不是有效的 Office 97–2003 二进制容器。`);
    }
    return;
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new EngineError('unreadable_file', `${label} 不是有效的 Office Open XML/OPC ZIP 包。`);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    throw new EngineError('unreadable_file', `${label} 的 Office Open XML 包结构不完整或校验失败。`);
  }
  const contentTypes = zip.file('[Content_Types].xml');
  const rootRelationships = zip.file('_rels/.rels');
  const mainPart = extension === 'docx' ? 'word/document.xml' : extension === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  const expectedType = extension === 'docx'
    ? 'wordprocessingml.document.main+xml'
    : extension === 'xlsx'
      ? 'spreadsheetml.sheet.main+xml'
      : 'presentationml.presentation.main+xml';
  if (!contentTypes || !rootRelationships || !zip.file(mainPart)) {
    throw new EngineError('unreadable_file', `${label} 缺少 Office Open XML 所需的包部件。`);
  }
  const typesXml = await contentTypes.async('string');
  if (!typesXml.includes(expectedType)) {
    throw new EngineError('unreadable_file', `${label} 的主文档类型与 .${extension} 扩展名不匹配。`);
  }
}

const officeFormatTools = OFFICE_PAIRS.map(officePairTool);

const excelToPdf: ToolImpl = {
  id: 'excel-to-pdf',
  async run(ctx) {
    let pages = 0;
    let sheets = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      if (!input.name.toLowerCase().endsWith('.xlsx')) {
        throw new EngineError('bad_request', `${input.name} 格式不匹配；此工具只接受 .xlsx 文件。`);
      }
      await validateOfficeContainer(input.bytes, 'xlsx', input.name);
      const bytes = await convertOfficeLocally(input.bytes, 'xlsx', 'pdf', {
        mode: 'excel-to-pdf',
        pageSize: str(ctx.options, 'pageSize') || 'a4',
        orientation: str(ctx.options, 'orientation') || 'auto',
        repeatHeader: bool(ctx.options, 'repeatHeader'),
        fontPath: resolveFontPath(ctx.globals.fontPath),
      });
      const pdf = await PDFDocument.load(bytes);
      if (pdf.getPageCount() === 0) throw new EngineError('empty_selection', `${input.name} 没有可导出的页面`);
      pages += pdf.getPageCount();
      sheets += (await readXlsx(input.bytes)).length;
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'excel-pdf' }, 'pdf'), bytes, input.id);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: pages, extra: { sheets } };
  },
};

const pptToPdf: ToolImpl = {
  id: 'ppt-to-pdf',
  async run(ctx) {
    let pages = 0;
    for (const [inputIndex, input] of ctx.inputs.entries()) {
      if (!input.name.toLowerCase().endsWith('.pptx')) {
        throw new EngineError('bad_request', `${input.name} 格式不匹配；此工具只接受 .pptx 文件。`);
      }
      await validateOfficeContainer(input.bytes, 'pptx', input.name);
      const converted = await convertOfficeLocally(input.bytes, 'pptx', 'pdf', {
        fontPath: resolveFontPath(ctx.globals.fontPath),
      });
      let bytes = converted;
      if (str(ctx.options, 'pageSize') === 'a4') {
        const source = await PDFDocument.load(converted);
        const destination = await PDFDocument.create();
        for (const sourcePage of source.getPages()) {
          const embedded = await destination.embedPage(sourcePage);
          const box = { width: 595.28, height: 841.89 };
          const scale = Math.min(box.width / embedded.width, box.height / embedded.height);
          const width = embedded.width * scale;
          const height = embedded.height * scale;
          const page = destination.addPage([box.width, box.height]);
          page.drawPage(embedded, { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height });
        }
        bytes = await destination.save({ useObjectStreams: true, addDefaultPage: false });
      }
      const pdf = await PDFDocument.load(bytes);
      if (pdf.getPageCount() === 0) throw new EngineError('empty_selection', `${input.name} 没有幻灯片`);
      pages += pdf.getPageCount();
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'ppt-pdf' }, 'pdf'), bytes, input.id);
      ctx.report({ percent: Math.round(((inputIndex + 1) / ctx.inputs.length) * 100), current: inputIndex + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: pages };
  },
};

const ofdToPdf: ToolImpl = {
  id: 'ofd-to-pdf',
  async run(ctx) {
    let pages = 0;
    for (const input of ctx.inputs) {
      const doc = await readOfd(input.bytes);
      if (!doc.pages.length) throw new EngineError('empty_selection', `${input.name} 中没有页面`);
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
        ctx.globals.fontPath,
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

export const importTools: ToolImpl[] = [wordToPdf, ...officeFormatTools, excelToPdf, pptToPdf, ofdToPdf, markdownToPdf];
