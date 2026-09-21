import { dirname, join, basename } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { rgb } from 'pdf-lib';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num, str } from '../lib/options.ts';
import { createDocument, sizePreset } from '../lib/pdf.ts';
import { textFont } from '../lib/fonts.ts';
import { readDocx, readPptx, readXlsx } from '../lib/office.ts';
import { mmToPt, readOfd } from '../lib/ofd.ts';
import { parseMarkdown } from '../lib/textfmt.ts';
import { Typesetter, wrapText, type TypesetImage } from '../lib/typesetter.ts';
import { EngineError } from '../errors.ts';
import type { ToolContext, ToolImpl } from '../types.ts';

const execFileAsync = promisify(execFile);

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
      const { blocks, images } = await readDocx(input.bytes);
      if (!blocks.length) throw new EngineError('empty_selection', `${input.name} 没有可导入的段落`);
      const box = sizePreset(str(ctx.options, 'pageSize')) ?? { width: 595.28, height: 841.89 };
      const out = await createDocument();
      const typesetter = new Typesetter(out, box, num(ctx.options, 'margin'), undefined, ctx.globals.fontPath);
      await typesetter.block(blocks, {
        imageFor: (block): TypesetImage | null => {
          const key = block.src?.split('/').pop();
          const bytes = key ? images.get(key) : undefined;
          return bytes ? { bytes } : null;
        },
      });
      pages += await saveAndEmit(
        ctx,
        out,
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'word-pdf' }, 'pdf'),
        input.id,
      );
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: pages };
  },
};

/**
 * Converts only paired legacy/OOXML formats. LibreOffice performs the feature
 * mapping; basic CFB signatures or the required OOXML/OPC package parts are
 * checked before a result is exposed to the user. This does not claim full
 * schema validation or lossless preservation of every Office feature.
 */
const OFFICE_PAIRS = [
  { id: 'doc-to-docx', from: 'doc', to: 'docx', kind: 'docx' },
  { id: 'docx-to-doc', from: 'docx', to: 'doc', kind: 'doc' },
  { id: 'xls-to-xlsx', from: 'xls', to: 'xlsx', kind: 'xlsx' },
  { id: 'xlsx-to-xls', from: 'xlsx', to: 'xls', kind: 'xls' },
  { id: 'ppt-to-pptx', from: 'ppt', to: 'pptx', kind: 'pptx' },
  { id: 'pptx-to-ppt', from: 'pptx', to: 'ppt', kind: 'ppt' },
] as const;

const OFFICE_EXECUTABLES = process.platform === 'win32'
  ? ['soffice.exe', 'soffice']
  : process.platform === 'darwin'
    ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice', 'libreoffice']
    : ['soffice', 'libreoffice'];

async function findOfficeExecutable(): Promise<string | null> {
  for (const candidate of OFFICE_EXECUTABLES) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 8_000, windowsHide: true });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return candidate;
    }
  }
  return null;
}

