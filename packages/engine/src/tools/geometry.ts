import { rgb } from 'pdf-lib';
import { parsePageRanges } from '@potools/core';
import {
  appendScaledPage,
  copyPagesInto,
  createDocument,
  cropPage,
  normalizeAngle,
  sizePreset,
  visualBoxOf,
  type Box,
} from '../lib/pdf.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num, str } from '../lib/options.ts';
import { EngineError } from '../errors.ts';
import type { ToolImpl } from '../types.ts';

export interface Cell {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Grid cells measured from the sheet's top edge. */
export function gridCells(perSheet: number, sheet: Box, gap: number, margin: number): Cell[] {
  const columns = perSheet >= 9 ? 3 : perSheet >= 4 ? (perSheet === 6 ? 3 : 2) : perSheet === 2 ? 2 : 1;
  const rows = Math.ceil(perSheet / columns);
  const usable = { width: sheet.width - margin * 2, height: sheet.height - margin * 2 };
  const cell = {
    width: (usable.width - gap * (columns - 1)) / columns,
    height: (usable.height - gap * (rows - 1)) / rows,
  };
  return Array.from({ length: perSheet }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return { x: margin + column * (cell.width + gap), y: margin + row * (cell.height + gap), ...cell };
  });
}

const resize: ToolImpl = {
  id: 'resize',
  async run(ctx) {
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const total = doc.getPageCount();
      if (!total) throw new EngineError('empty_selection', `${input.name} 没有页面`);
      const firstVisual = visualBoxOf(doc.getPages()[0]!);
      const target = str(ctx.options, 'target');
      const out = await createDocument();
      for (let page = 1; page <= total; page += 1) {
        const visual = visualBoxOf(doc.getPages()[page - 1]!);
        let box = target === 'match-first' ? { ...firstVisual } : (sizePreset(target) ?? { ...visual });
        const orientation = str(ctx.options, 'orientation');
        if (orientation === 'portrait' && box.width > box.height) box = { width: box.height, height: box.width };
        if (orientation === 'landscape' && box.width < box.height) box = { width: box.height, height: box.width };
        const scale = target === 'scale' ? Math.max(0.25, num(ctx.options, 'scale')) / 100 : 1;
        await appendScaledPage(out, doc, page, { width: box.width * scale, height: box.height * scale }, {
          margin: num(ctx.options, 'margin'),
          keepRatio: bool(ctx.options, 'keepRatio'),
        });
        ctx.report({ percent: Math.round((page / total) * 90), current: page, total });
      }
      const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'resized' }, 'pdf'),
        bytes,
        input.id,
      );
    }
    return {};
  },
};

const crop: ToolImpl = {
  id: 'crop',
  async run(ctx) {
    let cropped = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const selection = new Set(parsePageRanges(str(ctx.options, 'pages'), doc.getPageCount()));
      const manual = {
        top: num(ctx.options, 'top'),
        right: num(ctx.options, 'right'),
        bottom: num(ctx.options, 'bottom'),
        left: num(ctx.options, 'left'),
      };
      const shrink = bool(ctx.options, 'shrinkToContent');
      for (const [pageIndex, page] of doc.getPages().entries()) {
        if (!selection.has(pageIndex + 1)) continue;
        let edges = manual;
        if (shrink) {
          if (!ctx.contentInsets) throw new EngineError('unsupported', '需要本机 PDF 渲染器才能自动贴合内容');
          const detected = await ctx.contentInsets(input.bytes, pageIndex + 1, ctx.globals, normalizeAngle(page.getRotation().angle));
          if (detected) {
            edges = {
              top: detected.top + manual.top,
              right: detected.right + manual.right,
              bottom: detected.bottom + manual.bottom,
              left: detected.left + manual.left,
            };
          } else {
            ctx.warnings.push(`${baseName(input.name)}：无法自动贴合内容（缺少图片解码器），已按手动边距裁剪`);
          }
        }
        cropPage(page, edges);
        cropped += 1;
      }
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'cropped' }, 'pdf'),
        bytes,
        input.id,
      );
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: cropped, extra: { pages: cropped } };
  },
};

