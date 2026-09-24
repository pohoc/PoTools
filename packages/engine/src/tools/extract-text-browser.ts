import { parsePageRanges } from '@potools/core';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { EngineError } from '../errors.ts';
import { InMemoryFallback } from '../lib/memory-job.ts';
import { baseName } from '../lib/naming.ts';
import type { ToolImpl } from '../types.ts';
import { optBool, optStr } from './time-core.ts';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Browser PDF.js implementation; the desktop host already transfers the source bytes into this Worker. */
export const embeddedExtractTextTool: ToolImpl = {
  id: 'extract-text',
  async run(ctx) {
    const perPage = optStr(ctx, 'granularity') === 'per-page';
    const markers = optBool(ctx, 'pageMarkers', true);
    const encoder = new TextEncoder();

    for (const [index, input] of ctx.inputs.entries()) {
      const copy = new Uint8Array(input.bytes.byteLength);
      copy.set(input.bytes);
      const loading = getDocument({ data: copy, isEvalSupported: false, password: ctx.globals.password || undefined });
      let document: Awaited<typeof loading.promise> | null = null;
      try {
        document = await loading.promise;
        const selection = parsePageRanges(optStr(ctx, 'pages'), document.numPages);
        const stem = baseName(input.name);
        const parts: string[] = [];
        let characters = 0;
        for (const [slot, pageNumber] of selection.entries()) {
          if (ctx.cancelled()) break;
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          const text = content.items.map((item) => {
            const textItem = item as { str?: unknown; hasEOL?: boolean };
            return typeof textItem.str === 'string' ? `${textItem.str}${textItem.hasEOL ? '\n\n' : ''}` : '';
          }).join('');
          characters += text.length;
          if (perPage) {
            await ctx.emit({
              name: `${stem}-p${String(pageNumber).padStart(2, '0')}.txt`,
              kind: 'text',
              bytes: encoder.encode(text),
              page: pageNumber,
              sourceFileId: input.id,
            });
          } else {
            parts.push(markers && selection.length > 1 ? `--- ${pageNumber} ---\n${text}` : text);
          }
          page.cleanup();
          ctx.report({ percent: Math.round(((index + slot + 1) / ctx.inputs.length) * 100) });
        }
        if (!perPage) {
          const body = parts.join('\n\n').trim();
          if (!body) throw new EngineError('empty_selection', `${stem} 中没有可提取的文字（可能是扫描件）`);
          await ctx.emit({ name: `${stem}.txt`, kind: 'text', bytes: encoder.encode(body + '\n'), sourceFileId: input.id });
        }
        if (!characters) ctx.warnings.push(`${stem}：未提取到文字层`);
      } catch (error) {
        if (error instanceof EngineError || error instanceof InMemoryFallback) throw error;
        throw new InMemoryFallback(error instanceof Error ? error.message : String(error));
      } finally {
        if (document) await document.destroy();
        else await loading.destroy();
      }
    }
    return {};
  },
};
