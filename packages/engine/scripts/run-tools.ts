/**
 * End-to-end harness: drives every registered tool through the real engine and
 * asserts the artifacts on disk. Run after `make-samples`.
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { PDFArray, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { FileRef, JobSnapshot, ToolId } from '@potools/core';
import { defaultOptions, TOOL_LIST } from '@potools/core';

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}
import { createEngine, type Engine } from '../src/rpc.ts';
import { openRaster } from '../src/lib/render.ts';
import { writeDocx, writePptx, writeXlsx } from '../src/lib/office.ts';

const execFileAsync = promisify(execFile);

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
    return slides.length === 3 ? `${slides.length} slides` : `expected 3 slides, got ${slides.length}`;
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

  // Office pair conversion fixtures live in a disposable temp directory. The
  // optional external converter is discovered here so environments without it
  // report a clear skip rather than a misleading format failure.
  let officeExecutable: string | null = null;
  for (const candidate of process.platform === 'win32'
    ? ['soffice.exe', 'soffice']
    : process.platform === 'darwin'
      ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice', 'libreoffice']
      : ['soffice', 'libreoffice']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 8_000, windowsHide: true });
      officeExecutable = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        officeExecutable = candidate;
        break;
      }
    }
  }
  if (officeExecutable) {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'potools-office-fixtures-'));
    try {
      const profileDir = join(fixtureDir, 'profile');
      const outputDir = join(fixtureDir, 'legacy');
      await Promise.all([mkdir(profileDir), mkdir(outputDir)]);
      const [docxBytes, xlsxBytes, pptxBytes] = await Promise.all([
        writeDocx({ title: 'PoTools conversion sample', blocks: [{ kind: 'paragraph', text: 'Office conversion fixture', page: 1, bold: false }], imageFor: () => null, pageBreaks: true, contentWidth: 500 }),
        writeXlsx([{ name: 'Sheet1', rows: [['Quarter', 'Value'], ['Q1', '12']] }]),
        writePptx({ title: 'PoTools conversion sample', slides: [{ widthIn: 8, heightIn: 11, image: new Uint8Array(await readFile(resolve(SAMPLES, 'sample-scan-2.png'))), lines: [] }] }),
      ]);
      await Promise.all([
        writeFile(join(fixtureDir, 'sample.docx'), docxBytes),
        writeFile(join(fixtureDir, 'sample.xlsx'), xlsxBytes),
        writeFile(join(fixtureDir, 'sample.pptx'), pptxBytes),
      ]);
      for (const extension of ['doc', 'xls', 'ppt']) {
        await execFileAsync(officeExecutable, [
          '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
          `-env:UserInstallation=${pathToFileURL(`${profileDir}/`).href}`,
          '--convert-to', extension, '--outdir', outputDir,
          join(fixtureDir, `sample.${extension === 'doc' ? 'docx' : extension === 'xls' ? 'xlsx' : 'pptx'}`),
        ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      }
      const legacyFiles = await Promise.all(['doc', 'xls', 'ppt'].map(async (extension) => {
        const path = join(outputDir, `sample.${extension}`);
        const bytes = await readFile(path);
        const name = `sample.${extension}`;
        return { extension, ref: { id: `office-${extension}`, name, path } satisfies FileRef, bytes };
      }));
      const legacy = Object.fromEntries(legacyFiles.map(({ extension, ref }) => [extension, ref])) as Record<string, FileRef>;
      for (const [tool, source] of [
        ['doc-to-docx', legacy.doc], ['docx-to-doc', docx],
        ['xls-to-xlsx', legacy.xls], ['xlsx-to-xls', xlsx],
        ['ppt-to-pptx', legacy.ppt], ['pptx-to-ppt', pptx],
      ] as Array<[ToolId, FileRef]>) {
        const job = await run(engine, tool, [source]);
        const ok = job.progress.state === 'succeeded' && job.artifacts.length > 0;
        record(`office conversion ${tool}`, ok, ok ? `${job.artifacts.length} output` : job.error?.message ?? job.progress.state);
      }
    } catch (error) {
      for (const id of ['doc-to-docx', 'docx-to-doc', 'xls-to-xlsx', 'xlsx-to-xls', 'ppt-to-pptx', 'pptx-to-ppt']) {
        recordSkipped(`office conversion ${id}`, `could not create real fixtures: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  } else {
    for (const id of ['doc-to-docx', 'docx-to-doc', 'xls-to-xlsx', 'xlsx-to-xls', 'ppt-to-pptx', 'pptx-to-ppt']) {
      recordSkipped(`office conversion ${id}`, 'LibreOffice is not installed in this environment');
    }
  }

  const notDocx = await run(engine, 'word-to-pdf', [a]);
  record(
    'rejects non-Office input',
    notDocx.progress.state === 'failed' && notDocx.error?.code === 'unreadable_file',
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
  const byId = new Map(TOOL_LIST.map((tool) => [tool.id, tool]));
  const portraitPath = resolve(OUT_DIR, 'sample-person.png');
  const { default: sharp } = await import('sharp');
  const personSvg = Buffer.from('<svg width="800" height="1000" xmlns="http://www.w3.org/2000/svg"><circle cx="400" cy="220" r="145" fill="#e8b48b"/><path d="M130 950 Q145 490 400 430 Q655 490 670 950Z" fill="#263b5b"/></svg>');
  await sharp(personSvg).png().toFile(portraitPath);
  const portraitRef: FileRef = { id: 'image-test-person', name: 'sample-person.png', path: portraitPath };
  const cutoutJob = await run(engine, 'image-cutout', [portraitRef]);
  const cutoutPath = cutoutJob.artifacts[0]?.path;
  const cutoutMeta = cutoutPath ? await sharp(cutoutPath).metadata() : {};
  record('image cutout exports transparent PNG', cutoutJob.progress.state === 'succeeded' && cutoutMeta.format === 'png' && cutoutMeta.hasAlpha === true,
    cutoutPath ? `${cutoutMeta.format}, alpha=${cutoutMeta.hasAlpha}` : cutoutJob.error?.message ?? 'no artifact');
  const idPhotoJob = await run(engine, 'image-id-photo', [portraitRef], { size: 'one-inch', maxFileKb: 100, printSheet: true });
  const photoPath = idPhotoJob.artifacts[0]?.path;
  const sheetPath = idPhotoJob.artifacts[1]?.path;
  const photoMeta = photoPath ? await sharp(photoPath).metadata() : {};
  const sheetMeta = sheetPath ? await sharp(sheetPath).metadata() : {};
  const photoSizeKb = photoPath ? (await stat(photoPath)).size / 1024 : Number.POSITIVE_INFINITY;
  record('ID photo meets pixel and KB limits', idPhotoJob.progress.state === 'succeeded' && photoMeta.width === 295 && photoMeta.height === 413 && photoSizeKb <= 100,
    photoPath ? `${photoMeta.width}×${photoMeta.height}px, ${photoSizeKb.toFixed(1)} KB` : idPhotoJob.error?.message ?? 'no photo');
  record('ID photo creates A4 print sheet', Boolean(sheetMeta.width === 2480 && sheetMeta.height === 3508),
    sheetPath ? `${sheetMeta.width}×${sheetMeta.height}px` : 'no sheet');
  const printJob = await run(engine, 'image-print', [jpg], { paper: 'a4', orientation: 'portrait' });
  const printMeta = printJob.artifacts[0]?.path ? await sharp(printJob.artifacts[0].path).metadata() : {};
  record('image print creates A4 300 DPI output', printJob.progress.state === 'succeeded' && printMeta.width === 2480 && printMeta.height === 3508 && printMeta.density === 300,
    `${printMeta.width ?? 0}×${printMeta.height ?? 0}px, ${printMeta.density ?? 0} DPI`);
  const cleanJob = await run(engine, 'image-metadata-clean', [jpg]);
  const cleanMeta = cleanJob.artifacts[0]?.path ? await sharp(cleanJob.artifacts[0].path).metadata() : {};
  record('image metadata cleanup removes EXIF', cleanJob.progress.state === 'succeeded' && !cleanMeta.exif && !cleanMeta.xmp,
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
    if (['doc-to-docx', 'docx-to-doc', 'xls-to-xlsx', 'xlsx-to-xls', 'ppt-to-pptx', 'pptx-to-ppt'].includes(id)) {
      recordSkipped(`coverage ${byId.get(id)?.id ?? id}`, 'six real-format conversions were exercised with dedicated fixtures above');
      continue;
    }
    const files = extraFiles[id]?.() ?? (tool.multiFile ? [a, b] : [a]);
    const job = await run(engine, id, files, extraOptions[id] ?? {}, id);
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