const margins: ToolImpl = {
  id: 'margins',
  async run(ctx) {
    const edge = num(ctx.options, 'edge');
    const sides = str(ctx.options, 'sides');
    const vertical = sides === 'all' || sides === 'vertical' ? edge : 0;
    const horizontal = sides === 'all' || sides === 'horizontal' ? edge : 0;
    let pages = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const keepSize = bool(ctx.options, 'keepPageSize');
      const out = await createDocument();
      for (const [pageIndex] of doc.getPages().entries()) {
        const visual = visualBoxOf(doc.getPages()[pageIndex]!);
        const box = keepSize
          ? visual
          : { width: visual.width + horizontal * 2, height: visual.height + vertical * 2 };
        await appendScaledPage(out, doc, pageIndex + 1, box, {
          margin: 0,
          // Shrinking the drawn area inside an unchanged page box *is* the margin.
          inset: keepSize ? Math.max(vertical, horizontal) : 0,
        });
        pages += 1;
      }
      const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'margins' }, 'pdf'),
        bytes,
        input.id,
      );
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: pages };
  },
};

const nup: ToolImpl = {
  id: 'nup',
  async run(ctx) {
    const input = ctx.inputs[0]!;
    const doc = await ctx.loadPdf(input, ctx.globals);
    const total = doc.getPageCount();
    if (!total) throw new EngineError('empty_selection', `${input.name} 没有页面`);
    const perSheet = Math.max(1, Math.trunc(num(ctx.options, 'perSheet')));
    const gap = num(ctx.options, 'gap');
    const margin = num(ctx.options, 'margin');
    const rowFirst = str(ctx.options, 'order') !== 'vertical';

    const out = await createDocument();
    // Copy every source page once, embed it, then lay the embeds out on sheets
    // and drop the temporary pages again.
    const all: number[] = [];
    for (let page = 1; page <= total; page += 1) all.push(page);
    await copyPagesInto(out, doc, all);
    const embedded = await Promise.all(
      out.getPages().map(async (page, index) => ({
        page: await out.embedPage(page),
        rotation: ((Math.round(page.getRotation().angle) % 360) + 360) % 360,
        box: visualBoxOf(page),
        index,
      })),
    );

    const firstVisual = embedded[0]!.box;
    const preset = str(ctx.options, 'pageSize');
    let box = preset === 'match-first' ? { ...firstVisual } : (sizePreset(preset) ?? { ...firstVisual });
    const orientation = str(ctx.options, 'orientation');
    if (orientation === 'landscape' || (orientation === 'auto' && perSheet >= 4)) {
      box = { width: Math.max(box.width, box.height), height: Math.min(box.width, box.height) };
    } else if (orientation === 'portrait') {
      box = { width: Math.min(box.width, box.height), height: Math.max(box.width, box.height) };
    }
    const cells = gridCells(perSheet, box, gap, margin);
    let sheets = 0;

    for (let start = 0; start < total; start += perSheet) {
      const group: number[] = [];
      const block = embedded.slice(start, start + perSheet);
      if (rowFirst) {
        block.forEach((item) => group.push(item.index));
      } else {
        const columns = Math.max(1, Math.ceil(block.length / Math.max(1, Math.ceil(Math.sqrt(block.length)))));
        const rows = Math.ceil(block.length / columns);
        for (let column = 0; column < columns; column += 1) {
          for (let row = 0; row < rows; row += 1) {
            const item = block[row + column * rows];
            if (item) group.push(item.index);
          }
        }
      }
      const sheet = out.addPage([box.width, box.height]);
      group.forEach((sourceIndex, slot) => {
        const entry = embedded[sourceIndex]!;
        const cell = cells[slot]!;
        const natural = entry.rotation % 180 === 90
          ? { width: entry.page.height, height: entry.page.width }
          : { width: entry.page.width, height: entry.page.height };
        const scale = Math.min(cell.width / natural.width, cell.height / natural.height);
        sheet.drawPage(entry.page, {
          x: cell.x + (cell.width - natural.width * scale) / 2,
          // Cells are measured from the sheet's top edge; PDF draws from below.
          y: box.height - cell.y - cell.height + (cell.height - natural.height * scale) / 2,
          xScale: scale,
          yScale: scale,
        });
        if (bool(ctx.options, 'border')) {
          sheet.drawRectangle({
            x: cell.x,
            y: box.height - cell.y - cell.height,
            width: cell.width,
            height: cell.height,
            borderColor: rgb(0.75, 0.78, 0.83),
            borderWidth: 0.5,
          });
        }
      });
      sheets += 1;
      ctx.report({ percent: Math.round(((start + block.length) / total) * 95), current: start + block.length, total });
    }

    for (let index = total - 1; index >= 0; index -= 1) out.removePage(index);
    const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
    await ctx.emitPdf(renderName(ctx.namePattern, { name: baseName(input.name), tool: 'nup' }, 'pdf'), bytes);
    return { pageCountIn: total, pageCountOut: sheets, extra: { sheets, perSheet } };
  },
};

export const geometryTools: ToolImpl[] = [resize, crop, margins, nup];
