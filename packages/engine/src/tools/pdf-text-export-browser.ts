import { parsePageRanges } from '@potools/core';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { readDocModel, toFlow } from '../lib/docmodel.ts';
import { cropPdfRegionPng, bytesToBase64 } from '../lib/browser-region.ts';
import { openRaster } from '../lib/render.ts';
import { baseName, renderName } from '../lib/naming.ts';
import type { ToolImpl } from '../types.ts';
import { bool, num, str } from '../lib/options.ts';
import { DELIMITERS, flowToHtml, flowToMarkdown, flowToRtf, rowsToCsv } from '../lib/textfmt.ts';
import type { FlowBlock } from '../lib/docmodel.ts';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface BrowserLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  font: string;
  weight: string;
  style: string;
  block: number;
}

export interface BrowserPage {
  page: number;
  lines: BrowserLine[];
  rows: BrowserLine[][];
}

async function readPages(bytes: Uint8Array, password: string | null | undefined): Promise<BrowserPage[]> {
  const copy = Uint8Array.from(bytes);
  const loading = getDocument({ data: copy, isEvalSupported: false, password: password || undefined });
  let document: Awaited<typeof loading.promise> | null = null;
  try {
    document = await loading.promise;
    const pages: BrowserPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const runs: BrowserLine[] = [];
      for (const item of content.items) {
        if (!('str' in item) || typeof item.str !== 'string' || !item.str.trim()) continue;
        const transform = item.transform;
        const style = content.styles[item.fontName] as { fontFamily?: string; ascent?: number; descent?: number; vertical?: boolean } | undefined;
        const fontSize = Math.max(1, Math.hypot(transform[0] ?? 0, transform[1] ?? 0));
        const [left, baseline] = viewport.convertToViewportPoint(transform[4] ?? 0, transform[5] ?? 0);
        const ascent = typeof style?.ascent === 'number' ? style.ascent : 0.8;
        const text = item.str.replace(/\s+$/u, '');
        if (!text) continue;
        runs.push({
          text,
          x: left,
          y: baseline - ascent * fontSize,
          w: item.width,
          h: Math.max(1, item.height || fontSize),
          size: fontSize,
          font: style?.fontFamily ?? item.fontName,
          weight: /bold|black|heavy/i.test(`${style?.fontFamily ?? ''} ${item.fontName}`) ? 'bold' : 'normal',
          style: /italic|oblique/i.test(`${style?.fontFamily ?? ''} ${item.fontName}`) ? 'italic' : 'normal',
          block: 0,
        });
      }
      const rows = groupRuns(runs);
      pages.push({ page: pageNumber, lines: rows.map(mergeRuns), rows });
      page.cleanup();
    }
    return pages;
  } catch (error) {
    if (error instanceof InMemoryFallback) throw error;
    throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
  }
}

export function readBrowserPdfTextPages(bytes: Uint8Array, password?: string | null): Promise<BrowserPage[]> {
  return readPages(bytes, password);
}

function groupRuns(runs: BrowserLine[]): BrowserLine[][] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: BrowserLine[][] = [];
  for (const run of sorted) {
    const row = rows.find((items) => Math.abs(items[0]!.y - run.y) < Math.max(2, Math.min(items[0]!.h, run.h) * 0.55));
    if (row) row.push(run);
    else rows.push([run]);
  }
  return rows.sort((a, b) => a[0]!.y - b[0]!.y).map((row) => row.sort((a, b) => a.x - b.x));
}

function mergeRuns(pieces: BrowserLine[], index: number, rows: BrowserLine[][]): BrowserLine {
  let block = 0;
  for (let prior = index - 1; prior >= 0; prior -= 1) {
    const previousRow = rows[prior]!;
    const currentRow = rows[prior + 1]!;
    if (currentRow[0]!.y - previousRow[0]!.y > Math.max(currentRow[0]!.h, previousRow[0]!.h) * 1.45) block += 1;
  }
  const first = pieces[0]!;
  let text = '';
  let right = Number.NEGATIVE_INFINITY;
  for (const piece of pieces) {
    const gap = piece.x - right;
    const needsSpace = text && !/\s$/u.test(text) && !/^\s/u.test(piece.text) && gap > Math.max(1, piece.size * 0.16) && !isCjk(text.at(-1)!) && !isCjk(piece.text[0]!);
    text += `${needsSpace ? ' ' : ''}${piece.text}`;
    right = Math.max(right, piece.x + piece.w);
  }
  return { ...first, text: text.trim(), w: Math.max(...pieces.map((piece) => piece.x + piece.w)) - first.x, block };
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x3000 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xff60);
}

