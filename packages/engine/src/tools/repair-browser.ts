import { EngineError } from '../errors.ts';
import { baseName, renderName } from '../lib/naming.ts';
import { bool } from '../lib/options.ts';
import { stripXmp } from '../lib/pdf.ts';
import type { ToolImpl } from '../types.ts';

/** Rewrites PDFs in memory, using the same MuPDF WASM normalizer as the Node engine. */
export const embeddedRepairTool: ToolImpl = {
  id: 'repair',
  async run(ctx) {
    for (const [index, input] of ctx.inputs.entries()) {
      const source = bool(ctx.options, 'recompress')
        ? { ...input, bytes: await normalizeForRepair(input.bytes) }
        : input;
      const doc = await ctx.loadPdf(source, ctx.globals);
      if (!doc.getPageCount()) {
        throw new EngineError(
          'unreadable_file',
          `${baseName(input.name)}：文档结构损坏严重，重建后没有任何页面可恢复`,
        );
      }
      if (bool(ctx.options, 'stripMetadata')) {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setKeywords([]);
        stripXmp(doc);
      }
      doc.setProducer('PoTools');
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      await ctx.emitPdf(
        renderName(ctx.namePattern, { name: baseName(input.name), tool: 'repaired' }, 'pdf'),
        bytes,
        input.id,
      );
      const ratio = input.bytes.byteLength
        ? Math.round(((bytes.byteLength - input.bytes.byteLength) / input.bytes.byteLength) * 100)
        : 0;
      if (ratio > 5) ctx.warnings.push(`${baseName(input.name)}：结构已重建，体积增加 ${ratio}%`);
      ctx.report({ percent: Math.round(((index + 1) / ctx.inputs.length) * 100), current: index + 1, total: ctx.inputs.length });
    }
    return {};
  },
};

async function normalizeForRepair(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const { default: mupdf } = await import('mupdf');
    const document = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf') as unknown as {
      needsPassword(): number;
      authenticatePassword(password: string): boolean;
      saveToBuffer(options: string): { asUint8Array(): Uint8Array };
      destroy(): void;
    };
    try {
      if (document.needsPassword() && !document.authenticatePassword('')) return bytes;
      return new Uint8Array(document.saveToBuffer('compress').asUint8Array());
    } finally {
      document.destroy();
    }
  } catch {
    // The Node implementation also keeps the original bytes if MuPDF cannot
    // normalize them; pdf-lib then returns the established parse error.
    return bytes;
  }
}
