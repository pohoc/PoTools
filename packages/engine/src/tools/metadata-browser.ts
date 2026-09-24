import { PDFDict, PDFName, PDFDocument } from 'pdf-lib';
import { EngineError } from '../errors.ts';
import { baseName, renderName } from '../lib/naming.ts';
import type { ToolImpl, ToolResult } from '../types.ts';
import { bool, str } from '../lib/options.ts';

function metadataOf(doc: PDFDocument): Record<string, string> {
  const pick = (value: string | undefined) => (value ?? '').trim();
  const trailerInfo = (doc.context as unknown as { trailerInfo?: Record<string, unknown> }).trailerInfo;
  const rootRef = trailerInfo?.Root;
  const root = rootRef ? doc.context.lookup(rootRef as never) : undefined;
  return {
    title: pick(doc.getTitle()),
    author: pick(doc.getAuthor()),
    subject: pick(doc.getSubject()),
    keywords: pick(doc.getKeywords()),
    creator: pick(doc.getCreator()),
    producer: pick(doc.getProducer()),
    creationDate: isoOrEmpty(doc.getCreationDate()),
    modificationDate: isoOrEmpty(doc.getModificationDate()),
    hasXmp: String(root instanceof PDFDict && Boolean(root.get(PDFName.of('Metadata')))),
  };
}

function isoOrEmpty(value: Date | undefined): string {
  if (!value || Number.isNaN(value.getTime())) return '';
  return value.toISOString();
}

function trailerDict(doc: PDFDocument, key: 'Root' | 'Info'): PDFDict | undefined {
  const trailerInfo = (doc.context as unknown as { trailerInfo?: Record<string, unknown> }).trailerInfo;
  const ref = trailerInfo?.[key];
  if (!ref) return undefined;
  const resolved = doc.context.lookup(ref as never);
  return resolved instanceof PDFDict ? resolved : undefined;
}

function keywords(value: string): string[] {
  return value.split(/[,，;；]/).map((item) => item.trim()).filter(Boolean);
}

/** In-memory version of the metadata tool, sharing its RPC and job contract. */
export const embeddedMetadataTool: ToolImpl = {
  id: 'metadata',
  async run(ctx): Promise<ToolResult> {
    const mode = str(ctx.options, 'mode');
    const report: Record<string, unknown> = {};

    for (const [index, input] of ctx.inputs.entries()) {
      const doc = await ctx.loadPdf(input, ctx.globals);
      if (mode === 'read') {
        report[baseName(input.name)] = { pages: doc.getPageCount(), ...metadataOf(doc) };
        ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100) });
        continue;
      }

      if (mode === 'clear') {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setKeywords([]);
        doc.setCreator('');
        doc.setProducer('');
        const info = trailerDict(doc, 'Info');
        info?.delete(PDFName.of('CreationDate'));
        info?.delete(PDFName.of('ModDate'));
      } else {
        const title = str(ctx.options, 'title').trim();
        if (title) doc.setTitle(title);
        const author = str(ctx.options, 'author').trim();
        if (author) doc.setAuthor(author);
        const subject = str(ctx.options, 'subject').trim();
        if (subject) doc.setSubject(subject);
        const keywordList = str(ctx.options, 'keywords').trim();
        if (keywordList) doc.setKeywords(keywords(keywordList));
        const creator = str(ctx.options, 'creator').trim();
        if (creator) doc.setCreator(creator);
        const producer = str(ctx.options, 'producer').trim();
        if (producer) doc.setProducer(producer);
      }
      if (bool(ctx.options, 'stripXmp')) trailerDict(doc, 'Root')?.delete(PDFName.of('Metadata'));
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: mode === 'clear' ? 'clean' : 'meta' }, 'pdf'),
        bytes,
        input.id,
      );
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100) });
    }

    if (mode === 'read') {
      if (!Object.keys(report).length) throw new EngineError('bad_request', '没有可读取的文档');
      await ctx.emit({ name: 'document-info.json', kind: 'json', bytes: new TextEncoder().encode(JSON.stringify(report, null, 2)) });
      return { extra: { documents: Object.keys(report).length } };
    }
    return { extra: { mode } };
  },
};
