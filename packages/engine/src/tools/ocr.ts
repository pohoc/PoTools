import { loadPdf } from '../lib/files.ts';
import { getSharp } from '../lib/images.ts';
import { makeMsg, localeOf } from '../lib/messages.ts';
import { writeXlsx } from '../lib/office.ts';
import { baseName } from '../lib/naming.ts';
import { openRaster } from '../lib/render.ts';
import { recognizePaddlePage, type OcrLine } from '../lib/ocr.ts';
import { EngineError } from '../errors.ts';
import type { ToolImpl } from '../types.ts';

type RecognizedPage = { page: number; lines: OcrLine[]; text: string; width: number; height: number };

async function recognizeInput(ctx: Parameters<ToolImpl['run']>[0], input: (typeof ctx.inputs)[number], dpi: number): Promise<RecognizedPage[]> {
  const pages: RecognizedPage[] = [];
  if (/\.pdf$/i.test(input.name)) {
    const doc = await loadPdf(input, ctx.globals);
    const raster = await openRaster(input.bytes, ctx.globals);
    try {
      for (let page = 1; page <= raster.pageCount; page += 1) {
        if (ctx.cancelled()) break;
        const result = await recognizePaddlePage(raster.renderPng({ page, dpi }));
        const box = raster.pageBox(page);
        pages.push({ page, lines: result.lines, text: result.text, width: box.width * dpi / 72, height: box.height * dpi / 72 });
        ctx.report({ percent: Math.round(((page / raster.pageCount) / ctx.inputs.length) * 100), phase: 'recognize', current: page, total: doc.getPageCount() });
      }
    } finally {
      raster.close();
    }
    return pages;
  }

  const sharp = await getSharp();
  if (!sharp) throw new EngineError('no_image_codec', 'sharp is unavailable', 'error.noImageCodec');
  const image = sharp(Buffer.from(input.bytes), { failOn: 'none', page: 0 }).rotate();
  const meta = await image.metadata();
  const pageCount = Math.max(1, meta.pages ?? 1);
  for (let page = 0; page < pageCount; page += 1) {
    if (ctx.cancelled()) break;
    const { data, info } = await sharp(Buffer.from(input.bytes), { failOn: 'none', page }).rotate().png().toBuffer({ resolveWithObject: true });
    const result = await recognizePaddlePage(new Uint8Array(data));
    pages.push({ page: page + 1, lines: result.lines, text: result.text, width: info.width, height: info.height });
    ctx.report({ percent: Math.round(((page + 1) / pageCount / ctx.inputs.length) * 100), phase: 'recognize', current: page + 1, total: pageCount });
  }
  return pages;
}

const ocrText: ToolImpl = {
  id: 'ocr-text',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const dpi = Math.max(120, Math.min(300, Number(ctx.options.dpi) || 200));
    const markers = ctx.options.pageMarkers !== false;
    let totalPages = 0;
    for (const input of ctx.inputs) {
      const pages = await recognizeInput(ctx, input, dpi);
      totalPages += pages.length;
      const text = pages.map((page) => markers && pages.length > 1 ? `${msg('ocr.page', { page: page.page })}\n${page.text.trim()}` : page.text.trim()).filter(Boolean).join('\n\n');
      if (!text) {
        ctx.warnings.push(msg('ocr.warning.empty', { name: baseName(input.name) }));
      } else {
        await ctx.emit({ name: `${baseName(input.name)}-ocr.txt`, kind: 'text', bytes: new TextEncoder().encode(`${text}\n`), sourceFileId: input.id });
      }
    }
    if (!totalPages) throw new EngineError('empty_selection', msg('ocr.error.empty'));
    return { extra: { pages: totalPages } };
  },
};

type PositionedLine = { text: string; left: number; right: number; top: number; bottom: number };

