import type { InvoiceScanEntry } from '@potools/core';
import { EngineError } from '../errors.ts';
import { parseInvoiceFields } from '../lib/invoice-fields.ts';
import type { ResolvedInput } from '../types.ts';

const MAX_TEXT_CHARS = 2_000_000;

export interface InvoiceScanCandidate {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
}

export async function analyzeInvoiceCandidate(
  candidate: InvoiceScanCandidate,
  input: ResolvedInput,
  changedWhileReading: boolean,
): Promise<{ entry?: InvoiceScanEntry; skipped?: { relativePath: string; reason: string } }> {
  if (changedWhileReading || input.bytes.byteLength !== candidate.sizeBytes || input.bytes.byteLength > 100 * 1024 * 1024) {
    return { skipped: { relativePath: candidate.relativePath, reason: '扫描期间文件发生变化或超过大小上限' } };
  }

  const fields = (): InvoiceScanEntry['fields'] => ({ date: '', seller: '', buyer: '', invoiceNo: '', amount: '', type: '' });
  try {
    const digestBuffer = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(digestBuffer).set(input.bytes);
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', digestBuffer));
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const entry: InvoiceScanEntry = {
      path: candidate.path,
      relativePath: candidate.relativePath,
      name: candidate.name,
      extension: candidate.extension,
      sizeBytes: input.bytes.byteLength,
      sha256,
      pageCount: null,
      extractedText: '',
      recognition: 'needs-ocr',
      fields: fields(),
    };
    if (candidate.extension === '.pdf') {
      let document: import('mupdf').Document | null = null;
      try {
        const { default: mupdf } = await import('mupdf');
        try {
          document = mupdf.Document.openDocument(Uint8Array.from(input.bytes), 'application/pdf');
        } catch (error) {
          throw new EngineError('unreadable_file', `MuPDF 无法解析文档：${error instanceof Error ? error.message : String(error)}`, 'error.unreadable');
        }
        if (document.needsPassword() && !document.authenticatePassword('')) {
          throw new EngineError('encrypted_document', '文档需要密码才能读取', 'error.encrypted');
        }
        entry.pageCount = document.countPages();
        const textParts: string[] = [];
        for (let pageNumber = 1; pageNumber <= Math.min(document.countPages(), 20); pageNumber += 1) {
          const page = document.loadPage(pageNumber - 1);
          try {
            const structuredText = (page as unknown as {
              toStructuredText(options: string, area: string): import('mupdf').StructuredText;
            }).toStructuredText('', '');
            try {
              textParts.push(structuredText.asText());
            } finally {
              structuredText.destroy();
            }
          } catch {
            // Match RasterHandle.pageText: unreadable individual text layers are empty.
            textParts.push('');
          } finally {
            page.destroy();
          }
        }
        entry.extractedText = textParts.join('\n').slice(0, MAX_TEXT_CHARS);
        if (entry.extractedText.trim()) {
          entry.recognition = 'native-text';
          entry.fields = parseInvoiceFields(entry.extractedText);
        }
      } finally {
        document?.destroy();
      }
    }
    return { entry };
  } catch (error) {
    const issue = error instanceof Error ? error.message : String(error);
    return {
      entry: {
        path: candidate.path,
        relativePath: candidate.relativePath,
        name: candidate.name,
        extension: candidate.extension,
        sizeBytes: 0,
        sha256: '',
        pageCount: null,
        extractedText: '',
        recognition: 'failed',
        fields: fields(),
        error: issue,
      },
    };
  }
}
