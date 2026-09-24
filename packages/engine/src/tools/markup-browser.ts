import { degrees, rgb, StandardFonts, type PDFFont, type PDFDocument, type PDFPage } from 'pdf-lib';
import { parsePageRanges } from '@potools/core';
import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { contentsHead, sendAppendedToBack } from '../lib/pdf.ts';
import { embedSystemFont, systemFontResources, type SystemFontResource } from '../lib/system-fonts.ts';
import { bool, hexToRgb, num, requireText, str } from '../lib/options.ts';
import type { ToolImpl } from '../types.ts';

interface Box { width: number; height: number }
type Anchor = 'left' | 'center' | 'right';
type VAlign = 'top' | 'middle' | 'bottom';

function normalizeAngle(angle: number): number {
  return ((Math.round(angle) % 360) + 360) % 360;
}

function visualBox(page: PDFPage): Box {
  const { width, height } = page.getSize();
  return normalizeAngle(page.getRotation().angle) % 180 === 90 ? { width: height, height: width } : { width, height };
}

function toUserSpace(box: Box, rotation: number, vx: number, vy: number): { x: number; y: number } {
  const { width: w, height: h } = box;
  switch (normalizeAngle(rotation)) {
    case 90: return { x: vy, y: vx };
    case 180: return { x: w - vx, y: h - vy };
    case 270: return { x: w - vy, y: h - vx };
    default: return { x: vx, y: h - vy };
  }
}

function splitPosition(position: string): { anchor: Anchor; valign: VAlign } {
  if (position === 'center') return { anchor: 'center', valign: 'middle' };
  const [vertical, horizontal] = position.split('-');
  return {
    valign: vertical === 'top' ? 'top' : vertical === 'middle' ? 'middle' : 'bottom',
    anchor: horizontal === 'left' ? 'left' : horizontal === 'right' ? 'right' : 'center',
  };
}

interface GlyphRun {
  text: string;
  font: PDFFont;
  size: number;
  color: { r: number; g: number; b: number };
  opacity: number;
  phi: number;
  cx: number;
  cy: number;
  box: Box;
  rotation: number;
}

function drawAtVisualCenter(page: PDFPage, run: GlyphRun): void {
  const { text, font, size, color, opacity, phi, cx, cy, box, rotation } = run;
  const textWidth = font.widthOfTextAtSize(text, size);
  const lineHeight = font.heightAtSize(size);
  const radians = (phi * Math.PI) / 180;
  const dirX = Math.cos(radians);
  const dirY = Math.sin(radians);
  const perpX = -dirY;
  const perpY = dirX;
  const baselineToCenter = 0.28 * lineHeight;
  const center = toUserSpace(box, rotation, cx, cy);
  page.drawText(text, {
    x: center.x - (textWidth / 2) * dirX - baselineToCenter * perpX,
    y: center.y - (textWidth / 2) * dirY - baselineToCenter * perpY,
    size,
    font,
    color: rgb(color.r, color.g, color.b),
    opacity,
    rotate: degrees(phi),
  });
}

interface RunOptions {
  text: string;
  font: PDFFont;
  size: number;
  color: { r: number; g: number; b: number };
  opacity: number;
  position: string;
  margin: number;
  tilt: number;
  page: PDFPage;
}

function drawPositionedText({ text, font, size, color, opacity, position, margin, tilt, page }: RunOptions): void {
  const box = visualBox(page);
  const rotation = normalizeAngle(page.getRotation().angle);
  const textWidth = font.widthOfTextAtSize(text, size);
  const lineHeight = font.heightAtSize(size);
  const { anchor, valign } = splitPosition(position);
  const cx = anchor === 'left' ? margin + textWidth / 2 : anchor === 'right' ? box.width - margin - textWidth / 2 : box.width / 2;
  const cy = valign === 'top' ? margin + lineHeight / 2 : valign === 'bottom' ? box.height - margin - lineHeight / 2 : box.height / 2;
  drawAtVisualCenter(page, { text, font, size, color, opacity, phi: -rotation + tilt, cx, cy, box, rotation });
}

async function latinFont(doc: PDFDocument, sample: string, fonts: SystemFontResource[]): Promise<PDFFont> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  try {
    font.encodeText(sample);
    return font;
  } catch {
    try {
      return await embedSystemFont(doc, sample, fonts);
    } catch {
      throw new InMemoryFallback('markup requires a system font; route through the compatibility engine');
    }
  }
}

function fontsFor(ctx: Parameters<ToolImpl['run']>[0]): SystemFontResource[] {
  return systemFontResources(ctx.runtimeData);
}

