import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  StandardFonts,
  degrees,
} from 'pdf-lib';
import type { PageInfo } from '@potools/core';
import { EngineError } from '../errors';

export const PAGE_SIZES = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
} as const;

export type PageSizeKey = keyof typeof PAGE_SIZES;

export interface Box {
  width: number;
  height: number;
}

/** Loads a PDF and refuses encrypted files, which this engine cannot decrypt. */
export async function loadDocument(bytes: Uint8Array, label = ''): Promise<PDFDocument> {
  if (!bytes.byteLength) throw new EngineError('unreadable_file', `empty file: ${label}`);
  const signature = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (!signature.includes('%PDF-')) {
    throw new EngineError('unreadable_file', `not a PDF document: ${label || 'input'}`);
  }
  try {
    return await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt|password/i.test(message)) {
      throw new EngineError(
        'encrypted_document',
        label ? `${label} 已加密，需要先解密` : '文档已加密',
        'error.encrypted',
      );
    }
    throw new EngineError('unreadable_file', message, 'error.unreadable');
  }
}

export function savePdf(
  doc: PDFDocument,
  opts: { objectStreams?: boolean; deterministicId?: boolean } = {},
): Promise<Uint8Array> {
  return doc.save({
    useObjectStreams: opts.objectStreams ?? true,
    addDefaultPage: false,
    objectsPerTick: 120,
  });
}

/**
 * Copies one page from `source` into `target` and draws it onto a freshly sized
 * page. Used by resize/margins/n-up so the geometry stays in one place.
 */
export async function appendScaledPage(
  target: PDFDocument,
  source: PDFDocument,
  pageNumber: number,
  box: Box,
  options: { margin?: number; inset?: number; scale?: number; keepRatio?: boolean; align?: 'center' | 'start' } = {},
): Promise<PDFPage> {
  const [copied] = await target.copyPages(source, [pageNumber - 1]);
  if (!copied) throw new EngineError('bad_page_range', `page ${pageNumber} unavailable`);
  target.addPage(copied);
  const tempIndex = target.getPageCount() - 1;
  const embedded = await target.embedPage(copied, embedRect(copied));
  const rotation = normalizeAngle(copied.getRotation().angle);
  target.removePage(tempIndex);

  const page = target.addPage([box.width, box.height]);
  const margin = Math.max(0, options.margin ?? 0);
  const inset = Math.max(0, options.inset ?? 0);
  const available = {
    width: Math.max(1, box.width - margin * 2 - inset * 2),
    height: Math.max(1, box.height - margin * 2 - inset * 2),
  };
  const natural = isQuarterTurn(rotation)
    ? { width: embedded.height, height: embedded.width }
    : { width: embedded.width, height: embedded.height };
  const ratio = options.keepRatio === false ? null : Math.min(available.width / natural.width, available.height / natural.height);
  const scale = Math.min(ratio ?? 1, options.scale ?? 1, 8);
  const drawn = { width: natural.width * scale, height: natural.height * scale };
  const centered = options.align !== 'start';
  page.drawPage(embedded, {
    x: margin + inset + (centered ? (available.width - drawn.width) / 2 : 0),
    y: margin + inset + (centered ? (available.height - drawn.height) / 2 : 0),
    xScale: scale,
    yScale: scale,
  });
  page.setRotation(degrees(rotation));
  return page;
}

/** Trims the printable area without touching the content stream. */
export function cropPage(page: PDFPage, edges: { top: number; right: number; bottom: number; left: number }): void {
  const { x, y, width, height } = boxRectOf(page);
  const left = Math.max(0, Math.min(edges.left, width - 20));
  const bottom = Math.max(0, Math.min(edges.bottom, height - 20));
  const right = Math.max(0, Math.min(edges.right, width - 20));
  const top = Math.max(0, Math.min(edges.top, height - 20));
  // Composes with an existing CropBox, so repeated crops keep narrowing.
  page.setCropBox(x + left, y + bottom, Math.max(20, width - left - right), Math.max(20, height - top - bottom));
}

export function sizePreset(key: string): Box | null {
  const table = PAGE_SIZES as Record<string, readonly [number, number]>;
  const value = table[key];
  return value ? { width: value[0], height: value[1] } : null;
}

export async function createDocument(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setProducer('PoTools');
  doc.setCreator('PoTools');
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());
  return doc;
}