function bodySizeOf(pages: BrowserPage[]): number {
  const sizes = new Map<number, number>();
  for (const page of pages) for (const line of page.lines) sizes.set(Math.round(line.size), (sizes.get(Math.round(line.size)) ?? 0) + line.text.length);
  return [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

export function browserPagesToFlow(pages: BrowserPage[], pageBreaks: boolean): FlowBlock[] {
  const bodySize = bodySizeOf(pages);
  const flow: FlowBlock[] = [];
  for (const page of pages) {
    if (pageBreaks && flow.length) flow.push({ kind: 'pageBreak' });
    const groups: BrowserLine[][] = [];
    for (const line of page.lines) {
      const last = groups.at(-1);
      if (!last || last[0]!.block !== line.block) groups.push([line]);
      else last.push(line);
    }
    for (const group of groups) {
      const first = group[0]!;
      const text = joinLines(group.map((line) => line.text));
      const ratio = first.size / Math.max(1, bodySize);
      const heading = text.length <= 120 ? ratio >= 1.7 ? 1 : ratio >= 1.35 ? 2 : ratio >= 1.12 ? 3 : first.weight === 'bold' && ratio >= 0.95 && text.length <= 60 ? 4 : 0 : 0;
      if (heading && group.length === 1) flow.push({ kind: 'heading', level: heading, text: first.text, page: page.page });
      else if (group.every((line) => line.weight === 'bold')) flow.push({ kind: 'paragraph', text, page: page.page, bold: true });
      else {
        const bullets = group.map((line) => line.text).filter((line) => /^\s*([•·▪◦‣*o●-]|\((\d{1,3})\)|(\d{1,3}[.)])|([一二三四五六七八九十]+[、.]))\s+/u.test(line));
        if (bullets.length >= Math.max(1, group.length * 0.6)) {
          flow.push({
            kind: 'list',
            ordered: bullets.some((line) => /^\s*(\((\d{1,3})\)|(\d{1,3}[.)])|([一二三四五六七八九十]+[、.]))\s+/u.test(line)),
            items: bullets.map((line) => line.replace(/^\s*([•·▪◦‣*o●-]|\((\d{1,3})\)|(\d{1,3}[.)])|([一二三四五六七八九十]+[、.]))\s+/u, '').trim()),
            page: page.page,
          });
        } else flow.push({ kind: 'paragraph', text, page: page.page, bold: false });
      }
    }
  }
  return flow;
}

function joinLines(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (!out) { out = part; continue; }
    const tail = out[out.length - 1]!;
    const head = part[0]!;
    if (tail === '-') out = `${out.slice(0, -1)}${part}`;
    else out += isCjk(tail) || isCjk(head) ? part : ` ${part}`;
  }
  return out;
}

export function rowsOf(page: BrowserPage, gapLimit: number): string[][] {
  return page.rows.map((row) => {
    const cells: string[] = [];
    let buffer = '';
    let previousEnd: number | null = null;
    for (const line of [...row].sort((a, b) => a.x - b.x)) {
      if (previousEnd !== null && line.x - previousEnd > gapLimit) { cells.push(buffer.trim()); buffer = ''; }
      else if (buffer) buffer += ' ';
      buffer += line.text;
      previousEnd = line.x + line.w;
    }
    cells.push(buffer.trim());
    return cells;
  });
}

function textBytes(text: string): Uint8Array { return new TextEncoder().encode(text); }

