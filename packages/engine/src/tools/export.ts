import { readFile } from 'node:fs/promises';
import type { JobGlobals } from '@potools/core';
import { loadPdf } from '../lib/files.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num, str } from '../lib/options.ts';
import { EngineError } from '../errors.ts';
import { cropRegion, readDocModel, toFlow, toRows, type DocModel, type FlowBlock, type Rect } from '../lib/docmodel.ts';
import {
  DELIMITERS,
  flowToHtml,
  flowToMarkdown,
  flowToRtf,
  rowsToCsv,
} from '../lib/textfmt.ts';
import { writeDocx, writePptx, writeXlsx } from '../lib/office.ts';
import { chapterize, writeEpub, type EpubImage } from '../lib/epub.ts';
import { ptToMm, writeOfd, type OfdFontInput, type OfdPageInput } from '../lib/ofd.ts';
import { resolveFontPath } from '../lib/fonts.ts';
import { openRaster, type RasterHandle } from '../lib/render.ts';
import { recognizePaddlePage } from '../lib/ocr.ts';
import type { ResolvedInput, ToolImpl } from '../types.ts';

interface Source {
  input: ResolvedInput;
  doc: Awaited<ReturnType<typeof loadPdf>>;
  model: DocModel;
  flow: FlowBlock[];
  raster: RasterHandle;
}

async function openSource(input: ResolvedInput, globals: JobGlobals, pageBreaks: boolean): Promise<Source> {
  const doc = await loadPdf(input, globals);
  if (!doc.getPageCount()) throw new EngineError('empty_selection', `${input.name} 没有页面`);
  const model = await readDocModel(input.bytes, doc, globals);
  const raster = await openRaster(input.bytes, globals);
  return { input, doc, model, flow: toFlow(model, { pageBreaks }), raster };
}

async function cropAll(
  source: Source,
  dpi: number,
): Promise<Map<Extract<FlowBlock, { kind: 'image' }>, { bytes: Uint8Array; width: number; height: number }>> {
  const out = new Map<Extract<FlowBlock, { kind: 'image' }>, { bytes: Uint8Array; width: number; height: number }>();
  for (const block of source.flow) {
    if (block.kind !== 'image') continue;
    if (!block.box.w || !block.box.h) continue;
    const bytes = await cropRegion(source.raster, block.page, block.box as Rect, dpi);
    if (bytes) out.set(block, { bytes, width: block.box.w, height: block.box.h });
  }
  return out;
}

const PT_TO_PX = 96 / 72;

const pdfToWord: ToolImpl = {
  id: 'pdf-to-word',
  async run(ctx) {
    const wantImages = bool(ctx.options, 'includeImages');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, bool(ctx.options, 'pageBreaks'));
      const crops = wantImages ? await cropAll(source, 150) : new Map();
      const first = source.model.pages[0];
      // A scanned PDF has no text blocks. Previously this produced a valid but
      // completely empty DOCX when includeImages was disabled. Preserve each
      // textless page as a full-page image so the conversion never loses the
      // visible document content.
      const fallbackImages = new Map<FlowBlock, { bytes: Uint8Array; width: number; height: number }>();
      const blocks: FlowBlock[] = [];
      for (const [pageIndex, page] of source.model.pages.entries()) {
        if (bool(ctx.options, 'pageBreaks') && pageIndex > 0) blocks.push({ kind: 'pageBreak' });
        blocks.push(...source.flow.filter((block) => 'page' in block && block.page === page.page));
        if (page.lines.length > 0) continue;
        try {
          const ocr = await recognizePaddlePage(source.raster.renderPng({ page: page.page, dpi: 200 }));
          const recognized = (ocr.lines.length ? ocr.lines.map((line) => line.text) : ocr.text.split(/\r?\n/))
            .map((line) => line.trim())
            .filter(Boolean);
          if (recognized.length) {
            blocks.push({ kind: 'paragraph', text: recognized.join('\n'), page: page.page, bold: false });
            continue;
          }
        } catch (error) {
          if (!(error instanceof EngineError) || error.code !== 'unsupported') throw error;
        }
        const block: FlowBlock = {
          kind: 'image',
          page: page.page,
          box: { x: 0, y: 0, w: page.width, h: page.height },
        };
        blocks.push(block);
        fallbackImages.set(block, {
          bytes: source.raster.renderPng({ page: page.page, dpi: 150 }),
          width: page.width,
          height: page.height,
        });
      }
      const bytes = await writeDocx({
        title: baseName(input.name),
        blocks,
        pageBreaks: bool(ctx.options, 'pageBreaks'),
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
      source.raster.close();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { extra: { documents: produced } };
  },
};

const pdfToExcel: ToolImpl = {
  id: 'pdf-to-excel',
  async run(ctx) {
    const sheetPerPage = bool(ctx.options, 'sheetPerPage');
    const gap = num(ctx.options, 'columnGap');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, false);
      const stem = baseName(input.name);
      const sheets = sheetPerPage
        ? source.model.pages.map((page) => ({ name: `${stem} ${page.page}`, rows: toRows(page, gap) }))
        : [{ name: stem, rows: source.model.pages.flatMap((page) => toRows(page, gap)) }];
      const bytes = await writeXlsx(sheets.filter((sheet) => sheet.rows.length));
      await ctx.emit({
        name: renderName(ctx.namePattern, { name: stem, tool: 'excel' }, 'xlsx'),
        kind: 'xlsx',
        bytes,
        sourceFileId: input.id,
      });
      produced += 1;
      source.raster.close();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { extra: { workbooks: produced } };
  },
};

