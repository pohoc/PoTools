import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { FileRef, JobGlobals } from '@potools/core';
import type { PDFDocument } from 'pdf-lib';
import { EngineError } from '../errors.ts';
import { logger } from '../logger.ts';
import type { ResolvedInput } from '../types.ts';
import { loadDocument } from './pdf.ts';
import { normalizePdfBytes } from './render.ts';

export function defaultTempRoot(): string {
  return join(tmpdir(), 'potools');
}

let tempRoot = resolve(process.env.POTOOLS_TEMP ?? defaultTempRoot());

export function tempRootDir(): string {
  return tempRoot;
}

/** Empty or null falls back to the OS temp folder. Returns the applied root. */
export function setTempRootDir(dir: string | null | undefined): string {
  const next = String(dir ?? '').trim();
  tempRoot = resolve(next || defaultTempRoot());
  return tempRoot;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export interface DirListing {
  /** Folder actually listed; equals `requested` unless it does not exist yet. */
  path: string;
  /** Path the caller asked for, so a not-yet-created folder stays selectable. */
  requested: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  quick: Array<{ id: QuickLocation; path: string }>;
}

export type QuickLocation = 'home' | 'documents' | 'downloads' | 'desktop';

const QUICK_DIRS: Array<[QuickLocation, string]> = [
  ['documents', 'Documents'],
  ['downloads', 'Downloads'],
  ['desktop', 'Desktop'],
];

/** Existing standard folders offered as one-click jump targets. */
async function quickLocations(home: string): Promise<DirListing['quick']> {
  const candidates: Array<[QuickLocation, string]> = [['home', home], ...QUICK_DIRS.map(([id, name]) => [id, join(home, name)] as [QuickLocation, string])];
  const checked = await Promise.all(candidates.map(async ([id, path]) =>
    (await readdir(path).then(() => true, () => false)) ? { id, path } : null,
  ));
  return checked.filter((entry): entry is { id: QuickLocation; path: string } => entry !== null);
}

/** Read-only folder listing that backs the in-app directory picker. */
export async function browseDirs(input: string | null): Promise<DirListing> {
  const home = resolve(homedir());
  const requested = resolve(String(input ?? '').trim() || home);
  let path = requested;
  let entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  // A saved folder may not exist yet; browse the nearest ancestor that does.
  while (!entries) {
    const parent = dirname(path);
    if (parent === path) throw new EngineError('unreadable_file', `无法读取目录：${path}`);
    path = parent;
    entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  }
  return {
    path,
    requested,
    parent: dirname(path) === path ? null : dirname(path),
    quick: await quickLocations(home),
    dirs: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  };
}

export function tempJobDir(jobId: string): string {
  return join(tempRoot, 'jobs', safeSegment(jobId));
}

export function tempInboxDir(jobId: string): string {
  return join(tempRoot, 'inbox', safeSegment(jobId));
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'job';
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, bytes);
}

export async function readInput(file: FileRef, jobId = 'adhoc'): Promise<ResolvedInput> {
  let bytes: Uint8Array;
  if (file.path && isAbsolute(file.path)) {
    try {
      bytes = new Uint8Array(await readFile(file.path));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      throw new EngineError(
        'unreadable_file',
        missing
          ? `${file.name || file.path} 已不存在，可能已被移动、删除或清理`
          : `无法读取 ${file.name || file.path}: ${String(error)}`,
      );
    }
  } else if (file.dataBase64) {
    bytes = new Uint8Array(Buffer.from(file.dataBase64, 'base64'));
  } else {
    throw new EngineError('bad_request', `${file.name ?? '文件'} 缺少路径或内容`);
  }
  return { id: file.id, name: file.name, path: file.path ?? null, bytes };
}

/**
 * pdf-lib is strict about structure and cannot read encrypted files, so a MuPDF
 * rewrite is attempted once before giving up.
 */
export async function loadPdf(input: ResolvedInput, globals: JobGlobals = {}): Promise<PDFDocument> {
  try {
    return await loadDocument(input.bytes, input.name);
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    if (error.code === 'encrypted_document' && !globals.password) throw error;
    logger.debug('retrying load through mupdf', { file: input.name, code: error.code });
    const normalized = await normalizePdfBytes(input.bytes, input.name);
    try {
      return await loadDocument(normalized, input.name);
    } catch (retryError) {
      throw retryError instanceof EngineError ? error : retryError;
    }
  }
}

export async function copyInto(dir: string, name: string, sourcePath: string): Promise<string> {
  const target = join(resolve(dir), name);
  await ensureDir(dirname(target));
  await copyFile(sourcePath, target);
  return target;
}
