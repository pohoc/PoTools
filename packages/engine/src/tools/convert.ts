import { parsePageRanges } from '@potools/core';
import { loadPdf } from '../lib/files.ts';
import { createDocument } from '../lib/pdf.ts';
import { openRaster } from '../lib/render.ts';
import { getSharp, imageInfo, prepareForEmbedding, transcodePng, type RasterFormat } from '../lib/images.ts';
import { bool, hexToRgb, num, str } from '../lib/options.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { EngineError } from '../errors.ts';
import type { ToolImpl } from '../types.ts';

const PT_PER_PX = 72 / 96;
const MAX_PAGE_PT = 2400;

const pdfToImages: ToolImpl = {
  id: 'pdf-to-images',
  async run(ctx) {
    const format = str(ctx.options, 'format') as RasterFormat;
    const dpi = Math.max(48, num(ctx.options, 'dpi'));
    const quality = num(ctx.options, 'quality');
    const transparent = bool(ctx.options, 'transparentBackground') && format !== 'jpeg';
    let exported = 0;

    for (const [index, input] of ctx.inputs.entries()) {
      const raster = await openRaster(input.bytes, ctx.globals);
      const selection = parsePageRanges(str(ctx.options, 'pages'), raster.pageCount);
      const stem = baseName(input.name);
      for (const [pageIndex, page] of selection.entries()) {
        if (ctx.cancelled()) break;
        const png = raster.renderPng({ page, dpi, transparent });
        const bytes =
          format === 'png' ? png : await transcodePng(png, { format, quality, transparent });
        exported += 1;
        await ctx.emit({
          name: renderName(
            ctx.namePattern,
            {
              name: stem,
              tool: `p${String(page).padStart(2, '0')}`,
              index: pageIndex + 1,
              total: selection.length,
              range: String(page),
            },
            format === 'jpeg' ? 'jpg' : format,
          ),
          kind: 'image',
          bytes,
          page,
          sourceFileId: input.id,
        });
        ctx.report({
          percent: Math.round(((index + (pageIndex + 1) / selection.length) / ctx.inputs.length) * 100),
          phase: 'render',
          current: exported,
          total: selection.length * ctx.inputs.length,
        });
      }
      raster.close();
    }
    return { pageCountOut: exported, extra: { images: exported, dpi } };
  },
};

interface PagePlan {
  box: { width: number; height: number };
  draw: { x: number; y: number; width: number; height: number };
  coverAspect?: number;
}

function planPage(
  meta: { width: number; height: number },
  options: { pageSize: string; orientation: string; fit: string; margin: number },
): PagePlan {
  const margin = Math.max(0, options.margin);
  const landscapeSource = meta.width >= meta.height;
  let box: { width: number; height: number };

  if (options.pageSize === 'auto') {
    const raw = { width: meta.width * PT_PER_PX, height: meta.height * PT_PER_PX };
    const cap = Math.max(raw.width, raw.height) / MAX_PAGE_PT;
    box = cap > 1 ? { width: raw.width / cap, height: raw.height / cap } : raw;
  } else {
    const preset =
      options.pageSize === 'letter'
        ? { width: 612, height: 792 }
        : { width: 595.28, height: 841.89 };
    const landscape =
      options.orientation === 'landscape' || (options.orientation === 'auto' && landscapeSource);
    box = landscape
      ? { width: preset.height, height: preset.width }
      : { width: preset.width, height: preset.height };
  }

  const available = { width: box.width - margin * 2, height: box.height - margin * 2 };
  const sourceAspect = meta.width / meta.height;

  if (options.fit === 'cover') {
    return {
      box,
      draw: { x: margin, y: margin, width: available.width, height: available.height },
      coverAspect: available.width / available.height,
    };
  }
  const scale = Math.min(available.width / box.width, available.height / box.height, 1);
  const width = box.width * scale;
  const height = box.height * scale;
  return {
    box,
    draw: {
      x: margin + (available.width - width) / 2,
      y: margin + (available.height - height) / 2,
      width,
      height,
    },
  };
}

const imagesToPdf: ToolImpl = {
  id: 'images-to-pdf',
  async run(ctx) {
    const pageSize = str(ctx.options, 'pageSize');
    const orientation = str(ctx.options, 'orientation');
    const fit = str(ctx.options, 'fit');
    const margin = num(ctx.options, 'margin');
    const quality = num(ctx.options, 'imageQuality');
    const background = str(ctx.options, 'background') || '#ffffff';

    const out = await createDocument();
    for (const [index, input] of ctx.inputs.entries()) {
      if (ctx.cancelled()) break;
      const meta = await imageInfo(input.bytes);
      const plan = planPage(meta, { pageSize, orientation, fit, margin });
      let bytes = input.bytes;
      if (plan.coverAspect && Number.isFinite(plan.coverAspect)) {
        const cropped = await cropToAspect(input.bytes, plan.coverAspect, quality);
        if (cropped) bytes = cropped;
        else ctx.warnings.push(`${baseName(input.name)}：无法按“填满”裁剪，已改为完整显示`);
      }
      const prepared = await prepareForEmbedding(bytes, { quality, background });
      const image =
        prepared.kind === 'jpeg' ? await out.embedJpg(prepared.bytes) : await out.embedPng(prepared.bytes);
      const page = out.addPage([plan.box.width, plan.box.height]);
      if (background !== '#ffffff') {
        const color = hexToRgb(background);
        page.drawRectangle({
          x: 0,
          y: 0,
          width: plan.box.width,
          height: plan.box.height,
          color: { r: color.r, g: color.g, b: color.b, a: 1 } as never,
        });
      }
      page.drawImage(image, plan.draw);
      ctx.report({
        percent: Math.round(((index + 1) / ctx.inputs.length) * 100),
        phase: 'embed',
        current: index + 1,
        total: ctx.inputs.length,
      });
    }
    if (!out.getPageCount()) throw new EngineError('empty_selection', '没有可写入的图片');
    const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
    const stem = baseName(ctx.inputs[0]?.name ?? 'images');
    const label = ctx.inputs.length > 1 ? `${stem}-${ctx.inputs.length}pages` : stem;
    await ctx.emitPdf(renderName(ctx.namePattern, { name: label, tool: 'images' }, 'pdf'), bytes);
    return { pageCountOut: out.getPageCount(), extra: { images: ctx.inputs.length } };
  },
};

/** Center-crops then re-encodes so the image fills the page box exactly. */
async function cropToAspect(bytes: Uint8Array, aspect: number, quality: number): Promise<Uint8Array | null> {
  const sharp = await getSharp();
  if (!sharp) return null;
  const meta = await imageInfo(bytes);
  const targetWidth = Math.min(4200, Math.round(Math.max(meta.width, meta.height * aspect)));
  const targetHeight = Math.round(targetWidth / aspect);
  try {
    return new Uint8Array(
      await sharp(bytes, { failOn: 'none' })
        .rotate()
        .resize({ width: targetWidth, height: targetHeight, fit: 'cover', position: 'centre' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: Math.round(quality), mozjpeg: true })
        .toBuffer(),
    );
  } catch {
    return null;
  }
}

export const convertTools: ToolImpl[] = [pdfToImages, imagesToPdf];
