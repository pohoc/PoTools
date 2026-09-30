/**
 * Lazy pdf.js loader.
 *
 * pdf.js is the largest JavaScript dependency in the app (~700 kB across its
 * chunks) and only the flows that actually read PDF content need it: content
 * insets, invoice text extraction and the result preview. Importing it at module
 * scope put it on the start-up critical path through the transport/job plumbing,
 * so it is fetched on first use instead.
 *
 * The worker source must be set before any `getDocument` call, so it is
 * configured inside the loader rather than by each caller.
 */
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let modulePromise: Promise<PdfjsModule> | null = null;

/** Resolves the pdf.js module, loading and configuring it once per context. */
export function loadPdfjs(): Promise<PdfjsModule> {
  modulePromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    return pdfjs;
  });
  return modulePromise;
}