const exportTools: ToolImpl[] = [
  {
    id: 'pdf-to-markdown',
    async run(ctx) {
      const encoder = new TextEncoder();
      let documents = 0;
      for (const [index, input] of ctx.inputs.entries()) {
        const stem = baseName(input.name);
        const includeImages = bool(ctx.options, 'includeImages');
        let markdown: string;
        if (includeImages) {
          const doc = await ctx.loadPdf(input, ctx.globals);
          if (!doc.getPageCount()) throw new EngineError('empty_selection', `${input.name} 没有页面`);
          const model = await readDocModel(input.bytes, doc, ctx.globals);
          const raster = await openRaster(input.bytes, ctx.globals);
          try {
            const flow = toFlow(model, { pageBreaks: bool(ctx.options, 'pageBreaks') });
            const names = new Map<Extract<FlowBlock, { kind: 'image' }>, string>();
            let imageCount = 0;
            for (const block of flow) {
              if (block.kind !== 'image' || !block.box.w || !block.box.h) continue;
              const crop = await cropPdfRegionPng(raster, block.page, block.box, 150);
              const name = `${stem}-p${block.page}-${String(++imageCount).padStart(2, '0')}.png`;
              names.set(block, name);
              await ctx.emit({ name, kind: 'image', bytes: crop.bytes, sourceFileId: input.id });
            }
            markdown = flowToMarkdown(flow, (block) => names.get(block) ?? null);
          } finally {
            raster.close();
          }
        } else {
          const flow = browserPagesToFlow(await readPages(input.bytes, ctx.globals.password), bool(ctx.options, 'pageBreaks'));
          markdown = flowToMarkdown(flow, () => null);
        }
        await ctx.emit({ name: renderName(ctx.namePattern, { name: stem, tool: 'markdown' }, 'md'), kind: 'md', bytes: encoder.encode(markdown), sourceFileId: input.id });
        documents += 1;
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
      }
      return { extra: { documents } };
    },
  },
  {
    id: 'pdf-to-html',
    async run(ctx) {
      let documents = 0;
      for (const [index, input] of ctx.inputs.entries()) {
        const stem = baseName(input.name);
        const doc = await ctx.loadPdf(input, ctx.globals);
        if (!doc.getPageCount()) throw new EngineError('empty_selection', `${input.name} 没有页面`);
        const model = await readDocModel(input.bytes, doc, ctx.globals);
        const raster = await openRaster(input.bytes, ctx.globals);
        let html: string;
        try {
          const flow = toFlow(model);
          const embedImages = bool(ctx.options, 'embedImages');
          const dpi = num(ctx.options, 'dpi') || 144;
          const names = new Map<Extract<FlowBlock, { kind: 'image' }>, string>();
          let imageCount = 0;
          for (const block of flow) {
            if (block.kind !== 'image' || !block.box.w || !block.box.h) continue;
            const crop = await cropPdfRegionPng(raster, block.page, block.box, dpi);
            if (embedImages) names.set(block, `data:image/png;base64,${bytesToBase64(crop.bytes)}`);
            else {
              const name = `${stem}-p${block.page}-${String(++imageCount).padStart(2, '0')}.png`;
              names.set(block, name);
              await ctx.emit({ name, kind: 'image', bytes: crop.bytes, sourceFileId: input.id });
            }
          }
          html = flowToHtml(flow, { title: stem, imageFor: (block) => names.get(block) ?? null });
        } finally {
          raster.close();
        }
        await ctx.emit({ name: renderName(ctx.namePattern, { name: stem, tool: 'html' }, 'html'), kind: 'html', bytes: textBytes(html), sourceFileId: input.id });
        documents += 1;
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
      }
      return { extra: { documents } };
    },
  },
  {
    id: 'pdf-to-csv',
    async run(ctx) {
      const delimiter = DELIMITERS[str(ctx.options, 'delimiter')] ?? ',';
      const gap = num(ctx.options, 'columnGap');
      let tables = 0;
      for (const [index, input] of ctx.inputs.entries()) {
        const stem = baseName(input.name);
        const pages = await readPages(input.bytes, ctx.globals.password);
        const kept = pages.map((page) => ({ page: page.page, rows: rowsOf(page, gap) })).filter((entry) => entry.rows.length);
        if (!kept.length) {
          ctx.warnings.push(`${stem}：未识别到可导出的表格行`);
          ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
          continue;
        }
        const rows = kept.length === 1 ? kept[0]!.rows : kept.flatMap((entry) => [[`# page ${entry.page}`], ...entry.rows, ['']]);
        await ctx.emit({ name: renderName(ctx.namePattern, { name: stem, tool: 'csv' }, 'csv'), kind: 'csv', bytes: textBytes(rowsToCsv(rows, delimiter)), sourceFileId: input.id });
        tables += 1;
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
      }
      if (!tables) throw new EngineError('empty_selection', '没有可导出的表格内容');
      return { extra: { tables } };
    },
  },
  {
    id: 'pdf-to-rtf',
    async run(ctx) {
      let documents = 0;
      for (const [index, input] of ctx.inputs.entries()) {
        const flow = browserPagesToFlow(await readPages(input.bytes, ctx.globals.password), bool(ctx.options, 'pageBreaks'));
        const rtf = flowToRtf(flow);
        await ctx.emit({ name: renderName(ctx.namePattern, { name: baseName(input.name), tool: 'rtf' }, 'rtf'), kind: 'rtf', bytes: textBytes(rtf), sourceFileId: input.id });
        documents += 1;
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
      }
      return { extra: { documents } };
    },
  },
];

export const embeddedPdfTextExportTools = exportTools;