const watermark: ToolImpl = {
  id: 'watermark',
  async run(ctx) {
    const text = requireText(ctx.options, 'text', '水印文字');
    const tilt = num(ctx.options, 'rotation');
    const size = num(ctx.options, 'fontSize');
    const opacity = Math.min(1, Math.max(0.01, num(ctx.options, 'opacity') / 100));
    const color = hexToRgb(str(ctx.options, 'color'));
    const position = str(ctx.options, 'position');
    const tiled = bool(ctx.options, 'tiled');
    const gap = Math.max(0, num(ctx.options, 'tileGap'));
    let pagesTouched = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const font = await latinFont(doc, text, fontsFor(ctx));
      const selection = new Set(parsePageRanges(str(ctx.options, 'pages'), doc.getPageCount()));
      for (const [pageIndex, page] of doc.getPages().entries()) {
        if (!selection.has(pageIndex + 1)) continue;
        const head = contentsHead(doc, page);
        const rotation = normalizeAngle(page.getRotation().angle);
        if (tiled) {
          const box = visualBox(page);
          const stepX = font.widthOfTextAtSize(text, size) + gap;
          const stepY = font.heightAtSize(size) + gap;
          const reach = Math.max(box.width, box.height);
          for (let cy = stepY / 2; cy < reach + stepY; cy += stepY) {
            for (let cx = -reach; cx < reach * 2; cx += stepX) {
              drawAtVisualCenter(page, { text, font, size, color, opacity, phi: -rotation + tilt, cx: cx + stepX / 2, cy, box, rotation });
            }
          }
        } else {
          drawPositionedText({ text, font, size, color, opacity, position, margin: size, tilt, page });
        }
        if (str(ctx.options, 'layer') === 'below') sendAppendedToBack(head.array, head.count);
        pagesTouched += 1;
      }
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'watermarked' }, 'pdf'), bytes, input.id);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: pagesTouched, extra: { pagesTouched } };
  },
};

const pageNumbers: ToolImpl = {
  id: 'page-numbers',
  async run(ctx) {
    const format = str(ctx.options, 'format') || '{n}';
    const start = Math.trunc(num(ctx.options, 'start') || 1);
    const size = num(ctx.options, 'fontSize');
    const margin = num(ctx.options, 'margin');
    const color = hexToRgb(str(ctx.options, 'color'));
    const position = str(ctx.options, 'position');
    const skipFirst = bool(ctx.options, 'skipFirst');
    let added = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const sample = format.replace(/\{n\}/g, '888').replace(/\{total\}/g, '888');
      const font = await latinFont(doc, sample, fontsFor(ctx));
      const total = doc.getPageCount();
      const selection = new Set(parsePageRanges(str(ctx.options, 'pages'), total));
      doc.getPages().forEach((page, pageIndex) => {
        const pageNumber = pageIndex + 1;
        if (!selection.has(pageNumber) || (skipFirst && pageNumber === 1)) return;
        const label = format.replace(/\{n\}/g, String(pageIndex + start)).replace(/\{total\}/g, String(Math.max(1, total - (skipFirst ? 1 : 0))));
        try { font.encodeText(label); } catch { throw new InMemoryFallback('page label requires a system font'); }
        drawPositionedText({ text: label, font, size, color, opacity: 1, position, margin, tilt: 0, page });
        added += 1;
      });
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'numbered' }, 'pdf'), bytes, input.id);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: added, extra: { numberedPages: added } };
  },
};

const headerFooter: ToolImpl = {
  id: 'header-footer',
  async run(ctx) {
    const header = str(ctx.options, 'header').trim();
    const footer = str(ctx.options, 'footer').trim();
    if (!header && !footer) throw new EngineError('bad_request', '页眉与页脚至少填写一个');
    const size = num(ctx.options, 'fontSize');
    const margin = num(ctx.options, 'margin');
    const color = hexToRgb(str(ctx.options, 'color'));
    const skipFirst = bool(ctx.options, 'skipFirst');
    let pagesTouched = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const sample = `${header}${footer}`.replace(/\{n\}/g, '888').replace(/\{total\}/g, '888');
      const font = await latinFont(doc, sample, fontsFor(ctx));
      const total = doc.getPageCount();
      const selection = new Set(parsePageRanges(str(ctx.options, 'pages'), total));
      const fill = (value: string, pageIndex: number) => value
        .replace(/\{name\}/g, baseName(input.name))
        .replace(/\{n\}/g, String(pageIndex + 1))
        .replace(/\{total\}/g, String(Math.max(1, total - (skipFirst ? 1 : 0))));

      doc.getPages().forEach((page, pageIndex) => {
        if (!selection.has(pageIndex + 1) || (skipFirst && pageIndex === 0)) return;
        if (header) {
          const text = fill(header, pageIndex);
          try { font.encodeText(text); } catch { throw new InMemoryFallback('header text requires a system font'); }
          drawPositionedText({ text, font, size, color, opacity: 1, position: `top-${str(ctx.options, 'headerAlign') === 'center' ? 'center' : str(ctx.options, 'headerAlign')}`, margin, tilt: 0, page });
        }
        if (footer) {
          const text = fill(footer, pageIndex);
          try { font.encodeText(text); } catch { throw new InMemoryFallback('footer text requires a system font'); }
          drawPositionedText({ text, font, size, color, opacity: 1, position: `bottom-${str(ctx.options, 'footerAlign') === 'center' ? 'center' : str(ctx.options, 'footerAlign')}`, margin, tilt: 0, page });
        }
        pagesTouched += 1;
      });
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'hf' }, 'pdf'), bytes, input.id);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: pagesTouched, extra: { pagesTouched } };
  },
};

export const embeddedMarkupTools: ToolImpl[] = [watermark, pageNumbers, headerFooter];