/** pdf-lib embeds the MediaBox unless told otherwise; keep the CropBox. */
function embedRect(page: PDFPage): { left: number; bottom: number; right: number; top: number } {
  const rect = boxRectOf(page);
  return { left: rect.x, bottom: rect.y, right: rect.x + rect.width, top: rect.y + rect.height };
}

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectOf(array: PDFArray | undefined, fallback: PageRect): PageRect {
  if (!array) return fallback;
  const read = (index: number): number => {
    const value = array.get(index);
    return value instanceof PDFNumber ? value.asNumber() : fallback[index === 0 ? 'x' : index === 1 ? 'y' : index === 2 ? 'width' : 'height'];
  };
  const x0 = read(0);
  const y0 = read(1);
  return { x: x0, y: y0, width: read(2) - x0, height: read(3) - y0 };
}

/**
 * The printable rectangle: CropBox when present, clipped to the MediaBox.
 * Viewers and printers honour it, so every layout calculation should too.
 */
export function boxRectOf(page: PDFPage): PageRect {
  const media = rectOf(page.node.MediaBox(), { x: 0, y: 0, ...page.getSize() });
  const cropValue = page.node.get(PDFName.of('CropBox'));
  const cropArray = cropValue instanceof PDFRef ? page.node.context.lookup(cropValue) : cropValue;
  if (!(cropArray instanceof PDFArray)) return media;
  const crop = rectOf(cropArray, media);
  const x = Math.max(media.x, crop.x);
  const y = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  if (right - x < 8 || top - y < 8) return media;
  return { x, y, width: right - x, height: top - y };
}

export function boxOf(page: PDFPage): Box {
  const { width, height } = boxRectOf(page);
  return { width, height };
}

/** Page size as a viewer shows it, i.e. after /Rotate. */
export function visualBoxOf(page: PDFPage): Box {
  const { width, height } = boxOf(page);
  return isQuarterTurn(page.getRotation().angle) ? { width: height, height: width } : { width, height };
}

export function isQuarterTurn(rotation: number): boolean {
  return normalizeAngle(rotation) % 180 === 90;
}

export function normalizeAngle(angle: number): number {
  return ((Math.round(angle) % 360) + 360) % 360;
}

export function rotateBy(page: PDFPage, delta: number): void {
  page.setRotation(degrees(normalizeAngle(page.getRotation().angle + delta)));
}

export function pagesInfo(doc: PDFDocument): PageInfo[] {
  return doc.getPages().map((page, index) => ({
    page: index + 1,
    ...boxOf(page),
    rotation: normalizeAngle(page.getRotation().angle),
  }));
}

/** 1-based `pages` are copied onto the end of `target`. */
export async function copyPagesInto(
  target: PDFDocument,
  source: PDFDocument,
  pages: number[],
): Promise<PDFPage[]> {
  if (!pages.length) return [];
  const count = source.getPageCount();
  const indices = pages.map((p) => {
    const index = Math.trunc(p) - 1;
    if (index < 0 || index >= count) {
      throw new EngineError('bad_page_range', `page ${p} is out of range (1-${count})`);
    }
    return index;
  });
  const copied = await target.copyPages(source, indices);
  copied.forEach((page) => target.addPage(page));
  return copied;
}

export interface RefitOptions {
  size: PageSizeKey | 'match-first' | 'keep';
  orientation: 'keep' | 'portrait' | 'landscape';
  margin: number;
}

export function sizeFor(
  key: RefitOptions['size'],
  orientation: RefitOptions['orientation'],
  reference: Box,
): Box | null {
  if (key === 'keep') return null;
  let box: Box =
    key === 'match-first'
      ? { ...reference }
      : { width: PAGE_SIZES[key][0], height: PAGE_SIZES[key][1] };
  if (orientation === 'portrait' && box.width > box.height) box = swap(box);
  if (orientation === 'landscape' && box.width < box.height) box = swap(box);
  return box;
}

function swap(box: Box): Box {
  return { width: box.height, height: box.width };
}

/**
 * Rebuilds every page onto a common canvas by drawing the original page as a
 * form XObject, so nothing is cropped. Returns true when pages were rewritten.
 */
