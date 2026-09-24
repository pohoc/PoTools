import { rgb } from 'pdf-lib';
import type { PDFEmbeddedPage } from 'pdf-lib';
import { boxRectOf, copyPagesInto, createDocument, normalizeAngle, sizePreset } from '../lib/pdf.ts';
import type { Box } from '../lib/pdf.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool, num, str } from '../lib/options.ts';
import { gridCells } from './geometry.ts';
import { EngineError } from '../errors.ts';
import type { ToolImpl } from '../types.ts';

interface Rect {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** One source page, already trimmed and rotation-baked, ready to be tiled. */
interface Tile {
  embedded: PDFEmbeddedPage;
  /** Size as it will appear, i.e. after /Rotate. */
  width: number;
  height: number;
  label: string;
}

/** A rectangle measured from the sheet's top edge, like the n-up cells. */
interface Slot {
  tile: Tile;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

type Matrix = [number, number, number, number, number, number];

/**
 * pdf-lib embeds the MediaBox and ignores /Rotate, so the rotation is folded
 * into the form matrix instead — every tile then draws upright.
 */
function bakeRotation(rotation: number, rect: Rect): Matrix {
  const width = rect.right - rect.left;
  const height = rect.top - rect.bottom;
  switch (normalizeAngle(rotation)) {
    case 90:
      return [0, -1, 1, 0, -rect.bottom, width + rect.left];
    case 180:
      return [-1, 0, 0, -1, width + rect.left, height + rect.bottom];
    case 270:
      return [0, 1, -1, 0, height + rect.bottom, -rect.left];
    default:
      return [1, 0, 0, 1, -rect.left, -rect.bottom];
  }
}

/**
 * Shelf packing at natural size: tiles flow along one axis and wrap, so a
 * receipt shares a row while a full A4 invoice keeps a sheet to itself.
 */
function packShelves(tiles: Tile[], sheet: Box, gap: number, margin: number, columnFirst: boolean): Slot[][] {
  const usableA = (columnFirst ? sheet.height : sheet.width) - margin * 2;
  const usableB = (columnFirst ? sheet.width : sheet.height) - margin * 2;
  const sheets: Slot[][] = [];
  let slots: Slot[] = [];
  let aCursor = 0;
  let bUsed = 0;
  let bandB = 0;

  for (const tile of tiles) {
    const along = columnFirst ? tile.height : tile.width;
    const across = columnFirst ? tile.width : tile.height;
    const scale = Math.min(1, usableA / along, usableB / across);
    const a = along * scale;
    const b = across * scale;
    if (slots.length && aCursor + gap + a > usableA) {
      bUsed += bandB + gap;
      bandB = 0;
      aCursor = 0;
    }
    if (bUsed + b > usableB && slots.length) {
      sheets.push(slots);
      slots = [];
      bUsed = 0;
      bandB = 0;
      aCursor = 0;
    }
    const placed: Slot = {
      tile,
      x: columnFirst ? margin + bUsed : margin + aCursor,
      y: columnFirst ? margin + aCursor : margin + bUsed,
      width: columnFirst ? b : a,
      height: columnFirst ? a : b,
      scale,
    };
    slots.push(placed);
    aCursor += a + gap;
    bandB = Math.max(bandB, b);
  }
  if (slots.length) sheets.push(slots);
  return sheets;
}

function packGrid(tiles: Tile[], sheet: Box, perSheet: number, gap: number, margin: number, columnFirst: boolean): Slot[][] {
  const cells = gridCells(perSheet, sheet, gap, margin);
  const order = cells
    .map((cell, index) => ({ cell, index }))
    .sort((a, b) =>
      columnFirst
        ? a.cell.x - b.cell.x || a.cell.y - b.cell.y
        : a.cell.y - b.cell.y || a.cell.x - b.cell.x,
    )
    .map((entry) => entry.index);
  const sheets: Slot[][] = [];
  for (let start = 0; start < tiles.length; start += perSheet) {
    const slots: Slot[] = [];
    const block = tiles.slice(start, start + perSheet);
    block.forEach((tile, position) => {
      const cell = cells[order[position] ?? position]!;
      const scale = Math.min(cell.width / tile.width, cell.height / tile.height, 1);
      slots.push({ tile, ...cell, scale });
    });
    sheets.push(slots);
  }
  return sheets;
}

const invoiceMerge: ToolImpl = {
  id: 'invoice-merge',
  async run(ctx) {
    if (!ctx.inputs.length) throw new EngineError('empty_selection', '没有可拼版的票据文件');
    const dedupe = bool(ctx.options, 'skipDuplicates');
    const inputs = [...ctx.inputs];
    if (bool(ctx.options, 'sortByName')) {
      inputs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }

    const kept: typeof inputs = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const input of inputs) {
      const key = `${input.name.toLowerCase()}:${input.bytes.byteLength}`;
      if (dedupe && seen.has(key)) {
        duplicates += 1;
        ctx.warnings.push(`已跳过重复文件：${input.name}`);
        continue;
      }
      seen.add(key);
      kept.push(input);
    }
    if (!kept.length) throw new EngineError('empty_selection', '所有文件都是重复项，没有可拼版的票据');

    const autoCrop = bool(ctx.options, 'autoCrop');
    const out = await createDocument();
    const tiles: Tile[] = [];
    let sourcePages = 0;

    for (const [index, input] of kept.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      const count = doc.getPageCount();
      if (!count) {
        ctx.warnings.push(`${input.name} 没有页面，已跳过`);
        continue;
      }
      const pages = Array.from({ length: count }, (_, position) => position + 1);
      const copied = await copyPagesInto(out, doc, pages);
      for (const [position, page] of copied.entries()) {
        const rotation = normalizeAngle(page.getRotation().angle);
        // Everything here is in absolute page coordinates, so an offset CropBox works.
        const base = boxRectOf(page);
        let rect: Rect = {
          left: base.x,
          bottom: base.y,
          right: base.x + base.width,
          top: base.y + base.height,
        };
        if (autoCrop) {
          const insets = ctx.contentInsets
            ? await ctx.contentInsets(input.bytes, position + 1, ctx.globals, rotation)
            : null;
          if (insets) {
            rect = {
              left: base.x + clamp(insets.left, 0, base.width - 20),
              bottom: base.y + clamp(insets.bottom, 0, base.height - 20),
              right: base.x + base.width - clamp(insets.right, 0, base.width - 20),
              top: base.y + base.height - clamp(insets.top, 0, base.height - 20),
            };
          }
        }
        const embedded = await out.embedPage(page, rect, bakeRotation(rotation, rect));
        const quarter = rotation % 180 === 90;
        const crop = { width: rect.right - rect.left, height: rect.top - rect.bottom };
        tiles.push({
          embedded,
          width: quarter ? crop.height : crop.width,
          height: quarter ? crop.width : crop.height,
          label: `${baseName(input.name)} ${position + 1}`,
        });
      }
      sourcePages += count;
      ctx.report({
        percent: Math.round(((index + 1) / kept.length) * 70),
        current: index + 1,
        total: kept.length,
      });
    }

    if (!tiles.length) throw new EngineError('empty_selection', '没有可拼版的页面');

    const preset = str(ctx.options, 'sheetSize');
    const base = sizePreset(preset) ?? { width: 595.28, height: 841.89 };
    const perSheetRaw = String(ctx.options.perSheet ?? 'auto');
    const perSheet = perSheetRaw === 'auto' ? 0 : Math.max(1, Math.trunc(Number(perSheetRaw) || 0));
    const gap = num(ctx.options, 'gap');
    const margin = num(ctx.options, 'margin');
    const columnFirst = str(ctx.options, 'order') === 'vertical';
    const landscape = tiles.filter((tile) => tile.width > tile.height).length;
    const orientation = str(ctx.options, 'orientation');
    const wantLandscape =
      orientation === 'landscape' ||
      (orientation === 'auto' && (perSheet >= 4 || (perSheet === 0 && landscape > tiles.length / 2)));
    const sheet: Box = wantLandscape
      ? { width: Math.max(base.width, base.height), height: Math.min(base.width, base.height) }
      : { width: Math.min(base.width, base.height), height: Math.max(base.width, base.height) };

    const border = bool(ctx.options, 'border');
    const sheets = perSheet
      ? packGrid(tiles, sheet, perSheet, gap, margin, columnFirst)
      : packShelves(tiles, sheet, gap, margin, columnFirst);

    for (const [position, slots] of sheets.entries()) {
      const page = out.addPage([sheet.width, sheet.height]);
      for (const slot of slots) {
        const drawn = { width: slot.tile.width * slot.scale, height: slot.tile.height * slot.scale };
        const top = slot.y + (slot.height - drawn.height) / 2;
        page.drawPage(slot.tile.embedded, {
          x: slot.x + (slot.width - drawn.width) / 2,
          y: sheet.height - top - drawn.height,
          xScale: slot.scale,
          yScale: slot.scale,
        });
        if (border) {
          page.drawRectangle({
            x: slot.x,
            y: sheet.height - slot.y - slot.height,
            width: slot.width,
            height: slot.height,
            borderColor: rgb(0.75, 0.78, 0.83),
            borderWidth: 0.5,
          });
        }
      }
      ctx.report({ percent: 70 + Math.round(((position + 1) / sheets.length) * 25) });
    }

    // The copied source pages were only used as embed material.
    for (let position = sourcePages - 1; position >= 0; position -= 1) out.removePage(position);

    const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
    const name = renderName(
      ctx.namePattern,
      { name: baseName(kept[0]!.name), tool: 'invoices' },
      'pdf',
    );
    await ctx.emitPdf(name, bytes);
    return {
      pageCountIn: sourcePages,
      pageCountOut: sheets.length,
      extra: { sheets: sheets.length, invoices: tiles.length, duplicates },
    };
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

export const invoiceTools: ToolImpl[] = [invoiceMerge];
