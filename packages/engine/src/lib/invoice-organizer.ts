import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { InvoiceArchiveResult, InvoiceScanEntry, InvoiceScanResult, InvoiceUndoResult } from '@potools/core';
import { EngineError } from '../errors.ts';
import { openRaster } from './render.ts';
import { parseInvoiceFields } from './invoice-fields.ts';

export { parseInvoiceFields } from './invoice-fields.ts';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const UNDO_ARCHIVES = new Map<string, { targetRoot: string; files: Array<{ path: string; sha256: string }> }>();

export async function scanInvoiceDirectory(options: {
  directory: string;
  recursive?: boolean;
  maxFiles?: number;
  excludeDirectory?: string;
}): Promise<InvoiceScanResult> {
  if (!options.directory || !isAbsolute(options.directory)) {
    throw new EngineError('bad_request', '请选择有效的来源目录');
  }
  const root = await realpath(options.directory).catch(() => {
    throw new EngineError('unreadable_file', '无法访问来源目录');
  });
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new EngineError('bad_request', '来源路径不是目录');
  const excluded = options.excludeDirectory ? await realpath(options.excludeDirectory).catch(() => resolve(options.excludeDirectory!)) : '';
  if (excluded && (samePath(root, excluded) || isWithin(root, excluded))) {
    throw new EngineError('bad_request', '归档目标不能与来源目录相同或位于来源目录内');
  }
  const limit = Math.min(MAX_FILES, Math.max(1, Math.trunc(options.maxFiles ?? MAX_FILES)));
  const files: Array<{ path: string; relativePath: string; name: string; extension: string }> = [];
  const skipped: InvoiceScanResult['skipped'] = [];
  let totalBytes = 0;
  let exceeded = false;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      skipped.push({ relativePath: relative(root, directory), reason: `无法读取目录：${messageOf(error)}` });
      return [];
    });
    for (const entry of entries) {
      if (files.length >= limit || totalBytes >= MAX_TOTAL_BYTES) {
        exceeded = true;
        return;
      }
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join('/');
      if (excluded && (samePath(path, excluded) || isWithin(excluded, path))) continue;
      if (entry.isSymbolicLink()) {
        skipped.push({ relativePath: rel, reason: '跳过符号链接' });
        continue;
      }
      if (entry.isDirectory()) {
        if (options.recursive !== false) await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) continue;
      const itemStat = await lstat(path).catch(() => null);
      if (!itemStat?.isFile()) {
        skipped.push({ relativePath: rel, reason: '文件状态已变化，已跳过' });
        continue;
      }
      if (itemStat.size > MAX_FILE_BYTES) {
        skipped.push({ relativePath: rel, reason: '超过单文件 100 MB 上限' });
        continue;
      }
      if (totalBytes + itemStat.size > MAX_TOTAL_BYTES) {
        exceeded = true;
        return;
      }
      totalBytes += itemStat.size;
      files.push({ path, relativePath: rel, name: entry.name, extension });
    }
  }

  await walk(root);
  const analyzed: InvoiceScanEntry[] = [];
  for (const file of files) {
    try {
      const bytes = await readFile(file.path);
      const current = await stat(file.path);
      if (current.size !== bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) {
        skipped.push({ relativePath: file.relativePath, reason: '扫描期间文件发生变化或超过大小上限' });
        continue;
      }
      const entry: InvoiceScanEntry = {
        ...file,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        pageCount: null,
        extractedText: '',
        recognition: 'needs-ocr',
        fields: { date: '', seller: '', buyer: '', invoiceNo: '', amount: '', type: '' },
      };
      if (file.extension === '.pdf') {
        const raster = await openRaster(bytes);
        try {
          entry.pageCount = raster.pageCount;
          const textParts: string[] = [];
          const pagesToRead = Math.min(raster.pageCount, 20);
          for (let page = 1; page <= pagesToRead; page += 1) {
            textParts.push(raster.pageText(page));
          }
          entry.extractedText = textParts.join('\n').slice(0, MAX_TEXT_CHARS);
          if (entry.extractedText.trim()) {
            entry.recognition = 'native-text';
            entry.fields = parseInvoiceFields(entry.extractedText);
          }
        } finally {
          raster.close();
        }
      }
      analyzed.push(entry);
    } catch (error) {
      analyzed.push({
        ...file,
        sizeBytes: 0,
        sha256: '',
        pageCount: null,
        extractedText: '',
        recognition: 'failed',
        fields: { date: '', seller: '', buyer: '', invoiceNo: '', amount: '', type: '' },
        error: messageOf(error),
      });
    }
  }
  return {
    sourceDirectory: root,
    scannedAt: Date.now(),
    files: analyzed,
    skipped,
    warnings: [
      'ocr-unavailable',
      ...(exceeded ? ['scan-limit-reached'] : []),
    ],
  };
}