const pdfToPpt: ToolImpl = {
  id: 'pdf-to-ppt',
  async run(ctx) {
    const withText = bool(ctx.options, 'textLayer');
    const dpi = num(ctx.options, 'dpi');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, false);
      const slides = [];
      for (const page of source.model.pages) {
        const png = await cropRegion(source.raster, page.page, { x: 0, y: 0, w: page.width, h: page.height }, dpi);
        if (!png) continue;
        const widthIn = page.width / 72;
        const heightIn = page.height / 72;
        slides.push({
          widthIn,
          heightIn,
          image: png,
          lines: withText
            ? page.lines.map((line) => ({
                text: line.text,
                xIn: line.x / 72,
                yIn: line.y / 72,
                wIn: Math.max(0.2, line.w / 72),
                hIn: Math.max(0.12, line.h / 72),
                size: line.size,
                bold: line.weight === 'bold' || /bold/i.test(line.font),
              }))
            : [],
        });
        ctx.report({ percent: Math.round(((index + page.page / source.model.pages.length) / ctx.inputs.length) * 100) });
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
      source.raster.close();
    }
    return { extra: { presentations: produced } };
  },
};

const pdfToMarkdown: ToolImpl = {
  id: 'pdf-to-markdown',
  async run(ctx) {
    const wantImages = bool(ctx.options, 'includeImages');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, bool(ctx.options, 'pageBreaks'));
      const stem = baseName(input.name);
      const crops = wantImages ? await cropAll(source, 150) : new Map();
      const counters = new Map<number, number>();
      const markdown = flowToMarkdown(source.flow, (block) => {
        const crop = crops.get(block);
        if (!crop) return null;
        const next = (counters.get(block.page) ?? 0) + 1;
        counters.set(block.page, next);
        const name = `${stem}-p${block.page}-${String(next).padStart(2, '0')}.png`;
        void ctx.emit({ name, kind: 'image', bytes: crop.bytes, sourceFileId: input.id });
        return name;
      });
      await ctx.emit({
        name: renderName(ctx.namePattern, { name: stem, tool: 'markdown' }, 'md'),
        kind: 'md',
        bytes: Buffer.from(markdown, 'utf8'),
        sourceFileId: input.id,
      });
      produced += 1;
      source.raster.close();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { extra: { documents: produced } };
  },
};

const pdfToHtml: ToolImpl = {
  id: 'pdf-to-html',
  async run(ctx) {
    const embed = bool(ctx.options, 'embedImages');
    const dpi = num(ctx.options, 'dpi');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, false);
      const stem = baseName(input.name);
      const crops = await cropAll(source, dpi);
      const counters = new Map<number, number>();
      const html = flowToHtml(source.flow, {
        title: stem,
        imageFor: (block) => {
          const crop = crops.get(block);
          if (!crop) return null;
          if (embed) return `data:image/png;base64,${Buffer.from(crop.bytes).toString('base64')}`;
          const next = (counters.get(block.page) ?? 0) + 1;
          counters.set(block.page, next);
          const name = `${stem}-p${block.page}-${String(next).padStart(2, '0')}.png`;
          void ctx.emit({ name, kind: 'image', bytes: crop.bytes, sourceFileId: input.id });
          return name;
        },
      });
      await ctx.emit({
        name: renderName(ctx.namePattern, { name: stem, tool: 'html' }, 'html'),
        kind: 'html',
        bytes: Buffer.from(html, 'utf8'),
        sourceFileId: input.id,
      });
      produced += 1;
      source.raster.close();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { extra: { documents: produced } };
  },
};

const pdfToCsv: ToolImpl = {
  id: 'pdf-to-csv',
  async run(ctx) {
    const delimiter = DELIMITERS[str(ctx.options, 'delimiter')] ?? ',';
    const gap = num(ctx.options, 'columnGap');
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, false);
      const stem = baseName(input.name);
      const pages = source.model.pages.map((page) => ({ page: page.page, rows: toRows(page, gap) }));
      const kept = pages.filter((entry) => entry.rows.length);
      if (!kept.length) {
        ctx.warnings.push(`${stem}：未识别到可导出的表格行`);
        source.raster.close();
        continue;
      }
      const rows = kept.length === 1 ? kept[0]!.rows : kept.flatMap((entry) => [[`# page ${entry.page}`], ...entry.rows, ['']]);
      await ctx.emit({
        name: renderName(ctx.namePattern, { name: stem, tool: 'csv' }, 'csv'),
        kind: 'csv',
        bytes: Buffer.from(rowsToCsv(rows, delimiter), 'utf8'),
        sourceFileId: input.id,
      });
      produced += 1;
      source.raster.close();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    if (!produced) throw new EngineError('empty_selection', '没有可导出的表格内容');
    return { extra: { tables: produced } };
  },
};

