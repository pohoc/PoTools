import type { PDFDocument } from 'pdf-lib';
import type { JobGlobals } from '@potools/core';
import { getSharp } from './images.ts';
import { pageBoxOf, pageImageRects, toVisualRect, type Rect } from './pagedata.ts';
import { normalizeAngle } from './pdf.ts';
import { openRaster, type RasterHandle } from './render.ts';

export interface StLine {
  text: string;
  /** Top-left origin, points, in the visual (post-rotation) space. */
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

export interface StPage {
  page: number;
  width: number;
  height: number;
  lines: StLine[];
  /** Image boxes in the same visual space as `lines`. */
  images: Rect[];
}

export interface DocModel {
  pages: StPage[];
  /** Dominant body font size, used to spot headings. */
  bodySize: number;
}

export type FlowBlock =
  | { kind: 'heading'; level: number; text: string; page: number }
  | { kind: 'paragraph'; text: string; page: number; bold: boolean }
  | { kind: 'list'; ordered: boolean; items: string[]; page: number }
  | { kind: 'image'; page: number; box: Rect; src?: string; alt?: string }
  | { kind: 'pageBreak' };

interface JsonBox {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface JsonLine {
  bbox?: JsonBox;
  text?: string;
  font?: { name?: string; weight?: string; style?: string; size?: number };
}

interface JsonBlock {
  type?: string;
  bbox?: JsonBox;
  lines?: JsonLine[];
}

const BULLET = /^\s*([•·▪◦‣*o●·-]|\((\d{1,3})\)|(\d{1,3}[.)])|([一二三四五六七八九十]+[、.]))\s+/;
const NUMBERED = /^\s*(\(\d{1,3}\)|\d{1,3}[.)]|[一二三四五六七八九十]+[、.])\s+/;

/** Reads MuPDF's structured text plus image placements into one layout model. */
export async function readDocModel(
  bytes: Uint8Array,
  doc: PDFDocument,
  globals: JobGlobals = {},
): Promise<DocModel> {
  const raster = await openRaster(bytes, globals);
  const pages: StPage[] = [];
  try {
    for (let page = 1; page <= doc.getPageCount(); page += 1) {
      const box = pageBoxOf(doc, page - 1);
      const rotation = normalizeAngle(doc.getPages()[page - 1]!.getRotation().angle);
      const visual = rotation % 180 === 90 ? { width: box.height, height: box.width } : box;
      const json = raster.stext(page) as { blocks?: JsonBlock[] } | null;
      const lines: StLine[] = [];
      (json?.blocks ?? []).forEach((block, blockIndex) => {
        if (block.type !== 'text') return;
        (block.lines ?? []).forEach((line) => {
          const text = (line.text ?? '').trim();
          if (!text) return;
          const bbox = line.bbox ?? {};
          lines.push({
            text,
            x: num(bbox.x),
            y: num(bbox.y),
            w: num(bbox.w),
            h: num(bbox.h),
            size: num(line.font?.size, 10),
            font: line.font?.name ?? '',
            weight: line.font?.weight ?? 'normal',
            style: line.font?.style ?? 'normal',
            block: blockIndex,
          });
        });
      });
      const images = (await pageImageRects(doc, page - 1)).map((rect) =>
        toVisualRect(rect, box.width, box.height, rotation),
      );
      pages.push({ page, width: visual.width, height: visual.height, lines, images });
    }
  } finally {
    raster.close();
  }
  return { pages, bodySize: bodySizeOf(pages) };
}

function num(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Size that covers most characters — headings are measured against it. */
export function bodySizeOf(pages: StPage[]): number {
  const weights = new Map<number, number>();
  for (const page of pages) {
    for (const line of page.lines) {
      weights.set(Math.round(line.size), (weights.get(Math.round(line.size)) ?? 0) + line.text.length);
    }
  }
  let best = 10;
  let bestWeight = 0;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = size;
    }
  }
  return best;
}

export function headingLevel(line: StLine, bodySize: number): number | null {
  const bold = line.weight === 'bold' || line.style === 'bold' || /bold/i.test(line.font);
  const ratio = line.size / Math.max(1, bodySize);
  if (line.text.length > 120) return null;
  if (ratio >= 1.7) return 1;
  if (ratio >= 1.35) return 2;
  if (ratio >= 1.12) return 3;
  if (bold && ratio >= 0.95 && line.text.length <= 60) return 4;
  return null;
}