export async function refitPages(doc: PDFDocument, opts: RefitOptions): Promise<boolean> {
  const originals = doc.getPages();
  if (!originals.length) return false;
  const firstVisual = visualBoxOf(originals[0] as PDFPage);
  const target = sizeFor(opts.size === 'keep' ? 'keep' : opts.size, opts.orientation, firstVisual);
  if (!target) return false;

  const margin = Math.max(0, Math.min(opts.margin ?? 0, Math.floor(Math.min(target.width, target.height) / 3)));
  const snapshots = await Promise.all(
    originals.map(async (page) => ({
      embedded: await doc.embedPage(page, embedRect(page)),
      rotation: normalizeAngle(page.getRotation().angle),
    })),
  );
  for (let i = originals.length - 1; i >= 0; i -= 1) doc.removePage(i);

  for (const { embedded, rotation } of snapshots) {
    const page = doc.addPage([target.width, target.height]);
    // The embedded XObject carries the unrotated content, so fit against the
    // rotated footprint and then restore /Rotate on the destination page.
    const source = isQuarterTurn(rotation)
      ? { width: embedded.height, height: embedded.width }
      : { width: embedded.width, height: embedded.height };
    const available = { width: target.width - margin * 2, height: target.height - margin * 2 };
    const scale = Math.min(available.width / source.width, available.height / source.height, 4);
    const drawn = { width: source.width * scale, height: source.height * scale };
    page.drawPage(embedded, {
      x: margin + (available.width - drawn.width) / 2 + (isQuarterTurn(rotation) ? (drawn.height - drawn.width) / 2 : 0),
      y: margin + (available.height - drawn.height) / 2,
      xScale: scale,
      yScale: scale,
    });
    page.setRotation(degrees(rotation));
  }
  return true;
}

export function readMetadata(doc: PDFDocument): Record<string, string> {
  const pick = (value: string | undefined): string => (value ?? '').trim();
  return {
    title: pick(doc.getTitle()),
    author: pick(doc.getAuthor()),
    subject: pick(doc.getSubject()),
    keywords: pick(doc.getKeywords()),
    creator: pick(doc.getCreator()),
    producer: pick(doc.getProducer()),
    creationDate: isoOrEmpty(doc.getCreationDate()),
    modificationDate: isoOrEmpty(doc.getModificationDate()),
    hasXmp: String(hasXmpMetadata(doc)),
  };
}

function trailerDict(doc: PDFDocument, key: 'Root' | 'Info'): PDFDict | undefined {
  const trailerInfo = (doc.context as unknown as { trailerInfo?: Record<string, unknown> }).trailerInfo;
  const ref = trailerInfo?.[key];
  if (!ref) return undefined;
  const resolved = doc.context.lookup(ref as never);
  return resolved instanceof PDFDict ? resolved : undefined;
}

function rootDict(doc: PDFDocument): PDFDict | undefined {
  return trailerDict(doc, 'Root');
}

function hasXmpMetadata(doc: PDFDocument): boolean {
  return Boolean(rootDict(doc)?.get(PDFName.of('Metadata')));
}

function isoOrEmpty(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

export function stripXmp(doc: PDFDocument): void {
  rootDict(doc)?.delete(PDFName.of('Metadata'));
}

export function clearInfoDates(doc: PDFDocument): void {
  const info = trailerDict(doc, 'Info');
  info?.delete(PDFName.of('CreationDate'));
  info?.delete(PDFName.of('ModDate'));
}

/**
 * Normalises `/Contents` into an array so appended streams can be reordered.
 * Returns the array plus how many entries it held before anything was drawn.
 */
export function contentsHead(doc: PDFDocument, page: PDFPage): { array: PDFArray; count: number } {
  const raw = page.node.get(PDFName.of('Contents'));
  const resolved = raw === undefined ? undefined : doc.context.lookup(raw as never);
  if (resolved instanceof PDFArray) {
    return { array: resolved, count: resolved.size() };
  }
  const array = PDFArray.withContext(doc.context);
  let count = 0;
  if (resolved) {
    array.push(raw as never);
    count = 1;
  }
  page.node.set(PDFName.of('Contents'), array);
  return { array, count };
}

/**
 * pdf-lib always appends drawn content, which paints on top. Moving the freshly
 * added streams to the head of `/Contents` puts them behind the page's artwork.
 */
export function sendAppendedToBack(array: PDFArray, previousCount: number): void {
  const size = array.size();
  if (size <= previousCount + 1 || previousCount === 0) return;
  const appended = [];
  for (let index = previousCount; index < size; index += 1) appended.push(array.get(index));
  for (let index = size - 1; index >= previousCount; index -= 1) array.remove(index);
  appended.reverse().forEach((object, index) => array.insert(index, object));
}
export function hasUniformSize(doc: PDFDocument): boolean {
  const pages = doc.getPages();
  if (pages.length <= 1) return true;
  const base = visualBoxOf(pages[0] as PDFPage);
  return pages.every(
    (page) =>
      Math.abs(visualBoxOf(page).width - base.width) < 1 &&
      Math.abs(visualBoxOf(page).height - base.height) < 1,
  );
}

export async function embedStandardFont(doc: PDFDocument) {
  return doc.embedFont(StandardFonts.Helvetica);
}