const pdfToRtf: ToolImpl = {
  id: 'pdf-to-rtf',
  async run(ctx) {
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, bool(ctx.options, 'pageBreaks'));
      const rtf = flowToRtf(source.flow);
      await ctx.emit({
        name: renderName(ctx.namePattern, { name: baseName(input.name), tool: 'rtf' }, 'rtf'),
        kind: 'rtf',
        bytes: Buffer.from(rtf, 'utf8'),
        sourceFileId: input.id,
      });
      produced += 1;
      source.raster.close();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { extra: { documents: produced } };
  },
};

const pdfToEpub: ToolImpl = {
  id: 'pdf-to-epub',
  async run(ctx) {
    const wantImages = bool(ctx.options, 'includeImages');
    const by = str(ctx.options, 'chapterBy') === 'page' ? 'page' : 'heading';
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, false);
      const stem = baseName(input.name);
      const images = new Map<string, EpubImage>();
      const flow: FlowBlock[] = [];
      let counter = 0;
      for (const block of source.flow) {
        if (block.kind === 'image' && wantImages && block.box.w && block.box.h) {
          const bytes = await cropRegion(source.raster, block.page, block.box, 144);
          if (bytes) {
            counter += 1;
            const name = `p${block.page}-${String(counter).padStart(2, '0')}.png`;
            images.set(name, { name, bytes });
            flow.push({ ...block, src: name });
            continue;
          }
        }
        flow.push(block);
      }
      const chapters = chapterize(flow, by);
      const bytes = await writeEpub({
        title: stem,
        author: 'PoTools',
        chapters,
        images,
      });
      await ctx.emit({
        name: renderName(ctx.namePattern, { name: stem, tool: 'epub' }, 'epub'),
        kind: 'epub',
        bytes,
        sourceFileId: input.id,
      });
      produced += 1;
      source.raster.close();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { extra: { books: produced } };
  },
};

const pdfToOfd: ToolImpl = {
  id: 'pdf-to-ofd',
  async run(ctx) {
    let mode = str(ctx.options, 'mode');
    const dpi = num(ctx.options, 'dpi');
    const fontPath = mode === 'text' ? resolveFontPath(ctx.globals.fontPath) : null;
    if (mode === 'text' && !fontPath) {
      ctx.warnings.push('未找到可嵌入的中文字体，已改用整页图像方式导出');
      mode = 'image';
    }
    let font: OfdFontInput | null = null;
    if (fontPath) {
      const bytes = new Uint8Array(await readFile(fontPath));
      const name = `${baseName(fontPath).replace(/[^\w.-]/g, '_')}.${fontPath.split('.').pop()}`;
      // A whole CJK font is tens of MB; reference it by name instead of embedding.
      if (bytes.byteLength > 3_000_000) {
        ctx.warnings.push('字体体积过大，OFD 内只登记字体名，请用装有该字体的阅读器打开');
        font = { name };
      } else {
        font = { name, bytes };
      }
    }
    let produced = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const source = await openSource(input, ctx.globals, false);
      const stem = baseName(input.name);
      const pages: OfdPageInput[] = [];
      for (const page of source.model.pages) {
        const width = ptToMm(page.width);
        const height = ptToMm(page.height);
        if (mode === 'image') {
          const bytes = await cropRegion(source.raster, page.page, { x: 0, y: 0, w: page.width, h: page.height }, dpi);
          if (!bytes) continue;
          pages.push({
            width,
            height,
            texts: [],
            images: [{ bytes, name: `${stem}-p${page.page}.png`, x: 0, y: 0, width, height }],
          });
          continue;
        }
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
      }
      if (!pages.length) throw new EngineError('no_rasterizer', '没有可导出的页面', 'error.noRasterizer');
      const bytes = await writeOfd({ title: stem, author: 'PoTools', font, pages });
      await ctx.emit({
        name: renderName(ctx.namePattern, { name: stem, tool: 'ofd' }, 'ofd'),
        kind: 'ofd',
        bytes,
        sourceFileId: input.id,
      });
      produced += 1;
      source.raster.close();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { extra: { documents: produced } };
  },
};

export const exportTools: ToolImpl[] = [
  pdfToWord,
  pdfToExcel,
  pdfToPpt,
  pdfToMarkdown,
  pdfToHtml,
  pdfToCsv,
  pdfToRtf,
  pdfToEpub,
  pdfToOfd,
];
