import type { PageThumb } from 'core';
import UTIF from 'utif';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mark, now } from './timing.ts';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type RasterFormat = 'jpeg' | 'png' | 'webp' | 'tiff';

function rasterFormat(bytes: Uint8Array): RasterFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  if (bytes.length >= 8 && (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
    || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  )) return 'tiff';
  return null;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function requestedWidth(params: Record<string, unknown>): number {
  return Math.min(2400, Math.max(48, Number(params.width) || 160));
}

function outputOptions(params: Record<string, unknown>, width: number): { mime: 'image/png' | 'image/jpeg'; quality: number } {
  const png = params.format === 'png' || width > 600;
  return {
    mime: png ? 'image/png' : 'image/jpeg',
    quality: Math.min(95, Math.max(45, Number(params.quality) || (width > 600 ? 92 : 68))),
  };
}

async function decodeTiff(bytes: Uint8Array): Promise<ImageBitmap | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return null;
  try {
    const buffer = Uint8Array.from(bytes).buffer as ArrayBuffer;
    const ifds = UTIF.decode(buffer);
    const ifd = ifds[0];
    if (!ifd) return null;
    const width = Number(ifd.t256?.[0] ?? ifd.width ?? 0);
    const height = Number(ifd.t257?.[0] ?? ifd.height ?? 0);
    const orientation = Math.min(8, Math.max(1, Number(ifd.t274?.[0] ?? 1)));
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16000 || height > 16000 || width * height > 120_000_000) return null;
    UTIF.decodeImage(buffer, ifd, ifds);
    const rgba = UTIF.toRGBA8(ifd);
    if (rgba.byteLength !== width * height * 4) return null;
    const swap = orientation >= 5 && orientation <= 8;
    const outWidth = swap ? height : width;
    const outHeight = swap ? width : height;
    const source = new OffscreenCanvas(width, height);
    const sourceContext = source.getContext('2d', { alpha: true });
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const context = canvas.getContext('2d', { alpha: true });
    if (!sourceContext || !context) return null;
    const transforms: Record<number, [number, number, number, number, number, number]> = {
      1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, width, 0],
      3: [-1, 0, 0, -1, width, height], 4: [1, 0, 0, -1, 0, height],
      5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, height, 0],
      7: [0, -1, -1, 0, height, width], 8: [0, -1, 1, 0, 0, width],
    };
    sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    context.setTransform(...transforms[orientation]!);
    context.drawImage(source, 0, 0);
    return await createImageBitmap(canvas);
  } catch {
    return null;
  }
}

async function rasterBitmap(bytes: Uint8Array, format: RasterFormat | null): Promise<ImageBitmap | null> {
  if (format === 'tiff') return decodeTiff(bytes);
  if (typeof createImageBitmap !== 'function') return null;
  const copy = Uint8Array.from(bytes);
  try { return await createImageBitmap(new Blob([copy.buffer]), { imageOrientation: 'from-image' }); }
  catch { return null; }
}

