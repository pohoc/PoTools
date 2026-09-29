import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { parseInvoiceFields } from '../../../../packages/engine/wasm/pkg/potools_engine.js';
import type { InvoiceScanEntry, InvoiceScanResult } from 'core';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const MAX_TEXT_CHARS = 2_000_000;

interface Candidate {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
}

function emptyFields(): InvoiceScanEntry['fields'] {
  return { date: '', seller: '', buyer: '', invoiceNo: '', amount: '', type: '' };
}

async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const loading = getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false });
  let document: Awaited<typeof loading.promise> | null = null;
  try {
    document = await loading.promise;
    const parts: string[] = [];
    for (let index = 1; index <= Math.min(document.numPages, 20); index += 1) {
      const page = await document.getPage(index);
      try {
        const content = await page.getTextContent();
        parts.push(content.items.map((item) => 'str' in item && typeof item.str === 'string' ? `${item.str}${item.hasEOL ? '\n\n' : ''}` : '').join(''));
      } catch {
        parts.push('');
      } finally {
        page.cleanup();
      }
    }
    return { text: parts.join('\n').slice(0, MAX_TEXT_CHARS), pages: document.numPages };
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
  }
}

export async function scanInvoices(
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  params: Record<string, unknown>,
  workerCount: number,
): Promise<InvoiceScanResult> {
  const listing = await invoke<{
    sourceDirectory: string;
    files: Candidate[];
    skipped: InvoiceScanResult['skipped'];
    exceeded: boolean;
  }>('invoice_scan_list', {
    directory: String(params.directory ?? ''),
    recursive: params.recursive !== false,
    maxFiles: params.maxFiles,
    excludeDirectory: params.excludeDirectory,
  });
  const indexed: Array<InvoiceScanEntry | undefined> = new Array(listing.files.length);
  const skipped = [...listing.skipped];
  const analyze = async (candidate: Candidate, index: number): Promise<void> => {
    const empty = emptyFields();
    try {
      const loaded = await invoke<{ bytes: ArrayBuffer | Uint8Array | number[]; currentSizeBytes: number; changedWhileReading: boolean }>(
        'invoice_read_candidate', { path: candidate.path, expectedSizeBytes: candidate.sizeBytes },
      );
      const bytes = loaded.bytes instanceof ArrayBuffer ? new Uint8Array(loaded.bytes) : Array.isArray(loaded.bytes) ? Uint8Array.from(loaded.bytes) : new Uint8Array(loaded.bytes);
      if (loaded.changedWhileReading || bytes.byteLength !== candidate.sizeBytes || bytes.byteLength > 100 * 1024 * 1024) {
        skipped.push({ relativePath: candidate.relativePath, reason: '扫描期间文件发生变化或超过大小上限' });
        return;
      }
      let pageCount: number | null = null;
      let extractedText = '';
      let recognition: InvoiceScanEntry['recognition'] = 'needs-ocr';
      let fields = empty;
      if (candidate.extension === '.pdf') {
        const extracted = await extractPdfText(bytes);
        pageCount = extracted.pages;
        extractedText = extracted.text;
        if (extractedText.trim()) {
          fields = parseInvoiceFields(extractedText) as unknown as InvoiceScanEntry['fields'];
          recognition = 'native-text';
        }
      }
      const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      indexed[index] = { ...candidate, sizeBytes: bytes.byteLength, sha256, pageCount, extractedText, recognition, fields };
    } catch (error) {
      indexed[index] = { ...candidate, sizeBytes: 0, sha256: '', pageCount: null, extractedText: '', recognition: 'failed', fields: empty, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const size = Math.max(1, workerCount);
  for (let start = 0; start < listing.files.length; start += size) {
    await Promise.all(listing.files.slice(start, start + size).map((candidate, offset) => analyze(candidate, start + offset)));
  }
  return {
    sourceDirectory: listing.sourceDirectory,
    scannedAt: Date.now(),
    files: indexed.filter((entry): entry is InvoiceScanEntry => Boolean(entry)),
    skipped,
    warnings: ['ocr-unavailable', ...(listing.exceeded ? ['scan-limit-reached'] : [])],
  };
}