export async function archiveInvoiceFiles(input: {
  sourceDirectory: string;
  targetDirectory: string;
  conflict: 'rename' | 'skip';
  files: Array<{ path: string; sha256: string; relativePath: string; enabled: boolean; fields?: InvoiceScanEntry['fields'] }>;
}): Promise<InvoiceArchiveResult> {
  if (input.files.length > MAX_FILES || !input.files.some((item) => item.enabled)) {
    throw new EngineError('bad_request', `请选择 1 至 ${MAX_FILES} 个归档文件`);
  }
  if (!input.targetDirectory || !isAbsolute(input.targetDirectory)) {
    throw new EngineError('bad_request', '请选择有效的归档目标目录');
  }
  const sourceRoot = await realpath(input.sourceDirectory).catch(() => {
    throw new EngineError('unreadable_file', '来源目录已不可用，请重新扫描');
  });
  const targetRoot = resolve(input.targetDirectory);
  if (!isAbsolute(targetRoot) || samePath(sourceRoot, targetRoot) || isWithin(sourceRoot, targetRoot) || isWithin(targetRoot, sourceRoot)) {
    throw new EngineError('bad_request', '归档目标必须是来源目录之外的独立目录');
  }
  await mkdir(targetRoot, { recursive: true });
  const targetReal = await realpath(targetRoot);
  if (samePath(sourceRoot, targetReal) || isWithin(sourceRoot, targetReal) || isWithin(targetReal, sourceRoot)) {
    throw new EngineError('bad_request', '归档目标与来源目录不能重叠');
  }
  const sourceInfo = await stat(sourceRoot);
  if (!sourceInfo.isDirectory()) throw new EngineError('bad_request', '来源路径不是目录');
  const copied: InvoiceArchiveResult['copied'] = [];
  const skipped: InvoiceArchiveResult['skipped'] = [];
  const failed: InvoiceArchiveResult['failed'] = [];

  for (const item of input.files) {
    if (!item.enabled) continue;
    let temporary = '';
    try {
      const source = resolve(item.path);
      if (!isWithin(sourceRoot, source)) throw new Error('源文件不在已扫描目录内');
      const sourceReal = await realpath(source);
      if (!isWithin(sourceRoot, sourceReal)) throw new Error('源文件已移出来源目录');
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('源文件不再是普通文件');
      if (sourceStat.size > MAX_FILE_BYTES) throw new Error('源文件超过 100 MB 上限');
      if (!/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error('扫描校验信息无效，请重新扫描');
      const bytes = await readFile(sourceReal);
      const digest = sha256(bytes);
      if (digest !== item.sha256) throw new Error('源文件内容已变化，请重新扫描');
      const segments = safeRelativeSegments(item.relativePath);
      const requested = resolve(targetReal, ...segments);
      if (!isWithin(targetReal, requested)) throw new Error('目标路径超出归档目录');
      await ensureSafeDirectory(targetReal, dirname(requested));
      let destination = requested;
      if (input.conflict === 'skip') {
        await stat(destination).then(() => { throw new Error('conflict:目标文件已存在'); }, (error) => {
          if (error instanceof Error && error.message.startsWith('conflict:')) throw error;
        });
      } else {
        destination = await freeDestination(requested);
      }
      temporary = join(dirname(destination), `.potools-${randomUUID()}.tmp`);
      await copyFile(sourceReal, temporary);
      const copiedBytes = await readFile(temporary);
      if (sha256(copiedBytes) !== digest) throw new Error('复制校验失败');
      await link(temporary, destination);
      await rm(temporary, { force: true });
      temporary = '';
      copied.push({ source: item.path, target: destination, sha256: digest, fields: item.fields ?? emptyFields() });
    } catch (error) {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      const reason = messageOf(error);
      if (reason.startsWith('conflict:')) skipped.push({ source: item.path, reason: reason.slice('conflict:'.length) });
      else failed.push({ source: item.path, reason });
    }
  }

  const archiveId = randomUUID();
  UNDO_ARCHIVES.set(archiveId, { targetRoot: targetReal, files: copied.map(({ target, sha256 }) => ({ path: target, sha256 })) });
  while (UNDO_ARCHIVES.size > 32) {
    const oldest = UNDO_ARCHIVES.keys().next().value;
    if (!oldest) break;
    UNDO_ARCHIVES.delete(oldest);
  }
  const report = { archiveId, createdAt: new Date().toISOString(), sourceDirectory: sourceRoot, targetDirectory: targetReal, conflict: input.conflict, copied, skipped, failed };
  const csvRows = [
    ['source', 'target', 'sha256', 'date', 'seller', 'buyer', 'invoiceNo', 'amount', 'type', 'result', 'reason'],
    ...copied.map((item) => [item.source, item.target, item.sha256, item.fields.date, item.fields.seller, item.fields.buyer, item.fields.invoiceNo, item.fields.amount, item.fields.type, 'copied', '']),
    ...skipped.map((item) => [item.source, '', '', '', '', '', '', '', '', 'skipped', item.reason]),
    ...failed.map((item) => [item.source, '', '', '', '', '', '', '', '', 'failed', item.reason]),
  ];
  const csv = `\uFEFF${csvRows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  let reportPath: string | undefined;
  let csvReportPath: string | undefined;
  const warnings: string[] = [];
  try {
    reportPath = await uniqueReportPath(targetReal);
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    csvReportPath = reportPath.replace(/\.json$/i, '.csv');
    await writeFile(csvReportPath, csv, { flag: 'wx' });
  } catch (error) {
    warnings.push('report-write-failed');
    if (reportPath && !(await stat(reportPath).then(() => true, () => false))) reportPath = undefined;
    if (csvReportPath && !(await stat(csvReportPath).then(() => true, () => false))) csvReportPath = undefined;
  }
  return { archiveId, copied, skipped, failed, reportPath, csvReportPath, warnings };
}

export async function undoInvoiceArchive(archiveId: string): Promise<InvoiceUndoResult> {
  const archive = UNDO_ARCHIVES.get(archiveId);
  if (!archive) throw new EngineError('bad_request', '本次归档记录已过期或不存在');
  const { targetRoot } = archive;
  const removed: string[] = [];
  const skipped: InvoiceUndoResult['skipped'] = [];
  for (const item of archive.files) {
    let tombstone = '';
    try {
      const path = resolve(item.path);
      if (!isWithin(targetRoot, path)) throw new Error('文件不在本次归档目录内');
      const fileStat = await lstat(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('目标已不存在或不再是普通文件');
      if (!/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error('归档校验信息无效');
      tombstone = join(dirname(path), `.potools-undo-${randomUUID()}.tmp`);
      await rename(path, tombstone);
      const tombstoneStat = await lstat(tombstone);
      if (!tombstoneStat.isFile() || tombstoneStat.isSymbolicLink()) throw new Error('撤销目标已被替换，已保留临时文件');
      const real = await realpath(tombstone);
      if (!isWithin(targetRoot, real)) throw new Error('目标路径已被重定向到归档目录之外');
      const digest = sha256(await readFile(real));
      if (digest !== item.sha256) {
        await link(tombstone, path);
        await unlink(tombstone);
        tombstone = '';
        throw new Error('文件内容已变化，已保留该文件');
      }
      await unlink(tombstone);
      tombstone = '';
      removed.push(path);
    } catch (error) {
      let recoveryMessage = '';
      if (tombstone) {
        const originalPath = resolve(item.path);
        await link(tombstone, originalPath)
          .then(() => rm(tombstone, { force: true }))
          .catch(() => { recoveryMessage = `；未能恢复原路径，文件保留在 ${tombstone}`; });
      }
      skipped.push({ path: item.path, reason: `${messageOf(error)}${recoveryMessage}` });
    }
  }
  UNDO_ARCHIVES.delete(archiveId);
  return { removed, skipped };
}

function safeRelativeSegments(value: string): string[] {
  if (!value || value.length > 2048 || isAbsolute(value) || /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error('目标路径必须是相对路径');
  }
  const segments = value.replace(/\\/g, '/').split('/').filter(Boolean).map((segment) => {
    if (segment === '.' || segment === '..') throw new Error('目标路径不能包含 . 或 ..');
    let safe = segment.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '').slice(0, 120);
    if (!safe) safe = '_';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(safe)) safe = `_${safe}`;
    return safe;
  });
  if (segments.length < 1 || segments.length > 24) throw new Error('目标路径层级无效');
  return segments;
}

async function freeDestination(requested: string): Promise<string> {
  const extension = extname(requested);
  const stem = basename(requested, extension);
  for (let suffix = 1; suffix <= 9999; suffix += 1) {
    const candidate = suffix === 1 ? requested : join(dirname(requested), `${stem} (${suffix})${extension}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('同名文件过多，无法自动生成不冲突的名称');
}

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  const rel = relative(root, directory);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('目标目录超出归档目录');
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    await mkdir(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('目标目录包含符号链接或非目录');
  }
}

async function uniqueReportPath(directory: string): Promise<string> {
  const base = `potools-invoice-report-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (let index = 1; index <= 100; index += 1) {
    const path = join(directory, `${base}${index === 1 ? '' : `-${index}`}.json`);
    try {
      await stat(path);
    } catch {
      return path;
    }
  }
  throw new Error('无法创建归档报告文件');
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function csvCell(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function emptyFields(): InvoiceScanEntry['fields'] {
  return { date: '', seller: '', buyer: '', invoiceNo: '', amount: '', type: '' };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