/** Groups the flat line list into the headings/paragraphs/lists exporters share. */
export function toFlow(model: DocModel, options: { pageBreaks?: boolean } = {}): FlowBlock[] {
  const flow: FlowBlock[] = [];
  for (const page of model.pages) {
    if (options.pageBreaks && flow.length) flow.push({ kind: 'pageBreak' });
    const groups = groupByBlock(page.lines);
    for (const group of groups) {
      const first = group[0]!;
      const joined = joinLines(group.map((line) => line.text));
      const level = headingLevel(first, model.bodySize);
      if (level && group.length === 1) {
        flow.push({ kind: 'heading', level, text: first.text, page: page.page });
        continue;
      }
      const bullets = group.filter((line) => BULLET.test(line.text));
      if (bullets.length >= Math.max(1, group.length * 0.6)) {
        flow.push({
          kind: 'list',
          ordered: bullets.some((line) => NUMBERED.test(line.text)),
          items: bullets.map((line) => line.text.replace(BULLET, '').trim()),
          page: page.page,
        });
        continue;
      }
      flow.push({
        kind: 'paragraph',
        text: joined,
        page: page.page,
        bold: group.every((line) => line.weight === 'bold' || /bold/i.test(line.font)),
      });
    }
    for (const box of page.images) flow.push({ kind: 'image', page: page.page, box });
  }
  return flow;
}

function groupByBlock(lines: StLine[]): StLine[][] {
  const groups: StLine[][] = [];
  let current: StLine[] = [];
  let block = Number.NaN;
  for (const line of lines) {
    if (line.block !== block) {
      if (current.length) groups.push(current);
      current = [];
      block = line.block;
    }
    current.push(line);
  }
  if (current.length) groups.push(current);
  return groups;
}

/** CJK text wraps without spaces, so joining lines must not insert one there. */
export function joinLines(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (!out) {
      out = part;
      continue;
    }
    const tail = out[out.length - 1]!;
    const head = part[0]!;
    const cjk = isCjk(tail) || isCjk(head);
    if (tail === '-') {
      out = `${out.slice(0, -1)}${part}`;
      continue;
    }
    out += cjk ? part : ` ${part}`;
  }
  return out;
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xff60)
  );
}

/** Rows of cells, split where the horizontal gap exceeds `columnGap` points. */
export function toRows(page: StPage, columnGap: number): string[][] {
  const buckets: StLine[][] = [];
  for (const line of [...page.lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = buckets.find((items) => {
      const anchor = items[0]!;
      return Math.abs(line.y - anchor.y) < Math.max(2, Math.min(anchor.h, line.h) * 0.6);
    });
    if (row) row.push(line);
    else buckets.push([line]);
  }
  return buckets
    .sort((a, b) => a[0]!.y - b[0]!.y)
    .map((row) => {
      const cells: string[] = [];
      let buffer = '';
      let previousEnd: number | null = null;
      for (const line of [...row].sort((a, b) => a.x - b.x)) {
        if (previousEnd !== null && line.x - previousEnd > columnGap) {
          cells.push(buffer.trim());
          buffer = '';
        } else if (buffer) {
          buffer += ' ';
        }
        buffer += line.text;
        previousEnd = line.x + line.w;
      }
      cells.push(buffer.trim());
      return cells;
    });
}

/** Crops a visual-space box out of the rendered page. */
export async function cropRegion(
  raster: RasterHandle,
  page: number,
  box: Rect,
  dpi: number,
): Promise<Uint8Array | null> {
  const sharp = await getSharp();
  const pageBox = raster.pageBox(page);
  const png = raster.renderPng({ page, dpi });
  if (!png.length || !pageBox.width) return null;
  if (!sharp) return null;
  const meta = await sharp(Buffer.from(png)).metadata();
  const scale = (meta.width || pageBox.width) / pageBox.width;
  const left = clamp(box.x * scale, 0, (meta.width ?? 1) - 1);
  const top = clamp(box.y * scale, 0, (meta.height ?? 1) - 1);
  const width = clamp(box.w * scale, 1, (meta.width ?? 1) - left);
  const height = clamp(box.h * scale, 1, (meta.height ?? 1) - top);
  try {
    return new Uint8Array(
      await sharp(Buffer.from(png)).extract({ left, top, width, height }).png().toBuffer(),
    );
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.round(value), max));
}

export type { Rect };