function tableRows(lines: OcrLine[], width: number): string[][] {
  const positioned: PositionedLine[] = lines.filter((line) => line.text.trim()).map((line, index) => ({
    text: line.text.trim(),
    left: line.box?.[0] ?? index * 10,
    top: line.box?.[1] ?? index * 24,
    right: line.box?.[2] ?? index * 10 + Math.max(24, line.text.length * 12),
    bottom: line.box?.[3] ?? index * 24 + 18,
  })).sort((a, b) => a.top - b.top || a.left - b.left);
  if (!positioned.length) return [];

  const rows: PositionedLine[][] = [];
  for (const line of positioned) {
    const row = rows.find((candidate) => {
      const top = Math.min(...candidate.map((cell) => cell.top));
      const bottom = Math.max(...candidate.map((cell) => cell.bottom));
      const height = Math.max(line.bottom - line.top, bottom - top);
      return Math.abs((line.top + line.bottom) / 2 - (top + bottom) / 2) <= height * 0.55;
    });
    if (row) row.push(line);
    else rows.push([line]);
  }
  rows.sort((a, b) => Math.min(...a.map((cell) => cell.top)) - Math.min(...b.map((cell) => cell.top)));

  const threshold = Math.max(18, width * 0.018);
  const anchors: number[] = [];
  for (const line of positioned.slice().sort((a, b) => a.left - b.left)) {
    const nearest = anchors.findIndex((anchor) => Math.abs(anchor - line.left) <= threshold);
    if (nearest < 0) anchors.push(line.left);
    else anchors[nearest] = (anchors[nearest]! + line.left) / 2;
  }
  anchors.sort((a, b) => a - b);

  return rows.map((row) => {
    const cells = Array.from({ length: anchors.length }, () => '');
    for (const line of row.sort((a, b) => a.left - b.left)) {
      let column = anchors.reduce((best, anchor, index) => Math.abs(anchor - line.left) < Math.abs(anchors[best]! - line.left) ? index : best, 0);
      if (cells[column]) {
        const next = anchors.findIndex((_, index) => index > column && !cells[index]);
        if (next >= 0 && line.left - anchors[column]! > threshold) column = next;
      }
      cells[column] = cells[column] ? `${cells[column]} ${line.text}` : line.text;
    }
    return cells;
  });
}

const ocrTable: ToolImpl = {
  id: 'ocr-table',
  async run(ctx) {
    const msg = makeMsg(localeOf(ctx));
    const dpi = Math.max(120, Math.min(300, Number(ctx.options.dpi) || 220));
    const sheets: Array<{ name: string; rows: string[][] }> = [];
    for (const input of ctx.inputs) {
      const pages = await recognizeInput(ctx, input, dpi);
      for (const page of pages) {
        const rows = tableRows(page.lines, page.width);
        if (!rows.length) {
          ctx.warnings.push(msg('ocr.warning.noTable', { name: baseName(input.name), page: page.page }));
          continue;
        }
        const sheetName = `${baseName(input.name)}-${page.page}`.replace(/[\\/?*\[\]:]/g, '-').slice(0, 31);
        sheets.push({ name: sheetName || `Page-${sheets.length + 1}`, rows });
      }
    }
    if (!sheets.length) throw new EngineError('empty_selection', msg('ocr.error.noTable'));
    const bytes = await writeXlsx(sheets);
    const outputName = ctx.inputs.length === 1 ? `${baseName(ctx.inputs[0]!.name)}-tables.xlsx` : 'ocr-tables.xlsx';
    await ctx.emit({ name: outputName, kind: 'xlsx', bytes, sourceFileId: ctx.inputs.length === 1 ? ctx.inputs[0]!.id : undefined });
    ctx.warnings.push(msg('ocr.warning.review'));
    return { extra: { pages: sheets.length, rows: sheets.reduce((count, sheet) => count + sheet.rows.length, 0) } };
  },
};

export const ocrTools: ToolImpl[] = [ocrText, ocrTable];
