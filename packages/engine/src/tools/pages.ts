import type { PDFDocument } from 'pdf-lib';
import { degrees } from 'pdf-lib';
import { parsePageRanges, formatPageRanges } from '@potools/core';
import { copyPagesInto, createDocument, refitPages, rotateBy } from '../lib/pdf.ts';
import type { RefitOptions } from '../lib/pdf.ts';
import { loadPdf } from '../lib/files.ts';
import { bool, num, str } from '../lib/options.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { EngineError } from '../errors.ts';
import type { ToolContext, ToolImpl } from '../types.ts';

function allPages(doc: PDFDocument): number[] {
  return Array.from({ length: doc.getPageCount() }, (_, i) => i + 1);
}

async function copyMetadataInto(target: PDFDocument, source: PDFDocument): Promise<void> {
  const title = source.getTitle();
  if (title) target.setTitle(title);
  const author = source.getAuthor();
  if (author) target.setAuthor(author);
  const subject = source.getSubject();
  if (subject) target.setSubject(subject);
  const creator = source.getCreator();
  if (creator) target.setCreator(creator);
}

async function finishSave(ctx: ToolContext, doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

/** Names every artifact from the first source file's stem plus a tool suffix. */
function stemFor(ctx: ToolContext, index = 0, suffix = ''): string {
  const input = ctx.inputs[index] ?? ctx.inputs[0];
  const base = input ? baseName(input.name) : 'document';
  return `${base}${suffix}`;
}

const merge: ToolImpl = {
  id: 'merge',
  async run(ctx) {
    const out = await createDocument();
    let pageCount = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await loadPdf(input, ctx.globals);
      await copyMetadataInto(out, doc);
      await copyPagesInto(out, doc, allPages(doc));
      pageCount += doc.getPageCount();
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 80), phase: 'copy', current: index + 1, total: ctx.inputs.length });
    }
    if (!out.getPageCount()) throw new EngineError('empty_selection', '没有可合并的页面');
    const changed = await refitPages(out, {
      size: str(ctx.options, 'pageSize') as RefitOptions['size'],
      orientation: str(ctx.options, 'orientation') as 'portrait',
      margin: num(ctx.options, 'margin'),
    });
    if (changed) ctx.warnings.push('已按目标页面尺寸缩放内容，可能出现留白');
    const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
    const name = renderName(ctx.namePattern, { name: stemFor(ctx), tool: 'merge' }, 'pdf');
    await ctx.emitPdf(name, bytes);
    return { pageCountIn: pageCount, pageCountOut: out.getPageCount() };
  },
};

const split: ToolImpl = {
  id: 'split',
  async run(ctx) {
    const input = ctx.inputs[0] as NonNullable<ToolContext['inputs'][number]>;
    const doc = await loadPdf(input, ctx.globals);
    const total = doc.getPageCount();
    const mode = str(ctx.options, 'mode');
    const stem = baseName(input.name);
    const groups: number[][] = [];

    if (mode === 'each-page') groups.push(...allPages(doc).map((page) => [page]));
    else if (mode === 'every-n') {
      const size = Math.max(1, Math.trunc(num(ctx.options, 'everyN') || 1));
      for (let start = 1; start <= total; start += size) {
        groups.push(allPages(doc).slice(start - 1, start - 1 + size));
      }
    } else if (mode === 'halves') {
      const half = Math.ceil(total / 2);
      groups.push(allPages(doc).slice(0, half), allPages(doc).slice(half));
    } else if (mode === 'manual') {
      const manual = ctx.options.groups as unknown as number[][];
      if (!Array.isArray(manual) || !manual.length) throw new EngineError('empty_selection', '请先在预览上选择拆分位置');
      groups.push(...manual.filter((group) => Array.isArray(group) && group.length));
    } else {
      const ranges = str(ctx.options, 'ranges');
      const parts = ranges.split(/[,;，、]+/).map((chunk) => chunk.trim()).filter(Boolean);
      const parsed = parts.map((part) => parsePageRanges(part, total));
      if (bool(ctx.options, 'rangesAsOne')) groups.push(parsed.flat());
      else groups.push(...parsed);
    }

    const filtered = groups.filter((group) => group.length);
    if (!filtered.length) throw new EngineError('empty_selection', '没有匹配到任何页面');
    for (const [index, group] of filtered.entries()) {
      if (ctx.cancelled()) break;
      const part = await createDocument();
      await copyMetadataInto(part, doc);
      await copyPagesInto(part, doc, group);
      const bytes = await part.save({ useObjectStreams: true, addDefaultPage: false });
      const name = renderName(
        ctx.namePattern,
        {
          name: stem,
          tool: 'split',
          index: index + 1,
          total: filtered.length,
          range: formatPageRanges(group),
        },
        'pdf',
      );
      await ctx.emitPdf(name, bytes, input.id);
      ctx.report({ percent: Math.round(((index + 1) / filtered.length) * 100), phase: 'write', current: index + 1, total: filtered.length });
    }
    return { pageCountIn: total, pageCountOut: filtered.reduce((sum, group) => sum + group.length, 0), extra: { files: filtered.length } };
  },
};

