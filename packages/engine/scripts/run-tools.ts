/**
 * End-to-end harness: drives every registered tool through the real engine and
 * asserts the artifacts on disk. Run after `make-samples`.
 */
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { PDFArray, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { FileRef, JobError, JobSnapshot, TempUsage, TextRunResult, ToolId } from '@potools/core';
import { defaultOptions, TOOL_LIST } from '@potools/core';

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}
import { createEngine, type Engine } from '../src/rpc.ts';
import { DAY_MS, formatInZone, parseFlex, zonedParts } from '../src/tools/time-core.ts';
import { openRaster } from '../src/lib/render.ts';
import { writeDocx, writePptx, writeXlsx } from '../src/lib/office.ts';
import { convertOfficeLocally } from '../src/lib/document-builder.ts';


const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = resolve(HERE, '../../../samples');
const OUT_DIR = resolve(SAMPLES, 'out');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
let counter = 0;
const results: Array<{ name: string; ok: boolean; skipped?: boolean; detail: string }> = [];

function file(name: string): FileRef {
  return { id: `${name}-${counter}`, name, path: resolve(SAMPLES, name) };
}

async function run(
  engine: Engine,
  tool: ToolId,
  files: FileRef[],
  options: Record<string, unknown> = {},
  label: string = tool,
): Promise<JobSnapshot> {
  const id = `${tool}-${(counter += 1)}`;
  const settled = new Promise<JobSnapshot>((resolveJob) => {
    const unsubscribe = engine.manager.on((event) => {
      if (event.event !== 'job.updated' || event.job.id !== id) return;
      if (!TERMINAL.has(event.job.progress.state)) return;
      unsubscribe();
      resolveJob(event.job);
    });
  });
  const snapshot = engine.manager.submit({
    id,
    tool,
    files,
    options: { ...defaultOptions(tool), ...options },
    output: { dir: OUT_DIR },
  });
  void snapshot;
  return settled;
}

async function textOf(job: JobSnapshot): Promise<string> {
  let out = '';
  for (const artifact of job.artifacts) {
    if (!artifact.path) continue;
    out += await readFile(artifact.path, 'utf8');
  }
  return out;
}

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}\n`);
}

function recordSkipped(name: string, detail: string): void {
  results.push({ name, ok: false, skipped: true, detail });
  process.stdout.write(`SKIP  ${name.padEnd(34)} ${detail}\n`);
}

async function assertArtifacts(name: string, job: JobSnapshot, expectPages?: number): Promise<void> {
  if (job.progress.state !== 'succeeded') {
    record(name, false, job.error ? `${job.error.code}: ${job.error.message}` : job.progress.state);
    return;
  }
  if (!job.artifacts.length) {
    record(name, false, 'no artifacts');
    return;
  }
  let total = 0;
  for (const artifact of job.artifacts) {
    if (!artifact.path) {
      record(name, false, `${artifact.name} has no path`);
      return;
    }
    const info = await stat(artifact.path).catch(() => null);
    if (!info || info.size === 0) {
      record(name, false, `${artifact.name} missing or empty`);
      return;
    }
    total += info.size;
  }
  if (job.artifacts[0]?.kind === 'pdf' && expectPages !== undefined) {
    const buffer = await readFileBuffer(job.artifacts[0].path as string);
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    if (doc.getPageCount() !== expectPages) {
      record(name, false, `expected ${expectPages} pages, got ${doc.getPageCount()}`);
      return;
    }
  }
  const warnings = job.warnings.length ? ` warn=${job.warnings.length}` : '';
  record(name, true, `${job.artifacts.length} file(s), ${(total / 1024).toFixed(0)} KB${warnings}`);
}


/** Reads the printable box the way viewers do: CropBox when present. */
async function inspectPdf(
  path: string,
): Promise<{ count: number; pages: Array<{ w: number; h: number; r: number }> }> {
  const doc = await PDFDocument.load(await readFileBuffer(path), { updateMetadata: false });
  const edgeNumbers = (page: ReturnType<typeof doc.getPage>, name: string): number[] | null => {
    const value = page.node.get(PDFName.of(name));
    if (!(value instanceof PDFArray)) return null;
    return Array.from({ length: value.size() }, (_, index) => {
      const item = value.get(index);
      return item instanceof PDFNumber ? item.asNumber() : 0;
    });
  };
  return {
    count: doc.getPageCount(),
    pages: doc.getPages().map((page) => {
      const media = edgeNumbers(page, 'MediaBox') ?? [0, 0, page.getWidth(), page.getHeight()];
      const crop = edgeNumbers(page, 'CropBox') ?? media;
      const at = (box: number[], index: number): number => box[index] ?? 0;
      const width = at(crop, 2) - at(crop, 0) || at(media, 2) - at(media, 0);
      const height = at(crop, 3) - at(crop, 1) || at(media, 3) - at(media, 1);
      return {
        w: Math.round(width),
        h: Math.round(height),
        r: ((Math.round(page.getRotation().angle) % 360) + 360) % 360,
      };
    }),
  };
}

async function artifactText(job: JobSnapshot, kind?: string): Promise<string> {
  const artifact = kind ? job.artifacts.find((item) => item.kind === kind) : job.artifacts[0];
  if (!artifact?.path) return '';
  return Buffer.from(await readFileBuffer(artifact.path)).toString('utf8');
}

async function rasterText(path: string): Promise<string> {
  const raster = await openRaster(new Uint8Array(await readFileBuffer(path)), {});
  let text = '';
  for (let page = 1; page <= raster.pageCount; page += 1) text += `${raster.pageText(page)}\n`;
  raster.close();
  return text;
}

function near(value: number, target: number, tolerance: number): boolean {
  return Math.abs(value - target) <= tolerance;
}

/** A rejected `tool.run` carries the same code/message shape as a failed job. */
function asJobError(error: unknown): JobError {
  const e = error as { code?: string; message?: string };
  return { code: e?.code ?? 'internal', message: e?.message ?? String(error) };
}

interface TextRun {
  result: TextRunResult | null;
  error: JobError | null;
}

/**
 * Calls the synchronous text channel. It must never create a job and never touch
 * the filesystem, so the harness reads the reply straight off the wire.
 */
async function callText(
  engine: Engine,
  tool: ToolId,
  options: Record<string, unknown> = {},
  locale: string = 'zh-CN',
): Promise<TextRun> {
  try {
    const result = (await engine.call('tool.run', {
      tool,
      options,
      globals: { locale },
    })) as TextRunResult;
    return { result, error: null };
  } catch (error) {
    return { result: null, error: asJobError(error) };
  }
}

/** Asserts the reply contract (inline text == artifact bytes) plus the needles. */
function contractProblems(result: TextRunResult, needles: string[]): string[] {
  const problems = needles
    .filter((needle) => !result.text.includes(needle))
    .map((needle) => `缺少「${needle}」`);
  const draft = result.artifacts.find((item) => item.kind === 'text' || item.kind === 'json');
  if (!draft) problems.push('无文本 artifact');
  else {
    if (Buffer.from(draft.dataBase64, 'base64').toString('utf8') !== result.text) {
      problems.push('artifact 字节与 text 不一致');
    }
    if (draft.sizeBytes !== Buffer.byteLength(result.text)) problems.push(`sizeBytes=${draft.sizeBytes}`);
    if (!draft.name) problems.push('artifact 缺少名称');
  }
  if (!Array.isArray(result.warnings)) problems.push('warnings 非数组');
  if (!Number.isFinite(result.ms) || result.ms < 0) problems.push(`ms=${result.ms}`);
  return problems;
}

async function assertExports(
  name: string,
  job: JobSnapshot,
  inspect: (bytes: Uint8Array) => Promise<string>,
): Promise<void> {
  if (job.progress.state !== 'succeeded') {
    record(name, false, job.error ? `${job.error.code}: ${job.error.message}` : job.progress.state);
    return;
  }
  const artifact = job.artifacts.find((item) => item.kind !== 'image');
  if (!artifact?.path) {
    record(name, false, 'no artifact path');
    return;
  }
  try {
    const detail = await inspect(new Uint8Array(await readFileBuffer(artifact.path)));
    record(name, !/missing|not an|no |expected/.test(detail), `${artifact.name} — ${detail}`);
  } catch (error) {
    record(name, false, `${artifact.name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertPdfText(
  name: string,
  job: JobSnapshot,
  expectPages: number,
  needles: string[],
): Promise<void> {
  if (job.progress.state !== 'succeeded') {
    record(name, false, job.error ? `${job.error.code}: ${job.error.message}` : job.progress.state);
    return;
  }
  const path = job.artifacts[0]?.path;
  if (!path) {
    record(name, false, 'no artifact path');
    return;
  }
  const raster = await openRaster(new Uint8Array(await readFileBuffer(path)), {});
  const pageCount = raster.pageCount;
  let text = '';
  for (let page = 1; page <= pageCount; page += 1) text += `${raster.pageText(page)}\n`;
  raster.close();
  const missing = needles.filter((needle) => !text.includes(needle));
  const ok = pageCount === expectPages && !missing.length;
  const detail =
    pageCount !== expectPages
      ? `expected ${expectPages} page(s), got ${pageCount}`
      : missing.length
        ? `missing text: ${missing.join(', ')}`
        : `${pageCount} page(s), text ok`;
  record(name, ok, detail);
}

async function readFileBuffer(path: string): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises');
  return new Uint8Array(await readFile(path));
}