async function renderImageThumb(bytes: Uint8Array, params: Record<string, unknown>): Promise<PageThumb | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const bitmap = await rasterBitmap(bytes, rasterFormat(bytes));
  if (!bitmap) return null;
  try {
    const widthLimit = requestedWidth(params);
    const scale = Math.min(1, widthLimit / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if (width > 32767 || height > 32767) return null;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const options = outputOptions(params, widthLimit);
    const mime = options.mime === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob({ type: mime, quality: mime === 'image/png' ? undefined : options.quality / 100 });
    if (blob.type !== mime) return null;
    return {
      page: 1,
      dataUrl: `data:${mime};base64,${encodeBase64(new Uint8Array(await blob.arrayBuffer()))}`,
      width: bitmap.width,
      height: bitmap.height,
      rotation: 0,
    };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

type LoadedPdf = Awaited<ReturnType<typeof getDocument>['promise']>;

/**
 * The most recently parsed PDF.
 *
 * The page grid asks for thumbnails in chunks of eight pages, per width, so a
 * 30-page document used to be fetched, copied and fully parsed four or more
 * times — for a 45 MB scan that dominated the whole preview. The document is
 * kept until a *different* file is asked for, which makes every chunk after the
 * first reuse one parse.
 */
let loaded: { key: string; document: LoadedPdf } | null = null;

async function documentFor(input: { id: string; bytes: Uint8Array }): Promise<LoadedPdf> {
  const key = `${input.id}:${input.bytes.byteLength}`;
  if (loaded?.key === key) return loaded.document;
  if (loaded) {
    await loaded.document.destroy().catch(() => undefined);
    loaded = null;
  }
  // Copied once: pdf.js takes ownership of the buffer it is given, and the
  // caller's bytes stay live for the rest of the session.
  const startedAt = now();
  const data = Uint8Array.from(input.bytes);
  const document = await getDocument({ data, isEvalSupported: false }).promise;
  loaded = { key, document };
  mark('preview:parse', startedAt, { bytes: input.bytes.byteLength, pages: document.numPages });
  return document;
}

async function renderPdfThumbs(input: { id: string; bytes: Uint8Array }, params: Record<string, unknown>): Promise<PageThumb[] | null> {
  const requested = Array.isArray(params.pages) ? params.pages.map(Number) : [];
  if (!requested.length) return [];
  const width = requestedWidth(params);
  const options = outputOptions(params, width);
  // Outlives this call: the cache above serves the remaining page chunks.
  const document = await documentFor(input);

  const pages = requested.filter(
    (pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= document.numPages,
  );
  if (!pages.length) return [];

  // Measured on a 45 MB / 30-page scan: total parsing is ~150 ms, but each page
  // costs ~900 ms to rasterise because pdf.js decodes the page's full-resolution
  // image before scaling it down to the requested width. Rendered sequentially,
  // eight pages therefore took seven seconds while the thread sat waiting on
  // image decoding — a small pool overlaps those decodes.
  //
  // Deliberately modest: the large preview width means multi-megapixel canvases,
  // and pdf.js serialises on this thread whatever it cannot hand to the decoder.
  const concurrency = Math.min(width > 800 ? 2 : 4, pages.length);
  const rendered = new Array<PageThumb | null>(pages.length).fill(null);
  let cursor = 0;
  const renderNext = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pages.length) return;
      const pageNumber = pages[index] as number;
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / Math.max(1, baseViewport.width) });
      const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('PoTools: 2D context unavailable for page rendering');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport, background: '#ffffff' }).promise;
      const blob = await canvas.convertToBlob({ type: options.mime, quality: options.quality / 100 });
      rendered[index] = {
        page: pageNumber,
        dataUrl: `data:${options.mime};base64,${encodeBase64(new Uint8Array(await blob.arrayBuffer()))}`,
        width: canvas.width,
        height: canvas.height,
        rotation: 0,
      };
      page.cleanup();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, renderNext));
  return rendered.filter((thumb): thumb is PageThumb => thumb !== null);
}

export async function renderPageThumbs(
  inputs: Array<{ id: string; name: string; bytes: Uint8Array }>,
  params: Record<string, unknown>,
): Promise<{ handled: boolean; result?: PageThumb[] }> {
  const file = params.file as { id?: string; name?: string } | undefined;
  const input = inputs.find((item) => item.id === file?.id) ?? inputs[0];
  if (!file || !input || typeof OffscreenCanvas === 'undefined') {
    // `handled: false` normally means "not my job, try the next handler", but for
    // a page-thumbnail request it also leaves the grid empty with no error. Name
    // the reason: a WebView without OffscreenCanvas (older WebKit) lands here.
    console.warn('PoTools: page thumbnails unavailable', {
      hasFile: Boolean(file),
      hasInput: Boolean(input),
      hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    });
    return { handled: false };
  }
  const isPdf = new TextDecoder().decode(input.bytes.subarray(0, 1024)).includes('%PDF-');
  if (!isPdf) {
    const requested = Array.isArray(params.pages) ? params.pages.map(Number) : [];
    if (!requested.length || !requested.includes(1)) {
      // Returning an empty grid here is what a broken preview looks like, so say
      // why. The usual cause is a payload that arrived without bytes: a
      // File-backed input carries them out of band and a worker cannot see them.
      console.warn('PoTools: page thumbnails requested for a non-PDF payload', {
        file: file.name,
        bytes: input.bytes.byteLength,
        head: new TextDecoder().decode(input.bytes.subarray(0, 16)),
        requested,
      });
      return { handled: true, result: [] };
    }
    const result = await renderImageThumb(input.bytes, params);
    if (!result) console.warn('PoTools: image thumbnail render returned nothing', { file: file.name, bytes: input.bytes.byteLength });
    return result ? { handled: true, result: [result] } : { handled: false };
  }
  try {
    const result = await renderPdfThumbs(input, params);
    if (!result) console.warn('PoTools: PDF thumbnail render returned nothing', { file: file.name, bytes: input.bytes.byteLength, pages: params.pages });
    return result ? { handled: true, result } : { handled: false };
  } catch (error) {
    // A bare catch here turned every render failure into a blank grid with no
    // error at all, which is the hardest possible thing to diagnose.
    console.error('PoTools: PDF page thumbnails failed', {
      file: file.name,
      bytes: input.bytes.byteLength,
      error,
    });
    return { handled: false };
  }
}