interface PlanItem {
  fileId: string;
  page: number;
  rotation?: number;
}

const organize: ToolImpl = {
  id: 'organize',
  async run(ctx) {
    const plan = (ctx.options.plan ?? []) as unknown as PlanItem[];
    if (!Array.isArray(plan) || !plan.length) throw new EngineError('empty_selection', '页面计划为空');
    const sources = new Map<string, PDFDocument>();
    for (const input of ctx.inputs) sources.set(input.id, await loadPdf(input, ctx.globals));

    const out = await createDocument();
    const first = ctx.inputs[0] ? sources.get(ctx.inputs[0].id) : undefined;
    if (first) await copyMetadataInto(out, first);

    for (const [index, item] of plan.entries()) {
      if (ctx.cancelled()) break;
      const source = sources.get(item.fileId);
      if (!source) {
        ctx.warnings.push(`跳过来源缺失的页面 ${item.page}`);
        continue;
      }
      const copied = await copyPagesInto(out, source, [item.page]);
      const page = copied[0];
      if (page && typeof item.rotation === 'number') {
        const current = source.getPages()[item.page - 1]?.getRotation().angle ?? 0;
        page.setRotation(degrees(normalize(current + item.rotation)));
      }
      ctx.report({ percent: Math.round(((index + 1) / plan.length) * 90), phase: 'copy', current: index + 1, total: plan.length });
    }
    if (!out.getPageCount()) throw new EngineError('empty_selection', '没有可输出的页面');
    await refitPages(out, {
      size: str(ctx.options, 'pageSize') as RefitOptions['size'],
      orientation: 'keep',
      margin: 0,
    });
    const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
    await ctx.emitPdf(renderName(ctx.namePattern, { name: stemFor(ctx), tool: 'organize' }, 'pdf'), bytes);
    return { pageCountIn: plan.length, pageCountOut: out.getPageCount() };
  },
};

function normalize(angle: number): number {
  return ((Math.round(angle) % 360) + 360) % 360;
}

/** Rotation is stored in /Rotate, which every viewer applies; content is untouched. */
const rotate: ToolImpl = {
  id: 'rotate',
  async run(ctx) {
    const angle = num(ctx.options, 'angle');
    let processed = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await loadPdf(input, ctx.globals);
      const pages = parsePageRanges(str(ctx.options, 'pages'), doc.getPageCount());
      for (const page of pages) {
        const target = doc.getPages()[page - 1];
        if (target) rotateBy(target, angle);
      }
      await copyMetadataInto(doc, doc);
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'rotated' }, 'pdf'),
        bytes,
        input.id,
      );
      processed += pages.length;
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountIn: processed, pageCountOut: processed, extra: { angle } };
  },
};

const extractPages: ToolImpl = {
  id: 'extract-pages',
  async run(ctx) {
    const onePerGroup = bool(ctx.options, 'oneFilePerGroup');
    let pagesOut = 0;
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await loadPdf(input, ctx.globals);
      const selection = parsePageRanges(str(ctx.options, 'pages'), doc.getPageCount());
      const groups: number[][] = [];
      if (onePerGroup) {
        const parts = str(ctx.options, 'pages')
          .split(/[,;，、]+/)
          .map((chunk) => chunk.trim())
          .filter(Boolean)
          .map((part) => parsePageRanges(part, doc.getPageCount()));
        groups.push(...(parts.length ? parts : [selection]));
      } else {
        groups.push(selection);
      }
      for (const [groupIndex, group] of groups.entries()) {
        const part = await createDocument();
        await copyMetadataInto(part, doc);
        await copyPagesInto(part, doc, group);
        const bytes = await part.save({ useObjectStreams: true, addDefaultPage: false });
        await ctx.emitPdf(
          renderName(
            ctx.namePattern,
            {
              name: baseName(input.name),
              tool: 'extract',
              index: groupIndex + 1,
              total: groups.length,
              range: formatPageRanges(group),
            },
            'pdf',
          ),
          bytes,
          input.id,
        );
        pagesOut += group.length;
      }
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return { pageCountOut: pagesOut };
  },
};

const deletePages: ToolImpl = {
  id: 'delete-pages',
  async run(ctx) {
    const raw = str(ctx.options, 'pages').trim();
    if (!raw || raw.toLowerCase() === 'all') throw new EngineError('bad_request', '请填写要删除的页码');
    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await loadPdf(input, ctx.globals);
      const doomed = [...new Set(parsePageRanges(raw, doc.getPageCount()))].sort((a, b) => b - a);
      const kept = doc.getPageCount() - doomed.length;
      if (kept <= 0) throw new EngineError('empty_selection', '不能删除全部页面');
      for (const page of doomed) doc.removePage(page - 1);
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'trimmed' }, 'pdf'),
        bytes,
        input.id,
      );
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return {};
  },
};

export const pageTools: ToolImpl[] = [merge, split, organize, rotate, extractPages, deletePages];