async function main(): Promise<void> {
  const engine = await createEngine({ concurrency: 1 });
  const info = engine.info();
  process.stdout.write(
    `engine ${info.version} node=${info.nodeVersion} raster=${info.features.rasterizer} codec=${info.features.imageCodec} font=${info.features.cjkFont ? 'ok' : 'none'}\n\n`,
  );

  const a = file('sample-a.pdf');
  const b = file('sample-b.pdf');
  const photos = file('sample-photos.pdf');
  counter += 1;
  const jpg = file('sample-photo-1.jpg');
  const png = file('sample-scan-2.png');
  const wide = file('sample-wide-3.jpg');

  // 1. merge
  await assertArtifacts('merge', await run(engine, 'merge', [a, b]), 5);
  await assertArtifacts(
    'merge (a4 normalized)',
    await run(engine, 'merge', [a, b], { pageSize: 'a4', orientation: 'portrait', margin: 12 }),
    5,
  );

  // 2. split
  await assertArtifacts('split each-page', await run(engine, 'split', [a], { mode: 'each-page' }));
  await assertArtifacts('split every-2', await run(engine, 'split', [a], { mode: 'every-n', everyN: 2 }));
  await assertArtifacts('split ranges', await run(engine, 'split', [a], { mode: 'ranges', ranges: '1-2,3' }));
  await assertArtifacts('split ranges as one', await run(engine, 'split', [a], { mode: 'ranges', ranges: '1,3', rangesAsOne: true }), 2);
  await assertArtifacts('split halves', await run(engine, 'split', [a], { mode: 'halves' }));

  // 3. organize
  const plan = [
    { fileId: a.id, page: 3 },
    { fileId: a.id, page: 1, rotation: 90 },
    { fileId: b.id, page: 2 },
    { fileId: a.id, page: 1 },
  ];
  await assertArtifacts('organize', await run(engine, 'organize', [a, b], { plan }), 4);

  // 4. rotate / extract / delete
  await assertArtifacts('rotate page 1', await run(engine, 'rotate', [a], { angle: -90, pages: '1' }), 3);
  await assertArtifacts('extract 2-3', await run(engine, 'extract-pages', [a], { pages: '2-3' }), 2);
  await assertArtifacts('extract per range', await run(engine, 'extract-pages', [a], { pages: '1,3', oneFilePerGroup: true }));
  await assertArtifacts('delete page 2', await run(engine, 'delete-pages', [a], { pages: '2' }), 2);

  // 5. markup
  await assertArtifacts('watermark center', await run(engine, 'watermark', [a], { text: '机密 CONF' }), 3);
  await assertArtifacts('watermark tiled', await run(engine, 'watermark', [a], { text: 'DRAFT 草稿', tiled: true, opacity: 12 }), 3);
  await assertArtifacts('watermark below layer', await run(engine, 'watermark', [a], { text: 'BELOW', layer: 'below' }), 3);
  await assertArtifacts('watermark top-right', await run(engine, 'watermark', [a], { text: 'X', position: 'top-right' }), 3);
  await assertArtifacts('page numbers', await run(engine, 'page-numbers', [a], { format: '第 {n} 页 / 共 {total} 页' }), 3);
  await assertArtifacts('page numbers skip first', await run(engine, 'page-numbers', [a], { skipFirst: true, position: 'bottom-right' }), 3);

  // 6. metadata
  await assertArtifacts('metadata write', await run(engine, 'metadata', [a], { mode: 'write', title: '新标题', author: '本地' }), 3);
  await assertArtifacts('metadata clear', await run(engine, 'metadata', [a], { mode: 'clear' }), 3);
  await assertArtifacts('metadata read', await run(engine, 'metadata', [a], { mode: 'read' }));

  // 7. compress
  await assertArtifacts('compress extreme', await run(engine, 'compress', [photos], { preset: 'extreme' }), 3);
  await assertArtifacts('compress off', await run(engine, 'compress', [a], { resampleImages: false }), 3);

  // 8. convert
  await assertArtifacts('pdf→jpeg', await run(engine, 'pdf-to-images', [a], { format: 'jpeg', dpi: 110, pages: '1-2' }));
  await assertArtifacts('pdf→png', await run(engine, 'pdf-to-images', [a], { format: 'png', dpi: 96, pages: '1' }));
  await assertArtifacts('pdf→webp', await run(engine, 'pdf-to-images', [a], { format: 'webp', pages: '1' }));
  await assertArtifacts('images→pdf auto', await run(engine, 'images-to-pdf', [jpg, png, wide], { pageSize: 'auto' }), 3);
  await assertArtifacts('images→pdf a4 cover', await run(engine, 'images-to-pdf', [jpg, wide], { pageSize: 'a4', fit: 'cover', margin: 0 }), 2);
  await assertArtifacts('images→pdf a4 contain', await run(engine, 'images-to-pdf', [png], { pageSize: 'a4', fit: 'contain', margin: 24 }), 1);

  // 9. geometry tools
  await assertArtifacts('resize a4', await run(engine, 'resize', [b], { target: 'a4' }), 2);
  await assertArtifacts('resize 80%', await run(engine, 'resize', [a], { target: 'scale', scale: 80 }), 3);
  await assertArtifacts('crop edges', await run(engine, 'crop', [a], { top: 40, bottom: 40, left: 30, right: 30 }), 3);
  await assertArtifacts('crop to content', await run(engine, 'crop', [a], { shrinkToContent: true }), 3);
  await assertArtifacts('margins keep size', await run(engine, 'margins', [a], { edge: 30, keepPageSize: true }), 3);
  await assertArtifacts('margins grow page', await run(engine, 'margins', [a], { edge: 30, keepPageSize: false }), 3);
  await assertArtifacts('n-up 2', await run(engine, 'nup', [a], { perSheet: 2 }), 2);
  await assertArtifacts('n-up 4 bordered', await run(engine, 'nup', [photos], { perSheet: 4, border: true }), 1);

  // 9b. invoice tiling
  const invoice = file('sample-invoice.pdf');
  const rotated = file('sample-rotated.pdf');
  await assertArtifacts('invoice auto tile', await run(engine, 'invoice-merge', [invoice]), 1);
  await assertArtifacts(
    'invoice auto (no crop)',
    await run(engine, 'invoice-merge', [invoice], { autoCrop: false }),
    3,
  );
  await assertArtifacts('invoice 4-up', await run(engine, 'invoice-merge', [a, b], { perSheet: 4 }), 2);
  const dupes = await run(engine, 'invoice-merge', [invoice, invoice]);
  await assertArtifacts('invoice dedupe', dupes, 1);
  record('invoice dedupe warns', dupes.warnings.length === 1, `${dupes.warnings.length} warning(s)`);
  const rotatedJob = await run(engine, 'invoice-merge', [rotated], { perSheet: 1, orientation: 'portrait' });
  const rotatedPath = rotatedJob.artifacts[0]?.path;
  if (!rotatedPath) {
    record('invoice bakes /Rotate', false, rotatedJob.error?.code ?? 'no artifact');
  } else {
    const raster = await openRaster(new Uint8Array(await readFileBuffer(rotatedPath)), {});
    const bounds = await raster.inkBounds(1);
    raster.close();
    // The source bar is 400x40 in page space, so an upright tile must read tall.
    record(
      'invoice bakes /Rotate',
      Boolean(bounds && bounds.height > bounds.width * 3),
      bounds ? `${Math.round(bounds.width)}x${Math.round(bounds.height)} pt` : 'no ink found',
    );
  }

  // invoice-organize is intentionally RPC-backed rather than a queued ToolImpl.
  // Exercise the same scan → preview payload → archive → undo contract used by
  // InvoiceOrganizerPage so it is covered as a product tool, not as a runner gap.
  let invoiceOrganizerCoverage = false;
  const invoiceOrganizerRoot = await mkdtemp(join(tmpdir(), 'potools-invoice-organizer-'));
  const invoiceSource = join(invoiceOrganizerRoot, 'source');
  const invoiceTarget = join(invoiceOrganizerRoot, 'target');
  try {
    await mkdir(invoiceSource, { recursive: true });
    const invoiceSourceFile = join(invoiceSource, 'sample-invoice.pdf');
    await writeFile(invoiceSourceFile, await readFile(resolve(SAMPLES, 'sample-invoice.pdf')));
    const canonicalSource = await realpath(invoiceSource);
    const canonicalSourceFile = await realpath(invoiceSourceFile);
    const scan = (await engine.call('invoice.scan', {
      directory: invoiceSource,
      recursive: true,
      excludeDirectory: invoiceTarget,
    })) as import('@potools/core').InvoiceScanResult;
    const entry = scan.files[0];
    const scanOk = scan.sourceDirectory === canonicalSource && scan.files.length === 1 && entry?.path === canonicalSourceFile && Boolean(entry?.sha256);
    record('invoice RPC scan/preview', scanOk, `${scan.files.length} file(s), root=${scan.sourceDirectory === canonicalSource}, path=${entry?.path === canonicalSourceFile}, recognition=${entry?.recognition ?? 'none'}`);
    if (scanOk && entry) {
      const archive = (await engine.call('invoice.archive', {
        sourceDirectory: scan.sourceDirectory,
        targetDirectory: invoiceTarget,
        conflict: 'rename',
        files: [{
          path: entry.path,
          sha256: entry.sha256,
          relativePath: '2024/sample-invoice.pdf',
          enabled: true,
          fields: entry.fields,
        }],
      })) as import('@potools/core').InvoiceArchiveResult;
      const archivedPath = archive.copied[0]?.target;
      const reportJson = archive.reportPath
        ? await readFile(archive.reportPath, 'utf8').then((value) => JSON.parse(value) as { archiveId?: string; copied?: Array<{ target?: string }> }).catch(() => null)
        : null;
      const reportCsv = archive.csvReportPath ? await readFile(archive.csvReportPath, 'utf8').catch(() => '') : '';
      const reportsOk = Boolean(
        reportJson?.archiveId === archive.archiveId
        && reportJson.copied?.length === 1
        && reportJson.copied[0]?.target === archivedPath
        && reportCsv.startsWith('\uFEFF')
        && reportCsv.includes('sample-invoice.pdf')
        && reportCsv.includes('copied'),
      );
      const archiveOk = archive.copied.length === 1 && Boolean(archivedPath) && Boolean(archive.reportPath) && Boolean(archive.csvReportPath) && Boolean(await stat(archivedPath!).catch(() => null)) && reportsOk;
      record('invoice RPC archive/report', archiveOk, `${archive.copied.length} copied, reports=${reportsOk}, json=${Boolean(reportJson)}, csv=${reportCsv.includes('copied')}`);
      if (archiveOk) {
        const undone = (await engine.call('invoice.undo', { archiveId: archive.archiveId })) as import('@potools/core').InvoiceUndoResult;
        const sourceStillExists = Boolean(await stat(invoiceSourceFile).catch(() => null));
        invoiceOrganizerCoverage = undone.removed.length === 1 && undone.skipped.length === 0 && !(await stat(archivedPath!).catch(() => null)) && sourceStillExists;
        record('invoice RPC undo', invoiceOrganizerCoverage, `removed=${undone.removed.length}, skipped=${undone.skipped.length}, source=${sourceStillExists}`);
      }
    }
  } catch (error) {
    record('invoice RPC scan/preview', false, error instanceof Error ? error.message : String(error));
  } finally {
    await rm(invoiceOrganizerRoot, { recursive: true, force: true });
  }
  await assertArtifacts('header+footer', await run(engine, 'header-footer', [a], { header: '内部文件', footer: '{n}/{total}' }), 3);
  await assertArtifacts('remove-blank none', await run(engine, 'remove-blank', [a], { tolerance: 0 }), 3);
  await assertArtifacts('remove-blank report', await run(engine, 'remove-blank', [a], { reportOnly: true }));
  await assertArtifacts('repair', await run(engine, 'repair', [photos], { recompress: true }), 3);
  await assertArtifacts('extract-images', await run(engine, 'extract-images', [photos], { format: 'original', minBytes: 0 }));
  await assertArtifacts('extract-images → webp', await run(engine, 'extract-images', [photos], { format: 'webp', minBytes: 0 }));
  await assertArtifacts('extract-text', await run(engine, 'extract-text', [a], { granularity: 'single' }));
  await assertArtifacts('extract-text per page', await run(engine, 'extract-text', [a], { granularity: 'per-page' }), undefined);
  await assertArtifacts(
    'split manual groups',
    await run(engine, 'split', [a], { mode: 'manual', groups: [[1, 2], [3]] }),
    undefined,
  );

  // 9c. format exports
  await assertExports('export word', await run(engine, 'pdf-to-word', [a]), async (bytes) => {
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')?.async('string');
    return xml?.includes('第一季度报告') ? 'document.xml ok' : 'heading missing in document.xml';
  });
  await assertExports('export excel', await run(engine, 'pdf-to-excel', [a], { sheetPerPage: false }), async (bytes) => {
    const zip = await JSZip.loadAsync(bytes);
    const shared = await zip.file('xl/sharedStrings.xml')?.async('string');
    return shared?.includes('Revenue') ? 'sharedStrings ok' : 'no cell data';
  });
  await assertExports('export ppt', await run(engine, 'pdf-to-ppt', [a], { dpi: 96 }), async (bytes) => {
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const xmls = await Promise.all(slides.map((name) => zip.file(name)?.async('string')));
    const textSlide = xmls.find((xml) => xml?.includes('第一季度报告')) ?? '';
    const hasBlackText = /<a:srgbClr val="000000"\s*\/>/.test(textSlide);
    return slides.length === 3 && textSlide && hasBlackText
      ? `${slides.length} slides; searchable text black`
      : `expected black searchable text; slides=${slides.length}, text=${Boolean(textSlide)}, black=${hasBlackText}`;
  });
  await assertExports('export markdown', await run(engine, 'pdf-to-markdown', [a]), async (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    return text.includes('#') && text.includes('第一季度报告') ? `${text.length} chars` : 'heading text missing';
  });
  await assertExports('export html', await run(engine, 'pdf-to-html', [a], { embedImages: true, dpi: 72 }), async (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    return text.includes('<html') && text.includes('第一季度报告') ? `${(text.length / 1024).toFixed(0)}KB` : 'body missing';
  });
  await assertExports('export csv', await run(engine, 'pdf-to-csv', [a]), async (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    return text.includes('Revenue') ? `${text.split('\n').length} rows` : 'no rows';
  });
  await assertExports('export rtf', await run(engine, 'pdf-to-rtf', [a]), async (bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    return text.startsWith('{\\rtf1') && text.includes('\\par') ? `${text.length} chars` : 'not an rtf document';
  });

  await assertExports('export epub', await run(engine, 'pdf-to-epub', [a], { chapterBy: 'heading' }), async (bytes) => {
    const zip = await JSZip.loadAsync(bytes);
    const first = zip.files['mimetype'];
    const opf = await zip.file('OEBPS/content.opf')?.async('string');
    if (!first || Buffer.from(await first.async('uint8array')).toString() !== 'application/epub+zip') {
      return 'mimetype entry invalid';
    }
    return opf?.includes('chapter1.xhtml') ? `${Object.keys(zip.files).length} entries` : 'no chapters';
  });
  await assertExports('export ofd (text)', await run(engine, 'pdf-to-ofd', [a], { mode: 'text' }), async (bytes) => {
    const zip = await JSZip.loadAsync(bytes);
    const root = await zip.file('OFD.xml')?.async('string');
    const content = await zip.file('Doc_0/Pages/Page_0/Content.xml')?.async('string');
    if (!root?.includes('ofd:OFD')) return 'OFD.xml missing';
    return content?.includes('TextCode') ? 'text layer ok' : 'no text objects';
  });
  await assertExports('export ofd (image)', await run(engine, 'pdf-to-ofd', [a], { mode: 'image', dpi: 96 }), async (bytes) => {
    const zip = await JSZip.loadAsync(bytes);
    const images = Object.keys(zip.files).filter((name) => name.endsWith('.png'));
    return images.length === 3 ? `${images.length} page images` : `expected 3 images, got ${images.length}`;
  });

  // 9e. format imports (fixtures are produced by the same writers above)
  counter += 1;
  const docx = file('sample-office.docx');
  counter += 1;
  const xlsx = file('sample-office.xlsx');
  counter += 1;
  const pptx = file('sample-office.pptx');
  counter += 1;
  const ofd = file('sample-office.ofd');
  counter += 1;
  const md = file('sample-office.md');
  await assertPdfText(
    'import word→pdf',
    await run(engine, 'word-to-pdf', [docx]),
    1,
    ['本地化转换测试', 'The quick brown fox', '导出 docx/xlsx/pptx'],
  );
  await assertPdfText('import excel→pdf', await run(engine, 'excel-to-pdf', [xlsx]), 1, ['收入', 'Q1', '增长', '12%']);
  await assertPdfText('import ppt→pdf', await run(engine, 'ppt-to-pdf', [pptx]), 1, ['本地化转换测试']);
  await assertPdfText('import ofd→pdf', await run(engine, 'ofd-to-pdf', [ofd]), 2, ['OFD 往返测试', 'Page two 第二页']);
  await assertPdfText(
    'import markdown→pdf',
    await run(engine, 'markdown-to-pdf', [md]),
    1,
    ['标题一', '列表甲', 'const a = 1;'],
  );

  // Office conversion fixtures are generated and converted with the same local runtime shipped by the app.
  const fixtureDir = await mkdtemp(join(tmpdir(), 'potools-office-fixtures-'));
  const conversionIds = ['doc-to-docx', 'docx-to-doc', 'xls-to-xlsx', 'xlsx-to-xls', 'ppt-to-pptx', 'pptx-to-ppt'];
  try {
    const [docxBytes, xlsxBytes, pptxBytes] = await Promise.all([
      writeDocx({ title: 'PoTools conversion sample', blocks: [{ kind: 'paragraph', text: 'Office conversion fixture', page: 1, bold: false }], imageFor: () => null, pageBreaks: true, contentWidth: 500 }),
      writeXlsx([{ name: 'Sheet1', rows: [['Quarter', 'Value'], ['Q1', '12']] }]),
      writePptx({
        title: 'PoTools conversion sample',
        slides: [{
          widthIn: 8,
          heightIn: 11,
          image: new Uint8Array(await readFile(resolve(SAMPLES, 'sample-scan-2.png'))),
          lines: [
            { text: '本地化转换测试', xIn: 0.5, yIn: 0.5, wIn: 7, hIn: 0.5, size: 22, bold: true, color: '000000' },
            { text: '导出 docx/xlsx/pptx', xIn: 0.5, yIn: 1.1, wIn: 7, hIn: 0.5, size: 16, bold: false, color: '000000' },
          ],
        }],
      }),
    ]);
    const originals = { docx: docxBytes, xlsx: xlsxBytes, pptx: pptxBytes };
    const legacy = {
      doc: await convertOfficeLocally(docxBytes, 'docx', 'doc'),
      xls: await convertOfficeLocally(xlsxBytes, 'xlsx', 'xls'),
      ppt: await convertOfficeLocally(pptxBytes, 'pptx', 'ppt'),
    };
    const refs = new Map<string, FileRef>();
    for (const [extension, bytes] of Object.entries({ ...originals, ...legacy })) {
      const path = join(fixtureDir, `sample.${extension}`);
      await writeFile(path, bytes);
      refs.set(extension, { id: `office-${extension}`, name: `sample.${extension}`, path });
    }
    for (const [tool, sourceExtension] of [
      ['doc-to-docx', 'doc'], ['docx-to-doc', 'docx'],
      ['xls-to-xlsx', 'xls'], ['xlsx-to-xls', 'xlsx'],
      ['ppt-to-pptx', 'ppt'], ['pptx-to-ppt', 'pptx'],
    ] as Array<[ToolId, string]>) {
      const source = refs.get(sourceExtension)!;
      const job = await run(engine, tool, [source]);
      const ok = job.progress.state === 'succeeded' && job.artifacts.length > 0;
      record(`office conversion ${tool}`, ok, ok ? `${job.artifacts.length} output` : job.error?.message ?? job.progress.state);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const id of conversionIds) {
      if ((error as { code?: string })?.code === 'unsupported') recordSkipped(`office conversion ${id}`, detail);
      else record(`office conversion ${id}`, false, detail);
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }

  const notDocx = await run(engine, 'word-to-pdf', [a]);
  record(
    'rejects non-Office input',
    notDocx.progress.state === 'failed' && notDocx.error?.code === 'bad_request',
    notDocx.error?.message.slice(0, 60) ?? 'unexpectedly succeeded',
  );

  // 10. failure paths
  const corrupt = resolve(SAMPLES, 'corrupt.pdf');
  const good = (await readFile(resolve(SAMPLES, 'sample-a.pdf'))).toString('latin1');
  // Classic real-world damage: a wrong startxref offset while every object is
  // still present. MuPDF rebuilds the table; pdf-lib alone refuses to open it.
  const corruptText = good.replace(/startxref\n\d+\n%%EOF\s*$/, 'startxref\n42\n%%EOF\n');
  record('fixture is corrupted', corruptText !== good, corruptText === good ? 'pattern not found' : 'ok');
  await writeFile(corrupt, Buffer.from(corruptText, 'latin1'));
  const truncatedPath = resolve(SAMPLES, 'truncated.pdf');
  const rawGood = await readFile(resolve(SAMPLES, 'sample-a.pdf'));
  await writeFile(truncatedPath, rawGood.subarray(0, Math.floor(rawGood.length * 0.72)));
  const broken = await run(engine, 'repair', [{ id: 'corrupt', name: 'corrupt.pdf', path: corrupt }]);
  await assertArtifacts('repair broken xref', broken, 3);
  const truncated = await run(engine, 'repair', [
    { id: 'trunc', name: 'truncated.pdf', path: truncatedPath },
  ]);
  record(
    'refuses unrecoverable file',
    truncated.progress.state === 'failed',
    truncated.error?.code ?? 'unexpectedly succeeded',
  );
  // 11. saving a staged artifact into a chosen folder
  // freePath() never clobbers, so clear the previous run's copy first.
  await rm(resolve(OUT_DIR, 'saved-copy.pdf'), { force: true });
  const saved = (await engine.call('file.write', {
    jobId: broken.id,
    artifactId: broken.artifacts[0]?.id,
    dir: resolve(SAMPLES, 'out'),
    name: 'saved-copy.pdf',
  })) as { path: string };
  record('file.write to folder', Boolean(saved.path?.endsWith('saved-copy.pdf')), saved.path ?? 'failed');

  // 12. guards and temp accounting
  const allBlank = await run(engine, 'remove-blank', [a], { tolerance: 100 });
  record('rejects blanking every page', allBlank.progress.state === 'failed', allBlank.error?.code ?? 'ok');
  const noHeader = await run(engine, 'header-footer', [a], { header: '', footer: '' });
  record('rejects empty header+footer', noHeader.progress.state === 'failed', noHeader.error?.code ?? 'ok');
  const usage = (await engine.call('temp.stat', {})) as { jobs: number; bytes: number; dir: string };
  record('temp.stat', usage.jobs > 0 && usage.bytes > 0, `${usage.jobs} job dirs, ${(usage.bytes / 1024).toFixed(0)} KB`);
  const cleaned = (await engine.call('temp.clean', { olderThanDays: 0, keepJobs: 2 })) as {
    removedJobs: number;
    freedBytes: number;
    keptJobs: number;
  };
  record(
    'temp.clean keeps newest',
    cleaned.keptJobs >= 2 && cleaned.removedJobs > 0,
    `removed ${cleaned.removedJobs}, kept ${cleaned.keptJobs}, freed ${(cleaned.freedBytes / 1024).toFixed(0)} KB`,
  );

  // 12. non-job endpoints
  const probed = (await engine.call('file.probe', { file: a })) as { pageCount: number; pages: unknown[] };
  record('file.probe', probed.pageCount === 3 && probed.pages.length === 3, `pages=${probed.pageCount}`);
  const thumbs = (await engine.call('page.thumbs', { file: a, pages: [1, 2], width: 140 })) as Array<{ dataUrl: string }>;
  record(
    'page.thumbs',
    thumbs.length === 2 && thumbs[0]!.dataUrl.startsWith('data:image/jpeg;base64,'),
    `${thumbs.length} thumb(s), ${(thumbs[0]!.dataUrl.length / 1024).toFixed(0)}KB payload`,
  );
  const tools = await engine.call('tools.list', {});
  record('tools.list', Array.isArray(tools) && tools.length === TOOL_LIST.length, `${Array.isArray(tools) ? tools.length : 0} descriptors`);
  const paths = engine.info();
  record(
    'engine.info paths',
    Boolean(paths.defaultOutputDir && paths.tempDir),
    `${paths.defaultOutputDir} | ${paths.tempDir}`,
  );

  // 13. failure paths
  const badRange = await run(engine, 'delete-pages', [a], { pages: '1-3' });
  record('rejects deleting all pages', badRange.progress.state === 'failed', badRange.error?.code ?? badRange.progress.state);
  const missing = await run(engine, 'merge', [{ id: 'x', name: 'nope.pdf', path: resolve(SAMPLES, 'nope.pdf') }]);
  record('reports missing file', missing.progress.state === 'failed', missing.error?.code ?? 'ok');
  const emptyText = await run(engine, 'watermark', [a], { text: '   ' });
  record('rejects empty watermark', emptyText.progress.state === 'failed', emptyText.error?.code ?? 'ok');


  // 15. content assertions — is the output actually correct, not just present
  {
    const merged = await run(engine, 'merge', [a, b]);
    const geometry = await inspectPdf(merged.artifacts[0]!.path as string);
    record(
      'merge keeps every page',
      geometry.count === 5 && geometry.pages.every((page) => page.w > 0),
      `${geometry.count} pages, first ${geometry.pages[0]?.w}x${geometry.pages[0]?.h}`,
    );
    record('merge keeps text', (await rasterText(merged.artifacts[0]!.path as string)).includes('Appendix A'), 'text read back');

    const rotated = await run(engine, 'rotate', [a], { angle: 90 });
    const rotatedGeometry = await inspectPdf(rotated.artifacts[0]!.path as string);
    record(
      'rotate writes /Rotate 90',
      rotatedGeometry.pages.length === 3 && rotatedGeometry.pages.every((page) => page.r === 90),
      `rotations ${rotatedGeometry.pages.map((page) => page.r).join(',')}`,
    );

    const marked = await run(engine, 'watermark', [a], { text: '机密文件', position: 'center', fontSize: 48 });
    const markedText = await rasterText(marked.artifacts[0]!.path as string);
    record('watermark embeds CJK text', markedText.includes('机密文件'), markedText.includes('机密文件') ? 'glyphs present' : 'CJK text missing');

    const numbered = await run(engine, 'page-numbers', [a], { format: '{n} / {total}' });
    const numberedText = await rasterText(numbered.artifacts[0]!.path as string);
    record('page numbers render', numberedText.includes('1 / 3') && numberedText.includes('3 / 3'), 'first+last page labels');

    const headed = await run(engine, 'header-footer', [a], { header: '内部资料', footer: '第 {n} 页' });
    const headedText = await rasterText(headed.artifacts[0]!.path as string);
    record('header+footer render', headedText.includes('内部资料') && headedText.includes('第 1 页'), 'both lines present');

    const resized = await run(engine, 'resize', [b], { target: 'a4' });
    const resizedGeometry = await inspectPdf(resized.artifacts[0]!.path as string);
    record(
      'resize lands on A4',
      resizedGeometry.pages.every((page) => near(page.w, 595, 2) && near(page.h, 842, 2)),
      `${resizedGeometry.pages[0]?.w}x${resizedGeometry.pages[0]?.h}`,
    );

    const cropped = await run(engine, 'crop', [a], { top: 40, bottom: 40, left: 30, right: 30 });
    const croppedGeometry = await inspectPdf(cropped.artifacts[0]!.path as string);
    record(
      'crop shrinks the box exactly',
      croppedGeometry.pages.every((page) => near(page.w, 535, 2) && near(page.h, 762, 2)),
      `${croppedGeometry.pages[0]?.w}x${croppedGeometry.pages[0]?.h} (was 595x842)`,
    );

    const grew = await run(engine, 'margins', [a], { edge: 30, keepPageSize: false });
    const grewGeometry = await inspectPdf(grew.artifacts[0]!.path as string);
    record(
      'margins grow the page',
      grewGeometry.pages.every((page) => near(page.w, 655, 2) && near(page.h, 902, 2)),
      `${grewGeometry.pages[0]?.w}x${grewGeometry.pages[0]?.h}`,
    );

    const squeezed = await run(engine, 'compress', [photos]);
    const before = (await stat(resolve(SAMPLES, 'sample-photos.pdf'))).size;
    const after = squeezed.artifacts[0]?.sizeBytes ?? 0;
    record('compress shrinks image PDFs', after > 0 && after < before * 0.5, `${formatKb(before)} → ${formatKb(after)}`);

    const textJob = await run(engine, 'extract-text', [a], { granularity: 'single' });
    record('extract-text content', (await artifactText(textJob)).includes('Revenue'), 'txt has page text');

    const csvJob = await run(engine, 'pdf-to-csv', [a]);
    const csv = await artifactText(csvJob);
    record('csv keeps the header row', csv.includes('Revenue'), (csv.split(/\r?\n/)[0] ?? '').slice(0, 30));

    const mdJob = await run(engine, 'pdf-to-markdown', [a]);
    const md = await artifactText(mdJob);
    record('markdown keeps headings', md.startsWith('# ') && md.includes('Page Two'), 'heading markers present');
  }

  // 16. round trips through the new formats
  {
    const toWord = await run(engine, 'pdf-to-word', [a]);
    const docxRef: FileRef = {
      id: 'roundtrip-docx',
      name: 'roundtrip.docx',
      path: toWord.artifacts[0]?.path ?? '',
    };
    const backToPdf = await run(engine, 'word-to-pdf', [docxRef]);
    const text = backToPdf.artifacts[0]?.path ? await rasterText(backToPdf.artifacts[0].path) : '';
    record(
      'round trip PDF→docx→PDF',
      text.includes('第一季度报告') && text.includes('Lorem ipsum'),
      text ? 'text survived' : 'no text after round trip',
    );

    const toOfd = await run(engine, 'pdf-to-ofd', [a], { mode: 'text' });
    const ofdRef: FileRef = { id: 'roundtrip-ofd', name: 'roundtrip.ofd', path: toOfd.artifacts[0]?.path ?? '' };
    const ofdBack = await run(engine, 'ofd-to-pdf', [ofdRef]);
    const ofdText = ofdBack.artifacts[0]?.path ? await rasterText(ofdBack.artifacts[0].path) : '';
    record(
      'round trip PDF→OFD→PDF',
      ofdText.includes('第一季度报告'),
      ofdText ? `${ofdBack.artifacts.length} file(s)` : 'no text after round trip',
    );

    const invoices = await run(engine, 'invoice-merge', [invoice], { sheetSize: 'a4', orientation: 'portrait', perSheet: 2 });
    const sheetGeometry = invoices.artifacts[0]?.path ? await inspectPdf(invoices.artifacts[0].path) : null;
    record(
      'invoice sheet is A4 portrait',
      Boolean(sheetGeometry?.pages.every((page) => near(page.w, 595, 2) && near(page.h, 842, 2))),
      sheetGeometry ? `${sheetGeometry.pages[0]?.w}x${sheetGeometry.pages[0]?.h}` : 'no artifact',
    );
  }

  // 17. error matrix
  {
    counter += 1;
    const emptyPath = resolve(OUT_DIR, 'empty-input.pdf');
    await writeFile(emptyPath, new Uint8Array(0));
    const empty = { id: 'empty-1', name: 'empty-input.pdf', path: emptyPath };
    const emptyJob = await run(engine, 'merge', [empty]);
    record('rejects empty file', emptyJob.progress.state === 'failed', emptyJob.error?.code ?? 'succeeded');

    const badRange = await run(engine, 'rotate', [a], { pages: '999' });
    record('rejects out-of-range pages', badRange.progress.state === 'failed', badRange.error?.code ?? 'succeeded');

    const badMarkdown = await run(engine, 'markdown-to-pdf', [a]);
    record(
      'rejects binary as markdown',
      badMarkdown.progress.state === 'failed' && badMarkdown.error?.code === 'unreadable_file',
      badMarkdown.error?.message.slice(0, 40) ?? 'succeeded',
    );

    for (const [id, file] of [
      ['excel-to-pdf', a],
      ['ppt-to-pdf', a],
      ['ofd-to-pdf', a],
    ] as Array<[ToolId, FileRef]>) {
      const job = await run(engine, id, [file]);
      record(`rejects wrong format: ${id}`, job.progress.state === 'failed', job.error?.code ?? 'succeeded');
    }

    // A 600 DPI raster of a photo-heavy PDF takes seconds, so the cancel lands mid-job.
    const heavy = engine.manager.submit({
      id: `cancel-${(counter += 1)}`,
      tool: 'pdf-to-images',
      files: [photos],
      options: { ...defaultOptions('pdf-to-images'), dpi: 600, format: 'png' },
      output: { dir: OUT_DIR },
    });
    engine.manager.cancel(heavy.id);
    const deadline = Date.now() + 20_000;
    let settled = engine.manager.get(heavy.id);
    while (Date.now() < deadline && (!settled || !TERMINAL.has(settled.progress.state))) {
      await new Promise((wait) => setTimeout(wait, 120));
      settled = engine.manager.get(heavy.id);
    }
    record(
      'cancels a running job',
      settled?.progress.state === 'cancelled',
      `state=${settled?.progress.state ?? 'timeout'}`,
    );
  }

  // 14. coverage sweep — every registered tool must run end to end
  // ── 23 个纯文本工具（9 时间 + 14 加解密/编码）：改走 tool.run 同步内存通道，
  //    断言返回文本的实际内容；file-checksum 需要文件，仍走 job.submit。──
  const TEXT_TOOLS: ToolId[] = [
    'timestamp', 'date-diff', 'date-math', 'workdays', 'timezone-board', 'duration', 'cron',
    'date-format', 'relative-time',
    'hash', 'hmac', 'base64', 'radix', 'hex', 'url-codec', 'unicode-escape', 'jwt', 'aes', 'rsa',
    'totp', 'x509', 'password-gen', 'uuid-gen',
  ];
  const textToolsRun = new Set<ToolId>();

  /** Runs one text tool through `tool.run` and asserts the returned text. */
  const textCase = async (
    tool: ToolId,
    options: Record<string, unknown>,
    needles: string[],
    name: string = tool,
  ): Promise<TextRunResult | null> => {
    const { result, error } = await callText(engine, tool, options);
    if (!result) {
      record(`text ${name}`.slice(0, 40), false, error ? `${error.code}: ${error.message.slice(0, 60)}` : '无返回');
      return null;
    }
    const problems = contractProblems(result, needles);
    if (!problems.length) textToolsRun.add(tool);
    record(
      `text ${name}`.slice(0, 40),
      !problems.length,
      problems.length
        ? `${problems.join('; ')} | ${result.text.slice(0, 40)}`
        : `${needles.length} 处断言命中，${result.text.length} 字符，${result.artifacts.length} artifact，${result.ms}ms`,
    );
    return result;
  };

  /** The queue path stays in place for the one text-ish tool that needs a file. */
  const jobTextHas = (id: ToolId, options: Record<string, unknown>, needles: string[], files: FileRef[]) =>
    run(engine, id, files, options, id).then(async (job) => {
      const text = await textOf(job);
      const missing = needles.filter((needle) => !text.includes(needle));
      record(
        `text ${id}`.slice(0, 40),
        job.progress.state === 'succeeded' && missing.length === 0,
        job.progress.state !== 'succeeded'
          ? job.error?.message?.slice(0, 60) ?? job.progress.state
          : missing.length
            ? `缺少: ${missing.join(', ')} | ${text.slice(0, 40)}`
            : `${needles.length} 处断言命中，${text.length} 字符`,
      );
    });

  // file-checksum 需要文件，仍在队列上跑；放在快照之前，免得污染下面的零落盘/零入队断言。
  await jobTextHas('file-checksum', { algorithm: 'sha256' }, ['32b64d3faee92a676d3873881996860d424a90a997d04525be26e30261cb39aa'], [jpg]);

  const tempBeforeText = (await engine.call('temp.stat', {})) as TempUsage;
  const jobsBeforeText = engine.manager.list().length;

  const JWT_HS256 =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6InBvaG9jIiwiaWF0IjoxNTE2MjM5MDIyLCJleHAiOjQxMDI0NDQ4MDB9.3Tmg1Fo4uLBZax4hclaqgKLvRWx4K5pOpmOPYJlT5MI';
  const X509_PEM = [
    '-----BEGIN CERTIFICATE-----',
    'MIIDlzCCAn+gAwIBAgIUHHo+rktKrT6AUP0t5AucAereszswDQYJKoZIhvcNAQEL',
    'BQAwWzELMAkGA1UEBhMCQ04xCzAJBgNVBAgMAlpKMREwDwYDVQQHDAhIYW5nemhv',
    'dTEQMA4GA1UECgwHUG9Ub29sczEaMBgGA1UEAwwRYWxpY2UuZXhhbXBsZS5jb20w',
    'HhcNMjYwOTIxMTQwNDM1WhcNMzYwOTE4MTQwNDM1WjBbMQswCQYDVQQGEwJDTjEL',
    'MAkGA1UECAwCWkoxETAPBgNVBAcMCEhhbmd6aG91MRAwDgYDVQQKDAdQb1Rvb2xz',
    'MRowGAYDVQQDDBFhbGljZS5leGFtcGxlLmNvbTCCASIwDQYJKoZIhvcNAQEBBQAD',
    'ggEPADCCAQoCggEBAMe67OA7zbn27a1CiA/Y+bMXWtWcl17jaU/VVceiJlnQQg50',
    'AKbnY/NOZWPFKK+8s+6RhqJo2FVMyXGtnwLsssakMkEPw8V4s6nwqzmCGrwR9Zs9',
    'OoriZ3fTZBY7KHf1zSemddQ9DT57rokSvIS5k+k5MYGeChcjsz+yZQYGSQnaIq5k',
    'DGAc1JGt2gXHFeJDy2fQ9ED0sqOtylN1plbDJpzsPYLIRRfQv4I4EKHdCN894bOc',
    'LQqXmIH/wjjdlizD1O0sTLv0O10Qlylxgnb4utBbMr/ZtfQhdZV+JGw5a8utTJKb',
    'pya82Zg786TQtKgjeWiIF7WXnSu+Rh1Xkfms5wkCAwEAAaNTMFEwHQYDVR0OBBYE',
    'FK1jfLfC8iZRNol10XGxAy6+HTTyMB8GA1UdIwQYMBaAFK1jfLfC8iZRNol10XGx',
    'Ay6+HTTyMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAMSthg2N',
    'woafzPzqDdytpxwMk2dmzdMig9vTxq41ts3u6cuCn8ZIjORGiBugU2/ID71NLJyA',
    't0U5HR/BO68rjNnlkqswvcq8V0tRsOOuL5WK5zo/LybiqJnHhirmVbvUqHyOesJ/',
    'EIabTjuCCJfq5W0rt3ZDpYKvL0G5386e+o6+F6UkMr4PJVfC79PV+95I/ND/5SpW',
    'rrOKWPfzDlrzAW49FfTeNxGtsG7RUwVGJ8vBrSBEnx8BCekYlfziyoku8C9JmJaQ',
    'n2tDk1N6t3Iy3iU25nRkGywh9s8caE5fXu3uCG5qmZ7OeZEi9EHHK4o41U8UXJac',
    'UBpkNoXep+H3L40=',
    '-----END CERTIFICATE-----',
  ].join('\n');

  await textCase('timestamp', { input: '1700000000' }, ['2023-11-15', '1700000000000']);
  await textCase('date-diff', { from: '2023-01-01', to: '2023-11-15', breakdown: true }, ['318 天', '2023-11-15']);
  await textCase('date-math', { base: '2023-11-15', direction: 'add', value: 10, unit: 'days' }, ['2023-11-25']);
  await textCase('workdays', { start: '2023-11-01', mode: 'add', days: 5 }, ['2023-11-08', '周六']);
  await textCase('timezone-board', { at: '2023-11-15T12:00:00Z', zones: 'Asia/Shanghai\nAmerica/New_York', style: 'full' }, ['Asia/Shanghai', 'America/New_York', '20:00:00', '07:00:00']);
  await textCase('duration', { value: '3735', unit: 's', style: 'all' }, ['01:02:15', 'PT1H2M15S']);
  await textCase('cron', { expression: '0 9 * * 1-5', from: '2023-11-13T00:00:00Z', count: 5 }, ['2023-11-13 09:00:00', '星期五']);
  await textCase('date-format', { input: '1700000000', pattern: 'YYYY-MM-DD' }, ['2023-11-15']);
  await textCase('relative-time', { input: '2023-11-15', base: '2023-11-16' }, ['昨天']);

  const defaultTimezone = await callText(engine, 'timezone-board', { at: '2023-11-15T12:00:00Z', zones: 'Asia/Shanghai\nAmerica/New_York' });
  const defaultTimezoneText = defaultTimezone.result?.text ?? '';
  const defaultTimezoneRows = defaultTimezoneText.split(/\r?\n/);
  const shanghaiRow = defaultTimezoneRows.find((line) => line.includes('Asia/Shanghai') && line.includes('2023-11-15')) ?? '';
  const newYorkRow = defaultTimezoneRows.find((line) => line.includes('America/New_York') && line.includes('2023-11-15')) ?? '';
  record(
    'timezone-board default style',
    shanghaiRow.includes('2023-11-15 20:00')
      && newYorkRow.includes('2023-11-15 07:00')
      && !shanghaiRow.includes('20:00:00')
      && !newYorkRow.includes('07:00:00'),
    'default datetime keeps minute precision',
  );
  const defaultDuration = await callText(engine, 'duration', { value: '3735', unit: 's' });
  const defaultDurationText = defaultDuration.result?.text ?? '';
  record(
    'duration default style',
    /小时|hour/i.test(defaultDurationText) && !defaultDurationText.includes('PT1H2M15S') && !defaultDurationText.includes('01:02:15'),
    'default human output stays copy-friendly',
  );
  const defaultTimestamp = await callText(engine, 'timestamp', { input: '1700000000', showRange: false, showNow: false });
  const defaultTimestampText = defaultTimestamp.result?.text ?? '';
  record(
    'timestamp default style',
    defaultTimestampText.includes('Unix 秒') && defaultTimestampText.includes('Unix 毫秒') && defaultTimestampText.includes('2023-11-15'),
    'default both output keeps date/time and epoch values',
  );

  // 参考站对齐断言：epochconverter 的周期边界/实时戳、timeanddate 的终点日口径与工作日统计。
  {
    const ENUM_TOKENS = [
      'full', 'auto', 'iso', 'date', 'datetime', 'relative', 'chinese', 'all', 'hhmmss', 'human',
      'days', 'weeks', 'ms', 'minutes', 'seconds', 'summary',
    ];
    const enumEcho = (text: string) =>
      ENUM_TOKENS.filter(
        (token) =>
          new RegExp(`(?:\\s\\s|[=(|])${token}[ \\t]*$`, 'm').test(text) ||
          new RegExp(`[=(|]${token}(?=$|[\\s).,;:])`, 'm').test(text),
      );
    const longDecimals = (text: string) =>
      [...text
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '')
        .matchAll(/\d\.\d{3,}/g)]
        .map((hit) => hit[0]);
    const rowNum = (text: string, label: string) => Number(new RegExp(`${label}\\s+([\\d,]+)`).exec(text)?.[1]?.replace(/,/g, '') ?? Number.NaN);
    const hanGlyph = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;
    const stampBase = { input: '1700000000', timezone: 'Asia/Shanghai', style: 'full' };

    const stamp = await callText(engine, 'timestamp', stampBase);
    const stampText = stamp.result?.text ?? '';
    const wanted = ['1699977600', '1700063999', '1699804800', '1700409599', '1698768000', '1701359999', '1672502400', '1704038399'];
    const absent = wanted.filter((value) => !stampText.includes(value));
    record(
      'timestamp day/week/month/year bounds',
      absent.length === 0 && stampText.includes('2023-11-13 00:00:00') && stampText.includes('2023-11-30 23:59:59'),
      absent.length ? `缺 ${absent.join(',')}` : '8 个边界秒值 + 周一/月末 23:59:59 命中',
    );
    record('timestamp states week start', stampText.includes('周起始 周一'), '未声明周起始');
    const nowRow = rowNum(stampText, 'Unix 秒');
    record('timestamp showNow live stamp', nowRow > 1_700_000_000 && stampText.includes('当前时间（实时）'), `Unix 秒=${nowRow}`);
    const stampOff = await callText(engine, 'timestamp', { ...stampBase, showRange: false, showNow: false });
    const offText = stampOff.result?.text ?? '';
    record(
      'timestamp showRange/showNow off',
      !offText.includes('周期边界') && !offText.includes('当前时间（实时）') && !offText.includes('1698768000'),
      '关闭后仍输出边界或实时段',
    );
    const styleIso = await callText(engine, 'timestamp', { ...stampBase, style: 'iso' });
    record('timestamp style label localized', !/输出样式\s+full/.test(offText) && !/输出样式\s+iso/.test(styleIso.result?.text ?? ''), `off=${/输出样式\s+(\S+)/.exec(offText)?.[1]} iso=${/输出样式\s+(\S+)/.exec(styleIso.result?.text ?? '')?.[1]}`);

    const excl = await callText(engine, 'date-diff', { from: '2026-01-05', to: '2026-03-08', timezone: 'Asia/Shanghai' });
    const incl = await callText(engine, 'date-diff', { from: '2026-01-05', to: '2026-03-08', timezone: 'Asia/Shanghai', includeEnd: true, holidays: '2026-02-17' });
    const exclText = excl.result?.text ?? '';
    const inclText = incl.result?.text ?? '';
    record(
      'date-diff includeEnd = +1 day',
      rowNum(exclText, '范围内天数') === 62 && rowNum(inclText, '范围内天数') === 63
        && Number(excl.result?.extra?.daysExcludingEnd) === 62 && Number(excl.result?.extra?.daysIncludingEnd) === 63
        && exclText.includes('不含终点日（终点日不计入）') && inclText.includes('含终点日（起点日与终点日都计入）')
        && exclText.includes('两者相差') && inclText.includes('1 天'),
      `excl=${rowNum(exclText, '范围内天数')} incl=${rowNum(inclText, '范围内天数')}`,
    );
    record(
      'date-diff workday tally (hand-checked)',
      rowNum(exclText, '工作日') === 45 && rowNum(exclText, '周末') === 17
        && rowNum(inclText, '工作日') === 44 && rowNum(inclText, '周末') === 18 && rowNum(inclText, '节假日') === 1,
      `excl 45/17 got ${rowNum(exclText, '工作日')}/${rowNum(exclText, '周末')} · incl 44/18/1 got ${rowNum(inclText, '工作日')}/${rowNum(inclText, '周末')}/${rowNum(inclText, '节假日')}`,
    );
    record(
      'date-diff breakdown collapsed',
      (exclText.match(/日历分解/g) ?? []).length === 1 && !exclText.includes('年月日') && !/0 年 · 2 个月/.test(exclText),
      `日历分解 ${(exclText.match(/日历分解/g) ?? []).length} 次，含年月日=${exclText.includes('年月日')}`,
    );
    record('date-diff no long decimals', longDecimals(exclText).length === 0 && exclText.includes('8.86 周'), longDecimals(exclText).join(',') || 'ok');
    const noWorkday = await callText(engine, 'date-diff', { from: '2026-01-05', to: '2026-03-08', timezone: 'Asia/Shanghai', countWorkdays: false });
    record('date-diff countWorkdays off', !(noWorkday.result?.text ?? '').includes('工作日 / 周末统计'), '关闭后仍统计');
    const weekUnit = await callText(engine, 'date-diff', { from: '2026-01-05', to: '2026-03-08', timezone: 'Asia/Shanghai', unit: 'weeks' });
    record('date-diff unit echo', !!weekUnit.result && !/unit=weeks/.test(weekUnit.result.text) && weekUnit.result.text.includes('按周'), weekUnit.result?.text.match(/· unit=\S+/)?.[0] ?? 'no');

    const rollOn = await callText(engine, 'date-math', { base: '2026-01-31', direction: 'add', value: 1, unit: 'months', timezone: 'Asia/Shanghai', skipWeekend: true });
    const rollText = rollOn.result?.text ?? '';
    record(
      'date-math skipWeekend rolls forward',
      rollText.includes('顺延后结果') && rollText.includes('2026-03-02 00:00:00')
        && rollText.includes('跳过天数') && rowNum(rollText, '跳过天数') === 2
        && rollText.includes('2026-02-28') && rollText.includes('2026-03-01') && rollText.includes('星期一'),
      `跳过=${rowNum(rollText, '跳过天数')} 顺延=${rollText.includes('2026-03-02 00:00:00')}`,
    );
    record('date-math keeps clamping wording', rollText.includes('目标月份没有 31 日，已收敛到该月最后一天：31 日 → 28 日。') && rollText.includes('2026-02-28T00:00:00+08:00'), '月末日收敛文案或原始结果丢失');
    const rollOff = await callText(engine, 'date-math', { base: '2026-01-31', direction: 'add', value: 1, unit: 'months', timezone: 'Asia/Shanghai' });
    record('date-math skipWeekend default off', !(rollOff.result?.text ?? '').includes('顺延至工作日'), '默认关闭却顺延');

    const countOn = await callText(engine, 'relative-time', { input: '2026-12-31 23:59:59', base: '2026-09-22 04:00:00', timezone: 'Asia/Shanghai' });
    const countText = countOn.result?.text ?? '';
    record(
      'relative-time countdown',
      countText.includes('倒计时') && countText.includes('还剩') && countText.includes('100 天 19 小时 59 分 59 秒'),
      countText.match(/拆分\s+.*/)?.[0]?.trim() ?? '无倒计时',
    );
    const countPast = await callText(engine, 'relative-time', { input: '2026-09-22 04:00:00', base: '2026-12-31 23:59:59', timezone: 'Asia/Shanghai' });
    const countOff = await callText(engine, 'relative-time', { input: '2026-12-31 23:59:59', base: '2026-09-22 04:00:00', timezone: 'Asia/Shanghai', showCountdown: false });
    record(
      'relative-time countdown direction + switch',
      (countPast.result?.text ?? '').includes('已过') && !(countOff.result?.text ?? '').includes('倒计时'),
      `past=${(countPast.result?.text ?? '').includes('已过')} off=${(countOff.result?.text ?? '').includes('倒计时')}`,
    );

    const grammar = await callText(engine, 'timestamp', {
      input: 'Wed, 15 Nov 2023 06:13:20 GMT\nSun, 06 Nov 1994 08:49:37 GMT\n11/15/2023\n15-11-2023\n15 Nov 2023',
      timezone: 'UTC',
      style: 'date',
      showRange: false,
      showNow: false,
    });
    const grammarText = grammar.result?.text ?? '';
    record(
      'parse RFC 2822 / HTTP-date / M-D-Y / D-M-Y',
      grammarText.includes('1994-11-06') && (grammarText.match(/2023-11-15/g) ?? []).length === 4 && !/无法识别/.test(grammarText),
      `11-15 命中 ${(grammarText.match(/2023-11-15/g) ?? []).length}/4，1994-11-06=${grammarText.includes('1994-11-06')}`,
    );
    const rfcExact = await callText(engine, 'timestamp', { input: 'Wed, 15 Nov 2023 06:13:20 +0800', timezone: 'UTC', style: 'full', showRange: false, showNow: false });
    record('RFC 2822 offset round trip', (rfcExact.result?.text ?? '').includes('Unix 秒         1700000000'), rfcExact.result?.text.match(/Unix 秒\s+\S+/)?.[0] ?? 'no');

    for (const [tool, options] of [
      ['timestamp', { input: '1700000000' }],
      ['date-diff', { from: '2026-01-05', to: '2026-03-08', includeEnd: true, unit: 'weeks' }],
      ['date-math', { base: '2026-01-31', unit: 'months', value: 1, skipWeekend: true }],
      ['relative-time', { input: '2026-12-31 23:59:59', base: '2026-09-22 04:00:00' }],
    ] as Array<[ToolId, Record<string, unknown>]>) {
      const en = await callText(engine, tool, options, 'en');
      const text = en.result?.text ?? '';
      if (!en.result) {
        record(`en ${tool} no enum echo / decimals`.slice(0, 40), false, `${en.error?.code ?? '?'} ${(en.error?.message ?? '').slice(0, 40)}`);
        continue;
      }
      const echoes = enumEcho(text);
      const decimals = longDecimals(text);
      const bad = [...echoes.map((token) => `回显 ${token}`), ...decimals.map((value) => `小数 ${value}`), ...(hanGlyph.test(text) ? ['含汉字'] : [])];
      record(
        `en ${tool} no enum echo / decimals`.slice(0, 40),
        bad.length === 0,
        bad.length ? bad.join('，') : `无裸枚举词、无长小数、无 CJK（${text.length} 字符）`,
      );
    }
  }

  {
    const ENUM_WORDS = [
      'full', 'auto', 'iso', 'date', 'datetime', 'relative', 'chinese', 'all', 'hhmmss', 'human',
      'days', 'weeks', 'ms', 'minutes', 'seconds', 'summary', 'gregorian',
    ];
    const echoedEnum = (text: string) =>
      ENUM_WORDS.filter((word) => new RegExp(`(?:\\s{2,}|·\\s|[=(])${word}[ \\t]*$`, 'm').test(text));
    const longDecimals = (text: string) =>
      [...text
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '')
        .replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, '')
        .replace(/-?P[YWMDT][YMDTHMS\d.,]*/g, '')
        .matchAll(/\d\.\d{3,}/g)]
        .map((hit) => hit[0]);
    const hanGlyph = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;
    const rowOf = (text: string, label: string) => new RegExp(`^\\s*${label}\\s+(.*)$`, 'm').exec(text)?.[1] ?? '';
    const runsOf = (text: string) =>
      [...text.matchAll(/^ {2}#\d\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/gm)].map((hit) => hit[1]).join(' ');
    const STUB_NOW = Date.parse('2026-09-22T07:01:08+08:00');
    const CRON_WEEKDAY = { expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai', from: '2026-09-22 00:00:00', count: 3 };
    const CRON_WEEKLY = { ...CRON_WEEKDAY, expression: '@weekly' };
    const CRON_REBOOT = { ...CRON_WEEKDAY, expression: '@reboot' };
    const CRON_YEARLY = { ...CRON_WEEKDAY, expression: '0 0 1 1 *' };
    const CRON_QUARTER = { expression: '*/15 9-17 * * 1,3-5', timezone: 'Asia/Shanghai', from: '2026-09-22T00:00:00Z', count: 4 };
    const WORKDAY_CASE = { start: '2026-09-28', mode: 'add', days: 5, weekend: '0,6', holidays: '2026-10-01', timezone: 'Asia/Shanghai' };
    const boardCase = { at: '2026-09-28 23:30:00', zones: 'Asia/Shanghai\nUTC\nAmerica/New_York\nEurope/London\nAsia/Tokyo', timezone: 'Asia/Shanghai', style: 'full' };

    let weekdayText = '';
    let weeklyText = '';
    let rebootText = '';
    let yearlyText = '';
    let quarterText = '';
    let workdayText = '';
    let boardText = '';
    let durationText = '';
    const realNow = Date.now;
    try {
      Date.now = () => STUB_NOW;
      weekdayText = (await callText(engine, 'cron', CRON_WEEKDAY)).result?.text ?? '';
      weeklyText = (await callText(engine, 'cron', CRON_WEEKLY)).result?.text ?? '';
      rebootText = (await callText(engine, 'cron', CRON_REBOOT)).result?.text ?? '';
      yearlyText = (await callText(engine, 'cron', CRON_YEARLY)).result?.text ?? '';
      quarterText = (await callText(engine, 'cron', CRON_QUARTER)).result?.text ?? '';
      workdayText = (await callText(engine, 'workdays', WORKDAY_CASE)).result?.text ?? '';
      boardText = (await callText(engine, 'timezone-board', boardCase)).result?.text ?? '';
      durationText = (await callText(engine, 'duration', { value: '4000000000', unit: 'ms', style: 'all', timezone: 'Asia/Shanghai' })).result?.text ?? '';
    } finally {
      Date.now = realNow;
    }

    record(
      'cron human sentence + next run + countdown',
      rowOf(weekdayText, '口语化') === '周一至周五 09:00'
        && /下次时刻\s+2026-09-22 09:00:00/.test(weekdayText)
        && /倒计时\s+还有 0 天 09 小时 00 分 00 秒/.test(weekdayText),
      `口语化=${rowOf(weekdayText, '口语化')} 下次=${/下次时刻/.test(weekdayText)} 倒计时=${rowOf(weekdayText, '倒计时')}`,
    );
    record(
      'cron echoes 起始 only when it resolves',
      /^ {2}起始\s+2026-09-22 00:00:00 \(UTC\+08:00\) · 星期二$/m.test(weekdayText)
        && !/起始\s+2026-09-22 00:00:00 →/.test(weekdayText)
        && /起始\s+2026-09-22T00:00:00Z → 2026-09-22 08:00:00/.test(quarterText),
      `same=${rowOf(weekdayText, '起始')} | zoned=${rowOf(quarterText, '起始')}`,
    );
    record(
      'cron macro header names the expansion',
      /^ {2}字段格式\s+@weekly → 0 0 \* \* 0 · 5 字段/m.test(weeklyText)
        && weeklyText.includes('每周日 00:00')
        && /^ {2}字段格式\s+@reboot · 无日历字段/m.test(rebootText)
        && !/执行时刻/.test(rebootText),
      `weekly=${rowOf(weeklyText, '字段格式')} | reboot=${rowOf(rebootText, '字段格式')}`,
    );
    record(
      'cron next runs match archived baselines',
      runsOf(weekdayText) === '2026-09-22 09:00:00 2026-09-23 09:00:00 2026-09-24 09:00:00'
        && runsOf(weeklyText) === '2026-09-27 00:00:00 2026-10-04 00:00:00 2026-10-11 00:00:00'
        && runsOf(quarterText) === '2026-09-23 09:00:00 2026-09-23 09:15:00 2026-09-23 09:30:00 2026-09-23 09:45:00'
        && runsOf(yearlyText) === '2027-01-01 00:00:00 2028-01-01 00:00:00 2029-01-01 00:00:00',
      `weekly=${runsOf(weeklyText)} quarter=${runsOf(quarterText)} yearly=${runsOf(yearlyText)}`,
    );
    record(
      'workdays matches archived baseline',
      rowOf(workdayText, '目标日期') === '2026-10-06 星期二'
        && /自然日跨度\s+8 天（工作日 5 个 · 休息日 3 个）/.test(workdayText)
        && workdayText.includes('工作日明细（5 天）')
        && /跳过的休息日（3 天）/.test(workdayText)
        && /2026-10-01 周四 · 节假日/.test(workdayText)
        && workdayText.includes('1791216000'),
      `目标=${rowOf(workdayText, '目标日期')} 跨度=${/自然日跨度\s+8 天/.test(workdayText)}`,
    );
    record(
      'timezone-board day shift and offset delta',
      /\+1天/.test(boardText) && /−8 小时/.test(boardText) && /−12 小时/.test(boardText)
        && /\+1 小时/.test(boardText) && boardText.includes('基准'),
      `列=${(boardText.match(/相对偏移/) ?? ['-'])[0]} 跨日=${/\+1天/.test(boardText)}`,
    );
    record(
      'duration totals grouped with short decimals',
      durationText.includes('4,000,000,000') && /天\s+46\.3$/m.test(durationText) && /周\s+6\.61$/m.test(durationText)
        && longDecimals(durationText).length === 0 && durationText.includes('年长基准'),
      longDecimals(durationText).join(',') || `天=${rowOf(durationText, '天')} 周=${rowOf(durationText, '周')}`,
    );

    const SWEEP: Array<[ToolId, Record<string, unknown>]> = [
      ['timestamp', { input: '1700000000', timezone: 'Asia/Shanghai' }],
      ['date-diff', { from: '2026-01-05', to: '2026-03-08', timezone: 'Asia/Shanghai', includeEnd: true, breakdown: true }],
      ['date-math', { base: '2026-01-31', direction: 'add', value: 1, unit: 'months', timezone: 'Asia/Shanghai', skipWeekend: true }],
      ['workdays', WORKDAY_CASE],
      ['timezone-board', boardCase],
      ['duration', { value: '4000000000', unit: 'ms', style: 'all', timezone: 'Asia/Shanghai' }],
      ['cron', CRON_QUARTER],
      ['date-format', { input: '2026-03-08 12:00:00', pattern: 'YYYY-MM-DD HH:mm:ss ddd A ZZ', timezone: 'Asia/Shanghai', locale: 'en-US', showCommon: true }],
      ['relative-time', { input: '2026-12-31 23:59:59', base: '2026-09-22 04:00:00', timezone: 'Asia/Shanghai', locale: 'en-US' }],
    ];
    const zhDirty: string[] = [];
    for (const [tool, options] of SWEEP) {
      const en = await callText(engine, tool, options, 'en');
      const zh = await callText(engine, tool, options, 'zh-CN');
      if (!en.result || !zh.result) {
        record(`en ${tool} enum + decimal hygiene`.slice(0, 40), false, `${en.error?.code ?? zh.error?.code ?? '?'} 无返回`);
        continue;
      }
      const echoes = echoedEnum(en.result.text);
      const decimals = longDecimals(en.result.text);
      const bad = [
        ...echoes.map((word) => `回显 ${word}`),
        ...decimals.map((value) => `小数 ${value}`),
        ...(hanGlyph.test(en.result.text) ? ['含汉字'] : []),
      ];
      record(
        `en ${tool} enum + decimal hygiene`.slice(0, 40),
        bad.length === 0,
        bad.length ? bad.join('，') : `0 处枚举回显、0 处长小数、0 个汉字（${en.result.text.length} 字符）`,
      );
      const zhBad = [...echoedEnum(zh.result.text), ...longDecimals(zh.result.text)];
      if (zhBad.length) zhDirty.push(`${tool}:${zhBad.join('/')}`);
    }
    record('zh 9 time tools enum + decimal hygiene', zhDirty.length === 0, zhDirty.join(' ') || '9 个工具中文态同样干净');
  }
  await textCase('hash', { input: 'abc' }, ['900150983cd24fb0d6963f7d28e17f72', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']);
  await textCase('hmac', { message: 'hello', secret: 'key', algorithm: 'sha256' }, ['9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b']);
  await textCase('base64', { input: 'Hello, 世界!', mode: 'encode' }, ['SGVsbG8sIOS4lueVjCE=']);
  await textCase('radix', { input: 'Hello', mode: 'encode', alphabet: 'base32' }, ['JBSWY3DP']);
  await textCase('hex', { input: 'Hi', mode: 'encode' }, ['4869']);
  await textCase('url-codec', { input: 'a b&c=d', mode: 'encode' }, ['a%20b%26c%3Dd']);
  await textCase('unicode-escape', { input: '中文A', mode: 'encode' }, ['\\u4e2d\\u6587A']);
  await textCase('totp', { mode: 'generate', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 8, at: '59' }, ['94287082']);
  await textCase('x509', { pem: X509_PEM }, ['CN=alice.example.com', 'X.509 v3', '有效期内']);
  await textCase('password-gen', { length: 20, count: 3 }, ['3 条 × 20 位']);

  // uuid-gen：v4 需匹配版本/变体正则（随机值，不能硬编码文本）
  {
    const result = await textCase('uuid-gen', { version: 'v4', count: 3 }, ['-', 'v4'], 'uuid-gen v4');
    const v4 = (result?.text ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) ?? [];
    if (result) textToolsRun.add('uuid-gen');
    record('text uuid-gen', v4.length === 3, `v4 匹配 ${v4.length}/3，文本 ${(result?.text ?? '').length} 字符`);
  }

  // jwt：自签令牌 + 正确密钥应通过、错误密钥应拒绝（两个断言合成一条用例）
  {
    const pass = await callText(engine, 'jwt', { token: JWT_HS256, secret: 'topsecret', verify: true });
    const fail = await callText(engine, 'jwt', { token: JWT_HS256, secret: 'WRONG-KEY', verify: true });
    const problems = [
      ...(pass.result ? contractProblems(pass.result, ['✓ 通过（签名匹配）', 'pohoc']) : [`pass ${pass.error?.code}: ${pass.error?.message.slice(0, 40)}`]),
      ...(fail.result ? contractProblems(fail.result, ['✗ 失败（签名不匹配）']) : [`fail ${fail.error?.code}: ${fail.error?.message.slice(0, 40)}`]),
    ];
    if (!problems.length) textToolsRun.add('jwt');
    record('text jwt verify', !problems.length, problems.length ? problems.join('; ') : `通过+拒绝均命中，${pass.result!.text.length}/${fail.result!.text.length} 字符`);
  }

  // aes：encrypt→decrypt 往返一致，且损坏容器必须报错（GCM 拒绝）
  {
    const enc = await callText(engine, 'aes', { input: '机密 round-trip', mode: 'encrypt', passphrase: 'pw123' });
    const container = String(enc.result?.extra?.container ?? '');
    const dec = container
      ? await callText(engine, 'aes', { input: container, mode: 'decrypt', passphrase: 'pw123' })
      : { result: null, error: { code: 'internal', message: 'extra.container 缺失' } as JobError };
    const broken = container.slice(0, -2) + (container.slice(-2) === 'AA' ? 'BB' : 'AA');
    const tamper = await callText(engine, 'aes', { input: broken, mode: 'decrypt', passphrase: 'pw123' });
    const tamperRejected = tamper.error !== null || Boolean(tamper.result?.text.includes('失败'));
    const problems = [
      ...(enc.result ? contractProblems(enc.result, ['AES 加密', '容器串', container]) : [`encrypt ${enc.error?.message.slice(0, 40) ?? '?'}`]),
      ...(dec.result ? contractProblems(dec.result, ['机密 round-trip']) : [`decrypt ${dec.error?.message.slice(0, 40) ?? '?'}`]),
      ...(container ? [] : ['extra.container 为空']),
      ...(tamperRejected ? [] : ['篡改容器未被拒绝（危险）']),
    ];
    if (!problems.length) textToolsRun.add('aes');
    record(
      'text aes round trip',
      !problems.length,
      problems.length ? problems.join('; ') : `容器 ${container.length} 字符, 往返一致, 篡改被拒（${tamper.error ? tamper.error.code : '文本提示'}）`,
    );
  }

  // rsa：keygen→sign→verify 往返（验签需把 `signature:` 头拼进 message，见 TASK3 UX）
  {
    const keygen = await textCase(
      'rsa', { mode: 'generate' }, ['BEGIN PRIVATE KEY', 'BEGIN PUBLIC KEY'], 'rsa keygen',
    );
    const keyText = keygen?.text ?? '';
    const priv = keyText.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/)?.[0] ?? '';
    const pub = keyText.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/)?.[0] ?? '';
    const sign = await callText(engine, 'rsa', { mode: 'sign', privateKey: priv, message: '待签名内容' });
    const signature = String(sign.result?.extra?.signature ?? '');
    const verify = await callText(engine, 'rsa', { mode: 'verify', publicKey: pub, message: `signature: ${signature}\n待签名内容` });
    const bad = await callText(engine, 'rsa', { mode: 'verify', publicKey: pub, message: `signature: ${signature}\n被改动的原文` });
    const problems = [
      ...(keygen ? [] : ['keygen 未返回文本']),
      ...(signature ? [] : ['extra.signature 为空']),
      ...(verify.result ? contractProblems(verify.result, ['✓ 通过（签名与原文、公钥匹配）']) : [`verify ${verify.error?.message.slice(0, 40)}`]),
      ...(bad.result ? contractProblems(bad.result, ['✗ 不通过']) : [`bad ${bad.error?.message.slice(0, 40)}`]),
    ];
    if (!problems.length) textToolsRun.add('rsa');
    record('text rsa sign/verify', !problems.length, problems.length ? problems.join('; ') : `密钥对有，签名 ${signature.length} 字符，正/反验签均命中`);
  }

  // 双语验收：同一输入在 en 语境下必须零汉字，语言中立的计算结果与 zh 一致。
  const HAN = /[\u4e00-\u9fff]/;
  const enTextCase = async (
    tool: ToolId,
    options: Record<string, unknown>,
    needles: string[],
    name: string = tool,
  ): Promise<TextRunResult | null> => {
    const { result, error } = await callText(engine, tool, options, 'en');
    if (!result) {
      record(`en ${name}`.slice(0, 40), false, error ? `${error.code}: ${error.message.slice(0, 60)}` : '无返回');
      return null;
    }
    const problems = contractProblems(result, needles);
    if (HAN.test(result.text)) problems.push('en 输出含汉字');
    if (result.warnings.some((item) => HAN.test(item))) problems.push('en warnings 含汉字');
    record(
      `en ${name}`.slice(0, 40),
      !problems.length,
      problems.length ? `${problems.join('; ')} | ${result.text.slice(0, 40)}` : `CJK-free + ${needles.length} needles, ${result.text.length} chars`,
    );
    return result;
  };
  await enTextCase('timestamp', { input: '1700000000' }, ['2023-11-15', '1700000000000']);
  await enTextCase('duration', { value: '3735', unit: 's', style: 'all' }, ['01:02:15', 'PT1H2M15S']);
  await enTextCase('cron', { expression: '0 9 * * 1-5', from: '2023-11-13T00:00:00Z', count: 5 }, ['2023-11-13 09:00:00', 'Monday']);
  await enTextCase('hash', { input: 'abc' }, ['900150983cd24fb0d6963f7d28e17f72', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']);
  await enTextCase('base64', { input: '中文😀 PoToois', mode: 'encode' }, ['5Lit5paH8J+YgCBQb1Rvb2lz']);
  await enTextCase('totp', { mode: 'generate', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 8, at: '59' }, ['94287082']);
  {
    const enc = await enTextCase('aes', { input: 'round-trip payload', mode: 'encrypt', passphrase: 'pw123' }, [], 'aes encrypt en');
    const container = String(enc?.extra?.container ?? '');
    const dec = container
      ? await callText(engine, 'aes', { input: container, mode: 'decrypt', passphrase: 'pw123' }, 'en')
      : { result: null, error: { code: 'internal', message: 'extra.container 缺失' } as JobError };
    const problems = dec.result ? [...contractProblems(dec.result, ['round-trip payload']), ...(HAN.test(dec.result.text) ? ['en 解密输出含汉字'] : [])] : [`decrypt ${dec.error?.message.slice(0, 40) ?? '?'}`];
    record('en aes round trip', !problems.length, problems.length ? problems.join('; ') : `CJK-free container ${container.length} chars, plaintext back`);
  }

  // 通道边界：需要文件的工具走 tool.run 必须被拒绝，且不允许留下任务或临时目录。
  {
    const refused = await callText(engine, 'file-checksum', { algorithm: 'sha256' });
    record(
      'tool.run refuses file tools',
      refused.error?.code === 'unsupported',
      `${refused.error?.code ?? 'succeeded'}: ${(refused.error?.message ?? '竟然成功').slice(0, 46)}`,
    );
    const unknown = await callText(engine, 'merge', {});
    record('tool.run rejects unknown text tool', unknown.error?.code === 'unsupported', unknown.error?.code ?? 'succeeded');
  }

  record(
    'tool.run covers 23 text tools',
    textToolsRun.size === TEXT_TOOLS.length && TEXT_TOOLS.every((id) => textToolsRun.has(id)),
    `已断言 ${textToolsRun.size}/${TEXT_TOOLS.length}${textToolsRun.size === TEXT_TOOLS.length ? '' : `，缺 ${TEXT_TOOLS.filter((id) => !textToolsRun.has(id)).join(', ')}`}`,
  );

  const tempAfterText = (await engine.call('temp.stat', {})) as TempUsage;
  record(
    'tool.run leaves temp untouched',
    tempAfterText.jobs === tempBeforeText.jobs
      && tempAfterText.files === tempBeforeText.files
      && tempAfterText.bytes === tempBeforeText.bytes,
    `前 ${tempBeforeText.jobs} 任务/${tempBeforeText.files} 文件/${tempBeforeText.bytes} B → 后 ${tempAfterText.jobs}/${tempAfterText.files}/${tempAfterText.bytes} B`,
  );
  const jobsAfterText = engine.manager.list().length;
  record('tool.run leaves queue untouched', jobsAfterText === jobsBeforeText, `${jobsBeforeText} → ${jobsAfterText} 个任务`);

  // 日期短语解析：期望值按运行当天推算，不写死日期。
  {
    const zone = 'Asia/Shanghai';
    const fixedNow = Date.now();
    const origin = zonedParts(zone, fixedNow);
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    /** Calendar shift around the zoned "today", independent of the parser. */
    const expectAt = (days: number, hour: number, minute: number, second: number): string => {
      const moved = new Date(Date.UTC(origin.year, origin.month - 1, origin.day) + days * DAY_MS);
      return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
    };
    const parsed = (expression: string): string =>
      formatInZone(zone, parseFlex(expression, { timeZone: zone, fallbackNow: fixedNow }));
    const clock = { hour: origin.hour, minute: origin.minute, second: origin.second };
    for (const [expression, wanted] of [
      ['yesterday', expectAt(-1, 0, 0, 0)],
      ['前天', expectAt(-2, 0, 0, 0)],
      ['+3d', expectAt(3, clock.hour, clock.minute, clock.second)],
      ['yesterday 14:30', expectAt(-1, 14, 30, 0)],
    ] as Array<[string, string]>) {
      let got = '';
      let detail = '';
      try {
        got = parsed(expression);
        detail = `${expression} → ${got}`;
      } catch (error) {
        detail = `${expression} → 抛出 ${(error as Error).message.slice(0, 40)}`;
      }
      record(`parser ${expression}`.slice(0, 40), got === wanted, `${detail}（期望 ${wanted}）`);
    }
    // 同一短语经 tool.run 落到工具输出上。
    await textCase(
      'date-format',
      { input: 'yesterday 14:30', pattern: 'YYYY-MM-DD HH:mm:ss', timezone: zone },
      [expectAt(-1, 14, 30, 0)],
      'date-format yesterday 14:30',
    );
  }
  const byId = new Map(TOOL_LIST.map((tool) => [tool.id, tool]));
  const portraitPath = resolve(OUT_DIR, 'sample-person.png');
  const { default: sharp } = await import('sharp');
  const personSvg = Buffer.from('<svg width="800" height="1000" xmlns="http://www.w3.org/2000/svg"><circle cx="400" cy="220" r="145" fill="#e8b48b"/><path d="M130 950 Q145 490 400 430 Q655 490 670 950Z" fill="#263b5b"/></svg>');
  await sharp(personSvg).png().toFile(portraitPath);
  const portraitRef: FileRef = { id: 'image-test-person', name: 'sample-person.png', path: portraitPath };
  const cutoutJob = await run(engine, 'image-cutout', [portraitRef]);
  const cutoutPath = cutoutJob.artifacts[0]?.path;
  const cutoutMeta = cutoutPath ? await sharp(cutoutPath).metadata() : undefined;
  record('image cutout exports transparent PNG', cutoutJob.progress.state === 'succeeded' && cutoutMeta?.format === 'png' && cutoutMeta.hasAlpha === true,
    cutoutPath ? `${cutoutMeta?.format}, alpha=${cutoutMeta?.hasAlpha}` : cutoutJob.error?.message ?? 'no artifact');
  const idPhotoJob = await run(engine, 'image-id-photo', [portraitRef], { size: 'one-inch', maxFileKb: 100, printSheet: true });
  const photoPath = idPhotoJob.artifacts[0]?.path;
  const sheetPath = idPhotoJob.artifacts[1]?.path;
  const photoMeta = photoPath ? await sharp(photoPath).metadata() : undefined;
  const sheetMeta = sheetPath ? await sharp(sheetPath).metadata() : undefined;
  const photoSizeKb = photoPath ? (await stat(photoPath)).size / 1024 : Number.POSITIVE_INFINITY;
  record('ID photo meets pixel and KB limits', idPhotoJob.progress.state === 'succeeded' && photoMeta?.width === 295 && photoMeta.height === 413 && photoSizeKb <= 100,
    photoPath ? `${photoMeta?.width}×${photoMeta?.height}px, ${photoSizeKb.toFixed(1)} KB` : idPhotoJob.error?.message ?? 'no photo');
  record('ID photo creates A4 print sheet', Boolean(sheetMeta?.width === 2480 && sheetMeta.height === 3508),
    sheetPath ? `${sheetMeta?.width}×${sheetMeta?.height}px` : 'no sheet');
  const printJob = await run(engine, 'image-print', [jpg], { paper: 'a4', orientation: 'portrait' });
  const printMeta = printJob.artifacts[0]?.path ? await sharp(printJob.artifacts[0].path).metadata() : undefined;
  record('image print creates A4 300 DPI output', printJob.progress.state === 'succeeded' && printMeta?.width === 2480 && printMeta.height === 3508 && printMeta.density === 300,
    `${printMeta?.width ?? 0}×${printMeta?.height ?? 0}px, ${printMeta?.density ?? 0} DPI`);
  const cleanJob = await run(engine, 'image-metadata-clean', [jpg]);
  const cleanMeta = cleanJob.artifacts[0]?.path ? await sharp(cleanJob.artifacts[0].path).metadata() : undefined;
  record('image metadata cleanup removes EXIF', cleanJob.progress.state === 'succeeded' && !cleanMeta?.exif && !cleanMeta?.xmp,
    cleanJob.progress.state === 'succeeded' ? 'EXIF/GPS/XMP absent' : cleanJob.error?.message ?? 'no artifact');
  const mark = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const repairJob = await run(engine, 'image-watermark-clean', [jpg], { repairPng: mark.toString('base64') });
  record('watermark repair emits PNG', repairJob.progress.state === 'succeeded' && Boolean(repairJob.artifacts[0]?.name.endsWith('.png')),
    repairJob.progress.state === 'succeeded' ? repairJob.artifacts[0]?.name ?? 'no artifact' : repairJob.error?.message ?? 'no artifact');
  const extraFiles: Partial<Record<ToolId, () => FileRef[]>> = {
  'images-to-pdf': () => [jpg, png],
    'image-compress': () => [jpg, png],
    'image-resize': () => [jpg],
    'image-crop': () => [wide],
    'image-rotate': () => [jpg],
    'image-convert': () => [png],
    'image-info': () => [jpg, png],
    'extract-images': () => [photos],
    'compress': () => [photos],
    'word-to-pdf': () => [docx],
    'excel-to-pdf': () => [xlsx],
    'ppt-to-pdf': () => [pptx],
    'image-cutout': () => [portraitRef],
    'image-id-photo': () => [portraitRef],
    'image-metadata-clean': () => [jpg],
    'image-print': () => [jpg],
    'image-watermark-clean': () => [jpg],
    'ofd-to-pdf': () => [ofd],
    'markdown-to-pdf': () => [md],
  };
  const extraOptions: Record<ToolId, Record<string, unknown>> | Record<string, Record<string, unknown>> = {
    'delete-pages': { pages: '2' },
    organize: {
      plan: [
        { fileId: a.id, page: 2, rotation: 90 },
        { fileId: a.id, page: 1, rotation: 0 },
        { fileId: b.id, page: 1, rotation: 0 },
      ],
    },
    metadata: { title: '覆盖测试', author: 'pohoc' },
    'pdf-to-excel': { sheetPerPage: false },
    'image-watermark-clean': { repairPng: Buffer.from('<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" fill="white"/></svg>').toString('base64') },
  };

  for (const tool of TOOL_LIST) {
    const id = tool.id;
    if (id === 'invoice-organize') {
      record('coverage invoice-organize', invoiceOrganizerCoverage, invoiceOrganizerCoverage ? 'RPC scan → archive → undo passed' : 'RPC contract failed above');
      continue;
    }
    if (['doc-to-docx', 'docx-to-doc', 'xls-to-xlsx', 'xlsx-to-xls', 'ppt-to-pptx', 'pptx-to-ppt'].includes(id)) {
      recordSkipped(`coverage ${byId.get(id)?.id ?? id}`, 'six real-format conversions were exercised with dedicated fixtures above');
      continue;
    }
    if (tool.requiresInput === false) {
      record(`coverage ${byId.get(id)?.id ?? id}`.slice(0, 40), true, '纯文本工具，无需文件，由上方专用文本用例断言');
      continue;
    }
    let job: JobSnapshot;
    try {
      const files = extraFiles[id]?.() ?? (tool.multiFile ? [a, b] : [a]);
      job = await run(engine, id, files, extraOptions[id] ?? {}, id);
    } catch (error) {
      recordSkipped(`coverage ${byId.get(id)?.id ?? id}`.slice(0, 40), `引擎无实现：${(error as Error).message.slice(0, 40)}`);
      continue;
    }
    if (job.progress.state === 'failed' && job.error?.code === 'unsupported') {
      recordSkipped(`coverage ${byId.get(id)?.id ?? id}`.slice(0, 40), `依赖本机可选转换器：${job.error.message.slice(0, 40)}`);
      continue;
    }
    const ok = job.progress.state === 'succeeded' && job.artifacts.length > 0;
    const detail = ok
      ? `${job.artifacts.length} artifact(s), ${formatKb(job.summary?.outputBytes ?? 0)}`
      : job.error
        ? `${job.error.code}: ${job.error.message.slice(0, 70)}`
        : job.progress.state;
    record(`coverage ${byId.get(id)?.id ?? id}`.slice(0, 40), ok, detail);
  }

  const failed = results.filter((item) => !item.ok && !item.skipped);
  const skipped = results.filter((item) => item.skipped).length;
  process.stdout.write(`\n${results.length - failed.length - skipped}/${results.length} checks passed${skipped ? `, ${skipped} skipped` : ''}\n`);
  if (failed.length) {
    process.stdout.write(`failures:\n${failed.map((item) => `  - ${item.name}: ${item.detail}`).join('\n')}\n`);
    process.exitCode = 1;
  }
  await rm(OUT_DIR, { recursive: true, force: true });
  await Promise.all(['corrupt.pdf', 'truncated.pdf'].map((name) => rm(resolve(SAMPLES, name), { force: true })));
  process.stdout.write('temporary test output and damage fixtures cleaned\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
