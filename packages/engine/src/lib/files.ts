import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileRef, JobGlobals } from '@potools/core';
import type { PDFDocument } from 'pdf-lib';
import { EngineError } from '../errors.ts';
import { logger } from '../logger.ts';
import type { ResolvedInput } from '../types.ts';
import { loadDocument } from './pdf.ts';
import { normalizePdfBytes } from './render.ts';

export const TEMP_ROOT = resolve(process.env.POTOOLS_TEMP ?? join(tmpdir(), 'potools'));

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function tempJobDir(jobId: string): string {
  return join(TEMP_ROOT, 'jobs', safeSegment(jobId));
}

export function tempInboxDir(jobId: string): string {
  return join(TEMP_ROOT, 'inbox', safeSegment(jobId));
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
      throw new EngineError('unreadable_file', `无法读取 ${file.name || file.path}: ${String(error)}`);
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