function officePairTool(pair: (typeof OFFICE_PAIRS)[number]): ToolImpl {
  return {
    id: pair.id,
    async run(ctx) {
      const executable = await findOfficeExecutable();
      if (!executable) {
        throw new EngineError('unsupported', '此类格式转换需要在本机安装 LibreOffice。');
      }
      const root = await mkdtemp(join(tmpdir(), 'potools-office-'));
      const inputDir = join(root, 'input');
      const outputDir = join(root, 'output');
      const profileDir = join(root, 'profile');
      const { mkdir } = await import('node:fs/promises');
      await Promise.all([mkdir(inputDir), mkdir(outputDir), mkdir(profileDir)]);
      try {
        for (const [index, input] of ctx.inputs.entries()) {
          if (!input.name.toLowerCase().endsWith(`.${pair.from}`)) {
            throw new EngineError('bad_request', `${input.name} 格式不匹配；此工具只接受 .${pair.from} 文件。`);
          }
          await validateOfficeContainer(input.bytes, pair.from, input.name);
          const cleanName = basename(input.name).replace(/[\\/:*?"<>|]/g, '_').replace(/\.${pair.from}$/i, '') || `file-${index + 1}`;
          const source = join(inputDir, `${index + 1}-${cleanName}.${pair.from}`);
          const output = join(outputDir, `${index + 1}-${cleanName}.${pair.to}`);
          await writeFile(source, input.bytes);
          try {
            await execFileAsync(
              executable,
              [
                '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
                `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
                '--convert-to', pair.to, '--outdir', outputDir, source,
              ],
              { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new EngineError('unreadable_file', `无法转换 ${input.name}：${detail}`);
          }
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(await readFile(output));
          } catch {
            throw new EngineError('unreadable_file', `${input.name} 转换失败；请确认文件未损坏并可由 LibreOffice 打开。`);
          }
          await validateOfficeContainer(bytes, pair.to, `${input.name} 转换结果`);
          await ctx.emit({
            name: renderName(ctx.namePattern, { name: baseName(input.name), tool: pair.to }, pair.to),
            kind: pair.kind,
            bytes,
            sourceFileId: input.id,
          });
          ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
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

const CELL_SIZE = 8.5;

const excelToPdf: ToolImpl = {
  id: 'excel-to-pdf',
  async run(ctx) {
    const preset = str(ctx.options, 'pageSize');
    const orientation = str(ctx.options, 'orientation');
    const repeatHeader = bool(ctx.options, 'repeatHeader');
    const margin = 34;
    let pages = 0;
    let sheets = 0;

    for (const input of ctx.inputs) {
      const data = await readXlsx(input.bytes);
      if (!data.length) throw new EngineError('empty_selection', `${input.name} 没有非空工作表`);
      const out = await createDocument();
      const latinFont = (await textFont(out, 'Revenue 0', { fontPath: ctx.globals.fontPath })).font;
      const cjkFont = (await textFont(out, '收入零', { fontPath: ctx.globals.fontPath })).font;
      const cellWidth = (value: string): number => {
        const font = /[\u3000-\u30ff\u4e00-\u9fff\uff00-\uff60]/.test(value) ? cjkFont : latinFont;
        return font.widthOfTextAtSize(String(value ?? ''), CELL_SIZE);
      };
      let base = sizePreset(preset) ?? { width: 595.28, height: 841.89 };
      let page = out.addPage([base.width, base.height]);
      let y = base.height - margin;
      let fresh = true;

      const startPage = (): void => {
        if (fresh) {
          fresh = false;
          return;
        }
        page = out.addPage([base.width, base.height]);
        y = base.height - margin;
        pages += 1;
      };

      let headerRef: string[] = [];
      const drawRow = async (cells: string[], bold: boolean, columns: number[]): Promise<void> => {
        const font = (await textFont(out, cells.join(' ') || 'x', { fontPath: ctx.globals.fontPath })).font;
        const lineHeight = CELL_SIZE * 1.35;
        const wrapped = cells.map((cell, column) =>
          wrapText(String(cell ?? ''), font, CELL_SIZE, Math.max(20, (columns[column] ?? 60) - 6)),
        );
        const height = Math.max(...wrapped.map((lines) => lines.length), 1) * lineHeight + 4;
        if (y - height < margin) {
          startPage();
          if (repeatHeader && !bold) await drawRow(headerRef, true, columns);
        }
        let x = margin;
        for (const [column, lines] of wrapped.entries()) {
          const width = columns[column] ?? 60;
          page.drawRectangle({
            x,
            y: y - height,
            width,
            height,
            borderColor: rgb(0.78, 0.81, 0.86),
            borderWidth: 0.4,
            color: bold ? rgb(0.93, 0.95, 0.99) : undefined,
          });
          lines.forEach((line, lineIndex) => {
            if (!line.trim()) return;
            page.drawText(line, {
              x: x + 3,
              y: y - height + 3 + (lines.length - 1 - lineIndex) * lineHeight,
              size: CELL_SIZE,
              font,
              color: rgb(0.1, 0.12, 0.16),
            });
          });
          x += width;
        }
        y -= height;
      };

      for (const sheetData of data) {
        const natural = sheetData.rows.reduce((widest, row) => Math.max(widest, row.length), 1);
        const widths: number[] = [];
        for (let column = 0; column < natural; column += 1) {
          // Measure the widest cell so numbers and CJK words are not split.
          const measured = Math.max(...sheetData.rows.map((row) => cellWidth(row[column] ?? '')));
          const declared = (sheetData.colWidths[column] ?? 0) * 5.2;
          widths.push(Math.min(260, Math.max(34, Math.max(measured, declared) + 10)));
        }
        const total = widths.reduce((sum, value) => sum + value, 0);
        const wantsLandscape =
          orientation === 'landscape' || (orientation === 'auto' && total > base.width - margin * 2);
        base = wantsLandscape
          ? { width: Math.max(base.width, base.height), height: Math.min(base.width, base.height) }
          : { width: Math.min(base.width, base.height), height: Math.max(base.width, base.height) };
        const available = base.width - margin * 2;
        const scale = Math.min(1, available / Math.max(total, 1));
        const columns = widths.map((value) => value * scale);

        startPage();
        const heading = (await textFont(out, sheetData.name, { fontPath: ctx.globals.fontPath })).font;
        page.drawText(sheetData.name, { x: margin, y, size: 12, font: heading, color: rgb(0.2, 0.25, 0.35) });
        y -= 18;
        const [header, ...body] = sheetData.rows;
        headerRef = header ?? [];
        if (header) await drawRow(header, true, columns);
        for (const row of body) await drawRow(row, false, columns);
        sheets += 1;
      }
      await saveAndEmit(
        ctx,
        out,
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'excel-pdf' }, 'pdf'),
        input.id,
      );
    }
    return { pageCountOut: pages, extra: { sheets } };
  },
};

const pptToPdf: ToolImpl = {
  id: 'ppt-to-pdf',
  async run(ctx) {
    const toA4 = str(ctx.options, 'pageSize') === 'a4';
    let pages = 0;
    for (const input of ctx.inputs) {
      const { slides, widthIn, heightIn } = await readPptx(input.bytes);
      if (!slides.length) throw new EngineError('empty_selection', `${input.name} 没有幻灯片`);
      const out = await createDocument();
      const a4 = { width: 595.28, height: 841.89 };
      const slide = { width: widthIn * 72, height: heightIn * 72 };
      const scale = toA4 ? Math.min(a4.width / slide.width, a4.height / slide.height) : 1;
      const box = { width: slide.width * scale, height: slide.height * scale };
      for (const [index, item] of slides.entries()) {
        const page = out.addPage([box.width, box.height]);
        pages += 1;
        for (const bytes of item.images) {
          try {
            const embedded =
              bytes[0] === 0xff && bytes[1] === 0xd8 ? await out.embedJpg(bytes) : await out.embedPng(bytes);
            const fit = Math.min(box.width / embedded.width, box.height / embedded.height, 1);
            page.drawImage(embedded, {
              x: (box.width - embedded.width * fit) / 2,
              y: (box.height - embedded.height * fit) / 2,
              width: embedded.width * fit,
              height: embedded.height * fit,
            });
          } catch {
            ctx.warnings.push(`${baseName(input.name)}：第 ${index + 1} 页有无法解码的图片，已跳过`);
          }
        }
        for (const text of item.texts) {
          const font = (await textFont(out, text.text, { fontPath: ctx.globals.fontPath })).font;
          const size = Math.max(5, text.size * scale);
          const width = Math.max(24, text.wIn * 72 * scale);
          const lines = wrapText(text.text, font, size, width);
          const top = box.height - text.yIn * 72 * scale;
          lines.forEach((line, lineIndex) => {
            if (!line.trim()) return;
            page.drawText(line, {
              x: text.xIn * 72 * scale,
              y: top - size * 1.25 * (lineIndex + 1),
              size,
              font,
              color: rgb(0.12, 0.14, 0.2),
            });
          });
        }
        ctx.report({ percent: Math.round(((index + 1) / slides.length) * 95) });
      }
      await saveAndEmit(
        ctx,
        out,
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'ppt-pdf' }, 'pdf'),
        input.id,
      );
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
